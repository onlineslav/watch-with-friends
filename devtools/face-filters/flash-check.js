// The YouTube picture flashes since the player became a <webview>, with no filter running — so it
// is the swap itself, not the capture loop. This measures it instead of describing it.
//
// A real video plays in a real webview, driven by the real YouTubePlayer. Then two things are
// sampled 20 times a second: the guest's own pixels, and the window's. The video area's brightness
// is printed as a sparkline per sample, so a blink shows up as a trough rather than as an
// impression. A run of `_` in the window row with a steady guest row means the guest is painting
// fine and the flash is in how the embedder composites it.
//
//   node scripts/electron.js devtools/face-filters/flash-check.js [--seconds=8] [--iframe]
//
// --iframe loads the same page with the old <iframe> instead, which is the before-and-after.
const {app, BrowserWindow, webContents} = require('electron')
const {prepareYouTube, registerYouTube, guardWebviews} = require('../../main/youtube')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const esbuild = require('esbuild')

const say = (line = '') => fs.writeSync(1, `${line}\n`)
const arg = (name, fallback) => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`))
  return found ? Number(found.slice(name.length + 3)) : fallback
}
const SECONDS = arg('seconds', 8)
const IFRAME = process.argv.includes('--iframe')
const VIDEO = 'M7lc1UVf-VE'
const HZ = 20

const root = path.resolve(__dirname, '../..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'svp-flash-'))
app.setPath('userData', path.join(temporary, 'profile'))
prepareYouTube()

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// The app's own policy, so the page composites the way the real one does.
const CSP = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8').match(/content="(default-src[^"]+)"/)[1]
// --board adds what the room always has over the picture: the whiteboard canvas, transparent and
// never hidden, covering the whole stage.
const BOARD = process.argv.includes('--board')
const CSS = `body { margin: 0; background: #0b0b0f; }
#stage { position: absolute; left: 0; top: 0; width: 1000px; height: 660px; }
#player { position: absolute; left: 0; top: 64px; width: 960px; height: 540px; }
#player webview, #player iframe { display: inline-flex; width: 100%; height: 100%; border: 0; }
#board { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }`
const PAGE = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${CSP}" />
<link rel="stylesheet" href="page.css" /></head><body><div id="stage"><div id="player"></div>${BOARD ? '<canvas id="board"></canvas>' : ''}</div></body></html>`

// Mean brightness of the middle of the picture, where a YouTube video always has something. The
// controls and the page around it are deliberately outside this box.
function brightness(image) {
  const {width, height} = image.getSize()
  if (!width || !height) return 0
  const bitmap = image.toBitmap()
  let total = 0
  let counted = 0
  for (let y = (height * 0.3) | 0; y < (height * 0.7) | 0; y += 4) {
    for (let x = (width * 0.3) | 0; x < (width * 0.7) | 0; x += 4) {
      const at = (y * width + x) * 4
      total += bitmap[at] + bitmap[at + 1] + bitmap[at + 2]
      counted++
    }
  }
  return counted ? total / (counted * 3) : 0
}

const BARS = '_.:-=+*#%@'
const spark = (values, peak) => values.map((v) => BARS[Math.min(BARS.length - 1, Math.round((v / (peak || 1)) * (BARS.length - 1)))]).join('')

app.whenReady().then(async () => {
  registerYouTube()
  const win = new BrowserWindow({show: true, width: 1000, height: 700, backgroundColor: '#0b0b0f',
    webPreferences: {backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required', webviewTag: true}})
  win.webContents.setAudioMuted(true)
  guardWebviews(win.webContents)
  const run = (source) => win.webContents.executeJavaScript(source)
  try {
    fs.writeFileSync(path.join(temporary, 'page.css'), CSS)
    fs.writeFileSync(path.join(temporary, 'index.html'), PAGE)
    await win.loadFile(path.join(temporary, 'index.html'))

    const bundle = await esbuild.build({stdin: {contents: `
      import {YouTubePlayer} from './renderer/youtube.mjs'
      window.player = new YouTubePlayer(document.getElementById('player'))
      window.failure = null
      player.addEventListener('error', ({detail}) => (window.failure = detail))
    `, resolveDir: root}, bundle: true, write: false, format: 'iife', target: 'chrome130'})
    await run(bundle.outputFiles[0].text)

    if (IFRAME) {
      // The old path, for comparison: same page, same CSS, an iframe instead of a guest.
      await run(`
        player.ensureFrame = function () {
          if (this.frame) return
          const frame = document.createElement('iframe')
          frame.src = 'svp-youtube://player/index.html'
          frame.allow = 'autoplay; fullscreen; encrypted-media; picture-in-picture'
          this.frame = frame
          this.ready = false
          this.container.replaceChildren(frame)
        }
        null
      `)
    }
    await run(`player.open('${VIDEO}')`)
    for (let i = 0; i < 200 && !(await run('player.playing && player.time > 0.5')); i++) {
      const failure = await run('window.failure')
      if (failure) throw new Error(failure)
      await pause(100)
    }
    const guestId = await run('player.guestId || null')
    if (!IFRAME && !guestId) throw new Error('the player never reported a guest')
    say(`playing ${VIDEO} in ${IFRAME ? 'an <iframe>' : `a <webview> (guest ${guestId})`}${BOARD ? ', with the whiteboard canvas over it' : ''}, sampling ${SECONDS}s at ${HZ}Hz`)
    say('')

    const guest = guestId ? webContents.fromId(guestId) : null
    const fromGuest = []
    const fromWindow = []
    for (let i = 0; i < SECONDS * HZ; i++) {
      const started = Date.now()
      if (guest) fromGuest.push(brightness(await guest.capturePage()))
      fromWindow.push(brightness(await win.webContents.capturePage()))
      await pause(Math.max(0, 1000 / HZ - (Date.now() - started)))
    }

    const report = (label, values) => {
      if (!values.length) return
      const peak = Math.max(...values)
      const dark = values.filter((v) => v < peak * 0.25).length
      say(`${label.padEnd(8)} ${spark(values, peak)}`)
      say(`${''.padEnd(8)} peak ${peak.toFixed(0)}, ${dark} of ${values.length} samples below a quarter of it`)
    }
    report('guest', fromGuest)
    report('window', fromWindow)
    say('')
    say('A trough in `window` while `guest` stays level is a compositing flash, not a dropped frame.')
  } catch (error) {
    say(`FAILED: ${error.stack || error}`)
    win.destroy()
    app.exit(1)
    return
  }
  win.destroy()
  app.exit(0)
})
