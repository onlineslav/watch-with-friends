const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {parseLine} = require('../shared/log')
const log = require('../main/log')

const workspace = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wwf-log-'))

// The module keeps one file open, so every test starts it somewhere new and stops it after.
function open(info = {version: '0.5.0'}) {
  const dir = workspace()
  log.start({dir, info})
  return dir
}

const lines = (dir) =>
  fs.readFileSync(path.join(dir, 'watch-with-friends.log'), 'utf8').trim().split('\n').map(parseLine)

test.afterEach(() => log.stop())

test('the first line of a new file says what machine wrote it', () => {
  const dir = open({version: '0.5.0', platform: 'win32 10.0.26200'})
  const [launch] = lines(dir)
  assert.equal(launch.ev, 'launch')
  assert.equal(launch.version, '0.5.0')
  assert.equal(launch.platform, 'win32 10.0.26200')
})

test('events from main are stamped here and written in order', () => {
  const dir = open()
  log.record('ffmpeg', 'start', {id: 1, transcoding: true})
  log.record('ffmpeg', 'failed', {id: 1, message: 'boom'}, 'error')
  log.flush()
  const written = lines(dir)
  assert.deepEqual(written.slice(1).map((l) => [l.sc, l.ev, l.lv]), [
    ['ffmpeg', 'start', 'info'],
    ['ffmpeg', 'failed', 'error'],
  ])
  assert.equal(written[1].transcoding, true)
})

test('a renderer batch keeps the times it was stamped with, not the time it arrived', () => {
  const dir = open()
  const at = Date.parse('2026-09-21T14:32:05.123Z')
  log.recordBatch([{at, mono: 500, level: 'info', scope: 'telemetry', event: 'viewer-sample', data: {lossPct: 3.1}}])
  log.flush()
  const entry = lines(dir).at(-1)
  assert.equal(entry.t, '2026-09-21T14:32:05.123Z', 'a batch is up to a second old when it lands')
  assert.equal(entry.lossPct, 3.1)
})

test('a malformed batch is ignored rather than taking the log down with it', () => {
  const dir = open()
  log.recordBatch(null)
  log.recordBatch([null, 'nope', {scope: 'ok', event: 'kept'}])
  log.flush()
  assert.deepEqual(lines(dir).slice(1).map((l) => l.ev), ['kept'])
})

test('paths written by main are redacted on the way to disk', () => {
  const dir = open()
  log.record('media', 'opened', {file: 'C:\\Users\\someone\\Videos\\clip.mkv'})
  log.flush()
  const entry = lines(dir).at(-1)
  assert.equal(entry.file, '…/clip.mkv')
})

test('the file rolls over and keeps exactly one older file', () => {
  const dir = open()
  const big = 'x'.repeat(400)
  // Written a batch at a time, the way the once-a-second flush does it in the app.
  for (let batch = 0; batch < 20; batch++) {
    for (let i = 0; i < 1000; i++) log.record('bulk', 'fill', {i, big})
    log.flush()
  }
  const current = path.join(dir, 'watch-with-friends.log')
  const previous = path.join(dir, 'watch-with-friends.1.log')
  assert.ok(fs.existsSync(previous), 'the older half is kept')
  assert.ok(fs.statSync(current).size <= log.MAX_FILE_BYTES, 'and the current file stays under the cap')
  assert.ok(fs.statSync(previous).size <= log.MAX_FILE_BYTES)
  assert.deepEqual(fs.readdirSync(dir).sort(), ['watch-with-friends.1.log', 'watch-with-friends.log'], 'two files, never a third')
})

test('an export puts the note and the machine at the top, oldest events first', () => {
  const dir = open({version: '0.5.0'})
  log.record('room', 'entered', {room: 'ABCD2345'})
  const target = path.join(workspace(), 'diagnostics.log')
  log.exportTo(target, {note: 'went blurry around 40 minutes in'})
  const text = fs.readFileSync(target, 'utf8')
  assert.match(text, /# note: went blurry around 40 minutes in/)
  assert.match(text, /# version: 0\.5\.0/)
  assert.ok(text.indexOf('"ev":"launch"') < text.indexOf('"ev":"entered"'), 'in the order things happened')
})

test('an export flushes what has not been written yet', () => {
  const dir = open()
  log.record('room', 'leave', {})
  const target = path.join(workspace(), 'diagnostics.log')
  log.exportTo(target, {})
  assert.match(fs.readFileSync(target, 'utf8'), /"ev":"leave"/, 'the last seconds are the interesting ones')
})

test('an event from before the file opened is kept and written once it does', () => {
  log.stop()
  log.record('error', 'main-uncaught', {message: 'died during startup'}, 'error')
  const dir = open()
  const written = lines(dir).map((l) => l.ev)
  assert.ok(written.includes('main-uncaught'), 'a fault during startup is the one worth keeping')
  assert.ok(written.includes('launch'))
})
