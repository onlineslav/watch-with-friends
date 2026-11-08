import test from 'node:test'
import assert from 'node:assert/strict'
import {updateClock, estimatedMediaTime, chooseSendQuality, chooseAudioStep, audioCapBps, aggregateLinks} from '../renderer/sync.mjs'
import {adaptBuffer, MAX_BUFFER_MS} from '../renderer/telemetry.mjs'

test('media clock accounts for transit and stops extrapolating a stalled host', () => {
  const clock = updateClock(null, 100, 200, 1150)
  assert.equal(clock.offset, 1000)
  const state = {time: 10, sentAt: 1200, receivedAt: 300, duration: 100, playing: true}
  assert.equal(estimatedMediaTime(state, 1300, clock), 11.1)
  assert.equal(estimatedMediaTime({...state, playing: false}, 1300, clock), 10)
  assert.ok(estimatedMediaTime(state, 100000, clock) <= 18.1)
  assert.equal(updateClock(clock, 100, 90, 100), clock)
})

test('persistent packet loss lowers quality while buffering stays bounded', () => {
  let quality = null, buffer = {bufferMs: 250, calmMs: 0}
  for (let i = 0; i < 12; i++) {
    quality = chooseSendQuality(quality, {receiver: {lossPct: 5}, width: 1920, height: 1080})
    buffer = adaptBuffer(buffer, true, 2000)
  }
  assert.ok(quality.bitrate < 1e6)
  assert.ok(quality.scale >= 3)
  assert.equal(buffer.bufferMs, MAX_BUFFER_MS)
  const reduced = quality.bitrate
  for (let i = 0; i < 24; i++) quality = chooseSendQuality(quality, {receiver: {lossPct: 0}})
  assert.ok(quality.bitrate > reduced)
})

test('quality respects dimensions, congestion and group upload budget', () => {
  const quality = chooseSendQuality({bitrate: 10e6}, {receiver: {lossPct: 5}, peerCount: 7, width: 3840, height: 2160, capacity: 1e6})
  assert.ok(quality.bitrate <= 800000)
  assert.ok(quality.scale >= 6)
  const peers = Array.from({length: 7}, () => chooseSendQuality({bitrate: 10e6}, {peerCount: 7}))
  assert.ok(peers.reduce((n, p) => n + p.bitrate, 0) <= 18e6 + 7)
})

test('a low bandwidth estimate alone does not lock a clean stream into a smaller picture', () => {
  let quality = {bitrate: 4e6}
  for (let i = 0; i < 3; i++) {
    quality = chooseSendQuality(quality, {receiver: {lossPct: 0, freezes: 0}, capacity: 350000})
    assert.ok(quality.bitrate >= 4e6)
    assert.equal(quality.scale, 1)
  }
})

test('quality recovers from the floor promptly when bandwidth returns', () => {
  let quality = {bitrate: 300000}
  for (let i = 0; i < 8; i++) {
    quality = chooseSendQuality(quality, {receiver: {lossPct: 0, freezes: 0}, capacity: 6e6, width: 1920, height: 800})
  }
  assert.ok(quality.bitrate >= 4e6, `still capped at ${quality.bitrate} after 16 clean seconds`)
  assert.equal(quality.scale, 1)
})

test('clean playback probes beyond an estimate left low by the previous send ceiling', () => {
  let quality = {bitrate: 300000}
  for (let i = 0; i < 15; i++) {
    quality = chooseSendQuality(quality, {receiver: {lossPct: 0, freezes: 0}, capacity: 1200000})
  }
  assert.ok(quality.bitrate >= 4e6, `still capped at ${quality.bitrate} after 30 clean seconds`)
  assert.equal(quality.scale, 1)
})

test('a receiver report is consumed once even when host sampling runs ahead of the viewer', () => {
  const input = {receiver: {lossPct: 5, freezes: 1}, receiverAt: 1000, capacity: 6e6}
  const reduced = chooseSendQuality({bitrate: 4e6}, input)
  const repeated = chooseSendQuality(reduced, input)
  assert.equal(repeated.bitrate, reduced.bitrate)
  assert.equal(repeated.calmMs, 0)
  assert.equal(reduced.decision, 'freezes')
  assert.equal(repeated.decision, 'duplicate-feedback')
  const next = chooseSendQuality(repeated, {...input, receiverAt: 3000})
  assert.ok(next.bitrate < repeated.bitrate)
})

test('reusing a clean report cannot accumulate the recovery window', () => {
  const input = {receiver: {lossPct: 0, freezes: 0}, receiverAt: 1000, capacity: 6e6}
  let quality = chooseSendQuality({bitrate: 300000}, input)
  for (let i = 0; i < 20; i++) quality = chooseSendQuality(quality, input)
  assert.equal(quality.bitrate, 300000)
  assert.equal(quality.calmMs, 2000)
  assert.equal(quality.decision, 'duplicate-feedback')
})

