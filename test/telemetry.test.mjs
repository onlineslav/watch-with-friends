import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_BUFFER_MS,
  MIN_BUFFER_MS,
  adaptBuffer,
  adaptShareBuffer,
  SHARE_BUFFER_START,
  SHARE_BUFFER_STEPS,
  bitrateDelta,
  describeLink,
  describePeer,
  inboundDelta,
  isSteady,
  isTroubled,
  nextSteady,
  readStats,
  readDetail,
  detailDelta,
  soundLateMs,
  audioPathMs,
  videoTargetMs,
  viewerDelayMs,
  linkFacts,
  omitNull,
  parseOpusFmtp,
} from '../renderer/telemetry.mjs'
import {captionHtml} from '../renderer/subtitles.mjs'

test('nextSteady only counts uninterrupted playback', () => {
  let steady = {since: null, epoch: 0}
  steady = nextSteady(steady, {playing: true, time: 10, epoch: 0}, 10, 1000)
  steady = nextSteady(steady, {playing: true, time: 12, epoch: 0}, 12.1, 3000)
  assert.equal(steady.since, 1000)
  assert.ok(isSteady(steady, 5000))
  assert.ok(!isSteady(steady, 4000))
  assert.equal(nextSteady(steady, {playing: true, time: 60, epoch: 0}, 14, 5000).since, 5000, 'seek jump')
  assert.equal(nextSteady(steady, {playing: true, time: 14, epoch: 1}, 14, 5000).since, 5000, 'ffmpeg restarted')
  assert.equal(nextSteady(steady, {playing: false, time: 14, epoch: 0}, 14, 5000).since, null, 'paused')
})

const report = [
  {id: 'p', type: 'candidate-pair', nominated: true, state: 'succeeded', currentRoundTripTime: 0.042, localCandidateId: 'l', remoteCandidateId: 'r'},
  {id: 'l', type: 'local-candidate', candidateType: 'srflx'},
  {id: 'r', type: 'remote-candidate', candidateType: 'relay'},
  {id: 'old', type: 'inbound-rtp', kind: 'video', ssrc: 1, packetsReceived: 900, frameHeight: 720},
  {id: 'in', type: 'inbound-rtp', kind: 'video', ssrc: 2, packetsReceived: 100, packetsLost: 3, framesPerSecond: 24, frameHeight: 1080, jitter: 0.012},
  {id: 'out', type: 'outbound-rtp', kind: 'video', framesPerSecond: 24, frameHeight: 1080, qualityLimitationReason: 'cpu'},
]

test('readStats picks the live streams and the active connection', () => {
  const stats = readStats(report)
  assert.equal(stats.rttMs, 42)
  assert.equal(stats.relayed, true)
  assert.equal(stats.inbound.ssrc, 2)
  assert.equal(stats.inbound.jitterMs, 12)
  assert.deepEqual(stats.outbound, {fps: 24, height: 1080, limit: 'cpu'})
})

test('audio-only telemetry uses audio packets even after a video stream was replaced', () => {
  const stats = readStats([...report, {id: 'audio', type: 'inbound-rtp', kind: 'audio', ssrc: 3, packetsReceived: 200, packetsLost: 5, jitter: 0.02}], {audioOnly: true})
  assert.equal(stats.inbound.ssrc, 3)
  assert.equal(stats.inbound.packetsLost, 5)
  assert.equal(stats.inbound.jitterMs, 20)
  assert.equal(stats.inbound.height, 0)
  assert.equal(stats.outbound, null)
})

