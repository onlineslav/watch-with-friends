// The pure parts of `npm run bench` (scripts/bench-lib.js): the clip's schedule, the ffmpeg arguments that
// draw it, and the arithmetic that turns what a viewer saw and heard into numbers.
const test = require('node:test')
const assert = require('node:assert/strict')
const lib = require('../scripts/bench-lib')

test('the schedule is irregular, at least 2s apart, on frame boundaries, and the same every time', () => {
  const a = lib.makeSchedule()
  const b = lib.makeSchedule()
  assert.deepEqual(a, b)
  assert.ok(a.events.length >= 22 + 3, 'enough events after the 10s ramp-up for N >= 20')
  assert.ok(a.events.filter((e) => e.t >= lib.STEADY).length >= 20)
  const gaps = a.events.slice(1).map((e, i) => e.t - a.events[i].t)
  assert.ok(Math.min(...gaps) >= 2 - 1e-9)
  assert.ok(new Set(gaps.map((g) => g.toFixed(3))).size > 5, 'gaps differ')
  for (const e of a.events) assert.equal(e.frame, Math.round(e.t * a.fps))
  assert.notDeepEqual(lib.makeSchedule({seed: 2}).events, a.events)
})

test('the flash lasts at least 3 frames and starts exactly where the beep does', () => {
  assert.ok(lib.FLASH_FRAMES >= 3)
  const s = lib.makeSchedule({count: 2})
  const filter = lib.videoFilter(s)
  assert.match(filter, /color=black/)
  assert.match(filter, /color=white/)
  assert.equal((filter.match(/between/g) || []).length, 2)
  const first = s.events[0].t
  assert.ok(filter.includes(`between(t,${(first - 0.001).toFixed(3)},`))
  assert.ok(lib.beepExpression(s).includes(`between(t,${(first - 0.00001).toFixed(5)},`))
  const args = lib.clipArgs(s, 'out.mkv')
  assert.ok(args.includes('flac'), 'no lossy generation before the app')
  assert.equal(args.at(-1), 'out.mkv')
})

test('percentiles, median and the offset summary', () => {
  assert.equal(lib.median([3, 1, 2]), 2)
  assert.equal(lib.median([1, 2, 3, 4]), 2.5)
  assert.equal(lib.percentile([0, 10], 0.95), 9.5)
  assert.equal(lib.median([]), null)
  const s = lib.summarizeOffsets([10, -50, 30, 20])
  assert.equal(s.n, 4)
  assert.equal(s.medianMs, 15)
  assert.equal(s.worstMs, -50, 'the worst keeps its sign')
  assert.equal(s.medianAbsMs, 25)
  assert.equal(lib.summarizeOffsets([]).n, 0)
})

test('rising edges: the first bright frame after a dark one, once per flash', () => {
  const luma = [10, 10, 255, 255, 255, 255, 10, 120, 10, 255, 10]
  const frames = luma.map((l, i) => ({time: i * 33, luma: l}))
  // 120 is between the thresholds (not a flash), 255 at index 9 is
  assert.deepEqual(lib.risingEdges(frames), [66, 297])
  assert.deepEqual(lib.risingEdges([{time: 0, luma: 255}, {time: 1, luma: 255}]), [], 'a first frame already bright is not an edge')
})

test('pairing and aligning: nearest beep, and the schedule shift that explains the detections', () => {
  assert.deepEqual(lib.pairEvents([1000, 4000], [1050, 3900, 9000]).map((p) => Math.round(p.offset)), [50, -100])
  assert.deepEqual(lib.pairEvents([1000], [5000]), [], 'too far apart is a different event, not a sync error')
  const s = lib.makeSchedule()
  const times = s.events.map((e) => e.t)
  // detections of events 3.. with one missed and a delay growing by 40ms per event
  const seen = s.events.slice(3).filter((_, i) => i !== 4).map((e, i) => e.t * 1000 + 7000 + i * 40)
  const aligned = lib.alignToSchedule(seen, times)
  assert.equal(aligned.matches.length, seen.length)
  assert.equal(aligned.matches[0].index, 3)
  assert.equal(aligned.matches[4].index, 8, 'the missed event is skipped, not shifted into')
  assert.deepEqual(lib.alignToSchedule([], times).matches, [])
})

test('cadence: intervals, jitter and late frames', () => {
  const smooth = lib.cadence([0, 33.3, 66.6, 100, 133.3], 33.3)
  assert.equal(smooth.lateFrames, 0)
  assert.ok(smooth.intervalStddevMs < 0.1)
  const hitch = lib.cadence([0, 33, 66, 166, 199], 33.3)
  assert.equal(hitch.lateFrames, 1)
  assert.equal(hitch.intervalMaxMs, 100)
})

test('concealment is concealed minus silent, over the window, as a share of the samples that arrived', () => {
  const c = lib.concealment({concealed: 100, silent: 40, samples: 1000}, {concealed: 600, silent: 140, samples: 49000})
  assert.equal(c.netSamples, 400)
  assert.equal(c.totalSamples, 48000)
  assert.equal(c.pct, 0.833)
  assert.equal(lib.concealment(null, {}), null)
})

test('the audio clock maps to the page clock by readings, and a frame becomes a heard time', () => {
  const map = lib.clockMap([{ctx: 1, perf: 1450}, {ctx: 2, perf: 2452}, {ctx: 3, perf: 3451}, {ctx: 4, perf: 0}])
  assert.equal(map.offsetMs, 451)
  assert.equal(map.n, 3)
  assert.equal(lib.heardAt(map, 48000, 48000), 1451)
  assert.equal(lib.slope([[0, 0], [1, 10], [2, 20]]), 10)
  assert.equal(lib.slope([[0, 0]]), null)
})
