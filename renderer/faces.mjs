// Frame-driven face tracking. Only one inference is in flight; a slow detector skips frames
// instead of building latency. MediaPipe and pixel readback live in face-worker.mjs.
import {HOLD_MS, MAX_FACES, createSmoother, facePose, holdOpacity, isCut, smoothFace} from './filters.mjs'

const ASSETS = 'svp-vision://assets'
const CAPTURE_TIMEOUT_MS = 5000
let connections = []
export const faceConnections = () => connections

// Find the best assignment for the whole frame, rather than letting the first detection steal
// another person's history. With at most three faces an exhaustive assignment is tiny. Distances
// use head size and aspect-correct coordinates, not a fixed fraction of the video width.
function matchFaces(tracked, detections, aspect, at) {
  const observations = detections.slice(0, MAX_FACES).map(landmarks => ({landmarks, pose: facePose(landmarks, aspect)})).filter(item => item.pose)
  const costs = observations.map(({pose}) => tracked.map(face => {
    if (at - face.at >= HOLD_MS) return Infinity
    const ratio = pose.scale / face.pose.scale
    const distance = Math.hypot(pose.x - face.pose.x, pose.y - face.pose.y) / ((pose.scale + face.pose.scale) / 2)
    return ratio > 0.5 && ratio < 2 && distance < 1.5 ? distance + Math.abs(Math.log(ratio)) * 0.5 : Infinity
  }))
  let bestCost = Infinity, assignment = []
  const visit = (indices, used, cost) => {
    if (cost >= bestCost) return
    const index = indices.length
    if (index === observations.length) { bestCost = cost; assignment = indices; return }
    visit([...indices, -1], used, cost + 1.75)
    for (let i = 0; i < tracked.length; i++) {
      if (!(used & (1 << i))) visit([...indices, i], used | (1 << i), cost + costs[index][i])
    }
  }
  visit([], 0, 0)
  const matched = observations.map((observation, i) => ({...observation,
    face: assignment[i] >= 0 ? tracked[assignment[i]] : {smoother: createSmoother(), landmarks: null, at: 0},
  }))
  return {matched, unmatched: tracked.filter((_, i) => !assignment.includes(i))}
}

export class FaceTracker {
  constructor() {
    this.worker = null
    this.loading = null
    this.tracked = []
    this.thumbnail = null
    this.error = null
    this.timer = null
    this.videoTimer = null
    this.source = null
    this.aspect = 16 / 9
    this.detecting = false
    this.generation = 0
    this.lastTimestamp = null
    this.lastFrameAt = 0
    this.stats = {delegate: null, frames: 0, discarded: 0, inferenceMs: 0, latencyMs: 0}
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
              // A new frame may have arrived while inference was busy. Submit the current frame
              // immediately instead of idling until another display refresh. Never queue frames.
              this.detect()
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
    this.onSeeking = () => this.reset()
    source.addEventListener?.('seeking', this.onSeeking)
    this.schedule()
    this.detect()
    return true
  }

  stop() {
    cancelAnimationFrame(this.timer)
    if (this.videoTimer !== null) this.source?.cancelVideoFrameCallback?.(this.videoTimer)
    this.source?.removeEventListener?.('seeking', this.onSeeking)
    this.timer = null
    this.videoTimer = null
    this.source = null
    this.reset()
  }

  reset() {
    this.generation++
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
    const source = this.source
    if (!source) return
    const tick = () => {
      if (this.source !== source) return
      this.detect()
      this.schedule()
    }
    if (source.requestVideoFrameCallback) this.videoTimer = source.requestVideoFrameCallback(tick)
    else this.timer = requestAnimationFrame(tick)
  }

  detect() {
    const source = this.source
    if (!source || !this.worker || this.error || source.seeking || this.detecting || !source.videoWidth || source.readyState < 2) return
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

  accept({detections, thumbnail, aspect, at, inferenceMs, timestamp}) {
    this.stats.frames++
    this.stats.inferenceMs = inferenceMs
    this.stats.latencyMs = performance.now() - at
    // A cold GPU or suspended window can finish seconds late. Do not paint that old face onto
    // advancing video. A genuinely unchanged/paused frame is still safe to use.
    if (this.stats.latencyMs > 200 && timestamp !== undefined) {
      let current
      try {
        current = new VideoFrame(this.source)
        if (current.timestamp !== timestamp) {
          this.stats.discarded++
          this.tracked = []
          return
        }
      } catch {
        this.stats.discarded++
        this.tracked = []
        return
      } finally { current?.close() }
    }
    if (this.aspect !== aspect || (this.thumbnail && isCut(this.thumbnail, thumbnail))) this.tracked = []
    this.aspect = aspect
    this.thumbnail = thumbnail
    const {matched, unmatched} = matchFaces(this.tracked, detections, aspect, at)
    const next = matched.map(({face, landmarks, pose}) => {
      face.landmarks = smoothFace(face.smoother, landmarks, aspect, at) || landmarks
      face.pose = pose
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
    // On a paused frame the filter stays with the face. During an inference stall on playing
    // video, age it on wall time so the old mask cannot freeze over seconds of newer footage.
    const clock = this.detecting && this.source?.paused === false ? now : Math.min(now, this.lastFrameAt)
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
