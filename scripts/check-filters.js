// Integration check for the face filters. Runs the real modules in a hidden window against the
// app's own Content-Security-Policy, so it catches the things unit tests cannot: whether the
// WebAssembly runtime is allowed to load at all, whether the model arrives over svp-vision://,
// whether the shader compiles, and whether the YouTube player's webview can be streamed.
//
// Everything here is local and synthetic. It does not prove MediaPipe finds faces in a film — that
// is MediaPipe's job, not this code's — it proves the pipeline around it is wired up and running.
const {app, BrowserWindow, ipcMain, session, webContents} = require('electron')
const {prepareVision, registerVision} = require('../main/vision')
const {prepareYouTube, guardWebviews, captureGuest} = require('../main/youtube')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const esbuild = require('esbuild')

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'svp-filters-check-'))
app.setPath('userData', path.join(temporary, 'profile'))
prepareYouTube()
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

// The capture test needs three distinguishable areas: the player's guest, something drawn over it,
// and the page around it. Capturing the guest must return the first and neither of the others.
// Orange rather than green for the guest, because green is the one colour a red/blue channel mix-up
// would leave looking correct.
const GUEST = '<!doctype html><html><body style="margin:0;height:100vh;background:#ff8000"></body></html>'
// In a stylesheet, not style attributes: the app's own policy is `style-src 'self'`, which drops an
// inline style outright. A webview that silently loses its width and height falls back to a size
// the player never had, and every landmark is then measured against the wrong aspect ratio.
const PAGE_CSS = `body { margin: 0; background: #0000ff; }
#guest { position: absolute; left: 0; top: 0; display: inline-flex; width: 640px; height: 360px; }
#guest.resized { width: 500px; height: 400px; }
#cover { position: absolute; left: 0; top: 0; width: 640px; height: 120px; background: #ff0000; }
#filter { position: absolute; left: 0; top: 400px; }`
const PAGE = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${CSP}" />
<link rel="stylesheet" href="check.css" />
</head><body>
<webview id="guest" src="svp-youtube://player/index.html"></webview>
<div id="cover"></div>
<canvas id="filter"></canvas>
</body></html>`

app.whenReady().then(async () => {
  registerVision()
  // A stand-in for the real player page: everything here stays local, and what is being checked is
  // the capture, not YouTube.
  session.defaultSession.protocol.handle('svp-youtube', async () => new Response(GUEST, {headers: {'Content-Type': 'text/html'}}))
  ipcMain.handle('youtube:capture', (event, guestId) => captureGuest(event, guestId))
  // Hidden on purpose: tab capture of a guest works without showing a test window.
  const win = new BrowserWindow({show: false, width: 900, height: 820, webPreferences: {preload: path.join(root, 'main', 'preload.js'), backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required', webviewTag: true}})
  guardWebviews(win.webContents)
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
    fs.writeFileSync(path.join(temporary, 'check.css'), PAGE_CSS)
    fs.writeFileSync(path.join(temporary, 'index.html'), PAGE)
    await win.loadFile(path.join(temporary, 'index.html'))

    const bundle = await esbuild.build({
      stdin: {
        contents: `
          import {FaceTracker, captureGuest, faceConnections} from './renderer/faces.mjs'
          import {FilterRenderer} from './renderer/filter-gl.mjs'
          import {FILTERS, buildMesh, toWorld} from './renderer/filters.mjs'
          window.failure = null
          Object.assign(window, {FaceTracker, captureGuest, faceConnections, FilterRenderer, FILTERS, buildMesh, toWorld})

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
    say('PASS: MediaPipe loads in a worker under the app CSP, with the model served over svp-vision://')

    // ---- 2. Detection runs on real frames without throwing. A stripe pattern has no face in it,
    // so finding none is the correct answer; what is being checked is that it completes.
    await until('window.tracker.stats.frames > 0 || window.tracker.error', 'worker completes its first inference')
    const detected = await run('({error: String(window.tracker.error || ""), faces: window.tracker.visible().length, frames: window.tracker.stats.frames})')
    assert.equal(detected.error, '', `detection threw: ${detected.error}`)
    assert.ok(detected.frames > 0, 'the worker never completed inference')
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

    // ---- 3b. The face map draws the detector's own landmarks instead of a warp. It shares the
    // canvas and the viewport with the warp but none of its program, so it is checked separately:
    // a mesh of thin lines and dots must mark the face without filling it the way the warp does.
    const map = await run(`
      (() => {
        const canvas = document.getElementById('filter')
        const renderer = new FilterRenderer(canvas)
        renderer.resize(640, 360)
        const faces = [{landmarks: window.fixture, opacity: 1}]
        renderer.draw(window.video, faces, window.FILTERS.mesh, {x: 0, y: 0, width: 640, height: 360})
        const flat = document.createElement('canvas')
        Object.assign(flat, {width: 640, height: 360})
        const c = flat.getContext('2d')
        c.drawImage(canvas, 0, 0)
        const {data} = c.getImageData(0, 0, 640, 360)
        let marked = 0, minX = 640, maxX = 0
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] > 40) {
            marked++
            const x = (i / 4) % 640
            if (x < minX) minX = x
            if (x > maxX) maxX = x
          }
        }
        return {marked, minX, maxX, edges: window.faceConnections().length}
      })()
    `)
    assert.ok(map.edges > 100, `MediaPipe's tessellation did not come through (${map.edges} edges)`)
    const mapShare = (map.marked / (640 * 360)) * 100
    // Drawing nothing means the mesh program or the landmark buffers are broken; covering the
    // canvas means it is painting somewhere other than the face.
    assert.ok(mapShare > 0.5, `the face map drew almost nothing (${mapShare.toFixed(1)}% of the canvas)`)
    assert.ok(mapShare < 25, `the face map covered far more than a face (${mapShare.toFixed(1)}% of the canvas)`)
    const mapCentre = (map.minX + map.maxX) / 2
    assert.ok(Math.abs(mapCentre - 320) < 60, `the face map landed off-centre at x=${mapCentre}`)
    say(`PASS: the face map draws ${map.edges} mesh edges and its landmarks over the face (${mapShare.toFixed(1)}% of the canvas)`)

    say('')

    // ---- 4 and 5. Capturing the player's guest, which is what the whole YouTube path stands on.
    // The guest is orange, a strip drawn over it by the embedder is red, and the page behind it is
    // blue. Only orange may come back: red proves the filter canvas would be fed into the detector
    // it came from, and blue proves the capture is the window rather than the guest, which would
    // put every landmark in the wrong place.
    const guestId = await run(`
      new Promise((resolve, reject) => {
        const guest = document.getElementById('guest')
        if (guest.getWebContentsId) { try { return resolve(guest.getWebContentsId()) } catch {} }
        guest.addEventListener('dom-ready', () => resolve(guest.getWebContentsId()), {once: true})
        setTimeout(() => reject(new Error('the webview never attached')), 10000)
      })
    `)
    assert.ok(Number.isInteger(guestId), 'the player webview did not attach under the app CSP')
    say(`PASS: the player's webview attaches under the app CSP (guest ${guestId})`)

    // A webview has no intrinsic size, so it is worth knowing separately that it got the one the
    // stylesheet gives it. Losing that is silent: the guest falls back to a size the player never
    // had, and since the aspect ratio is what every landmark is measured against, the whole warp
    // lands in the wrong place while every other check still passes.
    const element = await run(`(() => { const g = document.getElementById('guest'); return [g.clientWidth, g.clientHeight] })()`)
    assert.deepEqual(element, [640, 360], `the player webview is ${element[0]}x${element[1]}, not the size the stylesheet gives it`)
    const inside = await webContents.fromId(guestId).executeJavaScript('[innerWidth, innerHeight]')
    assert.ok(Math.abs(inside[0] / inside[1] - 640 / 360) < 0.05, `the guest's own view is ${inside[0]}x${inside[1]}, not the shape of the element`)
    say(`PASS: the guest is laid out at the size the page gives it (${inside[0]}x${inside[1]})`)

    await run(`
      window.capture = null
      window.captureError = ''
      window.tracker.stop()
      captureGuest(${guestId}).then(
        (capture) => (window.capture = capture),
        (error) => (window.captureError = String(error)),
      )
      // executeJavaScript resolves with the completion value, and awaits it when that value is a
      // promise. Ending on a plain value keeps this call fire-and-forget: otherwise the check waits
      // here for the capture instead of polling for it, and a stall looks like a dead harness.
      null
    `)
    await until('Boolean(window.capture) || Boolean(window.captureError)', 'the guest capture resolves')
    const captureError = await run('window.captureError || ""')
    assert.equal(captureError, '', `capturing the guest failed: ${captureError}`)
    await until('Boolean(window.capture && window.capture.video.videoWidth > 0)', 'the guest produces frames')
    // The first frame back can be taken mid-layout, at a size the player never actually had. The
    // aspect ratio is what every landmark position is measured against, so it has to settle on the
    // shape of the element rather than stay at whatever the attach happened to catch.
    await until(`Math.abs(window.capture.video.videoWidth / window.capture.video.videoHeight - 640 / 360) < 0.05`,
      'the captured frame settles on the shape of the player')

    const seen = await run(`
      (() => {
        const frame = window.capture.video
        const w = frame.videoWidth, h = frame.videoHeight
        const canvas = document.createElement('canvas')
        canvas.width = w; canvas.height = h
        const c = canvas.getContext('2d', {willReadFrequently: true})
        c.drawImage(frame, 0, 0)
        const {data} = c.getImageData(0, 0, w, h)
        let guest = 0, cover = 0, page = 0
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i], g = data[i + 1], b = data[i + 2]
          if (r > 150 && g > 80 && g < 180 && b < 100) guest++
          else if (r > 150 && g < 80 && b < 100) cover++
          else if (b > 150 && r < 100 && g < 100) page++
        }
        const total = data.length / 4
        return {w, h, guest: (guest / total) * 100, cover: (cover / total) * 100, page: (page / total) * 100}
      })()
    `)
    assert.ok(seen.guest > 95, `the capture is not the player's guest (${seen.guest.toFixed(1)}% of it) — a red/blue mix-up looks like this`)
    assert.ok(seen.cover < 1, `content drawn over the player leaked into the capture (${seen.cover.toFixed(1)}%)`)
    assert.ok(seen.page < 1, `the page around the player leaked into the capture (${seen.page.toFixed(1)}%)`)
    say(`PASS: the capture is the guest alone, in the right channel order (${seen.guest.toFixed(1)}% guest, ${seen.cover.toFixed(1)}% occluder, ${seen.page.toFixed(1)}% page) at ${seen.w}x${seen.h}`)

    // A guest belonging to no window at all must be refused, or any renderer could photograph any
    // other window's contents.
    const stranger = await captureGuest({sender: win.webContents}, guestId + 1000)
    assert.equal(stranger, null, "captureGuest photographed a webContents that is not this window's guest")
    say("PASS: a capture request for anything but the caller's own player is refused")

    await run("document.getElementById('guest').classList.add('resized')")
    await until('Math.abs(window.capture.video.videoWidth / window.capture.video.videoHeight - 1.25) < 0.03', 'capture follows a resized guest')
    const resized = await run(`(() => {
      const v = window.capture.video, c = document.createElement('canvas')
      c.width = 100; c.height = 100
      const ctx = c.getContext('2d'); ctx.drawImage(v, 0, 0, 100, 100)
      const pixels = ctx.getImageData(0, 0, 100, 100).data
      let orange = 0
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 150 && pixels[i+1] > 80 && pixels[i+2] < 100) orange++
      return orange / 10000
    })()`)
    assert.ok(resized > 0.95, `resized tab capture added letterboxing: ${resized}`)
    say('PASS: video capture follows guest resizing without adding letterboxing')

    const stopped = await run(`(() => {
      const tracks = window.capture.video.srcObject.getTracks()
      window.capture.stop(); window.tracker.close()
      return tracks.every(t => t.readyState === 'ended') && window.capture.video.srcObject === null
    })()`)
    assert.ok(stopped, 'capture tracks were not released')

    say('')
    say('All filter checks passed. Two things are deliberately not covered: whether MediaPipe finds')
    say('faces in real footage, and whether a real YouTube video inside the guest is captured the')
    say('same way as this stand-in. Play a film, then a YouTube video, with a filter on.')
  } finally {
    win.destroy()
  }
}).then(() => app.exit(0), (error) => {
  say(`FAIL: ${error && error.message ? error.message : error}`)
  app.exit(1)
})
