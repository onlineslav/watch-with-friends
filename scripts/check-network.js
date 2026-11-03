// Real WebRTC and application code; discovery normally uses local IPC.
// --public-discovery checks Nostr with different room startup orders instead.
// Hidden windows use disposable identities and loopback media connections.
const {app, BrowserWindow, ipcMain, dialog} = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {pathToFileURL} = require('node:url')
const {execFileSync} = require('node:child_process')
const esbuild = require('esbuild')
const {parseLine} = require('../shared/log')
const diagnostics = require('../main/log')
const {prepareYouTube, registerYouTube} = require('../main/youtube')
prepareYouTube()
const checkYouTube = process.argv.includes('--youtube')
// --switch-loop=N: after the earlier steps, all three windows leave a room and enter another N times (default 1); the 0.8.2 Mac CI
// failure was a pair that never connected on such a switch (M1.7).
const switchLoop = Number((process.argv.find((arg) => arg.startsWith('--switch-loop=')) || '').split('=')[1]) || 1
// --churn-loop=N: in a room of three, one person leaves and comes straight back N times (the 0.8.2 Mac CI failure: the returning
// pair never connected, "handshake timed out"). Default 3.
const churnLoop = Number((process.argv.find((arg) => arg.startsWith('--churn-loop=')) || '').split('=')[1]) || 3
const rejoinLoop = Number((process.argv.find((arg) => arg.startsWith('--rejoin-loop=')) || '').split('=')[1]) || 3
// --live-rate=N: N people in one room, the host playing a film, and the live telemetry stream measured
// per person for 60 seconds (M1.1). Nothing else is checked.
const liveRatePeople = Number((process.argv.find((arg) => arg.startsWith('--live-rate=')) || '').split('=')[1]) || 0
const {createLiveSender} = require('../main/live')
const {createFakeWebSocket} = require('./fakes')

const root = path.resolve(__dirname, '..')
const publicDiscovery = process.argv.includes('--public-discovery')
// ~300 MB per run; removed again however the run ends (--keep or KEEP_TEMP=1 to look at it), and folders of dead runs on start.
const scratch = require('./temp-dirs').create('synced-network-test-', {keep: process.argv.includes('--keep') || Boolean(process.env.KEEP_TEMP)})
const temporary = scratch.dir
const finish = (code) => { scratch.release(); app.exit(code) }
app.setPath('userData', path.join(temporary, 'profile'))
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const run = (win, source) => win.webContents.executeJavaScript(source).catch((error) => { throw new Error(`${error.message}\nExecuting: ${source}`) })
const testWindows = [] // [name, BrowserWindow], for failure dumps
const connectionDump = `JSON.stringify({self: __test.selfId, role: __test.session.role, claimedAt: __test.session.claimedAt, preview: Boolean(__test.session.preview),
  published: __test.session.stream?.getTracks().map((t) => t.kind + ':' + t.readyState) ?? null,
  captured: __test.session.captured?.getTracks().map((t) => t.kind + ':' + t.readyState) ?? null,
  peers: Object.entries(__test.session.room?.getPeers() || {}).map(([id, pc]) => ({id, inSession: __test.session.peers.has(id), conn: pc.connectionState, ice: pc.iceConnectionState, sig: pc.signalingState,
    senders: pc.getSenders().map((s) => s.track ? s.track.kind + ':' + s.track.readyState : 'none'),
    receivers: pc.getReceivers().map((r) => r.track.kind + ':' + r.track.readyState + (r.track.muted ? ':muted' : '') + '#' + r.track.id.slice(0, 6)),
    transceivers: pc.getTransceivers().map((t) => (t.mid ?? '-') + ':' + t.direction + '/' + (t.currentDirection ?? '-'))}))})`
async function until(win, condition, timeoutMs = publicDiscovery ? 90000 : 15000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await run(win, condition)) return
    await pause(100)
  }
  console.error(await run(win, `JSON.stringify({identity:__test.identity?.username, friendIdentity:__test.friendNetwork.identity?.username, homeHidden:document.getElementById('home').hidden, welcomeHidden:document.getElementById('welcome').hidden, startupHidden:document.getElementById('startup').hidden, startup:document.getElementById('startup-status').textContent})`))
  // Every window's WebRTC side of it: what each is sending and receiving, per connection, and
  // where negotiation stands. A viewer with no stream is usually explained on the host's side.
  for (const [name, other] of testWindows) {
    if (other.isDestroyed()) continue
    console.error(`${name} connections: ` + await run(other, connectionDump).catch((error) => error.message))
    const trace = await run(other, 'JSON.stringify((globalThis.__trace || []).slice(-80))').catch(() => '[]') // set only by a debug build of the transport
    if (trace !== '[]') console.error(`${name} transport trace: ${trace}`)
  }
    console.error(await run(win, `JSON.stringify({friends:__test.friendNetwork.list(), role:__test.session.role, peers:[...__test.session.peers], remote:__test.session.remote, connection:__test.session.connection, video:{ready:document.getElementById('remote-video').readyState, frames:document.getElementById('remote-video').getVideoPlaybackQuality().totalVideoFrames}, streams:[...__test.session.peerStreams].map(([id, entry]) => ({id, stream:entry.stream.id.slice(0, 6), claimedAt:entry.claimedAt, tracks:entry.stream.getTracks().map(t => ({kind:t.kind, muted:t.muted, state:t.readyState, id:t.id.slice(0, 6)}))})), errors:__test.errors})`))
  assert.fail(`Timed out: ${condition}`)
}

// M1.2: the samples carry what is needed to tell the network, the computer, the encoder and the audio
// path apart, stay inside the line cap, and cost the page almost nothing. Reads the real log file.
async function checkMeasurements(windows, host, viewer) {
  const baseline = Boolean(process.env.MEASURE_BASELINE) // an older checkout has no new fields: cost only
  if (!baseline) await checkFields(windows)
  await checkCost(host, viewer, baseline)
}

async function checkFields(windows) {
  const entries = () => { diagnostics.flush(); return fs.readFileSync(diagnostics.filePath(), 'utf8').trim().split('\n').map(parseLine).filter(Boolean) }
  const lineLength = (entry) => Buffer.byteLength(JSON.stringify(entry))
  const wanted = (all) => ({
    viewer: all.filter((e) => e.ev === 'viewer-sample' && e.a && e.s && e.v).at(-1),
    host: all.filter((e) => e.ev === 'host-sample' && e.e).at(-1),
    machine: all.filter((e) => e.ev === 'machine-sample' && e.p && e.host?.ahead != null).at(-1),
    link: all.find((e) => e.ev === 'link' && e.net && e.opus),
    static: all.find((e) => e.sc === 'machine' && e.ev === 'static'),
  })
  let found = wanted([])
  for (let i = 0; i < 40 && !(found.viewer && found.host && found.machine && found.link && found.static); i++) {
    await pause(1000)
    await Promise.all(windows.map((win) => run(win, '__test.flushLog()')))
    found = wanted(entries())
  }
  const all = entries()
  assert.ok(found.viewer, 'viewer-sample carries audio health (a), sync inputs (s) and decoder cost (v)')
  assert.ok(found.host, 'host-sample carries encoder cost (e)')
  assert.ok(found.machine, `machine-sample carries per-process load (p) and the host pipeline (ahead); last seen: ${JSON.stringify(all.filter((e) => e.ev === 'machine-sample').slice(-3))}`)
  assert.ok(found.link, 'a link event records candidate types and the negotiated Opus parameters')
  assert.ok(found.static, 'machine/static records GPU status and display refresh rate once')
  assert.equal(found.viewer.set.af, 1)
  assert.ok(['balanced', 'text', 'motion'].includes(found.viewer.set.pri))
  assert.ok(typeof found.viewer.a.jit === 'number' && typeof found.viewer.a.rx === 'number' && 'conc' in found.viewer.a && 'ins' in found.viewer.a && 'rem' in found.viewer.a, 'audio: jitter, packets, concealment, stretching')
  assert.ok(typeof found.viewer.s.aJb === 'number' && typeof found.viewer.s.vJb === 'number', 'audio and video jitter-buffer delay separately')
  assert.ok(Array.isArray(found.machine.p.m) && Array.isArray(found.machine.p.r), 'CPU/memory for the main and renderer processes')
  assert.ok(found.static.gpu.features && found.static.displays.length, 'GPU feature table and displays')
  assert.ok(all.every((e) => !JSON.stringify(e).match(/NaN|Infinity|undefined/)), 'no NaN in any line')
  const cap = Math.max(...all.filter((e) => ['viewer-sample', 'host-sample', 'machine-sample', 'link'].includes(e.ev)).map(lineLength))
  assert.ok(cap < 4000, `longest sample line ${cap} bytes is under the 4000-byte cap`)
  console.log(`MEASURE viewer-sample ${lineLength(found.viewer)} B: ${JSON.stringify(found.viewer)}`)
  console.log(`MEASURE host-sample ${lineLength(found.host)} B: ${JSON.stringify(found.host)}`)
  console.log(`MEASURE machine-sample ${lineLength(found.machine)} B: ${JSON.stringify(found.machine)}`)
  console.log(`MEASURE host pipeline over time: ${JSON.stringify(all.filter((e) => e.ev === 'machine-sample' && e.host).map((e) => e.host))}`)
  console.log(`MEASURE link ${lineLength(found.link)} B: ${JSON.stringify(found.link)}`)
  console.log(`MEASURE link events (${all.filter((e) => e.ev === 'link').length}): ${JSON.stringify(all.filter((e) => e.ev === 'link').map((e) => ({m: e.m, peer: e.peer?.slice(0, 4), net: e.net, venc: e.venc, vdec: e.vdec, opus: e.opus})))}`)
  const costs = (role) => all.filter((e) => e.ev === 'machine-sample' && e.role === role && e.cost != null).map((e) => e.cost).sort((x, y) => x - y)
  for (const role of ['host', 'viewer']) {
    const list = costs(role)
    console.log(`MEASURE in-page JS time per tick (${role}, ${list.length} ticks, excludes getStats itself): median ${list[Math.floor(list.length / 2)]} ms, max ${list.at(-1)} ms`)
  }
  console.log(`MEASURE machine/static ${lineLength(found.static)} B`)
  const viewerLines = all.filter((e) => e.self && e.self === found.viewer.self && ['viewer-sample', 'machine-sample'].includes(e.ev))
  console.log(`MEASURE viewer per-2s bytes (viewer-sample + machine-sample): ${lineLength(found.viewer) + lineLength(found.machine)} B (${viewerLines.length} such lines logged)`)

  console.log('PASS: Samples carry audio health, A/V sync inputs, codec cost, machine load, host pipeline, link facts and settings, inside the line cap')
}

