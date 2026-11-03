// `npm run bench`: how far apart a viewer sees a flash and hears its beep, and how the audio and video
// arrive, measured the same way every time so a change to the media path is a number, not a feeling.
//
//   film   a host plays a generated clip (moving picture, white flash patch, 1kHz beep at the same
//          instant, quiet stereo bed tone) and a viewer receives it over real WebRTC
//   share  a sharer shares a "window" that draws the same schedule, its sound coming from the clip's own PCM
//          through the real app-audio path (main/app-audio.js -> renderer/app-audio.mjs -> the share
//          stream) from a stand-in helper; only the OS capture call is skipped, because it makes sound
//
// Nothing is audible: every window is muted and the output gain feeds only a tap that reaches the
// destination through a gain of zero. Real renderer code over local discovery, like check-network.js.
//
//   npm run bench                       both variants, 3 runs each (about 10 minutes)
//   npm run bench -- --variant=film     or share
//   npm run bench -- --runs=1 --quick   a short clip, for working on the bench itself (not a result)
//   npm run bench -- --device-latency-ms=40   see "Device latency" below
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
  const hit = process.argv.find((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`))
  return hit == null ? fallback : hit.includes('=') ? hit.split('=')[1] : true
}
const options = {
  variant: String(flag('variant', 'all')),
  runs: Number(flag('runs', 3)),
  quick: Boolean(flag('quick', false)) || Boolean(flag('count', 0)),
  deviceLatencyMs: Number(flag('device-latency-ms', 0)),
  seed: Number(flag('seed', 1)),
  count: Number(flag('count', 0)), // fewer events than the full 28, for working on the bench (not a result)
  shareAudio: String(flag('share-audio', 'app')), // 'none' shares the picture alone: how the video behaves without the audio beside it
  keep: Boolean(flag('keep', false)),
  raw: Boolean(flag('raw', false)), // also write every frame and beep to a .raw.json beside the report
}
const variants = options.variant === 'all' ? ['film', 'share'] : [options.variant]
assert.ok(variants.every((v) => ['film', 'share'].includes(v)), '--variant is film, share or all')

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'synced-bench-'))
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
  let source = fs.readFileSync(path.join(root, 'renderer/app.js'), 'utf8')
  // A share bench has no window to follow: skip the Windows whole-app path (native/win-app-windows) so
  // startShare takes the plain route, which the stubbed getDisplayMedia and the app-audio path plug into.
  const windowsShare = "const APP_WINDOWS = window.api.platform === 'win32'"
  assert.ok(source.includes(windowsShare), 'app.js still declares APP_WINDOWS the way bench.js expects')
  source = source.replace(windowsShare, 'const APP_WINDOWS = false')
  source += `
    window.__test = {
      get session() { return session }, get identity() { return identity },
      friendNetwork, enterRoom, leaveRoom, hostFile, startShare, stopShare, shareSettings, tileViews, control, flushLog, selfId, getState: hostState, errors: [],
    };
    window.addEventListener('error', (e) => __test.errors.push(e.message));
    window.addEventListener('unhandledrejection', (e) => __test.errors.push(String(e.reason)));
    (${benchHooks.toString()})();
  `
  await esbuild.build({stdin: {contents: source, resolveDir: path.join(root, 'renderer')}, bundle: true, format: 'iife', target: 'chrome130', outfile: path.join(temporary, 'bundle.js'), plugins: [{
    name: 'local-discovery', setup(build) {
      build.onResolve({filter: /^trystero$/}, () => ({path: 'trystero', namespace: 'local'}))
      build.onLoad({filter: /.*/, namespace: 'local'}, () => ({resolveDir: root, contents: `
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
  fs.copyFileSync(path.join(__dirname, 'bench-tap.js'), path.join(temporary, 'bench-tap.js'))

  const schedule = lib.makeSchedule({seed: options.seed, ...(options.quick ? {count: 6, first: 3, minGap: 2, maxGap: 2.6} : {}), ...(options.count ? {count: options.count} : {})})
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
  await run(win, `document.getElementById('handle').value=${JSON.stringify(name)}; document.getElementById('welcome-name').value=${JSON.stringify(name)}; document.getElementById('welcome-form').dispatchEvent(new Event('submit', {cancelable:true}));`)
  await until(win, '__test.friendNetwork.identity && !document.getElementById("home").hidden', 30000, `${name} home`)
  // Shown, far off-screen: a window that was never shown does not present frames, and the rVFC rate
  // is one of the things this bench asserts.
  win.setBounds({x: -20000, y: -20000, width: 1280, height: 720})
  win.showInactive()
  return win
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
      callbacks: window.length, rvfcPerSecond: lib.round((window.length - 1) / Math.max(1, spanS), 2), spanS: lib.round(spanS, 1), presentedFramesNotCalledBack: skipped, steadyOnly: Boolean(long),
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
  return {samples: samples.length, avSkewMedianMs: lib.round(lib.median(col('av')), 1), avSkewP95AbsMs: lib.round(lib.percentile(col('av').map(Math.abs), 0.95), 1), audioJitterBufferMs: lib.round(lib.median(col('aJb')), 1), videoJitterBufferMs: lib.round(lib.median(col('vJb')), 1), reportedOutMs: lib.round(lib.median(col('out')), 1), reportedBaseMs: lib.round(lib.median(col('base')), 1)}
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
  const rate = viewer.video.rvfcPerSecond
  if (!(rate >= 0.9 * fps)) problems.push(`viewer rVFC rate ${rate}/s is under 0.9x the clip's ${fps}fps: the picture times are not trustworthy`)
  if (!quick && viewer.matchedSteady < 20) problems.push(`only ${viewer.matchedSteady} of ${viewer.expectedSteady} steady-state events were paired (need 20)`)
  if (!extra?.noAudio && !(viewer.levelRms >= 0.1)) problems.push(`the received beep's RMS ${viewer.levelRms} is under 0.1: the audio arrived silent or not at all`)
  if (!extra?.noAudio && viewer.matched < 3) problems.push('fewer than 3 flash/beep pairs: no offset can be reported')
  if (extra?.helper && extra.helper.p95LateMs > 5) problems.push(`the fake helper delivered audio ${extra.helper.p95LateMs}ms late at p95: the share's ground truth is off`)
  if (extra?.window && extra.window.p95LateMs > 5) problems.push(`the shared window painted ${extra.window.p95LateMs}ms late at p95: the share's ground truth is off`)
  return problems
}

// ---------- the two variants ----------

async function runFilm(env, runIndex) {
  const {host, viewer} = await connectedPair(`film${runIndex}`, 'filmhost', 'filmviewer')
  try {
    const sink = {sampleRate: null}
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
    await Promise.all([host, viewer].map((win) => run(win, '__test.flushLog()')))
    const viewerRead = readSide(viewerData, env.schedule, {deviceMs: options.deviceLatencyMs})
    const hostRead = readSide(hostData, env.schedule, {deviceMs: options.deviceLatencyMs})
    const transport = transportOf(from, to, host, env.schedule)
    const errors = [...await run(host, '__test.errors'), ...await run(viewer, '__test.errors')]
    return {variant: 'film', viewer: viewerRead, host: {offset: hostRead.offset, matchedSteady: hostRead.matchedSteady, video: hostRead.video, levelRms: hostRead.levelRms, clock: hostRead.clock, stereo: hostRead.stereo, raw: hostRead.raw}, transport, telemetry: telemetryOf(selfId), elapsedS: lib.round((Date.now() - startedAt) / 1000, 1), pageErrors: errors, problems: validity({viewer: viewerRead, transport, schedule: env.schedule, variant: 'film', quick: options.quick})}
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
    const windowReport = await run(sharer, '__bench.windowReport()')
    await run(sharer, '__bench.stopWindow()')
    const helper = (() => { try { return JSON.parse(fs.readFileSync(statsFile, 'utf8')) } catch { return null } })()
    const viewerRead = readSide(viewerData, env.schedule, {deviceMs: options.deviceLatencyMs, epoch})
    const transport = transportOf(from, to, sharer, env.schedule)
    const errors = [...await run(sharer, '__test.errors'), ...await run(viewer, '__test.errors')]
    return {
      variant: 'share', viewer: viewerRead, transport, telemetry: telemetryOf(selfId), pageErrors: errors,
      groundTruth: {helperDelivery: helper, windowPaint: windowReport, clockNote: 'flash painted and PCM delivered at the same schedule instants on the wall clock; window capture latency and the shared app\'s own output buffer are not in this number'},
      problems: validity({viewer: viewerRead, transport, schedule: env.schedule, variant: 'share', quick: options.quick, extra: {helper, window: windowReport, noAudio}}),
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

function summarizeVariant(allRuns) {
  const runs = allRuns.filter((r) => !r.failed)
  const col = (pick) => runs.map(pick).filter(Number.isFinite)
  return {
    runs: runs.length, failedRuns: allRuns.length - runs.length,
    steadyMedianMs: {perRun: col((r) => r.viewer.offset.steady.medianMs), median: lib.round(lib.median(col((r) => r.viewer.offset.steady.medianMs)), 1), spread: spread(col((r) => r.viewer.offset.steady.medianMs))},
    steadyMedianAbsMs: lib.round(lib.median(col((r) => r.viewer.offset.steady.medianAbsMs)), 1),
    steadyP95AbsMs: {perRun: col((r) => r.viewer.offset.steady.p95AbsMs), median: lib.round(lib.median(col((r) => r.viewer.offset.steady.p95AbsMs)), 1)},
    steadyWorstMs: {perRun: col((r) => r.viewer.offset.steady.worstMs), worst: runs.length ? runs.flatMap((r) => (Number.isFinite(r.viewer.offset.steady.worstMs) ? [r.viewer.offset.steady.worstMs] : [])).reduce((w, v) => (Math.abs(v) > Math.abs(w) ? v : w), 0) : null},
  }
}

function printReport(report) {
  const f = (v, unit = '') => (v == null ? 'n/a' : `${v}${unit}`)
  console.log(`\n=== Benchmark ${report.version} ${report.date}${report.options.quick ? ' (quick: not a result)' : ''} ===`)
  for (const [variant, runs] of Object.entries(report.variants)) {
    const s = report.summary[variant]
    console.log(`\n--- ${variant}: ${runs.length} run(s) ---`)
    console.log(`  A/V offset at the viewer, beep heard minus flash shown (positive = sound late), events after ${lib.STEADY}s of clip:`)
    console.log(`    median ${f(s.steadyMedianMs.median, 'ms')}  |median| ${f(s.steadyMedianAbsMs, 'ms')}  p95 |offset| ${f(s.steadyP95AbsMs.median, 'ms')}  worst ${f(s.steadyWorstMs.worst, 'ms')}   spread of the run medians ${f(s.steadyMedianMs.spread, 'ms')} (${s.steadyMedianMs.perRun.join(', ')})`)
    runs.forEach((r, i) => {
      if (r.failed) return console.log(`  run ${i + 1}: FAILED ${r.failed}`)
      const o = r.viewer.offset.steady
      const t = r.transport
      console.log(`  run ${i + 1}: n=${o.n}/${r.viewer.expectedSteady} median ${f(o.medianMs, 'ms')} p95 ${f(o.p95AbsMs, 'ms')} worst ${f(o.worstMs, 'ms')} sd ${f(o.stddevMs, 'ms')} drift ${f(r.viewer.offset.driftMsPerS, 'ms/s')}` +
        (r.host ? `   | host's own playback: median ${f(r.host.offset.steady.medianMs, 'ms')} (n=${r.host.offset.steady.n})` : '') +
        `   | telemetry s.av median ${f(r.telemetry.avSkewMedianMs, 'ms')} (transport skew, not subtracted)`)
      const c = t.audio.concealment
      console.log(`         audio: ${f(t.audio.codecChannels)} ch (receive fmtp '${f(t.audio.fmtp)}', send fmtp '${f(t.audio.sentFmtp)}'; stereo separation at the viewer's tap ${f(r.viewer.stereo.separation)}${r.host ? `, at the host's ${f(r.host.stereo.separation)}` : ''}; 0.5 is two independent channels, 0 is mono), received ${f(t.audio.receivedKbps, ' kbps')} of ${f(t.audio.configuredMaxKbps, ' kbps')} cap (sent ${f(t.audio.sentKbps, ' kbps')}), concealed (conc-sil) ${f(c?.pct, '%')} over ${f(t.windowS, 's')} (${f(c?.netSamples)} of ${f(c?.totalSamples)} samples), lost ${f(t.audio.packetsLost)}, beep RMS ${f(lib.round(r.viewer.levelRms, 3))}`)
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
  const watchdog = setTimeout(() => { console.error('Benchmark timed out'); app.exit(1) }, 40 * 60 * 1000)
  let exitCode = 0
  try {
    const env = await fixtures()
    diagnostics.start({dir: path.join(temporary, 'logs'), info: {version: app.getVersion()}})
    require('../main/main').registerIpc()
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
          variantsOut[variant].push(await (variant === 'film' ? runFilm(env, i) : runShare(env, i)))
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
      clip: {fps: env.schedule.fps, events: env.schedule.events.length, durationS: env.schedule.duration, seed: options.seed, flashFrames: lib.FLASH_FRAMES, beepS: lib.BEEP_SECONDS},
      measurement: {
        gated: 'viewer.offset.steady: beep heard (AudioWorklet frame after the output gain, mapped with getOutputTimestamp) minus flash shown (rVFC expectedDisplayTime of the first white frame); host and telemetry s.av are beside it, never subtracted',
        steadyFromS: lib.STEADY, concealment: 'conc - sil over the window that starts 10s after the picture does',
      },
      variants: variantsOut,
      summary: Object.fromEntries(Object.entries(variantsOut).map(([k, runs]) => [k, summarizeVariant(runs)])),
    }
    const dir = path.join(root, 'work', 'bench')
    fs.mkdirSync(dir, {recursive: true})
    let file = path.join(dir, `${version}-${date}.json`)
    if (fs.existsSync(file) && !options.quick) file = path.join(dir, `${version}-${date}-${new Date().toISOString().slice(11, 16).replace(':', '')}.json`)
    if (options.quick) file = path.join(dir, `${version}-${date}-quick.json`)
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
    diagnostics.stop()
    if (!options.keep) {
      // The big files first: a window's profile can stay locked a moment after it closes.
      for (const name of ['bench-clip.mkv', 'bench-clip.f32']) try { fs.rmSync(path.join(temporary, name), {force: true}) } catch {}
      try { fs.rmSync(temporary, {recursive: true, force: true, maxRetries: 3}) } catch {}
    }
  }
  app.exit(exitCode)
})
