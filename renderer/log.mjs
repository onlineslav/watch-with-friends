import {createRing} from '../shared/log.js'

// The renderer's end of the diagnostic log. Events are stamped here and shipped to main in
// batches, because the interesting one — the telemetry sample — repeats every 2 seconds for
// every peer and a write per event would be an IPC message per event.
//
// Context (room code, role) is attached automatically: when two people compare logs, every line
// needs to say which room and which side it came from, and remembering to pass that at each call
// site is how it ends up missing from the one line that mattered.

const PENDING_LIMIT = 600
const FLUSH_MS = 2000

const pending = createRing(PENDING_LIMIT)
let context = {}
let timer = null
let sending = false

export function setLogContext(next) {
  context = {...context, ...next}
  for (const [key, value] of Object.entries(context)) if (value == null) delete context[key]
}

export function logEvent(scope, event, data = {}, level = 'info') {
  pending.push({at: Date.now(), mono: performance.now(), level, scope, event, data: {...context, ...data}})
  if (!timer) timer = setTimeout(flushLog, FLUSH_MS)
}

export const logWarn = (scope, event, data) => logEvent(scope, event, data, 'warn')
export const logError = (scope, event, data) => logEvent(scope, event, data, 'error')

export async function flushLog() {
  clearTimeout(timer)
  timer = null
  if (sending || !pending.size) return
  const {items, dropped} = pending.drain()
  if (dropped) items.unshift({at: Date.now(), mono: performance.now(), level: 'warn', scope: 'log', event: 'dropped', data: {events: dropped}})
  sending = true
  try {
    await window.api.logEvents(items)
  } catch {
    // Main is gone or busy. The events are already out of the ring; keeping them would only
    // grow it, and the gap is visible in the file because the next flush reports what it lost.
  } finally {
    sending = false
  }
}

const errorData = (error) => ({
  message: String(error?.message || error || 'unknown'),
  stack: String(error?.stack || '').split('\n').slice(0, 6).join(' | ') || null,
})

// Anything that reaches the window would otherwise only exist in a devtools console nobody has
// open. These are the lines that explain a log that simply stops.
export function installErrorLogging() {
  window.addEventListener('error', (event) => {
    logError('error', 'uncaught', {...errorData(event.error || event.message), source: event.filename || null, line: event.lineno || null})
  })
  window.addEventListener('unhandledrejection', (event) => {
    logError('error', 'unhandled-rejection', errorData(event.reason))
  })
  // A flush is up to 2 seconds behind, which is exactly the window in which a crash or a close
  // takes the last events with it.
  window.addEventListener('pagehide', () => flushLog())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushLog()
  })
}

export async function saveDiagnostics(note = '') {
  await flushLog()
  return window.api.saveDiagnostics({note})
}
