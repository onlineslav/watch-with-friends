// Run with npm run test:live. The whole live telemetry chain against a real local Worker: workerd
// (wrangler dev) with the Durable Object, this app's real renderer and main-process sender, a raw
// reader to time arrivals, and `npm run diagnostics -- --live` as a subprocess. The reader
// authenticates with your own `gh` login; GitHub is called for real, the Worker is never deployed.
//
// Needs `gh auth login` with access to the diagnostics repository, wrangler (npx), and a built
// renderer (npm run bundle). Writes only to a temporary directory. Plays no sound.
const {app, BrowserWindow, ipcMain} = require('electron')
const assert = require('node:assert/strict')
const {execFileSync, spawn} = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {decodeBatch, unwrapRelayFrame} = require('../shared/live')
const log = require('../main/log')
const {registerIpc, watchTransportWarnings} = require('../main/main')
const {createUploader} = require('../main/diagnostics')
const {createLiveSender} = require('../main/live')

const root = path.resolve(__dirname, '..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'wwf-live-check-'))
app.setPath('userData', path.join(temporary, 'profile'))
const PORT = 8798
const BASE = `http://127.0.0.1:${PORT}`
const USER = 'e2e#aaaa-bbbb'
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const forward = (file) => file.replace(/\\/g, '/')

async function until(check, what, timeoutMs = 15000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await check()) return
    await pause(50)
  }
  assert.fail(`Timed out waiting for ${what}`)
}

// wrangler dev, with the real worker behind a wrapper that supplies a plain rate limiter (the local
// simulation of the platform's one fails to start; 100 a minute here, because this check connects more
// often than a person would; the real limit is covered in test/live-relay.test.mjs) and nothing else changed.
function startWorker() {
  const entry = path.join(temporary, 'dev-worker.mjs')
  fs.writeFileSync(entry, `
import worker, {LiveHub} from '${forward(path.join(root, 'relay', 'worker.mjs'))}'
export {LiveHub}
const hits = new Map()
const RATE_LIMITER = {limit: async ({key}) => { const now = Date.now(); const list = (hits.get(key) || []).filter((t) => now - t < 60000); list.push(now); hits.set(key, list); return {success: list.length <= 100} }}
export default {fetch: (request, env, ctx) => worker.fetch(request, {...env, RATE_LIMITER}, ctx)}
`)
  fs.writeFileSync(path.join(temporary, 'wrangler.jsonc'), JSON.stringify({
    name: 'live-check', main: 'dev-worker.mjs', compatibility_date: '2026-09-14',
    vars: {DIAGNOSTICS_REPO: 'onlineslav/watch-with-friends-diagnostics'},
    durable_objects: {bindings: [{name: 'LIVE', class_name: 'LiveHub'}]},
    migrations: [{tag: 'v1', new_sqlite_classes: ['LiveHub']}],
  }))
  const child = spawn(`npx wrangler dev --config "${path.join(temporary, 'wrangler.jsonc')}" --port ${PORT} --local --persist-to "${path.join(temporary, 'state')}"`, {cwd: path.join(root, 'relay'), shell: true, stdio: ['ignore', 'pipe', 'pipe']})
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  return {child, output: () => output, stop() {
    try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {stdio: 'ignore'}) } catch { try { child.kill() } catch {} }
  }}
}

const token = () => execFileSync('gh', ['auth', 'token'], {encoding: 'utf8'}).trim()

// A reader that records when each line arrived.
function rawReader(auth) {
  const reader = {frames: [], texts: [], lines: [], socket: null}
  reader.socket = new WebSocket(`ws://127.0.0.1:${PORT}/live?role=view`, {headers: {Authorization: `Bearer ${auth}`}})
  reader.socket.binaryType = 'arraybuffer'
  reader.socket.addEventListener('message', (event) => {
    const arrivedAt = Date.now()
    if (typeof event.data === 'string') { reader.texts.push({at: arrivedAt, message: JSON.parse(event.data)}); return }
    const {from, payload} = unwrapRelayFrame(Buffer.from(event.data))
    reader.frames.push({at: arrivedAt, from})
    for (const text of decodeBatch(payload)) reader.lines.push({arrivedAt, from, text})
  })
  return reader
}

