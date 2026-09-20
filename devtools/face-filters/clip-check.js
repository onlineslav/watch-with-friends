// Offline look at what the face filter actually produces on a real clip.
// Seeks a local mp4, runs the real MediaPipe landmarker + the app's own buildMesh/FilterRenderer,
// and writes composited PNGs so the result can be inspected rather than guessed at.
const {app, BrowserWindow} = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = 'C:/Software Development/synced-video-player'
// This file lives in the scratchpad, outside the project, so nothing resolves by name.
const esbuild = require(path.join(ROOT, 'node_modules', 'esbuild'))
const SCRATCH = __dirname
const OUT = path.join(SCRATCH, 'shots')
const CLIP = path.join(SCRATCH, 'clip.mp4')
const {prepareVision, registerVision} = require(path.join(ROOT, 'main', 'vision.js'))

const FILTER = process.argv.find((a) => a.startsWith('--filter='))?.slice(9) || 'chad'
const TIMES = (process.argv.find((a) => a.startsWith('--times='))?.slice(8) || '0.3,1,2,3,4,5,6,7,8,9')
  .split(',')
  .map(Number)

app.setPath('userData', path.join(SCRATCH, 'profile'))
prepareVision()
fs.mkdirSync(OUT, {recursive: true})

const say = (line = '') => fs.writeSync(1, `${line}\n`)

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0;background:#111">
<video id="v" src="clip.mp4" muted playsinline preload="auto"></video>
<canvas id="filter"></canvas>
<canvas id="filter2"></canvas>
<canvas id="filter3"></canvas>
<canvas id="filter4"></canvas>
<canvas id="filter5"></canvas>
<canvas id="out"></canvas>
<script src="probe.js"></script>
</body></html>`

const SOURCE = `
import {FaceLandmarker, FilesetResolver} from '@mediapipe/tasks-vision'
import {FilterRenderer} from '${ROOT}/renderer/filter-gl.mjs'
import {FILTERS, buildMesh, facePose, toWorld, createSmoother, smoothFace, GRID, GRID_BOX} from '${ROOT}/renderer/filters.mjs'

const A = 'svp-vision://assets'
const video = document.getElementById('v')
const filterCanvas = document.getElementById('filter')
const filterCanvas2 = document.getElementById('filter2')
const filterCanvas3 = document.getElementById('filter3')
const filterCanvas4 = document.getElementById('filter4')
const filterCanvas5 = document.getElementById('filter5')
const out = document.getElementById('out')
const ctx = out.getContext('2d')
let landmarker = null
let renderer = null
let renderer2 = null
let renderer3 = null
let renderer4 = null
let renderer5 = null
let smoother = createSmoother()

