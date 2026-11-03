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

// One-way delay of a message in one direction (M1.9), from the sender's clock reading to ours. `offset`
// is the measured offset to the host's clock (host = ours + offset), so `toHost` converts our reading
// into the host's and `fromHost` the other way. The offset assumes the two directions take equally
// long, so the absolute number is only as good as that: what means something is a direction that gets
// slower by itself (a queue building in one link), which moves its number and not the other's. A
// delay can come out a little negative when the assumption is off; it is logged as it is.
export const MAX_ONE_WAY_MS = 60_000
export function oneWayDelayMs(sentAt, receivedAt, offset) {
  if (!finite(sentAt, 0, 1e15) || !finite(receivedAt, 0, 1e15) || !finite(offset, -1e15, 1e15)) return null
  const ms = receivedAt - sentAt + offset
  return ms >= -5000 && ms <= MAX_ONE_WAY_MS ? ms : null
}
// host to viewer: our clock now, the host's clock at send, and the offset (host = ours + offset)
export const hostToViewerMs = (hostSentAt, ourNow, offset) => oneWayDelayMs(hostSentAt, ourNow, offset)
// viewer to host: the viewer stamps its message with the host's clock (`toHostClock`); the host just subtracts
export const toHostClock = (ourNow, offset) => (finite(ourNow, 0, 1e15) && finite(offset, -1e15, 1e15) ? ourNow + offset : null)
export const viewerToHostMs = (stampedHostClock, hostNow) => oneWayDelayMs(stampedHostClock, hostNow, 0)

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
//
// Above the 4 Mbps starting rate the climb is careful, and a stall is remembered. A viewer's
// Wi-Fi once queued 12 seconds of video (82% loss) after the cap went 4 -> 6.1 -> 7.7 Mbps in
// two seconds on an estimate of 7.7-8.9 Mbps, then the same link's reports stopped arriving and
// a missing report only held the cap where it was. So: above the start, a raise waits for two
// fresh clean reports (the first one after a raise mostly predates it) and probes without
// trusting the estimate's headroom; a report more than STALE_FEEDBACK_MS old during playback is
// trouble, since reports share the congested connection with the video; heavy loss halves the
// cap; and for SAFE_MEMORY_MS of clean playback after trouble the cap stays below the rate that
// was actually being sent when it began.
const START_BITRATE = 4_000_000
export const STALE_FEEDBACK_MS = 4000
const SAFE_MEMORY_MS = 60_000
const RECOVERY_CALM_MS = 6000

export function chooseSendQuality(previous, {receiver, receiverAt = null, feedbackAgeMs = null, sentBps = null, capacity, active = true, peerCount = 1, width = 1920, height = 1080}, intervalMs = 2000) {
  const ceiling = Math.min(10_000_000, 18_000_000 / Math.max(1, peerCount))
  let bitrate = Math.min(previous?.bitrate ?? Math.min(START_BITRATE, ceiling), ceiling)
  let calmMs = previous?.calmMs || 0
  let failedAt = previous?.failedAt ?? null
  let sinceTroubleMs = previous?.sinceTroubleMs ?? 0
  let decision = 'duplicate-feedback'
  const fresh = receiverAt == null || receiverAt !== previous?.receiverAt
  const trouble = (reason, factor) => {
    decision = reason
    // Where this episode of trouble began, in what was really going out (the cap can sit well
    // above it). Further cuts in the same episode keep it, or a long one would pin the cap low.
    if (failedAt == null || sinceTroubleMs > 0) failedAt = finite(sentBps, 1, 1e10) ? Math.min(bitrate, sentBps) : bitrate
    sinceTroubleMs = 0
    bitrate *= factor
    calmMs = 0
  }
  if (!active || !receiver) {
    calmMs = 0
    decision = active ? 'no-feedback' : 'inactive'
  } else if (!fresh) {
    if (feedbackAgeMs > STALE_FEEDBACK_MS) trouble('stale-feedback', 0.75)
  } else if (receiver.lossPct > 2 || receiver.freezes > 0) {
    trouble(receiver.freezes > 0 ? 'freezes' : 'loss', receiver.lossPct > 10 ? 0.5 : 0.75)
    if (finite(capacity, 100_000, 1e10)) bitrate = Math.min(bitrate, capacity * 0.8)
  } else {
    decision = 'settling'
    calmMs = Math.min(RECOVERY_CALM_MS, calmMs + intervalMs)
    sinceTroubleMs += intervalMs
    if (failedAt != null && sinceTroubleMs >= SAFE_MEMORY_MS) failedAt = null
    if (calmMs >= RECOVERY_CALM_MS) {
      const careful = bitrate >= START_BITRATE
      const probe = bitrate + Math.max(300_000, bitrate * 0.25)
      // Use observed headroom for a faster recovery, but never jump more than 2x.
      // The probe must be able to exceed a stale estimate left by our old cap.
      const headroom = !careful && finite(capacity, 100_000, 1e10) ? Math.min(capacity * 0.8, bitrate * 2) : 0
      const safe = failedAt != null ? Math.max(bitrate, failedAt * 0.85) : Infinity
      const raised = Math.min(Math.max(probe, headroom), safe)
      if (raised > bitrate) {
        bitrate = raised
        decision = bitrate >= ceiling && previous?.bitrate >= ceiling ? 'ceiling' : 'recovery'
        if (careful) calmMs = RECOVERY_CALM_MS - 2 * intervalMs
      } else decision = 'holding-below-stall'
    }
  }
  bitrate = Math.round(Math.max(300_000, Math.min(ceiling, bitrate)))
  if (previous?.bitrate > Math.round(ceiling) && bitrate === Math.round(ceiling)) decision = 'group-budget'
  const maxHeight = bitrate < 900_000 ? 360 : bitrate < 2_000_000 ? 540 : bitrate < 3_500_000 ? 720 : 1080
  return {bitrate, calmMs, failedAt, sinceTroubleMs, scale: Math.max(1, width / 1920, height / maxHeight), receiverAt, decision, ceiling}
}

