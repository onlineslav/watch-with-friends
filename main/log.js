'use strict'

// The diagnostic log file. Both processes write here: main directly, the renderer in batches over
// IPC. shared/log.js decides what a line looks like and what is stripped from it; this decides
// where it lands and when the file rolls over.
//
// Two files of 5 MB. The telemetry sample is ~250 bytes every 2 seconds, so one file holds roughly
// five hours and the pair covers a whole movie night at both ends. Rotation is by size and not by
// time: a fault twenty minutes into a long film should not push the start of the session out of
// the file, and a crash should leave the evidence behind rather than a fresh empty log.

const fs = require('node:fs')
const path = require('node:path')
const {createRing, formatEvent, shouldRotate} = require('../shared/log')

const MAX_FILE_BYTES = 5 * 1024 * 1024
// Half a second, so a line is in the file (and on the live stream, main/live.js) soon after it is
// recorded; a write only happens when something was recorded.
const FLUSH_MS = 500
const PENDING_LIMIT = 4000
const NAME = 'watch-with-friends.log'
const PREVIOUS = 'watch-with-friends.1.log'
const CURSOR = 'upload-cursor.json'

const pending = createRing(PENDING_LIMIT)
let directory = null
let size = 0
let timer = null
let header = {}

const filePath = () => (directory ? path.join(directory, NAME) : null)
const previousPath = () => (directory ? path.join(directory, PREVIOUS) : null)

// main and the renderer have separate monotonic origins, so `m` only orders events within one
// process. Lining the two processes up — and the two people — is the wall clock's job.
const stamp = (scope, event, data, level) => ({at: Date.now(), mono: performance.now(), level, scope, event, data})

function schedule() {
  if (timer) return
  timer = setTimeout(flush, FLUSH_MS)
  timer.unref?.()
}

function start({dir, info = {}} = {}) {
  directory = dir
  header = info
  try {
    fs.mkdirSync(directory, {recursive: true})
    size = fs.statSync(filePath()).size
  } catch {
    size = 0
  }
  loadCursor()
  record('app', 'launch', info)
  flush()
}

// Writes the last events and closes the file. Recording still works afterwards, so a fault during
// shutdown is held in memory rather than thrown at a path that may no longer be writable.
function stop() {
  flush()
  directory = null
}

// Buffered even before there is a file to write to: a fault during startup is exactly the one
// worth keeping, and start() flushes whatever accumulated on its way past.
function record(scope, event, data = {}, level = 'info') {
  pending.push(stamp(scope, event, data, level))
  schedule()
}

// Entries arrive from the renderer already stamped, because a batch is up to a second old by the
// time it gets here and re-stamping would move every event to the moment it was flushed.
function recordBatch(entries) {
  if (!Array.isArray(entries)) return
  for (const entry of entries.slice(0, PENDING_LIMIT)) {
    if (!entry || typeof entry !== 'object') continue
    pending.push({
      at: Number(entry.at) || Date.now(),
      mono: Number(entry.mono) || 0,
      level: entry.level,
      scope: entry.scope,
      event: entry.event,
      data: entry.data,
    })
  }
  schedule()
}

function rotate(incoming) {
  if (!shouldRotate(size, incoming, MAX_FILE_BYTES)) return
  try {
    fs.rmSync(previousPath(), {force: true})
    fs.renameSync(filePath(), previousPath())
    size = 0
    // What was uploaded of the current file is now what was uploaded of the previous one.
    cursor = {previous: cursor.current, current: 0}
    rotations++
    // No file yet means nothing was ever uploaded; the cursor still says "everything" without one.
    if (fs.existsSync(cursorPath())) saveCursor()
  } catch {}
}

// Telemetry uploads (main/diagnostics.js) send only what they haven't sent before. The cursor is the
// byte offset already uploaded in each file, kept beside the log so a crash or a quit resumes from
// it on the next launch instead of sending the same hours again. `previous: null` means the
// previous file is fully sent. With no cursor file yet (telemetry just turned on), everything in
// both files counts as unsent.
let cursor = {previous: 0, current: 0}
let rotations = 0
const cursorPath = () => (directory ? path.join(directory, CURSOR) : null)

