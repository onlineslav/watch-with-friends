// Connection health: what the viewer is actually receiving, what the host is able to send,
// and how much the viewer buffers to ride out a shaky connection. Pure functions only.

// Bound viewer delay; persistent congestion also reduces the sender's quality ceiling.
export const MIN_BUFFER_MS = 250
export const MAX_BUFFER_MS = 750
const CALM_BEFORE_SHRINK_MS = 30_000
const SHRINK_STEP_MS = 250

// The busiest stream wins: stale entries from a replaced stream stop reporting framesPerSecond.
const busiest = (a, b) => ((b.framesPerSecond || 0) > (a?.framesPerSecond || 0) ? b : a || b)

// Keep byte counters local to diagnostics; they are not part of room telemetry.
const rtpSample = (stats, key) => stats && Number.isFinite(stats.timestamp) && Number.isFinite(stats[key])
  ? {id: stats.id, ssrc: stats.ssrc, timestamp: stats.timestamp, bytes: stats[key]} : null

export function bitrateDelta(previous, next) {
  if (!previous || !next || previous.id !== next.id || previous.ssrc !== next.ssrc) return null
  const intervalMs = next.timestamp - previous.timestamp
  const bytes = next.bytes - previous.bytes
  if (!Number.isFinite(intervalMs) || intervalMs <= 0 || !Number.isFinite(bytes) || bytes < 0) return null
  return {bitrateBps: Math.round(bytes * 8000 / intervalMs), intervalMs: Math.round(intervalMs)}
}

// The route a connection is using now. The transport's selectedCandidatePairId names it exactly; the
// nominated-and-succeeded search is the fallback for a report without it (it can find none, or the old
// pair, for a moment while ICE switches routes). `switches` counts route changes since the connection began.
export function selectedPair(report, byId) {
  let pair = null
  let switches = null
  report.forEach((s) => {
    if (s.type === 'transport' && s.selectedCandidatePairId && byId.get(s.selectedCandidatePairId)) {
      pair = byId.get(s.selectedCandidatePairId)
      if (Number.isFinite(s.selectedCandidatePairChanges)) switches = s.selectedCandidatePairChanges
    }
  })
  if (!pair) report.forEach((s) => { if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s })
  return {pair, switches}
}

export function readStats(report, {audioOnly = false} = {}) {
  const byId = new Map()
  report.forEach((s) => byId.set(s.id, s))
  let inbound = null
  let outbound = null
  // Independent of audioOnly: a share (or any video with audio) sends/receives both RTP streams
  // at once, so actual audio throughput needs its own fields rather than only ever substituting
  // for the video ones in audio-only mode.
  let audioInbound = null
  let audioOutbound = null
  const {pair} = selectedPair(report, byId)
  report.forEach((s) => {
    if (s.type === 'inbound-rtp' && s.kind === (audioOnly ? 'audio' : 'video')) inbound = busiest(inbound, s)
    else if (s.type === 'outbound-rtp' && s.kind === (audioOnly ? 'audio' : 'video')) outbound = busiest(outbound, s)
    if (s.type === 'inbound-rtp' && s.kind === 'audio') audioInbound = busiest(audioInbound, s)
    else if (s.type === 'outbound-rtp' && s.kind === 'audio') audioOutbound = busiest(audioOutbound, s)
  })
  const candidateTypes = pair ? [byId.get(pair.localCandidateId), byId.get(pair.remoteCandidateId)].map((c) => c?.candidateType) : []
  return {
    ...(pair?.availableOutgoingBitrate != null && {capacity: pair.availableOutgoingBitrate}),
    rttMs: pair?.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null,
    relayed: candidateTypes.includes('relay'),
    inboundRtp: rtpSample(inbound, 'bytesReceived'),
    outboundRtp: rtpSample(outbound, 'bytesSent'),
    audioInboundRtp: rtpSample(audioInbound, 'bytesReceived'),
    audioOutboundRtp: rtpSample(audioOutbound, 'bytesSent'),
    inbound: inbound && {
      ssrc: inbound.ssrc,
      packetsReceived: inbound.packetsReceived || 0,
      packetsLost: inbound.packetsLost || 0,
      freezeCount: inbound.freezeCount || 0,
      framesDropped: inbound.framesDropped || 0,
      jitterMs: Math.round((inbound.jitter || 0) * 1000),
      fps: inbound.framesPerSecond || 0,
      height: inbound.frameHeight || 0,
      jitterBufferDelay: inbound.jitterBufferDelay || 0,
      jitterBufferEmittedCount: inbound.jitterBufferEmittedCount || 0,
    },
    outbound: outbound && {
      fps: outbound.framesPerSecond || 0,
      height: outbound.frameHeight || 0,
      limit: outbound.qualityLimitationReason || 'none',
    },
  }
}