// Always aggregate complete per-peer records, never one peer's sender and another's receiver.
export function aggregateLinks(links) {
  if (!links.length) return null
  const score = (p) => (p.receiver?.freezes || 0) * 100 + (p.receiver?.lossPct || 0) * 10 + (p.sender?.limit === 'none' ? 0 : 20) + (p.rttMs || 0) / 100
  return links.reduce((worst, next) => score(next) > score(worst) ? next : worst)
}

// Audio gives way by bitrate before it drops out (M1.6). Each viewer has its own audio ceiling, set
// from the loss that viewer reports (the same report chooseSendQuality reads): step 0 is the
// configured cap (AUDIO_MAX_BITRATE for films, Settings' choice for a share), step 1 is 128 kbps above
// 2% loss, step 2 is 64 kbps above 5%. A smaller stream costs the link less, so the picture and the
// retransmissions keep room, and Opus's forward error correction has less to carry. One step back up
// after 30 seconds of clean reports. A report that did not arrive is not calm: only fresh ones count.
// No RED (a second copy of every packet): Opus's in-band FEC is on in the SDP and costs nothing extra.
export const AUDIO_STEP_CAPS_BPS = [Infinity, 128_000, 64_000]
export const AUDIO_STEP_LOSS_PCT = [2, 5]
export const AUDIO_RECOVER_MS = 30_000

export function chooseAudioStep(previous, {receiver = null, receiverAt = null} = {}, intervalMs = 2000) {
  let step = previous?.step ?? 0
  let calmMs = previous?.calmMs ?? 0
  let decision = 'holding'
  const fresh = receiver != null && receiverAt != null && receiverAt !== previous?.receiverAt
  if (fresh) {
    const loss = receiver.lossPct
    const wanted = loss > AUDIO_STEP_LOSS_PCT[1] ? 2 : loss > AUDIO_STEP_LOSS_PCT[0] ? 1 : 0
    if (wanted > step) {
      step = wanted
      calmMs = 0
      decision = 'loss'
    } else if (loss > AUDIO_STEP_LOSS_PCT[0]) {
      calmMs = 0 // still lossy, already as low as the loss asks: stay
    } else if (step > 0) {
      calmMs += intervalMs
      decision = 'calm'
      if (calmMs >= AUDIO_RECOVER_MS) {
        step -= 1
        calmMs = 0
        decision = 'recovery'
      }
    }
  }
  return {step, calmMs, receiverAt: fresh ? receiverAt : previous?.receiverAt ?? null, decision, lossPct: fresh ? receiver.lossPct : previous?.lossPct ?? null}
}

export const audioCapBps = (step, configuredBps) => Math.min(configuredBps, AUDIO_STEP_CAPS_BPS[step] ?? AUDIO_STEP_CAPS_BPS.at(-1))
