// Frame-driven face tracking. Only one inference is in flight; a slow detector skips frames
// instead of building latency. MediaPipe and pixel readback live in face-worker.mjs.
import {HOLD_MS, MAX_FACES, createSmoother, holdOpacity, isCut, smoothFace} from './filters.mjs'

const ASSETS = 'svp-vision://assets'
const CAPTURE_TIMEOUT_MS = 5000
let connections = []
export const faceConnections = () => connections

const centre = (landmarks) => {
  const eye = landmarks[33]
  const other = landmarks[263]
  return eye && other ? [(eye.x + other.x) / 2, (eye.y + other.y) / 2] : [0, 0]
}

// Faces come back in no particular order, so each detection is matched to the face it is nearest
// to. Without this, two people on screen would swap smoothers every frame and both would shake.
//
// Whatever is left over is returned too, and that matters: detection misses a frontal face several
// times a minute on ordinary footage, and dropping those outright is what made the filter flash.
function matchFaces(tracked, detections) {
  const free = new Set(tracked)
  const result = []
  for (const landmarks of detections) {
    const [x, y] = centre(landmarks)
    let best = null
    let bestDistance = Infinity
    for (const face of free) {
      const distance = Math.hypot(face.x - x, face.y - y)
      if (distance < bestDistance) {
        bestDistance = distance
        best = face
      }
    }
    // Further than a head away is a different person, not the same one having moved.
    const face = best && bestDistance < 0.25 ? best : {smoother: createSmoother(), x, y, landmarks: null, at: 0}
    free.delete(face)
    result.push({face, landmarks, x, y})
  }
  return {matched: result, unmatched: [...free]}
}

export class FaceTracker {
  constructor() {
    this.worker = null
    this.loading = null
    this.tracked = []
    this.thumbnail = null
    this.error = null
    this.timer = null
    this.source = null
    this.aspect = 16 / 9
    this.detecting = false
    this.generation = 0
    this.lastTimestamp = null
    this.lastFrameAt = 0
    this.stats = {delegate: null, frames: 0, inferenceMs: 0, latencyMs: 0}
  }

  async load() {
    if (this.loading) return this.loading
    const controller = this.loadController = new AbortController()
    const loading = this.loading = (async () => {
      const response = await fetch(`${ASSETS}/face-worker.js`, {signal: controller.signal})
      if (!response.ok) throw new Error('The face tracking worker is not installed')
      // A worker URL must share the document's origin. Fetch the packaged script and create a
      // same-origin blob; WASM/model URLs inside it remain absolute and covered by the app CSP.
      const url = URL.createObjectURL(new Blob([await response.text()], {type: 'text/javascript'}))
      try {
        controller.signal.throwIfAborted()
        await new Promise((resolve, reject) => {
          const worker = this.worker = new Worker(url)
          const timeout = setTimeout(() => fail(new Error('Face tracking initialization timed out')), 30000)
          const fail = error => {
            clearTimeout(timeout)
            worker.terminate()
            if (this.worker === worker) {
              this.error = error
              this.detecting = false
              this.worker = null
              this.loading = null
            }
            reject(error)
          }
          controller.signal.addEventListener('abort', () => fail(new Error('Face tracking closed')), {once: true})
          worker.onerror = event => fail(new Error(event.message || 'Face tracking worker failed'))
          worker.onmessage = ({data}) => {
            if (data.type === 'ready') {
              clearTimeout(timeout)
              connections = data.connections
              this.stats.delegate = data.delegate
              resolve()
            } else if (data.type === 'error') {
              fail(new Error(data.error))
            } else if (data.type === 'result') {
              this.detecting = false
              if (data.generation === this.generation && this.source) this.accept(data)
            }
          }
        })
      } finally { URL.revokeObjectURL(url) }
    })()
    try { await loading } catch (error) { if (this.loading === loading) this.loading = null; throw error }
  }

  async start(source) {
    this.stop()
    this.source = source
    this.error = null
    const generation = this.generation
    try { await this.load() } catch (error) {
      if (this.generation === generation) this.error = error
      return false
    }
    if (this.generation !== generation || this.source !== source) return false
    this.schedule()
    return true
  }

  stop() {
    cancelAnimationFrame(this.timer)
    this.timer = null
    this.generation++
    this.source = null
    this.tracked = []
    this.thumbnail = null
    this.lastTimestamp = null
    this.lastFrameAt = 0
  }

  close() {
    this.stop()
    this.loadController?.abort()
    this.worker?.terminate()
    this.worker = null
    this.loading = null
    this.detecting = false
  }

  schedule() {
    if (!this.source) return
    this.timer = requestAnimationFrame(() => {
      this.detect()
      this.schedule()
    })
  }

  detect() {
    const source = this.source
    if (!source || !this.worker || this.detecting || !source.videoWidth || source.readyState < 2) return
    let frame
    try {
      frame = new VideoFrame(source)
      // Polling the presented frame works for local video, WebRTC and tab capture. Paused or
      // lower-FPS sources are never inferred twice, even on a high-refresh display.
      if (frame.timestamp === this.lastTimestamp) return
      this.lastTimestamp = frame.timestamp
      this.lastFrameAt = performance.now()
      this.detecting = true
      this.worker.postMessage({frame, at: this.lastFrameAt, generation: this.generation}, [frame])
    } catch (error) {
      this.error = error
      this.detecting = false
    } finally { frame?.close() }
  }

