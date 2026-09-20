// Integration check for the face filters. Runs the real modules in a hidden window against the
// app's own Content-Security-Policy, so it catches the things unit tests cannot: whether the
// WebAssembly runtime is allowed to load at all, whether the model arrives over svp-vision://,
// whether the shader compiles, and whether the window can capture itself for the YouTube path.
//
// Everything here is local and synthetic. It does not prove MediaPipe finds faces in a film — that
// is MediaPipe's job, not this code's — it proves the pipeline around it is wired up and running.
const {app, BrowserWindow} = require('electron')
const {prepareVision, registerVision} = require('../main/vision')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const esbuild = require('esbuild')

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'svp-filters-check-'))
app.setPath('userData', path.join(temporary, 'profile'))
prepareVision()
const root = path.resolve(__dirname, '..')
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// app.exit() discards whatever console.log still has buffered, which silently truncates the
// transcript at whatever point the buffer last flushed. Write straight to the descriptor.
const STALLED = Symbol('stalled')
const say = (line = '') => fs.writeSync(1, `${line}
`)

// The same policy the app ships, so a directive the filters need but index.html lacks fails here.
const CSP = fs
  .readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8')
  .match(/content="(default-src[^"]+)"/)[1]

// The capture test needs three distinguishable areas: the element being captured, something drawn
// over it, and the page around it. Element Capture must return the first and neither of the others.
const PAGE = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${CSP}" />
</head><body style="margin:0;background:#0000ff">
<div id="surface" style="position:absolute;left:0;top:0;width:640px;height:360px;isolation:isolate;background:#00cc00"></div>
<div id="cover" style="position:absolute;left:0;top:0;width:640px;height:120px;background:#ff0000"></div>
<canvas id="filter" style="position:absolute;left:0;top:400px"></canvas>
</body></html>`

app.whenReady().then(async () => {
  registerVision()
  // Visible on purpose: getDisplayMedia never resolves for a window that is not being shown, so a
  // hidden window would hang this check rather than fail it.
  const win = new BrowserWindow({show: true, width: 900, height: 820, webPreferences: {backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required'}})
  win.webContents.setAudioMuted(true)
  const run = (source) => win.webContents.executeJavaScript(source)
  const until = async (condition, label = condition) => {
    for (let i = 0; i < 300; i++) {
      // A blocked renderer never answers executeJavaScript at all, so the poll itself is raced
      // against a deadline: without this the check hangs instead of reporting where it got stuck.
      // A sentinel object, because a condition may legitimately answer with any truthy value and a
      // string or boolean marker would be mistaken for one.
      const answer = await Promise.race([
        (async () => {
          const failure = await run('window.failure')
          if (failure) throw new Error(failure)
          return await run(condition)
        })(),
        pause(2000).then(() => STALLED),
      ])
      if (answer !== STALLED && answer) return
      if (answer === STALLED) say(`  ... waiting on ${label} (${(i / 5) | 0}s, renderer not answering)`)
      await pause(200)
    }
    throw new Error(`Timed out: ${label}`)
  }
  try {
    fs.writeFileSync(path.join(temporary, 'index.html'), PAGE)
    await win.loadFile(path.join(temporary, 'index.html'))

    const bundle = await esbuild.build({
      stdin: {
        contents: `
          import {FaceTracker, captureElement} from './renderer/faces.mjs'
          import {FilterRenderer} from './renderer/filter-gl.mjs'
          import {FILTERS, buildMesh, toWorld} from './renderer/filters.mjs'
          window.failure = null
          Object.assign(window, {FaceTracker, captureElement, FilterRenderer, FILTERS, buildMesh, toWorld})

          // A synthetic "video": a canvas of coloured stripes, streamed into a <video> so it has
          // the videoWidth/videoHeight the pipeline reads. Stripes make a warp visible.
          const source = document.createElement('canvas')
          Object.assign(source, {width: 640, height: 360})
          const ctx = source.getContext('2d')
          window.paint = () => {
            for (let x = 0; x < 640; x += 16) {
              ctx.fillStyle = (x / 16) % 2 ? '#e0402a' : '#2a6fe0'
              ctx.fillRect(x, 0, 16, 360)
            }
          }
          window.paint()
          const stream = source.captureStream(30)
          setInterval(window.paint, 33)
          const video = document.createElement('video')
          video.muted = true
          video.srcObject = stream
          window.video = video
          window.ready = video.play().then(() => true, (e) => { window.failure = String(e); return false })

          // The fixture face from the unit tests, in image coordinates.
          const LAYOUT = new Map([[33,[-0.5,0]],[263,[0.5,0]],[1,[0,0.5]],[152,[0,1.8]],[10,[0,-1.3]],
            [234,[-1.05,0.4]],[454,[1.05,0.4]],[93,[-1,0.75]],[323,[1,0.75]],
            [172,[-0.9,1]],[136,[-0.82,1.25]],[150,[-0.68,1.45]],[149,[-0.5,1.62]],[176,[-0.3,1.74]],
            [148,[-0.15,1.79]],[377,[0.15,1.79]],[400,[0.3,1.74]],[378,[0.5,1.62]],[379,[0.68,1.45]],
            [365,[0.82,1.25]],[397,[0.9,1]],[132,[-1,0.85]],[58,[-0.95,1.1]],[288,[0.95,1.1]],[361,[1,0.85]],
            [70,[-0.66,-0.36]],[63,[-0.56,-0.42]],[105,[-0.44,-0.45]],[66,[-0.32,-0.42]],[107,[-0.2,-0.38]],
            [336,[0.2,-0.38]],[296,[0.32,-0.42]],[334,[0.44,-0.45]],[293,[0.56,-0.42]],[300,[0.66,-0.36]],
            [133,[-0.24,0]],[159,[-0.37,-0.1]],[145,[-0.37,0.1]],[362,[0.24,0]],[386,[0.37,-0.1]],[374,[0.37,0.1]],
            [103,[-0.8,-0.95]],[67,[-0.5,-1.12]],[109,[-0.2,-1.2]],[338,[0.2,-1.2]],[297,[0.5,-1.12]],[332,[0.8,-0.95]]])
          const aspect = 640 / 360
          const pose = {x: 0.5 * aspect, y: 0.45, scale: 0.16, cos: 1, sin: 0}
          window.fixture = Array.from({length: 478}, () => ({x: 0.5, y: 0.45}))
          for (const [index, [lx, ly]] of LAYOUT) {
            const [wx, wy] = toWorld(pose, lx, ly, aspect)
            window.fixture[index] = {x: wx, y: wy}
          }
        `,
        resolveDir: root,
      },
      bundle: true,
      write: false,
      format: 'iife',
      target: 'chrome130',
    })
    await run(bundle.outputFiles[0].text)
    await until('Boolean(window.video.videoWidth > 0)', 'the synthetic source starts')

    // ---- 1. MediaPipe loads at all: CSP, the wasm runtime and the model over svp-vision://.
    await run(`
      window.tracker = new FaceTracker()
      window.started = null
      window.tracker.start(window.video).then((ok) => (window.started = {ok, error: String(window.tracker.error || '')}))
    `)
    await until('Boolean(window.started)', 'MediaPipe loads')
    const started = await run('window.started')
    assert.equal(started.ok, true, `the face landmarker did not load: ${started.error}`)
    say('PASS: MediaPipe loads under the app CSP, with the model served over svp-vision://')

    // ---- 2. Detection runs on real frames without throwing. A stripe pattern has no face in it,
    // so finding none is the correct answer; what is being checked is that it completes.
    await pause(600)
    const detected = await run('({error: String(window.tracker.error || ""), faces: window.tracker.visible().length})')
    assert.equal(detected.error, '', `detection threw: ${detected.error}`)
    say(`PASS: detectForVideo runs on live frames (${detected.faces} faces in a test pattern, as expected)`)

    // ---- 3. The shader compiles and the warp actually puts pixels on the canvas.
    const drawn = await run(`
      (() => {
        const canvas = document.getElementById('filter')
        const renderer = new FilterRenderer(canvas)
        renderer.resize(640, 360)
        const faces = [{landmarks: window.fixture, opacity: 1}]
        renderer.draw(window.video, faces, window.FILTERS.chad, {x: 0, y: 0, width: 640, height: 360})
        // Same task as the draw, so the drawing buffer is still there to copy out of.
        const flat = document.createElement('canvas')
        Object.assign(flat, {width: 640, height: 360})
        const c = flat.getContext('2d')
        c.drawImage(canvas, 0, 0)
        const {data} = c.getImageData(0, 0, 640, 360)
        let opaque = 0, minX = 640, maxX = 0, minY = 360, maxY = 0
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] > 200) {
            opaque++
            const p = i / 4, x = p % 640, y = (p / 640) | 0
            if (x < minX) minX = x
            if (x > maxX) maxX = x
            if (y < minY) minY = y
            if (y > maxY) maxY = y
          }
        }
        return {opaque, minX, maxX, minY, maxY}
      })()
    `)
    // The filter covers one face, so it must cover a face-sized part of the canvas. Both bounds
    // matter: drawing nothing means the warp is broken, and covering everything means the canvas is
    // opaque where it should be transparent, which would hide the whole video behind a grey slab.
    const share = (drawn.opaque / (640 * 360)) * 100
    assert.ok(share > 2, `the warp drew almost nothing (${share.toFixed(1)}% of the canvas)`)
    assert.ok(share < 45, `the filter canvas is opaque where it should be clear (${share.toFixed(1)}% of the canvas)`)
    // The fixture face is centred, so the drawn region must be too rather than smeared to a corner.
    const centreX = (drawn.minX + drawn.maxX) / 2
    assert.ok(Math.abs(centreX - 320) < 60, `the warp landed off-centre at x=${centreX}`)
    say(`PASS: the filter shader draws the warp over the face alone (${share.toFixed(1)}% of the canvas, centred at x=${Math.round(centreX)})`)

    say('')
    say('Core filter pipeline verified. Two things are deliberately not covered: whether MediaPipe')
    say('finds faces in real footage, and whether a cross-origin YouTube iframe survives Element')
    say('Capture. Play a film, then a YouTube video, with a filter on to confirm those.')
    say('')

    // ---- 4 and 5. Self-capture, which is what the whole YouTube path stands on. Opt-in, because
    // the compositor only produces frames while the window is genuinely on screen and not covered:
    // on a busy desktop or a headless machine this fails for reasons unrelated to this code, and a
    // check that fails for unrelated reasons is worse than no check.
    if (!process.argv.includes('--capture')) {
      say('SKIP: self-capture checks — pass --capture with the window visible and uncovered')
      return
    }
    assert.equal(await run('typeof RestrictionTarget'), 'function', 'this Electron build has no Element Capture')
    await run(`
      window.capture = null
      window.captureError = ''
      window.tracker.stop()
      captureElement(document.getElementById('surface')).then(
        (capture) => (window.capture = capture),
        (error) => (window.captureError = String(error)),
      )
      // executeJavaScript resolves with the completion value, and awaits it when that value is a
      // promise. Ending on a plain value keeps this call fire-and-forget: otherwise the check waits
      // here for the capture instead of polling for it, and a stall looks like a dead harness.
      null
    `)
    await until('Boolean(window.capture) || Boolean(window.captureError)', 'self-capture resolves')
    const captureError = await run('window.captureError || ""')
    assert.equal(captureError, '', `self-capture failed: ${captureError}`)
    await until('Boolean(window.capture && window.capture.video.videoWidth > 0)', 'the captured element produces frames')

    // ---- 5. What the capture actually contains. The target is green, the strip drawn over it is
    // red, and the page behind it is blue. Only green may come back: red proves the filter canvas
    // would be fed into the detector it came from, and blue proves the capture is really the whole
    // window, which would put every landmark in the wrong place.
    const seen = await run(`
      (async () => {
        const video = window.capture.video
        await new Promise((r) => setTimeout(r, 600))
        const w = video.videoWidth, h = video.videoHeight
        const canvas = document.createElement('canvas')
        Object.assign(canvas, {width: w, height: h})
        const c = canvas.getContext('2d', {willReadFrequently: true})
        c.drawImage(video, 0, 0)
        const {data} = c.getImageData(0, 0, w, h)
        let green = 0, red = 0, blue = 0
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i], g = data[i + 1], b = data[i + 2]
          if (g > 150 && r < 100 && b < 100) green++
          else if (r > 150 && g < 100 && b < 100) red++
          else if (b > 150 && r < 100 && g < 100) blue++
        }
        const total = data.length / 4
        return {w, h, green: (green / total) * 100, red: (red / total) * 100, blue: (blue / total) * 100}
      })()
    `)
    assert.ok(seen.green > 95, `the capture is not the target element (${seen.green.toFixed(1)}% of it)`)
    assert.ok(seen.red < 1, `content drawn over the target leaked into the capture (${seen.red.toFixed(1)}%)`)
    assert.ok(seen.blue < 1, `the page around the target leaked into the capture (${seen.blue.toFixed(1)}%)`)
    say(`PASS: Element Capture returns the target alone (${seen.green.toFixed(1)}% target, ${seen.red.toFixed(1)}% occluder, ${seen.blue.toFixed(1)}% page) at ${seen.w}x${seen.h}`)
    await run('window.capture.stop()')

    say('\nAll filter checks passed. One thing is not covered here: whether a cross-origin')
    say('YouTube iframe inside the captured element survives. Play a YouTube video in the')
    say('app with a filter on to confirm that.')
  } finally {
    win.destroy()
  }
}).then(() => app.exit(0), (error) => {
  say(`FAIL: ${error && error.message ? error.message : error}`)
  app.exit(1)
})
