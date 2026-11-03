'use strict'

// Live telemetry, the app's end: with Settings' "Send telemetry for development" on, every log line
// is also pushed over one WebSocket to the relay Worker's /live route (relay/live.mjs), which
// fans it out to a developer running `npm run diagnostics -- --live`. The 15-minute archive upload
// (main/diagnostics.js) is separate and unchanged; this is only the "as it happens" copy.
//
// It lives in main, off the page: the lines are the ones main/log.js has just written, already
// redacted, so what a reader sees is byte for byte what the file holds.
//
// The Worker tells this socket whether anybody is watching ({"watching": true|false}). While nobody
// is, nothing is sent and nothing is kept. While the socket is down (or has not yet heard), lines
// are held, at most a minute and 256 KB, and sent when it is back and someone is watching; what had
// to be dropped is said by a "live/dropped" line in the stream. Batches go out at most once a
// second, deflated against the preset dictionary in shared/live.js.
//
// Reconnecting backs off from a second to a minute with jitter and never starts more than four
// attempts in any minute, because the Worker's limit is ten requests a minute per address and a
// Worker that is down must not be hammered. A WebSocket cannot say why an upgrade failed, so a
// 429 is simply one more failed attempt. A ping every 15 seconds that is not answered within 10
// declares the socket dead, so a connection that silently died is replaced within 25.

const {encodeBatch, splitBatches} = require('../shared/live')
const {formatEvent} = require('../shared/log')

const MAX_AGE_MS = 60_000
const MAX_BUFFER_BYTES = 256 * 1024
const SEND_EVERY_MS = 1000
const PING_EVERY_MS = 15_000
const PONG_WITHIN_MS = 10_000
const BACKOFF_FIRST_MS = 1000
const BACKOFF_MAX_MS = 60_000
const ATTEMPTS_PER_MINUTE = 4
const STABLE_AFTER_MS = 10_000
const NO_ENDPOINT_RETRY_MS = 60_000
const OPEN = 1

// https://relay.example/telemetry → wss://relay.example/live?role=app&from=aya%23abcd-1234
function liveUrl(endpoint, from) {
  const url = new URL(endpoint)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = url.pathname.replace(/\/telemetry\/?$/, '') + '/live'
  url.search = new URLSearchParams({role: 'app', from}).toString()
  return url.toString()
}

// Seconds to wait before attempt number `failures` (0 = first retry), jittered down by up to half.
const backoffMs = (failures, random = Math.random) =>
  Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** Math.min(failures, 10)) * (0.5 + random() * 0.5)

// How long until another connection attempt is allowed under "at most four a minute".
function attemptDelay(starts, now) {
  const recent = starts.filter((at) => now - at < 60_000)
  return recent.length < ATTEMPTS_PER_MINUTE ? 0 : recent[recent.length - ATTEMPTS_PER_MINUTE] + 60_000 - now
}

