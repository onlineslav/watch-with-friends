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

export function readStats(report, {audioOnly = false} = {}) {
  const byId = new Map()
  report.forEach((s) => byId.set(s.id, s))
  let inbound = null
  let outbound = null
  let pair = null
  report.forEach((s) => {
    if (s.type === 'inbound-rtp' && s.kind === (audioOnly ? 'audio' : 'video')) inbound = busiest(inbound, s)
    else if (s.type === 'outbound-rtp' && s.kind === (audioOnly ? 'audio' : 'video')) outbound = busiest(outbound, s)
    else if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s
  })
  const candidateTypes = pair ? [byId.get(pair.localCandidateId), byId.get(pair.remoteCandidateId)].map((c) => c?.candidateType) : []
  return {
    ...(pair?.availableOutgoingBitrate != null && {capacity: pair.availableOutgoingBitrate}),
    rttMs: pair?.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null,
    relayed: candidateTypes.includes('relay'),
    inboundRtp: rtpSample(inbound, 'bytesReceived'),
    outboundRtp: rtpSample(outbound, 'bytesSent'),
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
