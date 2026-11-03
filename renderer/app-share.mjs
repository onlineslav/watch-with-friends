// Pure decisions for a whole-app share: native/win-app-windows reports where the app's windows
// are, app-share-track.mjs captures each one on its own, and these decide which captures to run,
// what part of the desktop to show (settleCrop) and at what size (outputSize).

export const MAX_WINDOWS = 64
// Crop edges past the shared window snap outward to this grid: small moves of a plugin window
// outside it don't change the stream's size.
export const CROP_GRID = 16
// A capture outlives its window disappearing by this long: an app that hides its plugin windows
// while it's in the background (Ableton does) gets them back without a new capture starting.
export const KEEP_HIDDEN_MS = 15_000
// Hardware H.264 encoders top out around here; a share spanning several monitors is scaled to fit.
export const MAX_OUTPUT = {width: 3840, height: 2160}

const isInt = (value) => Number.isInteger(value) && Math.abs(value) < 1e6

export const MAX_APP_NAME = 80

// The helper's line, {"desktop":[x,y,w,h],"minimized":0|1,"app":"name","windows":[[x,y,w,h,hwnd],...]}
// topmost first, as {desktop: {x, y, width, height}, minimized, app, windows: [{x, y, width,
// height, hwnd}]} with the windows' positions relative to the desktop's top-left, or null for junk.
export function cleanLayout(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.desktop) || !Array.isArray(value.windows)) return null
  const [x, y, width, height] = value.desktop
  if (value.desktop.length !== 4 || ![x, y, width, height].every(isInt) || width <= 0 || height <= 0) return null
  if (value.windows.length > MAX_WINDOWS) return null
  const windows = []
  for (const entry of value.windows) {
    if (!Array.isArray(entry) || entry.length !== 5 || !entry.slice(0, 4).every(isInt) || !Number.isSafeInteger(entry[4]) || entry[4] <= 0) return null
    if (entry[2] <= 0 || entry[3] <= 0) continue
    windows.push({x: entry[0] - x, y: entry[1] - y, width: entry[2], height: entry[3], hwnd: entry[4]})
  }
  const app = typeof value.app === 'string' ? value.app.slice(0, MAX_APP_NAME) : ''
  return {desktop: {x, y, width, height}, minimized: value.minimized === 1 || value.minimized === true, app, windows}
}

// What viewers see instead of the picture, or null while there's a picture: the shared window is
// minimized (Windows can't capture a minimized window), or none of the app's windows are on screen.
export function placeholderText(layout) {
  const app = layout.app || 'The shared app'
  if (layout.minimized) return {title: `${app} is minimized`, detail: 'It will show up here again once it is restored.'}
  if (!layout.windows.length) return {title: `${app} isn't on screen`, detail: 'It will show up here again once it is.'}
  return null
}

// Which window captures to start and stop. `captures` maps each captured hwnd to when its window
// was last in a layout; a window gone for KEEP_HIDDEN_MS is stopped, one that's new is started.
export function captureChanges(captures, layout, now) {
  const shown = new Set(layout.windows.map((win) => win.hwnd))
  const start = [...shown].filter((hwnd) => !captures.has(hwnd))
  const stop = [...captures].filter(([hwnd, seen]) => !shown.has(hwnd) && now - seen >= KEEP_HIDDEN_MS).map(([hwnd]) => hwnd)
  return {start, stop}
}

export function regionBounds(region) {
  if (!region.length) return null
  const left = Math.min(...region.map((r) => r.x))
  const top = Math.min(...region.map((r) => r.y))
  const right = Math.max(...region.map((r) => r.x + r.width))
  const bottom = Math.max(...region.map((r) => r.y + r.height))
  return {x: left, y: top, width: right - left, height: bottom - top}
}

// `bounds` snapped outward to CROP_GRID, kept inside the desktop (which is `width`×`height`).
export function snapBox(bounds, width, height) {
  const left = Math.max(0, Math.floor(bounds.x / CROP_GRID) * CROP_GRID)
  const top = Math.max(0, Math.floor(bounds.y / CROP_GRID) * CROP_GRID)
  const right = Math.min(width, Math.ceil((bounds.x + bounds.width) / CROP_GRID) * CROP_GRID)
  const bottom = Math.min(height, Math.ceil((bounds.y + bounds.height) / CROP_GRID) * CROP_GRID)
  return {x: left, y: top, width: right - left, height: bottom - top}
}

const contains = (outer, inner) =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height
const union = (a, b) => regionBounds([a, b])

const clip = (box, desktop) => {
  const left = Math.max(0, box.x)
  const top = Math.max(0, box.y)
  return {x: left, y: top, width: Math.min(desktop.width, box.x + box.width) - left, height: Math.min(desktop.height, box.y + box.height) - top}
}

// What the crop should be for these windows: exactly the shared window (`anchor`, an hwnd) while
// everything else is inside it, so a lone window goes out untouched and opening a plugin inside it
// doesn't change the stream's size; anything reaching outside it widens the crop to the grid.
export function cropTarget(windows, desktop, anchor) {
  const main = anchor == null ? null : windows.find((win) => win.hwnd === anchor)
  const others = windows.filter((win) => win !== main)
  const outside = others.length ? regionBounds(others) : null
  if (!main) return outside && snapBox(outside, desktop.width, desktop.height)
  const exact = clip(main, desktop)
  if (!outside || contains(exact, clip(outside, desktop))) return exact
  return clip(union(exact, snapBox(outside, desktop.width, desktop.height)), desktop)
}

// The next crop (`state`: {box}): straight to `cropTarget`, growing and shrinking alike, so the
// share follows the window as it's resized or a plugin is dragged in and out. (It used to shrink
// only after a wait, to spare the encoder resizes when plugins opened and closed; `cropTarget`
// hugging the shared window already does that, and the wait read as lag.) A share starts on the
// whole desktop until the app shows something; with nothing showing, the crop stays where it was.
export function settleCrop(state, windows, desktop, anchor) {
  const wanted = cropTarget(windows, desktop, anchor)
  if (!wanted || wanted.width <= 0 || wanted.height <= 0) return {box: state?.box || {x: 0, y: 0, width: desktop.width, height: desktop.height}}
  return {box: wanted}
}

// The stream's size for a crop box: the box itself (pixel for pixel, the same size a lone
// window's own capture is), scaled down only to fit `limit` (Settings' resolution, or
// MAX_OUTPUT), keeping its shape, to even numbers then.
export function outputSize(box, limit = MAX_OUTPUT) {
  const maxWidth = Math.min(limit?.width || Infinity, MAX_OUTPUT.width)
  const maxHeight = Math.min(limit?.height || Infinity, MAX_OUTPUT.height)
  const scale = Math.min(1, maxWidth / box.width, maxHeight / box.height)
  if (scale === 1) return {width: box.width, height: box.height, scale}
  const even = (value) => Math.max(2, Math.floor((value * scale) / 2) * 2)
  return {width: even(box.width), height: even(box.height), scale}
}

// A frame stamp (microseconds) on the page's performance.now() clock, for a worker that reads its own.
// A worker's performance.now() counts from the worker's creation, the page's from the page's; the two
// time origins are wall-clock times, so their difference is the offset between the clocks. WebRTC's
// lip-sync compares the video's stamps with the audio track's (app-audio.mjs stamps on the page's
// clock), so a video on any other base is held back or pushed ahead by the difference.
export function pageClockUs(workerNowMs, workerOrigin, pageOrigin) {
  return Math.round((workerNowMs + workerOrigin - pageOrigin) * 1000)
}
