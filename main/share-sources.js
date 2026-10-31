// The share picker's list of screens and windows on Windows, from native/win-share-sources (see
// the top of its main.cpp) instead of desktopCapturer.getSources, which froze this process for
// 450-700ms per call (measured) and so made the whole window hang every time the open picker
// refreshed. The helper runs while the picker keeps asking and stops once it hasn't for IDLE_MS;
// a call returns its latest list straight away, or waits for its first one.
const fs = require('node:fs')
const path = require('node:path')
const {spawn} = require('node:child_process')
const {app} = require('electron')

const HELPER = 'win-share-sources'
const IDLE_MS = 6000
const FIRST_LIST_MS = 10_000
// A list is tens of KB (thumbnails); anything this long is not one.
const MAX_LINE = 16 * 1024 * 1024

const binaryPath = () =>
  app.isPackaged ? path.join(process.resourcesPath, `${HELPER}.exe`) : path.join(__dirname, '..', 'native', HELPER, `${HELPER}.exe`)

let proc = null
let latest = null
let waiters = []
let idleTimer = null

const available = () => process.platform === 'win32' && fs.existsSync(binaryPath())

function settle(error) {
  const pending = waiters
  waiters = []
  for (const waiter of pending) error ? waiter.reject(error) : waiter.resolve(latest)
}

function stop() {
  clearTimeout(idleTimer)
  proc?.kill()
  proc = null
  latest = null
}

function run() {
  latest = null
  proc = spawn(binaryPath(), [], {stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true})
  const current = proc
  let text = ''
  current.stdout.on('data', (buf) => {
    text += buf.toString('utf8')
    let newlineAt
    while ((newlineAt = text.indexOf('\n')) !== -1) {
      const line = text.slice(0, newlineAt)
      text = text.slice(newlineAt + 1)
      try {
        const sources = JSON.parse(line).sources
        if (Array.isArray(sources) && proc === current) {
          latest = sources
          settle()
        }
      } catch {}
    }
    if (text.length > MAX_LINE) text = ''
  })
  current.stderr.resume()
  const ended = (error) => {
    if (proc !== current) return
    proc = null
    latest = null
    settle(error || new Error(`${HELPER} stopped`))
  }
  current.on('error', ended)
  current.on('close', () => ended())
}

// [{id, name, thumbnail}], the same shape the picker got from desktopCapturer.
function list() {
  clearTimeout(idleTimer)
  idleTimer = setTimeout(stop, IDLE_MS)
  if (!proc) run()
  if (latest) return Promise.resolve(latest)
  return new Promise((resolve, reject) => {
    const waiter = {resolve, reject}
    waiters.push(waiter)
    setTimeout(() => {
      if (!waiters.includes(waiter)) return
      waiters = waiters.filter((other) => other !== waiter)
      reject(new Error('Listing screens and windows took too long'))
    }, FIRST_LIST_MS)
  })
}

module.exports = {available, list, stop}