// What changed between two inbound readings; null when the stream was replaced in between.
export function inboundDelta(previous, next) {
  if (!previous || !next || previous.ssrc !== next.ssrc || next.packetsReceived < previous.packetsReceived) return null
  const received = next.packetsReceived - previous.packetsReceived
  const lost = Math.max(0, next.packetsLost - previous.packetsLost)
  const emitted = next.jitterBufferEmittedCount - previous.jitterBufferEmittedCount
  return {
    lossPct: received + lost > 0 ? (100 * lost) / (received + lost) : 0,
    freezes: next.freezeCount - previous.freezeCount,
    droppedFrames: next.framesDropped - previous.framesDropped,
    // How long frames recently waited in the jitter buffer: how far the picture trails the host.
    delayMs: emitted > 0 ? Math.round((1000 * (next.jitterBufferDelay - previous.jitterBufferDelay)) / emitted) : null,
  }
}

// Pauses, seeks and track switches stall the stream on purpose. Freezes only mean a bad
// connection once the host has been playing uninterrupted for a little while.
export const STEADY_WINDOW_MS = 4000

export function nextSteady(steady, state, expectedTime, now) {
  if (!state.playing || state.buffering || state.loading) return {since: null, epoch: state.epoch}
  const interrupted = state.epoch !== steady.epoch || Math.abs(state.time - expectedTime) > 1.5
  return {since: interrupted || steady.since == null ? now : steady.since, epoch: state.epoch}
}

export const isSteady = (steady, now, windowMs = STEADY_WINDOW_MS) => steady.since != null && now - steady.since >= windowMs

export const isTroubled = (delta, jitterMs) => Boolean(delta && (delta.freezes > 0 || delta.lossPct > 2)) || jitterMs > 50

// Grow the buffer fast when playback hiccups; give it back slowly once things are calm.
export function adaptBuffer(state, troubled, intervalMs) {
  if (troubled) return {bufferMs: Math.min(MAX_BUFFER_MS, state.bufferMs * 2), calmMs: 0}
  const calmMs = state.calmMs + intervalMs
  if (state.bufferMs <= MIN_BUFFER_MS || calmMs < CALM_BEFORE_SHRINK_MS) return {bufferMs: state.bufferMs, calmMs}
  return {bufferMs: Math.max(MIN_BUFFER_MS, state.bufferMs - SHRINK_STEP_MS), calmMs: 0}
}

// The received sound plays through a Web Audio graph (routeRemoteAudio / routeTileAudio), whose output
// path (the context's outputLatency + baseLatency) WebRTC's lip-sync cannot see: it lines up audio and
// video where the audio leaves the jitter buffer, so the sound reaches the speakers that much after the
// picture. The video receiver therefore waits that long extra: its jitterBufferTarget is the adapted
// buffer (the same value the audio receiver gets, which grows and shrinks with trouble) PLUS this fixed
// amount, computed once from the two so the adaptation is never added to itself. Rounded to 10ms so a
// latency that wobbles by a fraction doesn't rewrite the target every tick.
// Capped at 300ms: Bluetooth headphones report 200-250ms (a Sony WH-1000XM4 on a Mac: outputLatency 215ms), which a
// 200ms cap left partly uncovered; a reading past 300 is taken as nonsense rather than waited for.
export const MAX_AUDIO_PATH_MS = 300
export function audioPathMs(outputLatencySeconds, baseLatencySeconds) {
  const ms = ((Number(outputLatencySeconds) || 0) + (Number(baseLatencySeconds) || 0)) * 1000
  return Number.isFinite(ms) && ms > 0 ? Math.min(MAX_AUDIO_PATH_MS, Math.round(ms / 10) * 10) : 0
}
export const videoTargetMs = (bufferMs, audioPath) => bufferMs + audioPath

