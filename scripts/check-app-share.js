// Real-pixel check for a whole-app share (native/win-app-windows + renderer/app-share-track.mjs),
// which unit tests of the layout math say nothing about. Opens three plain coloured windows for
// a few seconds: a red "app" window, a green tool window it owns (like a plugin window, which
// desktopCapturer doesn't list), and a blue window from another process on top of both. Then it
// runs the real composite and checks the output shows all of the red and green windows, covered
// parts included, and none of the blue one, cropped to the app; and that a plugin window opened
// mid-share and one closed mid-share appear and disappear.
// Puts windows on screen (no sound), so run it by hand on Windows:
// `node scripts/electron.js scripts/check-app-share.js` (after `node scripts/build-win-app-audio.js`).
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const {spawn} = require('node:child_process')
const {app, BrowserWindow, ipcMain, session} = require('electron')

const root = path.join(__dirname, '..')
// WIN_APP_WINDOWS points at another build, for checking one while the app holds the usual file.
const helper = process.env.WIN_APP_WINDOWS || path.join(root, 'native/win-app-windows/win-app-windows.exe')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'check-app-share-'))
const children = []

const form = (color, x, y, width, height, style = 'None') => `& {
  $f = New-Object Windows.Forms.Form
  $f.StartPosition = 'Manual'; $f.FormBorderStyle = '${style}'; $f.TopMost = $true; $f.ShowInTaskbar = $false
  $f.Location = New-Object Drawing.Point(${x}, ${y}); $f.Size = New-Object Drawing.Size(${width}, ${height})
  $f.BackColor = [Drawing.Color]::FromArgb(${color}); $f
}`

// The "app": a red main window and a green owned tool window; an `open` file in the work folder
// shows a second (yellow) tool window, `close` closes the green one. Prints the main window's handle.
const appScript = `
Add-Type -AssemblyName System.Windows.Forms
$main = ${form('230,20,20', 100, 100, 600, 400)}
$main.Add_Shown({
  $script:plugin = ${form('20,230,20', 650, 150, 300, 300, 'SizableToolWindow')}
  $script:plugin.Show($main)
  [Console]::Out.WriteLine($main.Handle.ToInt64()); [Console]::Out.Flush()
  $timer = New-Object Windows.Forms.Timer; $timer.Interval = 100
  $timer.Add_Tick({
    if (Test-Path '${path.join(work, 'open')}') { Remove-Item '${path.join(work, 'open')}'; $script:extra = ${form('230,230,20', 150, 450, 250, 150, 'SizableToolWindow')}; $script:extra.Show($main) }
    if (Test-Path '${path.join(work, 'close')}') { Remove-Item '${path.join(work, 'close')}'; $script:plugin.Close() }
    if (Test-Path '${path.join(work, 'out')}') { Remove-Item '${path.join(work, 'out')}'; $script:plugin.Left = 1100 }
    if (Test-Path '${path.join(work, 'in')}') { Remove-Item '${path.join(work, 'in')}'; $script:plugin.Left = 300 }
    if (Test-Path '${path.join(work, 'minimize')}') { Remove-Item '${path.join(work, 'minimize')}'; $main.WindowState = 'Minimized' }
    if (Test-Path '${path.join(work, 'restore')}') { Remove-Item '${path.join(work, 'restore')}'; $main.WindowState = 'Normal' }
  })
  $timer.Start()
})
[Windows.Forms.Application]::Run($main)
`
const otherScript = `
Add-Type -AssemblyName System.Windows.Forms
$o = ${form('20,20,230', 300, 50, 700, 300)}
$o.Add_Shown({ [Console]::Out.WriteLine('shown'); [Console]::Out.Flush() })
[Windows.Forms.Application]::Run($o)
`

function run(name, script) {
  const file = path.join(work, `${name}.ps1`)
  fs.writeFileSync(file, script)
  const proc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], {stdio: ['ignore', 'pipe', 'inherit']})
  children.push(proc)
  const first = new Promise((resolve, reject) => {
    proc.stdout.once('data', (buf) => resolve(buf.toString().trim()))
    proc.once('exit', () => reject(new Error(`${name} exited early`)))
  })
  return {proc, first}
}

