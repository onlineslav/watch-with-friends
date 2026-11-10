// Skipping: the "Skip intro" button, the on-screen "Skipped forward 30s" flash, and what Previous
// does. Pure, tested in test/skip.test.mjs; app.js does the drawing.

// The intro the host found ({start, end} in seconds, main/intro.js), checked on arrival. A bad one
// is dropped, never the whole state: older and newer copies must keep understanding each other.
export function cleanIntro(value, duration) {
  if (!value || typeof value !== 'object') return null
  const {start, end} = value
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end - start < 5 || end - start > 600) return null
  if (duration && end > duration) return null
  return {start, end}
}

// The button shows from the intro's start until just before its end (skipping the last second and a
// half would only be a jump), and not before the media is under way.
export const INTRO_LEAD_S = 0.5
export const INTRO_TAIL_S = 1.5
export function introShowing(intro, time) {
  return Boolean(intro) && Number.isFinite(time) && time >= intro.start - INTRO_LEAD_S && time < intro.end - INTRO_TAIL_S
}

// Presses in a row add up ("Skipped forward 1m 30s" after three), like a remote's skip button.
export const SKIP_CHAIN_MS = 1200
export function chainSkip(last, seconds, now) {
  const same = last && now - last.at < SKIP_CHAIN_MS && Math.sign(last.total) === Math.sign(seconds)
  return {total: (same ? last.total : 0) + seconds, at: now}
}

export function formatSkip(seconds) {
  const s = Math.round(Math.abs(seconds))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60), rest = s % 60
  return rest ? `${m}m ${rest}s` : `${m}m`
}

export const skipText = (total) => `Skipped ${total < 0 ? 'back' : 'forward'} ${formatSkip(total)}`

// Previous restarts what's playing unless it has only just begun, like every music player.
export const RESTART_AFTER_S = 5
export const previousAction = (time, hasPrevious) => (time > RESTART_AFTER_S || !hasPrevious ? 'restart' : 'previous')
