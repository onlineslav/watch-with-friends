const test = require('node:test')
const assert = require('node:assert/strict')
const {EventEmitter} = require('node:events')
const {describeGone, watchApp, watchPower, watchWindow, WINDOW_EVENTS, POWER_EVENTS} = require('../main/context')
const {sourceFacts, summarizeProbe, planSession, transcodeReasons} = require('../main/plan')
const {readMachine} = require('../main/machine')
const {formatEvent} = require('../shared/log')
const {createLiveSender, FAST_PING_EVERY_MS, PING_EVERY_MS, PONG_WITHIN_MS, EDGE_FRESH_MS} = require('../main/live')
const {createClock, createFakeWebSocket, settle} = require('../scripts/fakes')

const recorder = () => {
  const lines = []
  return {lines, record: (scope, event, data = {}, level = 'info') => lines.push({scope, event, data, level})}
}

// ---------- crashes, window state, power ----------

test('a dead renderer, GPU or helper process is logged with its reason, as an error unless it exited on purpose', () => {
  const app = new EventEmitter()
  const r = recorder()
  watchApp({app, record: r.record})
  app.emit('render-process-gone', {}, {}, {reason: 'crashed', exitCode: -1073741819})
  app.emit('child-process-gone', {}, {type: 'GPU', reason: 'launch-failed', exitCode: 18, name: 'GPU Process'})
  app.emit('child-process-gone', {}, {type: 'Utility', reason: 'clean-exit', exitCode: 0, serviceName: 'audio.mojom.AudioService'})
  app.emit('child-process-gone', {}, undefined) // a malformed event must not throw
  assert.deepEqual(r.lines.map((l) => [l.scope, l.event, l.level, l.data.reason]), [
    ['crash', 'render-process-gone', 'error', 'crashed'],
    ['crash', 'child-process-gone', 'error', 'launch-failed'],
    ['crash', 'child-process-gone', 'info', 'clean-exit'],
    ['crash', 'child-process-gone', 'error', 'unknown'],
  ])
  assert.deepEqual(r.lines[0].data.exitCode, -1073741819)
  assert.equal(r.lines[1].data.type, 'GPU')
  assert.equal(r.lines[2].data.service, 'audio.mojom.AudioService')
  // Through the log's own formatter: absent values are left out, and the line is small.
  const line = formatEvent({at: 1, mono: 1, level: r.lines[1].level, scope: 'crash', event: 'child-process-gone', data: r.lines[1].data})
  assert.ok(!line.includes('undefined') && line.length < 300, line)
})

test('window state, unresponsive and responsive each write one small line', () => {
  const win = new EventEmitter()
  const r = recorder()
  watchWindow({win, record: r.record})
  for (const [event] of WINDOW_EVENTS) win.emit(event)
  win.emit('unresponsive')
  win.emit('responsive')
  assert.deepEqual(r.lines.slice(0, WINDOW_EVENTS.length).map((l) => l.data.s), WINDOW_EVENTS.map(([, state]) => state))
  assert.ok(r.lines.slice(0, WINDOW_EVENTS.length).every((l) => l.scope === 'window' && l.event === 'state'))
  assert.deepEqual(r.lines.slice(-2).map((l) => [l.scope, l.event, l.level]), [['crash', 'unresponsive', 'warn'], ['crash', 'responsive', 'info']])
  assert.ok(WINDOW_EVENTS.some(([event]) => event === 'minimize') && WINDOW_EVENTS.some(([event]) => event === 'hide') && WINDOW_EVENTS.some(([event]) => event === 'focus'))
})

test('sleep and wake are logged, and the line before sleep is flushed to disk', () => {
  const powerMonitor = new EventEmitter()
  const r = recorder()
  let flushed = 0
  watchPower({powerMonitor, record: r.record, flush: () => flushed++})
  for (const [event] of POWER_EVENTS) powerMonitor.emit(event)
  assert.deepEqual(r.lines.map((l) => l.data.s), POWER_EVENTS.map(([, state]) => state))
  assert.ok(r.lines.every((l) => l.scope === 'power' && l.event === 'state'))
  assert.equal(flushed, 2, 'suspend and shutdown only')
  assert.ok(POWER_EVENTS.some(([event]) => event === 'suspend') && POWER_EVENTS.some(([event]) => event === 'resume'))
})