app.whenReady().then(async () => {
  let failure = null
  const worker = startWorker()
  const children = []
  try {
    log.start({dir: path.join(temporary, 'logs'), info: {version: app.getVersion()}})
    await until(() => /Ready on/.test(worker.output()), `the Worker to start:\n${worker.output()}`, 60000)
    console.log('Worker up (workerd via wrangler dev)')

    // 1. Authorization, against the real GitHub.
    const probe = (headers) => fetch(`${BASE}/live?role=view`, {headers}).then((r) => r.status)
    assert.equal(await probe({}), 401, 'no token: 401')
    assert.equal(await probe({Authorization: 'Bearer gho_notarealtokennotarealtokennotareal00'}), 401, 'a token GitHub rejects: 401')
    const mine = token()
    assert.equal(await probe({Authorization: `Bearer ${mine}`}), 200, 'your own login can watch')
    console.log('PASS: no token and a bad token get 401; your gh login (it can read the diagnostics repository) is let in')

    // 2. An app with the checkbox on, through the real IPC surface.
    const live = createLiveSender({endpoint: async () => `${BASE}/telemetry`, record: log.record})
    const uploader = createUploader({log, settingsFile: path.join(temporary, 'telemetry.json'), endpoint: async () => `${BASE}/telemetry`, send: async () => {}, live})
    registerIpc()
    ipcMain.removeHandler('telemetry:set')
    ipcMain.handle('telemetry:set', (_event, options) => uploader.set(options))
    const win = new BrowserWindow({show: false, webPreferences: {backgroundThrottling: false, preload: path.join(root, 'main/preload.js')}})
    watchTransportWarnings(win.webContents)
    await win.loadFile(path.join(root, 'renderer/index.html'))
    const run = (source) => win.webContents.executeJavaScript(source)

    const reader = rawReader(mine)
    await until(() => reader.socket.readyState === 1, 'the reader to connect')
    await pause(500)
    // "ping" is answered by the runtime itself (setWebSocketAutoResponse), whoever sends it.
    const pinger = new WebSocket(`ws://127.0.0.1:${PORT}/live?role=app&from=pinger`)
    const answers = []
    pinger.addEventListener('message', (event) => answers.push(event.data))
    await until(() => pinger.readyState === 1, 'the ping check to connect')
    pinger.send('ping')
    await until(() => answers.includes('pong'), 'a pong')
    pinger.close()
    console.log('PASS: "ping" is answered "pong" by the auto-response')
    assert.equal(live.status().connected, false, 'checkbox off: no socket')
    await run(`window.api.setTelemetry({enabled: true, from: ${JSON.stringify(USER)}})`)
    await until(() => live.status().connected && live.status().watching === true, 'the app to connect and be told someone is watching')
    assert.ok(reader.texts.some((t) => t.message.join === USER), 'the reader is told who connected')
    console.log('PASS: with the checkbox on, one socket opens and the Worker says a reader is watching')

    // 3. Lines logged in the renderer reach the reader, redacted and identical to the file.
    const sent = []
    for (let i = 0; i < 8; i++) {
      const at = Date.now()
      sent.push(at)
      await run(`window.api.logEvents([{at: ${at}, mono: ${i}, level: 'info', scope: 'e2e', event: 'film', data: {i: ${i}, file: 'C:\\\\Users\\\\x\\\\film.mkv'}}])`)
      await pause(700)
    }
    await until(() => reader.lines.filter((l) => l.text.includes('"sc":"e2e"')).length >= 8, 'all eight lines at the reader')
    const arrived = reader.lines.filter((l) => l.text.includes('"sc":"e2e"'))
    const delays = arrived.map((l) => l.arrivedAt - Date.parse(JSON.parse(l.text).t)).sort((a, b) => a - b)
    console.log(`MEASURE record-to-reader delay for ${delays.length} lines: min ${delays[0]} ms, median ${delays[delays.length >> 1]} ms, max ${delays.at(-1)} ms (main flush 0.5 s + one batch a second + the socket; the renderer adds up to 1 s of its own batching)`)
    assert.ok(delays.at(-1) < 2500, `every line arrived within 2.5 s of being recorded (max ${delays.at(-1)} ms)`)
    assert.ok(arrived.every((l) => l.from === USER && l.text.includes('…/film.mkv') && !l.text.includes('Users')), 'labelled, and redacted in main')
    log.flush()
    const filed = fs.readFileSync(log.filePath(), 'utf8').split('\n')
    for (const l of arrived) assert.ok(filed.includes(l.text), 'byte-identical to the line in the file')
    console.log('PASS: renderer lines reach the reader within 2.5 s, labelled with the username, redacted, identical to the file')

    // 4. `npm run diagnostics -- --live`, as a person would run it.
    const viewer = spawn('node', [path.join(root, 'scripts/diagnostics.js'), '--live', 'e2e', '--no-color', '--url', BASE], {stdio: ['ignore', 'pipe', 'pipe']})
    children.push(viewer)
    let printed = ''
    let said = ''
    viewer.stdout.on('data', (chunk) => { printed += chunk })
    viewer.stderr.on('data', (chunk) => { said += chunk })
    await until(() => /Connected/.test(said), `the viewer to connect: ${said}`)
    const marks = []
    for (let i = 100; i < 104; i++) {
      marks.push(Date.now())
      await run(`window.api.logEvents([{at: Date.now(), mono: ${i}, level: 'info', scope: 'e2e', event: 'film', data: {i: ${i}}}])`)
      await pause(600)
    }
    await pause(4500) // the reader holds lines 3 s to put two people in order
    assert.match(printed, new RegExp(`${USER} +e2e/film \\{"i":103`), `the viewer printed the lines:\n${printed}`)
    const rows = printed.trim().split('\n').filter((row) => row.includes('e2e/film'))
    assert.ok(rows.length >= 4)
    console.log(`MEASURE the reader printed:\n${rows.slice(-4).join('\n')}`)
    assert.ok(!/telemetry\//.test(printed), 'the scope filter hid every other scope')
    console.log('PASS: npm run diagnostics -- --live e2e shows the labelled lines, filtered by scope')
    // A mark (M1.9) goes through the same filter that hid everything but e2e, and is highlighted.
    await run(`window.api.logEvents([{at: Date.now(), mono: 200, level: 'info', scope: 'mark', event: 'note', data: {id: 'e2emark1', src: 'self', by: ${JSON.stringify(USER)}, note: 'audio crackles'}}])`)
    await until(() => />>> MARK by e2e#aaaa-bbbb "audio crackles" <<</.test(printed), `the viewer to highlight the mark:\n${printed}`, 10000)
    console.log('PASS: a mark is highlighted in --live even though the scope filter excludes its scope')
    viewer.kill()

    // 5. Checkbox off: the socket closes at once and the reader is told.
    const offAt = Date.now()
    await run('window.api.setTelemetry({enabled: false})')
    await until(() => !live.status().connected, 'the socket to close', 1000)
    await until(() => reader.texts.some((t) => t.message.leave === USER), 'the reader to hear the app leave', 1500)
    console.log(`PASS: turning the checkbox off closed the socket in ${Date.now() - offAt} ms and the Worker told the reader`)

    // 6. Back on, then the last reader leaves: apps are told to stop, and no frames follow.
    await run(`window.api.setTelemetry({enabled: true})`)
    await until(() => live.status().connected && live.status().watching === true, 'reconnection')
    reader.socket.close()
    await until(() => live.status().watching === false, 'the app to be told nobody is watching', 3000)
    const framesBefore = live.status().frames
    for (let i = 0; i < 5; i++) { log.record('e2e', 'unwatched', {i}); await pause(600) }
    await pause(1500)
    assert.equal(live.status().frames, framesBefore, 'no frames while nobody is watching')
    assert.equal(live.status().held, 0, 'and nothing held')
    console.log('PASS: with the last reader gone the Worker tells the app, and zero frames are sent')

    // 6b. The edge round trip (M1.9): in a room the socket is pinged every 2 s, watched or not, and the
    // Worker's auto-response gives the app its round trip to the edge.
    assert.equal(live.status().watching, false, 'nobody is watching')
    live.setFast(true)
    await until(() => live.edgeRtt() !== null, 'an edge round trip with nobody watching', 6000)
    const first = live.edgeRtt()
    const frames = live.status().frames
    const bytes = live.status().wireBytes
    const readings = []
    for (let i = 0; i < 7; i++) { await pause(1000); readings.push(live.edgeRtt()) }
    const pings = (live.status().wireBytes - bytes) / 10 // each ping is 10 bytes on the wire (see main/live.js)
    assert.ok(first >= 0 && first < 1000, `a sane round trip to a local Worker (${first} ms)`)
    assert.ok(pings >= 3 && pings <= 4, `one ping every 2 seconds (${pings} in 7 s)`)
    assert.ok(readings.every((reading) => reading !== null && reading >= 0 && reading < 1000), `a fresh reading at every look (${readings.join(', ')})`)
    assert.equal(live.status().frames, frames, 'and still no frames: only pings went out')
    console.log(`MEASURE edge RTT to the local Worker with nobody watching, once a second for 7 s: ${readings.join(', ')} ms (${pings} pings)`)
    console.log('PASS: the app measures its round trip to the edge every 2 s without anybody watching')
    live.setFast(false)

    // 7. The Worker restarts (a deploy, a crash): the app finds out and comes back.
    const second = rawReader(mine)
    await until(() => second.socket.readyState === 1, 'a new reader')
    await until(() => live.status().watching === true, 'the app told again')
    worker.stop()
    await until(() => !live.status().connected, 'the app to notice the Worker is gone', 40000)
    console.log('PASS: when the Worker goes away the app drops its socket (and retries with backoff, see test/live.test.js)')
  } catch (error) {
    failure = error
    console.error(error)
    console.error('--- wrangler output ---\n' + worker.output().slice(-3000))
  } finally {
    for (const child of children) try { child.kill() } catch {}
    worker.stop()
    log.stop()
    try { fs.rmSync(temporary, {recursive: true, force: true}) } catch {}
    app.exit(failure ? 1 : 0)
  }
})
