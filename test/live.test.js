const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')
const log = require('../main/log')
const {createUploader} = require('../main/diagnostics')
const {attemptDelay, backoffMs, createLiveSender, liveUrl, MAX_BUFFER_BYTES} = require('../main/live')
const {decodeBatch, encodeBatch, splitBatches, stripControl, unwrapRelayFrame} = require('../shared/live')
const {formatEvent} = require('../shared/log')
const view = require('../scripts/live-view')
const {createClock, createFakeWebSocket, settle} = require('../scripts/fakes')

const line = (n, extra = {}) => formatEvent({at: 1_800_000_000_000 + n, mono: n, level: 'info', scope: 'telemetry', event: 'viewer-sample', data: {self: 'abc', rttMs: n, ...extra}})

function harness(options = {}) {
  const WebSocketImpl = createFakeWebSocket()
  const clock = createClock()
  const records = []
  const sender = createLiveSender({
    endpoint: async () => 'https://relay.test/telemetry',
    WebSocketImpl, setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now, random: () => 0.5,
    record: (scope, event, data) => records.push({scope, event, data}), ...options,
  })
  // A socket the Worker has accepted, with someone watching.
  const connect = async (watching = true) => {
    await settle()
    const socket = WebSocketImpl.instances.at(-1)
    socket.open()
    socket.receive(JSON.stringify({watching}))
    await settle()
    return socket
  }
  return {WebSocketImpl, clock, sender, records, connect}
}

test.afterEach(() => log.stop())

test('with the checkbox off no socket is ever opened', async () => {
  const h = harness()
  h.sender.configure({enabled: false, from: 'aya#abcd-1234'})
  h.sender.push([line(1)])
  await h.clock.advance(120_000)
  assert.equal(h.WebSocketImpl.instances.length, 0)
  assert.equal(h.sender.status().held, 0, 'and nothing is kept')
})

test('the URL names the person and swaps the scheme and the route', () => {
  assert.equal(liveUrl('https://relay.test/telemetry', 'aya#abcd-1234'), 'wss://relay.test/live?role=app&from=aya%23abcd-1234')
  assert.equal(liveUrl('http://localhost:8787/telemetry', 'a'), 'ws://localhost:8787/live?role=app&from=a')
})

test('apps send only while a reader is connected: zero frames with zero viewers', async () => {
  const h = harness()
  h.sender.configure({enabled: true, from: 'aya#abcd-1234'})
  const socket = await h.connect(false)
  for (let i = 0; i < 20; i++) { h.sender.push([line(i)]); await h.clock.advance(1000) }
  assert.equal(socket.frames.length, 0, 'no frames')
  assert.equal(h.sender.status().held, 0, 'and nothing kept for later')
  // A reader arrives: the Worker says so, and lines from then on flow.
  socket.receive(JSON.stringify({watching: true}))
  h.sender.push([line(100)])
  await h.clock.advance(1000)
  assert.equal(socket.frames.length, 1)
  assert.deepEqual(decodeBatch(socket.frames[0]), [line(100)])
  // And stop again when the last reader leaves.
  socket.receive(JSON.stringify({watching: false}))
  h.sender.push([line(101)])
  await h.clock.advance(5000)
  assert.equal(socket.frames.length, 1)
})

test('batches leave at most once a second, each frame a self-contained deflate of the lines in order', async () => {
  const h = harness()
  h.sender.configure({enabled: true, from: 'aya#abcd-1234'})
  const socket = await h.connect()
  const sentAt = []
  socket.onSend = (data) => { if (typeof data !== 'string') sentAt.push(h.clock.now()) }
  for (let i = 0; i < 30; i++) { h.sender.push([line(i)]); await h.clock.advance(100) }
  await h.clock.advance(2000)
  assert.ok(sentAt.length >= 3 && sentAt.length <= 4, `${sentAt.length} frames for 3 seconds of lines`)
  for (let i = 1; i < sentAt.length; i++) assert.ok(sentAt[i] - sentAt[i - 1] >= 1000, 'never closer than a second')
  const lines = socket.frames.flatMap((frame) => decodeBatch(frame))
  assert.deepEqual(lines, Array.from({length: 30}, (_, i) => line(i)), 'every line, once, in order')
})