function createLiveSender({
  endpoint,
  WebSocketImpl = globalThis.WebSocket,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = Date.now,
  random = Math.random,
  record = () => {},
} = {}) {
  let enabled = false
  let name = null
  let socket = null
  let generation = 0
  let opened = false
  let openedAt = 0
  let watching = null // null until the Worker has said
  let connecting = false
  let failures = 0
  let starts = []
  let reconnectTimer = null
  let sendTimer = null
  let pingTimer = null
  let pongTimer = null
  let lastSend = -Infinity
  let held = [] // {at, text, bytes}
  let heldBytes = 0
  let dropped = 0
  const stats = {frames: 0, payloadBytes: 0, wireBytes: 0, lines: 0, pushes: 0}

  const remove = (count) => {
    const gone = held.splice(0, count)
    heldBytes -= gone.reduce((sum, item) => sum + item.bytes, 0)
    return gone.length
  }
  const clearHeld = () => { held = []; heldBytes = 0; dropped = 0 }

  function trim() {
    const cutoff = now() - MAX_AGE_MS
    let old = 0
    while (old < held.length && held[old].at < cutoff) old++
    if (old) dropped += remove(old)
    let excess = 0
    let bytes = heldBytes
    while (bytes > MAX_BUFFER_BYTES && excess < held.length) bytes -= held[excess++].bytes
    if (excess) dropped += remove(excess)
  }

  function push(lines) {
    if (!enabled || !Array.isArray(lines) || !lines.length) return
    // Connected and told nobody is watching: nothing to keep either.
    if (socket && opened && watching === false) return
    const at = now()
    for (const text of lines) held.push({at, text, bytes: Buffer.byteLength(text) + 1})
    heldBytes += lines.reduce((sum, text) => sum + Buffer.byteLength(text) + 1, 0)
    stats.lines += lines.length
    stats.pushes += 1
    trim()
    scheduleSend()
  }

  const ready = () => socket && opened && watching === true

  function scheduleSend() {
    if (sendTimer || !held.length || !ready()) return
    sendTimer = setTimer(sendNow, Math.max(0, lastSend + SEND_EVERY_MS - now()))
  }

  function sendNow() {
    sendTimer = null
    if (!ready() || !held.length) return
    trim()
    if (!held.length) return
    const marker = dropped
      ? formatEvent({at: now(), mono: 0, level: 'warn', scope: 'live', event: 'dropped', data: {n: dropped}})
      : null
    // One frame per tick: a backlog (after a reconnect) drains a second at a time.
    const first = splitBatches(held.map((item) => item.text))[0]
    const batch = marker ? [marker, ...first] : first
    let frame
    try { frame = encodeBatch(batch) } catch (error) { record('live', 'encode-failed', {message: error.message}, 'warn'); return }
    try { socket.send(frame) } catch { return } // the close event follows and reconnects
    remove(first.length)
    dropped = 0 // the marker, if any, went out with this frame
    lastSend = now()
    stats.frames += 1
    stats.payloadBytes += frame.length
    stats.wireBytes += frame.length + (frame.length < 126 ? 6 : 8) // WebSocket header and mask of a client frame
    scheduleSend()
  }

  function stopHeartbeat() {
    clearTimer(pingTimer)
    clearTimer(pongTimer)
    pingTimer = pongTimer = null
  }

  function heartbeat(mine) {
    stopHeartbeat()
    pingTimer = setTimer(() => {
      if (mine !== generation || !socket) return
      try { socket.send('ping') } catch { return }
      pongTimer = setTimer(() => {
        if (mine !== generation) return
        record('live', 'heartbeat-lost', {}, 'warn')
        closed(mine, 4000)
      }, PONG_WITHIN_MS)
      pongTimer.unref?.()
    }, PING_EVERY_MS)
    pingTimer.unref?.()
  }

  function heard(mine) {
    if (mine !== generation) return
    clearTimer(pongTimer)
    pongTimer = null
    heartbeat(mine)
  }

  // The one place a connection ends: a close, an error, a lost heartbeat, or being switched off.
  function closed(mine, code) {
    if (mine !== generation) return
    generation++
    const old = socket
    const wasOpen = opened
    const stable = wasOpen && now() - openedAt >= STABLE_AFTER_MS
    socket = null
    opened = false
    watching = null
    stopHeartbeat()
    clearTimer(sendTimer)
    sendTimer = null
    try { old?.close() } catch {}
    failures = stable ? 0 : failures + 1
    if (wasOpen || failures <= 3 || failures % 10 === 0) record('live', 'disconnected', {code, failures, wasOpen}, 'warn')
    if (enabled) scheduleReconnect()
  }

  function scheduleReconnect(hint = backoffMs(failures - 1, random)) {
    if (!enabled || !name || reconnectTimer || connecting || socket) return
    const wait = Math.max(hint, attemptDelay(starts, now()))
    reconnectTimer = setTimer(() => { reconnectTimer = null; connect() }, wait)
    reconnectTimer.unref?.()
  }

  async function connect() {
    if (!enabled || !name || socket || connecting || reconnectTimer) return
    const wait = attemptDelay(starts, now())
    if (wait > 0) return scheduleReconnect(wait)
    connecting = true
    let target = null
    try { target = await endpoint() } catch {}
    connecting = false
    if (!enabled || !name || socket) return
    if (!target) return scheduleReconnect(NO_ENDPOINT_RETRY_MS)
    starts.push(now())
    starts = starts.filter((at) => now() - at < 60_000)
    const mine = ++generation
    let created
    try {
      created = new WebSocketImpl(liveUrl(target, name))
    } catch (error) {
      generation++
      failures += 1
      record('live', 'connect-failed', {message: error.message}, 'warn')
      return scheduleReconnect()
    }
    created.binaryType = 'arraybuffer'
    socket = created
    created.addEventListener('open', () => {
      if (mine !== generation) return
      opened = true
      openedAt = now()
      heartbeat(mine)
    })
    created.addEventListener('message', (event) => {
      if (mine !== generation) return
      heard(mine)
      if (typeof event.data !== 'string' || event.data === 'pong') return
      let message
      try { message = JSON.parse(event.data) } catch { return }
      if (typeof message?.watching !== 'boolean') return
      watching = message.watching
      if (!watching) clearHeld()
      else scheduleSend()
    })
    created.addEventListener('close', (event) => closed(mine, event?.code))
    created.addEventListener('error', () => closed(mine, 1006))
  }

  // The checkbox and the username. Off closes the socket now; a new name reconnects under it,
  // since the Worker labels a socket for its whole life.
  function configure({enabled: on, from}) {
    const nextName = from || null
    const changed = nextName !== name
    enabled = Boolean(on)
    name = nextName
    if (!enabled) {
      clearTimer(reconnectTimer)
      clearTimer(sendTimer)
      reconnectTimer = sendTimer = null
      clearHeld()
      failures = 0
      if (socket) {
        const old = socket
        generation++
        socket = null
        opened = false
        watching = null
        stopHeartbeat()
        try { old.close(1000, 'off') } catch {}
      }
      return
    }
    if (changed && socket) {
      const old = socket
      generation++
      socket = null
      opened = false
      watching = null
      stopHeartbeat()
      try { old.close(1000, 'renamed') } catch {}
    }
    if (!socket) connect()
  }

  return {
    configure,
    push,
    close: () => configure({enabled: false, from: name}),
    status: () => ({connected: Boolean(socket && opened), watching, held: held.length, heldBytes, dropped, ...stats}),
  }
}

module.exports = {ATTEMPTS_PER_MINUTE, BACKOFF_MAX_MS, MAX_AGE_MS, MAX_BUFFER_BYTES, PING_EVERY_MS, PONG_WITHIN_MS, attemptDelay, backoffMs, createLiveSender, liveUrl}
