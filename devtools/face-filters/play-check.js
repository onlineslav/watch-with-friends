// Why the filter flashes. Runs the real FaceTracker against the clip in real time and logs what
// happens on every detection tick: how long it took, how many faces survived, and how different
// the thumbnail was from the last one (which is what the cut detector acts on).
const {app, BrowserWindow} = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = 'C:/Software Development/synced-video-player'
const esbuild = require(path.join(ROOT, 'node_modules', 'esbuild'))
const SCRATCH = __dirname
const CLIP = path.join(SCRATCH, 'clip.mp4')
const {prepareVision, registerVision} = require(path.join(ROOT, 'main', 'vision.js'))

const SECONDS = Number(process.argv.find((a) => a.startsWith('--seconds='))?.slice(10) || 10)

app.setPath('userData', path.join(SCRATCH, 'profile-play'))
prepareVision()
const say = (line = '') => fs.writeSync(1, `${line}\n`)

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0;background:#111">
<video id="v" src="clip.mp4" muted playsinline preload="auto"></video>
<script src="probe.js"></script>
</body></html>`

const SOURCE = `
import {FaceTracker} from '${ROOT}/renderer/faces.mjs'
import {CUT_THRESHOLD, frameDifference} from '${ROOT}/renderer/filters.mjs'

const video = document.getElementById('v')
window.failure = null
window.__play = {
  async run(seconds) {
    await new Promise((r) => { if (video.readyState >= 2) r(); else video.addEventListener('loadeddata', r, {once: true}) })
    const tracker = new FaceTracker()
    const ticks = []
    const frames = []

    // Wrap detect so every tick is recorded with the thumbnail difference it acted on.
    const inner = tracker.detect.bind(tracker)
    tracker.detect = () => {
      const before = tracker.thumbnail
      const t0 = performance.now()
      inner()
      const ms = performance.now() - t0
      const after = tracker.thumbnail
      const diff = before && after ? frameDifference(before, after) : null
      ticks.push({t: +video.currentTime.toFixed(2), ms: +ms.toFixed(1), tracked: tracker.tracked.length, diff: diff === null ? null : +diff.toFixed(3)})
    }

    const started = await tracker.start(video)
    if (!started) { window.failure = 'tracker did not start: ' + (tracker.error && tracker.error.message); return null }
    await video.play()

    // Sample what would actually be drawn, every rendered frame.
    let raf = 0
    const sample = () => {
      const visible = tracker.visible()
      frames.push(visible.length ? visible[0].opacity : 0)
      raf = requestAnimationFrame(sample)
    }
    raf = requestAnimationFrame(sample)
    await new Promise((r) => setTimeout(r, seconds * 1000))
    cancelAnimationFrame(raf)
    video.pause()
    tracker.stop()

    // A flash is a run of frames with nothing to draw, between frames that had something.
    const gaps = []
    let run = 0
    for (const opacity of frames) {
      if (opacity <= 0) run++
      else { if (run) gaps.push(run); run = 0 }
    }
    return {ticks, cutThreshold: CUT_THRESHOLD, frames: frames.length,
      blank: frames.filter((o) => o <= 0).length,
      partial: frames.filter((o) => o > 0 && o < 1).length,
      gaps}
  },
}
`

app.whenReady().then(async () => {
  registerVision()
  const dir = path.join(SCRATCH, 'play')
  fs.mkdirSync(dir, {recursive: true})
  fs.copyFileSync(CLIP, path.join(dir, 'clip.mp4'))
  fs.writeFileSync(path.join(dir, 'index.html'), PAGE)
  await esbuild.build({stdin: {contents: SOURCE, resolveDir: ROOT, loader: 'js'}, bundle: true, format: 'iife', target: 'chrome130', outfile: path.join(dir, 'probe.js')})

  const win = new BrowserWindow({show: true, width: 900, height: 600, webPreferences: {backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required'}})
  win.webContents.setAudioMuted(true)
  try {
    await win.loadFile(path.join(dir, 'index.html'))
    const out = await win.webContents.executeJavaScript(`window.__play.run(${SECONDS})`)
    if (!out) throw new Error(await win.webContents.executeJavaScript('window.failure'))

    const {ticks, cutThreshold, frames, blank, partial, gaps} = out
    say(`rendered frames: ${frames}   nothing drawn: ${blank} (${((blank / frames) * 100).toFixed(1)}%)   fading: ${partial}`)
    say(`gaps (consecutive blank frames): ${gaps.length} runs, longest ${Math.max(0, ...gaps)}`)
    say('')
    const lost = ticks.filter((t) => t.tracked === 0)
    const cuts = ticks.filter((t) => t.diff !== null && t.diff > cutThreshold)
    const slow = ticks.filter((t) => t.ms > 66)
    say(`detection ticks: ${ticks.length}`)
    say(`  found no face:        ${lost.length}`)
    say(`  over the cut line:    ${cuts.length}  (threshold ${cutThreshold})`)
    say(`  slower than one tick: ${slow.length}  (max ${Math.max(...ticks.map((t) => t.ms)).toFixed(0)}ms, median ${ticks.map((t) => t.ms).sort((a, b) => a - b)[ticks.length >> 1]}ms)`)
    say('')
    say('  ticks with no face found:')
    say('  ' + lost.map((t) => t.t).join(', '))
    say('')
    say('  last 30 ticks:')
    say('  t     ms  faces  framediff')
    for (const tick of ticks.slice(-30)) {
      const flag = tick.diff !== null && tick.diff > cutThreshold ? '  <- counted as a cut' : ''
      say(`  ${String(tick.t).padStart(5)} ${String(tick.ms).padStart(5)} ${String(tick.tracked).padStart(5)}  ${String(tick.diff).padStart(6)}${flag}`)
    }
  } catch (error) {
    say(`FAILED: ${error.stack || error}`)
    app.exit(1)
    return
  }
  app.exit(0)
})
