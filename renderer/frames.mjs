// video.captureStream() samples on a fixed 30fps timer: 24fps films judder (every 4th frame
// repeats) and 60fps video is halved. This forwards the frames the <video> presents, so the
// stream keeps the source frame rate. Returns null where Chromium lacks the APIs.
//
// requestVideoFrameCallback is frame-accurate but only fires ~1/s while the window is
// minimized, so a fast poll takes over whenever callbacks stall.
const STALL_MS = 100
const POLL_MS = 10

export function captureVideoFrames(video) {
  if (typeof MediaStreamTrackGenerator !== 'function' || typeof VideoFrame !== 'function' || !video.requestVideoFrameCallback) {
    return null
  }
  const generator = new MediaStreamTrackGenerator({kind: 'video'})
  const writer = generator.writable.getWriter()
  let writing = false
  let lastCallback = 0
  let lastMediaTimestamp = null

  const send = ({onlyIfNew}) => {
    if (writing || !video.videoWidth) return
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
    writing = true
    writer
      .write(stamped)
      .catch(() => stamped.close())
      .finally(() => (writing = false))
  }

  const onFrame = () => {
    if (generator.readyState === 'ended') return
    lastCallback = performance.now()
    send({onlyIfNew: false})
    video.requestVideoFrameCallback(onFrame)
  }
  video.requestVideoFrameCallback(onFrame)

  const poll = setInterval(() => {
    if (generator.readyState === 'ended') {
      clearInterval(poll)
      writer.close().catch(() => {})
      return
    }
    if (!video.paused && performance.now() - lastCallback > STALL_MS) send({onlyIfNew: true})
  }, POLL_MS)

  return generator
}