  accept({detections, thumbnail, aspect, at, inferenceMs}) {
    this.stats.frames++
    this.stats.inferenceMs = inferenceMs
    this.stats.latencyMs = performance.now() - at
    if (this.aspect !== aspect || (this.thumbnail && isCut(this.thumbnail, thumbnail))) this.tracked = []
    this.aspect = aspect
    this.thumbnail = thumbnail
    const {matched, unmatched} = matchFaces(this.tracked, detections)
    const next = matched.map(({face, landmarks, x, y}) => {
      face.landmarks = smoothFace(face.smoother, landmarks, aspect, at) || landmarks
      face.x = x
      face.y = y
      face.at = at
      return face
    })
    for (const face of unmatched) {
      if (face.landmarks && at - face.at < HOLD_MS) next.push(face)
    }
    this.tracked = next.slice(0, MAX_FACES)
  }

  visible(now = performance.now()) {
    const faces = []
    if (this.source?.videoWidth / this.source?.videoHeight !== this.aspect) return faces
    // On a paused frame the filter stays with the face. Missed detections on advancing video
    // still age and fade normally. Age uses capture time, not worker completion time.
    const clock = Math.min(now, this.lastFrameAt)
    for (const face of this.tracked) {
      const opacity = holdOpacity(clock - face.at)
      if (opacity > 0 && face.landmarks) faces.push({landmarks: face.landmarks, opacity})
    }
    return faces
  }
}

// Capture the guest as a Chromium video stream. No full-frame IPC, byte swapping, or polling
// screenshots, and the embedding window's overlay can never feed back into its own detector.
export async function captureGuest(guestId, getSourceId = id => window.api.captureYouTube(id)) {
  const guest = [...document.querySelectorAll('webview')].find(element => {
    try { return element.getWebContentsId() === guestId } catch { return false }
  })
  const size = () => {
    const width = guest?.clientWidth || 1280, height = guest?.clientHeight || 720
    const scale = Math.min(devicePixelRatio || 1, 1920 / width, 1080 / height)
    return {width: Math.max(2, Math.round(width * scale)), height: Math.max(2, Math.round(height * scale))}
  }
  const openStream = async ({width, height}) => {
    const sourceId = await getSourceId(guestId)
    if (!sourceId) throw new Error('The YouTube player is no longer available')
    // Release a stream that arrives after timeout as well as one that starts normally.
    let expired = false, timer
    const acquiring = navigator.mediaDevices.getUserMedia({audio: false, video: {mandatory: {
      chromeMediaSource: 'tab', chromeMediaSourceId: sourceId,
      maxWidth: width, maxHeight: height, minFrameRate: 1, maxFrameRate: 60,
    }}})
    acquiring.then(stream => { if (expired) stream.getTracks().forEach(track => track.stop()) }, () => {})
    try {
      return await Promise.race([acquiring, new Promise((_, reject) => {
        timer = setTimeout(() => { expired = true; reject(new Error('YouTube capture timed out')) }, CAPTURE_TIMEOUT_MS)
      })])
    } finally { clearTimeout(timer) }
  }
  let dimensions = size()
  let stream = await openStream(dimensions)
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.srcObject = stream
  let resizeTimer, resizing = false, stopped = false
  const resize = async () => {
    if (stopped || resizing) return
    const next = size()
    if (next.width === dimensions.width && next.height === dimensions.height) return
    resizing = true
    try {
      // Chromium's tab source locks its aspect ratio at acquisition; applyConstraints cannot
      // change it. Reacquire on resize, keeping the same video element for the tracker/renderer.
      stream.getTracks().forEach(track => track.stop())
      const replacement = await openStream(next)
      if (stopped) { replacement.getTracks().forEach(track => track.stop()); return }
      stream = replacement
      dimensions = next
      video.srcObject = stream
      video.play().catch(() => {})
    } catch {
      // End the old feed so the app's normal capture retry can recover, rather than drawing a
      // permanently misaligned filter with the old aspect ratio.
      stream.getTracks().forEach(track => track.stop())
    } finally {
      resizing = false
      if (!stopped && (size().width !== next.width || size().height !== next.height)) resize()
    }
  }
  const observer = guest ? new ResizeObserver(() => {
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(resize, 100)
  }) : null
  observer?.observe(guest)
  const stop = () => {
    stopped = true
    observer?.disconnect()
    clearTimeout(resizeTimer)
    stream.getTracks().forEach(track => track.stop())
    video.pause()
    video.srcObject = null
  }
  try {
    // Await pixels, not just play(): a detached capture element can leave play() pending.
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error('No picture came back from the YouTube player yet')), CAPTURE_TIMEOUT_MS)
      const check = () => { if (video.readyState >= 2 && video.videoWidth) finish() }
      const finish = error => {
        clearTimeout(timeout)
        video.removeEventListener('loadeddata', check)
        video.removeEventListener('resize', check)
        error ? reject(error) : resolve()
      }
      video.addEventListener('loadeddata', check)
      video.addEventListener('resize', check)
      video.play().then(check, finish)
      check()
    })
    return {video, stop, get active() { return !stopped && (resizing || stream.getVideoTracks()[0]?.readyState === 'live') }}
  } catch (error) { stop(); throw error }
}
