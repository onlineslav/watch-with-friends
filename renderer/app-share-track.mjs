// A whole-app share: the capture is the whole monitor the app is on, and this redraws each frame
// with only the app's windows showing (visibleRegion: other windows on top of them come out
// black), cropped to where they are (settleCrop), into a MediaStreamTrackGenerator the way
// frames.mjs does for films. `getLayout()` returns the latest cleaned win-app-windows layout.
// Untested here for the same reason frames.mjs is: the frame APIs only exist in a real renderer.
import {settleCrop, visibleRegion} from './app-share.mjs'

const even = (value) => Math.max(2, Math.round(value / 2) * 2)

export function appShareTrack(screenTrack, getLayout) {
  if (typeof MediaStreamTrackProcessor !== 'function' || typeof MediaStreamTrackGenerator !== 'function' || typeof OffscreenCanvas !== 'function') return null
  const reader = new MediaStreamTrackProcessor({track: screenTrack}).readable.getReader()
  const generator = new MediaStreamTrackGenerator({kind: 'video'})
  const writer = generator.writable.getWriter()
  const canvas = new OffscreenCanvas(2, 2)
  const context = canvas.getContext('2d', {alpha: false})
  let crop = null
  let stopped = false

  const stop = () => {
    if (stopped) return
    stopped = true
    reader.cancel().catch(() => {})
    writer.close().catch(() => {})
    screenTrack.stop()
  }

  const compose = (frame, layout) => {
    const {monitor} = layout
    const sx = frame.displayWidth / monitor.width
    const sy = frame.displayHeight / monitor.height
    const region = visibleRegion(layout)
    crop = settleCrop(crop, region, monitor, performance.now())
    const {box} = crop
    const width = even(box.width * sx)
    const height = even(box.height * sy)
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    context.fillStyle = '#000'
    context.fillRect(0, 0, width, height)
    context.save()
    context.beginPath()
    // Whole pixels, so an anti-aliased edge never blends in a sliver of the window on top.
    for (const r of region) {
      const left = Math.round((r.x - box.x) * sx)
      const top = Math.round((r.y - box.y) * sy)
      context.rect(left, top, Math.round((r.x + r.width - box.x) * sx) - left, Math.round((r.y + r.height - box.y) * sy) - top)
    }
    context.clip()
    context.drawImage(frame, box.x * sx, box.y * sy, box.width * sx, box.height * sy, 0, 0, width, height)
    context.restore()
    return new VideoFrame(canvas, {timestamp: frame.timestamp})
  }

  ;(async () => {
    try {
      while (!stopped) {
        const {value: frame, done} = await reader.read()
        if (done || stopped) {
          frame?.close()
          break
        }
        let composed
        try {
          composed = compose(frame, getLayout())
        } finally {
          frame.close()
        }
        try {
          await writer.write(composed)
        } catch {
          composed.close()
          break // the share's track was stopped
        }
      }
    } catch {}
    stop()
  })()

  return {track: generator, stop}
}
