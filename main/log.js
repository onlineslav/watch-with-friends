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
const FLUSH_MS = 1000
const PENDING_LIMIT = 4000
const NAME = 'watch-with-friends.log'
const PREVIOUS = 'watch-with-friends.1.log'

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
  } catch {}
}

function flush() {
  clearTimeout(timer)
  timer = null
  if (!directory) return
  const {items, dropped} = pending.drain()
  if (dropped) items.unshift(stamp('log', 'dropped', {events: dropped}, 'warn'))
  if (!items.length) return
  const text = `${items.map(formatEvent).join('\n')}\n`
  const bytes = Buffer.byteLength(text)
  rotate(bytes)
  try {
    fs.appendFileSync(filePath(), text)
    size += bytes
  } catch {}
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

const defaultExportName = (now = new Date()) =>
  `watch-with-friends-${now.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')}.log`

module.exports = {MAX_FILE_BYTES, defaultExportName, exportTo, filePath, flush, record, recordBatch, start, stop}
