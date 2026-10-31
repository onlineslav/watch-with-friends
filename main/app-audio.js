// Spawns the per-app audio helper, which captures one running application's audio and writes
// raw interleaved Float32 PCM to stdout: native/mac-app-audio on macOS (ScreenCaptureKit, a
// content filter scoped to that app), native/win-app-audio on Windows (WASAPI process loopback
// of that app's process tree). Session/pull/stop mirror media.js's ffmpeg sessions on purpose:
// pulling is what applies backpressure, same reason.
const fs = require('node:fs')
const path = require('node:path')
const {spawn} = require('node:child_process')
const {app} = require('electron')

const HELPER = process.platform === 'win32' ? 'win-app-audio' : 'mac-app-audio'
const binaryPath = () => {
  const file = process.platform === 'win32' ? `${HELPER}.exe` : HELPER
  return app.isPackaged ? path.join(process.resourcesPath, file) : path.join(__dirname, '..', 'native', HELPER, file)
}

const HIGH_WATER_BYTES = 4 * 1024 * 1024
const MAX_PULL_BYTES = 1024 * 1024
// ScreenCaptureKit can report a stream started successfully and then silently deliver nothing —
// the known failure mode when this binary hasn't been separately granted Screen & System Audio
// Recording permission (it's a distinct executable from the main app, with its own TCC entry).
// Treat that as a real failure instead of a share that's just quiet. (win-app-audio fills quiet
// stretches with silence itself, so there this only fires if it's genuinely stuck.)
const SILENCE_TIMEOUT_MS = 5000
const SILENCE_ERROR = process.platform === 'darwin'
  ? 'No audio arrived within 5s of starting — check that the shared app is actually making sound, and that mac-app-audio has Screen & System Audio Recording permission in System Settings > Privacy & Security.'
  : 'No audio arrived within 5s of starting.'

const sessions = new Map()
let nextSessionId = 1

// Resolves once the helper's first stderr line confirms capture actually started ("ready"), or
// rejects with its error line (e.g. the window closed, or Screen Recording permission is
// missing). Only a resolved session is worth pulling from.
function startSession(windowId) {
  if (!['darwin', 'win32'].includes(process.platform)) return Promise.reject(new Error('App audio capture is only available on macOS and Windows'))
  if (!fs.existsSync(binaryPath())) return Promise.reject(new Error(`This build is missing ${HELPER}, the helper that captures one app's audio`))
  return new Promise((resolve, reject) => {
    const proc = spawn(binaryPath(), [String(windowId)], {stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true})
    const session = {proc, chunks: [], size: 0, done: false, killed: false, error: null, waiter: null, bytesReceived: 0}
    const wake = () => {
      const waiter = session.waiter
      session.waiter = null
      waiter?.()
    }
    session.wake = wake

    let settled = false
    let stderrText = ''
    proc.stderr.on('data', (buf) => {
      stderrText += buf.toString('utf8')
      for (let newlineAt; (newlineAt = stderrText.indexOf('\n')) !== -1;) {
        const line = stderrText.slice(0, newlineAt).trim()
        stderrText = stderrText.slice(newlineAt + 1)
        if (settled) {
          // A failure after starting (the shared app quit, say) is the reason the process stops.
          if (line.startsWith('error:')) session.lateError = line.replace(/^error:\s*/, '')
        } else {
          settled = true
          started(line)
        }
      }
    })
    const started = (line) => {
      if (line === 'ready') {
        const id = nextSessionId++
        sessions.set(id, session)
        session.silenceTimer = setTimeout(() => {
          if (session.receivedAnyData || session.done) return
          session.error = SILENCE_ERROR
          session.done = true
          wake()
        }, SILENCE_TIMEOUT_MS)
        resolve({id})
      } else {
        proc.kill()
        reject(new Error(line.replace(/^error:\s*/, '') || `${HELPER} failed to start`))
      }
    }
    proc.stdout.on('data', (buf) => {
      if (!session.receivedAnyData) {
        session.receivedAnyData = true
        clearTimeout(session.silenceTimer)
      }
      session.bytesReceived += buf.length
      session.chunks.push(buf)
      session.size += buf.length
      if (session.size > HIGH_WATER_BYTES) proc.stdout.pause()
      wake()
    })
    proc.on('error', (err) => {
      clearTimeout(session.silenceTimer)
      session.error = err.message
      session.done = true
      wake()
      if (!settled) {
        settled = true
        reject(err)
      }
    })
    proc.on('close', (code, signal) => {
      clearTimeout(session.silenceTimer)
      session.done = true
      session.exitSignal = signal
      if (code !== 0 && !session.killed && !session.error) {
        // code is null when a signal killed the process (a crash, not a normal exit): macOS
        // writes a full stack trace for that to DiagnosticReports, which this can only point at.
        session.error = session.lateError || (signal
          ? `${HELPER} was killed by ${signal} (likely a crash) — check ~/Library/Logs/DiagnosticReports/${HELPER}-*.ips for the stack trace.`
          : `${HELPER} exited with code ${code}`)
      }
      wake()
      if (!settled) {
        settled = true
        reject(new Error(session.error || `${HELPER} exited before starting`))
      }
    })
  })
}

async function pull(id) {
  const session = sessions.get(id)
  if (!session) return {done: true}
  while (!session.size && !session.done && !session.killed) {
    await new Promise((resolve) => (session.waiter = resolve))
  }
  if (session.killed) return {done: true}
  if (session.size) {
    // Flagged once per session so main.js can log the single most diagnostic fact here: whether
    // real capture ever actually happened, not just "no error yet".
    const first = !session.loggedFirstChunk
    session.loggedFirstChunk = true
    const parts = []
    let taken = 0
    while (session.chunks.length && taken < MAX_PULL_BYTES) {
      const chunk = session.chunks.shift()
      parts.push(chunk)
      taken += chunk.length
    }
    session.size -= taken
    if (session.size < HIGH_WATER_BYTES / 2) session.proc.stdout.resume()
    return {chunk: Buffer.concat(parts, taken), first}
  }
  sessions.delete(id)
  return {done: true, error: session.error, bytesReceived: session.bytesReceived, exitSignal: session.exitSignal}
}

function stopSession(id) {
  const session = sessions.get(id)
  if (!session) return
  sessions.delete(id)
  clearTimeout(session.silenceTimer)
  session.killed = true
  session.proc.kill()
  session.wake()
}

function stopAll() {
  for (const id of [...sessions.keys()]) stopSession(id)
}

module.exports = {startSession, pull, stopSession, stopAll}