// How far a viewer's picture trails the host's clock, for captions and the report to the host. A
// measured value (the frame's own display time against its capture time, or the video jitter buffer's
// recent delay) already includes the extra video wait above; the buffer fallback is only the requested
// buffer, so the wait is added to it there.
export function viewerDelayMs({frameDelayMs = null, playoutDelayMs = null, bufferMs = 0, audioPath = 0, rttMs = 0, decodeMs = 0}) {
  return frameDelayMs ?? (playoutDelayMs ?? videoTargetMs(bufferMs, audioPath)) + (rttMs || 0) / 2 + decodeMs
}

// A live share or game is not a film: the 250 ms floor above that smooths playback is pure lag
// there. Share receivers start at 0 (the browser's own adaptive buffer), step up only while this
// viewer's connection is troubled, and step back down after the same calm stretch.
export const SHARE_BUFFER_STEPS = [0, 100, 250]
export const SHARE_BUFFER_START = {bufferMs: SHARE_BUFFER_STEPS[0], calmMs: 0}

export function adaptShareBuffer(state, troubled, intervalMs) {
  const index = Math.max(0, SHARE_BUFFER_STEPS.indexOf(state.bufferMs))
  if (troubled) return {bufferMs: SHARE_BUFFER_STEPS[Math.min(SHARE_BUFFER_STEPS.length - 1, index + 1)], calmMs: 0}
  const calmMs = state.calmMs + intervalMs
  if (index === 0 || calmMs < CALM_BEFORE_SHRINK_MS) return {bufferMs: SHARE_BUFFER_STEPS[index], calmMs}
  return {bufferMs: SHARE_BUFFER_STEPS[index - 1], calmMs: 0}
}

// `sender` is the host's outgoing video, `receiver` what a viewer reports getting. `host` and
// `viewer` say whose they are ("Your", "Your friend's").
function assess({rttMs, relayed, sender, receiver}, host, viewer) {
  const notes = []
  let level = 'good'
  const flag = (severity, note) => {
    if (severity === 'poor' || level === 'good') level = severity
    notes.push(note)
  }

  if (receiver && (receiver.freezes > 0 || receiver.lossPct > 5)) {
    flag('poor', `${viewer} connection is dropping video${receiver.lossPct >= 1 ? ` (${Math.round(receiver.lossPct)}% packet loss)` : ''}.`)
  } else if (receiver?.lossPct > 1) {
    flag('fair', `${viewer} connection is losing a few packets (${receiver.lossPct.toFixed(1)}%).`)
  }
  if (sender?.limit === 'cpu') flag('fair', `${host} computer is too busy to stream at full quality.`)
  else if (sender?.limit === 'bandwidth') flag('fair', `${host} upload speed is limiting picture quality.`)
  if (rttMs > 250) flag('fair', `High ping (${rttMs} ms).`)

  if (!notes.length) notes.push('Connection looks good.')
  if (receiver?.bufferMs > MIN_BUFFER_MS) notes.push(`Viewer is buffering ${(receiver.bufferMs / 1000).toFixed(2)} s to smooth playback.`)
  if (relayed) notes.push('Connected through a relay server.')

  const picture = receiver?.height ? receiver : sender
  const quality = picture?.height ? `${picture.height}p${picture.fps ? Math.round(picture.fps) : ''}` : null
  return {level, quality, detail: notes.join('\n')}
}

export function describeLink({selfRole, ...link}) {
  const friend = "Your friend's"
  const {level, quality, detail} = assess(link, selfRole === 'host' ? 'Your' : friend, selfRole === 'host' ? friend : 'Your')
  const text = [link.rttMs != null ? `${link.rttMs} ms` : null, quality].filter(Boolean).join(' · ') || 'Measuring…'
  return {level, text, detail}
}

// The stats beside one person's name: ping from you to them, and the picture they receive
// (a viewer) or send (the host). Level and detail are null until something is measured.
export function describePeer({self = false, rttMs = null, relayed = false, sender = null, receiver = null}) {
  if (rttMs == null && !receiver?.height && !sender?.height) return {level: null, text: '', detail: null}
  const whose = self ? 'Your' : 'Their'
  const {level, quality, detail} = assess({rttMs, relayed, sender, receiver}, whose, whose)
  const loss = receiver?.lossPct >= 1 ? `${Math.round(receiver.lossPct)}% loss` : null
  const text = [rttMs != null ? `${rttMs} ms` : null, quality, loss].filter(Boolean).join(' · ')
  return {level, text, detail}
}

