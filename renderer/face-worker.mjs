// MediaPipe is synchronous, including with its GPU delegate. Keep inference, downscaling and
// pixel readback off the playback/UI thread. The caller transfers at most one VideoFrame at a time.
import {FaceLandmarker, FilesetResolver} from '@mediapipe/tasks-vision'
import {MAX_FACES, grayscale} from './filters.mjs'

const ASSETS = 'svp-vision://assets'
// Detection resolution for the whole frame. Because the frame is normalized to this size, it is
// what decides how many pixels of face the landmark stage gets, whatever the source resolution.
// scripts/landmark-curve.js puts the accuracy knee at roughly 25-34px of eye distance; 384 left an
// ordinary wide shot well under it. 768 costs ~2.8ms of inference median and doubles that budget.
const DETECT_SIZE = 768
const canvas = new OffscreenCanvas(DETECT_SIZE, DETECT_SIZE)
const context = canvas.getContext('2d')
const thumb = new OffscreenCanvas(32, 18)
const thumbContext = thumb.getContext('2d', {willReadFrequently: true})
let landmarker

async function initialize() {
  const fileset = await FilesetResolver.forVisionTasks(ASSETS)
  const model = await fetch(`${ASSETS}/face_landmarker.task`)
  if (!model.ok) throw new Error('The face model is not installed')
  const bytes = new Uint8Array(await model.arrayBuffer())
  for (const delegate of ['GPU', 'CPU']) {
    try {
      landmarker = await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: {modelAssetBuffer: bytes, delegate},
        canvas: new OffscreenCanvas(1, 1),
        runningMode: 'VIDEO', numFaces: MAX_FACES,
        minFaceDetectionConfidence: 0.4, minFacePresenceConfidence: 0.4,
        minTrackingConfidence: 0.4,
        outputFaceBlendshapes: false, outputFacialTransformationMatrixes: false,
      })
      self.postMessage({type: 'ready', delegate, connections: FaceLandmarker.FACE_LANDMARKS_TESSELATION || []})
      return
    } catch (error) {
      if (delegate === 'CPU') throw error
    }
  }
}

self.onmessage = ({data}) => {
  const {frame, at, generation} = data
  if (!frame) return
  const started = performance.now()
  try {
    const scale = Math.min(1, DETECT_SIZE / Math.max(frame.displayWidth, frame.displayHeight))
    const width = Math.max(2, Math.round(frame.displayWidth * scale))
    const height = Math.max(2, Math.round(frame.displayHeight * scale))
    if (canvas.width !== width || canvas.height !== height) Object.assign(canvas, {width, height})
    context.drawImage(frame, 0, 0, width, height)
    thumbContext.drawImage(canvas, 0, 0, 32, 18)
    const thumbnail = grayscale(thumbContext.getImageData(0, 0, 32, 18).data)
    const result = landmarker.detectForVideo(canvas, at)
    self.postMessage({type: 'result', generation, at, thumbnail,
      timestamp: frame.timestamp,
      aspect: frame.displayWidth / frame.displayHeight,
      detections: (result?.faceLandmarks || []).slice(0, MAX_FACES),
      inferenceMs: performance.now() - started})
  } catch (error) {
    self.postMessage({type: 'error', generation, error: String(error?.message || error)})
  } finally {
    frame.close()
  }
}

initialize().catch(error => self.postMessage({type: 'error', error: String(error?.message || error)}))
