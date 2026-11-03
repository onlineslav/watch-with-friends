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
const {registerIpc, watchTransportWarnings} = require('../main/main')
const {createLiveSender} = require('../main/live')
const {decodeBatch} = require('../shared/live')
const {createFakeWebSocket} = require('./fakes')

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
    watchTransportWarnings(win.webContents)
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

    await win.webContents.executeJavaScript('console.warn("Trystero: discovery relay disconnected - 192.168.1.14; retrying")')
    await until(() => entries().some((e) => e.ev === 'transport-warning'), 'a discovery warning')
    const warning = entries().find((e) => e.ev === 'transport-warning')
    assert.equal(warning.lv, 'warn')
    assert.match(warning.message, /discovery relay disconnected - \[ip\]/)

    // ffmpeg failures are recorded by main, on the other side of the same file. Electron prints
    // its own line about this rejection; that line is the check working, not the check failing.
    await win.webContents.executeJavaScript('window.api.startSession({filePath: "C:/nope/missing.mkv"}).catch(() => {})')
    await until(() => entries().some((e) => e.sc === 'ffmpeg'), 'a main-process ffmpeg line')

    // The live stream (M1.1) carries exactly the lines the file holds: a path logged from the page is
    // already redacted when a fake /live receives it.
    const FakeWebSocket = createFakeWebSocket()
    FakeWebSocket.answerPings = true
    const live = createLiveSender({endpoint: async () => 'https://relay.test/telemetry', WebSocketImpl: FakeWebSocket})
    const unsubscribe = log.subscribe(live.push)
    live.configure({enabled: true, from: 'tester#aaaa-bbbb'})
    await until(() => FakeWebSocket.instances.length === 1, 'the live socket')
    FakeWebSocket.instances[0].open()
    FakeWebSocket.instances[0].receive(JSON.stringify({watching: true}))
    await win.webContents.executeJavaScript('window.api.logEvents([{at: Date.now(), mono: 1, level: "info", scope: "live", event: "path", data: {file: "C:\\\\Users\\\\x\\\\film.mkv"}}])')
    await until(() => FakeWebSocket.instances[0].frames.length > 0, 'a live frame')
    const received = FakeWebSocket.instances[0].frames.flatMap((frame) => decodeBatch(frame)).find((text) => text.includes('"ev":"path"'))
    log.flush()
    const filed = fs.readFileSync(log.filePath(), 'utf8').split('\n').find((text) => text.includes('"ev":"path"'))
    assert.ok(received.includes('…/film.mkv') && !received.includes('Users'), 'the live line is redacted: ' + received)
    assert.equal(received, filed, 'and byte-identical to the line in the file')
    unsubscribe()
    live.close()

    const target = path.join(profile, 'export.log')
    log.exportTo(target, {note: 'went blurry about 40 minutes in'})
    const exported = fs.readFileSync(target, 'utf8')
    assert.match(exported, /# note: went blurry about 40 minutes in/)
    assert.match(exported, /"ev":"renderer-ready"/, 'the export carries both processes')
    assert.match(exported, /"ev":"transport-warning"/, 'discovery failures survive an export')
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