// ---------- Measurements for the log (M1.2) ----------
//
// Everything below only feeds the diagnostic log; nothing here changes what the app does. Every
// reading tolerates a stat that older Chromium or another platform doesn't have: it comes back
// null, never NaN, and `omitNull` leaves it out of the line so a sample stays small.

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const label = (value) => (typeof value === 'string' && value ? value.slice(0, 48) : null)
// An address's family, never the address: 4, 6, or 'mdns' for Chromium's hidden `.local` names.
export function family(address) {
  if (typeof address !== 'string' || !address) return null
  if (address.endsWith('.local')) return 'mdns'
  if (address.includes(':')) return 6
  return /^\d+\.\d+\.\d+\.\d+$/.test(address) ? 4 : null
}
const flag = (value) => (typeof value === 'boolean' ? value : null)
const kindOf = (stat) => stat.kind ?? stat.mediaType
export const round = (value, places = 0) => (value == null || !Number.isFinite(value) ? null : Math.round(value * 10 ** places) / 10 ** places)

// Counter movement between two readings; null if either is missing or the counter went backwards.
const step = (previous, next, key) => {
  const a = previous?.[key]
  const b = next?.[key]
  return a != null && b != null && b >= a ? b - a : null
}
// Average per unit of a (total, count) pair of counters between two readings.
const perUnit = (previous, next, totalKey, countKey, scale = 1000) => {
  const total = step(previous, next, totalKey)
  const count = step(previous, next, countKey)
  return total != null && count > 0 ? (total * scale) / count : null
}

// Drops null/undefined/NaN fields and empty groups, so absent stats cost no bytes. Arrays are kept whole.
export function omitNull(value) {
  if (Array.isArray(value)) return value
  if (value == null || typeof value !== 'object') return typeof value === 'number' && !Number.isFinite(value) ? null : value ?? null
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    const clean = omitNull(item)
    if (clean != null) out[key] = clean
  }
  return Object.keys(out).length ? out : null
}

// The stream that is still receiving: a replaced stream's stats can linger beside the live one.
const newest = (a, b, recency) => {
  if (!a) return b
  const x = num(a[recency])
  const y = num(b[recency])
  if (x != null && y != null) return y > x ? b : a
  return (num(b.packetsReceived) || 0) > (num(a.packetsReceived) || 0) ? b : a
}