window.__probe = {
  async init() {
    const fileset = await FilesetResolver.forVisionTasks(A)
    const bytes = new Uint8Array(await (await fetch(A + '/face_landmarker.task')).arrayBuffer())
    landmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: {modelAssetBuffer: bytes, delegate: 'GPU'},
      runningMode: 'VIDEO', numFaces: 3,
      minFaceDetectionConfidence: 0.4, minFacePresenceConfidence: 0.4, minTrackingConfidence: 0.4,
      outputFaceBlendshapes: false, outputFacialTransformationMatrixes: true,
    })
    await new Promise((r) => { if (video.readyState >= 2) r(); else video.addEventListener('loadeddata', r, {once: true}) })
    renderer = new FilterRenderer(filterCanvas)
    return {w: video.videoWidth, h: video.videoHeight, dur: video.duration}
  },

  seek(t) {
    return new Promise((r) => { video.addEventListener('seeked', () => r(video.currentTime), {once: true}); video.currentTime = t })
  },

  // Detection at the detector's real working size (the app downscales to DETECT_SIZE first).
  detect(detectSize, ts) {
    const c = document.createElement('canvas')
    const s = Math.min(1, detectSize / Math.max(video.videoWidth, video.videoHeight))
    c.width = Math.round(video.videoWidth * s)
    c.height = Math.round(video.videoHeight * s)
    c.getContext('2d').drawImage(video, 0, 0, c.width, c.height)
    const res = landmarker.detectForVideo(c, ts)
    return res?.faceLandmarks || []
  },

  // Composite: video, then the warp over it, then optional landmark dots.
  shoot(faceSets, filterDef, {dots = false, smooth = false, now = 0, variant = 'a', crop = 0} = {}) {
    const W = video.videoWidth, H = video.videoHeight
    out.width = W; out.height = H
    renderer.resize(W, H)
    const aspect = W / H
    let faces = faceSets.map((landmarks) => ({landmarks, opacity: 1}))
    if (smooth) faces = faces.map((f) => ({...f, landmarks: smoothFace(smoother, f.landmarks, aspect, now) || f.landmarks}))
    const r = renderer
    const rc = filterCanvas
    r.resize(W, H)
    const filter = typeof filterDef === 'string' ? FILTERS[filterDef] : filterDef
    r.draw(video, faces, filter, {x: 0, y: 0, width: W, height: H})
    ctx.drawImage(video, 0, 0, W, H)
    ctx.drawImage(rc, 0, 0, W, H)
    if (dots) {
      for (const f of faces) {
        ctx.fillStyle = '#00ff88'
        for (const p of f.landmarks) ctx.fillRect(p.x * W - 1, p.y * H - 1, 3, 3)
        const pose = facePose(f.landmarks, aspect)
        if (pose) {
          ctx.strokeStyle = '#ff0066'; ctx.lineWidth = 2
          ctx.beginPath()
          for (let r = 0; r <= 8; r++) {
            for (let c = 0; c <= 8; c++) {
              const lx = GRID_BOX.x0 + (GRID_BOX.x1 - GRID_BOX.x0) * c / 8
              const ly = GRID_BOX.y0 + (GRID_BOX.y1 - GRID_BOX.y0) * r / 8
              const [wx, wy] = toWorld(pose, lx, ly, aspect)
              ctx.rect(wx * W - 2, wy * H - 2, 4, 4)
            }
          }
          ctx.stroke()
        }
      }
    }
    if (crop && faces.length) {
      const pose = facePose(faces[0].landmarks, aspect)
      if (pose) {
        const cx = (pose.x / aspect) * W
        const cy = pose.y * H
        const half = pose.scale * W / aspect * crop
        const c = document.createElement('canvas')
        c.width = c.height = 512
        c.getContext('2d').drawImage(out, cx - half, cy - half * 0.95, half * 2, half * 2, 0, 0, 512, 512)
        return c.toDataURL('image/png')
      }
    }
    return out.toDataURL('image/png')
  },


  // A labelled map of candidate landmarks on a big face crop, so lamp and control indices can be
  // chosen by looking rather than by guessing.
  label(faceSets, indices, size) {
    const W = video.videoWidth, H = video.videoHeight
    out.width = W; out.height = H
    ctx.drawImage(video, 0, 0, W, H)
    const aspect = W / H
    const lm = faceSets[0]
    const pose = facePose(lm, aspect)
    if (!pose) return null
    ctx.font = 'bold 13px monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (const i of indices) {
      const p = lm[i]
      if (!p) continue
      const x = p.x * W, y = p.y * H
      ctx.fillStyle = 'rgba(0,0,0,0.75)'
      ctx.fillRect(x - 15, y - 8, 30, 16)
      ctx.fillStyle = '#ffee00'
      ctx.fillText(String(i), x, y)
    }
    const cx = (pose.x / aspect) * W, cy = pose.y * H
    const half = pose.scale * W / aspect * 1.45
    const c = document.createElement('canvas')
    c.width = c.height = size
    c.getContext('2d').drawImage(out, cx - half, cy - half * 0.95, half * 2, half * 2, 0, 0, size, size)
    return c.toDataURL('image/png')
  },

  reset() { smoother = createSmoother() },
}
`

// Optional: a filter table to try instead of the shipped one, so the numbers can be retuned
// without touching the repo.
const LABEL = (process.argv.find((a) => a.startsWith('--label='))?.slice(8) || '').split(',').filter(Boolean).map(Number)
const OVERRIDE = path.join(SCRATCH, 'chad.json')
const TABLES = fs.existsSync(OVERRIDE) ? JSON.parse(fs.readFileSync(OVERRIDE, 'utf8')) : {[FILTER]: FILTER}

app.whenReady().then(async () => {
  registerVision()
  const dir = path.join(SCRATCH, 'page')
  fs.mkdirSync(dir, {recursive: true})
  fs.copyFileSync(CLIP, path.join(dir, 'clip.mp4'))
  fs.writeFileSync(path.join(dir, 'index.html'), PAGE)
  await esbuild.build({
    stdin: {contents: SOURCE, resolveDir: ROOT, loader: 'js'},
    bundle: true,
    format: 'iife',
    target: 'chrome130',
    outfile: path.join(dir, 'probe.js'),
  })

  const win = new BrowserWindow({
    show: true,
    width: 1000,
    height: 700,
    webPreferences: {backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required', offscreen: false},
  })
  win.webContents.setAudioMuted(true)
  const run = (js) => win.webContents.executeJavaScript(js)
  try {
    await win.loadFile(path.join(dir, 'index.html'))
    const info = await run('window.__probe.init()')
    say(`clip ${info.w}x${info.h}, ${info.dur.toFixed(2)}s, filter=${FILTER}`)

    let ts = 0
    for (const t of TIMES) {
      await run(`window.__probe.seek(${t})`)
      ts += 100
      const faces = await run(`window.__probe.detect(768, ${ts})`)
      const n = faces.length
      const name = `t${String(t).replace('.', '_')}`
      for (const [label, def] of Object.entries(TABLES)) {
        const v = 'a'
        for (const [tag, opts] of [['', `{variant:"${v}"}`], ['-crop', `{variant:"${v}",crop:1.5}`]]) {
          const shot = await run(`window.__probe.shoot(${JSON.stringify(faces)}, ${JSON.stringify(def)}, ${opts})`)
          fs.writeFileSync(path.join(OUT, `${name}-${label}${tag}.png`), Buffer.from(shot.split(',')[1], 'base64'))
        }
      }
      if (LABEL.length) {
        const shot = await run(`window.__probe.label(${JSON.stringify(faces)}, ${JSON.stringify(LABEL)}, 1400)`)
        if (shot) fs.writeFileSync(path.join(OUT, `${name}-map.png`), Buffer.from(shot.split(',')[1], 'base64'))
      }
      say(`t=${t}s  faces=${n}`)
    }
    say('done')
  } catch (error) {
    say(`FAILED: ${error.stack || error}`)
    app.exit(1)
    return
  }
  app.exit(0)
})
