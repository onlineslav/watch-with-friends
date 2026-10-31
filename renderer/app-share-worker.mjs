// The frame work of a whole-app share, in a dedicated worker so none of it runs on the page's main
// thread: app-share-track.mjs hands over each window capture's frame stream and the output
// track's writable, and posts every layout. Bundled on its own to app-share-worker.js (the
// page's CSP only allows workers from the app's own files).
//
// A frame goes out when a window sends one (at most at Settings' frame rate), not on a timer that
// beats against the captures' own rate, which dropped and doubled frames unevenly. With only the
// shared window showing and nothing to crop, its frames go out untouched; otherwise the windows
// are drawn together, bottom first. A still screen still sends one at least every KEEPALIVE_MS.
import {outputSize, settleCrop} from './app-share.mjs'

const KEEPALIVE_MS = 500
const STATS_MS = 10_000

const windows = new Map() // hwnd → {reader, frame}
let writer = null
let layout = null
let anchor = null
let limits = {frameRate: 30}
let crop = null
let lastSent = -Infinity
let timer = 0
let stopped = false
let canvas = null
let context = null
let sentSize = ''
let sentCrop = ''
let cropPostedAt = -Infinity
let stats = {passed: 0, composed: 0, composeMs: 0, framesIn: 0, busy: 0}

const post = (message) => self.postMessage(message)
const minInterval = () => 1000 / limits.frameRate - 2 // a little early is fine; late doubles up

function schedule() {
  if (timer || stopped || !writer) return
  timer = setTimeout(send, Math.max(0, lastSent + minInterval() - performance.now()))
}

function watch(hwnd, readable) {
  const entry = {reader: readable.getReader(), frame: null}
  windows.get(hwnd)?.reader.cancel().catch(() => {})
  windows.get(hwnd)?.frame?.close()
  windows.set(hwnd, entry)
  ;(async () => {
    try {
      for (;;) {
        const {value, done} = await entry.reader.read()
        if (done) break
        if (stopped || windows.get(hwnd) !== entry) {
          value.close()
          break
        }
        entry.frame?.close()
        entry.frame = value
        stats.framesIn++
        schedule()
      }
    } catch {}
    if (windows.get(hwnd) !== entry) return
    drop(hwnd)
    post({type: 'ended', hwnd}) // its window closed: the page stops tracking that capture
  })()
}

function drop(hwnd) {
  const entry = windows.get(hwnd)
  if (!entry) return
  windows.delete(hwnd)
  entry.frame?.close()
  entry.reader.cancel().catch(() => {})
  schedule()
}

function compose(box, size) {
  if (!canvas) {
    canvas = new OffscreenCanvas(size.width, size.height)
    context = canvas.getContext('2d', {alpha: false, desynchronized: true})
  }
  if (canvas.width !== size.width || canvas.height !== size.height) {
    canvas.width = size.width
    canvas.height = size.height
  }
  const sx = size.width / box.width
  const sy = size.height / box.height
  context.fillStyle = '#000'
  context.fillRect(0, 0, size.width, size.height)
  for (let i = layout.windows.length - 1; i >= 0; i--) {
    const win = layout.windows[i]
    const frame = windows.get(win.hwnd)?.frame
    if (!frame) continue
    try {
      context.drawImage(frame, (win.x - box.x) * sx, (win.y - box.y) * sy, win.width * sx, win.height * sy)
    } catch {
      drop(win.hwnd) // its capture ended under it (the window closed): the next layout leaves it out
    }
  }
}

function send() {
  timer = 0
  if (stopped || !writer || !layout) return
  const now = performance.now()
  // The output's own sinks haven't taken the last frame yet: try again shortly rather than queue.
  if (writer.desiredSize <= 0) {
    stats.busy++
    timer = setTimeout(send, 4)
    return
  }
  if (!layout.windows.some((win) => windows.get(win.hwnd)?.frame)) return
  crop = settleCrop(crop, layout.windows, layout.desktop, now, anchor)
  const {box} = crop
  let size = outputSize(box, limits)
  const lone = layout.windows.length === 1 && layout.windows[0].hwnd === anchor ? windows.get(anchor)?.frame : null
  // A lone window's capture can be a pixel or two off its reported frame; its own size wins.
  const exact = lone && size.scale === 1 && Math.abs(lone.displayWidth - box.width) <= 2 && Math.abs(lone.displayHeight - box.height) <= 2
  let frame
  if (exact) {
    size = {width: lone.displayWidth, height: lone.displayHeight, scale: 1}
    frame = new VideoFrame(lone, {timestamp: Math.round(now * 1000)})
    stats.passed++
  } else {
    const started = performance.now()
    compose(box, size)
    frame = new VideoFrame(canvas, {timestamp: Math.round(now * 1000)})
    stats.composeMs += performance.now() - started
    stats.composed++
  }
  lastSent = now
  const sizeKey = `${size.width}x${size.height}`
  if (sizeKey !== sentSize) {
    sentSize = sizeKey
    post({type: 'size', width: size.width, height: size.height})
  }
  // A drag changes the crop many times a second; the log gets where it went, twice a second at most.
  const cropKey = `${box.x},${box.y},${box.width},${box.height}`
  if (cropKey !== sentCrop && now - cropPostedAt >= 500) {
    sentCrop = cropKey
    cropPostedAt = now
    post({type: 'crop', box, size, windows: layout.windows.length})
  }
  writer.write(frame).catch(() => {
    frame.close()
    stop() // the share's track was stopped
  })
}

function stop() {
  if (stopped) return
  stopped = true
  clearTimeout(timer)
  for (const hwnd of [...windows.keys()]) drop(hwnd)
  writer?.close().catch(() => {})
  self.close()
}

setInterval(() => {
  if (performance.now() - lastSent >= KEEPALIVE_MS) schedule()
}, KEEPALIVE_MS / 2)

setInterval(() => {
  post({type: 'stats', ...stats, composeMs: Math.round(stats.composeMs), seconds: STATS_MS / 1000})
  stats = {passed: 0, composed: 0, composeMs: 0, framesIn: 0, busy: 0}
}, STATS_MS)

self.onmessage = ({data}) => {
  if (data.type === 'start') {
    writer = data.writable.getWriter()
    anchor = data.anchor
    limits = data.limits
    layout = data.layout
  } else if (data.type === 'window') {
    watch(data.hwnd, data.readable)
  } else if (data.type === 'drop') {
    drop(data.hwnd)
  } else if (data.type === 'layout') {
    layout = data.layout
    schedule()
  } else if (data.type === 'limits') {
    limits = data.limits
    schedule()
  } else if (data.type === 'stop') {
    stop()
  }
}