function loadCursor() {
  try {
    const saved = JSON.parse(fs.readFileSync(cursorPath(), 'utf8'))
    cursor = {
      previous: Number.isSafeInteger(saved.previous) && saved.previous >= 0 ? saved.previous : null,
      current: Number.isSafeInteger(saved.current) && saved.current >= 0 ? saved.current : 0,
    }
  } catch {
    cursor = {previous: 0, current: 0}
  }
}

function saveCursor() {
  try { fs.writeFileSync(cursorPath(), JSON.stringify(cursor)) } catch {}
}

const fileSize = (file) => {
  try { return fs.statSync(file).size } catch { return 0 }
}

function readRange(file, from, to) {
  if (to <= from) return ''
  const buffer = Buffer.alloc(to - from)
  const fd = fs.openSync(file, 'r')
  try { fs.readSync(fd, buffer, 0, buffer.length, from) } finally { fs.closeSync(fd) }
  return buffer.toString('utf8')
}

// Everything written since the last committed upload, oldest first, at most `maxBytes` (the newest
// part is kept: a backlog that big is old news, the end of it is not). Lines are written whole and
// this reads synchronously up to the size at this moment, so a chunk never ends mid-line.
// commit() is called only once the upload succeeded; a rotation in between is accounted for.
function takeUnsent({maxBytes = 2 * MAX_FILE_BYTES} = {}) {
  flush()
  if (!directory) return null
  const previousSize = fileSize(previousPath())
  const currentSize = fileSize(filePath())
  // An offset past the end means the file was replaced behind our back; start that file over.
  const previousFrom = cursor.previous == null ? previousSize : cursor.previous > previousSize ? 0 : cursor.previous
  const currentFrom = cursor.current > currentSize ? 0 : cursor.current
  let text = ''
  try {
    text = readRange(previousPath(), previousFrom, previousSize) + readRange(filePath(), currentFrom, currentSize)
  } catch {
    return null
  }
  if (!text.trim()) return null
  if (Buffer.byteLength(text) > maxBytes) {
    const tail = Buffer.from(text).subarray(-maxBytes).toString('utf8')
    text = tail.slice(tail.indexOf('\n') + 1)
  }
  const taken = rotations
  return {
    text,
    commit() {
      cursor = rotations === taken ? {previous: null, current: currentSize} : {previous: currentSize, current: cursor.current}
      saveCursor()
    },
  }
}

function flush() {
  clearTimeout(timer)
  timer = null
  if (!directory) return
  const {items, dropped} = pending.drain()
  if (dropped) items.unshift(stamp('log', 'dropped', {events: dropped}, 'warn'))
  if (!items.length) return
  const lines = items.map(formatEvent)
  const text = `${lines.join('\n')}\n`
  const bytes = Buffer.byteLength(text)
  rotate(bytes)
  try {
    fs.appendFileSync(filePath(), text)
    size += bytes
  } catch {}
  for (const listener of listeners) {
    try { listener(lines) } catch {}
  }
}

// Whoever wants the lines as they are written (the live telemetry stream, main/live.js) gets the
// same strings that went to the file, redacted and capped, so nothing downstream redacts again.
const listeners = new Set()
function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const read = (file) => {
  try { return fs.readFileSync(file, 'utf8') } catch { return '' }
}

// One file, oldest first, with what the person typed in the box at the top where it is read first.
function exportTo(targetPath, {note = ''} = {}) {
  flush()
  const preamble = {
    exported: new Date().toISOString(),
    note: String(note || '').slice(0, 2000) || null,
    ...header,
  }
  const body = [
    '# Watch With Friends diagnostics',
    ...Object.entries(preamble).map(([key, value]) => `# ${key}: ${value ?? '—'}`),
    '# Paths and addresses are removed. Usernames and room codes are kept, to match up two logs.',
    '',
    read(previousPath()),
    read(filePath()),
  ].join('\n')
  fs.mkdirSync(path.dirname(targetPath), {recursive: true})
  fs.writeFileSync(targetPath, body)
  return targetPath
}

const headerInfo = () => ({...header})

const defaultExportName =(now = new Date()) =>
  `watch-with-friends-${now.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')}.log`

module.exports = {MAX_FILE_BYTES, defaultExportName, exportTo, filePath, flush, headerInfo, record, recordBatch, start, stop, subscribe, takeUnsent}