test('readStats captures audio RTP byte counters alongside video, not only in audioOnly mode', () => {
  // A screen share (or any video with audio) sends/receives both at once; audioOnly only ever
  // selects one or the other for `inbound`/`outbound`, so actual audio throughput needs its own,
  // always-populated fields regardless of that mode.
  const withAudio = [
    ...report.map((s) => (s.id === 'in' ? {...s, timestamp: 1000, bytesReceived: 250000} : s.id === 'out' ? {...s, ssrc: 3, timestamp: 1000, bytesSent: 500000} : s)),
    {id: 'audio-in', type: 'inbound-rtp', kind: 'audio', ssrc: 4, timestamp: 1000, bytesReceived: 32000},
    {id: 'audio-out', type: 'outbound-rtp', kind: 'audio', ssrc: 5, timestamp: 1000, bytesSent: 64000},
  ]
  const stats = readStats(withAudio)
  assert.deepEqual(stats.audioInboundRtp, {id: 'audio-in', ssrc: 4, timestamp: 1000, bytes: 32000})
  assert.deepEqual(stats.audioOutboundRtp, {id: 'audio-out', ssrc: 5, timestamp: 1000, bytes: 64000})
  // Unaffected: the existing video-mode fields still read the video streams, not audio.
  assert.deepEqual(stats.inboundRtp, {id: 'in', ssrc: 2, timestamp: 1000, bytes: 250000})
  assert.deepEqual(stats.outboundRtp, {id: 'out', ssrc: 3, timestamp: 1000, bytes: 500000})
  assert.equal(readStats(report).audioInboundRtp, null, 'no audio stream present')
})

test('readStats retains separate local byte samples without adding counters to room telemetry', () => {
  const stats = readStats(report.map(s => s.id === 'in' ? {...s, timestamp: 1000, bytesReceived: 250000} : s.id === 'out' ? {...s, ssrc: 3, timestamp: 1000, bytesSent: 500000} : s))
  assert.deepEqual(stats.inboundRtp, {id: 'in', ssrc: 2, timestamp: 1000, bytes: 250000})
  assert.deepEqual(stats.outboundRtp, {id: 'out', ssrc: 3, timestamp: 1000, bytes: 500000})
  assert.deepEqual(stats.outbound, {fps: 24, height: 1080, limit: 'cpu'})
  assert.equal(readStats(report).inboundRtp, null, 'missing counters are not zero throughput')
})

test('bitrateDelta measures the actual sample interval and reports idle traffic as zero', () => {
  const first = {id: 'video', ssrc: 2, timestamp: 1000, bytes: 100000}
  assert.deepEqual(bitrateDelta(first, {...first, timestamp: 3000, bytes: 600000}), {bitrateBps: 2000000, intervalMs: 2000})
  assert.deepEqual(bitrateDelta(first, {...first, timestamp: 5000, bytes: 600000}), {bitrateBps: 1000000, intervalMs: 4000})
  assert.deepEqual(bitrateDelta(first, {...first, timestamp: 3000}), {bitrateBps: 0, intervalMs: 2000})
})

test('bitrateDelta cannot bridge new streams, reset counters or invalid clock samples', () => {
  const first = {id: 'video', ssrc: 2, timestamp: 1000, bytes: 100000}
  assert.equal(bitrateDelta(null, first), null)
  assert.equal(bitrateDelta(first, null), null)
  for (const change of [{id: 'new'}, {ssrc: 3}, {bytes: 0}, {timestamp: 1000}, {timestamp: 999}, {timestamp: NaN}, {bytes: Infinity}]) {
    assert.equal(bitrateDelta(first, {...first, timestamp: 3000, bytes: 200000, ...change}), null)
  }
})

test('inboundDelta measures loss and ignores replaced streams', () => {
  const a = {ssrc: 2, packetsReceived: 100, packetsLost: 0, freezeCount: 0, framesDropped: 0}
  const b = {ssrc: 2, packetsReceived: 190, packetsLost: 10, freezeCount: 1, framesDropped: 2}
  assert.deepEqual(inboundDelta(a, b), {lossPct: 10, freezes: 1, droppedFrames: 2, delayMs: null})
  const delay = inboundDelta({...a, jitterBufferDelay: 10, jitterBufferEmittedCount: 1000}, {...b, jitterBufferDelay: 22, jitterBufferEmittedCount: 1048})
  assert.equal(delay.delayMs, 250)
  assert.equal(inboundDelta(a, {...b, ssrc: 3}), null)
  assert.ok(isTroubled(inboundDelta(a, b), 5))
  assert.ok(!isTroubled({lossPct: 1, freezes: 0}, 10))
})

