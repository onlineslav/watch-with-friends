'use strict'

// Diagnostic logging, the pure half: how an event becomes a line, what is stripped out of it
// before it can be, and when the file has to roll over. main/log.js does the I/O.
//
// Two people compare two files after the fact, so every line carries both clocks. The wall clock
// lines the two files up against each other; the monotonic clock orders events inside one process,
// which the wall clock cannot do because it steps when the system clock is corrected.

const MAX_LINE_BYTES = 4000
const MAX_STRING = 500
const MAX_DEPTH = 6
const LEVELS = ['debug', 'info', 'warn', 'error']

// A log is meant to be sent to someone else, so these run over every value, not just the ones
// that look risky. Absolute paths name the person's disk and their media; only the file name is
// diagnostic. Addresses identify their home network; the app only ever needs the candidate type.
const PATH_PATTERN = /(?:[A-Za-z]:[\\/]|file:\/{2,3}|\/(?:home|Users|mnt|media|srv|opt|var|tmp)\/)[^\s"'<>|?*]*/g
const IPV4_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
// Four or more groups, so clock readings like 00:01:24 are left alone.
const IPV6_PATTERN = /\b(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}\b/gi

// Keep the last segment: "…\clip.mkv" still tells you which file broke, and nothing else.
function redactPath(text) {
  return String(text).replace(PATH_PATTERN, (match) => {
    const name = match.split(/[\\/]/).filter(Boolean).pop() || ''
    return name && !/^[A-Za-z]:$/.test(name) ? `…/${name}` : '…'
  })
}

const redactString = (text) => {
  const clean = redactPath(text).replace(IPV6_PATTERN, '[ip]').replace(IPV4_PATTERN, '[ip]')
  return clean.length > MAX_STRING ? `${clean.slice(0, MAX_STRING)}…` : clean
}

function redact(value, depth = 0) {
  if (typeof value === 'string') return redactString(value)
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (value == null || typeof value === 'boolean') return value ?? null
  if (depth >= MAX_DEPTH) return '[deep]'
  if (Array.isArray(value)) return value.slice(0, 64).map((item) => redact(item, depth + 1))
  if (value instanceof Error) return redactString(value.message || String(value))
  if (typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value).slice(0, 64)) {
      if (item !== undefined) out[key] = redact(item, depth + 1)
    }
    return out
  }
  return redactString(String(value))
}

// One event, one line of JSON. Short keys because the telemetry sample repeats every 2 seconds:
// t=time, m=monotonic ms, lv=level, sc=scope, ev=event.
function formatEvent({at, mono, level, scope, event, data}) {
  const head = {
    t: new Date(Number.isFinite(at) ? at : Date.now()).toISOString(),
    m: Math.round(Number.isFinite(mono) ? mono : 0),
    lv: LEVELS.includes(level) ? level : 'info',
    sc: String(scope || 'app'),
    ev: String(event || 'event'),
  }
  const body = data && typeof data === 'object' && !Array.isArray(data) ? redact(data, 1) : {}
  const line = JSON.stringify({...head, ...body})
  // Redaction caps each string, so this only catches an event with an unreasonable number of
  // fields. Keeping the header is worth more than keeping a line that no parser can read.
  return line.length <= MAX_LINE_BYTES ? line : JSON.stringify({...head, dropped: line.length})
}

const parseLine = (line) => {
  try { return JSON.parse(line) } catch { return null }
}

// Bounds what the renderer holds between flushes, so a main process that stops answering costs
// memory once rather than without limit. Oldest goes first, and the count of what was lost is
// reported so a gap in the file is visible rather than silent.
function createRing(limit) {
  const items = []
  let dropped = 0
  return {
    push(item) {
      items.push(item)
      if (items.length > limit) { items.shift(); dropped += 1 }
    },
    drain() {
      const taken = items.splice(0, items.length)
      const lost = dropped
      dropped = 0
      return {items: taken, dropped: lost}
    },
    get size() { return items.length },
    get dropped() { return dropped },
  }
}

// Roll over before the write rather than after it, so a file never passes the cap. A single
// oversized write still goes through: losing the event would be worse than a file slightly
// over the limit.
const shouldRotate = (size, incoming, max) => size > 0 && size + incoming > max

module.exports = {LEVELS, MAX_LINE_BYTES, MAX_STRING, createRing, formatEvent, parseLine, redact, redactPath, shouldRotate}
