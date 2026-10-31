// A whole-app share: every window the app has open (getLayout(), the latest cleaned
// win-app-windows layout) is captured on its own, and this draws them together the way they sit
// on screen, into a MediaStreamTrackGenerator the way frames.mjs does for films. A window
// capture shows the window's own content even where something covers it, so another app's window
// on top neither hides part of the share nor leaks into it; only the gaps between the app's
// windows are black. `captureWindow(hwnd)` resolves with a capture track for one window;
// `initial` is the shared window's capture, already started. Untested here for the same reason
// frames.mjs is: the frame APIs only exist in a real renderer.
import {captureChanges, outputSize, settleCrop} from './app-share.mjs'

// A still screen sends few frames; one at least this often keeps a joining viewer's picture coming.
const KEEPALIVE_MS = 500
// A window that couldn't be captured isn't tried again for this long.
const RETRY_MS = 5000

export function appShareTrack({getLayout, captureWindow, initial, limits, onCaptureError}) {
  if (typeof MediaStreamTrackProcessor !== 'function' || typeof MediaStreamTrackGenerator !== 'function' || typeof OffscreenCanvas !== 'function') return null
  const generator = new MediaStreamTrackGenerator({kind: 'video'})
  const writer = generator.writable.getWriter()
  const canvas = new OffscreenCanvas(2, 2)
  const context = canvas.getContext('2d', {alpha: false})
  const captures = new Map() // hwnd → {track, reader, frame, seen}
  const pending = new Set() // hwnds whose capture is starting
  const failed = new Map() // hwnd → when its capture last failed
  let current = {...limits}
  let queue = Promise.resolve()
  let crop = null
  let lastLayout = null
  let dirty = true
  let lastSent = 0
  let writing = false
  let stopped = false
  let timer = null

  const drop = (hwnd) => {
    const entry = captures.get(hwnd)
    if (!entry) return
    captures.delete(hwnd)
    entry.frame?.close()
    entry.reader.cancel().catch(() => {})
    entry.track.stop()
    dirty = true
  }

  // Keeps only the newest frame of each window; a capture that ends (its window closed) drops out.
  const watch = (hwnd, track) => {
    const entry = {track, reader: new MediaStreamTrackProcessor({track}).readable.getReader(), frame: null, seen: performance.now()}
    captures.set(hwnd, entry)
    ;(async () => {
      try {
        for (;;) {
          const {value, done} = await entry.reader.read()
          if (done) break
          if (stopped || captures.get(hwnd) !== entry) {
            value.close()
            break
          }
          entry.frame?.close()
          entry.frame = value
          dirty = true
        }
      } catch {}
      if (captures.get(hwnd) === entry) drop(hwnd)
    })()
  }

  // One at a time: main grants each getDisplayMedia call exactly one window, in order.
  const start = (hwnd) => {
    pending.add(hwnd)
    queue = queue.then(async () => {
      try {
        if (stopped) return
        const track = await captureWindow(hwnd)
        if (stopped) return track.stop()
        failed.delete(hwnd)
        watch(hwnd, track)
      } catch (error) {
        failed.set(hwnd, performance.now())
        onCaptureError?.(hwnd, error)
      } finally {
        pending.delete(hwnd)
      }
    })
  }

  const reconcile = (layout, now) => {
    for (const win of layout.windows) {
      const entry = captures.get(win.hwnd)
      if (entry) entry.seen = now
    }
    const known = new Map([...captures].map(([hwnd, entry]) => [hwnd, entry.seen]))
    for (const hwnd of pending) known.set(hwnd, now)
    const {start: wanted, stop: gone} = captureChanges(known, layout, now)
    for (const hwnd of wanted) if (!(now - (failed.get(hwnd) ?? -Infinity) < RETRY_MS)) start(hwnd)
    for (const hwnd of gone) drop(hwnd)
  }

  // Bottom window first, each at its place in the crop, scaled with it.
  const compose = (layout, now) => {
    crop = settleCrop(crop, layout.windows, layout.desktop, now)
    const {box} = crop
    const size = outputSize(box, current)
    if (canvas.width !== size.width || canvas.height !== size.height) {
      canvas.width = size.width
      canvas.height = size.height
    }
    const sx = size.width / box.width
    const sy = size.height / box.height
    context.fillStyle = '#000'
    context.fillRect(0, 0, size.width, size.height)
    for (const win of [...layout.windows].reverse()) {
      const frame = captures.get(win.hwnd)?.frame
      if (!frame) continue
      try {
        context.drawImage(frame, (win.x - box.x) * sx, (win.y - box.y) * sy, win.width * sx, win.height * sy)
      } catch {
        drop(win.hwnd) // its capture ended under it (the window closed): the next layout leaves it out
      }
    }
    return new VideoFrame(canvas, {timestamp: Math.round(now * 1000)})
  }

  const tick = () => {
    if (stopped) return
    const now = performance.now()
    const layout = getLayout()
    if (layout !== lastLayout) {
      lastLayout = layout
      dirty = true
    }
    reconcile(layout, now)
    if (writing || (!dirty && now - lastSent < KEEPALIVE_MS)) return
    if (![...captures.values()].some((entry) => entry.frame)) return
    dirty = false
    lastSent = now
    const frame = compose(layout, now)
    // getSettings() on a generated track has no size; tuneSenders reads this instead.
    generator.frameSize = {width: canvas.width, height: canvas.height}
    writing = true
    writer
      .write(frame)
      .catch(() => {
        frame.close()
        stop() // the share's track was stopped
      })
      .finally(() => (writing = false))
  }

  const run = () => {
    clearInterval(timer)
    timer = setInterval(tick, 1000 / current.frameRate)
  }

  function stop() {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    for (const hwnd of [...captures.keys()]) drop(hwnd)
    writer.close().catch(() => {})
  }

  // Settings' resolution and frame rate, applied live: the output size, and how often it's drawn.
  function setLimits(limits) {
    current = {...limits}
    dirty = true
    for (const {track} of captures.values()) track.applyConstraints({frameRate: {ideal: current.frameRate, max: current.frameRate}}).catch(() => {})
    if (!stopped) run()
  }

  watch(initial.hwnd, initial.track)
  run()
  return {track: generator, stop, setLimits}
}