test('a batch is much smaller than its text, even a single line', () => {
  const sample = line(1, {room: 'ABCDEFGH', role: 'viewer', host: 'x'.repeat(20), playback: {playing: true, loading: false, buffering: false, time: 12.5, readyState: 4}})
  const frame = encodeBatch([sample])
  assert.ok(frame.length < Buffer.byteLength(sample), `${frame.length} bytes for ${Buffer.byteLength(sample)}`)
  assert.deepEqual(decodeBatch(frame), [sample])
  // A frame from a future version, or one that expands into a bomb, is refused rather than followed.
  assert.throws(() => decodeBatch(Buffer.from([9, 1, 2, 3])), /version/)
  const bomb = Buffer.concat([Buffer.from([1]), zlib.deflateRawSync(Buffer.alloc(8 * 1024 * 1024, 65), {dictionary: Buffer.from(fs.readFileSync(path.join(__dirname, '../shared/live-dictionary.txt')).filter((byte) => byte !== 13))})])
  assert.throws(() => decodeBatch(bomb))
})

test('a backlog is cut into frames that fit, one per second', async () => {
  const h = harness()
  h.sender.configure({enabled: true, from: 'aya#abcd-1234'})
  await settle() // socket still connecting: lines are held
  const big = Array.from({length: 100}, (_, i) => line(i, {pad: 'x'.repeat(1500) + i}))
  h.sender.push(big)
  const socket = await h.connect()
  await h.clock.advance(1000)
  await h.clock.advance(1000)
  await h.clock.advance(1000)
  assert.ok(socket.frames.length >= 2, `${socket.frames.length} frames`)
  assert.ok(socket.frames.every((frame) => frame.length < 64 * 1024))
  assert.deepEqual(socket.frames.flatMap((frame) => decodeBatch(frame)), big)
  assert.equal(splitBatches(big, 10_000).flat().length, 100)
})

test('lines logged before the username is known are held and go out under it once it is', async () => {
  const h = harness()
  h.sender.configure({enabled: true, from: null})
  h.sender.push([line(1), line(2)])
  await h.clock.advance(5000)
  assert.equal(h.WebSocketImpl.instances.length, 0, 'no name, no socket')
  h.sender.configure({enabled: true, from: 'aya#abcd-1234'})
  const socket = await h.connect()
  assert.match(socket.url, /from=aya%23abcd-1234/)
  await h.clock.advance(1000)
  assert.deepEqual(socket.frames.flatMap((frame) => decodeBatch(frame)), [line(1), line(2)])
})

test('unplugging the network: reconnects with backoff, and holds at most a minute and 256 KB', async () => {
  const h = harness()
  h.sender.configure({enabled: true, from: 'aya#abcd-1234'})
  const first = await h.connect()
  await h.clock.advance(11_000) // long enough to count as a stable connection
  first.drop(1006)
  const downAt = h.clock.now()
  // A line every second for five minutes while the socket is down and every attempt fails.
  for (let i = 0; i < 300; i++) {
    h.sender.push([line(i)])
    await h.clock.advance(1000)
    const socket = h.WebSocketImpl.instances.at(-1)
    if (socket.readyState === 0) socket.fail()
  }
  const status = h.sender.status()
  assert.ok(status.held <= 61, `${status.held} lines held, the last minute's`)
  const huge = 'y'.repeat(3000)
  for (let i = 0; i < 400; i++) h.sender.push([line(1000 + i, {huge})])
  assert.ok(h.sender.status().heldBytes <= MAX_BUFFER_BYTES, `${h.sender.status().heldBytes} bytes held`)
  // Back up with someone watching: the marker says lines were lost, then what was kept follows.
  let socket
  for (let i = 0; i < 130; i++) {
    await h.clock.advance(1000)
    socket = h.WebSocketImpl.instances.at(-1)
    if (socket.readyState === 0) break
  }
  assert.equal(socket.readyState, 0, 'it keeps trying')
  socket.open()
  socket.receive(JSON.stringify({watching: true}))
  await h.clock.advance(1000)
  const lines = decodeBatch(socket.frames[0])
  const marker = JSON.parse(lines[0])
  assert.equal(marker.sc, 'live')
  assert.equal(marker.ev, 'dropped')
  assert.ok(marker.n > 0)
  assert.ok(h.clock.now() > downAt)
})

