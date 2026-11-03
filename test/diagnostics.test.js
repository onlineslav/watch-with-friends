const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')
const log = require('../main/log')
const {buildRequest, createUploader, loadEndpoint} = require('../main/diagnostics')
const {validatePublicConfig} = require('../main/turn')

const workspace = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wwf-telemetry-'))
test.afterEach(() => log.stop())

// What the Worker would store, read back the way scripts/diagnostics.js reads it.
const unpack = (request) => {
  const [meta, body] = [request.slice(0, request.indexOf('\n')), request.slice(request.indexOf('\n') + 1)]
  return {meta: JSON.parse(meta), text: zlib.gunzipSync(Buffer.from(body, 'base64')).toString('utf8')}
}
const events = (text) => text.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line).ev)

test('each upload carries only what was written since the last one that succeeded', () => {
  log.start({dir: workspace(), info: {version: '1.0.0'}})
  log.record('t', 'one')
  const first = log.takeUnsent()
  assert.deepEqual(events(first.text), ['launch', 'one'], 'turned on: what is already recorded goes too')
  first.commit()
  assert.equal(log.takeUnsent(), null, 'nothing new, nothing to send')
  log.record('t', 'two')
  const failed = log.takeUnsent()
  assert.deepEqual(events(failed.text), ['two'])
  // Not committed (the upload failed), so the next take sends it again along with what followed.
  log.record('t', 'three')
  assert.deepEqual(events(log.takeUnsent().text), ['two', 'three'])
})

test('the cursor survives a relaunch, so a crash or quit loses nothing and repeats nothing', () => {
  const dir = workspace()
  log.start({dir})
  log.record('t', 'before')
  log.takeUnsent().commit()
  log.record('t', 'unsent')
  log.stop()
  log.start({dir})
  assert.deepEqual(events(log.takeUnsent().text), ['unsent', 'launch'])
})

test('a rollover between uploads sends the rest of the older file, then the new one', () => {
  log.start({dir: workspace()})
  log.record('t', 'marker')
  log.takeUnsent().commit()
  const big = 'x'.repeat(400)
  let rolled = false
  for (let batch = 0; batch < 20 && !rolled; batch++) {
    for (let i = 0; i < 1000; i++) log.record('bulk', 'fill', {i, big})
    log.flush()
    rolled = fs.existsSync(log.filePath().replace('.log', '.1.log'))
  }
  log.record('t', 'after')
  const chunk = log.takeUnsent({maxBytes: 64 * 1024 * 1024})
  const sent = events(chunk.text)
  assert.ok(!sent.includes('marker'), 'what was sent before the rollover is not sent again')
  assert.ok(rolled, 'the file did roll over')
  assert.equal(sent[0], 'fill', 'starting right after the marker, in the older file')
  assert.equal(sent.at(-1), 'after')
  chunk.commit()
  assert.equal(log.takeUnsent(), null)
})

test('an upload in flight while the file rolls over commits against the right file', () => {
  log.start({dir: workspace()})
  log.record('t', 'in-flight')
  const chunk = log.takeUnsent()
  const big = 'x'.repeat(400)
  for (let batch = 0; batch < 15; batch++) {
    for (let i = 0; i < 1000; i++) log.record('bulk', 'fill', {i, big})
    log.flush()
  }
  chunk.commit()
  const next = events(log.takeUnsent({maxBytes: 64 * 1024 * 1024}).text)
  assert.ok(!next.includes('in-flight'), 'the uploaded part of the now-older file is not resent')
  assert.ok(next.includes('fill'))
})

test('a backlog bigger than the cap keeps its newest whole lines', () => {
  log.start({dir: workspace()})
  for (let i = 0; i < 200; i++) log.record('t', 'line', {i})
  const {text} = log.takeUnsent({maxBytes: 2000})
  assert.ok(Buffer.byteLength(text) <= 2000)
  const parsed = text.trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(parsed.at(-1).i, 199)
})

