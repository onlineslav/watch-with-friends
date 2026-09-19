// The face filters need MediaPipe's WebAssembly runtime and its landmark model as real files the
// renderer can fetch over svp-vision://. The wasm ships inside the npm package; the model does not,
// so it is downloaded once and cached. Both land in renderer/vision/, which is gitignored: binaries
// that large do not belong in the history, and the fetch is idempotent.
//
// Runs from postinstall/prebundle/pretest like scripts/patch-trystero.js, and never fails the build
// on its own — a missing model only disables the filters, which the renderer reports.
const fs = require('node:fs')
const path = require('node:path')

const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'
const MODEL_BYTES = 3758596 // what Google serves today; a mismatch only triggers a re-download
const target = path.join(__dirname, '..', 'renderer', 'vision')
// Only the SIMD build. Electron always has SIMD, and the nosimd/module variants are ~11MB each.
const WASM = ['vision_wasm_internal.js', 'vision_wasm_internal.wasm']

function copyWasm() {
  const from = path.join(__dirname, '..', 'node_modules', '@mediapipe', 'tasks-vision', 'wasm')
  for (const name of WASM) {
    const source = path.join(from, name)
    const destination = path.join(target, name)
    if (!fs.existsSync(source)) throw new Error(`@mediapipe/tasks-vision is missing ${name}`)
    if (fs.existsSync(destination) && fs.statSync(destination).size === fs.statSync(source).size) continue
    fs.copyFileSync(source, destination)
  }
}

async function fetchModel() {
  const destination = path.join(target, 'face_landmarker.task')
  if (fs.existsSync(destination) && fs.statSync(destination).size === MODEL_BYTES) return
  const response = await fetch(MODEL_URL, {signal: AbortSignal.timeout(120000)})
  if (!response.ok) throw new Error(`the face model download returned ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length < 1e6) throw new Error('the face model download was truncated')
  // Write beside the target and rename, so an interrupted run never leaves a half model behind.
  const temporary = `${destination}.partial`
  fs.writeFileSync(temporary, bytes)
  fs.renameSync(temporary, destination)
}

async function main() {
  fs.mkdirSync(target, {recursive: true})
  copyWasm()
  await fetchModel()
}

main().catch((error) => {
  console.warn(`Face filters are unavailable: ${error.message}`)
  process.exitCode = 0
})