// Raw counters and labels for the 2s sample's extra fields, read from the same getStats() report
// readStats() gets. Counters stay raw; detailDelta() turns two readings into what happened between.
export function readDetail(report) {
  const byId = new Map()
  report.forEach((s) => byId.set(s.id, s))
  let audioIn = null
  let videoIn = null
  let videoOut = null
  let playout = null
  const {pair, switches} = selectedPair(report, byId)
  report.forEach((s) => {
    const kind = kindOf(s)
    if (s.type === 'inbound-rtp' && kind === 'audio') audioIn = newest(audioIn, s, 'lastPacketReceivedTimestamp')
    else if (s.type === 'inbound-rtp' && kind === 'video') videoIn = newest(videoIn, s, 'lastPacketReceivedTimestamp')
    else if (s.type === 'outbound-rtp' && kind === 'video') videoOut = !videoOut || (num(s.framesPerSecond) || 0) > (num(videoOut.framesPerSecond) || 0) ? s : videoOut
    else if (s.type === 'media-playout' && kind === 'audio') playout = s
  })
  const local = pair && byId.get(pair.localCandidateId)
  const remote = pair && byId.get(pair.remoteCandidateId)
  return {
    audioIn: audioIn && {
      ssrc: audioIn.ssrc,
      received: num(audioIn.packetsReceived), lost: num(audioIn.packetsLost), jitter: num(audioIn.jitter),
      concealed: num(audioIn.concealedSamples), silent: num(audioIn.silentConcealedSamples), samples: num(audioIn.totalSamplesReceived),
      inserted: num(audioIn.insertedSamplesForDeceleration), removed: num(audioIn.removedSamplesForAcceleration),
      jbDelay: num(audioIn.jitterBufferDelay), jbCount: num(audioIn.jitterBufferEmittedCount),
      energy: num(audioIn.totalAudioEnergy), duration: num(audioIn.totalSamplesDuration), level: num(audioIn.audioLevel),
      ept: num(audioIn.estimatedPlayoutTimestamp),
    },
    playout: playout && {delay: num(playout.totalPlayoutDelay), count: num(playout.totalSamplesCount)},
    videoIn: videoIn && {
      ssrc: videoIn.ssrc,
      decoded: num(videoIn.framesDecoded), decodeTime: num(videoIn.totalDecodeTime),
      freezeS: num(videoIn.totalFreezesDuration), pauseS: num(videoIn.totalPausesDuration),
      pli: num(videoIn.pliCount), nack: num(videoIn.nackCount), fir: num(videoIn.firCount),
      jbDelay: num(videoIn.jitterBufferDelay), jbCount: num(videoIn.jitterBufferEmittedCount),
      ept: num(videoIn.estimatedPlayoutTimestamp),
      decoder: label(videoIn.decoderImplementation), decoderHw: flag(videoIn.powerEfficientDecoder), codec: label(byId.get(videoIn.codecId)?.mimeType),
    },
    videoOut: videoOut && {
      ssrc: videoOut.ssrc,
      encoded: num(videoOut.framesEncoded), encodeTime: num(videoOut.totalEncodeTime),
      pli: num(videoOut.pliCount), nack: num(videoOut.nackCount), fir: num(videoOut.firCount),
      limitCpuS: num(videoOut.qualityLimitationDurations?.cpu), limitBandwidthS: num(videoOut.qualityLimitationDurations?.bandwidth),
      limitOtherS: num(videoOut.qualityLimitationDurations?.other),
      encoder: label(videoOut.encoderImplementation), encoderHw: flag(videoOut.powerEfficientEncoder), codec: label(byId.get(videoOut.codecId)?.mimeType),
    },
    link: pair && {
      protocol: label(local?.protocol), local: label(local?.candidateType), remote: label(remote?.candidateType),
      relay: label(local?.relayProtocol), tcp: label(local?.tcpType),
      // Which route, without its addresses: the pair's own id, each end's address family and (where
      // Chromium says) the local network type, and how many times the route has switched.
      id: label(pair.id), lf: family(local?.address), rf: family(remote?.address),
      nt: label(local?.networkType), switches: num(switches),
    },
    // The route's own counters, both directions: ICE checks we sent and got answered, checks the other
    // end sent us and we answered, bytes each way and when a packet last arrived. A stall that only
    // one direction suffers shows here as checks going out unanswered while theirs still arrive.
    pair: pair && {
      id: pair.id, at: num(pair.timestamp),
      rq: num(pair.requestsSent), rs: num(pair.responsesReceived), rr: num(pair.requestsReceived), ss: num(pair.responsesSent),
      disc: num(pair.packetsDiscardedOnSend),
      bin: num(pair.bytesReceived), bout: num(pair.bytesSent), rtt: num(pair.currentRoundTripTime),
      lastIn: num(pair.lastPacketReceivedTimestamp),
    },
  }
}

// Whether a connection is struggling enough to traceroute to that person now (main rate-limits it to
// once a minute): the reason, or null. Loss over 10%, a round trip over a second, nothing received
// for 2s, a host hearing nothing from a viewer for 4s while playing, or ICE disconnected.
export function peerTrouble({lossPct, rttMs, quietMs, feedbackAgeMs, ice} = {}) {
  if (ice === 'disconnected' || ice === 'failed') return 'disconnected'
  if (lossPct > 10) return 'loss'
  if (rttMs > 1000) return 'rtt'
  if (quietMs > 2000) return 'quiet'
  if (feedbackAgeMs > 4000) return 'feedback'
  return null
}

// The address the route reaches the other person at, for main's peer ping and traceroute only
// (main/net-probe.js). Kept out of readDetail so nothing that logs or stores the detail can carry it.
export function remoteAddress(report) {
  const byId = new Map()
  report.forEach((s) => byId.set(s.id, s))
  const {pair} = selectedPair(report, byId)
  const remote = pair && byId.get(pair.remoteCandidateId)
  return remote && typeof remote.address === 'string' && remote.address ? remote.address : null
}