test('adaptBuffer grows fast, caps, and shrinks only after a calm stretch', () => {
  let state = {bufferMs: MIN_BUFFER_MS, calmMs: 0}
  for (let i = 0; i < 5; i++) state = adaptBuffer(state, true, 2000)
  assert.equal(state.bufferMs, MAX_BUFFER_MS)
  for (let i = 0; i < 14; i++) state = adaptBuffer(state, false, 2000)
  assert.equal(state.bufferMs, MAX_BUFFER_MS)
  state = adaptBuffer(state, false, 2000)
  assert.equal(state.bufferMs, MAX_BUFFER_MS - 250)
})

test('adaptShareBuffer starts at zero, steps up only when troubled, and shrinks after a calm stretch', () => {
  let state = SHARE_BUFFER_START
  assert.equal(state.bufferMs, 0)
  for (let i = 0; i < 10; i++) state = adaptShareBuffer(state, false, 2000)
  assert.equal(state.bufferMs, 0, 'calm never raises it')
  state = adaptShareBuffer(state, true, 2000)
  assert.equal(state.bufferMs, 100)
  state = adaptShareBuffer(state, true, 2000)
  assert.equal(state.bufferMs, 250)
  state = adaptShareBuffer(state, true, 2000)
  assert.equal(state.bufferMs, SHARE_BUFFER_STEPS.at(-1), 'capped at 250')
  assert.ok(SHARE_BUFFER_STEPS.at(-1) <= MIN_BUFFER_MS)
  for (let i = 0; i < 14; i++) state = adaptShareBuffer(state, false, 2000)
  assert.equal(state.bufferMs, 250, 'not yet calm for long enough')
  state = adaptShareBuffer(state, false, 2000)
  assert.equal(state.bufferMs, 100)
  for (let i = 0; i < 15; i++) state = adaptShareBuffer(state, false, 2000)
  assert.equal(state.bufferMs, 0)
  state = adaptShareBuffer({bufferMs: 100, calmMs: 20000}, true, 2000)
  assert.deepEqual(state, {bufferMs: 250, calmMs: 0}, 'trouble resets the calm timer')
})