test('reconnect attempts back off from one second to a minute and never exceed four a minute', async () => {
  const h = harness()
  h.sender.configure({enabled: true, from: 'aya#abcd-1234'})
  const starts = []
  let seen = 0
  for (let second = 0; second < 15 * 60; second++) {
    await h.clock.advance(1000)
    while (seen < h.WebSocketImpl.instances.length) { starts.push(h.clock.now()); seen++ }
    const socket = h.WebSocketImpl.instances.at(-1)
    if (socket && socket.readyState === 0) socket.fail() // the Worker is down, or answering 429
  }
  for (const at of starts) {
    const inMinute = starts.filter((other) => other >= at && other < at + 60_000).length
    assert.ok(inMinute <= 4, `${inMinute} attempts in the minute from ${at}`)
  }
  const gaps = starts.slice(1).map((at, i) => at - starts[i])
  assert.ok(gaps[0] <= 2000, `first retry after ${gaps[0]} ms`)
  assert.ok(Math.max(...gaps) <= 61_000, 'never longer than a minute between tries')
  assert.ok(gaps.at(-1) >= 15_000, `late tries are far apart: ${gaps.at(-3)}, ${gaps.at(-2)}, ${gaps.at(-1)}`)
  assert.ok(starts.length <= 60, `${starts.length} attempts in 15 minutes`)
  assert.ok(backoffMs(0, () => 1) === 1000 && backoffMs(30, () => 1) === 60_000)
  assert.equal(attemptDelay([0, 1, 2, 3], 4), 60_000 - 4 + 0)
})

test('a socket that stops answering is found within 30 seconds', async () => {
  const h = harness()
  h.sender.configure({enabled: true, from: 'aya#abcd-1234'})
  const socket = await h.connect()
  await h.clock.advance(15_000)
  assert.deepEqual(socket.texts, ['ping'])
  assert.equal(socket.closedWith, null)
  await h.clock.advance(10_001)
  assert.ok(socket.closedWith, 'declared dead 25 s after the last word')
  await h.clock.advance(2000)
  assert.equal(h.WebSocketImpl.instances.length, 2, 'and replaced')
  assert.ok(h.records.some((r) => r.event === 'heartbeat-lost'))
})

test('a socket that answers its pings stays', async () => {
  const h = harness()
  h.sender.configure({enabled: true, from: 'aya#abcd-1234'})
  const socket = await h.connect()
  socket.onSend = (data) => { if (data === 'ping') queueMicrotask(() => socket.receive('pong')) }
  for (let i = 0; i < 40; i++) await h.clock.advance(15_000)
  assert.equal(socket.closedWith, null)
  assert.equal(h.WebSocketImpl.instances.length, 1)
  assert.ok(socket.texts.length >= 30)
})