test('uploads are off until turned on, and filed under the username', async () => {
  const dir = workspace()
  log.start({dir: path.join(dir, 'logs'), info: {version: '1.2.3', platform: 'win32 10'}})
  const sent = []
  const settingsFile = path.join(dir, 'telemetry.json')
  const make = () => createUploader({log, settingsFile, endpoint: async () => 'https://relay.test/telemetry', send: async (url, request) => sent.push({url, ...unpack(request)}), firstDelayMs: 1e9, intervalMs: 1e9})
  const uploader = make()
  assert.equal(await uploader.upload(), false)
  assert.equal(sent.length, 0, 'nothing leaves the machine while it is off')
  assert.deepEqual(await uploader.status(), {enabled: false, available: true, lastSentAt: null, lastError: null})
  assert.equal(uploader.enabled, false, 'read at once by main, which runs the network probe only while it is on')

  await uploader.set({enabled: true, from: 'aya#abcd-1234'})
  assert.equal(uploader.enabled, true)
  assert.equal(await uploader.upload(), true)
  uploader.stop()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].meta.from, 'aya#abcd-1234')
  assert.equal(sent[0].meta.version, '1.2.3')
  assert.match(sent[0].text, /^# upload \{/, 'each chunk says which build wrote it')
  assert.ok(events(sent[0].text).includes('telemetry'), 'turning it on is itself in the log')

  // The setting is main's, so a relaunch uploads before any window has said anything.
  const again = make()
  assert.equal((await again.status()).enabled, true)
  await again.set({enabled: false})
  assert.equal(await again.upload(), false)
  again.stop()
})

test('a failed upload is reported and its lines are kept for the next try', async () => {
  const dir = workspace()
  log.start({dir: path.join(dir, 'logs')})
  let fail = true
  const sent = []
  const uploader = createUploader({log, settingsFile: path.join(dir, 't.json'), endpoint: async () => 'https://relay.test/telemetry', firstDelayMs: 1e9, intervalMs: 1e9,
    send: async (_url, request) => { if (fail) throw new Error('HTTP 502'); sent.push(unpack(request)) }})
  await uploader.set({enabled: true})
  log.record('t', 'kept')
  assert.equal(await uploader.upload(), false)
  assert.equal((await uploader.status()).lastError, 'HTTP 502')
  fail = false
  assert.equal(await uploader.upload(), true)
  uploader.stop()
  assert.ok(events(sent[0].text).includes('kept'))
  assert.equal((await uploader.status()).lastError, null)
})

test('a build without a telemetry address has nowhere to send', async () => {
  const read = (text) => ({readFile: async () => text})
  assert.equal(await loadEndpoint('x', {readFile: async () => { throw Object.assign(new Error('no'), {code: 'ENOENT'}) }}), null)
  assert.equal(await loadEndpoint('x', read('{"endpoint":"https://relay.test/credentials"}')), null)
  assert.equal(await loadEndpoint('x', read('{"telemetry":"http://relay.test/telemetry"}')), null)
  assert.equal(await loadEndpoint('x', read('{"telemetry":"https://u:p@relay.test/telemetry"}')), null)
  assert.equal(await loadEndpoint('x', read('{"telemetry":"https://relay.test/telemetry"}')), 'https://relay.test/telemetry')
  // and the packaging check lets the address through but nothing secret beside it
  assert.doesNotThrow(() => validatePublicConfig({endpoint: 'https://relay.test/credentials', telemetry: 'https://relay.test/telemetry'}))
  assert.throws(() => validatePublicConfig({telemetry: 'https://relay.test/telemetry', token: 'secret'}), /Do not package/)
  assert.throws(() => validatePublicConfig({telemetry: 'http://relay.test/telemetry'}), /telemetry endpoint must use HTTPS/)
})

test('the request is one line of metadata, then the base64 gzip', () => {
  const request = buildRequest({meta: {from: 'a#b'}, text: '{"ev":"x"}\n'})
  const {meta, text} = unpack(request)
  assert.deepEqual(meta, {from: 'a#b'})
  assert.equal(text, '# upload {"from":"a#b"}\n{"ev":"x"}\n')
})
