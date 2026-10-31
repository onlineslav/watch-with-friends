import test from 'node:test'
import assert from 'node:assert/strict'
import {CROP_GRID, KEEP_HIDDEN_MS, MAX_OUTPUT, MAX_WINDOWS, SHRINK_AFTER_MS, captureChanges, cleanLayout, cropTarget, outputSize, regionBounds, settleCrop, snapBox} from '../renderer/app-share.mjs'

// The shape win-app-windows prints: Ableton's main window and one VST window on top of it.
const REAL_LINE = {desktop: [0, 0, 3440, 1440], windows: [[314, 213, 465, 593, 6362204], [0, 0, 2294, 1392, 40572320]]}
const desktop = {x: 0, y: 0, width: 1920, height: 1080}

test('cleanLayout accepts the helper line and rejects junk', () => {
  const clean = cleanLayout(REAL_LINE)
  assert.deepEqual(clean.desktop, {x: 0, y: 0, width: 3440, height: 1440})
  assert.deepEqual(clean.windows, [{x: 314, y: 213, width: 465, height: 593, hwnd: 6362204}, {x: 0, y: 0, width: 2294, height: 1392, hwnd: 40572320}])
  for (const junk of [
    null, 'x', {},
    {desktop: [0, 0, 0, 10], windows: []},
    {desktop: [0, 0, 10], windows: []},
    {desktop: [0, 0, 10, 10], windows: [[0, 0, 1, 1, 0]]},
    {desktop: [0, 0, 10, 10], windows: [[0, 0, 1, 1, -5]]},
    {desktop: [0, 0, 10, 10], windows: [[0, 0, 1.5, 1, 7]]},
    {desktop: [0, 0, 10, 10], windows: [[0, 0, 1, 1]]},
    {desktop: [0, 0, 10, 10], windows: Array(MAX_WINDOWS + 1).fill([0, 0, 1, 1, 7])},
  ]) {
    assert.equal(cleanLayout(junk), null, JSON.stringify(junk)?.slice(0, 80))
  }
  assert.deepEqual(cleanLayout({desktop: [0, 0, 10, 10], windows: [[0, 0, 0, 5, 7]]}).windows, [], 'empty windows are dropped')
})

test('cleanLayout puts windows relative to the desktop, for a monitor left of the main one', () => {
  const clean = cleanLayout({desktop: [-1920, 0, 3840, 1080], windows: [[-1800, 100, 400, 300, 9], [100, 50, 800, 600, 8]]})
  assert.deepEqual(clean.windows.map(({x, y}) => [x, y]), [[120, 100], [2020, 50]])
})

test('captureChanges starts new windows and stops ones gone long enough', () => {
  const layout = cleanLayout(REAL_LINE)
  assert.deepEqual(captureChanges(new Map(), layout, 0), {start: [6362204, 40572320], stop: []})
  assert.deepEqual(captureChanges(new Map([[6362204, 0], [40572320, 0]]), layout, 0), {start: [], stop: []})
  const mainOnly = cleanLayout({...REAL_LINE, windows: [REAL_LINE.windows[1]]})
  const captures = new Map([[6362204, 1000], [40572320, 1000]])
  assert.deepEqual(captureChanges(captures, mainOnly, 1000 + KEEP_HIDDEN_MS - 1).stop, [], 'a hidden plugin window keeps its capture for a while')
  assert.deepEqual(captureChanges(captures, mainOnly, 1000 + KEEP_HIDDEN_MS).stop, [6362204], 'then it stops')
})

test('snapBox snaps outward to the grid and stays on the desktop', () => {
  assert.deepEqual(snapBox({x: 17, y: 1, width: 30, height: 30}, 1920, 1080), {x: 16, y: 0, width: 32, height: 32})
  assert.deepEqual(snapBox({x: 1900, y: 1070, width: 30, height: 30}, 1920, 1080), {x: 1888, y: 1056, width: 32, height: 24})
  const box = snapBox({x: 3, y: 5, width: 999, height: 333}, 1920, 1080)
  assert.equal(box.x % CROP_GRID, 0)
  assert.equal(box.width % CROP_GRID, 0)
})

