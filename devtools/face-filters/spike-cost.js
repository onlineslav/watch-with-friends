// How expensive is capturePage on a guest that is actually playing video, at the sizes the filter
// needs? Detection wants ~384px; the warp's texture wants display resolution or it looks soft.
const {app, BrowserWindow, webContents} = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const say = (line = '') => fs.writeSync(1, `${line}\n`)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svp-cost-'))
app.setPath('userData', path.join(dir, 'profile'))
const CLIP = path.join(__dirname, 'clip.mp4')

fs.copyFileSync(CLIP, path.join(dir, 'clip.mp4'))
// A guest that is genuinely decoding video, so the capture has real work behind it.
fs.writeFileSync(path.join(dir, 'guest.html'), '<!doctype html><body style="margin:0;background:#000"><video src="clip.mp4" autoplay muted loop style="width:100%;height:100%"></video></body>')
fs.writeFileSync(path.join(dir, 'host.html'), `<!doctype html><html><body style="margin:0;background:#000">
<webview id="w" src="file://${path.join(dir, 'guest.html').split(path.sep).join('/')}" style="position:absolute;left:0;top:0;width:1280px;height:720px"></webview>
<script>
  const w = document.getElementById('w')
  w.addEventListener('dom-ready', () => { window.guestId = w.getWebContentsId() })
</script>
</body></html>`)

const time = async (label, times, fn) => {
  const samples = []
  for (let i = 0; i < times; i++) {
    const t0 = performance.now()
    await fn()
    samples.push(performance.now() - t0)
  }
  samples.sort((a, b) => a - b)
  const median = samples[samples.length >> 1]
  say(`  ${label.padEnd(38)} median ${median.toFixed(1)}ms   max ${samples[samples.length - 1].toFixed(1)}ms`)
  return median
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({show: true, width: 1320, height: 780, webPreferences: {webviewTag: true, autoplayPolicy: 'no-user-gesture-required'}})
  try {
    await win.loadFile(path.join(dir, 'host.html'))
    let guestId = null
    for (let i = 0; i < 100 && !guestId; i++) {
      guestId = await win.webContents.executeJavaScript('window.guestId || null')
      if (!guestId) await new Promise((r) => setTimeout(r, 100))
    }
    const guest = webContents.fromId(guestId)
    await new Promise((r) => setTimeout(r, 1500))
    const first = await guest.capturePage()
    say(`guest surface: ${JSON.stringify(first.getSize())}`)
    say('')
    say('cost per capture (a 15Hz budget is 66ms, 30Hz is 33ms):')

    await time('full frame, raw bitmap', 20, async () => {
      const image = await guest.capturePage()
      image.toBitmap()
    })
    await time('full frame, resized to 384 wide', 20, async () => {
      const image = await guest.capturePage()
      image.resize({width: 384}).toBitmap()
    })
    await time('face-sized rect (512x512), raw bitmap', 20, async () => {
      const image = await guest.capturePage({x: 380, y: 100, width: 512, height: 512})
      image.toBitmap()
    })
    await time('full frame, JPEG 70', 20, async () => {
      const image = await guest.capturePage()
      image.toJPEG(70)
    })

    const sizes = await guest.capturePage().then((i) => ({full: i.toBitmap().length, jpeg: i.toJPEG(70).length, small: i.resize({width: 384}).toBitmap().length}))
    say('')
    say(`bytes per frame: full raw ${(sizes.full / 1e6).toFixed(1)}MB   384-wide raw ${(sizes.small / 1e3).toFixed(0)}KB   JPEG70 ${(sizes.jpeg / 1e3).toFixed(0)}KB`)
  } catch (error) {
    say(`FAILED: ${error.stack || error}`)
    app.exit(1)
    return
  }
  app.exit(0)
})