const bundle = (file, globalName) =>
  require('esbuild').buildSync({entryPoints: [path.join(root, file)], bundle: true, format: 'iife', globalName, write: false}).outputFiles[0].text

// The renderer half: follows the helper, captures windows through the grant IPC below, and
// reports pixel counts of the composite's output on request.
const page = `<!doctype html><script>
const {ipcRenderer} = require('electron')
const {spawn} = require('child_process')
${bundle('renderer/app-share-track.mjs', 'Track')}
${bundle('renderer/app-share.mjs', 'Share')}
let reader, layout
ipcRenderer.on('start', async (_event, helper, hwnd) => {
  try {
    const proc = spawn(helper, [String(hwnd)])
    let text = ''
    await new Promise((resolve) => proc.stdout.on('data', (buf) => {
      text += buf.toString()
      const lines = text.split('\\n'); text = lines.pop()
      for (const line of lines) {
        layout = Share.cleanLayout(JSON.parse(line)) || layout
        ipcRenderer.send('layout', JSON.parse(line))
      }
      if (layout) resolve()
    }))
    const capture = async (target) => {
      await ipcRenderer.invoke('grant', target)
      return (await navigator.mediaDevices.getDisplayMedia({video: true, audio: false})).getVideoTracks()[0]
    }
    const composite = Track.appShareTrack({
      getLayout: () => layout,
      subscribe: (fn) => {
        proc.stdout.on('data', () => fn(layout))
        return () => {}
      },
      captureWindow: capture,
      anchor: hwnd,
      initial: layout.windows.some((win) => win.hwnd === hwnd) ? {hwnd, track: await capture(hwnd)} : null,
      limits: {frameRate: 30},
      onCaptureError: (target, error) => ipcRenderer.send('capture-error', target, String(error)),
    })
    reader = new MediaStreamTrackProcessor({track: composite.track}).readable.getReader()
    ipcRenderer.send('started')
  } catch (error) {
    ipcRenderer.send('started', String(error?.stack || error))
  }
})
ipcRenderer.on('sample', async () => {
  // The newest frame: read for a moment, keep the last.
  let frame = (await reader.read()).value
  const until = performance.now() + 700
  while (performance.now() < until) {
    const next = await Promise.race([reader.read(), new Promise((resolve) => setTimeout(() => resolve(null), until - performance.now()))])
    if (!next) break
    frame.close(); frame = next.value
  }
  const canvas = new OffscreenCanvas(frame.displayWidth, frame.displayHeight)
  const context = canvas.getContext('2d')
  context.drawImage(frame, 0, 0)
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
  const counts = {red: 0, green: 0, blue: 0, yellow: 0, card: 0}
  for (let i = 0; i < pixels.length; i += 4) {
    const [r, g, b] = [pixels[i], pixels[i + 1], pixels[i + 2]]
    if (r >= 18 && r <= 26 && g >= 18 && g <= 26 && b >= 24 && b <= 32) counts.card++
    else if (r > 200 && g > 200 && b < 60) counts.yellow++
    else if (r > 200 && g < 60 && b < 60) counts.red++
    else if (g > 200 && r < 60 && b < 60) counts.green++
    else if (b > 200 && r < 60 && g < 60) counts.blue++
  }
  ipcRenderer.send('sampled', {counts, size: [frame.displayWidth, frame.displayHeight]})
  frame.close()
})
</script>`

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  assert.ok(fs.existsSync(helper), 'build the helper first: node scripts/build-win-app-audio.js')
  const {SHRINK_AFTER_MS} = await import(require('node:url').pathToFileURL(path.join(root, 'renderer/app-share.mjs')))
  await app.whenReady()
  const appForms = run('app', appScript)
  const appWindow = Number(await appForms.first)
  await run('other', otherScript).first
  await wait(800) // let them paint

  // Main's rule, the same as appwindows:grant: only a window the helper reports.
  let reported = new Set()
  ipcMain.on('layout', (_event, line) => (reported = new Set(line.windows.map((entry) => entry[4]))))
  const errors = []
  ipcMain.on('capture-error', (_event, hwnd, message) => errors.push({hwnd, message}))
  let pending = null
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    const source = pending
    pending = null
    callback(source ? {video: source} : {})
  })
  ipcMain.handle('grant', (_event, hwnd) => {
    assert.ok(reported.has(hwnd), `grant asked for a window the helper didn't report: ${hwnd}`)
    pending = {id: `window:${hwnd}:0`, name: ''}
  })

  const win = new BrowserWindow({show: false, webPreferences: {nodeIntegration: true, contextIsolation: false, backgroundThrottling: false}})
  win.webContents.on('console-message', ({message}) => console.log('page:', message))
  const file = path.join(work, 'page.html')
  fs.writeFileSync(file, page)
  fs.writeFileSync(path.join(work, 'app-share-worker.js'), bundle('renderer/app-share-worker.mjs'))
  await win.loadFile(file)
  const once = (channel) => new Promise((resolve) => ipcMain.once(channel, (_event, value) => resolve(value)))
  const started = once('started')
  win.webContents.send('start', helper, appWindow)
  const startError = await started
  if (startError) throw new Error(startError)
  const sample = async () => {
    await wait(1200) // time for the layout and any new capture to land
    const result = once('sampled')
    win.webContents.send('sample')
    return result
  }

  const first = await sample()
  console.log('start:', JSON.stringify(first), 'windows reported:', reported.size)
  assert.equal(reported.size, 2, 'the app window and the window it owns count as the app')
  // Red 600×400 minus where the green window overlaps it (650–700 × 150–450, at most 50×300).
  assert.ok(first.counts.red > 600 * 400 - 50 * 300 - 4000, `the red window shows in full, covered part included (${first.counts.red})`)
  assert.ok(first.counts.green > 270 * 260, `the green tool window shows in full, covered part included (${first.counts.green})`)
  assert.equal(first.counts.blue, 0, 'nothing of the other app\'s window comes through')
  assert.ok(first.size[0] < 1200 && first.size[1] < 700, `cropped to the app (${first.size})`)

  // Dragged out past the app's edge, the crop grows; dragged back in, it shrinks again.
  fs.writeFileSync(path.join(work, 'out'), '')
  const out = await sample()
  console.log('plugin dragged out:', JSON.stringify(out))
  assert.ok(out.size[0] > first.size[0] + 200, `the crop grows to follow it (${out.size})`)
  fs.writeFileSync(path.join(work, 'in'), '')
  await wait(SHRINK_AFTER_MS)
  const back = await sample()
  console.log('plugin dragged back in:', JSON.stringify(back))
  assert.deepEqual(back.size, [600, 400], 'and shrinks back to exactly the app window once it is inside again')
  assert.equal(back.counts.blue, 0)

  fs.writeFileSync(path.join(work, 'open'), '')
  const opened = await sample()
  console.log('after opening a window:', JSON.stringify(opened))
  assert.ok(opened.counts.yellow > 200 * 100, `a window opened mid-share appears (${opened.counts.yellow})`)
  assert.ok(opened.size[1] > first.size[1], 'the crop grows to take it in')

  fs.writeFileSync(path.join(work, 'close'), '')
  const closed = await sample()
  console.log('after closing a window:', JSON.stringify(closed), 'windows reported:', reported.size)
  assert.equal(closed.counts.green, 0, 'a closed window disappears')
  assert.equal(closed.counts.blue, 0)

  // Minimized: Windows can't capture it, so viewers get a card saying so; restored, the picture.
  fs.writeFileSync(path.join(work, 'minimize'), '')
  const minimized = await sample()
  console.log('app minimized:', JSON.stringify(minimized))
  assert.equal(minimized.counts.red, 0, 'nothing of the minimized window')
  assert.ok(minimized.counts.card > (minimized.size[0] * minimized.size[1]) / 2, 'the card instead')
  fs.writeFileSync(path.join(work, 'restore'), '')
  const restored = await sample()
  console.log('app restored:', JSON.stringify(restored))
  assert.ok(restored.counts.red > 100_000, 'the picture comes back once it is restored')
  assert.deepEqual(errors, [], 'every window could be captured')
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
