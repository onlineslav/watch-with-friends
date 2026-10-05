import {finite, HOST_TIMEOUT_MS} from './protocol.mjs'

// Offset between monotonic clocks, measured with a request/response midpoint.
// Prefer short round trips; delayed control messages must not move the media clock backward.
export function updateClock(previous, sent, received, remoteNow) {
  const rtt = received - sent
  if (!finite(rtt, 0, 5000) || !finite(remoteNow, 0, 1e15)) return previous
  const sample = {offset: remoteNow - (sent + received) / 2, rtt, at: received}
  if (!previous || received - previous.at > 60_000 || rtt <= previous.rtt * 1.2) return sample
  return previous
}

export function estimatedMediaTime(state, now, clock) {
  if (!state) return 0
  if (state.ended) return state.time
  const age = Math.max(0, Math.min(HOST_TIMEOUT_MS, now - state.receivedAt))
  const transit = clock && now - clock.at < 60_000 ? Math.max(0, Math.min(5000, state.receivedAt + clock.offset - state.sentAt)) : 0
  const elapsed = state.playing && !state.buffering && !state.loading ? (age + transit) / 1000 : 0
  return Math.max(0, Math.min(state.time + elapsed, state.duration || Infinity))
}

// WebRTC owns bandwidth estimation and congestion control. Do not turn each estimate
// into another hard cap: that also reduces the picture and can prevent the transport
// from probing for more bandwidth. Our ceilings respond to actual playback trouble,
// then reopen promptly on fresh, clean feedback while preserving the group budget.
export function chooseSendQuality(previous, {receiver, receiverAt = null, capacity, active = true, peerCount = 1, width = 1920, height = 1080}, intervalMs = 2000) {
  const ceiling = Math.min(10_000_000, 18_000_000 / Math.max(1, peerCount))
  let bitrate = Math.min(previous?.bitrate ?? Math.min(4_000_000, ceiling), ceiling)
  let calmMs = previous?.calmMs || 0
  const fresh = receiverAt == null || receiverAt !== previous?.receiverAt
  if (!active || !receiver) calmMs = 0
  else if (fresh) {
    if (receiver.lossPct > 2 || receiver.freezes > 0) {
      bitrate *= 0.75
      if (finite(capacity, 100_000, 1e10)) bitrate = Math.min(bitrate, capacity * 0.8)
      calmMs = 0
    } else {
      calmMs = Math.min(6000, calmMs + intervalMs)
      if (calmMs >= 6000) {
        const probe = bitrate + Math.max(300_000, bitrate * 0.25)
        // Use observed headroom for a faster recovery, but never jump more than 2x.
        // The probe must be able to exceed a stale estimate left by our old cap.
        const headroom = finite(capacity, 100_000, 1e10) ? Math.min(capacity * 0.8, bitrate * 2) : 0
        bitrate = Math.max(probe, headroom)
      }
    }
  }
  bitrate = Math.round(Math.max(300_000, Math.min(ceiling, bitrate)))
  const maxHeight = bitrate < 900_000 ? 360 : bitrate < 2_000_000 ? 540 : bitrate < 3_500_000 ? 720 : 1080
  return {bitrate, calmMs, scale: Math.max(1, width / 1920, height / maxHeight), receiverAt}
}

// Always aggregate complete per-peer records, never one peer's sender and another's receiver.
export function aggregateLinks(links) {
  if (!links.length) return null
  const score = (p) => (p.receiver?.freezes || 0) * 100 + (p.receiver?.lossPct || 0) * 10 + (p.sender?.limit === 'none' ? 0 : 20) + (p.rttMs || 0) / 100
  return links.reduce((worst, next) => score(next) > score(worst) ? next : worst)
}
