// Finding faces in whatever is on screen. Everything impure about the filters lives here: loading
// MediaPipe, running it on a schedule, and getting pixels out of the YouTube player. The maths it
// feeds is all in filters.mjs.
//
// Detection is deliberately slow and small — a few times a second, on a downscaled frame — because
// the cost scales with pixels and rate, and the renderer interpolates between results anyway.
// Nothing here runs unless a filter is switched on.

import {HOLD_MS, MAX_FACES, createSmoother, facePose, grayscale, holdOpacity, isCut, resetSmoother, smoothFace} from './filters.mjs'

const ASSETS = 'svp-vision://assets'
// The longest side the detector ever sees. Its own input is smaller still, so this throws away
// nothing it would have used, and it is the single biggest lever on cost.
const DETECT_SIZE = 384
const DETECT_HZ = 15
// A thumbnail this small is enough to tell a cut from a camera move and costs nothing to read back.
const THUMB_W = 32
const THUMB_H = 18
// How long to wait for the first captured frame before giving up on the YouTube path.
const CAPTURE_TIMEOUT_MS = 5000

let loading = null
// MediaPipe's own tessellation, kept from the load so the debug filter can draw the same face mesh
// the detector is describing. Empty until a filter has been switched on once; the mesh then falls
// back to bare dots, which still shows where the landmarks are.
let connections = []

export const faceConnections = () => connections

// MediaPipe is only fetched the first time someone turns a filter on, and only once per session.
async function loadLandmarker() {
  if (loading) return loading
  loading = (async () => {
    const {FaceLandmarker, FilesetResolver} = await import('@mediapipe/tasks-vision')
    connections = FaceLandmarker.FACE_LANDMARKS_TESSELATION || []
    const fileset = await FilesetResolver.forVisionTasks(ASSETS)
    const model = await fetch(`${ASSETS}/face_landmarker.task`)
    if (!model.ok) throw new Error('The face model is not installed')
    const bytes = new Uint8Array(await model.arrayBuffer())
    // GPU is worth having and usually available, but a machine that refuses it should still get
    // filters: at this rate and this input size the CPU delegate keeps up comfortably.
    for (const delegate of ['GPU', 'CPU']) {
      try {
        return await createLandmarker(FaceLandmarker, fileset, bytes, delegate)
      } catch (error) {
        if (delegate === 'CPU') throw error
      }
    }
  })()
  loading.catch(() => (loading = null))
  return loading
}

function createLandmarker(FaceLandmarker, fileset, bytes, delegate) {
  return FaceLandmarker.createFromOptions(fileset, {
    baseOptions: {modelAssetBuffer: bytes, delegate},
    runningMode: 'VIDEO',
    numFaces: MAX_FACES,
    // Film is not a webcam: faces turn away, pass through shadow and leave frame. Holding the
    // thresholds low and letting the hold-and-fade in filters.mjs cover the gaps looks better
    // than a filter that keeps dropping off a face that is plainly still there.
    minFaceDetectionConfidence: 0.4,
    minFacePresenceConfidence: 0.4,
    minTrackingConfidence: 0.4,
    outputFaceBlendshapes: false,
    outputFacialTransformationMatrixes: false,
  })
}

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
    this.landmarker = null
    this.tracked = []
    this.thumbnail = null
    this.error = null
    this.timer = null
    this.source = null
    this.aspect = 16 / 9
    this.detecting = false
    // Set to the active filter when the picture being read back already has that filter drawn
    // on it, which is the case for the YouTube path. Left null everywhere else.
    this.canvas = document.createElement('canvas')
    this.context = this.canvas.getContext('2d', {willReadFrequently: false})
    this.thumb = document.createElement('canvas')
    Object.assign(this.thumb, {width: THUMB_W, height: THUMB_H})
    this.thumbContext = this.thumb.getContext('2d', {willReadFrequently: true})
  }

  // `source` is anything with videoWidth/videoHeight that can be drawn: the local or remote
  // <video>, or the capture element standing in for the YouTube iframe.
  async start(source) {
    this.source = source
    if (!this.landmarker) {
      try {
        this.landmarker = await loadLandmarker()
      } catch (error) {
        this.error = error
        return false
      }
    }
    if (this.source !== source) return false
    this.schedule()
    return true
  }

  stop() {
    clearTimeout(this.timer)
    this.timer = null
    this.source = null
    this.tracked = []
    this.thumbnail = null
  }

  close() {
    this.stop()
    this.landmarker?.close?.()
    this.landmarker = null
    loading = null
  }

  schedule() {
    clearTimeout(this.timer)
    if (!this.source) return
    this.timer = setTimeout(() => {
      this.detect()
      this.schedule()
    }, 1000 / DETECT_HZ)
  }

  // Everything in one tick: downscale, look for a cut, detect, smooth.
  detect() {
    const source = this.source
    if (!source || this.detecting || !source.videoWidth || !source.videoHeight) return
    this.detecting = true
    try {
      const scale = Math.min(1, DETECT_SIZE / Math.max(source.videoWidth, source.videoHeight))
      const width = Math.max(2, Math.round(source.videoWidth * scale))
      const height = Math.max(2, Math.round(source.videoHeight * scale))
      if (this.canvas.width !== width || this.canvas.height !== height) Object.assign(this.canvas, {width, height})
      this.aspect = source.videoWidth / source.videoHeight
      this.context.drawImage(source, 0, 0, width, height)

      // A hard cut means the face that was there belongs to the previous shot. Drop it outright
      // rather than letting it fade onto whoever is on screen now.
      this.thumbContext.drawImage(source, 0, 0, THUMB_W, THUMB_H)
      const thumbnail = grayscale(this.thumbContext.getImageData(0, 0, THUMB_W, THUMB_H).data)
      if (this.thumbnail && isCut(this.thumbnail, thumbnail)) {
        for (const face of this.tracked) resetSmoother(face.smoother)
        this.tracked = []
      }
      this.thumbnail = thumbnail

      const now = performance.now()
      const result = this.landmarker.detectForVideo(this.canvas, now)
      const detections = (result?.faceLandmarks || []).slice(0, MAX_FACES)
      const {matched, unmatched} = matchFaces(this.tracked, detections)
      const next = matched.map(({face, landmarks, x, y}) => {
        face.landmarks = smoothFace(face.smoother, landmarks, this.aspect, now) || landmarks
        face.x = x
        face.y = y
        face.at = now
        return face
      })
      // A face detection did not find this tick is held, not thrown away. `at` is deliberately left
      // alone so it keeps ageing, which is what lets holdOpacity fade it out and, if detection does
      // not come back within HOLD_MS, drop it. Without this the hold-and-fade below never ran at
      // all: a single missed tick blanked the filter and the next one snapped it back.
      for (const face of unmatched) {
        if (face.landmarks && now - face.at < HOLD_MS) next.push(face)
      }
      this.tracked = next
    } catch (error) {
      this.error = error
    } finally {
      this.detecting = false
    }
  }

  // What to draw right now: the last known faces, fading out if detection has lost them. Called
  // every rendered frame, so it does no work beyond reading the clock.
  visible(now = performance.now()) {
    const faces = []
    for (const face of this.tracked) {
      const opacity = holdOpacity(now - face.at)
      if (opacity > 0 && face.landmarks) faces.push({landmarks: face.landmarks, opacity})
    }
    return faces
  }
}

