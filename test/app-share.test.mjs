import test from 'node:test'
import assert from 'node:assert/strict'
import {CROP_GRID, MAX_WINDOWS, SHRINK_AFTER_MS, cleanLayout, regionBounds, sameMonitor, settleCrop, snapBox, subtract, visibleRegion} from '../renderer/app-share.mjs'

// The line win-app-windows printed for a real Ableton window: taskbar and two windows on top.
const REAL_LINE = {monitor: [0, 0, 3440, 1440], windows: [[0, 1392, 3440, 48, 0], [1720, 0, 1720, 1392, 0], [0, 0, 1720, 1392, 0], [1146, 0, 2294, 1392, 1]]}
const monitor = {x: 0, y: 0, width: 1920, height: 1080}
const layout = (windows, at = monitor) => ({monitor: at, windows})
const win = (x, y, width, height, own) => ({x, y, width, height, own})
const area = (region) => region.reduce((sum, r) => sum + r.width * r.height, 0)

test('cleanLayout accepts the helper line and rejects junk', () => {
  const clean = cleanLayout(REAL_LINE)
  assert.deepEqual(clean.monitor, {x: 0, y: 0, width: 3440, height: 1440})
  assert.deepEqual(clean.windows.at(-1), {x: 1146, y: 0, width: 2294, height: 1392, own: true})
  assert.equal(clean.windows[0].own, false)
  for (const junk of [null, 'x', {}, {monitor: [0, 0, 0, 10], windows: []}, {monitor: [0, 0, 10], windows: []}, {monitor: [0, 0, 10, 10], windows: [[0, 0, 1, 1, 2]]}, {monitor: [0, 0, 10, 10], windows: [[0, 0, 1.5, 1, 1]]}, {monitor: [0, 0, 10, 10], windows: Array(MAX_WINDOWS + 1).fill([0, 0, 1, 1, 1])}]) {
    assert.equal(cleanLayout(junk), null, JSON.stringify(junk)?.slice(0, 80))
  }
  assert.deepEqual(cleanLayout({monitor: [0, 0, 10, 10], windows: [[0, 0, 0, 5, 1]]}).windows, [], 'empty windows are dropped')
})

test('subtract leaves the uncovered pieces of a rectangle', () => {
  const rect = {x: 0, y: 0, width: 100, height: 100}
  assert.deepEqual(subtract(rect, {x: 200, y: 0, width: 10, height: 10}), [rect])
  assert.deepEqual(subtract(rect, {x: -10, y: -10, width: 200, height: 200}), [])
  const pieces = subtract(rect, {x: 25, y: 25, width: 50, height: 50})
  assert.equal(pieces.length, 4)
  assert.equal(area(pieces), 100 * 100 - 50 * 50)
})

test('visibleRegion shows the app and cuts out every other window on top of it', () => {
  // A plugin window floats over the app's main window; another app covers part of the plugin.
  const other = {x: 500, y: 300, width: 200, height: 200}
  const region = visibleRegion(layout([win(other.x, other.y, other.width, other.height, false), win(400, 200, 300, 300, true), win(0, 0, 1000, 800, true)]))
  assert.equal(area(region), (1000 * 800 - 200 * 200) + (300 * 300 - 200 * 200), 'main and plugin, each minus what the other window hides')
  for (const piece of region) assert.deepEqual(subtract(piece, other), [piece], 'nothing under the covering window shows')
  assert.deepEqual(regionBounds(region), {x: 0, y: 0, width: 1000, height: 800})
  // A window below the app doesn't cut anything.
  assert.equal(area(visibleRegion(layout([win(0, 0, 100, 100, true), win(0, 0, 100, 100, false)]))), 100 * 100)
  // Coordinates come out relative to the monitor, for a monitor that isn't at the origin.
  assert.deepEqual(visibleRegion(layout([win(2000, 100, 50, 50, true)], {x: 1920, y: 0, width: 1920, height: 1080})), [{x: 80, y: 100, width: 50, height: 50}])
})

test('visibleRegion on the real Ableton line keeps only its uncovered strip', () => {
  const region = visibleRegion(cleanLayout(REAL_LINE))
  assert.deepEqual(regionBounds(region), null, 'fully covered: the two side-by-side windows hide all of it')
})

test('snapBox snaps outward to the grid and stays on the monitor', () => {
  assert.deepEqual(snapBox({x: 17, y: 1, width: 30, height: 30}, 1920, 1080), {x: 16, y: 0, width: 32, height: 32})
  assert.deepEqual(snapBox({x: 1900, y: 1070, width: 30, height: 30}, 1920, 1080), {x: 1888, y: 1056, width: 32, height: 24})
  const box = snapBox({x: 3, y: 5, width: 999, height: 333}, 1920, 1080)
  assert.equal(box.x % CROP_GRID, 0)
  assert.equal(box.width % CROP_GRID, 0)
})

test('settleCrop grows at once and shrinks only after the app stays smaller', () => {
  const main = [{x: 0, y: 0, width: 800, height: 600}]
  const withPlugin = [...main, {x: 800, y: 0, width: 400, height: 400}]
  let state = settleCrop(null, main, monitor, 0)
  assert.deepEqual(state.box, {x: 0, y: 0, width: 800, height: 608})
  state = settleCrop(state, withPlugin, monitor, 100)
  assert.deepEqual(state.box, {x: 0, y: 0, width: 1200, height: 608}, 'a plugin opening grows it right away')
  state = settleCrop(state, main, monitor, 200)
  assert.equal(state.box.width, 1200, 'closing it keeps the size for now')
  state = settleCrop(state, withPlugin, monitor, 1000)
  assert.equal(state.smallerSince, null, 'reopening it resets the wait')
  state = settleCrop(state, main, monitor, 1100)
  state = settleCrop(state, main, monitor, 1100 + SHRINK_AFTER_MS - 1)
  assert.equal(state.box.width, 1200)
  state = settleCrop(state, main, monitor, 1100 + SHRINK_AFTER_MS)
  assert.equal(state.box.width, 800, 'shrinks once it has stayed smaller long enough')
})

test('settleCrop starts on the whole monitor and holds still while nothing shows', () => {
  let state = settleCrop(null, [], monitor, 0)
  assert.deepEqual(state.box, {x: 0, y: 0, width: 1920, height: 1080})
  state = settleCrop({box: {x: 0, y: 0, width: 800, height: 608}, smallerSince: null}, [], monitor, 50)
  assert.deepEqual(state.box, {x: 0, y: 0, width: 800, height: 608}, 'minimized: keep the last crop')
})

test('sameMonitor compares all four edges', () => {
  assert.equal(sameMonitor(monitor, {...monitor}), true)
  assert.equal(sameMonitor(monitor, {...monitor, x: 1920}), false)
})