test('turning the checkbox off closes the socket at once, and on again opens one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwf-live-'))
  log.start({dir: path.join(dir, 'logs')})
  const h = harness()
  const uploader = createUploader({log, settingsFile: path.join(dir, 't.json'), endpoint: async () => 'https://relay.test/telemetry', send: async () => {}, live: h.sender, firstDelayMs: 1e9, intervalMs: 1e9})
  await uploader.set({from: 'aya#abcd-1234'})
  await settle()
  assert.equal(h.WebSocketImpl.instances.length, 0, 'a name alone opens nothing')
  await uploader.set({enabled: true})
  await settle()
  assert.equal(h.WebSocketImpl.instances.length, 1)
  const socket = await h.connect()
  const before = h.clock.now()
  await uploader.set({enabled: false})
  assert.deepEqual(socket.closedWith, {code: 1000, reason: 'off'})
  assert.ok(h.clock.now() - before < 1000)
  await h.clock.advance(120_000)
  assert.equal(h.WebSocketImpl.instances.length, 1, 'and it stays closed')
  await uploader.set({enabled: true})
  await settle()
  assert.equal(h.WebSocketImpl.instances.length, 2)
  uploader.stop()
})

test('live lines are the redacted lines of the log file, byte for byte', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwf-live-'))
  log.start({dir: path.join(dir, 'logs')})
  const h = harness()
  const uploader = createUploader({log, settingsFile: path.join(dir, 't.json'), endpoint: async () => 'https://relay.test/telemetry', send: async () => {}, live: h.sender, firstDelayMs: 1e9, intervalMs: 1e9})
  await uploader.set({enabled: true, from: 'aya#abcd-1234'})
  const socket = await h.connect()
  log.recordBatch([{at: Date.now(), mono: 5, level: 'info', scope: 'media', event: 'opened', data: {file: 'C:\\Users\\x\\film.mkv', addr: '192.168.1.14'}}])
  log.flush()
  await h.clock.advance(1000)
  const live = socket.frames.flatMap((frame) => decodeBatch(frame)).find((text) => text.includes('"ev":"opened"'))
  const filed = fs.readFileSync(log.filePath(), 'utf8').split('\n').find((text) => text.includes('"ev":"opened"'))
  assert.ok(live.includes('…/film.mkv'))
  assert.ok(!live.includes('Users') && !live.includes('192.168'))
  assert.equal(live, filed)
  uploader.stop()
})

// --- the reader ----------------------------------------------------------------------------------

const frameFrom = (label, lines) => Buffer.concat([Buffer.from([Buffer.byteLength(label)]), Buffer.from(label), encodeBatch(lines)])

