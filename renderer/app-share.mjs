// Pure decisions for a whole-app share: native/win-app-windows reports where the app's windows
// are, app-share-track.mjs captures each one on its own, and these decide which captures to run,
// what part of the desktop to show (settleCrop) and at what size (outputSize).

export const MAX_WINDOWS = 64
// The crop grows at once when a plugin window opens, and only shrinks back after the app has
// stayed smaller this long, so closing and reopening a window doesn't keep resizing the stream.
export const SHRINK_AFTER_MS = 1500
// Crop edges snap outward to this grid: small moves don't change the stream's size, and the
// encoder gets dimensions it likes.
export const CROP_GRID = 16
// A capture outlives its window disappearing by this long: an app that hides its plugin windows
// while it's in the background (Ableton does) gets them back without a new capture starting.
export const KEEP_HIDDEN_MS = 15_000
// Hardware H.264 encoders top out around here; a share spanning several monitors is scaled to fit.
export const MAX_OUTPUT = {width: 3840, height: 2160}

const isInt = (value) => Number.isInteger(value) && Math.abs(value) < 1e6

// The helper's line, {"desktop":[x,y,w,h],"windows":[[x,y,w,h,hwnd],...]} topmost first, as
// {desktop: {x, y, width, height}, windows: [{x, y, width, height, hwnd}]} with the windows'
// positions relative to the desktop's top-left, or null for junk.
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
  return {desktop: {x, y, width, height}, windows}
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
const sameBox = (a, b) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
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

// The next crop, from the last one (`state`: {box, smallerSince}) and the app's windows now. A
// share starts on the whole desktop until the app shows something; with nothing showing (the app
// minimized), the crop stays where it was.
export function settleCrop(state, windows, desktop, now, anchor) {
  const wanted = cropTarget(windows, desktop, anchor)
  const box = state?.box || wanted || {x: 0, y: 0, width: desktop.width, height: desktop.height}
  if (!wanted || wanted.width <= 0 || wanted.height <= 0) return {box, smallerSince: null}
  if (!state?.box || sameBox(box, wanted)) return {box: wanted, smallerSince: null}
  if (!contains(box, wanted)) {
    const grown = union(box, wanted)
    return {box: grown, smallerSince: sameBox(grown, wanted) ? null : now}
  }
  const since = state.smallerSince ?? now
  return now - since >= SHRINK_AFTER_MS ? {box: wanted, smallerSince: null} : {box, smallerSince: since}
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
