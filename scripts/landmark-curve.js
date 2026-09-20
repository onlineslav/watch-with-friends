// How much does landmark accuracy cost when the model is given fewer pixels of face?
//
// The renderer downscales a whole frame to DETECT_SIZE before detection, so a face that occupies a
// modest part of the picture reaches MediaPipe's landmark stage as a thumbnail. This measures the
// price of that directly: the same frames are detected at several scales, and every scale is
// compared against the detection at native resolution.
//
// The native-resolution run is a reference, not ground truth. This cannot say MediaPipe is wrong
// when given every pixel — only how fast it drifts away from its own best answer as pixels go. That
// is the question DETECT_SIZE actually poses, and unlike the live benchmark it is deterministic:
// the same file gives the same numbers every run.
const {app, BrowserWindow} = require('electron')
const {prepareVision, registerVision} = require('../main/vision')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {execFileSync} = require('node:child_process')
const esbuild = require('esbuild')

const root = path.resolve(__dirname, '..')
const option = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=') || fallback
const video = option('video', '')
const seconds = Number(option('seconds', '5'))
const startAt = Number(option('at', '0'))
// Scales are fractions of the source's long edge. The default set brackets the shipped DETECT_SIZE
// so the curve shows both what raising it could buy and what lowering it would cost.
const scales = option('scales', '1,0.8,0.6,0.45,0.3,0.2').split(',').map(Number)
if (!video || !fs.existsSync(video) || !Number.isFinite(seconds) || seconds <= 0 || seconds > 60
    || !Number.isFinite(startAt) || startAt < 0 || !scales.every((s) => s > 0 && s <= 1)) {
  throw new Error('Use --video=<path to a local file> --seconds=1..60 --at=<seconds> --scales=1,0.6,...')
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'svp-landmark-curve-'))
app.setPath('userData', path.join(temporary, 'profile'))
prepareVision()
const say = (value) => fs.writeSync(1, `${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`)
const deadline = setTimeout(() => { say('FAIL: exceeded 300 seconds'); app.exit(1) }, 300000)

// Frames are decoded to PNG up front rather than seeking a <video>. A still image removes decode
// timing and seek rounding from the measurement, so a rerun compares the same pixels.
function extract() {
  const directory = path.join(temporary, 'frames')
  fs.mkdirSync(directory)
  execFileSync(require('ffmpeg-static'), ['-y', '-v', 'error', '-ss', String(startAt), '-t', String(seconds),
    '-i', video, '-vsync', '0', '-f', 'image2', path.join(directory, 'f%04d.png')])
  return fs.readdirSync(directory).filter((name) => name.endsWith('.png')).sort()
}

