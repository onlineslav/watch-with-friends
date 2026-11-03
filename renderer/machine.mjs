// How hard the computer is working while the app runs: the renderer's own side of the machine-load
// readings in the diagnostic log. Pure and unit-tested apart from watchLongTasks, which only wires
// the browser's observer to a tally. The per-process CPU and memory come from the main process
// (main/machine.js) and are pushed here, so a sample never waits on a round trip for them.

const round = (value, places = 0) => (Number.isFinite(value) ? Math.round(value * 10 ** places) / 10 ** places : null)

// Renderer long tasks (the browser's own definition: a main-thread task over 50 ms). Counted between
// samples, because one stall in a 2-second window is what shows up as a dropped frame or a late
// control message. `supported` is false where the observer doesn't exist, so "none happened" and
// "can't tell" read differently in the log.
export class LongTaskTally {
  constructor() {
    this.supported = false
    this.reset()
  }

  reset() {
    this.n = 0
    this.total = 0
    this.max = 0
  }

  add(entries) {
    for (const entry of entries || []) {
      const duration = Number(entry?.duration)
      if (!Number.isFinite(duration) || duration < 0) continue
      this.n++
      this.total += duration
      if (duration > this.max) this.max = duration
    }
  }

  // null: can't tell; 0: none; otherwise {n, ms, max}.
  take() {
    if (!this.supported) return null
    const out = this.n ? {n: this.n, ms: Math.round(this.total), max: Math.round(this.max)} : 0
    this.reset()
    return out
  }
}

export function watchLongTasks(tally, Observer = globalThis.PerformanceObserver) {
  try {
    if (!Observer?.supportedEntryTypes?.includes('longtask')) return false
    new Observer((list) => tally.add(list.getEntries())).observe({type: 'longtask'})
    tally.supported = true
    return true
  } catch {
    return false
  }
}

// Spacing of the frames the host forwards to WebRTC (renderer/frames.mjs): mean and worst gap between
// consecutive frames, and how many times a frame was skipped because the previous write was still in
// flight. `reset()` forgets the last frame time at a pause or seek, so the gap that follows isn't a stall.
export class IntervalMeter {
  constructor() {
    this.last = null
    this.clear()
  }

  clear() {
    this.n = 0
    this.sum = 0
    this.max = 0
    this.busy = 0
  }

  mark(now) {
    if (this.last != null && now >= this.last) {
      const gap = now - this.last
      this.n++
      this.sum += gap
      if (gap > this.max) this.max = gap
    }
    this.last = now
  }

  skip() { this.busy++ }

  reset() { this.last = null }

  // {n, avg, max, busy} in ms, or null when nothing was forwarded or skipped since the last take.
  take() {
    const out = this.n || this.busy ? {n: this.n, avg: round(this.n ? this.sum / this.n : null, 1), max: round(this.n ? this.max : null, 1), busy: this.busy || null} : null
    this.clear()
    return out
  }
}

// Delays measured since the last sample, for the log (M1.9): the worst of them, or null when nothing
// arrived. The worst, not the average, because a queue that builds for a moment is the thing sought.
export class DelayTally {
  constructor() { this.max = null }
  add(ms) {
    if (Number.isFinite(ms) && (this.max === null || ms > this.max)) this.max = ms
  }
  take() {
    const out = this.max === null ? null : round(this.max, 1)
    this.max = null
    return out
  }
}

export const frameSpacing = new IntervalMeter()

// The latest reading pushed by main, kept only while it is fresh enough to belong to this sample.
export const MACHINE_FRESH_MS = 6000

export function freshMachine(latest, now, maxAgeMs = MACHINE_FRESH_MS) {
  return latest?.reading && now - latest.at <= maxAgeMs ? latest.reading : null
}

// The Settings that shape what is sent, so a change in quality can be matched to one in the log.
export function settingsTag({priority, audioBitrate, audioFirst}) {
  return {pri: priority ?? null, ab: Number.isFinite(audioBitrate) ? audioBitrate : null, af: audioFirst === false ? 0 : 1}
}
