// Real-pixel check for a whole-app share (native/win-app-windows + renderer/app-share-track.mjs),
// which unit tests of the layout math say nothing about. Opens three plain coloured windows for
// a few seconds: a red "app" window, a green window it owns (a plugin window), and a blue window
// from another process covering part of the red one. Then it captures the monitor through the
// real masking track and checks the output shows red and green but no blue, cropped to the app.
// Puts windows on screen (no sound), so run it by hand on Windows:
// `node scripts/electron.js scripts/check-app-share.js` (after `node scripts/build-win-app-audio.js`).
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const {spawn} = require('node:child_process')
const {app, BrowserWindow, desktopCapturer, ipcMain, screen, session} = require('electron')

const root = path.join(__dirname, '..')
const helper = path.join(root, 'native/win-app-windows/win-app-windows.exe')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'check-app-share-'))
const children = []

// A borderless, topmost, solid-colour form; `owned` shows a second one owned by the first.
const formScript = (name, color, x, y, width, height, owned) => `
Add-Type -AssemblyName System.Windows.Forms
function Make($c, $x, $y, $w, $h) {
  $f = New-Object Windows.Forms.Form
  $f.StartPosition = 'Manual'; $f.FormBorderStyle = 'None'; $f.TopMost = $true; $f.ShowInTaskbar = $false
  $f.Location = New-Object Drawing.Point($x, $y); $f.Size = New-Object Drawing.Size($w, $h)
  $f.BackColor = [Drawing.Color]::FromArgb($c[0], $c[1], $c[2]); $f
}
$main = Make @(${color}) ${x} ${y} ${width} ${height}
$main.Text = '${name}'
$main.Add_Shown({
  ${owned ? `$plugin = Make @(${owned.color}) ${owned.x} ${owned.y} ${owned.width} ${owned.height}; $plugin.Show($main)` : ''}
  [Console]::Out.WriteLine($main.Handle.ToInt64()); [Console]::Out.Flush()
})
[Windows.Forms.Application]::Run($main)
`

function openForm(...args) {
  const file = path.join(work, `${args[0]}.ps1`)
  fs.writeFileSync(file, formScript(...args))
  const proc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], {stdio: ['ignore', 'pipe', 'inherit']})
  children.push(proc)
  return new Promise((resolve, reject) => {
    proc.stdout.once('data', (buf) => resolve(Number(buf.toString().trim())))
    proc.once('exit', () => reject(new Error(`${args[0]} form exited early`)))
  })
}

const page = `<!doctype html><script>
const {ipcRenderer} = require('electron')
const {spawn} = require('child_process')
${require('esbuild').buildSync({entryPoints: [path.join(root, 'renderer/app-share-track.mjs')], bundle: true, format: 'iife', globalName: 'Track', write: false}).outputFiles[0].text}
${require('esbuild').buildSync({entryPoints: [path.join(root, 'renderer/app-share.mjs')], bundle: true, format: 'iife', globalName: 'Share', write: false}).outputFiles[0].text}
ipcRenderer.on('run', async (_event, helper, hwnd) => {
  try {
    const proc = spawn(helper, [String(hwnd)])
    let layout = null, text = ''
    const first = new Promise((resolve) => proc.stdout.on('data', (buf) => {
      text += buf.toString()
      const lines = text.split('\\n'); text = lines.pop()
      for (const line of lines) layout = Share.cleanLayout(JSON.parse(line)) || layout
      if (layout) resolve()
    }))
    await first
    await ipcRenderer.invoke('pick', layout.monitor)
    const stream = await navigator.mediaDevices.getDisplayMedia({video: true, audio: false})
    const capture = stream.getVideoTracks()[0]
    const masked = Track.appShareTrack(capture, () => layout)
    const reader = new MediaStreamTrackProcessor({track: masked.track}).readable.getReader()
    let frame
    for (let i = 0; i < 20; i++) { frame?.close(); frame = (await reader.read()).value }
    const canvas = new OffscreenCanvas(frame.displayWidth, frame.displayHeight)
    const context = canvas.getContext('2d')
    context.drawImage(frame, 0, 0)
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
    const counts = {red: 0, green: 0, blue: 0}
    for (let i = 0; i < pixels.length; i += 4) {
      const [r, g, b] = [pixels[i], pixels[i + 1], pixels[i + 2]]
      if (r > 200 && g < 60 && b < 60) counts.red++
      else if (g > 200 && r < 60 && b < 60) counts.green++
      else if (b > 200 && r < 60 && g < 60) counts.blue++
    }
    const result = {counts, size: [frame.displayWidth, frame.displayHeight], capture: [capture.getSettings().width, capture.getSettings().height], layout}
    frame.close(); masked.stop(); proc.kill()
    ipcRenderer.send('result', result)
  } catch (error) {
    ipcRenderer.send('result', {error: String(error?.stack || error)})
  }
})
</script>`

async function main() {
  assert.ok(fs.existsSync(helper), 'build the helper first: node scripts/build-win-app-audio.js')
  await app.whenReady()
  const appWindow = await openForm('app-share-main', '230,20,20', 100, 100, 600, 400, {color: '20,230,20', x: 650, y: 150, width: 300, height: 300})
  await openForm('app-share-other', '20,20,230', 200, 150, 200, 200)
  await new Promise((resolve) => setTimeout(resolve, 500)) // let them paint

  ipcMain.handle('pick', async (_event, {x, y, width, height}) => {
    const display = screen.getDisplayNearestPoint(screen.screenToDipPoint({x: x + width / 2, y: y + height / 2}))
    const sources = await desktopCapturer.getSources({types: ['screen']})
    const source = sources.find((s) => s.display_id === String(display.id)) || sources[0]
    session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => callback({video: source}))
  })
  const win = new BrowserWindow({show: false, webPreferences: {nodeIntegration: true, contextIsolation: false, backgroundThrottling: false}})
  const file = path.join(work, 'page.html')
  fs.writeFileSync(file, page)
  await win.loadFile(file)
  const result = await new Promise((resolve) => {
    ipcMain.once('result', (_event, value) => resolve(value))
    win.webContents.send('run', helper, appWindow)
  })
  if (result.error) throw new Error(result.error)
  console.log(JSON.stringify(result))
  const own = result.layout.windows.filter((w) => w.own)
  assert.equal(own.length, 2, 'the app window and the window it owns count as the app')
  assert.ok(result.layout.windows.some((w) => !w.own), 'the other process\'s window is reported as covering it')
  assert.ok(result.counts.red > 1000, 'the app window shows')
  assert.ok(result.counts.green > 1000, 'the window it owns shows')
  assert.equal(result.counts.blue, 0, 'nothing of the other app\'s window comes through')
  assert.ok(result.size[0] < result.capture[0], 'the output is cropped to the app, not the whole monitor')
  console.log('app share check passed')
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    for (const child of children) child.kill()
    fs.rmSync(work, {recursive: true, force: true})
    app.quit()
  })