// How far the sound trails the picture at the viewer's output, in ms (positive = sound late, the same
// sign as `npm run bench`), estimated from what each path holds: the audio's jitter buffer plus the Web
// Audio output it plays through (`outMs` + `baseMs`) against the video's jitter buffer plus its decode.
// `av` (the gap between the two tracks' estimatedPlayoutTimestamp) is NOT this: it compares the
// capture-time estimates, which lip-sync has already lined up, so it read 11-22ms while a share's picture
// was really ~650ms behind its sound. The jitter-buffer delays include whatever lip-sync is holding.
export function soundLateMs({aJb, vJb, dec, outMs, baseMs}) {
  if (!Number.isFinite(aJb) || !Number.isFinite(vJb)) return null
  return aJb + (Number.isFinite(outMs) ? outMs : 0) + (Number.isFinite(baseMs) ? baseMs : 0) - (vJb + (Number.isFinite(dec) ? dec : 0))
}

// What the audio and video did since the previous reading. A replaced stream (new ssrc) or a
// reset counter is not comparable, so its deltas come back null while its current values stay.
// Keys are short on purpose: this rides in a line written every 2 seconds.
export function detailDelta(previous, next) {
  const same = (a, b) => Boolean(a && b && a.ssrc === b.ssrc)
  const audio = next?.audioIn
  const before = same(previous?.audioIn, audio) ? previous.audioIn : null
  const playoutBefore = before && previous.playout
  const energy = step(before, audio, 'energy')
  const duration = step(before, audio, 'duration')
  const rms = energy != null && duration > 0 ? Math.sqrt(energy / duration) : audio?.level
  const video = next?.videoIn
  const videoBefore = same(previous?.videoIn, video) ? previous.videoIn : null
  const out = next?.videoOut
  const outBefore = same(previous?.videoOut, out) ? previous.videoOut : null
  const millis = (key, from, to) => { const d = step(from, to, key); return d == null ? null : Math.round(d * 1000) }
  const aJb = perUnit(before, audio, 'jbDelay', 'jbCount')
  const vJb = perUnit(videoBefore, video, 'jbDelay', 'jbCount')
  const skew = audio?.ept != null && video?.ept != null ? video.ept - audio.ept : null
  const pair = next?.pair
  const pairBefore = previous?.pair && pair && previous.pair.id === pair.id ? previous.pair : null
  const seconds = pairBefore && pair.at > pairBefore.at ? (pair.at - pairBefore.at) / 1000 : null
  const kbps = (key) => { const d = step(pairBefore, pair, key); return d != null && seconds ? Math.round((d * 8) / seconds / 1000) : null }
  return omitNull({
    // The route, both directions (see readDetail's pair): checks sent/answered (rq/rs), checks received/
    // answered (rr/ss), packets dropped on send, kbps in/out, its RTT, and ms since a packet last arrived.
    cp: pair && {
      rq: step(pairBefore, pair, 'rq'), rs: step(pairBefore, pair, 'rs'), rr: step(pairBefore, pair, 'rr'), ss: step(pairBefore, pair, 'ss'),
      disc: step(pairBefore, pair, 'disc'), in: kbps('bin'), out: kbps('bout'),
      rtt: round(pair.rtt != null ? pair.rtt * 1000 : null),
      quiet: pair.at != null && pair.lastIn != null ? Math.max(0, Math.round(pair.at - pair.lastIn)) : null,
    },
    // Audio receive health: loss, jitter, what the decoder made up, and how it is time-stretching.
    a: audio && {
      lost: step(before, audio, 'lost'), rx: step(before, audio, 'received'), jit: round(audio.jitter != null ? audio.jitter * 1000 : null, 1),
      conc: step(before, audio, 'concealed'), sil: step(before, audio, 'silent'), smp: step(before, audio, 'samples'),
      ins: step(before, audio, 'inserted'), rem: step(before, audio, 'removed'),
      jb: round(aJb, 1), lvl: round(rms, 3),
    },
    // A/V sync inputs: each track's own playout delay and the clock each claims to be playing at.
    s: audio || video ? {
      aEpt: round(audio?.ept), vEpt: round(video?.ept), av: round(skew),
      aJb: round(aJb, 1), vJb: round(vJb, 1),
      aPlay: round(perUnit(playoutBefore, next?.playout, 'delay', 'count'), 1),
    } : null,
    // Decoder cost and what the receiver asked the sender to resend or refresh.
    v: video && {
      dec: round(perUnit(videoBefore, video, 'decodeTime', 'decoded'), 1),
      pli: step(videoBefore, video, 'pli'), nack: step(videoBefore, video, 'nack'), fir: step(videoBefore, video, 'fir'),
      frz: millis('freezeS', videoBefore, video), pau: millis('pauseS', videoBefore, video),
    },
    // Encoder cost (host): ms per frame, time spent limited by cpu/bandwidth, and feedback received.
    e: out && {
      enc: round(perUnit(outBefore, out, 'encodeTime', 'encoded'), 1),
      cpu: millis('limitCpuS', outBefore, out), bw: millis('limitBandwidthS', outBefore, out), oth: millis('limitOtherS', outBefore, out),
      pli: step(outBefore, out, 'pli'), nack: step(outBefore, out, 'nack'), fir: step(outBefore, out, 'fir'),
    },
  })
}