app.whenReady().then(async () => {
  registerVision()
  const frames = extract()
  if (!frames.length) throw new Error('ffmpeg produced no frames')
  const win = new BrowserWindow({show: false, width: 640, height: 480, webPreferences: {backgroundThrottling: false}})
  // Model setup and 900 inferences take minutes with no natural output. Without this a stall is
  // indistinguishable from slow progress, which cost a run to find out.
  win.webContents.on('console-message', (_event, _level, message) => say(`  ${message}`))
  try {
    const policy = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8').match(/content="(default-src[^"]+)"/)[1]
    // The page sits on file:// beside the frames, so <img> loads them under img-src 'self'. Fetch
    // would not be allowed, which is why nothing here reads them as bytes.
    fs.writeFileSync(path.join(temporary, 'frames', 'index.html'),
      `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}">`)
    await win.loadFile(path.join(temporary, 'frames', 'index.html'))
    const bundle = await esbuild.build({stdin: {resolveDir: root, contents: `
      import {FaceLandmarker, FilesetResolver} from '@mediapipe/tasks-vision'
      import {facePose} from './renderer/filters.mjs'
      const ASSETS = 'svp-vision://assets'
      const load = (name) => new Promise((resolve, reject) => {
        const image = new Image()
        image.onload = () => resolve(image)
        image.onerror = () => reject(new Error('could not load ' + name))
        image.src = name
      })
      const quantile = (values, q) => {
        if (!values.length) return null
        const sorted = [...values].sort((a, b) => a - b)
        return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
      }
      window.run = async (names, scales, fps) => {
        console.log('resolving the wasm runtime')
        const fileset = await FilesetResolver.forVisionTasks(ASSETS)
        const model = await fetch(ASSETS + '/face_landmarker.task')
        if (!model.ok) throw new Error('the face model is not installed')
        const bytes = new Uint8Array(await model.arrayBuffer())
        console.log('model loaded, creating landmarkers')
        const make = async (delegate) => FaceLandmarker.createFromOptions(fileset, {
          baseOptions: {modelAssetBuffer: bytes, delegate},
          canvas: new OffscreenCanvas(1, 1),
          runningMode: 'VIDEO', numFaces: 1,
          minFaceDetectionConfidence: 0.4, minFacePresenceConfidence: 0.4, minTrackingConfidence: 0.4,
          outputFaceBlendshapes: false, outputFacialTransformationMatrixes: false,
        })
        // One landmarker per scale. VIDEO mode carries tracking state between frames, exactly as
        // production does, and a separate instance stops a small scale from quietly inheriting the
        // native run's prior — which would measure nothing at all.
        let delegate = 'GPU'
        const landmarkers = []
        for (const scale of scales) {
          try { landmarkers.push(await make(delegate)) } catch (error) {
            if (delegate === 'CPU') throw error
            delegate = 'CPU'
            landmarkers.push(await make(delegate))
          }
          console.log('landmarker ready for scale ' + scale + ' (' + delegate + ')')
        }
        const canvas = document.createElement('canvas')
        const context = canvas.getContext('2d', {willReadFrequently: true})
        const observations = scales.map(() => [])
        for (let i = 0; i < names.length; i++) {
          if (i % 10 === 0) console.log('frame ' + (i + 1) + ' of ' + names.length)
          const image = await load(names[i])
          for (let s = 0; s < scales.length; s++) {
            const width = Math.max(2, Math.round(image.width * scales[s]))
            const height = Math.max(2, Math.round(image.height * scales[s]))
            if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height }
            context.drawImage(image, 0, 0, width, height)
            const result = landmarkers[s].detectForVideo(canvas, (i * 1000) / fps)
            observations[s].push(result?.faceLandmarks?.[0] || null)
          }
        }
        const first = await load(names[0])
        const aspect = first.width / first.height
        const native = observations[0]
        const report = scales.map((scale, s) => {
          const errors = []
          let found = 0
          for (let i = 0; i < names.length; i++) {
            if (observations[s][i]) found++
            const reference = native[i]
            const observed = observations[s][i]
            if (!reference || !observed) continue
            const pose = facePose(reference, aspect)
            if (!pose) continue
            // Error in face units: one unit is the distance between the outer eye corners, the same
            // measure the filters are authored in, so it means the same thing at any face size.
            for (let k = 0; k < reference.length; k++) {
              errors.push(Math.hypot((observed[k].x - reference[k].x) * aspect, observed[k].y - reference[k].y) / pose.scale)
            }
          }
          // How much real face the landmark stage actually got, which is the quantity under test.
          // facePose measures in frame heights, so eye distance in pixels is that times the height
          // of the canvas this scale was detected on.
          const eyePixels = native.map((marks) => {
            const pose = marks && facePose(marks, aspect)
            return pose ? pose.scale * first.height * scale : null
          }).filter((value) => value !== null)
          return {
            scale,
            detectedAt: Math.round(first.width * scale) + 'x' + Math.round(first.height * scale),
            facesFound: found / names.length,
            eyeDistancePx: Math.round(quantile(eyePixels, 0.5) * 10) / 10,
            errorFaceUnits: {median: quantile(errors, 0.5), p95: quantile(errors, 0.95), max: quantile(errors, 1)},
            samples: errors.length,
          }
        })
        return {delegate, frames: names.length, report}
      }
    `, loader: 'js'}, bundle: true, write: false, format: 'iife', target: 'chrome130'})
    await win.webContents.executeJavaScript(bundle.outputFiles[0].text)
    const result = await win.webContents.executeJavaScript(
      `run(${JSON.stringify(frames)}, ${JSON.stringify(scales)}, ${30000 / 1001})`)
    say(result)
  } catch (error) {
    say(`FAIL: ${error?.message || error}`)
    clearTimeout(deadline)
    app.exit(1)
    return
  }
  clearTimeout(deadline)
  app.exit(0)
})
