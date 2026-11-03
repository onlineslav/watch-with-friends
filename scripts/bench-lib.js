// Pure parts of `npm run bench` (scripts/bench.js), unit-tested in test/bench.test.js: the clip's
// schedule, the ffmpeg arguments that draw it, and the arithmetic that turns what a viewer saw and heard
// into numbers. Nothing here touches Electron, the network or a speaker.
const FPS = 30
const SAMPLE_RATE = 48000
const FLASH_FRAMES = 4 // a flash patch lasts this many frames; the rising edge is what is timed
const BEEP_SECONDS = 0.15
const STEADY_FROM = 10 // seconds of clip time: ramp-up (jitter buffers, bitrate estimate) is not steady state
const PATCH = {x: 0, y: 0, w: 0.25, h: 0.25} // fraction of the picture; black except during a flash

// Small seeded generator, so every run (and every release) plays the same irregular clip.
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Events at irregular gaps of at least `minGap` seconds, each on a frame boundary so the flash's first
// frame and the beep's first sample are the same instant in the file. `t` is that instant in seconds.
function makeSchedule({seed = 1, count = 28, first = 3, minGap = 2, maxGap = 3.6, fps = FPS} = {}) {
  const next = rng(seed)
  const events = []
  let frame = Math.round(first * fps)
  for (let index = 0; index < count; index++) {
    events.push({index, frame, t: frame / fps})
    frame += Math.round((minGap + next() * (maxGap - minGap)) * fps)
  }
  return {fps, events, duration: events.at(-1).t + 3}
}

const num = (value) => Number(value.toFixed(6)).toString()
// A tiny lead so the sample or frame sitting exactly on the boundary counts as inside the window.
const EPS = 0.00001

function videoFilter(schedule) {
  const window = schedule.events.map((e) => `between(t,${num(e.t - 0.001)},${num(e.t + FLASH_FRAMES / schedule.fps - 0.001)})`).join('+')
  const box = (color, extra = '') => `drawbox=x=iw*${PATCH.x}:y=ih*${PATCH.y}:w=iw*${PATCH.w}:h=ih*${PATCH.h}:color=${color}:t=fill${extra}`
  return `${box('black')},${box('white', `:enable='${window}'`)}`
}

function beepExpression(schedule) {
  const gate = schedule.events.map((e) => `between(t,${num(e.t - EPS)},${num(e.t + BEEP_SECONDS - EPS)})`).join('+')
  return `0.5*sin(2*PI*1000*t)*(${gate})`
}