test('settleCrop grows at once and shrinks only after the app stays smaller', () => {
  const main = [{x: 0, y: 0, width: 800, height: 600}]
  const withPlugin = [...main, {x: 800, y: 0, width: 400, height: 400}]
  let state = settleCrop(null, main, desktop, 0)
  assert.deepEqual(state.box, {x: 0, y: 0, width: 800, height: 608})
  state = settleCrop(state, withPlugin, desktop, 100)
  assert.deepEqual(state.box, {x: 0, y: 0, width: 1200, height: 608}, 'a plugin opening grows it right away')
  state = settleCrop(state, main, desktop, 200)
  assert.equal(state.box.width, 1200, 'closing it keeps the size for now')
  state = settleCrop(state, withPlugin, desktop, 1000)
  assert.equal(state.smallerSince, null, 'reopening it resets the wait')
  state = settleCrop(state, main, desktop, 1100)
  state = settleCrop(state, main, desktop, 1100 + SHRINK_AFTER_MS - 1)
  assert.equal(state.box.width, 1200)
  state = settleCrop(state, main, desktop, 1100 + SHRINK_AFTER_MS)
  assert.equal(state.box.width, 800, 'shrinks once it has stayed smaller long enough')
})

test('settleCrop starts on the whole desktop and holds still while nothing shows', () => {
  let state = settleCrop(null, [], desktop, 0)
  assert.deepEqual(state.box, {x: 0, y: 0, width: 1920, height: 1080})
  state = settleCrop({box: {x: 0, y: 0, width: 800, height: 608}, smallerSince: null}, [], desktop, 50)
  assert.deepEqual(state.box, {x: 0, y: 0, width: 800, height: 608}, 'minimized: keep the last crop')
})

test('outputSize is pixel for pixel unless a limit makes it smaller', () => {
  assert.deepEqual(outputSize({x: 0, y: 0, width: 2304, height: 1392}), {width: 2304, height: 1392, scale: 1})
  const fit = outputSize({x: 0, y: 0, width: 2304, height: 1392}, {width: 1920, height: 1080})
  assert.ok(fit.width <= 1920 && fit.height <= 1080)
  assert.ok(Math.abs(fit.width / fit.height - 2304 / 1392) < 0.01, 'keeps its shape')
  assert.equal(fit.width % 2 + fit.height % 2, 0, 'even sizes')
  const wide = outputSize({x: 0, y: 0, width: 7680, height: 1440})
  assert.ok(wide.width <= MAX_OUTPUT.width, 'a share across monitors fits what encoders take')
})

test('cropTarget hugs the shared window exactly until something reaches outside it', () => {
  const main = {x: 0, y: 0, width: 1720, height: 1392, hwnd: 1}
  const proQ = {x: 82, y: 216, width: 1299, height: 887, hwnd: 2}
  const wide = {width: 3440, height: 1440}
  assert.deepEqual(cropTarget([main], wide, 1), {x: 0, y: 0, width: 1720, height: 1392}, 'a lone window: its exact frame, no grid')
  assert.deepEqual(cropTarget([proQ, main], wide, 1), {x: 0, y: 0, width: 1720, height: 1392}, 'a plugin inside it changes nothing')
  const dragged = cropTarget([{...proQ, x: 1000}, main], wide, 1)
  assert.equal(dragged.x, 0)
  assert.ok(dragged.width >= 2299 && dragged.width < 2299 + CROP_GRID, `dragged past the edge: widened to the grid (${dragged.width})`)
  assert.deepEqual(cropTarget([{...main, x: -8, y: -8, width: 1736, height: 1408}], wide, 1), {x: 0, y: 0, width: 1728, height: 1400}, 'kept on the desktop')
  assert.deepEqual(cropTarget([proQ], wide, 1), snapBox(proQ, 3440, 1440), 'the shared window hidden: the rest, on the grid')
  assert.equal(cropTarget([], wide, 1), null)
})

test('settleCrop shrinks back once a plugin dragged outside comes back in', () => {
  const main = {x: 0, y: 0, width: 1720, height: 1392, hwnd: 1}
  const proQ = {x: 82, y: 216, width: 1299, height: 887, hwnd: 2}
  const wide = {width: 3440, height: 1440}
  let state = settleCrop(null, [proQ, main], wide, 0, 1)
  for (let x = 82, t = 10; x <= 1500; x += 50, t += 10) state = settleCrop(state, [{...proQ, x}, main], wide, t, 1)
  assert.ok(state.box.width > 2700, 'grew while dragged out')
  let t = 1000
  for (let x = 1500; x >= 82; x -= 50, t += 10) state = settleCrop(state, [{...proQ, x: Math.max(82, x)}, main], wide, t, 1)
  state = settleCrop(state, [proQ, main], wide, t + SHRINK_AFTER_MS + 10, 1)
  assert.deepEqual(state.box, {x: 0, y: 0, width: 1720, height: 1392}, 'back to exactly the main window')
})

test('regionBounds spans every window', () => {
  assert.equal(regionBounds([]), null)
  assert.deepEqual(regionBounds([{x: 10, y: 10, width: 5, height: 5}, {x: 0, y: 20, width: 2, height: 2}]), {x: 0, y: 10, width: 15, height: 12})
})
