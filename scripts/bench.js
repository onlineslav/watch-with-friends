// `npm run bench`: how far apart a viewer sees a flash and hears its beep, and how the audio and video
// arrive, measured the same way every time so a change to the media path is a number, not a feeling.
//
//   film   a host plays a generated clip (moving picture, white flash patch, 1kHz beep at the same
//          instant, quiet stereo bed tone) and a viewer receives it over real WebRTC
//   share  a sharer shares a "window" that draws the same schedule, its sound coming from the clip's own PCM
//          through the real app-audio path (main/app-audio.js -> renderer/app-audio.mjs -> the share
//          stream) from a stand-in helper; only the OS capture call is skipped, because it makes sound
//   republish  (only with --variant=republish) a host opens the clip, then publishes it again twice, each time a
//          new audio section on the same connection; the viewer's stereo separation is read after each
//   reopen     (only with --variant=reopen) a host opens the clip, then opens a second and a third file (copies of
//          it); the viewer must hear the beeps of each (RMS >= 0.1) and decode them in stereo
//
//   loop       (only with --variant=loop) a host opens a short clip (two beeps, 5.5s) with Loop on; the viewer's beeps are
//          counted on every repeat (--repeats=N, default 8) and the viewer must hear both each time, with the
//          host never looking paused and no new publish per repeat (M1.12); then a 20s clip opened at 17s, whose every
//          restart goes through ffmpeg (player.mjs startAt) as a real film's does: both start beeps and new frames each repeat
//
// Nothing is audible: every window is muted and the output gain feeds only a tap that reaches the
// destination through a gain of zero. Real renderer code over local discovery, like check-network.js.
//
//   npm run bench                       both variants, 3 runs each (about 10 minutes)
//   npm run bench -- --variant=film     or share
//   npm run bench -- --runs=1 --quick   a short clip, for working on the bench itself (not a result)
//   npm run bench -- --device-latency-ms=40   see "Device latency" below
//   npm run bench -- --loss 5           drop 5% of the packets each way (see "Loss and capacity"); the mode is recorded in the JSON
//   npm run bench -- --link-kbps 1500   and/or cap each direction at 1500 kbps (a queue of 50 packets)
//   npm run bench -- --audio-ladder=off      keep the host's audio at its fixed cap, for comparison with the ladder
//   npm run bench -- --audio-first=off       "keep audio quality" off (audio at the same network priority as video)
//   npm run bench -- --tree=work/compat/v0.8.1   bench an earlier release instead (node scripts/old-tree.js v0.8.1)
//   npm run bench -- --label=name       put a name in the report's file name
//
// Loss and capacity: the windows' remote ICE candidates are pointed at UDP relays in this process
// (scripts/bench-net.js) that drop, or queue and delay, what they forward. Real WebRTC over real
// sockets; both directions are damaged, so the viewer's receiver reports are lost too, as on a bad link.
// libwebrtc's own fake network (WebRTC-FakeNetworkSendConfig via --force-fieldtrials) was tried first and
// does nothing in Electron 44: see the top of bench-net.js. A run that asked for loss and saw no lost
// audio packet is invalid.
//
// Device latency: the muted page's AudioContext reports outputLatency/baseLatency and
// getOutputTimestamp() maps context frames to the page's clock. If those come back ~0 (a muted or
// sink-less output may report none) the offset would leave out the output path, so `deviceLatencyIncluded`
// is false, the report says so, and the audio time is moved later by --device-latency-ms (default 0).
const {app, BrowserWindow, ipcMain} = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {pathToFileURL} = require('node:url')
const {execFileSync} = require('node:child_process')
const esbuild = require('esbuild')
const lib = require('./bench-lib')
const {benchHooks} = require('./bench-hooks')
const diagnostics = require('../main/log')
const {parseLine} = require('../shared/log')