// ---------- Getting at the YouTube picture ----------
// A YouTube video plays inside a cross-origin frame, so its pixels cannot be read the way a
// <video> can. The player is a <webview> for exactly this: capturePage() on the guest returns the
// guest's own pixels, so what comes back has never had this app's filter canvas over it. Capturing
// the window instead fed the warp its own output and the face smeared to a blob within a second.

// Frames arrive as BGRA, which is what the platform hands back; a canvas wants RGBA. Swapping the
// red and blue byte of each pixel as a 32-bit word is a few milliseconds for a full frame, where
// encoding to PNG in the main process costs more than the capture itself.
function toRgba({width, height, bitmap}) {
  const bytes = bitmap.byteOffset % 4 ? bitmap.slice() : bitmap
  const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2)
  for (let i = 0; i < words.length; i++) {
    const pixel = words[i]
    words[i] = (pixel & 0xff00ff00) | ((pixel & 0x000000ff) << 16) | ((pixel & 0x00ff0000) >>> 16)
  }
  return new ImageData(new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.byteLength), width, height)
}

// Stands in for the <video> the local and remote paths use: the tracker and the warp renderer only
// ask a source for videoWidth/videoHeight and to be drawable.
export async function captureGuest(guestId, capturePage = (id) => window.api.captureYouTube(id)) {
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  Object.defineProperties(canvas, {
    videoWidth: {get: () => canvas.width},
    videoHeight: {get: () => canvas.height},
  })
  let stopped = false
  let timer = null
  const capture = {
    video: canvas,
    stop() {
      stopped = true
      clearTimeout(timer)
    },
  }
  // One capture at a time, scheduled after the last one landed rather than on a fixed interval, so
  // a slow frame queues nothing up behind it.
  const pull = async () => {
    let frame = null
    try { frame = await capturePage(guestId) } catch {}
    if (stopped) return false
    if (frame?.width) {
      if (canvas.width !== frame.width || canvas.height !== frame.height) {
        canvas.width = frame.width
        canvas.height = frame.height
      }
      context.putImageData(toRgba(frame), 0, 0)
    }
    return Boolean(frame?.width)
  }
  const loop = async () => {
    const started = performance.now()
    await pull()
    if (stopped) return
    timer = setTimeout(loop, Math.max(0, 1000 / DETECT_HZ - (performance.now() - started)))
  }
  // A guest that has not painted yet returns nothing, which is ordinary a moment after the player
  // opens. Say so plainly rather than leaving a filter switched on that will never draw anything.
  for (let waited = 0; waited < CAPTURE_TIMEOUT_MS; waited += 100) {
    if (stopped) return capture
    if (await pull()) {
      loop()
      return capture
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  capture.stop()
  throw new Error('no picture came back from the YouTube player yet')
}