// M1.9: the context the log gains. A mark pressed by one person is logged by everyone in the room under one
// id, a copy that does not know an action ignores it, the rate limit holds, and the one-way delays, the audio
// device and the playback actions are in the real log. Reads the real log file.
async function checkContext(windows, host, viewer, other) {
  const entries = () => { diagnostics.flush(); return fs.readFileSync(diagnostics.filePath(), 'utf8').trim().split('\n').map(parseLine).filter(Boolean) }
  const flush = () => Promise.all(windows.map((win) => run(win, '__test.flushLog()')))
  const waitFor = async (what, find) => {
    let found
    for (let i = 0; i < 40 && !(found = find(entries())); i++) { await pause(500); await flush() }
    assert.ok(found, `Timed out waiting for ${what}`)
    return found
  }
  const [hostSelf, viewerSelf, otherSelf] = await Promise.all([host, viewer, other].map((win) => run(win, '__test.selfId')))

  // One key press: the marker logs it as its own, everyone else as a peer's, all under one id.
  const id = await run(viewer, '__test.markMoment("")')
  assert.match(id, /^[a-z0-9]{6,16}$/)
  await waitFor('the mark in all three logs', (all) => [hostSelf, viewerSelf, otherSelf].every((self) => all.some((e) => e.sc === 'mark' && e.ev === 'note' && e.id === id && e.self === self)))
  const marks = entries().filter((e) => e.sc === 'mark' && e.id === id)
  assert.deepEqual(marks.map((e) => e.src).sort(), ['peer', 'peer', 'self'])
  const own = marks.find((e) => e.src === 'self')
  assert.equal(own.self, viewerSelf)
  assert.equal(own.by, await run(viewer, '__test.identity.username'))
  assert.ok(marks.filter((e) => e.src === 'peer').every((e) => e.peer === viewerSelf && e.by === own.by), 'peers name who pressed it')
  // The same id again carries a note to everyone.
  assert.equal(await run(viewer, `__test.markMoment("audio crackles", ${JSON.stringify(id)})`), id)
  await waitFor('the note in all three logs', (all) => [hostSelf, viewerSelf, otherSelf].every((self) => all.some((e) => e.sc === 'mark' && e.id === id && e.self === self && e.note === 'audio crackles')))
  console.log('PASS: A mark reaches every log under one id, then a note is added to it')

  // The same thing the way a person does it: the key, the button, the note box, and Settings naming the key.
  const mineIds = () => new Set(entries().filter((e) => e.sc === 'mark' && e.src === 'self' && e.self === viewerSelf).map((e) => e.id))
  assert.equal(await run(viewer, 'document.getElementById("mark-key").textContent'), 'X', 'Settings shows the key')
  const known = mineIds().size
  await run(viewer, `document.body.dispatchEvent(new KeyboardEvent('keydown', {code: 'KeyX', ctrlKey: true, bubbles: true}))`)
  await flush()
  assert.equal(mineIds().size, known, 'Ctrl+X is not the mark key')
  await run(viewer, `document.body.dispatchEvent(new KeyboardEvent('keydown', {code: 'KeyX', bubbles: true}))`)
  await waitFor('the key press in the log', () => mineIds().size === known + 1)
  assert.equal(await run(viewer, 'document.getElementById("mark-note").hidden'), false, 'the note box opens')
  await run(viewer, `(() => { document.getElementById('mark-note-input').value = 'video froze'; document.getElementById('mark-note').requestSubmit() })()`)
  await waitFor('the typed note in all three logs', (all) => [hostSelf, viewerSelf, otherSelf].every((self) => all.some((e) => e.sc === 'mark' && e.self === self && e.note === 'video froze')))
  assert.equal(await run(viewer, 'document.getElementById("mark-note").hidden'), true, 'and closes')
  assert.equal(mineIds().size, known + 1, 'a note is the same mark')
  await run(viewer, `document.getElementById('mark').click()`)
  await waitFor('the button press in the log', () => mineIds().size === known + 2)
  // Shift+X opens the note box focused; the key press itself must be swallowed (it would otherwise be typed into it).
  const prevented = await run(viewer, `(() => { const event = new KeyboardEvent('keydown', {code: 'KeyX', key: 'X', shiftKey: true, bubbles: true, cancelable: true}); document.body.dispatchEvent(event); return event.defaultPrevented })()`)
  assert.equal(prevented, true, 'Shift+X is handled, not typed')
  await waitFor('the Shift+X mark in the log', () => mineIds().size === known + 3)
  assert.deepEqual(await run(viewer, `({open: !document.getElementById('mark-note').hidden, focused: document.activeElement === document.getElementById('mark-note-input'), value: document.getElementById('mark-note-input').value})`), {open: true, focused: true, value: ''}, 'the note box is open, focused and empty')
  await run(viewer, `document.getElementById('mark-note-input').dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))`)
  console.log('PASS: The mark key, the button and the note box work; Settings names the key')

  // Mute, volume (one line per drag, not per step) and a Settings change are one small line each.
  await run(viewer, `document.getElementById('mute').click()`)
  await run(viewer, `document.getElementById('mute').click()`)
  for (const volume of ['0.7', '0.6', '0.5']) await run(viewer, `(() => { const v = document.getElementById('volume'); v.value = '${volume}'; v.dispatchEvent(new Event('input')) })()`)
  await pause(1000)
  await run(viewer, `(() => { const v = document.getElementById('volume'); v.value = '1'; v.dispatchEvent(new Event('input')) })()`) // the later steps listen for sound
  await run(viewer, `(() => { const select = document.getElementById('share-framerate'); select.value = '60'; select.dispatchEvent(new Event('change')) })()`)
  await run(viewer, `(() => { const select = document.getElementById('share-framerate'); select.value = '30'; select.dispatchEvent(new Event('change')) })()`)
  const changes = await waitFor('mute, volume and settings lines', (all) => {
    const mine = all.filter((e) => e.self === viewerSelf)
    const volume = mine.filter((e) => e.sc === 'action' && e.ev === 'volume')
    const mutes = mine.filter((e) => e.sc === 'action' && e.ev === 'mute')
    const settings = mine.filter((e) => e.sc === 'settings' && e.ev === 'change')
    return mutes.length >= 2 && volume.length >= 2 && settings.length >= 2 ? {mutes, volume, settings} : null
  })
  assert.deepEqual(changes.mutes.slice(0, 2).map((e) => e.muted), [true, false])
  assert.equal(changes.volume.filter((e) => e.v === 0.5).length, 1, 'a drag from 0.7 to 0.5 is one line, at 0.5')
  assert.ok(!changes.volume.some((e) => e.v === 0.7 || e.v === 0.6), 'and not one per step')
  assert.deepEqual(changes.settings.slice(-2).map((e) => e.share.frameRate), [[30, 60], [60, 30]])
  console.log('PASS: Mute, volume and Settings changes are logged once each')

  // Rate limit, bad payloads, and an action nobody here registered (what a copy from before marks looks like to us).
  const sent = []
  for (let i = 0; i < 12; i++) sent.push(await run(other, '__test.markMoment("")'))
  assert.ok(sent.filter(Boolean).length <= 6 && sent.some((x) => x === null), `at most 6 marks in a window: ${sent.filter(Boolean).length} went out`)
  await run(other, `__test.session.markAction.send({id: 'BAD ID', note: 'x'}).catch(() => {})`)
  await run(other, `__test.session.markAction.send('not an object').catch(() => {})`)
  await run(host, `__test.session.room.makeAction('future-thing').send({x: 1}).catch(() => {})`)
  await pause(1500)
  await flush()
  const all = entries()
  const otherMarks = all.filter((e) => e.sc === 'mark' && e.ev === 'note' && e.self === otherSelf && e.src === 'self')
  assert.ok(otherMarks.length <= 6, `${otherMarks.length} marks logged by the one who flooded`)
  const received = all.filter((e) => e.sc === 'mark' && e.ev === 'note' && e.self === hostSelf && e.peer === otherSelf)
  assert.ok(received.length <= 6, `${received.length} of them shown to the host`)
  assert.ok(!all.some((e) => e.sc === 'mark' && /BAD/.test(JSON.stringify(e))), 'a bad id is dropped by the receiver')
  for (const win of [host, viewer, other]) assert.deepEqual(await run(win, '__test.errors'), [], 'no copy threw on a bad mark or an unknown action')
  assert.equal(await run(host, '__test.session.peers.size'), 2, 'and the room is intact')
  console.log(`PASS: Marks are rate limited (${otherMarks.length} of 12 sent), bad ones and unknown actions are ignored without errors`)

  // The numbers that tell which direction is slow, from the room's clock offset.
  const owViewer = await waitFor('host-to-viewer delay in a viewer-sample', (log) => log.filter((e) => e.ev === 'viewer-sample' && e.ow && Number.isFinite(e.ow.hv)).at(-1))
  const owHost = await waitFor('viewer-to-host delay in a host-sample', (log) => log.filter((e) => e.ev === 'host-sample' && e.ow && Number.isFinite(e.ow.vh)).at(-1))
  assert.ok(owViewer.ow.hv > -50 && owViewer.ow.hv < 2000, `host to viewer ${owViewer.ow.hv} ms on loopback`)
  assert.ok(owHost.ow.vh > -50 && owHost.ow.vh < 2000, `viewer to host ${owHost.ow.vh} ms on loopback`)
  console.log(`MEASURE one-way delay on loopback: host to viewer ${owViewer.ow.hv} ms, viewer to host ${owHost.ow.vh} ms; viewer-sample ${Buffer.byteLength(JSON.stringify(owViewer))} B, host-sample ${Buffer.byteLength(JSON.stringify(owHost))} B`)

  // Where the sound goes, once on entering the room, and the playback actions the earlier steps took.
  const devices = await waitFor('an audio/device line from every window', (log) => {
    const lines = log.filter((e) => e.sc === 'audio' && e.ev === 'device' && e.why === 'room')
    return [hostSelf, viewerSelf, otherSelf].every((self) => lines.some((e) => e.self === self)) ? lines : null
  })
  assert.ok(devices.every((e) => ['builtin', 'wired', 'bluetooth', 'hdmi', 'virtual', 'unknown'].includes(e.kind) && Number.isFinite(e.sr)), 'a known kind and a sample rate')
  console.log(`MEASURE audio/device ${Buffer.byteLength(JSON.stringify(devices[0]))} B: ${JSON.stringify(devices[0])}`)
  const actions = entries().filter((e) => e.sc === 'action')
  assert.ok(actions.some((e) => e.ev === 'pause' && e.via === 'viewer' && e.self === viewerSelf), 'the viewer logged pressing pause')
  assert.ok(actions.some((e) => e.ev === 'pause' && e.via === 'remote' && e.from === viewerSelf && e.self === hostSelf), 'the host logged the command it was sent')
  assert.ok(actions.some((e) => e.ev === 'seek' && e.v === 10 && e.via === 'viewer'), 'a seek carries where to, in seconds')
  assert.ok(entries().some((e) => e.sc === 'network' && e.ev === 'peer-state' && e.change && e.change.on), 'connection-state lines say which state moved')
  const longest = Math.max(...entries().filter((e) => ['mark', 'action', 'audio'].includes(e.sc)).map((e) => Buffer.byteLength(JSON.stringify(e))))
  assert.ok(longest < 4000, `the longest new line is ${longest} bytes`)
  assert.ok(entries().every((e) => !JSON.stringify(e).match(/NaN|Infinity|undefined/)), 'no NaN in any line')
  console.log(`PASS: One-way delays, the audio device and the playback actions are in the log (longest new line ${longest} B)`)
}

// The 2ms budget is measured on a typical desktop. CI runners are slower and noisy (Intel Mac 4.3-7.6ms, Windows 2.16ms
// on code that costs 1.4ms locally), so the workflow sets SAMPLE_COST_LIMIT_MS=report on every runner: the
// cost is still printed, and local runs gate on it.
const COST_REPORT_ONLY = process.env.SAMPLE_COST_LIMIT_MS === 'report'
const COST_LIMIT_MS = Number(process.env.SAMPLE_COST_LIMIT_MS) || 2

async function checkCost(host, viewer, baseline) {
  // Cost on the main thread: Chromium's own task time over 40 back-to-back samples, against 40 bare
  // getStats() calls, then the new parsing alone on a real report. Host (two viewers) and viewer.
  for (const [role, win] of [['host', host], ['viewer', viewer]]) {
    const contents = win.webContents
    contents.debugger.attach('1.3')
    try {
      await contents.debugger.sendCommand('Performance.enable')
      const taskSeconds = async () => (await contents.debugger.sendCommand('Performance.getMetrics')).metrics.find((m) => m.name === 'TaskDuration').value
      const measure = async (source) => {
        await pause(300)
        const before = await taskSeconds()
        await run(win, source)
        return ((await taskSeconds()) - before) * 1000 / 40
      }
      await run(win, '(async () => { while (__test.session.sampling) await new Promise((r) => setTimeout(r, 50)) })()')
      const bare = await measure(`(async () => { const pcs = Object.values(__test.session.room.getPeers()); for (let i = 0; i < 40; i++) await Promise.all(pcs.map((pc) => pc.getStats())); })()`)
      const full = await measure(`(async () => { for (let i = 0; i < 40; i++) { await __test.sampleConnection() } })()`)
      const parse = JSON.parse(await run(win, `(async () => {
        const pc = Object.values(__test.session.room.getPeers())[0]
        const report = await pc.getStats()
        const time = (fn) => { const t = performance.now(); for (let i = 0; i < 500; i++) fn(); return (performance.now() - t) / 500 }
        const detail = __test.readDetail ? __test.readDetail(report) : null
        return JSON.stringify({
          old: time(() => __test.readStats(report)),
          added: __test.readDetail ? time(() => { __test.readDetail(report); __test.detailDelta(detail, detail) }) : 0,
          ept: [...report.values()].filter((s) => s.type === 'inbound-rtp').map((s) => [s.kind, typeof s.estimatedPlayoutTimestamp, s.estimatedPlayoutTimestamp, s.decoderImplementation, s.powerEfficientDecoder]),
          keys: Object.fromEntries(['audio', 'video'].map((k) => [k, [...report.values()].filter((s) => s.type === 'inbound-rtp' && s.kind === k).flatMap((s) => Object.keys(s)).join(',')])),
        })
      })()`))
      console.log(`MEASURE page profile (${role}, main-thread TaskDuration per call): getStats alone ${bare.toFixed(2)} ms, full sampleConnection ${full.toFixed(2)} ms; parsing per peer: readStats ${parse.old.toFixed(3)} ms, new readDetail+detailDelta ${parse.added.toFixed(3)} ms`)
      if (role === 'viewer') console.log(`MEASURE inbound-rtp stats this Chromium exposes: ${JSON.stringify(parse.keys)}; estimatedPlayoutTimestamp/decoder values: ${JSON.stringify(parse.ept)}`)
      assert.ok(COST_REPORT_ONLY || parse.added < COST_LIMIT_MS, `the added parsing costs under ${COST_LIMIT_MS} ms`)
      if (baseline || COST_REPORT_ONLY) continue
      assert.ok(full < COST_LIMIT_MS, `the whole ${role} sample costs under ${COST_LIMIT_MS} ms of main thread (${full.toFixed(2)} ms)`)
    } finally {
      contents.debugger.detach()
    }
  }
  console.log(COST_REPORT_ONLY ? 'PASS: Sample cost reported (not gated on this runner)' : `PASS: Samples cost under ${COST_LIMIT_MS} ms of main thread on host and viewer`)
}

