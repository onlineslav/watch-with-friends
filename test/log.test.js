const test = require('node:test')
const assert = require('node:assert/strict')
const {createRing, formatEvent, parseLine, redact, redactPath, shouldRotate, MAX_STRING} = require('../shared/log')

const fields = (entry) => parseLine(formatEvent({at: Date.parse('2026-09-21T14:32:05.123Z'), mono: 1234.6, ...entry}))

test('an event becomes one line of JSON carrying both clocks', () => {
  const line = formatEvent({at: Date.parse('2026-09-21T14:32:05.123Z'), mono: 1234.6, level: 'warn', scope: 'telemetry', event: 'send-quality-change', data: {from: 4e6, to: 3e6}})
  assert.ok(!line.includes('\n'), 'one line, so the file stays newline delimited')
  assert.deepEqual(parseLine(line), {
    t: '2026-09-21T14:32:05.123Z',
    m: 1235,
    lv: 'warn',
    sc: 'telemetry',
    ev: 'send-quality-change',
    from: 4e6,
    to: 3e6,
  })
})

test('unknown levels and missing pieces fall back instead of writing a broken line', () => {
  const entry = fields({level: 'shout', scope: null, event: null, data: 'not an object'})
  assert.equal(entry.lv, 'info')
  assert.equal(entry.sc, 'app')
  assert.equal(entry.ev, 'event')
})

test('absolute paths are reduced to the file name', () => {
  assert.equal(redactPath('C:\\Users\\someone\\Videos\\clip.mkv'), '…/clip.mkv')
  assert.equal(redactPath('/Users/someone/Movies/clip.mkv'), '…/clip.mkv')
  assert.equal(redactPath('/home/someone/clip.mkv'), '…/clip.mkv')
  assert.equal(redactPath('file:///C:/Users/someone/clip.mkv'), '…/clip.mkv')
  assert.equal(
    redactPath('ffmpeg failed reading C:\\Users\\someone\\a.mkv and /home/someone/b.srt'),
    'ffmpeg failed reading …/a.mkv and …/b.srt',
    'every path in a sentence, not just the first',
  )
})

test('relative names and bare text are left alone', () => {
  assert.equal(redactPath('clip.mkv'), 'clip.mkv')
  assert.equal(redactPath('host could not play this media'), 'host could not play this media')
})

test('addresses are removed but clock readings are not', () => {
  assert.equal(redact('candidate 192.168.1.14 port 5000'), 'candidate [ip] port 5000')
  assert.equal(redact('peer 2001:0db8:85a3:0000:0000:8a2e:0370:7334 left'), 'peer [ip] left')
  assert.equal(redact('at 00:01:24 of 01:58:03'), 'at 00:01:24 of 01:58:03', 'timestamps are not IPv6')
  assert.equal(redact('version 44.3.0 on 10.0.26200'), 'version 44.3.0 on 10.0.26200', 'three-part versions survive')
})

test('redaction reaches inside nested values', () => {
  const clean = redact({file: 'C:\\Users\\someone\\clip.mkv', peers: [{name: '/home/someone/x.srt'}]})
  assert.equal(clean.file, '…/clip.mkv')
  assert.equal(clean.peers[0].name, '…/x.srt')
})

test('a long string is capped rather than allowed to fill the file', () => {
  const entry = fields({scope: 's', event: 'e', data: {message: 'x'.repeat(5000)}})
  assert.equal(entry.message.length, MAX_STRING + 1, 'capped, with the ellipsis that says so')
  assert.ok(entry.message.endsWith('…'))
})

test('an event with too many fields keeps its header instead of writing unparseable JSON', () => {
  const data = Object.fromEntries(Array.from({length: 64}, (_, i) => [`k${i}`, 'y'.repeat(200)]))
  const entry = fields({scope: 'wide', event: 'e', data})
  assert.equal(entry.sc, 'wide', 'still says where it came from')
  assert.ok(entry.dropped > 0, 'and says how much was lost')
})

test('non-finite numbers become null so the line stays valid JSON', () => {
  const entry = fields({scope: 's', event: 'e', data: {rtt: Infinity, loss: NaN, ok: 12}})
  assert.equal(entry.rtt, null)
  assert.equal(entry.loss, null)
  assert.equal(entry.ok, 12)
})

test('errors log their message, redacted', () => {
  const entry = fields({scope: 's', event: 'e', data: {error: new Error('cannot open C:\\Users\\someone\\clip.mkv')}})
  assert.equal(entry.error, 'cannot open …/clip.mkv')
})

test('the ring keeps the newest events and counts what it dropped', () => {
  const ring = createRing(3)
  for (const n of [1, 2, 3, 4, 5]) ring.push(n)
  assert.equal(ring.size, 3)
  const {items, dropped} = ring.drain()
  assert.deepEqual(items, [3, 4, 5])
  assert.equal(dropped, 2, 'a gap in the file is reported, not silent')
  assert.deepEqual(ring.drain(), {items: [], dropped: 0}, 'the count resets once reported')
})

test('the file rolls over before a write would pass the cap, never after', () => {
  assert.equal(shouldRotate(0, 900, 1000), false, 'an empty file is never rotated')
  assert.equal(shouldRotate(400, 500, 1000), false)
  assert.equal(shouldRotate(600, 500, 1000), true)
  assert.equal(shouldRotate(10, 5000, 1000), true, 'one oversized write still lands, in a fresh file')
})