// Opus as negotiated, read from a live SDP: the audio section that is carrying sound now. A connection
// that has hosted several films or shares keeps a stale audio section for each (stopped, or inactive, or
// with its track removed) ahead of the live one, so the first section is the wrong one to read.
// In order of preference: a section with a track in this description (an a=msid or a=ssrc line),
// then one that is not inactive, then any; the last such section wins, because new ones are appended.
// A section the other side rejected (port 0) is never read. The channel count comes from the rtpmap
// line and the rest from the fmtp parameters.
export function parseOpusFmtp(sdp) {
  if (typeof sdp !== 'string') return null
  const sections = []
  for (const section of sdp.split(/(?:^|\r?\n)m=/).slice(1)) {
    const lines = section.split(/\r?\n/)
    if (!lines[0].startsWith('audio ') || lines[0].startsWith('audio 0 ')) continue
    const rtpmap = lines.map((l) => /^a=rtpmap:(\d+) opus\/48000(?:\/(\d+))?/i.exec(l)).find(Boolean)
    if (!rtpmap) continue
    sections.push({lines, rtpmap, live: lines.some((l) => /^a=(msid|ssrc):/.test(l)), active: !lines.includes('a=inactive')})
  }
  const chosen = [(s) => s.live && s.active, (s) => s.active, () => true].map((keep) => sections.filter(keep).at(-1)).find(Boolean)
  if (!chosen) return null
  const {lines, rtpmap} = chosen
  const fmtp = lines.find((l) => l.startsWith(`a=fmtp:${rtpmap[1]} `))
  const params = Object.fromEntries((fmtp?.slice(fmtp.indexOf(' ') + 1).split(';') || []).map((p) => p.trim().split('=')).filter(([k]) => k))
  const read = (key) => (params[key] != null && params[key] !== '' && Number.isFinite(Number(params[key])) ? Number(params[key]) : null)
  return omitNull({ch: rtpmap[2] ? Number(rtpmap[2]) : null, st: read('stereo'), sst: read('sprop-stereo'), br: read('maxaveragebitrate'), fec: read('useinbandfec'), dtx: read('usedtx'), cbr: read('cbr'), pr: read('maxplaybackrate')})
}

// The slow-changing facts about one connection, kept out of the 2s samples: logged once, and again
// only when something here changes (an encoder switch, a new candidate pair, a renegotiated codec).
export function linkFacts(detail, opus = null) {
  const link = detail?.link
  return omitNull({
    net: link ? omitNull({p: link.protocol, l: link.local, r: link.remote, rp: link.relay, tcp: link.tcp, id: link.id, lf: link.lf, rf: link.rf, nt: link.nt, sw: link.switches}) : null,
    // Chromium only names the encoder/decoder (and says if it is hardware) when the page has capture permission,
    // so the codec's mime type is kept too: it is always there.
    venc: detail?.videoOut && {impl: detail.videoOut.encoder, hw: detail.videoOut.encoderHw, codec: detail.videoOut.codec},
    vdec: detail?.videoIn && {impl: detail.videoIn.decoder, hw: detail.videoIn.decoderHw, codec: detail.videoIn.codec},
    opus: omitNull({local: opus?.local, remote: opus?.remote}),
  })
}