test('describeLink explains what is limiting playback from each side', () => {
  const good = describeLink({selfRole: 'viewer', rttMs: 42, sender: {height: 1080, fps: 24, limit: 'none'}, receiver: {height: 1080, fps: 23.9, lossPct: 0, freezes: 0, bufferMs: 250}})
  assert.deepEqual(good, {level: 'good', text: '42 ms · 1080p24', detail: 'Connection looks good.'})

  const busyHost = describeLink({selfRole: 'host', rttMs: 60, sender: {height: 720, fps: 24, limit: 'cpu'}})
  assert.equal(busyHost.level, 'fair')
  assert.match(busyHost.detail, /^Your computer is too busy/)

  const dropping = describeLink({selfRole: 'host', rttMs: 90, receiver: {height: 720, fps: 20, lossPct: 8, freezes: 2, bufferMs: 1000}})
  assert.equal(dropping.level, 'poor')
  assert.match(dropping.detail, /Your friend's connection is dropping video \(8% packet loss\)/)
  assert.match(dropping.detail, /buffering 1\.00 s/)
})

test('describePeer summarizes each person in the room', () => {
  assert.deepEqual(describePeer({self: true}), {level: null, text: '', detail: null}, 'nothing measured yet')

  const viewer = describePeer({rttMs: 35, receiver: {height: 1080, fps: 23.97, lossPct: 3.4, freezes: 0, bufferMs: 250}})
  assert.equal(viewer.text, '35 ms · 1080p24 · 3% loss')
  assert.equal(viewer.level, 'fair')
  assert.match(viewer.detail, /^Their connection is losing a few packets/)

  const me = describePeer({self: true, sender: {height: 720, fps: 30, limit: 'bandwidth'}})
  assert.deepEqual(me, {level: 'fair', text: '720p30', detail: 'Your upload speed is limiting picture quality.'})
})

// ---------- M1.2 measurements ----------

const detailReport = (t, over = {}) => [
  {id: 'pair', type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'l', remoteCandidateId: 'r'},
  {id: 'l', type: 'local-candidate', candidateType: 'relay', protocol: 'udp', relayProtocol: 'tcp'},
  {id: 'r', type: 'remote-candidate', candidateType: 'host', protocol: 'udp'},
  {id: 'a-in', type: 'inbound-rtp', kind: 'audio', ssrc: 10, packetsReceived: 100 * t, packetsLost: 2 * t, jitter: 0.004 * t,
    concealedSamples: 480 * t, silentConcealedSamples: 96 * t, totalSamplesReceived: 96000 * t, insertedSamplesForDeceleration: 10 * t,
    removedSamplesForAcceleration: 20 * t, jitterBufferDelay: 2 * t, jitterBufferEmittedCount: 96000 * t,
    totalAudioEnergy: 0.04 * t, totalSamplesDuration: 2 * t, audioLevel: 0.2, estimatedPlayoutTimestamp: 1_000_000 + t * 2000, ...over.audio},
  {id: 'a-play', type: 'media-playout', kind: 'audio', totalPlayoutDelay: 4 * t, totalSamplesCount: 96000 * t},
  {id: 'codec-h264', type: 'codec', mimeType: 'video/H264'},
  {id: 'v-in', type: 'inbound-rtp', kind: 'video', codecId: 'codec-h264', ssrc: 11, framesDecoded: 48 * t, totalDecodeTime: 0.24 * t, totalFreezesDuration: 0.5 * t,
    totalPausesDuration: 0, pliCount: t, nackCount: 5 * t, firCount: 0, jitterBufferDelay: 12 * t, jitterBufferEmittedCount: 48 * t,
    estimatedPlayoutTimestamp: 1_000_120 + t * 2000, decoderImplementation: 'ExternalDecoder', powerEfficientDecoder: true, ...over.video},
  {id: 'v-out', type: 'outbound-rtp', kind: 'video', codecId: 'codec-h264', ssrc: 12, framesPerSecond: 24, framesEncoded: 48 * t, totalEncodeTime: 0.48 * t,
    pliCount: t, nackCount: 2 * t, firCount: 0, encoderImplementation: 'libx264', powerEfficientEncoder: false,
    qualityLimitationDurations: {none: 1, cpu: 0.5 * t, bandwidth: 0.25 * t, other: 0}},
]

test('detailDelta reports audio health, A/V sync inputs, decoder and encoder cost between two readings', () => {
  const d = detailDelta(readDetail(detailReport(1)), readDetail(detailReport(2)))
  assert.deepEqual(d.a, {lost: 2, rx: 100, jit: 8, conc: 480, sil: 96, smp: 96000, ins: 10, rem: 20, jb: 0.0, lvl: 0.141})
  assert.equal(d.a.jb, 0, 'rounded: 2s over 96000 samples is 0.02 ms')
  assert.equal(d.s.aEpt, 1_004_000)
  assert.equal(d.s.vEpt, 1_004_120)
  assert.equal(d.s.av, 120, 'video plays 120 ms ahead of audio')
  assert.equal(d.s.vJb, 250)
  assert.equal(d.s.aPlay, 0)
  assert.deepEqual(d.v, {dec: 5, pli: 1, nack: 5, fir: 0, frz: 500, pau: 0})
  assert.deepEqual(d.e, {enc: 10, cpu: 500, bw: 250, oth: 0, pli: 1, nack: 2, fir: 0})
})

test('detailDelta never compares across a replaced stream or a reset counter', () => {
  const first = readDetail(detailReport(2))
  const replaced = detailDelta(first, readDetail(detailReport(3, {audio: {ssrc: 99}, video: {ssrc: 98}})))
  assert.equal(replaced.a.lost, undefined, 'new audio ssrc: no delta')
  assert.equal(replaced.a.jit, 12, 'current values still reported')
  assert.equal(replaced.v?.pli, undefined)
  const reset = detailDelta(first, readDetail(detailReport(1)))
  assert.equal(reset.a.lost, undefined, 'counter went backwards')
  assert.equal(reset.a.smp, undefined)
  const firstSample = detailDelta(null, first)
  assert.equal(firstSample.a.lost, undefined)
  assert.equal(firstSample.a.lvl, 0.2, 'falls back to the instantaneous audioLevel')
})

test('every new reading tolerates missing stats: absent is left out, never NaN', () => {
  assert.equal(detailDelta(null, readDetail([])), null)
  const bare = readDetail([
    {id: 'a', type: 'inbound-rtp', mediaType: 'audio', ssrc: 1, packetsReceived: 'many', jitter: NaN},
    {id: 'v', type: 'inbound-rtp', kind: 'video', ssrc: 2},
    {id: 'o', type: 'outbound-rtp', kind: 'video', ssrc: 3, framesEncoded: 10, totalEncodeTime: 0},
  ])
  assert.equal(bare.audioIn.received, null, 'a non-number counter is absent')
  assert.equal(bare.link, null)
  const d = detailDelta(bare, bare)
  assert.ok(!JSON.stringify(d ?? {}).match(/NaN|Infinity/))
  const json = JSON.stringify(omitNull({x: NaN, y: Infinity, z: {q: undefined}, ok: 0, no: false, list: [1]}))
  assert.equal(json, '{"ok":0,"no":false,"list":[1]}')
  assert.equal(readDetail([]).audioIn, null)
  assert.equal(detailDelta(readDetail(detailReport(1)), readDetail(detailReport(1))).v.dec, undefined, 'no new frames: no per-frame figure')
})

test('readDetail picks the live audio stream over a stale one and reads the candidate pair', () => {
  const stale = {id: 'old', type: 'inbound-rtp', kind: 'audio', ssrc: 1, packetsReceived: 5000, lastPacketReceivedTimestamp: 1000}
  const live = {id: 'new', type: 'inbound-rtp', kind: 'audio', ssrc: 2, packetsReceived: 50, lastPacketReceivedTimestamp: 9000}
  assert.equal(readDetail([stale, live]).audioIn.ssrc, 2)
  assert.equal(readDetail([live, stale]).audioIn.ssrc, 2)
  assert.deepEqual(readDetail(detailReport(1)).link, {protocol: 'udp', local: 'relay', remote: 'host', relay: 'tcp', tcp: null})
})

const SDP = [
  'v=0', 'm=video 9 UDP/TLS/RTP/SAVPF 96', 'a=rtpmap:96 H264/90000',
  'm=audio 0 UDP/TLS/RTP/SAVPF 111', 'a=rtpmap:111 opus/48000/2', 'a=fmtp:111 minptime=10;stereo=0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 63 111', 'a=rtpmap:63 red/48000/2', 'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=510000', '',
].join('\r\n')

test('parseOpusFmtp reads the negotiated Opus parameters from the first audio section in use', () => {
  assert.deepEqual(parseOpusFmtp(SDP), {ch: 2, st: 1, sst: 1, br: 510000, fec: 1})
  assert.equal(parseOpusFmtp('v=0\r\nm=audio 9 X 0\r\na=rtpmap:0 PCMU/8000\r\n'), null, 'no Opus')
  assert.equal(parseOpusFmtp(null), null)
  assert.deepEqual(parseOpusFmtp('m=audio 9 X 111\r\na=rtpmap:111 opus/48000/2\r\n'), {ch: 2}, 'no fmtp line: only the channel count')
  assert.equal(parseOpusFmtp('m=audio 9 X 111\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 maxaveragebitrate=abc\r\n').br, undefined)
})

test('linkFacts gathers the slow-changing facts and is stable between identical readings', () => {
  const detail = readDetail(detailReport(1))
  const facts = linkFacts(detail, {local: parseOpusFmtp(SDP), remote: null})
  assert.deepEqual(facts, {
    net: {p: 'udp', l: 'relay', r: 'host', rp: 'tcp'},
    venc: {impl: 'libx264', hw: false, codec: 'video/H264'},
    vdec: {impl: 'ExternalDecoder', hw: true, codec: 'video/H264'},
    opus: {local: {ch: 2, st: 1, sst: 1, br: 510000, fec: 1}},
  })
  assert.equal(JSON.stringify(facts), JSON.stringify(linkFacts(readDetail(detailReport(5)), {local: parseOpusFmtp(SDP)})), 'counters do not leak into the facts')
  assert.equal(linkFacts(readDetail([])), null)
})

test('linkFacts still names the codec when Chromium withholds the encoder and decoder implementation', () => {
  const facts = linkFacts(readDetail(detailReport(1).map((s) => ({...s, encoderImplementation: undefined, decoderImplementation: undefined, powerEfficientEncoder: undefined, powerEfficientDecoder: undefined}))))
  assert.deepEqual(facts.venc, {codec: 'video/H264'})
  assert.deepEqual(facts.vdec, {codec: 'video/H264'})
})

test('soundLateMs sees the share gap that the estimatedPlayoutTimestamp skew (av) missed', () => {
  // The M1.4 bench's share: audio buffered 30ms, video held ~700ms by lip-sync; av read 11-22ms throughout.
  assert.equal(soundLateMs({aJb: 30, vJb: 697.2, dec: 5, outMs: 30, baseMs: 10}), -632.2)
  // The M1.4 bench's film: both about 250ms, the Web Audio output (30 + 10) is the sound's extra: measured +48.
  const film = soundLateMs({aJb: 252, vJb: 233, dec: 3, outMs: 30, baseMs: 10})
  assert.ok(film > 40 && film < 65, `${film}`)
  // Output latency missing (a context that reports none) or decode unknown still gives the jitter-buffer difference.
  assert.equal(soundLateMs({aJb: 100, vJb: 80, dec: null, outMs: null, baseMs: null}), 20)
  // Without either jitter buffer there is nothing to say.
  assert.equal(soundLateMs({aJb: null, vJb: 80}), null)
  assert.equal(soundLateMs({aJb: 100, vJb: undefined}), null)
})

test('the video waits for the Web Audio output path, on top of the adapted buffer, once', () => {
  assert.equal(audioPathMs(0.03, 0.01), 40)
  assert.equal(audioPathMs(0.0304, 0.0098), 40, 'rounded to 10ms: a wobble does not rewrite the target every tick')
  assert.equal(audioPathMs(0, 0), 0)
  assert.equal(audioPathMs(undefined, NaN), 0, 'a context that reports nothing adds nothing')
  assert.equal(audioPathMs(5, 5), 200, 'a nonsense reading is capped')
  // The adapted buffer (250..750 for a film, 0..250 for a share) is what the audio receiver gets; the video
  // receiver gets the same plus the fixed path. The adaptation is never added twice.
  for (const buffer of [0, 100, 250, 500, 750]) assert.equal(videoTargetMs(buffer, 40), buffer + 40)
  assert.equal(videoTargetMs(250, 0), 250, 'with no audio context the targets are equal, as before')
})

test('viewerDelayMs: a measured delay already holds the video wait; the buffer fallback gets it added', () => {
  const base = {rttMs: 20, decodeMs: 40}
  assert.equal(viewerDelayMs({...base, frameDelayMs: 310, playoutDelayMs: 999, bufferMs: 999, audioPath: 40}), 310, 'the frame\'s own display delay wins')
  assert.equal(viewerDelayMs({...base, playoutDelayMs: 290, bufferMs: 250, audioPath: 40}), 290 + 10 + 40, 'a measured jitter-buffer delay is not topped up again')
  assert.equal(viewerDelayMs({...base, bufferMs: 250, audioPath: 40}), 250 + 40 + 10 + 40, 'no measurement yet: requested buffer + the video wait')
  assert.equal(viewerDelayMs({...base, bufferMs: 250}), 250 + 10 + 40)
})

test('captions stay aligned with the picture when the video waits for the audio path', () => {
  // Host clock: a cue is on screen for host time 10.0..12.0s. The viewer's picture shows host time f at
  // viewer time f + trueDelay, and the captions are drawn for (host time estimate - delay) with the delay the
  // app computes. Every displayed frame must show the caption exactly when its own host time is inside the cue.
  const cues = [{start: 10, end: 12, text: 'hello'}]
  const rttMs = 30
  const decodeMs = 40
  for (const audioPath of [0, 40]) {
    for (const bufferMs of [250, 500]) {
      const trueDelay = bufferMs + audioPath + rttMs / 2 + decodeMs // what the picture really trails the host by
      const sources = {
        'a measured frame delay': {frameDelayMs: trueDelay},
        'a measured jitter-buffer delay': {playoutDelayMs: bufferMs + audioPath},
        'only the requested buffer': {},
      }
      for (const [name, measured] of Object.entries(sources)) {
        const delay = viewerDelayMs({...measured, bufferMs, audioPath, rttMs, decodeMs})
        assert.ok(Math.abs(delay - trueDelay) < 1e-9, `${name} (buffer ${bufferMs}, path ${audioPath}): ${delay} vs ${trueDelay}`)
        for (let f = 9.5; f < 12.5; f += 1 / 30) {
          const viewerClock = f + trueDelay / 1000 // when this frame is on screen; the host time estimate there
          const shown = captionHtml(cues, viewerClock - delay / 1000) === 'hello'
          assert.equal(shown, f >= 10 && f < 12, `${name}: frame ${f.toFixed(3)}`)
        }
      }
    }
  }
})

// A connection that has carried three publishes keeps three audio sections. The first is a stale one;
// reading it reported "mono, no FEC" for a connection that was stereo.
const audioSection = (port, direction, fmtp, extra = []) => [`m=audio ${port} UDP/TLS/RTP/SAVPF 111`, `a=${direction}`, ...extra, 'a=rtpmap:111 opus/48000/2', `a=fmtp:111 ${fmtp}`].join('\r\n')
const STALE = 'minptime=10;useinbandfec=1;stereo=0;sprop-stereo=0'
const LIVE = 'minptime=10;stereo=1;sprop-stereo=1;useinbandfec=1;usedtx=0;maxplaybackrate=48000;maxaveragebitrate=510000'

test('parseOpusFmtp reads the audio section that carries sound, not the first of several', () => {
  // The sender's own description: two stale sections (its track was removed: recvonly, no msid; and a
  // stopped one), then the live one with its track.
  const sender = ['v=0', audioSection(9, 'recvonly', STALE), audioSection(0, 'inactive', STALE), audioSection(9, 'sendrecv', LIVE, ['a=msid:film audio-3']), ''].join('\r\n')
  assert.deepEqual(parseOpusFmtp(sender), {ch: 2, st: 1, sst: 1, br: 510000, fec: 1, dtx: 0, pr: 48000})
  // The receiver's description of the same connection: no track of its own anywhere; the stale sections
  // are inactive and the live one is the last that is not.
  const receiver = ['v=0', audioSection(9, 'inactive', STALE), audioSection(9, 'inactive', STALE), audioSection(9, 'recvonly', LIVE), ''].join('\r\n')
  assert.deepEqual(parseOpusFmtp(receiver), {ch: 2, st: 1, sst: 1, br: 510000, fec: 1, dtx: 0, pr: 48000})
  // A track in an earlier section beats a later section that has none (a republish mid-way).
  const midway = ['v=0', audioSection(9, 'sendrecv', LIVE, ['a=ssrc:1234 cname:x']), audioSection(9, 'recvonly', STALE), ''].join('\r\n')
  assert.equal(parseOpusFmtp(midway).st, 1)
  // Nothing live and nothing active: the last one that is not rejected, rather than nothing.
  const dead = ['v=0', audioSection(9, 'inactive', STALE), audioSection(9, 'inactive', LIVE), audioSection(0, 'inactive', STALE), ''].join('\r\n')
  assert.equal(parseOpusFmtp(dead).st, 1)
})
