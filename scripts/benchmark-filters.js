// Live-service performance probe. Uses the production tracker, capture and renderer, a muted
// YouTube guest, and an isolated profile. No timing assertions: hardware and network vary.
const {app, BrowserWindow, ipcMain} = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const esbuild = require('esbuild')
const {prepareYouTube, registerYouTube, guardWebviews, captureGuest} = require('../main/youtube')
const {prepareVision, registerVision} = require('../main/vision')
const root = path.resolve(__dirname, '..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'svp-filter-perf-'))
const option = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=') || fallback
const videoId = option('video', 'DCqEdqxdDRE')
const filter = option('filter', 'mesh')
const seconds = Number(option('seconds', '12'))
const startAt = Number(option('at', '2'))
if (!/^[\w-]{11}$/.test(videoId) || !['mesh', 'chad', 'alien', 'chipmunk'].includes(filter)
    || !Number.isFinite(seconds) || seconds <= 0 || seconds > 60 || !Number.isFinite(startAt) || startAt < 0) {
  throw new Error('Use --video=<YouTube ID> --filter=mesh|chad|alien|chipmunk --seconds=1..60 --at=<seconds>')
}
app.setPath('userData', path.join(temporary, 'profile'))
prepareYouTube()
prepareVision()
const say = (value) => fs.writeSync(1, `${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`)
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const deadline = setTimeout(() => { say('FAIL: benchmark exceeded 90 seconds'); app.exit(1) }, 90000)

app.whenReady().then(async () => {
  registerYouTube()
  registerVision()
  ipcMain.handle('youtube:capture', captureGuest)
  const win = new BrowserWindow({show: false, width: 1280, height: 800, webPreferences: {
    preload: path.join(root, 'main/preload.js'), backgroundThrottling: false,
    autoplayPolicy: 'no-user-gesture-required', webviewTag: true,
  }})
  guardWebviews(win.webContents)
  win.webContents.setAudioMuted(true)
  const run = (source) => win.webContents.executeJavaScript(source)
  try {
    const policy = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8').match(/content="(default-src[^"]+)"/)[1]
    fs.writeFileSync(path.join(temporary, 'page.css'), 'body{margin:0} #player,webview{width:1280px;height:720px} #overlay{position:absolute;left:0;top:0}')
    fs.writeFileSync(path.join(temporary, 'index.html'), `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}"><link rel="stylesheet" href="page.css"><div id="player"></div><canvas id="overlay"></canvas>`)
    await win.loadFile(path.join(temporary, 'index.html'))
    const bundle = await esbuild.build({stdin: {resolveDir: root, contents: `
      import {YouTubePlayer} from './renderer/youtube.mjs'
      import {FaceTracker, captureGuest} from './renderer/faces.mjs'
      import {FilterRenderer} from './renderer/filter-gl.mjs'
      import {FILTERS} from './renderer/filters.mjs'
      window.player = new YouTubePlayer(document.getElementById('player'))
      window.failure = null
      player.addEventListener('error', ({detail}) => window.failure = String(detail))
      window.measure = async (seconds, filterId) => {
        const capture = await captureGuest(player.guestId)
        const tracker = new FaceTracker()
        if (!await tracker.start(capture.video)) throw new Error(String(tracker.error))
        const renderer = new FilterRenderer(document.getElementById('overlay'))
        renderer.resize(1280, 720)
        await new Promise(r => setTimeout(r, 1500))
        player.seek(${startAt})
        await new Promise(r => setTimeout(r, 1000))
        const samples = [], ages = [], draws = [], inference = [], latency = []
        const accepted = tracker.accept?.bind(tracker)
        if (accepted) tracker.accept = result => {
          inference.push(result.inferenceMs); latency.push(performance.now() - result.at)
          accepted(result)
        }
        const initialDetections = tracker.stats?.frames || 0
        let frames = 0, updates = 0, visible = 0, last = 0, previous = performance.now(), raf
        const started = previous
        const tick = () => {
          const now = performance.now()
          samples.push(now - previous); previous = now; frames++
          const faces = tracker.visible()
          if (faces.length) visible++
          const at = tracker.tracked[0]?.at
          if (at && at > last) { updates++; last = at; ages.push(now - at) }
          const before = performance.now()
          renderer.draw(capture.video, faces, FILTERS[filterId], {x:0,y:0,width:1280,height:720})
          draws.push(performance.now() - before)
          raf = requestAnimationFrame(tick)
        }
        raf = requestAnimationFrame(tick)
        await new Promise(r => setTimeout(r, seconds * 1000))
        cancelAnimationFrame(raf)
        const elapsed = (performance.now() - started) / 1000
        const summary = a => { a.sort((a,b)=>a-b); return {median:a[a.length>>1]||0, p95:a[Math.floor(a.length*.95)]||0, max:a.at(-1)||0} }
        const result = {video:player.videoId, filter:filterId, elapsed, renderFps:frames/elapsed,
          landmarkUpdatesPerSecond:updates/elapsed, framesWithFaces:visible/Math.max(1,frames),
          frameIntervalMs:summary(samples), landmarkAgeMs:summary(ages), drawMs:summary(draws),
          detectionsPerSecond:((tracker.stats?.frames || 0) - initialDetections)/elapsed,
          inferenceMs:summary(inference), workerRoundTripMs:summary(latency),
          trackerStats:tracker.stats, error:String(tracker.error||''),
          captureSize:[capture.video.videoWidth,capture.video.videoHeight]}
        tracker.close(); capture.stop(); renderer.destroy()
        return result
      }
    `}, bundle: true, write: false, format: 'iife', target: 'chrome130'})
    await run(bundle.outputFiles[0].text)
    await run(`player.open(${JSON.stringify(videoId)})`)
    for (let i = 0; i < 450; i++) {
      const state = await run('({error:window.failure, playing:player.playing, time:player.time})')
      if (state.error) throw new Error(state.error)
      if (state.playing && state.time > 1) break
      if (i === 449) throw new Error('YouTube did not start')
      await pause(100)
    }
    say(await run(`measure(${seconds}, ${JSON.stringify(filter)})`))
  } finally { win.destroy() }
}).then(() => { clearTimeout(deadline); app.exit(0) }, error => { say(`FAIL: ${error.stack || error}`); app.exit(1) })
