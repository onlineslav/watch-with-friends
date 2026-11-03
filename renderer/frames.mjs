// video.captureStream() samples on a fixed 30fps timer: 24fps films judder (every 4th frame
// repeats) and 60fps video is halved. This forwards the frames the <video> presents, so the
// stream keeps the source frame rate. Returns null where Chromium lacks the APIs.
//
// requestVideoFrameCallback is frame-accurate but only fires ~1/s while the window is
// minimized, so a fast poll takes over whenever callbacks stall.
//
// It also runs once per rendering frame, not once per presented video frame: a 60fps film on a 60Hz display
// sometimes presents two frames between two callbacks, and the first is never reported (bench: 12% of a 60fps
// film's frames were lost, the viewer received 52fps; a 24 or 30fps film lost none). The callback's presentedFrames
// counter shows when that happens; for the next BOOST_MS the poll then looks at the element every POLL_MS too, and a
// frame is sent once, whichever of the two sees it first (both check the media timestamp).
import {frameSpacing} from './machine.mjs'

const STALL_MS = 100
const POLL_MS = 8
const BOOST_MS = 2000

export function captureVideoFrames(video) {
  if (typeof MediaStreamTrackGenerator !== 'function' || typeof VideoFrame !== 'function' || !video.requestVideoFrameCallback) {
    return null
  }
  const generator = new MediaStreamTrackGenerator({kind: 'video'})
  const writer = generator.writable.getWriter()
  let writing = false
  let lastCallback = 0
  let lastMediaTimestamp = null
  let lastPresented = null
  let boostUntil = 0

  const send = ({onlyIfNew}) => {
    // A presented frame lost to a write still in flight counts; the fast poll just trying again does not.
    if (writing) return onlyIfNew ? undefined : frameSpacing.skip()
    if (!video.videoWidth) return
    let frame
    try {
      frame = new VideoFrame(video)
    } catch {
      return
    }
    if (onlyIfNew && frame.timestamp === lastMediaTimestamp) return frame.close()
    lastMediaTimestamp = frame.timestamp
    // Re-stamp with wall-clock time: media timestamps jump backwards on seeks, which WebRTC drops.
    const stamped = new VideoFrame(frame, {timestamp: Math.round(performance.now() * 1000)})
    frame.close()
    // getSettings() on a generated track has no size; tuneSenders reads this instead.
    generator.frameSize = {width: stamped.displayWidth, height: stamped.displayHeight}
    frameSpacing.mark(performance.now())
    writing = true
    writer
      .write(stamped)
      .catch(() => stamped.close())
      .finally(() => (writing = false))
  }

  const onFrame = (now, metadata) => {
    if (generator.readyState === 'ended') return
    lastCallback = performance.now()
    const presented = metadata?.presentedFrames
    if (Number.isFinite(presented)) {
      if (lastPresented != null && presented - lastPresented > 1) boostUntil = lastCallback + BOOST_MS
      lastPresented = presented
    }
    send({onlyIfNew: true})
    video.requestVideoFrameCallback(onFrame)
  }
  video.requestVideoFrameCallback(onFrame)

  // The gap after a pause or seek is the viewer's doing, not a stall in the pipeline.
  const forgetLast = () => {
    frameSpacing.reset()
    lastMediaTimestamp = null // a seek or a new file may land on the very timestamp the last frame had
  }
  frameSpacing.reset()
  video.addEventListener('pause', forgetLast)
  video.addEventListener('seeking', forgetLast)
  video.addEventListener('emptied', forgetLast)

  const poll = setInterval(() => {
    if (generator.readyState === 'ended') {
      clearInterval(poll)
      video.removeEventListener('pause', forgetLast)
      video.removeEventListener('seeking', forgetLast)
      video.removeEventListener('emptied', forgetLast)
      writer.close().catch(() => {})
      return
    }
    const now = performance.now()
    if (!video.paused && (now - lastCallback > STALL_MS || now < boostUntil)) send({onlyIfNew: true})
  }, POLL_MS)

  return generator
}
