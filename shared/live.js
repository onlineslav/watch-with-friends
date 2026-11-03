'use strict'

// Live telemetry, the pure half: how a batch of log lines becomes one WebSocket frame and back, and
// how a line is made safe to print in a terminal. main/live.js (the app's sender),
// relay/live.mjs (the Worker, which only forwards frames) and scripts/diagnostics.js (the reader)
// share it.
//
// A frame is one version byte and then raw deflate of the lines joined by "\n". Version 1 deflates
// against a preset dictionary (shared/live-dictionary.txt: real sample lines), which is what keeps
// a 1-second batch of two or three lines near a third of its size; compressing each batch alone
// would otherwise spend most of its bytes re-spelling the field names. Each frame stands alone, so
// the Worker can hibernate and a reader can join at any moment. A dictionary change needs a new
// version number, because readers must keep decoding what older apps send.

const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const VERSION = 1
// The Worker's cap on a frame. A batch is cut well below it so even incompressible text fits.
const MAX_FRAME_BYTES = 64 * 1024
const MAX_BATCH_BYTES = 48 * 1024
// What a reader will inflate from one frame; a Worker cap on the compressed size does not bound this.
const MAX_INFLATED_BYTES = 1024 * 1024

let dictionary = null
const dictionaryFor = (version) => {
  if (version !== VERSION) return null
  // Without carriage returns: Git may check the file out with CRLF on Windows, and the two ends of a
  // connection must hold the same bytes.
  return (dictionary ??= Buffer.from(fs.readFileSync(path.join(__dirname, 'live-dictionary.txt')).filter((byte) => byte !== 13)))
}

function encodeBatch(lines) {
  const body = zlib.deflateRawSync(Buffer.from(lines.join('\n'), 'utf8'), {dictionary: dictionaryFor(VERSION), level: 9})
  return Buffer.concat([Buffer.from([VERSION]), body])
}

// Throws on anything that is not a frame this build understands; the reader skips that frame.
function decodeBatch(frame) {
  const bytes = Buffer.from(frame)
  const version = bytes[0]
  if (version !== VERSION) throw new Error(`unknown frame version ${version}`)
  const text = zlib.inflateRawSync(bytes.subarray(1), {dictionary: dictionaryFor(version), maxOutputLength: MAX_INFLATED_BYTES}).toString('utf8')
  return text.split('\n').filter(Boolean)
}

// Control characters would let a hostile app socket (they are unauthenticated) drive the reader's
// terminal: C0 (escape sequences), DEL, C1, and the line/paragraph separators and bidirectional
// overrides that make text print out of order.
const CONTROL = new RegExp('[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]', 'g')
const stripControl = (text) => String(text).replace(CONTROL, '')

// Frames from an app arrive from the Worker (relay/live.mjs builds them) as [label length][label][payload].
function unwrapRelayFrame(frame) {
  const bytes = Buffer.from(frame)
  const length = bytes[0]
  if (bytes.length < 2 + length) throw new Error('short frame')
  return {from: bytes.subarray(1, 1 + length).toString('utf8'), payload: bytes.subarray(1 + length)}
}

// Cuts lines into batches of at most `maxBytes` of text each, keeping order. A single line is
// never split (shared/log.js already caps one at 4000 bytes).
function splitBatches(lines, maxBytes = MAX_BATCH_BYTES) {
  const batches = []
  let current = []
  let size = 0
  for (const line of lines) {
    const bytes = Buffer.byteLength(line) + 1
    if (current.length && size + bytes > maxBytes) { batches.push(current); current = []; size = 0 }
    current.push(line)
    size += bytes
  }
  if (current.length) batches.push(current)
  return batches
}

module.exports = {MAX_BATCH_BYTES, MAX_FRAME_BYTES, MAX_INFLATED_BYTES, VERSION, decodeBatch, encodeBatch, splitBatches, stripControl, unwrapRelayFrame}
