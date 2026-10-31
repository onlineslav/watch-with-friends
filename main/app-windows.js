// Spawns native/win-app-windows, which reports where one application's windows are (see the top
// of its main.cpp for the line format), for a whole-app share: the renderer captures each of
// those windows and lays them out together. Unlike app-audio's byte stream, only the latest
// layout matters, so a pull returns the newest line it hasn't returned yet and drops anything older.
const fs = require('node:fs')
const path = require('node:path')
const {spawn} = require('node:child_process')
const {app} = require('electron')

const HELPER = 'win-app-windows'
const binaryPath = () =>
  app.isPackaged ? path.join(process.resourcesPath, `${HELPER}.exe`) : path.join(__dirname, '..', 'native', HELPER, `${HELPER}.exe`)

// A layout line is small; anything this long is not one.
const MAX_LINE = 64 * 1024

const sessions = new Map()
let nextSessionId = 1

// Resolves with the session id and the first layout once the helper reports one, or rejects with
// its error line (the window closed, or it's this app's own window).
function startSession(windowId) {
  if (process.platform !== 'win32') return Promise.reject(new Error('Sharing a whole app is only available on Windows'))
  if (!fs.existsSync(binaryPath())) return Promise.reject(new Error(`This build is missing ${HELPER}, the helper that finds an app's windows`))
  return new Promise((resolve, reject) => {
    const proc = spawn(binaryPath(), [String(windowId)], {stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true})
    const session = {proc, layout: null, fresh: false, done: false, killed: false, error: null, waiter: null}
    const wake = () => {
      const waiter = session.waiter
      session.waiter = null
      waiter?.()
    }
    session.wake = wake
    let settled = false
    const settle = (error) => {
      if (settled) return
      settled = true
      if (error) return reject(error)
      const id = nextSessionId++
      sessions.set(id, session)
      session.fresh = false
      resolve({id, layout: session.layout})
    }

    let stderrText = ''
    proc.stderr.on('data', (buf) => {
      stderrText += buf.toString('utf8')
      for (let newlineAt; (newlineAt = stderrText.indexOf('\n')) !== -1;) {
        const line = stderrText.slice(0, newlineAt).trim()
        stderrText = stderrText.slice(newlineAt + 1)
        if (line.startsWith('error:')) session.error = line.replace(/^error:\s*/, '')
      }
    })
    let stdoutText = ''
    proc.stdout.on('data', (buf) => {
      stdoutText += buf.toString('utf8')
      let newlineAt
      while ((newlineAt = stdoutText.indexOf('\n')) !== -1) {
        const line = stdoutText.slice(0, newlineAt)
        stdoutText = stdoutText.slice(newlineAt + 1)
        try {
          session.layout = JSON.parse(line)
          session.fresh = true
        } catch {}
      }
      if (stdoutText.length > MAX_LINE) stdoutText = ''
      if (session.layout) settle()
      wake()
    })
    proc.on('error', (err) => {
      session.error = err.message
      session.done = true
      wake()
      settle(err)
    })
    proc.on('close', (code) => {
      session.done = true
      if (code !== 0 && !session.killed && !session.error) session.error = `${HELPER} exited with code ${code}`
      wake()
      settle(new Error(session.error || `${HELPER} exited before reporting any windows`))
    })
  })
}

async function pull(id) {
  const session = sessions.get(id)
  if (!session) return {done: true}
  while (!session.fresh && !session.done && !session.killed) {
    await new Promise((resolve) => (session.waiter = resolve))
  }
  if (session.killed) return {done: true}
  if (session.fresh) {
    session.fresh = false
    return {layout: session.layout}
  }
  sessions.delete(id)
  return {done: true, error: session.error}
}

// Whether the session's helper currently reports `hwnd` as one of the app's windows: the only
// windows main lets a whole-app share capture.
function reports(id, hwnd) {
  const windows = sessions.get(id)?.layout?.windows
  return Array.isArray(windows) && windows.some((entry) => Array.isArray(entry) && entry[4] === hwnd)
}

function stopSession(id) {
  const session = sessions.get(id)
  if (!session) return
  sessions.delete(id)
  session.killed = true
  session.proc.kill()
  session.wake()
}

function stopAll() {
  for (const id of [...sessions.keys()]) stopSession(id)
}

module.exports = {startSession, pull, reports, stopSession, stopAll}
