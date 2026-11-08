'use strict'

// While someone is in a room, every Chromium process of the app (main, renderer, GPU, network and
// audio services) runs at above-normal priority on Windows, so other programs that keep every core
// busy cannot starve the stream.
//
// Found 2026-11-08: two freezes of a film to a friend (40s and 15s, ICE disconnected both ways) each
// began within 4 seconds of a test suite starting on the host's PC, with 15+ busy node processes on
// 16 threads. The host's pings to its own router, timed in user space, went from 1ms to 150-350ms, and
// the friend's machine and network stayed clean throughout. Reproduced with 48 busy threads and
// `npm run bench`: the viewer presented 9 frames/s, sound 2.7s off the picture, 321 kbps sent. With
// the app's processes above normal and the same load: 22 frames/s, 5ms, 5.2 Mbps.
//
// Above normal, not high: the app uses a few percent of one core, so it never takes much from the
// programs it now goes ahead of, and ffmpeg (which can use every core while transcoding) and the
// native helpers are separate processes left at normal priority. Raising a priority needs root on
// macOS and Linux, so this does nothing there. It is re-applied every 2 seconds, which catches
// processes started later (a new renderer or utility process) and any reset by Chromium.

const os = require('node:os')

const REAPPLY_MS = 2000
const LOG_EVERY_MS = 60_000

function createPriorityBoost({
  getMetrics,
  record = () => {},
  platform = process.platform,
  setPriority = os.setPriority,
  getPriority = os.getPriority,
  raised = os.constants.priority.PRIORITY_ABOVE_NORMAL,
  normal = os.constants.priority.PRIORITY_NORMAL,
  now = Date.now,
  setTimer = setInterval,
  clearTimer = clearInterval,
  intervalMs = REAPPLY_MS,
}) {
  let timer = null
  const boosted = new Set()
  let loggedAt = -Infinity
  let lastFailed = 0

  const pids = () => {
    try {
      return [...new Set((getMetrics() || []).map((proc) => proc?.pid).filter((pid) => Number.isInteger(pid) && pid > 0))]
    } catch {
      return []
    }
  }

  // Returns what it did, for the log and the tests: {n, set, failed}.
  const apply = () => {
    const list = pids()
    let set = 0
    let failed = 0
    for (const pid of list) {
      try {
        if (getPriority(pid) !== raised) {
          setPriority(pid, raised)
          set++
        }
        boosted.add(pid)
      } catch {
        failed++
      }
    }
    for (const pid of boosted) if (!list.includes(pid)) boosted.delete(pid)
    // The first pass, a change in failures, and otherwise a process raised again at most once a minute.
    const first = loggedAt === -Infinity
    if (first || failed !== lastFailed || (set > 0 && now() - loggedAt >= LOG_EVERY_MS)) {
      record('app', 'priority', {on: true, n: list.length, set, failed})
      loggedAt = now()
    }
    lastFailed = failed
    return {n: list.length, set, failed}
  }

  return {
    get active() { return timer != null },
    start() {
      if (platform !== 'win32' || timer) return null
      const result = apply()
      timer = setTimer(apply, intervalMs)
      timer?.unref?.()
      return result
    },
    stop() {
      if (!timer) return
      clearTimer(timer)
      timer = null
      let restored = 0
      for (const pid of boosted) {
        try { setPriority(pid, normal); restored++ } catch {}
      }
      boosted.clear()
      loggedAt = -Infinity
      lastFailed = 0
      record('app', 'priority', {on: false, restored})
    },
    apply,
  }
}

module.exports = {REAPPLY_MS, createPriorityBoost}