test('paused playback and missing feedback cannot manufacture a recovery', () => {
  for (const input of [{active: false, receiver: {lossPct: 5, freezes: 1}, capacity: 100000}, {capacity: 10e6}]) {
    let quality = {bitrate: 600000, calmMs: 4000}
    for (let i = 0; i < 40; i++) quality = chooseSendQuality(quality, input)
    assert.equal(quality.bitrate, 600000)
    assert.equal(quality.calmMs, 0)
    assert.equal(quality.decision, input.active === false ? 'inactive' : 'no-feedback')
  }
})

test('quality diagnostics identify recovery, settling, the ceiling and group budget changes', () => {
  const clean = {receiver: {lossPct: 0, freezes: 0}}
  assert.equal(chooseSendQuality({bitrate: 300000}, clean).decision, 'settling')
  assert.equal(chooseSendQuality({bitrate: 300000, calmMs: 4000}, clean).decision, 'recovery')
  assert.equal(chooseSendQuality({bitrate: 10e6, calmMs: 6000}, clean).decision, 'ceiling')
  const group = chooseSendQuality({bitrate: 10e6}, {...clean, peerCount: 7})
  assert.equal(group.decision, 'group-budget')
  assert.equal(group.ceiling, 18e6 / 7)
  assert.equal(chooseSendQuality({...group, calmMs: 0}, {...clean, peerCount: 7}).decision, 'settling', 'rounding cannot manufacture another group reduction')
})

test('group health uses one complete peer record', () => {
  const good = {rttMs: 10, sender: {limit: 'none'}, receiver: {lossPct: 0}}
  const bad = {rttMs: 150, sender: {limit: 'bandwidth'}, receiver: {lossPct: 10}}
  assert.equal(aggregateLinks([good, bad]), bad)
})

// Replays of a real night (0.7.1 logs, host and viewer): the cap went 4 -> 6.1 -> 7.7 Mbps in two
// seconds on an estimate of 7.7-8.9 Mbps, the viewer's link choked at ~5.9 Mbps actually sent (82%
// loss, 12.8s ping), and then the viewer's reports stopped arriving while the cap only held.
const clean = {lossPct: 0, freezes: 0}
function feed(quality, reports, extra = {}) {
  for (const receiver of reports) quality = chooseSendQuality(quality, {receiver, receiverAt: (quality?.receiverAt ?? 0) + 2000, capacity: 8e6, ...extra})
  return quality
}

test('above the starting rate the cap climbs one probe at a time, not on the bandwidth estimate', () => {
  let quality = feed({bitrate: 4e6}, [clean, clean])
  assert.equal(quality.decision, 'recovery')
  assert.equal(quality.bitrate, 5e6, 'a 25% probe, not a jump to 80% of an 8 Mbps estimate')
  quality = feed(quality, [clean])
  assert.equal(quality.bitrate, 5e6, 'the first report after a raise mostly predates it')
  quality = feed(quality, [clean])
  assert.equal(quality.bitrate, 6.25e6, 'two fresh clean reports later, the next probe')
})

test('below the starting rate recovery still uses the estimate', () => {
  const quality = feed({bitrate: 1e6, calmMs: 4000}, [clean])
  assert.equal(quality.bitrate, 2e6, 'doubles toward 80% of the estimate')
})

test('a viewer report that stops arriving during playback lowers the cap', () => {
  const held = chooseSendQuality({bitrate: 6e6, receiverAt: 1000}, {receiver: clean, receiverAt: 1000, feedbackAgeMs: 2500})
  assert.equal(held.decision, 'duplicate-feedback', 'one late report is normal: the two clocks drift')
  assert.equal(held.bitrate, 6e6)
  let quality = chooseSendQuality(held, {receiver: clean, receiverAt: 1000, feedbackAgeMs: 4500})
  assert.equal(quality.decision, 'stale-feedback')
  assert.equal(quality.bitrate, 4.5e6)
  quality = chooseSendQuality(quality, {receiver: clean, receiverAt: 1000, feedbackAgeMs: 6500})
  assert.equal(quality.bitrate, 3.375e6, 'keeps backing off while the reports stay missing')
  const paused = chooseSendQuality({bitrate: 6e6, receiverAt: 1000}, {active: false, receiver: clean, receiverAt: 1000, feedbackAgeMs: 60_000})
  assert.equal(paused.bitrate, 6e6, 'paused playback is not trouble')
})

test('heavy loss halves the cap', () => {
  assert.equal(chooseSendQuality({bitrate: 6e6}, {receiver: {lossPct: 5, freezes: 0}}).bitrate, 4.5e6)
  assert.equal(chooseSendQuality({bitrate: 6e6}, {receiver: {lossPct: 60, freezes: 0}}).bitrate, 3e6)
})

