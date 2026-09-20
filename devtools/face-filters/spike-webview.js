// Decisive question for the YouTube path: does capturePage() on a <webview> guest return the
// guest's own pixels, excluding whatever the embedder painted on top of it?
//
// If yes, the filter can read clean unwarped frames and the whole feedback loop disappears.
// If no, there is no capture route that excludes our own canvas and the approach is dead.
//
// Guest page is solid green. The embedder covers it completely with solid red. Capture the guest
// and look at the middle pixel: green means the overlay is excluded, red means it is not.
const {app, BrowserWindow, ipcMain, webContents} = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const say = (line = '') => fs.writeSync(1, `${line}\n`)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svp-spike-'))
app.setPath('userData', path.join(dir, 'profile'))

fs.writeFileSync(path.join(dir, 'guest.html'), '<!doctype html><body style="margin:0;background:#00c800"></body>')
fs.writeFileSync(path.join(dir, 'host.html'), `<!doctype html><html><body style="margin:0;background:#000">
<webview id="w" src="file://${path.join(dir, 'guest.html').split(path.sep).join('/')}" style="position:absolute;left:0;top:0;width:400px;height:300px"></webview>
<div id="cover" style="position:absolute;left:0;top:0;width:400px;height:300px;background:#ff0000"></div>
<script>
  const w = document.getElementById('w')
  w.addEventListener('dom-ready', () => { window.guestId = w.getWebContentsId() })
</script>
</body></html>`)

app.whenReady().then(async () => {
  const win = new BrowserWindow({show: true, width: 600, height: 500, webPreferences: {webviewTag: true}})
  try {
    await win.loadFile(path.join(dir, 'host.html'))
    let guestId = null
    for (let i = 0; i < 100 && !guestId; i++) {
      guestId = await win.webContents.executeJavaScript('window.guestId || null')
      if (!guestId) await new Promise((r) => setTimeout(r, 100))
    }
    if (!guestId) throw new Error('the webview never reported a WebContents id')
    say(`guest WebContents id: ${guestId}`)

    const guest = webContents.fromId(guestId)
    if (!guest) throw new Error('no WebContents for that id')
    // Let the compositor settle so the cover is definitely painted over the guest.
    await new Promise((r) => setTimeout(r, 800))

    const image = await guest.capturePage()
    const size = image.getSize()
    const bitmap = image.toBitmap() // BGRA
    const px = (x, y) => {
      const at = (y * size.width + x) * 4
      return {b: bitmap[at], g: bitmap[at + 1], r: bitmap[at + 2]}
    }
    const middle = px(size.width >> 1, size.height >> 1)
    say(`captured ${size.width}x${size.height}, centre pixel r=${middle.r} g=${middle.g} b=${middle.b}`)
    if (middle.g > 150 && middle.r < 100) say('\nRESULT: the guest capture EXCLUDES the embedder overlay. The approach works.')
    else if (middle.r > 150 && middle.g < 100) say('\nRESULT: the guest capture INCLUDES the embedder overlay. The approach is dead.')
    else say('\nRESULT: inconclusive — neither pure green nor pure red.')

    // Also check it keeps working while the window is covered, since the old route needed the
    // window visible and that was a recurring source of failures.
    win.minimize()
    await new Promise((r) => setTimeout(r, 600))
    const hidden = await guest.capturePage().then((i) => i.getSize()).catch((e) => ({error: String(e)}))
    say(`while minimized: ${JSON.stringify(hidden)}`)
  } catch (error) {
    say(`FAILED: ${error.stack || error}`)
    app.exit(1)
    return
  }
  app.exit(0)
})
