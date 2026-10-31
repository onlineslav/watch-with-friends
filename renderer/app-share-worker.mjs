// The frame work of a whole-app share, in a dedicated worker so none of it runs on the page's main
// thread: app-share-track.mjs hands over each window capture's frame stream and the output
// track's writable, and posts every layout. Bundled on its own to app-share-worker.js (the
// page's CSP only allows workers from the app's own files).
//
// A frame goes out when a window sends one (at most at Settings' frame rate), not on a timer that
// beats against the captures' own rate, which dropped and doubled frames unevenly. With only the
// shared window showing and nothing to crop, its frames go out untouched; otherwise the windows
// are drawn together, bottom first. A still screen still sends one at least every KEEPALIVE_MS.
import {outputSize, placeholderText, settleCrop} from './app-share.mjs'

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
let shown = '' // 'picture' or 'placeholder', for the log
let card = null
let cardTitle = ''
let cardSize = [1280, 720]
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
    // At its own size, trimmed to the window, never stretched: while a window is being resized its
    // capture runs a frame behind the new size, and stretching that made the picture wobble.
    const w = Math.min(frame.displayWidth, win.width)
    const h = Math.min(frame.displayHeight, win.height)
    try {
      context.drawImage(frame, 0, 0, w, h, (win.x - box.x) * sx, (win.y - box.y) * sy, w * sx, h * sy)
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
  if (!layout.windows.some((win) => windows.get(win.hwnd)?.frame)) {
    // Nothing to show (minimized, say): a card saying so, at the size the picture had, twice a second.
    const text = placeholderText(layout)
    if (text) sendFrame(placeholder(text), now, 'placeholder')
    return
  }
  crop = settleCrop(crop, layout.windows, layout.desktop, anchor)
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
  // A drag changes the crop many times a second; the log gets where it went, twice a second at most.
  const cropKey = `${box.x},${box.y},${box.width},${box.height}`
  if (cropKey !== sentCrop && now - cropPostedAt >= 500) {
    sentCrop = cropKey
    cropPostedAt = now
    post({type: 'crop', box, size, windows: layout.windows.length})
  }
  sendFrame(frame, now)
}

function sendFrame(frame, now, kind = 'picture') {
  lastSent = now
  const sizeKey = `${frame.displayWidth}x${frame.displayHeight}`
  if (sizeKey !== sentSize) {
    sentSize = sizeKey
    post({type: 'size', width: frame.displayWidth, height: frame.displayHeight})
  }
  if (kind !== shown) {
    shown = kind
    post({type: 'showing', kind}) // logged: when viewers got the card, and when the picture came back
  }
  writer.write(frame).catch(() => {
    frame.close()
    stop() // the share's track was stopped
  })
}

// The card, as big as the last picture was (so restoring the window doesn't resize the stream
// twice), or 1280×720 if there hasn't been one.
function placeholder({title, detail}) {
  const [width, height] = sentSize && shown === 'picture' ? sentSize.split('x').map(Number) : cardSize
  cardSize = [width, height]
  if (!card || card.width !== width || card.height !== height || cardTitle !== title) {
    card ??= new OffscreenCanvas(width, height)
    card.width = width
    card.height = height
    cardTitle = title
    const draw = card.getContext('2d', {alpha: false})
    draw.fillStyle = '#16161c'
    draw.fillRect(0, 0, width, height)
    draw.textAlign = 'center'
    draw.textBaseline = 'middle'
    const unit = Math.max(12, Math.round(Math.min(width / 28, height / 16)))
    draw.fillStyle = '#e8e8ee'
    draw.font = `600 ${unit}px "Segoe UI", system-ui, sans-serif`
    draw.fillText(title, width / 2, height / 2 - unit * 0.6, width * 0.9)
    draw.fillStyle = '#8a8a96'
    draw.font = `${Math.round(unit * 0.6)}px "Segoe UI", system-ui, sans-serif`
    draw.fillText(detail, width / 2, height / 2 + unit * 0.7, width * 0.9)
  }
  return new VideoFrame(card, {timestamp: Math.round(performance.now() * 1000)})
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
