import test from 'node:test'
import assert from 'node:assert/strict'
import {GAP_MS, NUDGE_MAX_MS, SAMPLE_RATE, createAudioStamper} from '../renderer/app-audio.mjs'
import {pageClockUs} from '../renderer/app-share.mjs'

const QUANTUM = 960 // 20ms
const ms = (us) => us / 1000

// A page clock the test moves by hand, and a stamper reading it.
function setup() {
  const clock = {t: 0}
  return {clock, stamper: createAudioStamper({now: () => clock.t})}
}

test('the first quantum is stamped on the page clock, not from zero', () => {
  const {clock, stamper} = setup()
  clock.t = 90_000 // the page has been up for 90s when the audio track starts
  stamper.arrive(QUANTUM) // 20ms of audio just arrived
  // the newest sample is "now", so the quantum began 20ms ago
  assert.equal(ms(stamper.stamp(QUANTUM)), 90_000 - 20)
})

test('quanta follow each other, however the pulls are cut', () => {
  const {clock, stamper} = setup()
  clock.t = 5000
  stamper.arrive(QUANTUM * 2) // one pull carrying two quanta
  const a = stamper.stamp(QUANTUM)
  const b = stamper.stamp(QUANTUM)
  assert.equal(b - a, 20_000) // within one flush: exact
  clock.t += 40 // the next pull is right on time (40ms of audio later)
  stamper.arrive(QUANTUM * 2)
  assert.ok(Math.abs(stamper.stamp(QUANTUM) - b - 20_000) < 100)
  assert.deepEqual(stamper.reanchors, {gap: 0})
})

test('pull jitter moves the stamps by well under a millisecond', () => {
  const {clock, stamper} = setup()
  clock.t = 1000
  stamper.arrive(QUANTUM)
  let last = stamper.stamp(QUANTUM)
  for (let i = 0; i < 200; i++) {
    clock.t += 20 + (i % 2 ? 9 : -9) // pulls arrive up to 9ms early or late
    stamper.arrive(QUANTUM)
    const stamp = stamper.stamp(QUANTUM)
    assert.ok(Math.abs(stamp - last - 20_000) < 300, `step ${stamp - last}`)
    last = stamp
  }
  assert.deepEqual(stamper.reanchors, {gap: 0})
})

test('a helper clock that runs fast or slow is followed, not accumulated', () => {
  for (const ppm of [-1000, 1000]) {
    const {clock, stamper} = setup()
    clock.t = 1000
    let last = 0
    // 120s of 20ms pulls whose audio clock is `ppm` away from the page's
    for (let i = 0; i < 6000; i++) {
      clock.t += 20 * (1 - ppm / 1e6)
      stamper.arrive(QUANTUM)
      last = stamper.stamp(QUANTUM)
    }
    const error = ms(last) - (clock.t - 20)
    assert.ok(Math.abs(error) < 5, `${ppm}ppm left the stamps ${error}ms from the clock`)
  }
})

test('after a delivery gap the stamps jump to the clock instead of lagging behind it', () => {
  const {clock, stamper} = setup()
  clock.t = 1000
  stamper.arrive(QUANTUM)
  stamper.stamp(QUANTUM)
  clock.t += 20 + 4000 // nothing for four seconds (a silent app on the Mac helper), then 20ms of audio
  stamper.arrive(QUANTUM)
  const after = ms(stamper.stamp(QUANTUM))
  assert.ok(Math.abs(after - (clock.t - 20)) < 1, `stamped ${after}, the clock reads ${clock.t}`)
  assert.equal(stamper.reanchors.gap, 1)
  // and it carries on from there
  clock.t += 20
  stamper.arrive(QUANTUM)
  assert.ok(Math.abs(ms(stamper.stamp(QUANTUM)) - (clock.t - 20)) < 1)
  assert.equal(stamper.reanchors.gap, 1)
})

test('a lateness under the gap threshold is absorbed, one over it re-anchors', () => {
  const under = setup()
  under.clock.t = 1000
  under.stamper.arrive(QUANTUM)
  under.stamper.stamp(QUANTUM)
  under.clock.t += 20 + GAP_MS - 5
  under.stamper.arrive(QUANTUM)
  assert.equal(under.stamper.reanchors.gap, 0)
  const over = setup()
  over.clock.t = 1000
  over.stamper.arrive(QUANTUM)
  over.stamper.stamp(QUANTUM)
  over.clock.t += 20 + GAP_MS + 5
  over.stamper.arrive(QUANTUM)
  assert.equal(over.stamper.reanchors.gap, 1)
})

test('a burst of old audio is absorbed gradually, never in one step', () => {
  const {clock, stamper} = setup()
  clock.t = 1000
  stamper.arrive(QUANTUM)
  stamper.stamp(QUANTUM)
  clock.t += 20
  stamper.arrive(QUANTUM * 50) // a stalled pipe lets go of a second at once
  let last = stamper.stamp(QUANTUM)
  for (let i = 1; i < 50; i++) last = stamper.stamp(QUANTUM)
  clock.t += 20
  const before = last
  stamper.arrive(QUANTUM)
  const next = stamper.stamp(QUANTUM)
  assert.ok(next > before, 'stamps keep moving forward')
  assert.ok(next - before >= (20 - NUDGE_MAX_MS) * 1000 - 1, `moved ${next - before}us`)
  assert.deepEqual(stamper.reanchors, {gap: 0})
})

test('the first sample is never stamped before zero', () => {
  const {stamper} = setup()
  stamper.arrive(SAMPLE_RATE) // a second of audio arriving at clock 0
  assert.equal(stamper.stamp(QUANTUM), 0)
})

test('a worker frame is stamped on the page clock', () => {
  // The worker was created 40s after the page, and reads 2.5s on its own clock: that is 42.5s on the page's.
  const pageOrigin = 1_700_000_000_000
  assert.equal(pageClockUs(2500, pageOrigin + 40_000, pageOrigin), 42_500_000)
  // The page itself (same origin) is unchanged from the plain performance.now() stamp frames.mjs uses.
  assert.equal(pageClockUs(1234.5, pageOrigin, pageOrigin), 1_234_500)
})
