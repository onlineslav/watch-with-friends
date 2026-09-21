// Run with npm run test:logging. Proves the two halves meet: the renderer's batches reach the
// main process over the real IPC surface, land in the real file, and come back out of an export
// with paths stripped. A disposable profile keeps it away from the installed app's own log.
const {app, BrowserWindow} = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {parseLine} = require('../shared/log')
const log = require('../main/log')
const {registerIpc} = require('../main/main')

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wwf-logging-test-'))
app.setPath('userData', profile)
const root = path.resolve(__dirname, '..')
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const entries = () =>
  fs.readFileSync(log.filePath(), 'utf8').trim().split('\n').map(parseLine).filter(Boolean)

async function until(check, what, timeoutMs = 8000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (check()) return
    await pause(50)
  }
  assert.fail(`Timed out waiting for ${what}`)
}

app.whenReady().then(async () => {
  let failure = null
  try {
    log.start({dir: app.getPath('logs'), info: {version: app.getVersion(), platform: process.platform}})
    registerIpc()

    const win = new BrowserWindow({
      show: false,
      webPreferences: {backgroundThrottling: false, preload: path.join(root, 'main/preload.js')},
    })
    await win.loadFile(path.join(root, 'renderer/index.html'))

    // The renderer logs one line per launch, which is what proves the IPC path works at all.
    await until(() => entries().some((e) => e.ev === 'renderer-ready'), 'the renderer ready line')
    const ready = entries().find((e) => e.ev === 'renderer-ready')
    assert.match(ready.screen, /^\d+x\d+$/, 'the ready line carries the screen size')
    assert.ok(ready.self, 'and the transport id, so two logs can be told apart')

    // An uncaught error in the renderer must reach the file rather than an unopened console.
    win.webContents.executeJavaScript('setTimeout(() => { throw new Error("boom from C:\\\\Users\\\\someone\\\\clip.mkv") }, 0)')
    await until(() => entries().some((e) => e.ev === 'uncaught'), 'the renderer error')
    const uncaught = entries().find((e) => e.ev === 'uncaught')
    assert.equal(uncaught.lv, 'error')
    assert.match(uncaught.message, /boom from …\/clip\.mkv/, 'redacted on the way through')

    // ffmpeg failures are recorded by main, on the other side of the same file. Electron prints
    // its own line about this rejection; that line is the check working, not the check failing.
    await win.webContents.executeJavaScript('window.api.startSession({filePath: "C:/nope/missing.mkv"}).catch(() => {})')
    await until(() => entries().some((e) => e.sc === 'ffmpeg'), 'a main-process ffmpeg line')

    const target = path.join(profile, 'export.log')
    log.exportTo(target, {note: 'went blurry about 40 minutes in'})
    const exported = fs.readFileSync(target, 'utf8')
    assert.match(exported, /# note: went blurry about 40 minutes in/)
    assert.match(exported, /"ev":"renderer-ready"/, 'the export carries both processes')
    assert.match(exported, /"ev":"start-failed"|"sc":"ffmpeg"/)
    assert.ok(!/[A-Za-z]:\\Users\\/.test(exported), 'no Windows user paths survive an export')
    assert.ok(!/\/(?:home|Users)\//.test(exported), 'and no POSIX home paths either')

    const lines = entries()
    assert.ok(lines.every((e) => e.t && e.sc && e.ev), 'every line is parseable and stamped')
    console.log(`logging ok - ${lines.length} events, export ${Math.round(exported.length / 1024)} KB`)
    // --show prints the file, for reading what an event actually looks like.
    if (process.argv.includes('--show')) console.log('\n' + exported)
  } catch (error) {
    failure = error
    console.error(error)
  } finally {
    log.stop()
    // Chromium still holds files under the profile for a moment after the window goes; a leftover
    // temp directory is not worth failing a passing check over.
    try { fs.rmSync(profile, {recursive: true, force: true}) } catch {}
    app.exit(failure ? 1 : 0)
  }
})