test('after a stall the cap stays below what was being sent when it began, for a minute of calm', () => {
  let quality = chooseSendQuality({bitrate: 7.67e6, receiverAt: 0}, {receiver: {lossPct: 0, freezes: 1}, receiverAt: 2000, sentBps: 5.9e6})
  assert.equal(quality.failedAt, 5.9e6, 'the rate really going out, not the 7.67 Mbps cap above it')
  quality = chooseSendQuality(quality, {receiver: {lossPct: 0, freezes: 1}, receiverAt: 4000, sentBps: 3e6})
  assert.equal(quality.failedAt, 5.9e6, 'a second cut in the same episode keeps where it began')
  let peak = 0
  for (let t = 2; t <= 30; t++) {
    quality = chooseSendQuality(quality, {receiver: clean, receiverAt: 4000 + t * 2000, capacity: 9e6})
    peak = Math.max(peak, quality.bitrate)
  }
  assert.ok(peak <= 5.9e6 * 0.85 + 1, `climbed to ${peak} within a minute of the stall`)
  for (let t = 31; t <= 45; t++) quality = chooseSendQuality(quality, {receiver: clean, receiverAt: 4000 + t * 2000, capacity: 9e6})
  assert.equal(quality.failedAt, null, 'forgotten after a minute of clean playback')
  assert.ok(quality.bitrate > 5.9e6, `free to probe again, at ${quality.bitrate}`)
})

test('one clean report in the middle of a jam does not restart the stall memory at the jammed rate', () => {
  // 2026-11-08, host log: freezes at 3.65 Mbps sent, then loss and missed reports; one clean report at
  // 05:22:40; the next missed report used to set the memory to the 434 kbps trickling through the jam.
  let quality = chooseSendQuality({bitrate: 10e6, receiverAt: 0}, {receiver: {lossPct: 0, freezes: 1}, receiverAt: 2000, sentBps: 3.65e6})
  quality = chooseSendQuality(quality, {receiver: {lossPct: 72, freezes: 0}, receiverAt: 4000, sentBps: 5.1e6})
  quality = chooseSendQuality(quality, {receiver: clean, receiverAt: 6000, sentBps: 3e5})
  quality = chooseSendQuality(quality, {receiver: clean, receiverAt: 6000, feedbackAgeMs: 4500, sentBps: 434431})
  assert.equal(quality.failedAt, 3.65e6, 'still the rate the trouble began at')
  for (let i = 0; i < 10; i++) quality = chooseSendQuality(quality, {receiver: clean, receiverAt: 8000 + i * 2000, capacity: 12.5e6})
  assert.ok(quality.bitrate >= 3e6, `back near 720p within 20s, at ${quality.bitrate}`)
})

test('a raise held by the stall memory is logged as holding, not as recovery', () => {
  const quality = chooseSendQuality({bitrate: 369266, calmMs: 4000, failedAt: 434431, sinceTroubleMs: 2000, receiverAt: 0}, {receiver: clean, receiverAt: 2000, capacity: 12.5e6})
  assert.equal(quality.bitrate, 369266)
  assert.equal(quality.decision, 'holding-below-stall')
})

test('a long run of cuts down to the floor does not pin recovery there', () => {
  let quality = {bitrate: 4e6}
  for (let i = 0; i < 12; i++) quality = chooseSendQuality(quality, {receiver: {lossPct: 5}, receiverAt: i * 2000})
  assert.equal(quality.bitrate, 300000)
  for (let i = 12; i < 22; i++) quality = chooseSendQuality(quality, {receiver: clean, receiverAt: i * 2000, capacity: 6e6})
  assert.ok(quality.bitrate >= 2e6, `only ${quality.bitrate} after 20 clean seconds`)
})

// ---------- audio steps (M1.6) ----------

const tick = (state, reading, count = 1) => {
  for (let i = 0; i < count; i++) state = chooseAudioStep(state, reading, 2000)
  return state
}
const limited = {limit: 'bandwidth', capacity: 2_000_000}
const squeezed = {limit: 'none', capacity: 900_000}
const clear = {limit: 'none', capacity: 8_000_000}
const warm = (state = null) => tick(state, clear, 15) // 30s: past the start-up window, where nothing counts

test('the audio ceiling has one step, a 128 kbps floor, and never goes below the configured cap', () => {
  assert.deepEqual([0, 1, 2].map((step) => audioCapBps(step, 256_000)), [256_000, 128_000, 128_000])
  assert.deepEqual([0, 1].map((step) => audioCapBps(step, 96_000)), [96_000, 96_000], 'a lower setting is left alone')
  assert.deepEqual([0, 1].map((step) => audioCapBps(step, 510_000)), [510_000, 128_000])
})