// M1.1: what the live stream costs each person. Everyone's lines share one main process here, so each
// person gets their own sender (the real one, with a socket that only counts) fed just the lines that
// person's window wrote; lines from main itself, which carry no `self`, go to everyone, which
// overcounts. The host is the busiest: one host-sample per viewer every 2 seconds.
async function checkLiveRate(windows, video) {
  const [host, ...viewers] = windows
  await run(host, '__test.enterRoom("ABCDEFGH", {joining:false})')
  await Promise.all(viewers.map((win) => run(win, '__test.enterRoom("ABCDEFGH")')))
  await Promise.all(windows.map((win) => until(win, `__test.session.peers.size === ${windows.length - 1}`)))
  await run(host, `__test.hostFile(${JSON.stringify(video)})`)
  await run(host, '__test.control("loop", true)')
  await Promise.all(viewers.map((win) => until(win, 'document.getElementById("remote-video").getVideoPlaybackQuality().totalVideoFrames > 12')))
  const selves = await Promise.all(windows.map((win) => run(win, '__test.selfId')))
  const FakeWebSocket = createFakeWebSocket()
  FakeWebSocket.answerPings = true
  const senders = selves.map(() => createLiveSender({endpoint: async () => 'https://relay.test/telemetry', WebSocketImpl: FakeWebSocket}))
  const unsubscribe = diagnostics.subscribe((lines) => {
    if (process.env.LIVE_RATE_DUMP) fs.appendFileSync(process.env.LIVE_RATE_DUMP, `# ${Date.now()}\n${lines.join('\n')}\n`) // sample lines, for building shared/live-dictionary.txt
    const mine = selves.map(() => [])
    for (const line of lines) {
      const self = parseLine(line)?.self
      selves.forEach((id, index) => { if (!self || self === id) mine[index].push(line) })
    }
    mine.forEach((list, index) => senders[index].push(list))
  })
  // In a room the app pings its socket every 2 s for the edge round trip (M1.9); the rate includes those pings.
  senders.forEach((sender) => { sender.configure({enabled: true, from: 'tester#abcd-1234'}); sender.setFast(true) })
  await pause(200)
  for (const socket of FakeWebSocket.instances) { socket.open(); socket.receive(JSON.stringify({watching: true})) }
  assert.equal(FakeWebSocket.instances.length, windows.length)
  const started = Date.now()
  await pause(60000)
  const seconds = (Date.now() - started) / 1000
  unsubscribe()
  const rows = senders.map((sender, index) => {
    const status = sender.status()
    const role = index === 0 ? `host (${viewers.length} viewer${viewers.length === 1 ? '' : 's'})` : 'viewer'
    return {person: index, role, lines: status.lines, pushes: status.pushes, frames: status.frames, payloadBytes: status.payloadBytes, wireBytes: status.wireBytes,
      kbpsPayload: Number((status.payloadBytes * 8 / seconds / 1000).toFixed(2)), kbps: Number((status.wireBytes * 8 / seconds / 1000).toFixed(2))}
  })
  console.log(`MEASURE live stream over ${seconds.toFixed(0)}s, ${windows.length} people (host has ${viewers.length} peer${viewers.length === 1 ? '' : 's'}):`)
  console.table(rows)
  for (const row of rows) assert.ok(row.kbps < 5, `${row.role} sends ${row.kbps} kbps, under 5`)
  senders.forEach((sender) => sender.close())
  console.log(`PASS: Live telemetry stays under 5 kbps per person with ${viewers.length} peer${viewers.length === 1 ? '' : 's'} on the host (worst ${Math.max(...rows.map((row) => row.kbps))} kbps)`)
}

