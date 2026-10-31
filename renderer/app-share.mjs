// Pure decisions for a whole-app share: native/win-app-windows reports where the app's windows
// and the windows covering them are, and these turn that into what part of the monitor capture
// to show (the app's windows, minus anything on top of them) and how to crop it. The capture
// itself is in app-share-track.mjs.

export const MAX_WINDOWS = 256
// The crop grows at once when a plugin window opens, and only shrinks back after the app has
// stayed smaller this long, so closing and reopening a window doesn't keep resizing the stream.
export const SHRINK_AFTER_MS = 3000
// Crop edges snap outward to this grid: small moves don't change the stream's size, and the
// encoder gets dimensions it likes.
export const CROP_GRID = 16

const isInt = (value) => Number.isInteger(value) && Math.abs(value) < 1e6

// The helper's line, {"monitor":[x,y,w,h],"windows":[[x,y,w,h,own],...]} topmost first, as
// {monitor: {x, y, width, height}, windows: [{x, y, width, height, own}]}, or null for junk.
export function cleanLayout(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.monitor) || !Array.isArray(value.windows)) return null
  const [x, y, width, height] = value.monitor
  if (value.monitor.length !== 4 || ![x, y, width, height].every(isInt) || width <= 0 || height <= 0) return null
  if (value.windows.length > MAX_WINDOWS) return null
  const windows = []
  for (const entry of value.windows) {
    if (!Array.isArray(entry) || entry.length !== 5 || !entry.slice(0, 4).every(isInt) || (entry[4] !== 0 && entry[4] !== 1)) return null
    if (entry[2] <= 0 || entry[3] <= 0) continue
    windows.push({x: entry[0], y: entry[1], width: entry[2], height: entry[3], own: entry[4] === 1})
  }
  return {monitor: {x, y, width, height}, windows}
}

export const sameMonitor = (a, b) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height

// The parts of `rect` that `cut` doesn't cover: up to four pieces (above, below, left, right).
export function subtract(rect, cut) {
  const left = Math.max(rect.x, cut.x)
  const top = Math.max(rect.y, cut.y)
  const right = Math.min(rect.x + rect.width, cut.x + cut.width)
  const bottom = Math.min(rect.y + rect.height, cut.y + cut.height)
  if (left >= right || top >= bottom) return [rect]
  const pieces = []
  if (top > rect.y) pieces.push({x: rect.x, y: rect.y, width: rect.width, height: top - rect.y})
  if (bottom < rect.y + rect.height) pieces.push({x: rect.x, y: bottom, width: rect.width, height: rect.y + rect.height - bottom})
  if (left > rect.x) pieces.push({x: rect.x, y: top, width: left - rect.x, height: bottom - top})
  if (right < rect.x + rect.width) pieces.push({x: right, y: top, width: rect.x + rect.width - right, height: bottom - top})
  return pieces
}

// What the share shows, relative to the monitor's top-left: the app's windows, painted bottom to
// top, with every other window on top of them cut out, so nothing from another app comes through.
export function visibleRegion(layout) {
  let region = []
  for (const win of [...layout.windows].reverse()) {
    const rect = {x: win.x - layout.monitor.x, y: win.y - layout.monitor.y, width: win.width, height: win.height}
    region = win.own ? [...region, rect] : region.flatMap((piece) => subtract(piece, rect))
  }
  return region
}

export function regionBounds(region) {
  if (!region.length) return null
  const left = Math.min(...region.map((r) => r.x))
  const top = Math.min(...region.map((r) => r.y))
  const right = Math.max(...region.map((r) => r.x + r.width))
  const bottom = Math.max(...region.map((r) => r.y + r.height))
  return {x: left, y: top, width: right - left, height: bottom - top}
}

// `bounds` snapped outward to CROP_GRID, kept inside the monitor (which is `width`×`height`).
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

// The next crop, from the last one (`state`: {box, smallerSince}) and the region now showing. A
// share starts on the whole monitor until the app shows something; with nothing showing (the app
// minimized), the crop stays where it was.
export function settleCrop(state, region, monitor, now) {
  const bounds = regionBounds(region)
  const box = state?.box || snapBox(bounds || {x: 0, y: 0, width: monitor.width, height: monitor.height}, monitor.width, monitor.height)
  if (!bounds) return {box, smallerSince: null}
  const wanted = snapBox(bounds, monitor.width, monitor.height)
  if (!state?.box || sameBox(box, wanted)) return {box: wanted, smallerSince: null}
  if (!contains(box, wanted)) {
    const grown = union(box, wanted)
    return {box: grown, smallerSince: sameBox(grown, wanted) ? null : now}
  }
  const since = state.smallerSince ?? now
  return now - since >= SHRINK_AFTER_MS ? {box: wanted, smallerSince: null} : {box, smallerSince: since}
}