test('describeGone survives anything Electron might hand over', () => {
  for (const odd of [null, undefined, 5, 'x', {}, {reason: 7}]) assert.equal(describeGone(odd).data.reason, 'unknown')
  assert.equal(describeGone({reason: 'x'.repeat(500)}).data.reason.length, 80)
})

// ---------- source facts ----------

const probe = {
  format: {duration: '5400.5', format_name: 'matroska,webm', tags: {title: 'Movie'}},
  streams: [
    {index: 0, codec_type: 'video', codec_name: 'mjpeg', disposition: {attached_pic: 1}},
    {index: 1, codec_type: 'video', codec_name: 'hevc', pix_fmt: 'yuv420p10le', width: 3840, height: 2160, color_transfer: 'smpte2084', avg_frame_rate: '24000/1001'},
    {index: 2, codec_type: 'audio', codec_name: 'dts', channels: 6, tags: {language: 'eng'}, disposition: {default: 1}},
    {index: 4, codec_type: 'subtitle', codec_name: 'ass', tags: {language: 'eng'}},
    {index: 5, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle', tags: {language: 'eng'}},
  ],
}
const allSupported = {h264: true, hevc: true, av1: true, vp9: true, flac: true}
const eightBit = summarizeProbe({...probe, streams: probe.streams.map((s) => (s.index === 1 ? {...s, pix_fmt: 'yuv420p', color_transfer: undefined} : s))})

test('the probe now carries the container, the frame rate and each audio stream\'s codec', () => {
  const media = summarizeProbe(probe)
  assert.equal(media.container, 'matroska,webm')
  assert.equal(media.video.fps, 23.976)
  assert.deepEqual(media.audioInfo, [{index: 2, codec: 'dts', channels: 6}])
  assert.deepEqual(media.audio.map(({index, label, isDefault}) => ({index, label, isDefault})), [{index: 2, label: 'ENG · dts 6ch', isDefault: true}], 'the room state is still built from the same shape')
  assert.equal(media.audio[0].language, 'eng', 'plus the facts the language settings choose from')
  const noRate = summarizeProbe({format: {}, streams: [{index: 0, codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', avg_frame_rate: '0/0', r_frame_rate: '25/1'}]})
  assert.equal(noRate.video.fps, 25)
  assert.equal(noRate.container, null)
  assert.equal(summarizeProbe({streams: [{index: 0, codec_type: 'video', codec_name: 'h264', avg_frame_rate: '0/0'}]}).video.fps, null)
})

test('a 10-bit HDR film is logged as a transcode, with why, the encoder and the tone map', () => {
  const media = summarizeProbe(probe)
  const plan = planSession({media, filePath: 'movie.mkv', audioIndex: 2, support: allSupported, encoder: 'h264_nvenc', canTonemap: true})
  const facts = sourceFacts(media, plan, {audioIndex: 2, support: allSupported, canTonemap: true})
  assert.deepEqual(facts, {c: 'matroska,webm', dur: 5401, mode: 'transcode', v: {codec: 'hevc', pix: 'yuv420p10le', w: 3840, h: 2160, fps: 23.976, hdr: 1},
    why: ['pixel-format'], enc: 'h264_nvenc', tm: 1, a: {codec: 'dts', ch: 6}, af: 'flac'})
  assert.ok(JSON.stringify(facts).length < 400)
})

test('an 8-bit file passes through with no encoder; the reasons for a transcode are named', () => {
  const plan = planSession({media: eightBit, filePath: 'movie.mkv', audioIndex: 2, support: allSupported})
  const facts = sourceFacts(eightBit, plan, {audioIndex: 2, support: allSupported})
  assert.equal(facts.mode, 'copy')
  assert.equal(facts.enc, undefined)
  assert.equal(facts.why, undefined)
  assert.equal(facts.v.hdr, 0)
  assert.deepEqual(transcodeReasons(eightBit, {support: allSupported}), [])
  assert.deepEqual(transcodeReasons(eightBit, {support: allSupported, forceTranscode: true}), ['retry'])
  assert.deepEqual(transcodeReasons(eightBit, {support: {...allSupported, hevc: false}}), ['no-decoder'])
  const subtitle = eightBit.subtitles.find((s) => s.image)
  assert.deepEqual(transcodeReasons(eightBit, {support: allSupported, subtitle}), ['burn-in'])
  const mpeg = {video: {codec: 'mpeg2video', pixFmt: 'yuv420p'}}
  assert.deepEqual(transcodeReasons(mpeg, {support: allSupported}), ['codec'])
  const retried = planSession({media: eightBit, filePath: 'm.mkv', audioIndex: 2, support: allSupported, forceTranscode: true, encoder: 'libx264'})
  const withSub = planSession({media: eightBit, filePath: 'm.mkv', audioIndex: 2, subtitleId: subtitle.id, support: allSupported, encoder: 'h264_qsv'})
  assert.deepEqual(sourceFacts(eightBit, withSub, {audioIndex: 2, subtitle, support: allSupported}).sub, 'image')
  assert.equal(sourceFacts(eightBit, retried, {audioIndex: 2, forceTranscode: true, support: allSupported}).enc, 'libx264')
})

test('a song has no video facts and says so', () => {
  const song = summarizeProbe({format: {duration: '215.2', format_name: 'flac'}, streams: [{index: 0, codec_type: 'audio', codec_name: 'flac', channels: 2}]})
  const plan = planSession({media: song, filePath: 'song.flac', audioIndex: 0, support: allSupported})
  assert.deepEqual(sourceFacts(song, plan, {audioIndex: 0, support: allSupported}), {c: 'flac', dur: 215, mode: 'audio', a: {codec: 'flac', ch: 2}, af: 'flac'})
})

// ---------- the edge round trip ----------

test('the machine sample carries the edge round trip when there is one, and leaves it out otherwise', () => {
  const base = {getMetrics: () => [], systemMemory: () => ({free: 1024}), power: {}}
  assert.equal(readMachine({...base, edgeRtt: () => 42.5}).er, 42.5)
  assert.equal('er' in readMachine({...base, edgeRtt: () => null}), false)
  assert.equal('er' in readMachine({...base, edgeRtt: () => NaN}), false)
  assert.equal('er' in readMachine({...base, edgeRtt: () => { throw new Error('socket gone') }}), false)
  assert.equal('er' in readMachine(base), false)
})

function harness(options = {}) {
  const WebSocketImpl = createFakeWebSocket()
  const clock = createClock()
  const records = []
  const sender = createLiveSender({
    endpoint: async () => 'https://relay.test/telemetry',
    WebSocketImpl, setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now, random: () => 0.5,
    record: (scope, event, data) => records.push({scope, event, data}), ...options,
  })
  const connect = async (watching = false) => {
    await settle()
    const socket = WebSocketImpl.instances.at(-1)
    socket.open()
    socket.receive(JSON.stringify({watching}))
    await settle()
    return socket
  }
  return {WebSocketImpl, clock, sender, records, connect}
}

test('in a room the socket is pinged every 2 seconds, nobody watching, and the round trip is the edge RTT', async () => {
  const h = harness()
  h.sender.configure({enabled: true, from: 'aya#abcd-1234'})
  h.sender.setFast(true)
  const socket = await h.connect(false) // nobody is watching
  assert.equal(h.sender.edgeRtt(), null, 'no ping answered yet')
  const rtts = [31, 33, 180, 29]
  let carry = 0
  for (const rtt of rtts) {
    await h.clock.advance(FAST_PING_EVERY_MS - carry) // lands on the next ping
    assert.equal(socket.texts.at(-1), 'ping')
    await h.clock.advance(rtt)
    socket.receive('pong')
    assert.equal(h.sender.edgeRtt(), rtt, `the reading is the time between ping and pong (${rtt})`)
    carry = rtt
  }
  assert.equal(socket.texts.filter((text) => text === 'ping').length, rtts.length)
  assert.equal(socket.frames.length, 0, 'and nothing but pings went out')
  assert.equal(socket.closedWith, null)
})

test('outside a room it stays at one ping every 15 seconds, and entering one speeds it up at once', async () => {
  const h = harness()
  h.sender.configure({enabled: true, from: 'aya#abcd-1234'})
  const socket = await h.connect()
  socket.onSend = (data) => { if (data === 'ping') queueMicrotask(() => socket.receive('pong')) }
  await h.clock.advance(PING_EVERY_MS * 4)
  assert.equal(socket.texts.length, 4)
  h.sender.setFast(true)
  await h.clock.advance(FAST_PING_EVERY_MS * 5 + 1)
  assert.equal(socket.texts.length, 9)
  h.sender.setFast(false)
  await h.clock.advance(FAST_PING_EVERY_MS) // the tick already in flight
  const before = socket.texts.length
  await h.clock.advance(PING_EVERY_MS * 2)
  assert.ok(socket.texts.length - before <= 2, 'back to the slow rate')
})

test('a reading too old to belong to the sample is not reported, and one ping is outstanding at a time', async () => {
  const h = harness()
  h.sender.configure({enabled: true, from: 'aya#abcd-1234'})
  h.sender.setFast(true)
  const socket = await h.connect()
  await h.clock.advance(FAST_PING_EVERY_MS)
  await h.clock.advance(20)
  socket.receive('pong')
  assert.equal(h.sender.edgeRtt(), 20)
  // The Worker goes quiet: no new pings while one is unanswered, and the old reading ages out.
  await h.clock.advance(EDGE_FRESH_MS - 20 - 20)
  assert.equal(h.sender.edgeRtt(), 20, 'still fresh a moment before the limit')
  await h.clock.advance(60)
  assert.equal(socket.texts.length, 2, 'the second ping waits for an answer')
  assert.equal(socket.closedWith, null, 'and the socket is not dead yet')
  assert.equal(h.sender.edgeRtt(), null, 'but the reading no longer belongs to any sample')
})

test('an unanswered ping still declares the socket dead 10 seconds after it, however fast the pings', async () => {
  const h = harness()
  h.sender.configure({enabled: true, from: 'aya#abcd-1234'})
  h.sender.setFast(true)
  const socket = await h.connect()
  await h.clock.advance(FAST_PING_EVERY_MS)
  assert.equal(socket.closedWith, null)
  await h.clock.advance(PONG_WITHIN_MS - 1)
  assert.equal(socket.closedWith, null)
  await h.clock.advance(2)
  assert.ok(socket.closedWith)
  assert.equal(h.sender.edgeRtt(), null, 'no reading outlives its socket')
  assert.ok(h.records.some((r) => r.event === 'heartbeat-lost'))
})

test('a pong nobody asked for, and a pong from a socket that was replaced, add nothing', async () => {
  const h = harness()
  h.sender.configure({enabled: true, from: 'aya#abcd-1234'})
  h.sender.setFast(true)
  const socket = await h.connect()
  socket.receive('pong') // nobody asked
  assert.equal(h.sender.edgeRtt(), null)
  await h.clock.advance(FAST_PING_EVERY_MS)
  await h.clock.advance(60_000 - 1) // the connection was declared dead long before this
  socket.receive('pong')
  assert.equal(h.sender.edgeRtt(), null)
})

test('pings are counted in the wire bytes the rate check reads', async () => {
  const h = harness()
  h.sender.configure({enabled: true, from: 'aya#abcd-1234'})
  h.sender.setFast(true)
  const socket = await h.connect()
  socket.onSend = (data) => { if (data === 'ping') queueMicrotask(() => socket.receive('pong')) }
  await h.clock.advance(60_000)
  const pings = socket.texts.length
  assert.ok(pings >= 29 && pings <= 31, `${pings} pings in a minute`)
  assert.equal(h.sender.status().wireBytes, pings * 10)
  assert.ok(h.sender.status().wireBytes * 8 / 60 < 50, 'a few tens of bits per second')
})
