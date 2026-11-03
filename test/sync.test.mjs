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
  assert.equal(chooseSendQuality(group, {...clean, peerCount: 7}).decision, 'settling', 'rounding cannot manufacture another group reduction')
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
  let quality = feed({bitrate: 4e6}, [clean, clean, clean])
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

test('a long run of cuts down to the floor does not pin recovery there', () => {
  let quality = {bitrate: 4e6}
  for (let i = 0; i < 12; i++) quality = chooseSendQuality(quality, {receiver: {lossPct: 5}, receiverAt: i * 2000})
  assert.equal(quality.bitrate, 300000)
  for (let i = 12; i < 22; i++) quality = chooseSendQuality(quality, {receiver: clean, receiverAt: i * 2000, capacity: 6e6})
  assert.ok(quality.bitrate >= 2e6, `only ${quality.bitrate} after 20 clean seconds`)
})

// ---------- audio steps (M1.6) ----------

const report = (lossPct, at) => ({receiver: {lossPct}, receiverAt: at})
function audioFeed(state, losses, startAt = 1) {
  const steps = []
  losses.forEach((lossPct, i) => {
    state = chooseAudioStep(state, report(lossPct, startAt + i), 2000)
    steps.push(state.step)
  })
  return {state, steps}
}

test('audio steps down 256 -> 128 -> 64 kbps at above 2% and above 5% loss, and not at or below 2%', () => {
  assert.deepEqual([0, 1, 2, 3].map((step) => audioCapBps(step, 256_000)), [256_000, 128_000, 64_000, 64_000])
  assert.deepEqual(audioFeed(null, [0, 1, 2]).steps, [0, 0, 0], 'up to 2% is left alone')
  assert.deepEqual(audioFeed(null, [2.5]).steps, [1])
  assert.deepEqual(audioFeed(null, [5.1]).steps, [2])
  assert.deepEqual(audioFeed(null, [3, 6]).steps, [1, 2])
  // The cap never goes above what is configured: a share set to 96 kbps stays at 96, and still drops to 64.
  assert.deepEqual([0, 1, 2].map((step) => audioCapBps(step, 96_000)), [96_000, 96_000, 64_000])
  assert.deepEqual([0, 1, 2].map((step) => audioCapBps(step, 510_000)), [510_000, 128_000, 64_000])
})

test('at 5% loss the audio steps down within 10 seconds (one report every 2s)', () => {
  const losses = [4.6, 5.3, 4.8, 5.2, 4.9]
  const {steps} = audioFeed(null, losses)
  assert.deepEqual(steps, [1, 2, 2, 2, 2], 'the first report above 2% takes the first step, the first above 5% the second, and it stays down while the loss lasts')
})

test('audio steps back up one at a time after 30 seconds of clean reports, and only fresh reports count', () => {
  let {state} = audioFeed(null, [7])
  assert.equal(state.step, 2)
  const calm = (count, from) => audioFeed(state, Array(count).fill(0), from)
  let run = calm(14, 10) // 28s
  assert.equal(run.state.step, 2, 'not yet')
  state = run.state
  run = calm(1, 30)
  assert.equal(run.state.step, 1, 'one step after 30s')
  state = run.state
  run = calm(14, 40)
  assert.equal(run.state.step, 1)
  state = run.state
  run = calm(1, 60)
  assert.equal(run.state.step, 0, 'then the next, 30s later')
  // A stale (repeated) report is not calm.
  state = chooseAudioStep(null, report(7, 1), 2000)
  for (let i = 0; i < 40; i++) state = chooseAudioStep(state, report(0, 1), 2000) // the same report, again and again
  assert.equal(state.step, 2)
  // Loss that is above 2% but already as low as it asks for resets the clock.
  state = chooseAudioStep(null, report(7, 1), 2000)
  state = audioFeed(state, Array(10).fill(0), 2).state
  state = chooseAudioStep(state, report(3, 12), 2000)
  assert.equal(state.step, 2)
  assert.equal(state.calmMs, 0)
  // No receiver report at all (a viewer that has not reported): nothing changes.
  assert.equal(chooseAudioStep(state, {receiver: null, receiverAt: null}, 2000).step, 2)
})