async function fixtures() {
  const subscriptions = new Map()
  ipcMain.on('test:subscribe', (event, topic, active) => {
    const topics = subscriptions.get(event.sender) || new Set()
    if (active) topics.add(topic)
    else topics.delete(topic)
    subscriptions.set(event.sender, topics)
  })
  ipcMain.on('test:publish', (event, topic, message) => {
    for (const [contents, topics] of subscriptions) {
      if (contents !== event.sender && !contents.isDestroyed() && topics.has(topic)) contents.send('test:signal', topic, message)
    }
  })
  fs.writeFileSync(path.join(temporary, 'preload.js'), fs.readFileSync(path.join(root, 'main/preload.js'), 'utf8') + `
    const subscriptions = new Map();
    ipcRenderer.on('test:signal', (_event, topic, message) => {
      for (const handler of subscriptions.get(topic) || []) handler(topic, message);
    });
    contextBridge.exposeInMainWorld('__signal', {
      subscribe(topic, handler) {
        if (!subscriptions.has(topic)) subscriptions.set(topic, new Set());
        subscriptions.get(topic).add(handler);
        ipcRenderer.send('test:subscribe', topic, true);
        return () => {
          subscriptions.get(topic)?.delete(handler);
          if (!subscriptions.get(topic)?.size) ipcRenderer.send('test:subscribe', topic, false);
        };
      },
      publish: (topic, message) => ipcRenderer.send('test:publish', topic, message),
    });
  `)
  const source = fs.readFileSync(path.join(root, 'renderer/app.js'), 'utf8') + `
    window.__test = {
      get session() { return session }, get identity() { return identity },
      friendNetwork, enterRoom, leaveRoom, hostFile, startShare, stopShare, shareSettings, tileViews, control, receiveImage, shownImage, selectSubtitle, markMoment, logAudioDevice,
      primeDiscovery: (kind) => joinRoom({...network.config(), appId: APP_ID}, kind + ':startup-probe'),
      addToPlaylist, playItem, playNext, playable, orderedItems, moveInPlaylist, removeFromPlaylist, refreshAvailability, setPlaylistOpen,
      get history() { return roomHistory },
      audioState: () => ({running: audio?.state === 'running', connected: Boolean(remoteAudio)}),
      audioLevel: () => {
        if (!output || !audio) return 0;
        if (!__test.analyser) {
          __test.analyser = audio.createAnalyser();
          output.connect(__test.analyser);
        }
        const samples = new Float32Array(__test.analyser.fftSize);
        __test.analyser.getFloatTimeDomainData(samples);
        return Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
      },
      replaceCapturedAudio: (event) => {
        const captured = session.captured;
        const old = captured.getAudioTracks()[0];
        const replacement = old.clone();
        // Model capture replacing its track during a media pipeline reset. Scripted
        // mutations need explicit events; browser-driven changes fire these themselves.
        old.stop();
        captured.removeTrack(old);
        if (event === 'ended') old.dispatchEvent(new Event('ended'));
        else captured.dispatchEvent(new MediaStreamTrackEvent('removetrack', {track: old}));
        captured.addTrack(replacement);
        captured.dispatchEvent(new MediaStreamTrackEvent('addtrack', {track: replacement}));
      },
      getState: hostState, sampleConnection, flushLog, readStats, readDetail: typeof readDetail === 'function' ? readDetail : null, detailDelta: typeof detailDelta === 'function' ? detailDelta : null, youtube, selfId, errors: [],
    };
    // What opened and closed the playlist item menu, and the key/click events around it, for a
    // failure to explain itself (functions declared in app.js can be wrapped from here).
    __test.menuTrace = [];
    const traceMenu = (name, fn) => (...args) => { __test.menuTrace.push(name + ' ' + (new Error().stack.split('\\n')[2] || '').trim().slice(0, 80) + ' open=' + document.getElementById('playlist-item-menu').matches(':popover-open')); return fn(...args); };
    closePlaylistMenu = traceMenu('close', closePlaylistMenu);
    togglePlaylistMenu = traceMenu('toggle', togglePlaylistMenu);
    for (const type of ['keydown', 'keyup', 'click']) document.addEventListener(type, (e) => __test.menuTrace.push(type + ' ' + (e.code || '') + ' on ' + (e.target.className || e.target.tagName) + (e.defaultPrevented ? ' (prevented)' : '')), true);
    window.addEventListener('error', (e) => __test.errors.push(e.message));
    window.addEventListener('unhandledrejection', (e) => __test.errors.push(String(e.reason)));
  `
  await esbuild.build({stdin: {contents: source, resolveDir: path.join(root, 'renderer')}, bundle: true, format: 'iife', target: 'chrome130', outfile: path.join(temporary, 'bundle.js'), plugins: [{
    name: 'local-discovery', setup(build) {
      build.onResolve({filter: /^trystero$/}, () => ({path: 'trystero', namespace: 'local'}))
      build.onLoad({filter: /.*/, namespace: 'local'}, () => ({resolveDir: root, contents: publicDiscovery ? `
        import {joinRoom as join, selfId} from './node_modules/@trystero-p2p/nostr/dist/index.mjs';
        export {selfId};
        export const joinRoom = (config, code, callbacks) => join({...config,
          _test_only_mdnsHostFallbackToLoopback: true,
        }, code, callbacks);
      ` : `
        import {createTopicStrategy, selfId} from './node_modules/@trystero-p2p/core/dist/index.mjs';
        const join = createTopicStrategy({
          init: () => [{}], steadyAnnounceIntervalMs: 1000,
          subscribeTopic: (_relay, topic, handler) => window.__signal.subscribe(topic, handler),
          publishTopic: (_relay, topic, message) => window.__signal.publish(topic, message),
        });
        export {selfId};
        export const joinRoom = (config, code, callbacks) => join({...config,
          rtcConfig: {iceServers: []}, turnConfig: [], _test_only_mdnsHostFallbackToLoopback: true,
        }, code, callbacks);
      `}))
    },
  }]})
  const html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8')
    .replace('href="styles.css"', `href="${pathToFileURL(path.join(root, 'renderer/styles.css'))}"`)
  fs.writeFileSync(path.join(temporary, 'index.html'), html)
  if (publicDiscovery) return {}
  const video = path.join(temporary, 'sample.mp4')
  execFileSync(require('ffmpeg-static'), ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440', '-f', 'lavfi', '-i', 'sine=frequency=880', '-map', '0:v', '-map', '1:a', '-map', '2:a', '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=jpn', '-t', '30', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', video], {windowsHide: true, timeout: 15000})
  fs.writeFileSync(path.join(temporary, 'sample.srt'), '1\n00:00:00,000 --> 00:00:20,000\nShared test caption\n')
  const sound = path.join(temporary, 'sound.m4a')
  execFileSync(require('ffmpeg-static'), ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '30', '-c:a', 'aac', sound], {windowsHide: true, timeout: 15000})
  const picture = path.join(temporary, 'picture.png')
  execFileSync(require('ffmpeg-static'), ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:size=64x64', '-frames:v', '1', picture], {windowsHide: true, timeout: 15000})
  const short = path.join(temporary, 'short.mp4') // M1.12: a film short enough to loop many times in a few seconds
  execFileSync(require('ffmpeg-static'), ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '2.5', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', short], {windowsHide: true, timeout: 15000})
  return {video, picture, sound, short}
}

app.whenReady().then(async () => {
  const windows = []
  const watchdog = setTimeout(() => { console.error('Network integration check timed out'); finish(1) }, publicDiscovery || checkYouTube ? 240000 : 180000)
  try {
    const {video, picture, sound, short} = await fixtures()
    diagnostics.start({dir: path.join(temporary, 'logs'), info: {version: app.getVersion()}})
    require('../main/main').registerIpc()
    ipcMain.removeHandler('net:ice-servers')
    ipcMain.handle('net:ice-servers', () => [])
    // Shares capture a synthetic canvas and oscillator instead (fakeShare below), never the real screen.
    ipcMain.removeHandler('screenshare:select')
    ipcMain.handle('screenshare:select', () => true)
    for (const name of ['alpha', 'bravo', 'charlie', 'delta'].slice(0, liveRatePeople || 3)) {
      const win = new BrowserWindow({show: false, webPreferences: {partition: `network-${name}`, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required', preload: path.join(temporary, 'preload.js')}})
      windows.push(win)
      testWindows.push([name, win])
      win.webContents.setAudioMuted(true) // checks read levels inside Web Audio; nothing plays out loud
      require('../main/main').watchTransportWarnings(win.webContents)
      if (checkYouTube) registerYouTube(win.webContents.session)
      win.webContents.on('console-message', (details) => {
        if (details.level === 'error' || publicDiscovery && details.level === 'warning') console.error(`${name}: ${details.message}`)
      })
      await win.loadFile(path.join(temporary, 'index.html'))
      await until(win, 'window.__test && !document.getElementById("welcome").hidden')
      if (publicDiscovery && name !== 'bravo') await run(win, `__test.primed = __test.primeDiscovery(${JSON.stringify(name === 'alpha' ? 'presence' : 'persistent')}); true`)
      await run(win, `document.getElementById('handle').value=${JSON.stringify(name)}; document.getElementById('welcome-name').value=${JSON.stringify(name)}; document.getElementById('welcome-form').dispatchEvent(new Event('submit', {cancelable:true}));`)
      await until(win, '__test.friendNetwork.identity && !document.getElementById("home").hidden')
    }
    if (liveRatePeople) {
      await checkLiveRate(windows, video)
      return
    }
    const [a, b, c] = windows
    const names = await Promise.all(windows.map((win) => run(win, '__test.identity.username')))
    await run(a, `__test.friendNetwork.add(${JSON.stringify(names[1])})`)
    await until(b, '__test.friendNetwork.requests.size === 1')
    await run(b, `__test.friendNetwork.add(${JSON.stringify(names[0])})`)
    await Promise.all([a, b].map((win) => until(win, '__test.friendNetwork.online.size === 1')))
    console.log(`PASS: Signed friend request, acceptance and presence via ${publicDiscovery ? 'public Nostr relays' : 'local discovery'} and real WebRTC`)

    const joinAll = () => Promise.all(windows.map((win) => run(win, '__test.enterRoom("ABCDEFGH")')))
    const connected = () => Promise.all(windows.map((win) => until(win, '__test.session.peers.size === 2')))
    // One of the three leaves and comes straight back, churnLoop times; everyone must be connected again each time.
    const churn = async (room) => {
      for (let i = 1; i <= churnLoop; i++) {
        const who = [a, b, c][i % 3]
        await run(who, '__test.leaveRoom()')
        await pause(i * 37 % 250) // from straight away to a quarter of a second
        await run(who, `__test.enterRoom("${room}")`)
        await connected()
        if (churnLoop > 3) console.log(`churn ${i}/${churnLoop} ok`)
      }
    }
    await run(a, '__test.enterRoom("ABCDEFGH", {joining:false})')
    assert.equal(await run(a, 'document.getElementById("room-name").value'), "alpha's Room")
    await run(a, `
      if (document.getElementById('room').classList.contains('people-open')) document.getElementById('people-toggle').click();
      document.getElementById('people-toggle').click();
    `)
    assert.equal(await run(a, 'document.getElementById("room-name").checkVisibility()'), true)
    assert.equal(await run(a, '__test.session.peers.size'), 0)
    await run(a, `document.getElementById('room-name').value='  Movie   Night  '; document.getElementById('room-name-form').requestSubmit();`)
    assert.equal(await run(a, 'document.getElementById("room-name").value'), 'Movie Night')
    await run(a, `document.getElementById('room-name').value='   '; document.getElementById('room-name-form').requestSubmit();`)
    assert.equal(await run(a, 'document.getElementById("room-name").value'), 'Movie Night')
    console.log('PASS: Couch shows the default room name before anyone joins; edits save and blank names preserve it')
    await Promise.all([b, c].map((win) => run(win, '__test.enterRoom("ABCDEFGH")')))
    await connected()
    await Promise.all([b, c].map((win) => until(win, 'document.getElementById("room-name").value === "Movie Night"')))
    await run(b, `document.getElementById('room-name').value='Film Club'; document.getElementById('room-name-form').requestSubmit();`)
    await Promise.all([a, c].map((win) => until(win, 'document.getElementById("room-name").value === "Film Club"')))
    console.log('PASS: New arrivals receive the saved room name and subsequent edits synchronize')
    console.log('PASS: Three authenticated room participants connect while friends remain online')
    if (process.argv.includes('--churn-first')) { // for looping the step alone, without the long steps before it
      await churn('ABCDEFGH')
      console.log(`PASS: One of three leaves and returns straight away ${churnLoop} times and everyone is connected again`)
      return
    }
    if (publicDiscovery) {
      await run(b, '__test.leaveRoom()')
      await until(a, '__test.session.peers.size === 1')
      await run(b, '__test.enterRoom("ABCDEFGH")')
      await connected()
      for (const win of windows) assert.deepEqual(await run(win, '__test.errors'), [])
      console.log('PASS: Public discovery connects across presence-first, friends-first and media-first startup, including rejoining')
      return
    }
    await run(a, `__test.hostFile(${JSON.stringify(video)})`)
    await until(b, '__test.session.link?.receiver?.height === 720')
    await checkMeasurements(windows, a, b)
    await run(a, '__test.control("loop", true)')
    const qualityPeer = await run(b, '__test.selfId')
    await until(a, '!__test.session.sampling && !__test.session.tuning')
    await run(a, `(() => {
      const peer = ${JSON.stringify(qualityPeer)};
      const pc = __test.session.room.getPeers()[peer];
      const getStats = pc.getStats;
      const receiveTelemetry = __test.session.telemetryAction.onMessage;
      const probe = __test.qualityProbe = {pc, getStats, receiveTelemetry, peer, capacity: 350000, lossPct: 0, freezes: 0};
      // Real reports from this viewer must not overwrite the controlled feedback
      // while another peer's asynchronous getStats() is still pending.
      __test.session.telemetryAction.onMessage = (message, context) => {
        if (context.peerId !== peer) return receiveTelemetry(message, context);
      };
      __test.session.people.get(peer).quality = {bitrate: 4000000};
      pc.getStats = async () => {
        const report = await getStats.call(pc);
        const person = __test.session.people.get(peer);
        person.receiver = {lossPct: probe.lossPct, freezes: probe.freezes, droppedFrames: 0, fps: 24, height: 720, bufferMs: 250, delayMs: 250};
        person.receiverAt = performance.now();
        const controlled = new Map(report);
        const pair = [...report.values()].find(stats => stats.type === 'candidate-pair' && stats.nominated && stats.state === 'succeeded');
        // Some platforms omit nominated pairs in their first RTP readings. Give
        // readStats an explicit selected pair for the injected bandwidth value.
        controlled.set('quality-test-pair', {...pair, id: 'quality-test-pair', type: 'candidate-pair', nominated: true, state: 'succeeded', availableOutgoingBitrate: probe.capacity});
        return controlled;
      };
    })()`)
    const qualitySample = async () => {
      await until(a, '!__test.session.sampling && !__test.session.tuning')
      await run(a, '__test.sampleConnection()')
      await until(a, '!__test.session.sampling && !__test.session.tuning')
    }
    const videoEncoding = () => run(a, `__test.qualityProbe.pc.getSenders().find(sender => sender.track?.kind === 'video').getParameters().encodings[0]`)
    try {
      await qualitySample()
      assert.equal((await videoEncoding()).maxBitrate, 4000000)
      assert.equal((await videoEncoding()).scaleResolutionDownBy, 1)
      console.log('PASS: A clean HD stream keeps its picture and ceiling through a low bandwidth estimate')
      await run(a, '__test.qualityProbe.lossPct = 5; __test.qualityProbe.freezes = 1; true')
      await qualitySample()
      assert.equal((await videoEncoding()).maxBitrate, 300000)
      assert.equal((await videoEncoding()).scaleResolutionDownBy, 2)
      // Where the stall began is what was really going out (the encoder's own output for this clip), not the 4 Mbps cap.
      const stalledAt = await run(a, '__test.session.people.get(__test.qualityProbe.peer).quality.failedAt')
      assert.ok(stalledAt > 0, 'the stall was recorded')
      // The sender is held to half size (checked above), so the picture that arrives is at most 360 high. Not exactly 360: this is the
      // real encoder, and libwebrtc's own adaptation may already have taken the source below 720 (a 540 source, halved, is 270).
      await until(b, '__test.session.link?.receiver?.height > 0 && __test.session.link.receiver.height <= 360')
      await run(a, '__test.qualityProbe.capacity = 1200000; __test.qualityProbe.lossPct = 0; __test.qualityProbe.freezes = 0; true')
      // Advance 30 seconds of clean feedback without waiting for the periodic timer.
      for (let i = 0; i < 15; i++) await qualitySample()
      // For a minute after a stall the ceiling stays under 85% of the rate that stalled (at most the
      // 4 Mbps cap; less when the encoder was sending less), which still leaves a 720p clip its full picture.
      const recovered = (await videoEncoding()).maxBitrate
      const expected = 0.85 * Math.min(4000000, stalledAt)
      assert.ok(recovered >= Math.min(3000000, expected * 0.97) && recovered <= 3400000, `ceiling ${recovered} after 30 clean seconds (stalled at ${stalledAt}, expected about ${Math.round(expected)})`)
      // 720p needs a ceiling of 2 Mbps (the ladder's own step). The stall point is the rate the encoder was really sending, which for
      // this synthetic clip is sometimes under that; then the ladder correctly stays at 540p and there is no full picture to wait for.
      if (recovered >= 2000000) {
        assert.equal((await videoEncoding()).scaleResolutionDownBy, 1)
        // Native congestion control can take longer than our accelerated policy
        // samples to reopen its own resolution. Keep the clip playing through it.
        await until(b, '__test.session.link?.receiver?.height === 720', 45000)
      } else {
        console.log(`note: the encoder was sending ${stalledAt} bps at the stall, so recovery stayed at ${recovered} (under the 720p step); the 720p check is skipped`)
        assert.ok((await videoEncoding()).scaleResolutionDownBy <= 1.5)
      }
      console.log('PASS: Congestion reduces real WebRTC video to 360p; fresh clean feedback restores 720p despite a low estimate')
      await run(a, '__test.control("pause")')
      await until(a, 'document.getElementById("local-video").paused')
      const pausedBitrate = (await videoEncoding()).maxBitrate
      await run(a, '__test.qualityProbe.lossPct = 5; __test.qualityProbe.freezes = 1; true')
      await qualitySample()
      assert.equal((await videoEncoding()).maxBitrate, pausedBitrate)
      console.log('PASS: Paused playback does not alter quality on stale trouble reports')
      await run(a, '__test.qualityProbe.lossPct = 0; __test.qualityProbe.freezes = 0; __test.control("play")')
      await until(b, '__test.session.remote?.playing && __test.audioLevel() > 0.01')
      await Promise.all(windows.map(win => run(win, '__test.flushLog()')))
      const exported = path.join(temporary, 'quality-diagnostics.log')
      diagnostics.exportTo(exported)
      const entries = fs.readFileSync(exported, 'utf8').split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
      assert.ok(entries.some(e => e.sc === 'network' && e.ev === 'peer-state' && e.remoteDescription && e.connectionState === 'connected'), 'export records successful remote negotiation and connection state')
      const sent = entries.find(e => e.ev === 'host-sample' && e.sentBitrateBps > 0)
      const received = entries.find(e => e.ev === 'viewer-sample' && e.receivedBitrateBps > 0)
      assert.ok(sent && sent.sendIntervalMs > 0 && sent.source.height === 720, 'export includes measured send bitrate, interval and source size')
      assert.ok(received && received.receiveIntervalMs > 0 && typeof received.playback.playing === 'boolean', 'export includes measured receive bitrate and playback state')
      const inactive = entries.find(e => e.ev === 'host-sample' && e.decision === 'inactive' && !e.playback?.playing && Number.isFinite(e.feedbackAgeMs))
      assert.ok(inactive && inactive.feedbackAgeMs >= 0, 'export explains the tested pause and feedback age, independently of startup samples')
      assert.ok(entries.some(e => e.ev === 'send-quality-change' && e.reason === 'freezes' && e.scaleTo === 2))
      assert.ok(entries.some(e => e.ev === 'send-parameters-applied' && e.kind === 'video' && e.scale === 2 && e.maxBitrate === 300000))
      assert.ok(!/[A-Za-z]:[\\/]Users[\\/]|\/(?:home|Users)\//.test(fs.readFileSync(exported, 'utf8')), 'diagnostic export remains redacted')
      console.log('PASS: Exported diagnostics retain actual send/receive bitrate, playback state, fresh feedback decisions and applied sender parameters')
    } finally {
      await run(a, '__test.qualityProbe.pc.getStats = __test.qualityProbe.getStats; __test.session.telemetryAction.onMessage = __test.qualityProbe.receiveTelemetry; delete __test.qualityProbe; true')
    }
    await run(a, '__test.control("loop", false)')
    await run(a, '__test.control("seek", 0)')
    await Promise.all([b, c].map((win) => until(win, '__test.session.role === "viewer" && document.getElementById("remote-video").getVideoPlaybackQuality().totalVideoFrames > 12')))
    await until(b, '__test.session.clock !== null')
    await Promise.all([b, c].map((win) => until(win, '__test.audioState().running && __test.audioState().connected')))
    await Promise.all([b, c].map((win) => until(win, '__test.audioLevel() > 0.01')))
    console.log('PASS: Both viewers receive moving video and clock synchronization')
    const downloadItem = await run(c, `__test.addToPlaylist([${JSON.stringify(video)}])[0].id`)
    await until(b, `__test.session.playlist.items.has(${JSON.stringify(downloadItem)}) && __test.playable(__test.session.playlist.items.get(${JSON.stringify(downloadItem)}))`)
    const originalSaveDialog = dialog.showSaveDialog
    const {DownloadFiles} = require('../main/downloads')
    const originalRead = DownloadFiles.prototype.read
    const downloaded = path.join(temporary, 'downloaded-original.mp4')
    let saveResult = {canceled: false, filePath: downloaded}
    let delayReads = false
    dialog.showSaveDialog = async () => saveResult
    DownloadFiles.prototype.read = async function (...args) {
      if (delayReads) await pause(300)
      return originalRead.apply(this, args)
    }
    const showDownloadMenu = (win) => run(win, `(() => {
      __test.setPlaylistOpen(true);
      document.querySelector('[data-id="${downloadItem}"] .playlist-options').click();
    })()`)
    const downloadFromMenu = async (win) => {
      await showDownloadMenu(win)
      // Open, check and click in one renderer turn: playlist updates can close
      // the popover between separate executeJavaScript calls.
      await run(win, `(() => {
        const options = document.querySelector('[data-id="${downloadItem}"] .playlist-options');
        if (options.getAttribute('aria-expanded') !== 'true') options.click();
        const download = document.getElementById('playlist-download');
        if (download.disabled || !document.getElementById('playlist-item-menu').matches(':popover-open')) throw new Error('Download menu is not ready');
        download.click();
        if (!__test.session.downloads.jobs.has('${downloadItem}')) throw new Error('Download click did not start a job');
      })()`)
    }
    // A whole file crossing a data channel while a film streams: how long that takes is the
    // machine's throughput, not a state change, and CI's Intel Mac runner needed more than the 15s
    // every other wait gets (its connections were healthy, the transfer just wasn't done).
    const downloadsIdle = (win) => until(win, '__test.session.downloads.jobs.size === 0', publicDiscovery ? 90000 : 60000)
    try {
      await showDownloadMenu(b)
      assert.equal(await run(b, `document.activeElement.id`), 'playlist-download')
      await run(b, `document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowDown',code:'ArrowDown',bubbles:true}))`)
      assert.equal(await run(b, 'document.activeElement.id'), 'playlist-menu-remove')
      await run(b, `document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',code:'Escape',bubbles:true}))`)
      assert.equal(await run(b, 'document.getElementById("playlist-item-menu").matches(":popover-open")'), false)
      assert.equal(await run(b, 'document.activeElement.classList.contains("playlist-options")'), true)
      const wasPaused = await run(a, '__test.getState().paused')
      // Real key presses, through the page's own input pipeline (so Space activates the focused
      // button natively, which a synthetic KeyboardEvent can't). webContents.sendInputEvent goes
      // through the OS window and sometimes never arrived at these hidden windows (traced: no
      // keydown at all); the DevTools protocol delivers to the page whatever the window's focus.
      // A press can also land while the list redraws under it (focus moves to the new row's
      // button between keydown and keyup, so no click): press again, at most three times in all.
      const press = async (win, key, code, keyCode) => {
        if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach()
        for (const type of ['keyDown', 'keyUp']) {
          await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {type, key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, ...(type === 'keyDown' && key.length === 1 ? {text: key} : {})})
        }
      }
      const menuOpen = 'document.getElementById("playlist-item-menu").matches(":popover-open")'
      for (let attempt = 1; ; attempt++) {
        await press(b, ' ', 'Space', 32)
        try {
          await until(b, menuOpen, attempt < 3 ? 2000 : undefined)
          break
        } catch (error) {
          if (attempt >= 3) {
            console.error('menu trace: ' + await run(b, 'JSON.stringify(__test.menuTrace.slice(-30))'))
            throw error
          }
          await run(b, `document.querySelector('#playlist-items .playlist-options')?.focus(); true`)
        }
      }
      assert.equal(await run(a, '__test.getState().paused'), wasPaused)
      await press(b, 'Escape', 'Escape', 27)
      await until(b, '!document.getElementById("playlist-item-menu").matches(":popover-open")')
      b.webContents.debugger.detach()
      const baseRatio = await run(b, 'devicePixelRatio')
      for (const zoom of [0.5, 1, 2]) {
        // A zoom change resizes the page, and the app closes the item menu on resize (it would be
        // left in the wrong place). Under load that resize can arrive after the menu reopens, so
        // wait for the resize itself, not just the new zoom, before opening it.
        await run(b, `window.__resized = false; addEventListener('resize', () => (window.__resized = true), {once: true}); true`)
        b.webContents.setZoomFactor(zoom)
        await until(b, `window.__resized && Math.abs(devicePixelRatio - ${baseRatio * zoom}) < 0.01`)
        await pause(100)
        await showDownloadMenu(b)
        const placement = await run(b, `(() => {
          const box = document.getElementById('playlist-item-menu').getBoundingClientRect();
          const anchor = document.activeElement?.closest?.('.playlist-item')?.getBoundingClientRect?.();
          return JSON.stringify({fits: box.width > 0 && box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight,
            box: [box.left, box.top, box.right, box.bottom].map(Math.round), viewport: [innerWidth, innerHeight], dpr: devicePixelRatio, anchor: anchor && [anchor.left, anchor.top, anchor.right, anchor.bottom].map(Math.round)});
        })()`)
        assert.equal(JSON.parse(placement).fits, true, `Download menu stays in the viewport at ${zoom * 100}% zoom: ${placement}`)
        await run(b, `document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true}))`)
      }
      b.webContents.setZoomFactor(1)
      await pause(100)
      console.log('PASS: Native Space opens the menu without pausing playback; Escape closes it; menu fits at 50%, 100% and 200% zoom')
      await downloadFromMenu(b)
      await downloadsIdle(b)
      assert.ok(fs.existsSync(downloaded), `Download failed: ${await run(b, 'document.getElementById("toast").textContent')}`)
      assert.deepEqual(fs.readFileSync(downloaded), fs.readFileSync(video))
      assert.equal(await run(b, '__test.session.role'), 'viewer')
      assert.equal(await run(a, '__test.session.role'), 'host')
      assert.equal(await run(b, `__test.session.ownFiles.has(${JSON.stringify(downloadItem)})`), false)
      await until(c, '__test.session.downloads.sources.size === 0')
      console.log('PASS: Playlist menu downloads the original file from a non-host owner over WebRTC while playback continues')

      saveResult = {canceled: false, filePath: path.join(temporary, 'local-copy.mp4')}
      await downloadFromMenu(c)
      await downloadsIdle(c)
      assert.deepEqual(fs.readFileSync(saveResult.filePath), fs.readFileSync(video))
      console.log('PASS: Owner can save a local copy through the same menu and native save IPC')

      saveResult = {canceled: true}
      await downloadFromMenu(b)
      await downloadsIdle(b)
      assert.equal(await run(c, '__test.session.downloads.sources.size'), 0)
      console.log('PASS: Cancelling the save dialog opens no peer file transfer')

      saveResult = {canceled: false, filePath: path.join(temporary, 'cancelled.mp4')}
      fs.writeFileSync(saveResult.filePath, 'existing file')
      delayReads = true
      // The 30 s film has been running since the quality steps and the menu checks took their time; start it over so it cannot end
      // during the download (its audio track ends with it, and "sound is still arriving" below would be false for another reason).
      await run(a, '__test.control("seek", 0)')
      await downloadFromMenu(b)
      await until(b, `(__test.session.downloads.jobs.get(${JSON.stringify(downloadItem)})?.received || 0) > 0`)
      const framesDuringDownload = await run(b, 'document.getElementById("remote-video").getVideoPlaybackQuality().totalVideoFrames')
      await until(b, `document.getElementById('remote-video').getVideoPlaybackQuality().totalVideoFrames > ${framesDuringDownload + 3}`)
      assert.equal(await run(b, `__test.session.downloads.jobs.has(${JSON.stringify(downloadItem)})`), true)
      await until(b, '__test.audioLevel() > 0.01') // sound is still arriving while the download runs (an instant's level can be a quiet moment)
      await showDownloadMenu(b)
      assert.equal(await run(b, 'document.getElementById("playlist-download").textContent'), 'Cancel download')
      assert.equal(await run(b, `document.querySelector('[data-id="${downloadItem}"] .playlist-download-progress').hidden`), false)
      if (process.argv.includes('--screenshots')) {
        await pause(100)
        const screenshot = path.join(temporary, 'download-progress.png')
        fs.writeFileSync(screenshot, (await b.capturePage()).toPNG())
        console.log(`Progress screenshot: ${screenshot}`)
      }
      await run(b, 'document.getElementById("playlist-download").click()')
      await downloadsIdle(b)
      await until(c, '__test.session.downloads.sources.size === 0')
      assert.equal(fs.readFileSync(saveResult.filePath, 'utf8'), 'existing file')
      assert.ok(fs.readdirSync(temporary).every((name) => !name.endsWith('.part')))
      console.log('PASS: Progress and menu cancellation remove partial files without overwriting an existing destination')

      saveResult = {canceled: false, filePath: path.join(temporary, 'removed.mp4')}
      await downloadFromMenu(b)
      await until(b, `(__test.session.downloads.jobs.get(${JSON.stringify(downloadItem)})?.received || 0) > 0`)
      await showDownloadMenu(c)
      await run(c, 'document.getElementById("playlist-menu-remove").click()')
      await downloadsIdle(b)
      await until(c, '__test.session.downloads.sources.size === 0')
      assert.equal(fs.existsSync(saveResult.filePath), false)
      assert.ok(fs.readdirSync(temporary).every((name) => !name.endsWith('.part')))
      console.log('PASS: Removing a shared item stops its download and cleans both peers')

    } finally {
      dialog.showSaveDialog = originalSaveDialog
      DownloadFiles.prototype.read = originalRead
      await run(b, '__test.setPlaylistOpen(false)')
      await run(c, '__test.setPlaylistOpen(false)')
    }
    await until(b, '__test.session.remote.subtitles.length === 1')
    assert.equal(await run(b, 'JSON.stringify(__test.session.remote.subtitles).includes("external:")'), false)
    await run(b, '__test.selectSubtitle(__test.session.remote.subtitles[0].value)')
    await until(b, '__test.session.captions.cues.some(cue => cue.text.includes("Shared test caption"))')
    console.log('PASS: Sidecar subtitle cues transfer through opaque track IDs')
    await run(b, '__test.control("pause")')
    await until(a, 'document.getElementById("local-video").paused')
    await until(c, '__test.session.remote.playing === false')
    await run(b, '__test.control("seek", 10)')
    await until(c, 'Math.abs(__test.session.remote.time - 10) < 1')
    // Drawn, not just loaded (the caption runs 0–20s), and cleared again when switched off.
    await until(b, 'document.getElementById("captions").textContent.includes("Shared test caption")')
    await run(b, '__test.selectSubtitle(null)')
    await until(b, 'document.getElementById("captions").textContent === ""')
    await run(b, '__test.selectSubtitle(__test.session.remote.subtitles[0].value)')
    await until(b, 'document.getElementById("captions").textContent.includes("Shared test caption")')
    await run(b, '__test.control("play")')
    await until(a, '!document.getElementById("local-video").paused')
    console.log('PASS: Viewer pause, seek and resume reach the host and other viewer')
    await checkContext(windows, a, b, c)
    for (const track of [1, 0, 1, 0]) {
      await run(b, '__test.control("pause")')
      await until(a, 'document.getElementById("local-video").paused')
      await Promise.all([b, c].map((win) => until(win, '__test.audioLevel() < 0.001')))
      await run(b, `__test.control('audio', __test.session.remote.audio[${track}].value)`)
      await until(a, `__test.getState().audioSelected === __test.getState().audio[${track}].value && document.getElementById('local-video').readyState >= 3`)
      await run(b, '__test.control("play")')
      await Promise.all([b, c].map((win) => until(win, '__test.audioLevel() > 0.01')))
    }
    console.log('PASS: Both viewers receive audible samples after repeated paused English/Japanese switches')
    for (const event of ['removetrack', 'ended']) {
      await run(b, '__test.control("pause")')
      await until(a, 'document.getElementById("local-video").paused')
      await Promise.all([b, c].map((win) => until(win, '__test.audioLevel() < 0.001')))
      await run(a, `__test.replaceCapturedAudio(${JSON.stringify(event)})`)
      assert.equal(await run(a, '__test.session.stream.getAudioTracks().length'), 1)
      await run(b, '__test.control("play")')
      await Promise.all([b, c].map((win) => until(win, '__test.audioLevel() > 0.01 && document.getElementById("remote-video").srcObject.getAudioTracks().length === 1')))
    }
    console.log('PASS: Replaced capture audio removes the old sender and remains audible for both viewers')
    await run(c, `__test.hostFile(${JSON.stringify(video)})`)
    await until(a, '__test.session.role === "viewer" && document.getElementById("remote-video").readyState >= 2')
    await until(b, '__test.session.peerStreams.get(__test.session.hostId)?.claimedAt === __test.session.remote.claimedAt')
    console.log('PASS: Host takeover attaches the stream for the new media revision')
    // M1.11: every file after the first used to reach viewers with picture and no sound (a second captureStream()
    // of the same element lost its audio to the first). Each viewer must hear the new host's file, not the last.
    const heardFrom = (host, claimBefore) => `(() => { const s = __test.session; const tracks = document.getElementById('remote-video').srcObject?.getAudioTracks() || []; return s.role === 'viewer' && s.remote?.claimedAt > ${claimBefore} && s.peerStreams.get(s.hostId)?.claimedAt === s.remote.claimedAt && tracks.some((t) => t.readyState === 'live' && !t.muted) && __test.audioLevel() > 0.01 })()`
    await Promise.all([a, b].map((win) => until(win, heardFrom(c, 0), 45000, 'viewers hear the takeover file')))
    // Ten files on one connection: each one audible, and the connection's size bounded. pc.removeTrack() used to
    // leave an audio and a video m-section behind per file (about 10 KB of offer each); the offer passed the 64 KiB a
    // signalling message may have at the 7th film and the receive budget closed the connection to every viewer.
    const MAX_TRANSCEIVERS = 6 // one film is 2 (audio + video); a source swap or a file change in flight briefly 4; 6 leaves room for a recycled pair
    const hostConnections = () => run(c, `JSON.stringify(Object.values(__test.session.room.getPeers()).map((pc) => ({transceivers: pc.getTransceivers().length, audioSenders: pc.getSenders().filter((s) => s.track?.kind === 'audio' && s.track.readyState === 'live').length, sections: (pc.localDescription.sdp.match(/^m=/gm) || []).length, offerBytes: JSON.stringify({type: pc.localDescription.type, sdp: pc.localDescription.sdp}).length})))`)
    let largest = 0
    for (let n = 2; n <= 11; n++) {
      const copy = path.join(temporary, `file-${n}.mp4`)
      fs.copyFileSync(video, copy)
      const claimBefore = await run(a, '__test.session.remote.claimedAt')
      await run(c, `__test.hostFile(${JSON.stringify(copy)})`)
      await Promise.all([a, b].map((win) => until(win, heardFrom(c, claimBefore), 45000, `viewers hear file ${n}`)))
      // A stopped transceiver goes once the negotiation that ends it is done: give that a moment.
      let shapes = JSON.parse(await hostConnections())
      for (let waited = 0; waited < 10000 && shapes.some((shape) => shape.audioSenders !== 1 || shape.transceivers > MAX_TRANSCEIVERS); waited += 250) {
        await new Promise((resolve) => setTimeout(resolve, 250))
        shapes = JSON.parse(await hostConnections())
      }
      for (const shape of shapes) {
        assert.ok(shape.transceivers <= MAX_TRANSCEIVERS, `file ${n}: ${shape.transceivers} transceivers on one connection (bound ${MAX_TRANSCEIVERS})`)
        assert.ok(shape.sections <= MAX_TRANSCEIVERS, `file ${n}: ${shape.sections} m-sections in the offer (bound ${MAX_TRANSCEIVERS})`)
        assert.equal(shape.audioSenders, 1, `file ${n}: one live audio sender per peer (${JSON.stringify(shape)})`)
        largest = Math.max(largest, shape.offerBytes)
      }
    }
    const final = JSON.parse(await hostConnections())
    console.log(`  after 11 files on one connection: ${final.map((s) => `${s.transceivers} transceivers, ${s.sections} m-sections, offer ${s.offerBytes} bytes`).join(' | ')} (largest offer seen ${largest} bytes; a signalling message may be 65536)`)
    assert.ok(largest < 32768, `the offer stays far below the 64 KiB signalling limit (${largest} bytes)`)
    console.log('PASS: Ten more files on one connection are each audible to both viewers, with bounded transceivers, one live audio sender per peer and a small offer')
    // M1.12: a film on Loop kept playing for the host but went silent for viewers about five seconds after its first
    // repeat (Chromium takes the capture's tracks out of the stream when a finished film restarts, and the app let
    // the published copies go). Six repeats of a 2.5 s film: each viewer hears it in every one, never sees a pause,
    // and keeps one live audio sender.
    {
      const claimBefore = await run(a, '__test.session.remote.claimedAt')
      await run(c, `__test.hostFile(${JSON.stringify(short)})`)
      await Promise.all([a, b].map((win) => until(win, heardFrom(c, claimBefore), 45000, 'viewers hear the short film')))
      await run(c, '__test.control("loop", true)')
      await run(c, 'window.__loops = 0; document.getElementById("local-video").addEventListener("ended", () => window.__loops++); true')
      for (const win of [a, b]) await run(win, 'window.__notPlaying = 0; setInterval(() => { if (__test.session.remote && !__test.session.remote.playing) window.__notPlaying++ }, 50); true')
      for (let repeat = 1; repeat <= 6; repeat++) {
        await until(c, `window.__loops >= ${repeat}`, 20000, `the short film ends for the ${repeat}th time`)
        await pause(1200) // into the new repeat, past the restart's own gap
        await Promise.all([a, b].map((win) => until(win, '__test.audioLevel() > 0.01', 2500, `a viewer hears repeat ${repeat + 1} of the looped film`)))
      }
      const shape = JSON.parse(await hostConnections())
      for (const one of shape) assert.equal(one.audioSenders, 1, `after the loop: one live audio sender per peer (${JSON.stringify(one)})`)
      for (const win of [a, b]) assert.equal(await run(win, 'window.__notPlaying'), 0, 'a loop restart never reaches a viewer as a pause')
      await run(c, '__test.control("loop", false)')
      console.log('PASS: A looped film is heard by both viewers on every one of six repeats and never shows as paused')
    }
    await run(c, `__test.hostFile(${JSON.stringify(path.join(temporary, 'missing.mp4'))})`)
    await Promise.all([a, b].map((win) => until(win, 'Boolean(__test.session.remote?.error) && document.getElementById("spinner").hidden')))
    console.log('PASS: A failed host file reaches both viewers as a terminal error')
    await run(c, `__test.hostFile(${JSON.stringify(picture)})`)
    await Promise.all([a, b].map((win) => until(win, 'Boolean(__test.shownImage())')))
    await run(b, `const current=__test.session.images.get(__test.session.hostId); __test.receiveImage(new Uint8Array([0]),__test.session.hostId,{id:String(current.claimedAt-1),claimedAt:current.claimedAt-1,mime:'image/png'}); if (__test.shownImage() !== current) throw Error('Stale image replaced current image');`)
    console.log('PASS: Full image transfer and stale-image rejection')
    await run(c, `__test.hostFile(${JSON.stringify(sound)})`)
    await Promise.all([a, b].map((win) => until(win, '__test.session.remote?.audioOnly && __test.session.lastInbound?.packetsReceived > 0 && __test.audioState().connected')))
    console.log('PASS: Audio-only playback and packet telemetry after video/image switches')
    for (let i = 0; i < 2; i++) {
      await Promise.all(windows.map((win) => run(win, '__test.leaveRoom()')))
      await joinAll()
      await connected()
    }
    await Promise.all([a, b].map((win) => until(win, '__test.friendNetwork.online.size === 1')))
    await Promise.all(windows.map((win) => run(win, '__test.leaveRoom()')))
    await run(a, '__test.enterRoom("RESTORE1", {joining:false})')
    ipcMain.removeHandler('dialog:media-files')
    ipcMain.handle('dialog:media-files', () => [video])
    for (const selector of ['#empty [data-open-media]', '#playlist-add']) {
      await run(a, `document.querySelector(${JSON.stringify(selector)}).click()`)
      await until(a, 'document.getElementById("local-video").readyState >= 2 && !__test.session.openingMedia')
      assert.equal(await run(a, 'document.getElementById("local-video").paused'), true)
      assert.ok(await run(a, 'document.getElementById("local-video").currentTime < 0.1'))
      assert.equal(await run(a, 'getComputedStyle(document.getElementById("empty")).display'), 'none')
      if (selector.includes('empty')) {
        await run(a, '__test.removeFromPlaylist(__test.session.playing.id)')
        await Promise.all(windows.map((win) => until(win, '__test.session.role === "idle"')))
      }
    }
    console.log('PASS: Local files added from the player or empty sidebar load paused at zero and dismiss the empty player')
    await run(a, '__test.control("play")')
    await until(a, 'document.getElementById("local-video").readyState >= 3')
    await run(a, '__test.control("pause"); __test.control("seek", 7.25)')
    await until(a, 'Math.abs(document.getElementById("local-video").currentTime - 7.25) < 0.1')
    const savedVideo = await run(a, '__test.session.playing.id')
    await run(a, `__test.playItem(__test.addToPlaylist([${JSON.stringify(video)}])[0].id)`)
    await until(a, 'document.getElementById("local-video").readyState >= 3 && !__test.session.openingMedia')
    await run(a, '__test.removeFromPlaylist(__test.session.playing.id)')
    await until(a, `__test.session.playing?.id === ${JSON.stringify(savedVideo)} && !__test.session.openingMedia && Math.abs(document.getElementById("local-video").currentTime - 7.25) < 0.1`)
    assert.equal(await run(a, 'document.getElementById("local-video").paused'), true)
    assert.equal(await run(a, 'getComputedStyle(document.querySelector("#empty [data-open-media]")).display'), 'none')
    console.log('PASS: Removing a playing video loads the previous video paused at its remembered timestamp')
    await run(a, '__test.leaveRoom()')
    assert.ok(Math.abs(await run(a, '__test.history.load("RESTORE1").observed.time') - 7.25) < 0.1)
    await run(a, '__test.enterRoom("RESTORE1")')
    await until(a, '__test.session.preview && document.getElementById("local-video").readyState >= 2')
    assert.equal(await run(a, 'document.getElementById("local-video").paused && !__test.session.stream'), true)
    assert.ok(Math.abs(await run(a, 'document.getElementById("local-video").currentTime') - 7.25) < 0.1)
    await run(b, '__test.enterRoom("RESTORE1")')
    await until(a, '__test.session.peers.size === 1')
    await pause(1200)
    assert.equal(await run(b, '__test.session.role'), 'idle', 'a preview must not publish itself to the room')
    await run(a, '__test.control("play")')
    await until(b, 'document.getElementById("remote-video").readyState >= 3')
    assert.equal(await run(a, '__test.session.preview'), false)
    await run(a, '__test.control("pause"); __test.control("seek", 9)')
    await until(a, 'Math.abs(document.getElementById("local-video").currentTime - 9) < 0.1')
    await run(a, '__test.leaveRoom()')
    await run(b, `__test.hostFile(${JSON.stringify(video)})`)
    await until(b, 'document.getElementById("local-video").readyState >= 3')
    const liveClaim = await run(b, '__test.session.claimedAt')
    await run(a, '__test.enterRoom("RESTORE1")')
    await until(a, '__test.session.role === "viewer" && !__test.session.preview && document.getElementById("remote-video").readyState >= 3')
    assert.equal(await run(b, '__test.session.claimedAt'), liveClaim, 'returning previews cannot take over a live host')
    console.log('PASS: Reopening restores the last video paused at its saved timestamp; Play shares it and existing hosts take precedence')
    // M1.7: a viewer who leaves and rejoins a room whose host is playing must get the picture again, not only
    // the sound (0.8.0 CI once got audio but no video after a rejoin, the host's setParameters rejected).
    // --rejoin-loop=N repeats it N times (default 3); the picture counts only once frames are decoded.
    await run(b, '__test.control("loop", true)') // a long loop must not run past the end of the 30 s film
    for (let i = 1; i <= rejoinLoop; i++) {
      await run(a, '__test.leaveRoom()')
      if (i % 2) await until(b, '__test.session.peers.size === 0') // alternate: the host sees the departure, or the return is quick
      await run(a, '__test.enterRoom("RESTORE1")')
      await until(a, '__test.session.role === "viewer" && document.getElementById("remote-video").readyState >= 3')
      const frames = await run(a, 'document.getElementById("remote-video").getVideoPlaybackQuality().totalVideoFrames')
      await until(a, `document.getElementById("remote-video").getVideoPlaybackQuality().totalVideoFrames > ${frames + 5} && !document.getElementById("remote-video").paused`)
      if (rejoinLoop > 3) console.log(`rejoin ${i}/${rejoinLoop} ok`)
    }
    console.log(`PASS: A viewer rejoining a live host's room gets picture and sound again (${rejoinLoop} times)`)
    for (const win of windows) assert.deepEqual(await run(win, '__test.errors'), [])
    console.log('PASS: Two leave/rejoin cycles retain friends and produce no renderer exceptions')

    await Promise.all(windows.map((win) => run(win, '__test.leaveRoom()')))
    await run(a, '__test.enterRoom("PERSIST1", {joining:false})')
    await Promise.all([b, c].map((win) => run(win, '__test.enterRoom("PERSIST1")')))
    await connected()
    await run(a, `document.getElementById('room-name').value='Weekly movies'; document.getElementById('room-name-form').requestSubmit()`)
    const playlistIds = []
    for (const win of windows) {
      playlistIds.push(await run(win, `__test.addToPlaylist([${JSON.stringify(video)}])[0].id`))
      await Promise.all(windows.map((peer) => until(peer, `__test.session.playlist.items.size === ${playlistIds.length}`)))
    }
    await Promise.all(windows.map((win) => until(win, '[...__test.session.playlist.items.values()].every(__test.playable)')))
    for (const [win, id, seconds] of [[a, playlistIds[0], 8], [b, playlistIds[1], 12]]) {
      await run(win, `__test.playItem(${JSON.stringify(id)})`)
      await until(win, 'document.getElementById("local-video").readyState >= 3')
      await run(win, `__test.control('pause'); __test.control('seek', ${seconds})`)
      await Promise.all(windows.map((peer) => until(peer, `Math.abs((__test.session.playlist.progress.get(${JSON.stringify(id)})?.time ?? -100) - ${seconds}) < 0.5`)))
    }
    await run(a, `__test.moveInPlaylist(${JSON.stringify(playlistIds[2])}, 0)`)
    await Promise.all(windows.map((win) => until(win, `__test.orderedItems(__test.session.playlist)[0].id === ${JSON.stringify(playlistIds[2])}`)))
    const oldPeerIds = await Promise.all(windows.map((win) => run(win, '__test.selfId')))
    const staleRoom = await run(a, '__test.history.load("PERSIST1") && localStorage.getItem(__test.history.prefix + "PERSIST1")')
    await Promise.all(windows.map((win) => run(win, '__test.leaveRoom()')))
    await Promise.all(windows.map((win) => until(win, `Boolean(document.querySelector('.saved-room-open[data-code="PERSIST1"]'))`)))
    // Reload every renderer: transport IDs change, local identity and saved room
    // data must survive. No live peer remains to supply a forgotten playlist.
    await Promise.all(windows.map((win) => win.loadFile(path.join(temporary, 'index.html'))))
    await Promise.all(windows.map((win) => until(win, 'window.__test && __test.friendNetwork.identity && !document.getElementById("home").hidden')))
    for (let i = 0; i < windows.length; i++) {
      assert.notEqual(await run(windows[i], '__test.selfId'), oldPeerIds[i])
      assert.equal(await run(windows[i], '__test.identity.username'), names[i])
      assert.equal(await run(windows[i], '__test.history.load("PERSIST1").details.name'), 'Weekly movies')
      assert.equal(await run(windows[i], '__test.history.load("PERSIST1").ownFiles.size'), 1)
    }
    await run(a, `document.querySelector('.saved-room-open[data-code="PERSIST1"]').click()`)
    await until(a, '__test.session.code === "PERSIST1" && __test.session.availableFiles.size === 1')
    assert.deepEqual(await run(a, '__test.orderedItems(__test.session.playlist).map(item => item.id)'), [playlistIds[2], playlistIds[0], playlistIds[1]])
    assert.equal(await run(a, 'document.querySelectorAll(".playlist-item.missing").length'), 2)
    assert.equal(await run(a, 'document.querySelectorAll(".playlist-item.missing .playlist-play:disabled").length'), 2)
    assert.ok(await run(a, 'document.getElementById("playlist-items").textContent.includes("Unavailable")'))
    await run(a, '__test.setPlaylistOpen(true); if (document.getElementById("room").classList.contains("people-open")) document.getElementById("people-toggle").click()')
    await run(a, 'document.getAnimations().forEach(animation => animation.finish())')
    assert.ok(await run(a, 'document.getElementById("playlist").getBoundingClientRect().width >= 220'))
    assert.ok(Math.abs(await run(a, `__test.session.playlist.progress.get(${JSON.stringify(playlistIds[1])}).time`) - 12) < 0.5)
    await run(a, '__test.control("play")')
    await until(a, '__test.session.role === "host" && document.getElementById("local-video").currentTime >= 7.5 && document.getElementById("local-video").readyState >= 3')
    await run(a, '__test.control("pause")')
    console.log('PASS: All three copies retain room name, playlist order and per-item progress after everyone leaves and restarts; Resume skips offline owners')
    await Promise.all([b, c].map((win) => run(win, `document.querySelector('.saved-room-open[data-code="PERSIST1"]').click()`)))
    await connected()
    await Promise.all(windows.map((win) => until(win, '[...__test.session.playlist.items.values()].every(__test.playable)')))
    await run(a, `__test.moveInPlaylist(${JSON.stringify(playlistIds[2])}, 2)`)
    await Promise.all(windows.map((win) => until(win, `__test.orderedItems(__test.session.playlist)[2].id === ${JSON.stringify(playlistIds[2])}`)))
    await run(b, '__test.leaveRoom()')
    await until(a, '__test.session.peers.size === 1 && document.querySelectorAll(".playlist-item.missing").length === 1')
    await until(b, `document.querySelector('.saved-room-open[data-code="PERSIST1"] .saved-room-members')?.textContent === 'In room: alpha, charlie'`)
    assert.equal(await run(b, '__test.session.room'), null, 'watching presence must not join the media room')
    assert.equal(await run(b, 'document.getElementById("saved-room-items").textContent.includes("PERS-IST1")'), false)
    assert.equal(await run(b, 'document.getElementById("saved-rooms").textContent.includes("Return to a room")'), false)
    console.log('PASS: Saved room cards hide codes and show live occupants, including non-friends, without joining the room')
    await run(a, '__test.control("seek", 29); __test.control("play")')
    await until(c, `__test.session.role === 'host' && __test.session.playing?.id === ${JSON.stringify(playlistIds[2])} && document.getElementById('local-video').readyState >= 3`)
    await until(a, `(() => { const s = __test.session; const tracks = document.getElementById('remote-video').srcObject?.getAudioTracks() || []; return s.role === 'viewer' && s.peerStreams.get(s.hostId)?.claimedAt === s.remote?.claimedAt && tracks.some((t) => t.readyState === 'live' && !t.muted) && __test.audioLevel() > 0.01 })()`, 45000, 'the viewer hears the item the playlist advanced to')
    console.log('PASS: Ending playback skips an offline owner’s item and starts the next available owner’s media')
    await run(a, `__test.playItem(${JSON.stringify(playlistIds[0])})`)
    await until(a, '__test.session.role === "host" && !document.getElementById("local-video").paused')
    await until(c, '__test.session.role === "viewer" && __test.session.remote.playing')
    await run(a, '__test.leaveRoom()')
    await until(b, `document.querySelector('.saved-room-open[data-code="PERSIST1"] .saved-room-members')?.textContent === 'In room: charlie'`)
    await until(c, `__test.session.role === 'host' && __test.session.playing?.id === ${JSON.stringify(playlistIds[2])} && !__test.session.openingMedia && document.getElementById('local-video').readyState >= 3`)
    console.log('PASS: When the active host leaves, remaining viewers skip unavailable items and continue with an available owner')
    await run(c, '__test.control("pause"); __test.control("seek", 6)')
    await until(c, 'Math.abs(document.getElementById("local-video").currentTime - 6) < 0.5')
    await run(c, '__test.leaveRoom()')
    await until(b, `document.querySelector('.saved-room-open[data-code="PERSIST1"] .saved-room-members')?.textContent === 'No one connected'`)
    // Reopen an older copy, start playback, then reunite it with a newer saved
    // history. Subsequent playback must still issue winning progress updates.
    await run(a, `localStorage.setItem(__test.history.prefix + 'PERSIST1', ${JSON.stringify(staleRoom)}); __test.enterRoom('PERSIST1')`)
    await until(a, '__test.session.availableFiles.size === 1')
    await run(a, `__test.playItem(${JSON.stringify(playlistIds[0])})`)
    await until(a, '__test.session.role === "host" && document.getElementById("local-video").readyState >= 3')
    await run(a, '__test.control("pause")')
    await run(c, '__test.enterRoom("PERSIST1")')
    await until(a, '__test.session.peers.size === 1')
    await until(a, `__test.session.playlist.progress.get(${JSON.stringify(playlistIds[2])})?.time >= 5.5`)
    await run(a, '__test.control("seek", 4)')
    await Promise.all([a, c].map((win) => until(win, `Math.abs((__test.session.playlist.progress.get(${JSON.stringify(playlistIds[0])})?.time ?? 100) - 4) < 0.5`)))
    console.log('PASS: A stale saved copy merges newer offline history and continues saving fresh playback progress')
    const vanished = path.join(temporary, 'vanished.mp4')
    fs.copyFileSync(video, vanished)
    const vanishedId = await run(a, `__test.addToPlaylist([${JSON.stringify(vanished)}])[0].id`)
    await until(c, `__test.session.playlist.items.has(${JSON.stringify(vanishedId)}) && __test.playable(__test.session.playlist.items.get(${JSON.stringify(vanishedId)}))`)
    fs.unlinkSync(vanished)
    await run(a, '__test.refreshAvailability()')
    await until(c, `!__test.playable(__test.session.playlist.items.get(${JSON.stringify(vanishedId)}))`)
    await run(c, `__test.removeFromPlaylist(${JSON.stringify(playlistIds[1])})`)
    await until(a, `!__test.session.playlist.items.has(${JSON.stringify(playlistIds[1])})`)
    await run(b, '__test.enterRoom("PERSIST1")')
    await connected()
    await until(b, `!__test.session.playlist.items.has(${JSON.stringify(playlistIds[1])}) && __test.session.ownFiles.size === 0`)
    console.log('PASS: Missing files become unavailable; a returning owner’s stale snapshot cannot resurrect a removed item')
    if (checkYouTube) {
      await run(a, '[...__test.session.playlist.items.keys()].forEach(id => __test.removeFromPlaylist(id))')
      await Promise.all(windows.map((win) => until(win, '__test.session.role === "idle" && __test.session.playlist.items.size === 0')))
      await run(a, `document.getElementById('playlist-add-url').click(); document.querySelector('#playlist-url-form input').value = 'https://www.youtube.com/watch?v=M7lc1UVf-VE'; document.getElementById('playlist-url-form').requestSubmit()`)
      await Promise.all(windows.map((win) => until(win, '__test.youtube.loaded && __test.youtube.duration > 0', 45000)))
      for (const win of windows) {
        assert.equal(await run(win, '__test.youtube.playing'), false)
        assert.ok(await run(win, '__test.youtube.time < 0.1'))
        assert.equal(await run(win, 'getComputedStyle(document.getElementById("empty")).display'), 'none')
      }
      console.log('PASS: A YouTube link added to an empty sidebar loads paused at zero for everyone and dismisses the empty player')
      await run(a, '__test.removeFromPlaylist(__test.session.playing.id)')
      await Promise.all(windows.map((win) => until(win, '__test.session.role === "idle"')))
      await run(a, `document.getElementById('media-url').value = 'https://www.youtube.com/watch?v=M7lc1UVf-VE'; document.getElementById('media-url-form').requestSubmit()`)
      await until(a, '__test.youtube.loaded && __test.youtube.duration > 0', 45000)
      assert.equal(await run(a, '__test.youtube.playing'), false)
      assert.ok(await run(a, '__test.youtube.time < 0.1'))
      await run(a, '__test.control("play")')
      await Promise.all(windows.map((win) => until(win, '__test.youtube.playing && __test.youtube.time > 1', 45000)))
      assert.equal(await run(c, '[...__test.session.playlist.items.values()].filter(item => item.youtubeId).length'), 1)
      await run(b, '__test.control("pause")')
      await Promise.all(windows.map((win) => until(win, '__test.youtube.state === 2')))
      await run(c, '__test.control("seek", 15)')
      await Promise.all(windows.map((win) => until(win, 'Math.abs(__test.youtube.time - 15) < 1.5')))
      await run(b, '__test.control("play")')
      await Promise.all(windows.map((win) => until(win, '__test.youtube.playing && __test.youtube.time > 16')))
      console.log('PASS: Three participants play YouTube directly; viewer pause, seek and resume synchronize')
      const ytId = await run(a, '__test.session.playing.id')
      await run(c, `__test.playItem(${JSON.stringify(ytId)})`)
      await until(c, '__test.session.role === "host" && __test.youtube.playing')
      await Promise.all([a, b].map((win) => until(win, '__test.session.role === "viewer" && __test.youtube.playing')))
      await run(c, `__test.hostFile(${JSON.stringify(video)})`)
      await until(c, 'document.getElementById("local-video").readyState >= 3 && !__test.youtube.frame')
      await Promise.all([a, b].map((win) => until(win, 'document.getElementById("remote-video").readyState >= 3 && !__test.youtube.frame')))
      console.log('PASS: YouTube host takeover and switching back to local WebRTC playback clean up embeds')
      const claimBeforeImport = await run(c, '__test.session.claimedAt')
      await run(a, `const transfer = new DataTransfer(); transfer.setData('text/uri-list', '# YouTube link\\r\\nhttps://www.youtube.com/watch?v=M7lc1UVf-VE'); document.getElementById('playlist').dispatchEvent(new DragEvent('drop', {bubbles:true, cancelable:true, dataTransfer:transfer}))`)
      await Promise.all(windows.map((win) => until(win, '[...__test.session.playlist.items.values()].filter(item => item.youtubeId).length === 2', 15000)))
      assert.equal(await run(c, '__test.session.claimedAt'), claimBeforeImport)
      console.log('PASS: Dragging a YouTube link into the sidebar adds it for everyone without changing playback')
      await run(a, `document.getElementById('playlist-add-url').click(); document.querySelector('#playlist-url-form input').value = 'https://www.youtube.com/playlist?list=PLBCF2DAC6FFB574DE'; document.getElementById('playlist-url-form').requestSubmit()`)
      await Promise.all(windows.map((win) => until(win, '[...__test.session.playlist.items.values()].filter(item => item.youtubeId).length === 12', 45000)))
      const imported = await run(a, '__test.orderedItems(__test.session.playlist).filter(item => item.youtubeId).map(item => item.youtubeId)')
      for (const win of [b, c]) assert.deepEqual(await run(win, '__test.orderedItems(__test.session.playlist).filter(item => item.youtubeId).map(item => item.youtubeId)'), imported)
      assert.equal(await run(c, '__test.session.claimedAt'), claimBeforeImport)
      assert.equal(await run(c, '__test.session.role === "host" && !__test.youtube.videoId && !document.getElementById("local-video").paused'), true)
      console.log('PASS: Sidebar URL imports append to the queue without taking over or interrupting playback')
      await run(a, '__test.leaveRoom()')
      await until(c, '__test.session.peers.size === 1')
      assert.equal(await run(c, '[...__test.session.playlist.items.values()].filter(item => item.youtubeId).every(__test.playable)'), true)
      await run(c, `__test.playItem(${JSON.stringify(ytId)})`)
      await Promise.all([b, c].map((win) => until(win, '__test.youtube.videoId === "M7lc1UVf-VE" && __test.youtube.playing')))
      console.log('PASS: Entire YouTube playlist imports in matching order on all peers and stays playable after its contributor leaves')
      await run(c, '__test.control("loop", true); __test.control("seek", __test.youtube.duration - 0.5); __test.control("play")')
      await until(c, '__test.youtube.playing && __test.youtube.time < 3')
      await until(b, '__test.session.loop && __test.youtube.playing && __test.youtube.time < 5')
      await run(c, '__test.control("loop", false)')
      for (let cycle = 0; cycle < 3; cycle++) {
        await run(c, `__test.hostFile(${JSON.stringify(video)})`)
        await until(c, 'document.getElementById("local-video").readyState >= 3 && !__test.youtube.frame')
        await until(b, 'document.getElementById("remote-video").readyState >= 3 && !__test.youtube.frame')
        await run(b, `__test.playItem(${JSON.stringify(ytId)})`)
        await Promise.all([b, c].map((win) => until(win, '__test.youtube.playing')))
      }
      console.log('PASS: Shared YouTube loop and three repeated local/YouTube host switches')
      await run(b, '__test.control("pause"); __test.control("seek", 12)')
      await Promise.all([b, c].map((win) => until(win, '__test.youtube.state === 2 && Math.abs(__test.youtube.time - 12) < 0.5')))
      await Promise.all([b, c].map((win) => run(win, '__test.leaveRoom()')))
      await run(b, '__test.enterRoom("PERSIST1")')
      await until(b, '__test.session.preview && __test.youtube.loaded && __test.youtube.duration > 0')
      assert.equal(await run(b, '__test.youtube.playing'), false)
      assert.ok(Math.abs(await run(b, '__test.youtube.time') - 12) < 0.5)
      await run(b, '__test.control("play")')
      await until(b, '!__test.session.preview && __test.youtube.playing && __test.youtube.time >= 12')
      console.log('PASS: Reopening YouTube restores the observed timestamp paused and resumes on Play')
    }
    // Isolate departure checks from the audiovisual fixture: transferring a playlist
    // file must work in an idle room too, and late replies must not enter a new room.
    for (let i = 1; i < switchLoop; i++) {
      await Promise.all(windows.map((win) => run(win, '__test.leaveRoom()')))
      const room = `SWITCH${i % 2}`
      await run(a, `__test.enterRoom("${room}", {joining:false})`)
      await Promise.all([b, c].map((win) => run(win, `__test.enterRoom("${room}")`)))
      await connected()
      console.log(`switch ${i}/${switchLoop - 1} ok`)
    }
    await Promise.all(windows.map((win) => run(win, '__test.leaveRoom()')))
    await run(a, '__test.enterRoom("DWNLOAD1", {joining:false})')
    await Promise.all([b, c].map((win) => run(win, '__test.enterRoom("DWNLOAD1")')))
    await connected()
    await churn('DWNLOAD1')
    console.log(`PASS: One of three leaves and returns straight away ${churnLoop} times and everyone is connected again`)
    if (process.argv.includes('--stop-after-churn')) return // for looping this step alone
    const departureItem = await run(c, `__test.addToPlaylist([${JSON.stringify(video)}])[0].id`)
    await until(b, `__test.session.playlist.items.has(${JSON.stringify(departureItem)}) && __test.playable(__test.session.playlist.items.get(${JSON.stringify(departureItem)}))`)
    const departureSave = path.join(temporary, 'departed-owner.mp4')
    let departurePath = departureSave
    dialog.showSaveDialog = async () => ({canceled: false, filePath: departurePath})
    DownloadFiles.prototype.read = async function (...args) { await pause(300); return originalRead.apply(this, args) }
    const startDepartureDownload = () => run(b, `__test.session.downloads.download(${JSON.stringify(departureItem)}, [...__test.session.peers].find(id => __test.session.identities.get(id) === ${JSON.stringify(names[2])})); true`)
    const departureHasProgress = () => until(b, `(__test.session.downloads.jobs.get(${JSON.stringify(departureItem)})?.received || 0) > 0`)
    try {
      await startDepartureDownload()
      await departureHasProgress()
      await run(c, '__test.leaveRoom()')
      await downloadsIdle(b)
      assert.equal(fs.existsSync(departureSave), false)
      assert.ok(fs.readdirSync(temporary).every((name) => !name.endsWith('.part')))
      await run(b, `__test.setPlaylistOpen(true); document.querySelector('[data-id="${departureItem}"] .playlist-options').click()`)
      assert.equal(await run(b, 'document.getElementById("playlist-download").disabled'), true)
      await run(c, '__test.enterRoom("DWNLOAD1")')
      await connected()
      await until(c, `__test.session.availableFiles.has(${JSON.stringify(departureItem)})`)
      await until(b, `__test.session.playlist.items.has(${JSON.stringify(departureItem)}) && __test.playable(__test.session.playlist.items.get(${JSON.stringify(departureItem)}))`)
      console.log('PASS: Owner departure stops the download and removes its temporary file; downloading becomes available after rejoining')

      departurePath = path.join(temporary, 'departed-viewer.mp4')
      await run(b, 'window.departedDownloads=__test.session.downloads; true')
      await startDepartureDownload()
      await departureHasProgress()
      await run(b, '__test.leaveRoom()')
      await until(b, 'window.departedDownloads.jobs.size === 0')
      await until(c, '__test.session.downloads.sources.size === 0')
      assert.equal(fs.existsSync(departurePath), false)
      assert.ok(fs.readdirSync(temporary).every((name) => !name.endsWith('.part')))
      await run(b, '__test.enterRoom("DWNLOAD2", {joining:false})')
      await pause(400)
      assert.equal(await run(b, '__test.session.downloads.jobs.size + __test.session.downloads.sources.size'), 0)
      assert.equal(await run(b, '__test.session.downloads === window.departedDownloads'), false)
      console.log('PASS: Downloader departure cleans both peers; late transfer replies cannot enter the next room')
    } finally {
      dialog.showSaveDialog = originalSaveDialog
      DownloadFiles.prototype.read = originalRead
    }
    // Simultaneous screen shares, with synthetic captures: a canvas and an oscillator that only
    // feeds a MediaStream, so the check never touches the real screen or the speakers.
    await Promise.all(windows.map((win) => run(win, '__test.leaveRoom()')))
    await run(a, '__test.enterRoom("SHARING1", {joining:false})')
    await Promise.all([b, c].map((win) => run(win, '__test.enterRoom("SHARING1")')))
    await connected()
    for (const [index, win] of windows.entries()) await run(win, `
      navigator.mediaDevices.getDisplayMedia = async () => {
        const canvas = Object.assign(document.createElement('canvas'), {width: 320, height: 180});
        const draw = canvas.getContext('2d');
        let frame = 0;
        setInterval(() => { draw.fillStyle = 'hsl(' + (${index * 120} + frame++ % 60) + ', 80%, 50%)'; draw.fillRect(0, 0, 320, 180) }, 33);
        const stream = canvas.captureStream(30);
        const context = new AudioContext();
        const tone = context.createOscillator();
        const sink = context.createMediaStreamDestination();
        tone.connect(sink);
        tone.start();
        stream.addTrack(sink.stream.getAudioTracks()[0]);
        return stream;
      };
      __test.shareSettings.audioDeviceId = 'system';
      true`)
    const [idA, idB, idC] = await Promise.all(windows.map((win) => run(win, '__test.selfId')))
    const tileKeys = (win) => run(win, '[...document.querySelectorAll("#share-tiles .share-tile")].map(tile => tile.dataset.key)')
    const visibleTiles = (win) => run(win, '[...document.querySelectorAll("#share-tiles .share-tile")].filter(tile => tile.checkVisibility()).map(tile => tile.dataset.key)')
    const framesFlowing = (win) => until(win, '[...document.querySelectorAll("#share-tiles video")].every(video => video.readyState >= 2 && video.videoWidth === 320)')
    await run(a, `__test.hostFile(${JSON.stringify(video)})`)
    await Promise.all([b, c].map((win) => until(win, 'document.getElementById("remote-video").readyState >= 3')))

    await run(b, '__test.startShare({id: "screen:0:0", name: "Bravo screen"}); true')
    await until(b, '__test.session.role === "host" && __test.session.screen?.alongside === false')
    await Promise.all([a, c].map((win) => until(win, `__test.session.role === "viewer" && __test.tileViews.has(${JSON.stringify(idB)})`)))
    assert.equal(await run(a, '__test.session.playing'), null, "the first share replaced alpha's movie")
    console.log('PASS: A first share claims host and replaces the movie')

    // A screen: a window share on Windows follows a real window (win-app-windows), and this one is synthetic.
    await run(c, '__test.startShare({id: "screen:1:0", name: "Charlie window"}); true')
    await until(c, '__test.session.screen?.alongside === true')
    assert.equal(await run(c, '__test.session.role'), 'viewer')
    assert.equal(await run(b, '__test.session.role === "host" && Boolean(__test.session.screen)'), true, 'a share alongside leaves the host sharing')
    await until(a, '__test.tileViews.size === 2')
    await until(b, '__test.tileViews.size === 2')
    await until(c, '__test.tileViews.size === 2')
    assert.deepEqual(await tileKeys(a), [idB, idC].sort())
    assert.deepEqual(await tileKeys(b), ['self', idC])
    assert.deepEqual(await tileKeys(c), ['self', idB])
    await Promise.all(windows.map(framesFlowing))
    for (const win of [b, c]) assert.equal(await run(win, '!__test.tileViews.get("self").mute && !__test.tileViews.get("self").gain'), true, 'your own tile is silent')
    console.log('PASS: Two people share at once; everyone sees both, sharers see their own preview first')

    await until(a, `[${JSON.stringify(idB)}, ${JSON.stringify(idC)}].every(id => __test.tileViews.get(id).source) && __test.audioLevel() > 0.05`)
    await run(a, `document.querySelector('.share-tile[data-key="${idB}"] .share-tile-mute').click()`)
    await until(a, `__test.tileViews.get(${JSON.stringify(idB)}).gain.gain.value < 0.01 && __test.tileViews.get(${JSON.stringify(idC)}).gain.gain.value > 0.99`)
    await until(a, '__test.audioLevel() > 0.05')
    await run(a, `document.querySelector('.share-tile[data-key="${idB}"] .share-tile-mute').click()`)
    await until(a, `__test.tileViews.get(${JSON.stringify(idB)}).gain.gain.value > 0.99`)
    console.log('PASS: Both shares\' audio mixes for a viewer, and each tile mutes on its own')

    assert.deepEqual(await run(a, '[...document.querySelectorAll("#share-tabs .share-tab")].map(tab => tab.textContent)'), ['All', ...[idB, idC].sort().map((id) => (id === idB ? 'bravo' : 'charlie'))])
    await run(a, '[...document.querySelectorAll("#share-tabs .share-tab")].find(tab => tab.textContent === "charlie").click()')
    assert.deepEqual(await visibleTiles(a), [idC])
    await run(a, `document.querySelector('.share-tile[data-key="${idC}"]').click()`)
    assert.deepEqual(await visibleTiles(a), [idB, idC].sort())
    await run(b, '[...document.querySelectorAll("#share-tabs .share-tab")].find(tab => tab.textContent === "You").click()')
    assert.deepEqual(await visibleTiles(b), ['self'])
    await run(b, '[...document.querySelectorAll("#share-tabs .share-tab")].find(tab => tab.textContent === "All").click()')
    assert.deepEqual(await visibleTiles(b), ['self', idC])
    if (process.argv.includes('--screenshots')) {
      const screenshot = path.join(temporary, 'share-grid.png')
      await run(b, "document.getElementById('room').classList.contains('people-open') && document.getElementById('people-toggle').click()")
      await run(b, "document.getElementById('toast').hidden = true")
      // A hidden window never repaints, so show it off-screen just long enough to capture.
      b.setBounds({x: -4000, y: -4000, width: 1280, height: 720})
      b.showInactive()
      await pause(800)
      fs.writeFileSync(screenshot, (await b.capturePage()).toPNG())
      b.hide()
      console.log(`Share grid screenshot: ${screenshot}`)
    }
    console.log('PASS: Tabs and tile clicks switch between one share full size and all of them')

    await run(b, '__test.stopShare()')
    await Promise.all([a, b].map((win) => until(win, `__test.session.role === "idle" && __test.tileViews.size === 1 && __test.tileViews.has(${JSON.stringify(idC)})`)))
    await until(c, '__test.session.role === "idle" && Boolean(__test.session.screen) && __test.tileViews.size === 1')
    await run(a, '__test.startShare({id: "screen:0:0", name: "Alpha screen"}); true')
    await until(a, '__test.session.screen?.alongside === true && __test.session.role === "idle"')
    await Promise.all([b, c].map((win) => until(win, `__test.tileViews.has(${JSON.stringify(idA)})`)))
    console.log('PASS: The rest keep sharing after the host stops, and a new share joins them without claiming host')

    await run(b, `__test.hostFile(${JSON.stringify(video)})`)
    await Promise.all([a, c].map((win) => until(win, '!__test.session.screen && __test.tileViews.size === 0 && document.getElementById("remote-video").readyState >= 3')))
    assert.equal(await run(b, '__test.tileViews.size'), 0)
    console.log('PASS: Opening a movie ends every share and plays for everyone')
    for (const win of windows) assert.deepEqual(await run(win, '__test.errors'), [])
  } finally {
    clearTimeout(watchdog)
    // So a failure's log below includes what the windows recorded in their last moments.
    await Promise.all(windows.map((win) => (win.isDestroyed() ? null : run(win, '__test.flushLog()').catch(() => {}))))
    await pause(300)
    for (const win of windows) if (!win.isDestroyed()) win.destroy()
    require('../main/media').stopAll()
    diagnostics.stop()
  }
}).then(() => finish(0), (error) => {
  console.error(error)
  // A timeout says what never happened, not why: the windows' own log usually does (a host
  // failing to play, ffmpeg exiting), and on CI this is the only place to see it.
  try {
    const dir = path.join(temporary, 'logs')
    const lines = fs.readdirSync(dir).filter((name) => name.endsWith('.log')).sort().reverse()
      .flatMap((name) => fs.readFileSync(path.join(dir, name), 'utf8').split('\n'))
      .filter((line) => /"lv":"(error|warn)"|"sc":"(media|ffmpeg)"/.test(line) && !/"ev":"ice-error"/.test(line))
    console.error(`--- last ${Math.min(40, lines.length)} errors, warnings and media events from the windows' log ---`)
    for (const line of lines.slice(-40)) console.error(line.slice(0, 600))
    // Who joined and left what, and when, for a connection that never formed (M1.7: the Mac CI rejoin failure).
    const peers = lines.length ? fs.readdirSync(dir).filter((name) => name.endsWith('.log')).sort().reverse()
      .flatMap((name) => fs.readFileSync(path.join(dir, name), 'utf8').split('\n')).filter((line) => /"sc":"(peer|room|network)"/.test(line)) : []
    console.error(`--- last ${Math.min(40, peers.length)} peer, room and network events ---`)
    for (const line of peers.slice(-40)) console.error(line.slice(0, 400))
  } catch (logError) {
    console.error(`(no diagnostic log to show: ${logError.message})`)
  }
  finish(1)
})