test('random loss alone never lowers the audio: only congestion does', () => {
  // Reports of heavy loss on a link that is not congested (the sender is not bandwidth-limited and the
  // estimate is high) change nothing, however long they last.
  let state = tick(null, clear, 60)
  assert.equal(state.step, 0)
  assert.equal(chooseAudioStep(state, {limit: 'cpu', capacity: 5_000_000}).step, 0, 'a cpu limit is not the link')
  assert.equal(chooseAudioStep(null, {}).step, 0, 'no readings at all')
})

test('nothing counts in the first 30s: a connection ramping up looks bandwidth-limited on any link', () => {
  const state = tick(null, limited, 14) // 28s of "bandwidth limited" and a 900 kbps estimate
  assert.equal(state.step, 0)
  assert.equal(tick(null, squeezed, 14).step, 0)
  assert.equal(tick(state, limited).step, 1, 'the first reading after the window, with the 4s already counted, takes the step')
})

test('a sender limited by bandwidth takes the step after ~4s, a low estimate after ~10s', () => {
  let state = tick(warm(), limited)
  assert.equal(state.step, 0, 'one reading is not enough')
  state = tick(state, limited)
  assert.equal(state.step, 1)
  assert.equal(state.decision, 'bandwidth-limited')
  let low = tick(warm(), squeezed, 4)
  assert.equal(low.step, 0, '8s under 1.5 Mbps: the estimate may still be climbing')
  low = tick(low, squeezed)
  assert.equal(low.step, 1)
  assert.equal(low.decision, 'low-estimate')
  // A start-up estimate that climbs past 1.5 Mbps before 10s never counts.
  let ramp = tick(null, {limit: 'none', capacity: 300_000}, 3)
  ramp = tick(ramp, {limit: 'none', capacity: 4_000_000}, 20)
  assert.equal(ramp.step, 0)
})

test('the audio goes back up after 30s with neither condition, and a flicker does not reset the climb', () => {
  let state = tick(warm(), limited, 2)
  assert.equal(state.step, 1)
  state = tick(state, clear, 14)
  assert.equal(state.step, 1, '28s: not yet')
  state = tick(state, clear)
  assert.equal(state.step, 0)
  assert.equal(state.decision, 'recovery')
  // Congestion again during the wait restarts it.
  state = tick(warm(), limited, 2)
  state = tick(state, clear, 10)
  state = tick(state, limited, 2)
  state = tick(state, clear, 14)
  assert.equal(state.step, 1)
})

test('a bandwidth limit with a plentiful estimate is an encoder wanting more, not congestion', () => {
  assert.equal(tick(warm(), {limit: 'bandwidth', capacity: 6_000_000}, 20).step, 0)
  assert.equal(tick(warm(), {limit: 'bandwidth', capacity: 2_000_000}, 2).step, 1)
  assert.equal(tick(warm(), {limit: 'bandwidth'}, 2).step, 1, 'no estimate known: the limit counts')
})

test('with "keep audio quality" on the ladder is never used', () => {
  const state = tick(null, {...limited, enabled: false}, 30)
  assert.equal(state.step, 0)
  assert.equal(state.decision, 'off')
  // Turning it on while a step is taken puts the audio straight back.
  const stepped = tick(warm(), limited, 2)
  assert.equal(chooseAudioStep(stepped, {...limited, enabled: false}).step, 0)
})

// M1.7: `npm run bench -- --variant=burst` (a 10% loss burst of 4s on a clean loopback link, 1080p film). Reports arrive every
// 2s; three clean ones used to be needed before the first raise and the picture was back at full size 7.6-10.7s after the
// burst ended. Two are enough now, and the stall memory (the cap stays under 85% of the failed rate for a minute) is untouched.
test('after a short loss burst the picture is back at full size within 10s of clean reports', () => {
  let quality = {bitrate: 7.8e6}
  quality = feed(quality, [{lossPct: 4.6, freezes: 1}, {lossPct: 10, freezes: 1}, {lossPct: 8, freezes: 1}], {sentBps: 7.8e6, width: 1920, height: 1080})
  assert.ok(quality.scale > 1, `the burst took the picture below full size (${quality.scale})`)
  let seconds = 0
  while (quality.scale > 1 && seconds < 60) {
    quality = feed(quality, [clean], {sentBps: quality.bitrate, width: 1920, height: 1080})
    seconds += 2
  }
  assert.ok(seconds <= 10, `full size again after ${seconds}s of clean reports`)
  assert.ok(quality.bitrate <= 7.8e6 * 0.85 + 1, 'the stall memory still holds the cap under 85% of the failed rate')
})
