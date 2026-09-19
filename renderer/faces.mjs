// Finding faces in whatever is on screen. Everything impure about the filters lives here: loading
// MediaPipe, running it on a schedule, and getting pixels out of a YouTube iframe. The maths it
// feeds is all in filters.mjs.
//
// Detection is deliberately slow and small — a few times a second, on a downscaled frame — because
// the cost scales with pixels and rate, and the renderer interpolates between results anyway.
// Nothing here runs unless a filter is switched on.

import {MAX_FACES, controlPoints, createSmoother, facePose, grayscale, holdOpacity, isCut, resetSmoother, smoothFace, unwarpLandmarks} from './filters.mjs'

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

// MediaPipe is only fetched the first time someone turns a filter on, and only once per session.
async function loadLandmarker() {
  if (loading) return loading
  loading = (async () => {
    const {FaceLandmarker, FilesetResolver} = await import('@mediapipe/tasks-vision')
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
  return result
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
    this.unwarp = null
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
      const matched = matchFaces(this.tracked, detections)
      this.tracked = matched.map(({face, landmarks, x, y}) => {
        face.landmarks = smoothFace(face.smoother, this.correct(landmarks, face), this.aspect, now) || landmarks
        face.x = x
        face.y = y
        face.at = now
        return face
      })
    } catch (error) {
      this.error = error
    } finally {
      this.detecting = false
    }
  }

  // Takes this app's own warp back out of a reading, using the filter as it stood over the face
  // last time round. With nothing drawn yet there is nothing to undo.
  correct(landmarks, face) {
    if (!this.unwarp || !face.landmarks) return landmarks
    const pose = facePose(face.landmarks, this.aspect)
    if (!pose) return landmarks
    return unwarpLandmarks(landmarks, controlPoints(this.unwarp, face.landmarks, pose, this.aspect), pose, this.aspect)
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
// A YouTube video plays inside a cross-origin iframe, so its pixels cannot be read the way a
// <video> can. Capturing the app's own window gets them back: Element Capture narrows the capture
// to one element and drops anything drawn over it, which matters because the filter canvas sits
// directly on top and would otherwise be fed back into the detector.

export async function captureElement(element) {
  if (typeof CropTarget === 'undefined') throw new Error('This build cannot capture the YouTube picture')
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {frameRate: DETECT_HZ},
    audio: false,
    preferCurrentTab: true,
    selfBrowserSurface: 'include',
    systemAudio: 'exclude',
  })
  const [track] = stream.getVideoTracks()
  try {
    await track.cropTo(await CropTarget.fromElement(element))
  } catch (error) {
    stream.getTracks().forEach((t) => t.stop())
    throw error
  }
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.srcObject = stream
  // Deliberately not awaited. play() on a detached element fed by a capture track can stay pending
  // indefinitely rather than resolving or rejecting, and awaiting it would hang the whole filter on
  // the YouTube path. Waiting for a frame to arrive is the reliable signal instead.
  video.play().catch(() => {})
  const capture = {
    video,
    stop() {
      stream.getTracks().forEach((t) => t.stop())
      video.srcObject = null
    },
  }
  // A capture that is set up correctly can still deliver nothing — the window has to be on screen
  // and not wholly covered for the compositor to produce frames at all. Give it a moment, then say
  // so plainly rather than leaving a filter switched on that will never draw anything.
  for (let waited = 0; waited < CAPTURE_TIMEOUT_MS; waited += 100) {
    if (video.videoWidth) return capture
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  capture.stop()
  throw new Error('no picture came back from the window — it may be minimized or covered')
}
