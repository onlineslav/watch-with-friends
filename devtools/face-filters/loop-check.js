// Reproducing the YouTube feedback loop without YouTube.
//
// On that path the app reads its own window back, so the detector measures a face the app has
// already warped. `correct()` is supposed to take that warp back out. This runs the exact loop on a
// held frame — draw the warp, detect on the drawn result, unwarp, draw again — and reports the jaw
// width each time round. Stable means the correction works. Growing means it recurses.
const {app, BrowserWindow} = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = 'C:/Software Development/synced-video-player'
const esbuild = require(path.join(ROOT, 'node_modules', 'esbuild'))
const SCRATCH = __dirname
const CLIP = path.join(SCRATCH, 'clip.mp4')
const {prepareVision, registerVision} = require(path.join(ROOT, 'main', 'vision.js'))

const AT = Number(process.argv.find((a) => a.startsWith('--at='))?.slice(5) || 8)
const ROUNDS = Number(process.argv.find((a) => a.startsWith('--rounds='))?.slice(9) || 25)
const CORRECT = !process.argv.includes('--no-correct')

app.setPath('userData', path.join(SCRATCH, 'profile-loop'))
prepareVision()
const say = (line = '') => fs.writeSync(1, `${line}\n`)

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0;background:#111">
<video id="v" src="clip.mp4" muted playsinline preload="auto"></video>
<canvas id="filter"></canvas>
<canvas id="stage"></canvas>
<script src="probe.js"></script>
</body></html>`

const SOURCE = `
import {FaceTracker} from '${ROOT}/renderer/faces.mjs'
import {FilterRenderer} from '${ROOT}/renderer/filter-gl.mjs'
import {FILTERS, facePose, toLocal} from '${ROOT}/renderer/filters.mjs'

const video = document.getElementById('v')
const filterCanvas = document.getElementById('filter')
const stage = document.getElementById('stage')
const ctx = stage.getContext('2d')
window.failure = null

// The stage stands in for the captured window: its pixels are the picture with the filter drawn
// over it, which is precisely what cropTo hands back.
Object.defineProperty(stage, 'videoWidth', {get: () => stage.width})
Object.defineProperty(stage, 'videoHeight', {get: () => stage.height})

window.__loop = {
  async run(at, rounds, correct) {
    await new Promise((r) => { if (video.readyState >= 2) r(); else video.addEventListener('loadeddata', r, {once: true}) })
    await new Promise((r) => { video.addEventListener('seeked', r, {once: true}); video.currentTime = at })
    const W = video.videoWidth, H = video.videoHeight
    stage.width = W; stage.height = H
    const filter = FILTERS.chad
    const renderer = new FilterRenderer(filterCanvas)
    renderer.resize(W, H)

    const tracker = new FaceTracker()
    // The window being read back already has this filter on it, exactly as app.js sets it.
    const started = await tracker.start(video)
    if (!started) { window.failure = 'tracker did not start: ' + (tracker.error && tracker.error.message); return null }
    tracker.stop()
    tracker.source = stage
    if (correct) tracker.unwarp = filter

    const aspect = W / H
    const jaws = []
    // Round 0: the true picture, nothing drawn yet.
    ctx.drawImage(video, 0, 0, W, H)
    for (let round = 0; round < rounds; round++) {
      tracker.detect()
      const faces = tracker.visible()
      if (!faces.length) { jaws.push(null); continue }
      const lm = faces[0].landmarks
      const pose = facePose(lm, aspect)
      // Jaw width in face units: the two gonial landmarks, which is what the filter widens.
      const [lx] = toLocal(pose, lm[58].x, lm[58].y, aspect)
      const [rx] = toLocal(pose, lm[288].x, lm[288].y, aspect)
      jaws.push(+(rx - lx).toFixed(4))

      // Draw the warp over the picture; that composite is what the next detection reads.
      renderer.draw(stage, faces, filter, {x: 0, y: 0, width: W, height: H})
      // The window is the true picture with our canvas composited over it; that is what gets
      // captured and handed back to us next time round.
      ctx.drawImage(video, 0, 0, W, H)
      ctx.drawImage(filterCanvas, 0, 0, W, H)
    }
    return {jaws, shot: stage.toDataURL('image/png')}
  },
}
`

app.whenReady().then(async () => {
  registerVision()
  const dir = path.join(SCRATCH, 'loop')
  fs.mkdirSync(dir, {recursive: true})
  fs.copyFileSync(CLIP, path.join(dir, 'clip.mp4'))
  fs.writeFileSync(path.join(dir, 'index.html'), PAGE)
  await esbuild.build({stdin: {contents: SOURCE, resolveDir: ROOT, loader: 'js'}, bundle: true, format: 'iife', target: 'chrome130', outfile: path.join(dir, 'probe.js')})

  const win = new BrowserWindow({show: true, width: 900, height: 600, webPreferences: {backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required'}})
  win.webContents.setAudioMuted(true)
  try {
    await win.loadFile(path.join(dir, 'index.html'))
    const out = await win.webContents.executeJavaScript(`window.__loop.run(${AT}, ${ROUNDS}, ${CORRECT})`)
    if (!out) throw new Error(await win.webContents.executeJavaScript('window.failure'))
    const label = CORRECT ? 'with the unwarp correction' : 'WITHOUT the correction (control)'
    say(`jaw width in face units, round by round, ${label}:`)
    say('  ' + out.jaws.map((j) => (j === null ? ' --- ' : j.toFixed(3))).join('  '))
    const first = out.jaws.find((j) => j !== null)
    const last = [...out.jaws].reverse().find((j) => j !== null)
    if (first && last) say(`\n  start ${first.toFixed(3)}  ->  end ${last.toFixed(3)}   (${(((last - first) / first) * 100).toFixed(1)}% change)`)
    const name = CORRECT ? 'loop-corrected.png' : 'loop-uncorrected.png'
    fs.writeFileSync(path.join(SCRATCH, 'shots', name), Buffer.from(out.shot.split(',')[1], 'base64'))
    say(`  final frame: shots/${name}`)
  } catch (error) {
    say(`FAILED: ${error.stack || error}`)
    app.exit(1)
    return
  }
  app.exit(0)
})