// Moving testsrc2 picture with the flash patch, a quiet bed tone (a different pitch per channel, so a
// stereo path can be told from a mono one) under 1kHz beeps. FLAC in Matroska: no lossy generation
// before the app's own, and no encoder delay to explain a constant offset.
function clipArgs(schedule, output) {
  const d = num(schedule.duration)
  return [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=${schedule.fps}:duration=${d}`,
    '-f', 'lavfi', '-i', `aevalsrc=0.03*sin(2*PI*220*t)|0.03*sin(2*PI*330*t):s=${SAMPLE_RATE}:d=${d}`,
    '-f', 'lavfi', '-i', `aevalsrc='${beepExpression(schedule)}':s=${SAMPLE_RATE}:d=${d}`,
    '-filter_complex', `[0:v]${videoFilter(schedule)}[v];[2:a]pan=stereo|c0=c0|c1=c0[beep];[1:a][beep]amix=inputs=2:normalize=0:duration=first[a]`,
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24', '-pix_fmt', 'yuv420p', '-g', String(schedule.fps),
    '-c:a', 'flac', '-ar', String(SAMPLE_RATE), '-t', d,
    output,
  ]
}

// The clip's own audio as raw interleaved float32, what a capture helper writes to stdout.
const pcmArgs = (clip, output) => ['-v', 'error', '-y', '-i', clip, '-vn', '-f', 'f32le', '-acodec', 'pcm_f32le', '-ac', '2', '-ar', String(SAMPLE_RATE), output]

function sorted(values) {
  return [...values].filter(Number.isFinite).sort((a, b) => a - b)
}

function percentile(values, p) {
  const list = sorted(values)
  if (!list.length) return null
  const at = (list.length - 1) * p
  const low = Math.floor(at)
  const high = Math.ceil(at)
  return list[low] + (list[high] - list[low]) * (at - low)
}

const median = (values) => percentile(values, 0.5)
const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null)
function stddev(values) {
  if (values.length < 2) return null
  const m = mean(values)
  return Math.sqrt(values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1))
}
const round = (value, digits = 2) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null)

// Rising edges of the flash patch: the first frame whose brightness crosses the midpoint after a frame
// below it. `frames` is [{time, luma}] in presentation order; `time` is when it is expected on screen.
function risingEdges(frames, {low = 80, high = 170} = {}) {
  const edges = []
  let armed = false
  for (const frame of frames) {
    if (frame.luma <= low) armed = true
    else if (frame.luma >= high && armed) {
      edges.push(frame.time)
      armed = false
    }
  }
  return edges
}

// Pairs each flash with the beep nearest in time (flashes are at least 2s apart, so a pairing further
// apart than `maxGapMs` means the two are not the same event, not a sync error to report).
function pairEvents(flashes, beeps, maxGapMs = 1000) {
  const pairs = []
  const used = new Set()
  for (const flash of flashes) {
    let best = -1
    for (let i = 0; i < beeps.length; i++) {
      if (used.has(i)) continue
      if (best < 0 || Math.abs(beeps[i] - flash) < Math.abs(beeps[best] - flash)) best = i
    }
    if (best >= 0 && Math.abs(beeps[best] - flash) <= maxGapMs) {
      used.add(best)
      pairs.push({flash, beep: beeps[best], offset: beeps[best] - flash})
    }
  }
  return pairs
}

// Which scheduled event each detected time is. The clip's gaps are irregular on purpose, so the one
// shift that lines the detected times up with the schedule is unambiguous even if some were missed or a
// stray one was seen: try each scheduled event as the first detection, then follow the schedule's own
// gaps from each match to the next (so a delay that grows over the clip does not break the pairing).
function alignToSchedule(times, eventTimes, toleranceMs = 400) {
  let best = {matches: [], error: Infinity}
  if (!times.length) return best
  for (let shift = 0; shift < eventTimes.length; shift++) {
    const matches = [{time: times[0], index: shift}]
    let error = 0
    for (let i = 1; i < times.length; i++) {
      const last = matches.at(-1)
      let at = -1
      let gap = Infinity
      for (let e = last.index + 1; e < eventTimes.length; e++) {
        const predicted = last.time + (eventTimes[e] - eventTimes[last.index]) * 1000
        if (Math.abs(predicted - times[i]) < gap) { gap = Math.abs(predicted - times[i]); at = e }
        if (predicted > times[i] + toleranceMs) break
      }
      if (at >= 0 && gap <= toleranceMs) {
        matches.push({time: times[i], index: at})
        error += gap
      }
    }
    if (matches.length > best.matches.length || (matches.length === best.matches.length && error < best.error)) best = {matches, error}
  }
  return best
}

// Offset = when the beep is heard minus when the flash is shown: positive means the sound is late.
function summarizeOffsets(offsets) {
  const abs = offsets.map(Math.abs)
  const worst = offsets.reduce((w, v) => (Math.abs(v) > Math.abs(w) ? v : w), 0)
  return {
    n: offsets.length,
    medianMs: round(median(offsets), 1), medianAbsMs: round(median(abs), 1),
    p95AbsMs: round(percentile(abs, 0.95), 1), worstMs: offsets.length ? round(worst, 1) : null,
    meanMs: round(mean(offsets), 1), stddevMs: round(stddev(offsets), 1),
  }
}

// Least-squares slope of y against x: how fast the offset wanders over the clip (ms per second).
function slope(points) {
  const n = points.length
  if (n < 3) return null
  const mx = mean(points.map((p) => p[0]))
  const my = mean(points.map((p) => p[1]))
  let num = 0
  let den = 0
  for (const [x, y] of points) {
    num += (x - mx) * (y - my)
    den += (x - mx) ** 2
  }
  return den ? num / den : null
}

// Frame cadence from the times each distinct frame was due on screen.
function cadence(times, nominalMs) {
  const gaps = []
  for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1])
  const late = gaps.filter((g) => g > nominalMs * 1.5).length
  return {
    frames: times.length,
    intervalMeanMs: round(mean(gaps), 2), intervalStddevMs: round(stddev(gaps), 2),
    intervalP95Ms: round(percentile(gaps, 0.95), 2), intervalMaxMs: round(Math.max(...gaps, 0), 2),
    lateFrames: late, lateFramePct: gaps.length ? round((late / gaps.length) * 100, 2) : null,
  }
}

// Concealed samples that were not just silence, as a share of the samples that arrived, between two
// getStats readings (the first taken after ramp-up).
function concealment(from, to) {
  if (!from || !to) return null
  const concealed = to.concealed - from.concealed
  const silent = to.silent - from.silent
  const samples = to.samples - from.samples
  return {concealedSamples: concealed, silentSamples: silent, netSamples: concealed - silent, totalSamples: samples, pct: samples > 0 ? round(((concealed - silent) / samples) * 100, 3) : null}
}

// A line through (contextTime, performanceTime) pairs from getOutputTimestamp(): the context's clock
// against the page's, as the median offset (the pair itself jitters by a quantum or so per call).
function clockMap(samples) {
  const offsets = samples.filter((s) => s.perf > 0).map((s) => s.perf - s.ctx * 1000)
  return {offsetMs: median(offsets), spreadMs: round(percentile(offsets, 0.95) - percentile(offsets, 0.05), 3), n: offsets.length}
}

const heardAt = (map, frame, sampleRate) => map.offsetMs + (frame / sampleRate) * 1000

const STEADY = STEADY_FROM
module.exports = {
  FPS, SAMPLE_RATE, FLASH_FRAMES, BEEP_SECONDS, PATCH, STEADY,
  rng, makeSchedule, videoFilter, beepExpression, clipArgs, pcmArgs,
  sorted, percentile, median, mean, stddev, round, slope,
  risingEdges, pairEvents, alignToSchedule, summarizeOffsets, cadence, concealment, clockMap, heardAt,
}