const root = path.resolve(__dirname, '..')
const flag = (name, fallback) => {
  const at = process.argv.findIndex((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`))
  if (at < 0) return fallback
  const hit = process.argv[at]
  if (hit.includes('=')) return hit.split('=')[1]
  const next = process.argv[at + 1] // "--loss 5" as well as "--loss=5"
  return next != null && !next.startsWith('--') ? next : true
}
const options = {
  variant: String(flag('variant', 'all')),
  runs: Number(flag('runs', 3)),
  quick: Boolean(flag('quick', false)) || Boolean(flag('count', 0)),
  deviceLatencyMs: Number(flag('device-latency-ms', 0)),
  seed: Number(flag('seed', 1)),
  count: Number(flag('count', 0)), // fewer events than the full 28, for working on the bench (not a result)
  shareAudio: String(flag('share-audio', 'app')), // 'none' shares the picture alone: how the video behaves without the audio beside it
  shareUptimeS: Number(flag('share-uptime-s', 15)), // the share starts only after both pages have been up this long, as in real use (a fresh page hides a timestamp-base bug)
  keep: Boolean(flag('keep', false)),
  raw: Boolean(flag('raw', false)), // also write every frame and beep to a .raw.json beside the report
  tree: String(flag('tree', '')), // a tree prepared by scripts/old-tree.js to bench instead of this one
  loss: Number(flag('loss', 0)), // percent of packets the fake network drops
  linkKbps: Number(flag('link-kbps', 0)), // per-direction capacity of the fake network, 0 for none
  audioLadder: String(flag('audio-ladder', 'on')),
  audioFirst: String(flag('audio-first', 'on')),
  label: String(flag('label', '')).replace(/[^A-Za-z0-9._-]/g, ''),
  burstAtS: Number(flag('burst-at', 15)), burstS: Number(flag('burst-s', 4)), burstPct: Number(flag('burst-pct', 10)), recoverS: Number(flag('recover-s', 30)), // --variant=burst
  size: String(flag('size', '1280x720')), // the clip's picture size, e.g. 1920x1080
  fps: Number(flag('fps', 30)), // the clip's (and the share window's) frame rate: 24, 30 or 60
  repeats: Math.max(1, Number(flag('repeats', 8))), // --variant=loop: how many times the short film loops
  publishes: Math.max(1, Number(flag('publishes', 3))), // --variant=republish / reopen: how many times the film is published
}
const {createNetwork} = require('./bench-net')
const treeRoot = options.tree ? path.resolve(options.tree) : root
const degraded = options.loss > 0 || options.linkKbps > 0 // not a sync run: the picture and the offsets are not what is read
assert.ok(options.loss >= 0 && options.loss < 100 && options.linkKbps >= 0, '--loss is a percent, --link-kbps a number')
assert.ok(['on', 'off'].includes(options.audioLadder) && ['on', 'off'].includes(options.audioFirst), '--audio-ladder and --audio-first are on or off')
const variants = options.variant === 'all' ? ['film', 'share'] : [options.variant]
// The relays are in the path for a damaged link, and for a burst of loss on a clean one (their loss starts at 0).
const network = degraded || variants.includes('burst') ? createNetwork({lossPct: options.loss, linkKbps: options.linkKbps}) : null
assert.ok(variants.every((v) => ['film', 'share', 'republish', 'reopen', 'loop', 'burst', 'pause'].includes(v)), '--variant is film, share, republish, reopen, loop, burst, pause or all')

const scratch = require('./temp-dirs').create('synced-bench-', {keep: Boolean(flag('keep', false)) || Boolean(process.env.KEEP_TEMP)})
const temporary = scratch.dir
app.setPath('userData', path.join(temporary, 'profile'))
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
// Windows pages shown off-screen would otherwise count as hidden and stop presenting frames.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')

// Each run closes its windows; the next run opens new ones, so closing the last must not quit the app.
app.on('window-all-closed', () => {})

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const run = (win, source) => win.webContents.executeJavaScript(source).catch((error) => { throw new Error(`${error.message}\nExecuting: ${source.slice(0, 300)}`) })
async function until(win, condition, timeoutMs = 30000, label = condition) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await run(win, condition)) return
    await pause(100)
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`)
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
    contextBridge.exposeInMainWorld('__benchRelay', {open: (host, port) => ipcRenderer.invoke('bench:relay', host, port)});
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
  let source = fs.readFileSync(path.join(treeRoot, 'renderer/app.js'), 'utf8')
  // A share bench has no window to follow: skip the Windows whole-app path (native/win-app-windows) so
  // startShare takes the plain route, which the stubbed getDisplayMedia and the app-audio path plug into.
  const windowsShare = "const APP_WINDOWS = window.api.platform === 'win32'"
  assert.ok(source.includes(windowsShare), 'app.js still declares APP_WINDOWS the way bench.js expects')
  source = source.replace(windowsShare, 'const APP_WINDOWS = false')
  source += `
    window.__test = {
      get session() { return session }, get identity() { return identity },
      friendNetwork, enterRoom, leaveRoom, hostFile, startShare, stopShare, shareSettings, tileViews, control, flushLog, selfId, getState: hostState, errors: [],
      publishStream, audioLadder: typeof audioLadder === 'undefined' ? null : audioLadder, // absent in a release from before M1.6
      player, // the long-film loop (runLongLoop) restarts ffmpeg mid-repeat the way a seek outside the buffer does
    };
    window.addEventListener('error', (e) => __test.errors.push(e.message));
    window.addEventListener('unhandledrejection', (e) => __test.errors.push(String(e.reason)));
    (${benchHooks.toString()})();
  `
  await esbuild.build({stdin: {contents: source, resolveDir: path.join(treeRoot, 'renderer')}, bundle: true, format: 'iife', target: 'chrome130', outfile: path.join(temporary, 'bundle.js'), plugins: [{
    name: 'local-discovery', setup(build) {
      build.onResolve({filter: /^trystero$/}, () => ({path: 'trystero', namespace: 'local'}))
      build.onLoad({filter: /.*/, namespace: 'local'}, () => ({resolveDir: treeRoot, contents: `
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
  const html = fs.readFileSync(path.join(treeRoot, 'renderer/index.html'), 'utf8')
    .replace('href="styles.css"', `href="${pathToFileURL(path.join(treeRoot, 'renderer/styles.css'))}"`)
  fs.writeFileSync(path.join(temporary, 'index.html'), html)
  fs.copyFileSync(path.join(__dirname, 'bench-tap.js'), path.join(temporary, 'bench-tap.js'))

  const schedule = lib.makeSchedule({seed: options.seed, fps: options.fps, size: options.size, ...(options.quick ? {count: 6, first: 3, minGap: 2, maxGap: 2.6} : {}), ...(options.count ? {count: options.count} : {})})
  const ffmpeg = require('ffmpeg-static')
  const clip = path.join(temporary, 'bench-clip.mkv')
  const pcm = path.join(temporary, 'bench-clip.f32')
  execFileSync(ffmpeg, lib.clipArgs(schedule, clip), {windowsHide: true, timeout: 120000})
  execFileSync(ffmpeg, lib.pcmArgs(clip, pcm), {windowsHide: true, timeout: 60000})
  return {clip, pcm, schedule}
}

async function openWindow(name, partition) {
  const win = new BrowserWindow({show: false, width: 1280, height: 720, webPreferences: {partition, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required', preload: path.join(temporary, 'preload.js')}})
  win.webContents.setAudioMuted(true) // belt and braces: the page also routes its output into a zero gain
  assert.equal(win.webContents.isAudioMuted(), true)
  win.webContents.on('console-message', (details) => { if (details.level === 'error') console.error(`${name}: ${details.message}`) })
  // A local file now and then fails to load with ERR_FAILED right after another window closed: try again.
  for (let attempt = 1; ; attempt++) {
    try {
      await win.loadFile(path.join(temporary, 'index.html'))
      break
    } catch (error) {
      if (attempt >= 4) throw error
      console.error(`${name}: loading the page failed (${error.code || error.message}), trying again`)
      await pause(1000)
    }
  }
  await until(win, 'window.__test && !document.getElementById("welcome").hidden', 30000, `${name} welcome screen`)
  if (network) await run(win, '__bench.installNetwork()') // before any connection exists: candidates are rewritten as they arrive
  await run(win, `document.getElementById('handle').value=${JSON.stringify(name)}; document.getElementById('welcome-name').value=${JSON.stringify(name)}; document.getElementById('welcome-form').dispatchEvent(new Event('submit', {cancelable:true}));`)
  await until(win, '__test.friendNetwork.identity && !document.getElementById("home").hidden', 30000, `${name} home`)
  // Shown, far off-screen: a window that was never shown does not present frames, and the rVFC rate
  // is one of the things this bench asserts.
  win.setBounds({x: -20000, y: -20000, width: 1280, height: 720})
  win.showInactive()
  return win
}

// The sending window's audio switches for this run (no-ops on a release from before they existed).
async function applySendOptions(win) {
  if (options.audioLadder === 'off') await run(win, '(() => { if (__test.audioLadder) __test.audioLadder.enabled = false; return true })()')
  if (options.audioFirst === 'off') await run(win, '__test.shareSettings.audioFirst = false; true')
}

async function connectedPair(tag, hostName, viewerName) {
  const opened = []
  try {
    const host = await openWindow(hostName, `bench-${tag}-${hostName}`)
    opened.push(host)
    const viewer = await openWindow(viewerName, `bench-${tag}-${viewerName}`)
    opened.push(viewer)
    const code = `B${tag}`.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8).padEnd(8, 'X')
    await run(host, `__test.enterRoom(${JSON.stringify(code)}, {joining:false})`)
    await run(viewer, `__test.enterRoom(${JSON.stringify(code)})`)
    await until(host, '__test.session.peers.size === 1', 30000, 'host sees the viewer')
    await until(viewer, '__test.session.peers.size === 1', 30000, 'viewer sees the host')
    return {host, viewer}
  } catch (error) {
    for (const win of opened) if (!win.isDestroyed()) win.destroy()
    throw error
  }
}

// ---------- reading a run ----------

const bitrateKbps = (a, b) => (a && b && b.timestamp > a.timestamp ? Number((((b.bytesReceived ?? b.bytesSent) - (a.bytesReceived ?? a.bytesSent)) * 8) / (b.timestamp - a.timestamp)) : null)
const rtpSnapshot = async (win) => JSON.parse(await run(win, '__bench.rtp().then(JSON.stringify)'))

function readSide(collected, schedule, {deviceMs, epoch = null}) {
  const frames = collected.frames.map(([time, media, presented, luma, now]) => ({time, media, presented, luma, now}))
  const flashes = lib.risingEdges(frames)
  const clock = lib.clockMap(collected.clock)
  const sr = collected.sampleRate
  const lag = lib.median(collected.clock.filter((c) => c.perf > 0).map((c) => (c.cur - c.ctx) * 1000))
  const outputMs = collected.outputLatency * 1000
  const baseMs = collected.baseLatency * 1000
  const included = lag >= 5 && outputMs >= 5
  const correctionMs = included ? 0 : deviceMs
  // The context's clock against the page's is not constant: it steps by a callback or three (10ms, 30ms in
  // the readings) when the audio service is late, and drifts. So each beep is mapped with the readings
  // taken within 300ms of when it was rendered, not with one line for the whole run.
  const usable = collected.clock.filter((c) => c.perf > 0)
  const mapAt = (at) => {
    const near = usable.filter((c) => Math.abs(c.now - at) <= 300).map((c) => c.perf - c.ctx * 1000)
    return near.length >= 3 ? lib.median(near) : clock.offsetMs
  }
  const beeps = collected.beeps.map((b) => mapAt(b.at) + (b.frame / sr) * 1000 + correctionMs)
  // Each end is lined up with the schedule on its own, and a flash is paired with the beep of the same
  // scheduled event (nearest-in-time would pair wrongly once the two are more than half a gap apart).
  const times = schedule.events.map((e) => e.t)
  const flashAlign = lib.alignToSchedule(flashes, times)
  const beepAlign = lib.alignToSchedule(beeps, times)
  const beepOf = new Map(beepAlign.matches.map((m) => [m.index, m.time]))
  const pairs = flashAlign.matches.filter((m) => beepOf.has(m.index)).map((m) => ({index: m.index, flash: m.time, beep: beepOf.get(m.index), offset: beepOf.get(m.index) - m.time}))
  const steady = pairs.filter((p) => schedule.events[p.index].t >= lib.STEADY)
  const expectedSteady = schedule.events.filter((e) => e.t >= lib.STEADY).length
  // Frame cadence and the rVFC rate are read over steady state too (the first seconds fill buffers), when the run is long enough.
  const first = frames[0]?.now ?? 0
  const long = frames.length && frames.at(-1).now - first > (lib.STEADY + 10) * 1000
  const window = long ? frames.filter((f) => f.now - first >= lib.STEADY * 1000) : frames
  const distinct = window.filter((f, i) => i === 0 || f.presented !== window[i - 1].presented)
  const spanS = window.length > 1 ? (window.at(-1).now - window[0].now) / 1000 : 0
  const skipped = window.length > 1 ? Math.max(0, (window.at(-1).presented - window[0].presented) - (window.length - 1)) : null
  return {
    raw: options.raw ? collected : undefined,
    flashesSeen: flashes.length, beepsSeen: beeps.length, matched: pairs.length, expectedSteady, matchedSteady: steady.length,
    offset: {steady: lib.summarizeOffsets(steady.map((p) => p.offset)), all: lib.summarizeOffsets(pairs.map((p) => p.offset)), driftMsPerS: lib.round(lib.slope(steady.map((p) => [schedule.events[p.index].t, p.offset])), 3)},
    offsets: pairs.map((p) => ({event: p.index, t: schedule.events[p.index].t, ms: Number(p.offset.toFixed(2))})),
    // Share only: both ends share a wall-clock schedule, so each can also be read against it on its own.
    absolute: epoch == null ? undefined : {
      videoMs: flashAlign.matches.map((m) => Number((collected.timeOrigin + m.time - (epoch + schedule.events[m.index].t * 1000)).toFixed(1))),
      audioMs: beepAlign.matches.map((m) => Number((collected.timeOrigin + m.time - (epoch + schedule.events[m.index].t * 1000)).toFixed(1))),
      videoSteadyMedianMs: lib.round(lib.median(flashAlign.matches.filter((m) => schedule.events[m.index].t >= lib.STEADY).map((m) => collected.timeOrigin + m.time - (epoch + schedule.events[m.index].t * 1000))), 1),
      audioSteadyMedianMs: lib.round(lib.median(beepAlign.matches.filter((m) => schedule.events[m.index].t >= lib.STEADY).map((m) => collected.timeOrigin + m.time - (epoch + schedule.events[m.index].t * 1000))), 1),
    },
    levelRms: lib.median(collected.levels.map((l) => l.rms)),
    clock: {
      sampleRate: sr, outputLatencyMs: lib.round(outputMs, 2), baseLatencyMs: lib.round(baseMs, 2), outputTimestampLagMs: lib.round(lag, 2),
      mapSpreadMs: clock.spreadMs, mapSamples: clock.n, deviceLatencyIncluded: included, correctionMs,
    },
    stereo: {channelsSeenByTap: collected.channelsIn, separation: lib.round(collected.stereo.side / Math.max(1e-12, collected.stereo.side + collected.stereo.mid), 3)},
    video: {
      callbacks: window.length, presentedPerSecond: window.length > 1 ? lib.round((window.at(-1).presented - window[0].presented) / Math.max(1, spanS), 2) : null, rvfcPerSecond: lib.round((window.length - 1) / Math.max(1, spanS), 2), spanS: lib.round(spanS, 1), presentedFramesNotCalledBack: skipped, steadyOnly: Boolean(long),
      width: collected.width, height: collected.height,
      cadence: lib.cadence(distinct.map((f) => f.time), 1000 / schedule.fps),
    },
  }
}

function telemetryOf(selfId) {
  diagnostics.flush()
  const lines = fs.readFileSync(diagnostics.filePath(), 'utf8').trim().split('\n').map(parseLine).filter(Boolean)
  const samples = lines.filter((e) => e.ev === 'viewer-sample' && e.self === selfId && e.s)
  const steady = samples.slice(5) // the first ten seconds are ramp-up
  const col = (key) => steady.map((e) => e.s[key]).filter(Number.isFinite)
  return {samples: samples.length, avSkewMedianMs: lib.round(lib.median(col('av')), 1), avSkewP95AbsMs: lib.round(lib.percentile(col('av').map(Math.abs), 0.95), 1), estimatedOffsetMedianMs: lib.round(lib.median(col('off')), 1), estimatedOffsetP95AbsMs: lib.round(lib.percentile(col('off').map(Math.abs), 0.95), 1), audioJitterBufferMs: lib.round(lib.median(col('aJb')), 1), videoJitterBufferMs: lib.round(lib.median(col('vJb')), 1), reportedOutMs: lib.round(lib.median(col('out')), 1), reportedBaseMs: lib.round(lib.median(col('base')), 1)}
}

// What the sending side logged: the audio steps it took (seconds after the first receiver report), what
// it sent, and how many times setParameters actually ran.
function hostTelemetryOf(selfId) {
  diagnostics.flush()
  const lines = fs.readFileSync(diagnostics.filePath(), 'utf8').trim().split('\n').map(parseLine).filter(Boolean)
  const mine = lines.filter((e) => e.self === selfId)
  const samples = mine.filter((e) => e.ev === 'host-sample')
  const reported = samples.filter((e) => e.receiver)
  const origin = reported[0]?.m ?? null
  const steps = mine.filter((e) => e.ev === 'audio-step-change').map((e) => ({atS: origin == null ? null : lib.round((e.m - origin) / 1000, 1), from: e.from, to: e.to, reason: e.reason, limit: e.limit, estimateKbps: Number.isFinite(e.estimateBps) ? Math.round(e.estimateBps / 1000) : null, capKbps: Number.isFinite(e.capBps) ? e.capBps / 1000 : null}))
  const col = (key) => samples.map((e) => e[key]).filter(Number.isFinite)
  const applied = mine.filter((e) => e.ev === 'send-parameters-applied')
  const links = mine.filter((e) => e.ev === 'link' && e.venc)
  return {
    venc: links.at(-1)?.venc ?? null, linkEvents: links.length,
    // ms of encoder time per frame (software H.264 at 720p+ is several ms; a hardware encoder about one) and what the encoder was limited by
    encMsMedian: lib.round(lib.median(samples.map((e) => e.e?.enc ?? e.sender?.enc).filter(Number.isFinite)), 2),
    samples: samples.length, audioSteps: steps, firstStepS: steps[0]?.atS ?? null, finalStep: samples.at(-1)?.audioStep ?? null,
    audioSentKbpsMedian: lib.round(lib.median(col('audioSentBitrateBps')) / 1000, 1),
    audioSentKbpsSeries: samples.filter((e) => Number.isFinite(e.audioSentBitrateBps)).filter((_, i) => i % 3 === 0).map((e) => [origin == null ? null : lib.round((e.m - origin) / 1000, 0), lib.round(e.audioSentBitrateBps / 1000, 0), e.audioStep ?? null]),
    lossReportedMedianPct: lib.round(lib.median(reported.map((e) => e.receiver.lossPct).filter(Number.isFinite)), 2),
    setParameters: {audio: applied.filter((e) => e.kind === 'audio').length, video: applied.filter((e) => e.kind === 'video').length, failed: mine.filter((e) => e.ev === 'send-parameters-failed').length},
  }
}

function transportOf(from, to, sender, schedule) {
  const a0 = from.viewer.audioIn
  const a1 = to.viewer.audioIn
  const v0 = from.viewer.videoIn
  const v1 = to.viewer.videoIn
  const seconds = a1 && a0 ? (a1.timestamp - a0.timestamp) / 1000 : null
  const audioSender = to.sender.senders.find((s) => s.kind === 'audio')
  const codec = a1?.codec
  const opus = /stereo=(\d)/.exec(codec?.sdpFmtpLine || '')
  return {
    windowS: lib.round(seconds, 1),
    audio: {
      codecChannels: codec?.channels ?? null, sdpStereo: opus ? Number(opus[1]) : null, fmtp: codec?.sdpFmtpLine ?? null, sentFmtp: to.sender.audioOut?.codec?.sdpFmtpLine ?? null,
      receivedKbps: lib.round(bitrateKbps(a0, a1), 1), sentKbps: lib.round(bitrateKbps(from.sender.audioOut, to.sender.audioOut), 1), configuredMaxKbps: audioSender?.maxBitrate ? audioSender.maxBitrate / 1000 : null,
      packetsLost: a1 && a0 ? a1.packetsLost - a0.packetsLost : null, jitterMs: lib.round((a1?.jitter ?? 0) * 1000, 2),
      concealment: lib.concealment(
        a0 && {concealed: a0.concealedSamples, silent: a0.silentConcealedSamples, samples: a0.totalSamplesReceived},
        a1 && {concealed: a1.concealedSamples, silent: a1.silentConcealedSamples, samples: a1.totalSamplesReceived}),
      stretchedMs: a1 && a0 ? lib.round(((a1.insertedSamplesForDeceleration - a0.insertedSamplesForDeceleration) + (a1.removedSamplesForAcceleration - a0.removedSamplesForAcceleration)) / 48, 1) : null,
    },
    video: {
      receivedKbps: lib.round(bitrateKbps(v0, v1), 0), inboundFps: lib.round(v1?.framesPerSecond, 1), width: v1?.frameWidth ?? null, height: v1?.frameHeight ?? null,
      framesDropped: v1 && v0 ? v1.framesDropped - v0.framesDropped : null, freezes: v1 && v0 ? v1.freezeCount - v0.freezeCount : null,
      decoder: v1?.decoderImplementation ?? null, packetsLost: v1 && v0 ? v1.packetsLost - v0.packetsLost : null,
      framesDecodedPerSecond: v1 && v0 ? lib.round((v1.framesDecoded - v0.framesDecoded) / ((v1.timestamp - v0.timestamp) / 1000), 2) : null,
    },
    sender: {videoKbps: lib.round(bitrateKbps(from.sender.videoOut, to.sender.videoOut), 0), limit: to.sender.videoOut?.qualityLimitationReason ?? null},
  }
}

// What makes a reading untrustworthy rather than merely bad. A run that trips one of these is flagged
// invalid in the JSON and fails the bench: a number from a broken harness must not look like a result.
function validity({viewer, transport, schedule, variant, quick, extra}) {
  const problems = []
  const fps = schedule.fps
  // Presented frames (rVFC's own counter), not callbacks: at 60fps a callback is skipped when two frames land in one rendering
  // frame, which says nothing about whether the picture is trustworthy; a shortfall of presented frames is real.
  const rate = viewer.video.presentedPerSecond ?? viewer.video.rvfcPerSecond
  // A run on a damaged link is read for its audio, not for sync: its picture and its pairs are allowed to suffer.
  if (!degraded && !(rate >= 0.9 * fps)) problems.push(`the viewer presents ${rate} frames/s, under 0.9x the clip's ${fps}fps: frames are missing (or the picture times are not trustworthy)`)
  if (!degraded && !quick && viewer.matchedSteady < 20) problems.push(`only ${viewer.matchedSteady} of ${viewer.expectedSteady} steady-state events were paired (need 20)`)
  if (!degraded && !extra?.noAudio && !(viewer.levelRms >= 0.1)) problems.push(`the received beep's RMS ${viewer.levelRms} is under 0.1: the audio arrived silent or not at all`)
  if (!degraded && !extra?.noAudio && viewer.matched < 3) problems.push('fewer than 3 flash/beep pairs: no offset can be reported')
  if (options.loss > 0 && !(transport.audio.packetsLost > 0)) problems.push(`--loss ${options.loss} was asked for but no audio packet was lost: the relays are not in the path`)
  // Random loss is not congestion: the audio keeps at least the 128 kbps floor (and, with "keep audio quality" on, its full cap).
  if (options.loss > 0 && !options.linkKbps && !options.tree && extra?.hostRead) {
    const sentKbps = extra.hostRead.audioSentKbpsMedian
    if (!(sentKbps >= 120)) problems.push(`at ${options.loss}% random loss the sent audio is ${sentKbps} kbps, under the 128 kbps floor`)
    if (options.audioFirst === 'on' && extra.hostRead.audioSteps.length) problems.push('the audio ladder stepped on random loss with "keep audio quality" on')
  }
  // A real bottleneck below 1.5 Mbps with "keep audio quality" off: the ladder takes its step.
  if (options.linkKbps > 0 && options.linkKbps < 1500 && options.audioFirst === 'off' && options.audioLadder === 'on' && !options.tree && !options.quick && extra?.hostRead && !(extra.hostRead.firstStepS != null)) {
    problems.push(`on a ${options.linkKbps} kbps link with "keep audio quality" off the audio never stepped down`)
  }
  // (A release from before M1.6 logs one failed setParameters per run; that is data about it, not a broken harness.)
  if (extra?.hostRead && !options.tree && extra.hostRead.setParameters.failed > 0) problems.push(`${extra.hostRead.setParameters.failed} setParameters call(s) failed`)
  // The audio sender is set once when it starts and once per step the ladder takes, not once per pass.
  if (extra?.hostRead && !options.tree && extra.hostRead.setParameters.audio > 1 + extra.hostRead.audioSteps.length) problems.push(`audio setParameters ran ${extra.hostRead.setParameters.audio} times for ${extra.hostRead.audioSteps.length} step(s): it should run once per change`)
  if (extra?.helper && extra.helper.p95LateMs > 5) problems.push(`the fake helper delivered audio ${extra.helper.p95LateMs}ms late at p95: the share's ground truth is off`)
  if (extra?.window && extra.window.p95LateMs > 5) problems.push(`the shared window painted ${extra.window.p95LateMs}ms late at p95: the share's ground truth is off`)
  return problems
}

// ---------- the two variants ----------

// What can be confirmed about hardware H.264 encoding. Chromium names the encoder (encoderImplementation) and sets
// powerEfficientEncoder only for a page with capture permission, so neither shows here or in the logs; instead: the GPU
// process's own verdict (app.getGPUFeatureStatus().video_encode), MediaCapabilities' answer for a WebRTC H.264 encode at the
// clip's size (powerEfficient is true for a hardware encoder), and the measured encode time per frame.
async function hardwareEncode(win) {
  const gpu = app.getGPUFeatureStatus?.() || {}
  const caps = await run(win, `navigator.mediaCapabilities.encodingInfo({type: 'webrtc', video: {contentType: 'video/H264;profile-level-id=42e01f;packetization-mode=1', width: ${Number(options.size.split('x')[0])}, height: ${Number(options.size.split('x')[1])}, bitrate: 4000000, framerate: ${options.fps}}}).then((r) => JSON.stringify({supported: r.supported, smooth: r.smooth, powerEfficient: r.powerEfficient})).catch((e) => JSON.stringify({error: String(e.message || e)}))`).then(JSON.parse)
  return {gpuVideoEncode: gpu.video_encode ?? null, gpuVideoDecode: gpu.video_decode ?? null, mediaCapabilities: caps}
}

async function runFilm(env, runIndex) {
  const {host, viewer} = await connectedPair(`film${runIndex}`, 'filmhost', 'filmviewer')
  try {
    const sink = {sampleRate: null}
    await applySendOptions(host)
    await Promise.all([run(host, '__bench.installTap()'), run(viewer, '__bench.installTap()')])
    await run(viewer, `__bench.watchVideo(() => document.getElementById('remote-video'))`)
    await run(host, `__bench.watchVideo(() => document.getElementById('local-video'))`)
    await run(host, `__test.hostFile(${JSON.stringify(env.clip)})`)
    await until(viewer, 'document.getElementById("remote-video").getVideoPlaybackQuality().totalVideoFrames > 24', 45000, 'viewer receives video')
    const startedAt = Date.now()
    const duration = env.schedule.duration
    // Steady-state counters start ten seconds after the picture does.
    await pause(lib.STEADY * 1000)
    const from = {viewer: await rtpSnapshot(viewer), sender: await rtpSnapshot(host)}
    await until(host, `document.getElementById('local-video').currentTime > ${duration - 1.5} || document.getElementById('local-video').ended`, (duration + 40) * 1000, 'the clip reaches its end')
    const to = {viewer: await rtpSnapshot(viewer), sender: await rtpSnapshot(host)}
    await pause(1500) // the last beep and its loudness window
    const [viewerData, hostData] = await Promise.all([run(viewer, '__bench.collect().then(JSON.stringify)'), run(host, '__bench.collect().then(JSON.stringify)')]).then((r) => r.map(JSON.parse))
    const selfId = await run(viewer, '__test.selfId')
    const hostSelfId = await run(host, '__test.selfId')
    await Promise.all([host, viewer].map((win) => run(win, '__test.flushLog()')))
    const viewerRead = readSide(viewerData, env.schedule, {deviceMs: options.deviceLatencyMs})
    const hostRead = readSide(hostData, env.schedule, {deviceMs: options.deviceLatencyMs})
    const transport = transportOf(from, to, host, env.schedule)
    const errors = [...await run(host, '__test.errors'), ...await run(viewer, '__test.errors')]
    const sent = hostTelemetryOf(hostSelfId)
    sent.hardware = await hardwareEncode(host)
    return {variant: 'film', viewer: viewerRead, host: {offset: hostRead.offset, matchedSteady: hostRead.matchedSteady, video: hostRead.video, levelRms: hostRead.levelRms, clock: hostRead.clock, stereo: hostRead.stereo, raw: hostRead.raw}, transport, telemetry: telemetryOf(selfId), sent, elapsedS: lib.round((Date.now() - startedAt) / 1000, 1), pageErrors: errors, problems: validity({viewer: viewerRead, transport, schedule: env.schedule, variant: 'film', quick: options.quick, extra: {hostRead: sent}})}
  } finally {
    host.destroy()
    viewer.destroy()
    require('../main/media').stopAll()
  }
}

// A film paused for PAUSE_S and played again, read only after the resume (2026-11-10, Lenna: "off by about a
// second" after every pause, until a seek). A bare captureStream() audio clone sends nothing while the element is
// paused, so its RTP clock fell behind the picture's (stamped with the wall clock) by the pause, and the viewer's
// lip-sync then held the sound back by up to that much, building over ~30s (her audio jitter buffer 250ms -> 2.2s).
// The offsets are split into the first 15s after the resume and the rest, and the late half is what is gated.
const PAUSE_AT_S = 11
const PAUSE_S = 6
const PAUSE_LATE_LIMIT_MS = 120
async function runPause(env, runIndex) {
  const {host, viewer} = await connectedPair(`pause${runIndex}`, 'pausehost', 'pauseviewer')
  try {
    await applySendOptions(host)
    await Promise.all([run(host, '__bench.installTap()'), run(viewer, '__bench.installTap()')])
    await run(viewer, `__bench.watchVideo(() => document.getElementById('remote-video'))`)
    await run(host, `__test.hostFile(${JSON.stringify(env.clip)})`)
    await until(viewer, 'document.getElementById("remote-video").getVideoPlaybackQuality().totalVideoFrames > 24', 45000, 'viewer receives video')
    const local = "document.getElementById('local-video')"
    await until(host, `${local}.currentTime > ${PAUSE_AT_S}`, 60000, `the clip reaches ${PAUSE_AT_S}s`)
    await run(host, "__test.control('pause'); true")
    await pause(PAUSE_S * 1000)
    const pausedAt = await run(host, `${local}.currentTime`)
    await run(host, "__test.control('play'); true")
    const resumedAt = await run(viewer, 'performance.now()') // the viewer page's clock, which the frames and beeps carry
    const duration = env.schedule.duration
    await until(host, `${local}.currentTime > ${duration - 1.5} || ${local}.ended`, (duration + 40) * 1000, 'the clip reaches its end')
    await pause(1500)
    const data = JSON.parse(await run(viewer, '__bench.collect().then(JSON.stringify)'))
    const after = {...data, frames: data.frames.filter((f) => f[4] > resumedAt + 300), beeps: data.beeps.filter((b) => b.at > resumedAt + 300)}
    const viewerRead = readSide(after, env.schedule, {deviceMs: options.deviceLatencyMs})
    const resumeT = pausedAt
    const early = viewerRead.offsets.filter((o) => o.t < resumeT + 15).map((o) => o.ms)
    const late = viewerRead.offsets.filter((o) => o.t >= resumeT + 15).map((o) => o.ms)
    const selfId = await run(viewer, '__test.selfId')
    await run(viewer, '__test.flushLog()')
    diagnostics.flush()
    const samples = fs.readFileSync(diagnostics.filePath(), 'utf8').trim().split('\n').map(parseLine).filter(Boolean).filter((e) => e.ev === 'viewer-sample' && e.self === selfId && e.s)
    const aJb = samples.map((e) => e.s.aJb).filter(Number.isFinite)
    const off = samples.map((e) => e.s.off).filter(Number.isFinite)
    const errors = [...await run(host, '__test.errors'), ...await run(viewer, '__test.errors')]
    const result = {
      variant: 'pause', pauseAtS: lib.round(pausedAt, 2), pauseS: PAUSE_S,
      early: lib.summarizeOffsets(early), late: lib.summarizeOffsets(late), driftMsPerS: viewerRead.offset.driftMsPerS, offsets: viewerRead.offsets,
      audioJitterBufferMaxMs: aJb.length ? Math.max(...aJb) : null, estimatedOffsetMaxMs: off.length ? Math.max(...off) : null,
      levelRms: viewerRead.levelRms, matched: viewerRead.matched, pageErrors: errors,
    }
    result.problems = [
      ...(late.length < 8 ? [`only ${late.length} events paired from 15s after the resume (need 8)`] : []),
      ...(!(viewerRead.levelRms >= 0.1) ? [`the received beep's RMS ${viewerRead.levelRms} is under 0.1: the audio arrived silent or not at all`] : []),
      ...(late.length && Math.abs(result.late.medianMs) > PAUSE_LATE_LIMIT_MS ? [`from 15s after a ${PAUSE_S}s pause the sound is ${result.late.medianMs}ms off the picture (limit ${PAUSE_LATE_LIMIT_MS}): the pause moved the audio's timeline`] : []),
    ]
    return result
  } finally {
    host.destroy()
    viewer.destroy()
    require('../main/media').stopAll()
  }
}

// A film published again and again on one connection: every publish is a new capture and so a new audio
// section in the offer (the way a returning peer's newer claim republishes it), and the first section
// in the SDP is the stale one. The viewer's L/R separation is read after each.
//
// mode 'reopen' opens another file each time instead (hostFile): before M1.11 that sent the viewer no audio
// at all (the host's own Web Audio tap heard it, its captureStream audio track had no signal), on v0.8.0
// and v0.8.1 alike. Both modes read the beeps too, not only the bed tone.
async function runRepublish(env, runIndex, mode = 'republish') {
  const {host, viewer} = await connectedPair(`${mode.slice(0, 5)}${runIndex}`, 'rephost', 'repviewer')
  try {
    await applySendOptions(host)
    await Promise.all([run(host, '__bench.installTap()'), run(viewer, '__bench.installTap()')])
    const audioSections = '(() => { const pc = Object.values(__test.session.room.getPeers())[0]; return (pc.remoteDescription.sdp.match(/^m=audio /gm) || []).length })()'
    const stages = []
    for (let publish = 1; publish <= options.publishes; publish++) {
      await run(viewer, 'window.__lastSrc = document.getElementById("remote-video").srcObject; true') // the element's frame counter restarts with each new stream
      let file = env.clip
      if (mode === 'reopen' && publish > 1) {
        file = env.clip.replace(/\.mkv$/, `-${publish}.mkv`)
        fs.copyFileSync(env.clip, file) // another file, not the same one again
      }
      await run(host, publish === 1 || mode === 'reopen' ? `__test.hostFile(${JSON.stringify(file)})` : '__test.publishStream(); true')
      await until(viewer, 'document.getElementById("remote-video").srcObject && document.getElementById("remote-video").srcObject !== window.__lastSrc && document.getElementById("remote-video").getVideoPlaybackQuality().totalVideoFrames > 60', 45000, `the viewer receives publish ${publish}`)
      await pause(3000)
      const beepsBefore = JSON.parse(await run(viewer, '__bench.collect().then(JSON.stringify)')).levels.length // the stereo reading restarts here
      await pause(6500)
      const data = JSON.parse(await run(viewer, '__bench.collect().then(JSON.stringify)'))
      const beeps = data.levels.slice(beepsBefore).map((l) => l.rms)
      const rtp = await rtpSnapshot(viewer)
      const shape = JSON.parse(await run(host, '(() => JSON.stringify(Object.values(__test.session.room.getPeers()).map((pc) => ({transceivers: pc.getTransceivers().length, sections: (pc.localDescription.sdp.match(/^m=/gm) || []).length, offerBytes: JSON.stringify({type: pc.localDescription.type, sdp: pc.localDescription.sdp}).length}))))()'))
      stages.push({publish, shape: shape[0], beeps: beeps.length, beepRms: lib.round(lib.median(beeps), 3), separation: lib.round(data.stereo.side / Math.max(1e-12, data.stereo.side + data.stereo.mid), 3), energy: data.stereo, audioSections: await run(viewer, audioSections), receiveFmtp: rtp.audioIn?.codec?.sdpFmtpLine ?? null})
    }
    const errors = [...await run(host, '__test.errors'), ...await run(viewer, '__test.errors')]
    const problems = [
      ...stages.filter((s) => !(s.separation >= 0.4)).map((s) => `after publish ${s.publish} the viewer's L/R separation is ${s.separation}, under 0.4: the audio decodes as mono (or is silent: energy ${s.energy.mid})`),
      ...stages.filter((s) => s.shape && s.shape.sections > 6).map((s) => `after publish ${s.publish} the connection has ${s.shape.sections} m-sections (${s.shape.offerBytes} bytes of offer): they pile up`),
      ...stages.filter((s) => !(s.beepRms >= 0.1)).map((s) => `after publish ${s.publish} the viewer heard ${s.beeps} beep(s), median RMS ${s.beepRms}, under 0.1: no sound arrived`),
    ]
    return {variant: mode, stages, pageErrors: errors, problems}
  } finally {
    host.destroy()
    viewer.destroy()
    require('../main/media').stopAll()
  }
}

async function runShare(env, runIndex) {
  const {host: sharer, viewer} = await connectedPair(`share${runIndex}`, 'sharer', 'shareviewer')
  const noAudio = options.shareAudio === 'none'
  const epochFile = path.join(temporary, `epoch-${runIndex}.txt`)
  const statsFile = path.join(temporary, `helper-stats-${runIndex}.json`)
  // The seam in main/app-audio.js: unpackaged builds spawn this instead of the OS capture helper.
  process.env.SVP_APP_AUDIO_FAKE = path.join(__dirname, 'bench-fake-app-audio.js')
  process.env.BENCH_PCM = env.pcm
  process.env.BENCH_EPOCH_FILE = epochFile
  process.env.BENCH_STATS_FILE = statsFile
  try {
    const sharerId = await run(sharer, '__test.selfId')
    // A share is started well into an app's life, not in its first seconds: WebRTC's lip-sync compares the
    // audio track's timestamps with the video's performance.now() stamps, so a bench that shares at 5s of
    // uptime hides what a 15-minute-old app does. Both pages must be this old before the share starts.
    for (const win of [sharer, viewer]) await until(win, `performance.now() >= ${options.shareUptimeS * 1000}`, options.shareUptimeS * 1000 + 30000, `the page is ${options.shareUptimeS}s old`)
    await applySendOptions(sharer)
    await Promise.all([run(viewer, '__bench.installTap()')])
    await run(sharer, `__bench.installWindow(${JSON.stringify({fps: env.schedule.fps, flashFrames: lib.FLASH_FRAMES, events: env.schedule.events})})`)
    await run(sharer, `__test.shareSettings.audioDeviceId = ${JSON.stringify(options.shareAudio)}; true`)
    await run(sharer, `__test.startShare({id: 'window:4242:0', name: 'Bench window'}); true`)
    await until(sharer, noAudio ? '__test.session.screen' : '__test.session.screen && __test.session.screen.audio === true', 20000, 'the share starts with audio (the stand-in helper answered)')
    await until(viewer, `__test.tileViews.has(${JSON.stringify(sharerId)}) && (${noAudio} || __test.tileViews.get(${JSON.stringify(sharerId)}).source) && __test.tileViews.get(${JSON.stringify(sharerId)}).video.readyState >= 3`, 30000, 'the viewer shows the share with its sound')
    await run(viewer, `__bench.watchVideo(() => __bench.tileVideo(${JSON.stringify(sharerId)}))`)
    if (!noAudio) await until(viewer, `__bench.rtp().then((r) => r.audioIn?.packetsReceived > 50)`, 20000, 'audio packets reach the viewer')
    const epoch = Date.now() + 3000
    fs.writeFileSync(epochFile, String(epoch))
    await run(sharer, `__bench.startWindow(${epoch})`)
    await pause(Math.max(0, epoch - Date.now()) + lib.STEADY * 1000)
    const from = {viewer: await rtpSnapshot(viewer), sender: await rtpSnapshot(sharer)}
    const endAt = epoch + (env.schedule.duration - 1.5) * 1000
    await pause(Math.max(0, endAt - Date.now()))
    const to = {viewer: await rtpSnapshot(viewer), sender: await rtpSnapshot(sharer)}
    await pause(2500)
    const viewerData = JSON.parse(await run(viewer, '__bench.collect().then(JSON.stringify)'))
    const selfId = await run(viewer, '__test.selfId')
    await Promise.all([sharer, viewer].map((win) => run(win, '__test.flushLog()')))
    const sent = hostTelemetryOf(sharerId)
    const windowReport = await run(sharer, '__bench.windowReport()')
    await run(sharer, '__bench.stopWindow()')
    const helper = (() => { try { return JSON.parse(fs.readFileSync(statsFile, 'utf8')) } catch { return null } })()
    const viewerRead = readSide(viewerData, env.schedule, {deviceMs: options.deviceLatencyMs, epoch})
    const transport = transportOf(from, to, sharer, env.schedule)
    const errors = [...await run(sharer, '__test.errors'), ...await run(viewer, '__test.errors')]
    return {
      variant: 'share', viewer: viewerRead, transport, telemetry: telemetryOf(selfId), sent, pageErrors: errors,
      groundTruth: {helperDelivery: helper, windowPaint: windowReport, clockNote: 'flash painted and PCM delivered at the same schedule instants on the wall clock; window capture latency and the shared app\'s own output buffer are not in this number'},
      problems: validity({viewer: viewerRead, transport, schedule: env.schedule, variant: 'share', quick: options.quick, extra: {helper, window: windowReport, noAudio, hostRead: sent}}),
    }
  } finally {
    require('../main/app-audio').stopAll()
    sharer.destroy()
    viewer.destroy()
    delete process.env.SVP_APP_AUDIO_FAKE
  }
}

// ---------- report ----------

const spread = (values) => (values.length ? lib.round(Math.max(...values) - Math.min(...values), 1) : null)

// M1.12: a short film on Loop. Every repeat, the viewer must hear both beeps (RMS >= 0.1), the host must never
// look paused (to itself or, through state, to the viewer), and a repeat must not republish the stream: the
// capture's audio track is the same live one throughout.
async function runLoop(env, runIndex) {
  const {host, viewer} = await connectedPair(`loop${runIndex}`, 'loophost', 'loopviewer')
  try {
    await applySendOptions(host)
    await Promise.all([run(host, '__bench.installTap()'), run(viewer, '__bench.installTap()')])
    const schedule = lib.makeSchedule({seed: options.seed, count: 2, first: 1, minGap: 1.5, maxGap: 1.5})
    const clip = path.join(temporary, `bench-loop-${runIndex}.mkv`)
    execFileSync(require('ffmpeg-static'), lib.clipArgs(schedule, clip), {windowsHide: true, timeout: 60000})
    await run(host, `(() => {
      const v = document.getElementById('local-video')
      const t0 = performance.now()
      const log = []
      const note = (what) => log.push([Math.round(performance.now() - t0), what])
      window.__loop = {started: false, ended: 0, loadedmetadata: 0, pausedSamples: 0, viewerPausedSamples: 0, samples: 0, log}
      v.addEventListener('ended', () => window.__loop.ended++)
      v.addEventListener('loadedmetadata', () => window.__loop.loadedmetadata++)
      v.addEventListener('playing', () => { window.__loop.started = true })
      for (const type of ['ended', 'pause', 'play', 'playing', 'seeking', 'seeked', 'emptied', 'waiting']) v.addEventListener(type, () => note(type + ' t=' + v.currentTime.toFixed(2)))
      // The capture's tracks: what each does at the end of the film (read through session.captured, which publishStream sets).
      const watched = new WeakSet()
      setInterval(() => {
        if (!window.__loop.started) return // the film is still opening: not a loop restart
        window.__loop.samples++
        const st = __test.getState()
        if (st.playing === false) { window.__loop.pausedSamples++; note('state.playing=false paused=' + v.paused + ' ended=' + v.ended + ' t=' + v.currentTime.toFixed(2)) }
        const stream = __test.session.captured
        if (stream && !watched.has(stream)) {
          watched.add(stream)
          stream.addEventListener('addtrack', (e) => note('capture addtrack ' + e.track.kind))
          stream.addEventListener('removetrack', (e) => note('capture removetrack ' + e.track.kind + ' ' + e.track.readyState))
        }
        for (const track of stream ? stream.getTracks() : []) {
          if (watched.has(track)) continue
          watched.add(track)
          for (const type of ['ended', 'mute', 'unmute']) track.addEventListener(type, () => note('capture ' + track.kind + ' ' + type))
        }
      }, 40)
      return true
    })()`)
    await run(viewer, `(() => { window.__loop = {viewerPausedSamples: 0, started: false}; setInterval(() => { const r = __test.session.remote; if (r && r.playing) window.__loop.started = true; else if (r && window.__loop.started) window.__loop.viewerPausedSamples++ }, 40); return true })()`)
    await run(host, `__test.hostFile(${JSON.stringify(clip)})`)
    await run(host, '__test.control("loop", true)')
    await until(viewer, 'document.getElementById("remote-video").getVideoPlaybackQuality().totalVideoFrames > 24', 45000, 'viewer receives video')
    const hostShape = '(() => { const s = __test.session; const live = (t) => ({kind: t.kind, state: t.readyState, muted: t.muted}); return JSON.stringify({captured: s.captured ? s.captured.getTracks().map(live) : null, published: s.stream ? s.stream.getTracks().map(live) : null, loadedmetadata: window.__loop.loadedmetadata}) })()'
    const viewerShape = '(() => { const v = document.getElementById("remote-video"); return JSON.stringify({tracks: v.srcObject ? v.srcObject.getTracks().map((t) => ({kind: t.kind, state: t.readyState, muted: t.muted})) : null}) })()'
    const stages = []
    let before = JSON.parse(await run(viewer, '__bench.collect().then(JSON.stringify)')).levels.length
    for (let repeat = 1; repeat <= options.repeats; repeat++) {
      await until(host, `window.__loop.ended >= ${repeat}`, 30000, `the clip ends the ${repeat}th time`)
      await pause(300)
      const levels = JSON.parse(await run(viewer, '__bench.collect().then(JSON.stringify)')).levels
      const mine = levels.slice(before).map((l) => l.rms)
      before = levels.length
      stages.push({repeat, beeps: mine.length, beepRms: lib.round(lib.median(mine), 3), host: JSON.parse(await run(host, hostShape)), viewer: JSON.parse(await run(viewer, viewerShape))})
    }
    const counters = await run(host, 'JSON.stringify(window.__loop)').then(JSON.parse)
    const viewerPaused = (await run(viewer, 'window.__loop.viewerPausedSamples')) | 0
    // A different film after the loop (opening it is not a loop restart, so the paused counters above are read first): the viewer must hear it too (the loop's detached capture tracks are let go, not kept).
    const next = clip.replace(/.mkv$/, '-next.mkv')
    fs.copyFileSync(clip, next)
    const beforeNext = JSON.parse(await run(viewer, '__bench.collect().then(JSON.stringify)')).levels.length
    await run(host, `__test.hostFile(${JSON.stringify(next)})`)
    await pause(9000)
    const nextLevels = JSON.parse(await run(viewer, '__bench.collect().then(JSON.stringify)')).levels.slice(beforeNext).map((l) => l.rms)
    const afterNext = {beeps: nextLevels.length, beepRms: lib.round(lib.median(nextLevels), 3), host: JSON.parse(await run(host, hostShape))}
    const errors = [...await run(host, '__test.errors'), ...await run(viewer, '__test.errors')]
    // The first pass of the loop has the viewer's start-up in it: judged from the second repeat on.
    const judged = stages.filter((s) => s.repeat >= 2)
    const problems = [
      ...judged.filter((s) => !(s.beeps >= 2 && s.beepRms >= 0.1)).map((s) => `repeat ${s.repeat}: the viewer heard ${s.beeps} of 2 beeps, median RMS ${s.beepRms} (under 0.1 is silence)`),
      ...(counters.pausedSamples > 0 ? [`the host looked paused in ${counters.pausedSamples} of ${counters.samples} samples during the loop`] : []),
      ...(viewerPaused > 0 ? [`the viewer was told the film was paused in ${viewerPaused} samples during the loop`] : []),
      ...(!(afterNext.beeps >= 2 && afterNext.beepRms >= 0.1) ? [`after the loop a different film was opened and the viewer heard ${afterNext.beeps} beep(s), median RMS ${afterNext.beepRms}`] : []),
      ...(stages.length < options.repeats ? ['the loop did not run every repeat'] : []),
    ]
    return {variant: 'loop', stages, afterNext, counters, events: counters.log, viewerPausedSamples: viewerPaused, pageErrors: errors, problems}
  } finally {
    host.destroy()
    viewer.destroy()
    require('../main/media').stopAll()
  }
}

// M1.12 attempt 3: a film longer than KEEP_BEHIND_SECONDS (player.mjs) has let go of its start by the time it ends, so
// Loop's seek(0) restarts ffmpeg and resets the SourceBuffer (startAt) instead of the plain currentTime set a short clip
// gets. A 20s clip with two beeps at its start and one near its end, opened at 17s: every restart goes through
// startAt(0). Mid-repeat the host is moved to 17s again through startAt itself (what a seek outside the buffer does), so
// the start is gone again for the next restart; each repeat costs ~8s instead of 20s. Judged every repeat: the viewer
// hears both start beeps (RMS >= 0.1), its decoded frames grow, and neither side ever reads the film as paused.
async function runLongLoop(env, runIndex) {
  const {host, viewer} = await connectedPair(`longloop${runIndex}`, 'longhost', 'longviewer')
  try {
    await applySendOptions(host)
    await Promise.all([run(host, '__bench.installTap()'), run(viewer, '__bench.installTap()')])
    const fps = 24
    const at = (t, index) => ({index, frame: Math.round(t * fps), t: Math.round(t * fps) / fps})
    const schedule = {fps, size: '640x360', events: [at(1, 0), at(2.5, 1), at(18, 2)], duration: 20}
    const clip = path.join(temporary, `bench-longloop-${runIndex}.mkv`)
    execFileSync(require('ffmpeg-static'), lib.clipArgs(schedule, clip), {windowsHide: true, timeout: 60000})
    await run(host, `(() => {
      const v = document.getElementById('local-video')
      const t0 = performance.now()
      const log = []
      const note = (what) => log.push([Math.round(performance.now() - t0), what])
      window.__loop = {started: false, ended: 0, loadedmetadata: 0, sessions: 0, sessionsAtEnd: [], pausedSamples: 0, samples: 0, log}
      // How many ffmpeg sessions had started when each repeat ended: the loop's own restart follows within milliseconds.
      v.addEventListener('ended', () => { window.__loop.ended++; window.__loop.sessionsAtEnd.push(window.__loop.sessions) })
      v.addEventListener('loadedmetadata', () => window.__loop.loadedmetadata++)
      v.addEventListener('playing', () => { window.__loop.started = true })
      for (const type of ['ended', 'pause', 'play', 'playing', 'seeking', 'seeked', 'emptied', 'waiting']) v.addEventListener(type, () => note(type + ' t=' + v.currentTime.toFixed(2)))
      __test.player.addEventListener('session', () => { window.__loop.sessions++; note('ffmpeg session ' + __test.player.sessionId) })
      const watched = new WeakSet()
      setInterval(() => {
        if (!window.__loop.started) return
        window.__loop.samples++
        if (__test.getState().playing === false) { window.__loop.pausedSamples++; note('state.playing=false paused=' + v.paused + ' ended=' + v.ended + ' t=' + v.currentTime.toFixed(2)) }
        const stream = __test.session.captured
        if (stream && !watched.has(stream)) {
          watched.add(stream)
          stream.addEventListener('addtrack', (e) => note('capture addtrack ' + e.track.kind))
          stream.addEventListener('removetrack', (e) => note('capture removetrack ' + e.track.kind + ' ' + e.track.readyState))
        }
        for (const track of stream ? stream.getTracks() : []) {
          if (watched.has(track)) continue
          watched.add(track)
          for (const type of ['ended', 'mute', 'unmute']) track.addEventListener(type, () => note('capture ' + track.kind + ' ' + type))
        }
      }, 40)
      return true
    })()`)
    await run(viewer, `(() => { window.__loop = {viewerPausedSamples: 0, started: false}; setInterval(() => { const r = __test.session.remote; if (r && r.playing) window.__loop.started = true; else if (r && window.__loop.started) window.__loop.viewerPausedSamples++ }, 40); return true })()`)
    await run(host, `__test.hostFile(${JSON.stringify(clip)}, null, {start: 17})`)
    await run(host, '__test.control("loop", true)')
    const frames = () => run(viewer, 'document.getElementById("remote-video").getVideoPlaybackQuality().totalVideoFrames')
    const hostShape = '(() => { const s = __test.session; const live = (t) => ({kind: t.kind, state: t.readyState, muted: t.muted}); return JSON.stringify({captured: s.captured ? s.captured.getTracks().map(live) : null, published: s.stream ? s.stream.getTracks().map(live) : null, buffered: (() => { const b = __test.player.sourceBuffer?.buffered; return b ? Array.from({length: b.length}, (_, i) => [b.start(i), b.end(i)].map((x) => Math.round(x * 10) / 10)) : null })(), loadedmetadata: window.__loop.loadedmetadata, sessions: window.__loop.sessions}) })()'
    const viewerShape = '(() => { const v = document.getElementById("remote-video"); return JSON.stringify({tracks: v.srcObject ? v.srcObject.getTracks().map((t) => ({kind: t.kind, state: t.readyState, muted: t.muted})) : null}) })()'
    const stages = []
    for (let repeat = 1; repeat <= options.repeats; repeat++) {
      await until(host, `window.__loop.ended >= ${repeat}`, 30000, `the long clip ends the ${repeat}th time`)
      const before = JSON.parse(await run(viewer, '__bench.collect().then(JSON.stringify)')).levels.length
      const framesBefore = await frames()
      const sessionsBefore = await run(host, `window.__loop.sessionsAtEnd[${repeat - 1}]`)
      // Past both start beeps, plus the viewer's delay behind the host.
      await until(host, 'document.getElementById("local-video").currentTime > 3.2', 20000, `repeat ${repeat + 1} plays past its start beeps`)
      await pause(900)
      const levels = JSON.parse(await run(viewer, '__bench.collect().then(JSON.stringify)')).levels.slice(before).map((l) => l.rms)
      const shape = JSON.parse(await run(host, hostShape))
      stages.push({repeat, beeps: levels.length, beepRms: lib.round(lib.median(levels), 3), framesGrew: (await frames()) - framesBefore, restartedFfmpeg: shape.sessions > sessionsBefore, host: shape, viewer: JSON.parse(await run(viewer, viewerShape))})
      if (repeat < options.repeats) await run(host, '__test.player.startAt(17); true') // the start goes again, as in a long film
    }
    const counters = await run(host, 'JSON.stringify(window.__loop)').then(JSON.parse)
    const viewerPaused = (await run(viewer, 'window.__loop.viewerPausedSamples')) | 0
    const errors = [...await run(host, '__test.errors'), ...await run(viewer, '__test.errors')]
    const problems = [
      ...stages.filter((s) => !(s.beeps >= 2 && s.beepRms >= 0.1)).map((s) => `long film, repeat ${s.repeat + 1}: the viewer heard ${s.beeps} of 2 beeps, median RMS ${s.beepRms} (under 0.1 is silence)`),
      ...stages.filter((s) => !(s.framesGrew > fps)).map((s) => `long film, repeat ${s.repeat + 1}: the viewer decoded ${s.framesGrew} frames in its first 3s`),
      ...stages.filter((s) => !s.restartedFfmpeg).map((s) => `long film, repeat ${s.repeat + 1}: the loop did not restart ffmpeg, so this is not the long-film path`),
      ...(counters.pausedSamples > 0 ? [`long film: the host looked paused in ${counters.pausedSamples} of ${counters.samples} samples during the loop`] : []),
      ...(viewerPaused > 0 ? [`long film: the viewer was told the film was paused in ${viewerPaused} samples during the loop`] : []),
      ...(stages.length < options.repeats ? ['long film: the loop did not run every repeat'] : []),
    ]
    return {stages, counters, events: counters.log, viewerPausedSamples: viewerPaused, pageErrors: errors, problems}
  } finally {
    host.destroy()
    viewer.destroy()
    require('../main/media').stopAll()
  }
}

// M1.7: a burst of packet loss on an otherwise clean link, then clean again. A film plays; after --burst-at seconds the relays
// drop --burst-pct percent of the packets each way for --burst-s seconds, then none. Read:
//   - the sender's ladder (host-sample `scale` and `bitrate`): how many seconds after the burst ends until the picture is back at
//     the size it had before (scale) and at the bitrate it had before. The card asks for 10s.
//   - the longest gap between the viewer's presented frames from the first dropped packet until --recover-s after the burst's end
//     (a freeze while the decoder waits for a keyframe or a retransmission). The card asks for no freeze over 500ms.
//   - the keyframe requests (PLI/FIR) and NACKs each side counted, and the viewer's freeze count and duration from getStats.
async function runBurst(env, runIndex) {
  const {host, viewer} = await connectedPair(`burst${runIndex}`, 'bursthost', 'burstviewer')
  try {
    await applySendOptions(host)
    await run(viewer, '__bench.installTap()') // collect() reads the tap too
    await run(viewer, `__bench.watchVideo(() => document.getElementById('remote-video'))`)
    await run(host, `__test.hostFile(${JSON.stringify(env.clip)})`)
    await until(viewer, 'document.getElementById("remote-video").getVideoPlaybackQuality().totalVideoFrames > 24', 45000, 'viewer receives video')
    await pause(options.burstAtS * 1000)
    const hostSelfId = await run(host, '__test.selfId')
    const before = {viewer: await rtpSnapshot(viewer), sender: await rtpSnapshot(host)}
    const droppedBefore = network.stats.dropped
    const startedWall = Date.now()
    network.setLoss(options.burstPct)
    await pause(options.burstS * 1000)
    network.setLoss(0)
    const endedWall = Date.now()
    const dropped = network.stats.dropped - droppedBefore
    await pause(options.recoverS * 1000)
    const after = {viewer: await rtpSnapshot(viewer), sender: await rtpSnapshot(host)}
    await Promise.all([host, viewer].map((win) => run(win, '__test.flushLog()')))
    const viewerData = JSON.parse(await run(viewer, '__bench.collect().then(JSON.stringify)'))
    const errors = [...await run(host, '__test.errors'), ...await run(viewer, '__test.errors')]
    const read = readBurst({hostSelfId, startedWall, endedWall, viewerData, before, after, fps: env.schedule.fps})
    const problems = [
      ...(dropped > 0 ? [] : ['no packet was dropped: the relays are not in the path']),
      ...(read.scaleBackAtS != null && read.scaleBackAtS <= 10 ? [] : [`the picture was not back at its size ${read.pre?.scale} within 10s of the burst's end (back at ${read.scaleBackAtS}s)`]),
      // The card's 500ms is for a burst a real link has; at 30% the retransmissions are lost too and no keyframe can be asked for sooner, so a heavier burst only reports.
      ...(read.longestGapMs <= 500 || options.burstPct > 15 ? [] : [`the longest freeze after the loss was ${read.longestGapMs}ms, over 500ms`]),
    ]
    return {variant: 'burst', dropped, read, pageErrors: errors, problems}
  } finally {
    network.setLoss(0)
    host.destroy()
    viewer.destroy()
    require('../main/media').stopAll()
  }
}

function readBurst({hostSelfId, startedWall, endedWall, viewerData, before, after, fps}) {
  diagnostics.flush()
  const lines = fs.readFileSync(diagnostics.filePath(), 'utf8').trim().split('\n').map(parseLine).filter(Boolean)
  const wall = (e) => Date.parse(e.t)
  const samples = lines.filter((e) => e.self === hostSelfId && e.ev === 'host-sample' && e.bitrate != null).map((e) => ({atS: lib.round((wall(e) - endedWall) / 1000, 1), wall: wall(e), bitrate: e.bitrate, scale: e.scale, decision: e.decision, lossPct: e.receiver?.lossPct ?? null, freezes: e.receiver?.freezes ?? null}))
  const pre = [...samples].reverse().find((s) => s.wall < startedWall) || null
  const during = samples.filter((s) => s.wall >= startedWall && s.wall <= endedWall + 2000)
  const post = samples.filter((s) => s.wall > endedWall)
  const scaleBack = pre && post.find((s) => s.scale <= pre.scale + 1e-6)
  const bitrateBack = pre && post.find((s) => s.bitrate >= pre.bitrate * 0.99)
  const frames = viewerData.frames.map((f) => viewerData.timeOrigin + f[4])
  const gaps = []
  for (let i = 1; i < frames.length; i++) if (frames[i] >= startedWall - 500 && frames[i] <= endedWall + options.recoverS * 1000) gaps.push({atS: lib.round((frames[i - 1] - startedWall) / 1000, 2), ms: Math.round(frames[i] - frames[i - 1])})
  const calmGaps = []
  for (let i = 1; i < frames.length; i++) if (frames[i] >= viewerData.timeOrigin + 5000 && frames[i] < startedWall - 500) calmGaps.push(frames[i] - frames[i - 1])
  const v0 = before.viewer.videoIn
  const v1 = after.viewer.videoIn
  const s0 = before.sender.videoOut
  const s1 = after.sender.videoOut
  const delta = (a, b, key) => (a && b && Number.isFinite(a[key]) && Number.isFinite(b[key]) ? b[key] - a[key] : null)
  return {
    pre, lowest: during.length ? {bitrate: Math.min(...during.map((s) => s.bitrate)), scale: Math.max(...during.map((s) => s.scale))} : null,
    scaleBackAtS: scaleBack ? scaleBack.atS : null, bitrateBackAtS: bitrateBack ? bitrateBack.atS : null,
    // Information, not a gate: the ceiling is held below its old value for a minute on purpose (the stall memory).
    ceilingAt10sPct: pre && post.find((s) => s.atS >= 10) ? lib.round((100 * post.find((s) => s.atS >= 10).bitrate) / pre.bitrate, 0) : null,
    series: samples.filter((s) => s.wall >= startedWall - 4000).map((s) => [s.atS, s.bitrate, s.scale, s.decision, s.lossPct]),
    longestGapMs: gaps.reduce((m, g) => Math.max(m, g.ms), 0), calmLongestGapMs: Math.round(calmGaps.reduce((m, g) => Math.max(m, g), 0)),
    gapsOver500: gaps.filter((g) => g.ms > 500), gapsOver150: gaps.filter((g) => g.ms > 150).length,
    viewer: {freezes: delta(v0, v1, 'freezeCount'), freezeS: lib.round(delta(v0, v1, 'totalFreezesDuration'), 2), framesDropped: delta(v0, v1, 'framesDropped'), heightBefore: v0?.frameHeight ?? null, heightAfter: v1?.frameHeight ?? null, packetsLost: delta(v0, v1, 'packetsLost'), pli: delta(v0, v1, 'pliCount'), nack: delta(v0, v1, 'nackCount'), fir: delta(v0, v1, 'firCount'), keyFramesDecoded: delta(v0, v1, 'keyFramesDecoded')},
    sender: {pli: delta(s0, s1, 'pliCount'), nack: delta(s0, s1, 'nackCount'), fir: delta(s0, s1, 'firCount'), keyFramesEncoded: delta(s0, s1, 'keyFramesEncoded')},
  }
}

function summarizeBurst(allRuns) {
  const runs = allRuns.filter((r) => !r.failed)
  const col = (pick) => runs.map(pick).filter(Number.isFinite)
  const med = (pick, digits = 1) => lib.round(lib.median(col(pick)), digits)
  return {runs: runs.length, failedRuns: allRuns.length - runs.length, scaleBackAtS: {perRun: runs.map((r) => r.read.scaleBackAtS), median: med((r) => r.read.scaleBackAtS)}, bitrateBackAtS: {perRun: runs.map((r) => r.read.bitrateBackAtS), median: med((r) => r.read.bitrateBackAtS)}, ceilingAt10sPct: {perRun: col((r) => r.read.ceilingAt10sPct), median: med((r) => r.read.ceilingAt10sPct, 0)}, longestGapMs: {perRun: col((r) => r.read.longestGapMs), median: med((r) => r.read.longestGapMs, 0)}, calmLongestGapMs: {perRun: col((r) => r.read.calmLongestGapMs), median: med((r) => r.read.calmLongestGapMs, 0)}}
}

function summarizeRepublish(allRuns) {
  const runs = allRuns.filter((r) => !r.failed)
  const count = Math.max(0, ...runs.map((r) => r.stages.length))
  const at = (n) => runs.map((r) => r.stages[n]?.separation).filter(Number.isFinite)
  const rms = (n) => runs.map((r) => r.stages[n]?.beepRms).filter(Number.isFinite)
  return {runs: runs.length, failedRuns: allRuns.length - runs.length, sections: runs.map((r) => r.stages.at(-1)?.shape?.sections ?? null), offerBytes: runs.map((r) => r.stages.at(-1)?.shape?.offerBytes ?? null), separation: Array.from({length: count}, (_, i) => i + 1).map((publish) => ({publish, perRun: at(publish - 1), median: lib.round(lib.median(at(publish - 1)), 3), beepRms: {perRun: rms(publish - 1), median: lib.round(lib.median(rms(publish - 1)), 3)}}))}
}

// A loop run is a pass or an invalid run; what is summarised is the quietest repeat anywhere.
function summarizeLoop(allRuns) {
  const runs = allRuns.filter((r) => !r.failed)
  const stages = runs.flatMap((r) => r.stages.filter((s) => s.repeat >= 2))
  const long = runs.flatMap((r) => r.long?.stages || [])
  return {runs: runs.length, failedRuns: allRuns.length - runs.length, repeatsJudged: stages.length, quietestBeepRms: lib.round(Math.min(...stages.map((s) => s.beepRms).filter(Number.isFinite)), 3), fewestBeeps: Math.min(...stages.map((s) => s.beeps)),
    long: {repeatsJudged: long.length, quietestBeepRms: lib.round(Math.min(...long.map((s) => s.beepRms).filter(Number.isFinite)), 3), fewestBeeps: Math.min(...long.map((s) => s.beeps)), fewestFrames: Math.min(...long.map((s) => s.framesGrew))}}
}

function summarizeVariant(allRuns) {
  const runs = allRuns.filter((r) => !r.failed)
  const col = (pick) => runs.map(pick).filter(Number.isFinite)
  const med = (pick, digits = 2) => lib.round(lib.median(col(pick)), digits)
  return {
    runs: runs.length, failedRuns: allRuns.length - runs.length,
    // The audio numbers, medians over the runs (this machine is shared: read three, not one).
    audio: {
      separationAtViewer: {perRun: col((r) => r.viewer.stereo.separation), median: med((r) => r.viewer.stereo.separation, 3)},
      concealmentPct: {perRun: col((r) => r.transport.audio.concealment?.pct), median: med((r) => r.transport.audio.concealment?.pct, 3)},
      receivedKbps: {perRun: col((r) => r.transport.audio.receivedKbps), median: med((r) => r.transport.audio.receivedKbps, 1)},
      sentKbps: {perRun: col((r) => r.transport.audio.sentKbps), median: med((r) => r.transport.audio.sentKbps, 1)},
      packetsLost: {perRun: col((r) => r.transport.audio.packetsLost), median: med((r) => r.transport.audio.packetsLost, 0)},
      firstStepS: {perRun: col((r) => r.sent?.firstStepS), median: med((r) => r.sent?.firstStepS, 1)},
      setParametersAudio: {perRun: col((r) => r.sent?.setParameters.audio), median: med((r) => r.sent?.setParameters.audio, 0)},
    },
    video: {
      presentedPerSecond: {perRun: col((r) => r.viewer.video.presentedPerSecond), median: med((r) => r.viewer.video.presentedPerSecond, 2)},
      rvfcPerSecond: {perRun: col((r) => r.viewer.video.rvfcPerSecond), median: med((r) => r.viewer.video.rvfcPerSecond, 2)},
      hostPresentedPerSecond: {perRun: col((r) => r.host?.video.presentedPerSecond), median: med((r) => r.host?.video.presentedPerSecond, 2)},
      inboundFps: {perRun: col((r) => r.transport.video.inboundFps), median: med((r) => r.transport.video.inboundFps, 1)},
      intervalSdMs: {perRun: col((r) => r.viewer.video.cadence.intervalStddevMs), median: med((r) => r.viewer.video.cadence.intervalStddevMs, 2)},
      intervalP95Ms: {perRun: col((r) => r.viewer.video.cadence.intervalP95Ms), median: med((r) => r.viewer.video.cadence.intervalP95Ms, 2)},
      intervalMaxMs: {perRun: col((r) => r.viewer.video.cadence.intervalMaxMs), median: med((r) => r.viewer.video.cadence.intervalMaxMs, 1)},
      lateFramePct: {perRun: col((r) => r.viewer.video.cadence.lateFramePct), median: med((r) => r.viewer.video.cadence.lateFramePct, 2)},
      freezes: {perRun: col((r) => r.transport.video.freezes), median: med((r) => r.transport.video.freezes, 0)},
      receivedKbps: {perRun: col((r) => r.transport.video.receivedKbps), median: med((r) => r.transport.video.receivedKbps, 0)},
    },
    steadyMedianMs: {perRun: col((r) => r.viewer.offset.steady.medianMs), median: lib.round(lib.median(col((r) => r.viewer.offset.steady.medianMs)), 1), spread: spread(col((r) => r.viewer.offset.steady.medianMs))},
    steadyMedianAbsMs: lib.round(lib.median(col((r) => r.viewer.offset.steady.medianAbsMs)), 1),
    steadyP95AbsMs: {perRun: col((r) => r.viewer.offset.steady.p95AbsMs), median: lib.round(lib.median(col((r) => r.viewer.offset.steady.p95AbsMs)), 1)},
    steadyWorstMs: {perRun: col((r) => r.viewer.offset.steady.worstMs), worst: runs.length ? runs.flatMap((r) => (Number.isFinite(r.viewer.offset.steady.worstMs) ? [r.viewer.offset.steady.worstMs] : [])).reduce((w, v) => (Math.abs(v) > Math.abs(w) ? v : w), 0) : null},
  }
}

function summarizePause(allRuns) {
  const runs = allRuns.filter((r) => !r.failed)
  const col = (pick) => runs.map(pick).filter(Number.isFinite)
  const both = (pick, digits = 1) => ({perRun: col(pick), median: lib.round(lib.median(col(pick)), digits)})
  return {runs: runs.length, failedRuns: allRuns.length - runs.length, earlyMedianMs: both((r) => r.early.medianMs), lateMedianMs: both((r) => r.late.medianMs), driftMsPerS: both((r) => r.driftMsPerS, 2), audioJitterBufferMaxMs: both((r) => r.audioJitterBufferMaxMs, 0), estimatedOffsetMaxMs: both((r) => r.estimatedOffsetMaxMs, 0)}
}

function printReport(report) {
  const f = (v, unit = '') => (v == null ? 'n/a' : `${v}${unit}`)
  const mode = [report.options.loss ? `loss ${report.options.loss}%` : '', report.options.linkKbps ? `link ${report.options.linkKbps}kbps` : '', report.options.audioLadder === 'off' ? 'audio ladder off' : '', report.options.audioFirst === 'off' ? 'keep-audio-quality off' : '', report.options.tree ? `tree ${path.basename(report.options.tree)}` : ''].filter(Boolean).join(', ') || 'clean link'
  console.log(`\n=== Benchmark ${report.version} ${report.date}${report.options.quick ? ' (quick: not a result)' : ''} [${mode}] ===`)
  for (const [variant, runs] of Object.entries(report.variants)) {
    const s = report.summary[variant]
    if (variant === 'pause') {
      console.log(`
--- pause: ${runs.length} run(s), paused ${PAUSE_S}s at ${PAUSE_AT_S}s, read after the resume (positive = sound late) ---`)
      console.log(`  first 15s after the resume ${f(s.earlyMedianMs.median, 'ms')} (${s.earlyMedianMs.perRun.join(', ')}); from 15s on ${f(s.lateMedianMs.median, 'ms')} (${s.lateMedianMs.perRun.join(', ')}); drift ${f(s.driftMsPerS.median, 'ms/s')}; viewer audio jitter buffer peak ${f(s.audioJitterBufferMaxMs.median, 'ms')}, s.off peak ${f(s.estimatedOffsetMaxMs.median, 'ms')}`)
      runs.forEach((r, i) => {
        if (r.failed) return console.log(`  run ${i + 1}: FAILED ${r.failed}`)
        console.log(`  run ${i + 1}: offsets after the resume ${r.offsets.map((o) => `${o.t.toFixed(0)}s ${o.ms.toFixed(0)}`).join(', ')}`)
        for (const problem of r.problems) console.log(`         INVALID: ${problem}`)
      })
      continue
    }
    if (variant === 'burst') {
      console.log(`
--- burst: ${runs.length} run(s), ${report.options.burstPct}% loss for ${report.options.burstS}s after ${report.options.burstAtS}s, ${report.options.recoverS}s to recover ---`)
      console.log(`  seconds after the burst ends until the picture is back at its size: ${f(s.scaleBackAtS.median, 's')} (${s.scaleBackAtS.perRun.join(', ')}); until the send ceiling is back at its old value: ${f(s.bitrateBackAtS.median, 's')} (${s.bitrateBackAtS.perRun.join(', ')}), at 10s it stands at ${f(s.ceilingAt10sPct.median, '%')} of it (${s.ceilingAt10sPct.perRun.join(', ')}); longest gap between presented frames from the loss to the end of the window ${f(s.longestGapMs.median, 'ms')} (${s.longestGapMs.perRun.join(', ')}), before the loss ${f(s.calmLongestGapMs.median, 'ms')}`)
      runs.forEach((r, i) => {
        if (r.failed) return console.log(`  run ${i + 1}: FAILED ${r.failed}`)
        const k = r.read
        console.log(`  run ${i + 1}: dropped ${r.dropped} packets; before ${JSON.stringify(k.pre)}; lowest ${JSON.stringify(k.lowest)}; gaps over 500ms ${JSON.stringify(k.gapsOver500)}, over 150ms ${k.gapsOver150}; viewer ${JSON.stringify(k.viewer)}; sender ${JSON.stringify(k.sender)}`)
        console.log(`         ladder after the loss started (s after the burst ended, bitrate, scale, decision, reported loss%): ${JSON.stringify(k.series)}`)
        for (const problem of r.problems) console.log(`         INVALID: ${problem}`)
      })
      continue
    }
    if (variant === 'loop') {
      console.log(`
--- loop: ${runs.length} run(s) ---`)
      console.log(`  ${s.repeatsJudged} repeat(s) judged (the first is start-up): fewest beeps heard in one repeat ${s.fewestBeeps} of 2, quietest repeat's median beep RMS ${s.quietestBeepRms} (a beep reads 0.35, silence 0)`)
      console.log(`  long film: ${s.long.repeatsJudged} repeat(s) judged: fewest start beeps heard in one repeat ${s.long.fewestBeeps} of 2, quietest median RMS ${s.long.quietestBeepRms}, fewest frames decoded in a repeat's first 3s ${s.long.fewestFrames}`)
      runs.forEach((r, i) => {
        if (r.failed) return console.log(`  run ${i + 1}: FAILED ${r.failed}`)
        console.log(`  run ${i + 1}: ${r.stages.map((x) => `#${x.repeat} ${x.beeps} beeps rms ${x.beepRms}`).join('; ')}`)
        const last = r.stages.at(-1)
        if (process.env.LOOP_EVENTS) console.log(r.events.map((e) => e.join(' ')).join('\n'))
        console.log(`         then a different film: ${r.afterNext.beeps} beeps, rms ${r.afterNext.beepRms}, published ${JSON.stringify(r.afterNext.host.published)}
         after the last repeat: host capture ${JSON.stringify(last.host.captured)}, published ${JSON.stringify(last.host.published)}, viewer ${JSON.stringify(last.viewer.tracks)}; loadedmetadata ${last.host.loadedmetadata}x, ended ${r.counters.ended}x, paused samples host ${r.counters.pausedSamples}/${r.counters.samples} viewer ${r.viewerPausedSamples}`)
        if (r.long) {
          const l = r.long
          const lastLong = l.stages.at(-1)
          console.log(`         long film (20s, every restart through ffmpeg): ${l.stages.map((x) => `#${x.repeat + 1} ${x.beeps} beeps rms ${x.beepRms}, +${x.framesGrew} frames${x.restartedFfmpeg ? '' : ', NO ffmpeg restart'}`).join('; ')}
         after its last repeat: host capture ${JSON.stringify(lastLong?.host.captured)}, published ${JSON.stringify(lastLong?.host.published)}, buffered ${JSON.stringify(lastLong?.host.buffered)}, viewer ${JSON.stringify(lastLong?.viewer.tracks)}; ffmpeg sessions ${lastLong?.host.sessions}, ended ${l.counters.ended}x, paused samples host ${l.counters.pausedSamples}/${l.counters.samples} viewer ${l.viewerPausedSamples}`)
          if (process.env.LOOP_EVENTS) console.log(l.events.map((e) => e.join(' ')).join('\n'))
        }
        for (const problem of r.problems) console.log(`         INVALID: ${problem}`)
      })
      continue
    }
    if (variant === 'republish' || variant === 'reopen') {
      console.log(`\n--- ${variant}: ${runs.length} run(s) ---`)
      console.log(`  viewer L/R separation after each publish (0.5 is stereo, 0 is mono): ${s.separation.map((x) => x.median).join(', ')}  (lowest of any run: ${Math.min(...s.separation.flatMap((x) => x.perRun))})`)
      console.log(`  viewer beep RMS after each publish (1kHz beep at 0.5 peak reads 0.35; silence 0): ${s.separation.map((x) => x.beepRms.median).join(', ')}  (lowest of any run: ${Math.min(...s.separation.flatMap((x) => x.beepRms.perRun))})`)
      console.log(`  the host's connection after the last publish: m-sections ${s.sections.join(', ')}, offer ${s.offerBytes.join(', ')} bytes per run (a signalling message may be 65536)`)
      runs.forEach((r, i) => {
        if (r.failed) return console.log(`  run ${i + 1}: FAILED ${r.failed}`)
        console.log(`  run ${i + 1}: ${r.stages.map((x) => `#${x.publish} sep ${x.separation}, ${x.audioSections} audio section(s)`).join('; ')}; receive fmtp '${r.stages.at(-1).receiveFmtp}'`)
        for (const problem of r.problems) console.log(`         INVALID: ${problem}`)
      })
      continue
    }
    console.log(`\n--- ${variant}: ${runs.length} run(s) ---`)
    console.log(`  audio, medians over ${s.runs} run(s): L/R separation at the viewer ${f(s.audio.separationAtViewer.median)} (${s.audio.separationAtViewer.perRun.join(', ')}), concealed ${f(s.audio.concealmentPct.median, '%')} (${s.audio.concealmentPct.perRun.join(', ')}), received ${f(s.audio.receivedKbps.median, ' kbps')}, sent ${f(s.audio.sentKbps.median, ' kbps')}, lost packets ${f(s.audio.packetsLost.median)}, first audio step ${f(s.audio.firstStepS.median, 's')}, audio setParameters ${f(s.audio.setParametersAudio.median)}`)
    console.log(`  video, medians over ${s.runs} run(s) at ${report.clip.fps}fps: viewer presents ${f(s.video.presentedPerSecond.median, '/s')} (${s.video.presentedPerSecond.perRun.join(', ')}; host's own ${f(s.video.hostPresentedPerSecond.median, '/s')}), rVFC callbacks ${f(s.video.rvfcPerSecond.median, '/s')}, inbound ${f(s.video.inboundFps.median, 'fps')}, frame interval sd ${f(s.video.intervalSdMs.median, 'ms')} (${s.video.intervalSdMs.perRun.join(', ')}), p95 ${f(s.video.intervalP95Ms.median, 'ms')}, max ${f(s.video.intervalMaxMs.median, 'ms')}, late frames ${f(s.video.lateFramePct.median, '%')}, freezes ${f(s.video.freezes.median)}, ${f(s.video.receivedKbps.median, ' kbps')}`)
    console.log(`  A/V offset at the viewer, beep heard minus flash shown (positive = sound late), events after ${lib.STEADY}s of clip:`)
    console.log(`    median ${f(s.steadyMedianMs.median, 'ms')}  |median| ${f(s.steadyMedianAbsMs, 'ms')}  p95 |offset| ${f(s.steadyP95AbsMs.median, 'ms')}  worst ${f(s.steadyWorstMs.worst, 'ms')}   spread of the run medians ${f(s.steadyMedianMs.spread, 'ms')} (${s.steadyMedianMs.perRun.join(', ')})`)
    runs.forEach((r, i) => {
      if (r.failed) return console.log(`  run ${i + 1}: FAILED ${r.failed}`)
      const o = r.viewer.offset.steady
      const t = r.transport
      console.log(`  run ${i + 1}: n=${o.n}/${r.viewer.expectedSteady} median ${f(o.medianMs, 'ms')} p95 ${f(o.p95AbsMs, 'ms')} worst ${f(o.worstMs, 'ms')} sd ${f(o.stddevMs, 'ms')} drift ${f(r.viewer.offset.driftMsPerS, 'ms/s')}` +
        (r.host ? `   | host's own playback: median ${f(r.host.offset.steady.medianMs, 'ms')} (n=${r.host.offset.steady.n})` : '') +
        `   | telemetry s.off (estimate, sound late) median ${f(r.telemetry.estimatedOffsetMedianMs, 'ms')}, s.av (capture-time skew, not subtracted) median ${f(r.telemetry.avSkewMedianMs, 'ms')}`)
      const c = t.audio.concealment
      console.log(`         audio: ${f(t.audio.codecChannels)} ch (receive fmtp '${f(t.audio.fmtp)}', send fmtp '${f(t.audio.sentFmtp)}'; stereo separation at the viewer's tap ${f(r.viewer.stereo.separation)}${r.host ? `, at the host's ${f(r.host.stereo.separation)}` : ''}; 0.5 is two independent channels, 0 is mono), received ${f(t.audio.receivedKbps, ' kbps')} of ${f(t.audio.configuredMaxKbps, ' kbps')} cap (sent ${f(t.audio.sentKbps, ' kbps')}), concealed (conc-sil) ${f(c?.pct, '%')} over ${f(t.windowS, 's')} (${f(c?.netSamples)} of ${f(c?.totalSamples)} samples), lost ${f(t.audio.packetsLost)}, beep RMS ${f(lib.round(r.viewer.levelRms, 3))}`)
      if (r.sent) console.log(`         sender video encoder (the host's change-only link event, venc): ${JSON.stringify(r.sent.venc)} (${r.sent.linkEvents} link event(s)); encode time ${f(r.sent.encMsMedian, 'ms')}/frame; hardware: ${JSON.stringify(r.sent.hardware)}`)
      if (r.sent) console.log(`         sender: audio steps ${JSON.stringify(r.sent.audioSteps)}, final step ${f(r.sent.finalStep)}, host-sample audio median ${f(r.sent.audioSentKbpsMedian, ' kbps')}, viewer-reported loss median ${f(r.sent.lossReportedMedianPct, '%')}, setParameters applied audio ${r.sent.setParameters.audio} video ${r.sent.setParameters.video} failed ${r.sent.setParameters.failed}`)
      const v = r.viewer.video
      console.log(`         video: ${f(v.cadence.frames)} frames presented, ${f(v.cadence.intervalMeanMs, 'ms')} mean interval (sd ${f(v.cadence.intervalStddevMs, 'ms')}, p95 ${f(v.cadence.intervalP95Ms, 'ms')}, max ${f(v.cadence.intervalMaxMs, 'ms')}, ${f(v.cadence.lateFramePct, '%')} late), rVFC ${f(v.rvfcPerSecond, '/s')}${v.presentedFramesNotCalledBack ? ` (${v.presentedFramesNotCalledBack} presented frames got no callback)` : ''} = ${f(lib.round(v.rvfcPerSecond / report.clip.fps, 2), 'x')} the clip's ${report.clip.fps}fps, inbound ${f(t.video.inboundFps, 'fps')} ${f(t.video.width)}x${f(t.video.height)} ${f(t.video.receivedKbps, ' kbps')}, dropped ${f(t.video.framesDropped)}, freezes ${f(t.video.freezes)}`)
      const k = r.viewer.clock
      console.log(`         output path: outputLatency ${f(k.outputLatencyMs, 'ms')} baseLatency ${f(k.baseLatencyMs, 'ms')} getOutputTimestamp lag ${f(k.outputTimestampLagMs, 'ms')} deviceLatencyIncluded=${k.deviceLatencyIncluded}${k.deviceLatencyIncluded ? '' : ` (correction applied: +${k.correctionMs}ms, from --device-latency-ms)`}, clock-map spread ${f(k.mapSpreadMs, 'ms')}`)
      if (r.viewer.absolute) console.log(`         against the shared schedule (wall clock): picture arrives ${f(r.viewer.absolute.videoSteadyMedianMs, 'ms')} after its instant, sound ${f(r.viewer.absolute.audioSteadyMedianMs, 'ms')} (steady-state medians; their difference is the offset above)`)
      if (r.groundTruth) console.log(`         ground truth: helper delivery lateness p95 ${f(r.groundTruth.helperDelivery?.p95LateMs, 'ms')} max ${f(r.groundTruth.helperDelivery?.maxLateMs, 'ms')}; window paint lateness p95 ${f(r.groundTruth.windowPaint?.p95LateMs, 'ms')} max ${f(r.groundTruth.windowPaint?.maxLateMs, 'ms')}`)
      for (const problem of r.problems) console.log(`         INVALID: ${problem}`)
      if (r.pageErrors.length) console.log(`         page errors: ${JSON.stringify(r.pageErrors)}`)
    })
  }
  console.log('')
}

app.whenReady().then(async () => {
  const watchdog = setTimeout(() => { console.error('Benchmark timed out'); scratch.release(); app.exit(1) }, 40 * 60 * 1000)
  let exitCode = 0
  try {
    const env = await fixtures()
    diagnostics.start({dir: path.join(temporary, 'logs'), info: {version: app.getVersion()}})
    require('../main/main').registerIpc()
    if (network) ipcMain.handle('bench:relay', (event, host, port) => network.relayFor(event.sender.id, host, port))
    ipcMain.removeHandler('net:ice-servers')
    ipcMain.handle('net:ice-servers', () => [])
    ipcMain.removeHandler('screenshare:select') // no real source is ever picked: the bench's window is a canvas
    ipcMain.handle('screenshare:select', () => true)
    console.log(`Bench clip: ${env.schedule.events.length} events, ${env.schedule.duration.toFixed(1)}s, ${env.schedule.fps}fps; ${variants.join(' + ')} x ${options.runs} run(s). Windows are muted and off-screen; nothing is played aloud.`)

    const variantsOut = {}
    for (const variant of variants) {
      variantsOut[variant] = []
      for (let i = 1; i <= options.runs; i++) {
        console.log(`${variant} run ${i}/${options.runs} ...`)
        try {
          variantsOut[variant].push(await (variant === 'film' ? runFilm(env, i) : variant === 'loop' ? runLoop(env, i).then(async (short) => { const long = await runLongLoop(env, i); return {...short, long, problems: [...short.problems, ...long.problems], pageErrors: [...short.pageErrors, ...long.pageErrors]} }) : variant === 'burst' ? runBurst(env, i) : variant === 'pause' ? runPause(env, i) : variant === 'republish' || variant === 'reopen' ? runRepublish(env, i, variant) : runShare(env, i)))
        } catch (error) {
          console.error(error)
          variantsOut[variant].push({variant, failed: String(error.message || error), problems: [`the run failed: ${error.message}`]})
        }
        await pause(2000) // let the closed windows go before the next pair opens
      }
    }
    const version = require('../package.json').version
    const date = new Date().toISOString().slice(0, 10)
    const report = {
      version, date, createdAt: new Date().toISOString(), options, platform: `${process.platform} ${process.arch}`, electron: process.versions.electron, chromium: process.versions.chrome,
      clip: {fps: env.schedule.fps, size: env.schedule.size, events: env.schedule.events.length, durationS: env.schedule.duration, seed: options.seed, flashFrames: lib.FLASH_FRAMES, beepS: lib.BEEP_SECONDS},
      measurement: {
        gated: 'viewer.offset.steady: beep heard (AudioWorklet frame after the output gain, mapped with getOutputTimestamp) minus flash shown (rVFC expectedDisplayTime of the first white frame); host and telemetry s.av are beside it, never subtracted',
        steadyFromS: lib.STEADY, concealment: 'conc - sil over the window that starts 10s after the picture does',
      },
      mode: {loss: options.loss, linkKbps: options.linkKbps, audioLadder: options.audioLadder, audioFirst: options.audioFirst, tree: options.tree ? path.basename(options.tree) : null, network: network && {kind: 'UDP relays (scripts/bench-net.js)', stats: network.stats}},
      variants: variantsOut,
      summary: Object.fromEntries(Object.entries(variantsOut).map(([k, runs]) => [k, k === 'republish' || k === 'reopen' ? summarizeRepublish(runs) : k === 'loop' ? summarizeLoop(runs) : k === 'burst' ? summarizeBurst(runs) : k === 'pause' ? summarizePause(runs) : summarizeVariant(runs)])),
    }
    const dir = path.join(root, 'work', 'bench')
    fs.mkdirSync(dir, {recursive: true})
    const name = options.label ? `${version}-${date}-${options.label}` : `${version}-${date}`
    let file = path.join(dir, `${name}.json`)
    if (fs.existsSync(file) && !options.quick) file = path.join(dir, `${name}-${new Date().toISOString().slice(11, 16).replace(':', '')}.json`)
    if (options.quick) file = path.join(dir, `${name}-quick.json`)
    fs.writeFileSync(file, JSON.stringify(report, null, 2))
    printReport(report)
    console.log(`Wrote ${file}`)
    const invalid = Object.values(variantsOut).flat().filter((r) => r.problems.length)
    if (invalid.length) {
      console.error(`FAIL: ${invalid.length} run(s) were not trustworthy (see INVALID above)`)
      exitCode = 1
    }
  } catch (error) {
    console.error(error)
    exitCode = 1
  } finally {
    clearTimeout(watchdog)
    require('../main/app-audio').stopAll()
    require('../main/media').stopAll()
    network?.close()
    diagnostics.stop()
    scratch.release() // unless --keep
  }
  app.exit(exitCode)
})