test('the reader prints two people\'s lines interleaved by their own clock, labelled, across releases', () => {
  const T = 1_800_000_000_000
  const at = (offset) => formatEvent({at: T + offset, mono: 0, level: 'info', scope: 'telemetry', event: 'viewer-sample', data: {offset}})
  const aya = view.linesFromFrame(frameFrom('aya#abcd-1234', [at(100), at(500), at(900)]))
  const lenna = view.linesFromFrame(frameFrom('lenna#efgh-5678', [at(50), at(450), at(850)]))
  // Aya's batch arrives at once, Lenna's 300 ms later; the printer ticks every 250 ms.
  const hold = view.createHold()
  const printed = []
  for (let now = T; now <= T + 8000; now += 250) {
    if (now === T) for (const item of aya) hold.add(item, now)
    if (now === T + 250) for (const item of lenna) hold.add(item, now)
    for (const item of hold.release(now)) printed.push(`${item.label.split('#')[0]}${item.line.offset}`)
  }
  assert.deepEqual(printed, ['lenna50', 'aya100', 'lenna450', 'aya500', 'lenna850', 'aya900'], 'in order of their own clocks, across ticks')
  assert.equal(hold.size, 0)
  // Nothing is printed before it has had time for the other person's batch to arrive.
  const early = view.createHold()
  for (const item of aya) early.add(item, T)
  assert.deepEqual(early.release(T + 1000), [])
  // A line with a far-off clock does not stall the rest: it goes when its hold is up.
  const skewed = view.createHold()
  skewed.add({at: T + 600_000, label: 'x', line: {}, text: ''}, T)
  assert.equal(skewed.release(T + 2999).length, 0)
  assert.equal(skewed.release(T + 3000).length, 1)
  const text = view.formatLine(aya[0], {color: false})
  assert.match(text, /^\d\d:\d\d:\d\d\.\d{3} aya#abcd-1234 +telemetry\/viewer-sample \{.*"offset":100/)
})

test('the reader filters by scope, scope/event and person', () => {
  const mixed = frameFrom('aya#abcd-1234', [line(1), formatEvent({at: 1_800_000_000_000, mono: 0, level: 'info', scope: 'media', event: 'opened', data: {}})])
  assert.equal(view.linesFromFrame(mixed, {scopes: ['telemetry']}).length, 1)
  assert.equal(view.linesFromFrame(mixed, {scopes: ['media']}).length, 1)
  assert.equal(view.linesFromFrame(mixed, {scopes: ['telemetry/viewer-sample']}).length, 1)
  assert.equal(view.linesFromFrame(mixed, {scopes: ['telemetry/host-sample']}).length, 0)
  assert.equal(view.linesFromFrame(mixed, {scopes: []}).length, 2)
  assert.equal(view.linesFromFrame(mixed, {from: 'len'}).length, 0)
  assert.equal(view.linesFromFrame(mixed, {from: 'aya'}).length, 2)
  assert.deepEqual(view.parseArgs(['--live', 'telemetry', '--from', 'Aya'], {}), {scopes: ['telemetry'], from: 'aya', url: view.DEFAULT_URL, color: null})
  assert.deepEqual(view.parseArgs(['--live', 'telemetry,clock', 'media/opened', '--no-color', '--url', 'http://localhost:8787'], {}).scopes, ['telemetry', 'clock', 'media/opened'])
  assert.equal(view.parseArgs(['aya'], {}), null)
  assert.throws(() => view.parseArgs(['--live', '--bogus'], {}), /Unknown option/)
})

test('control characters from a hostile app never reach the terminal', () => {
  const hostile = frameFrom('evil\u001b[2J#1', [
    '{"t":"2026-11-03T00:00:00.000Z","sc":"x\u001b]0;pwned\u0007","ev":"e\u009b31m","msg":"line\u0085two \u202edesrever"}',
    'plain \u001b[31mred\u001b[0m text\u0000',
  ])
  const items = view.linesFromFrame(hostile)
  assert.equal(items.length, 2)
  const printed = items.map((item) => view.formatLine(item, {color: false})).join('\n')
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e]/.test(printed), JSON.stringify(printed))
  assert.match(printed, /pwned/, 'the text survives, the control characters do not')
  assert.equal(stripControl('a\u001b[0mb'), 'a[0mb')
})

test('escapes inside JSON values, and the level, cannot smuggle control characters either', () => {
  const json = '{"t":"2026-11-03T00:00:00.000Z","lv":"\\u001b]0;pwn\\u0007","sc":"s\\u009b","ev":"e","a":"\\u001b[2J","b":"\\u009b2J\\u202eevil","c":["\\u0085x"]}'
  const items = view.linesFromFrame(frameFrom('lbl‮', [json]))
  assert.equal(items.length, 1)
  assert.equal(items[0].line.lv, '\u001b]0;pwn\u0007', 'the escapes did decode into real characters')
  for (const color of [false, true]) {
    const printed = view.formatLine(items[0], {color, colorOf: () => 36})
    const bare = printed.replace(/\u001b\[(?:36|0)m/g, '')
    assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029‪-‮⁦-⁩]/.test(bare), JSON.stringify(bare))
    assert.match(bare, /pwn/i)
  }
})

test('garbage frames are skipped, not fatal', () => {
  assert.deepEqual(view.linesFromFrame(Buffer.from([5, 1, 2])), [])
  assert.deepEqual(view.linesFromFrame(Buffer.from([0, 9, 9, 9])), [])
  assert.deepEqual(view.linesFromFrame(Buffer.alloc(0)), [])
  assert.throws(() => unwrapRelayFrame(Buffer.from([200, 1])), /short/)
})
