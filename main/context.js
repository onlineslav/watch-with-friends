'use strict'

// Context for the diagnostic log (M1.9): what the computer and the window were doing around a bad
// moment. Everything here is a plain event listener that writes one small line when something
// happens, so it costs nothing between events (no timer, no polling, no IPC).
//
//   crash/render-process-gone     the page's process died (reason, exit code)
//   crash/child-process-gone      the GPU, a utility or another helper process died
//   crash/unresponsive|responsive the window stopped answering, and came back
//   window/state                  minimized, restored, shown, hidden, focused, blurred, maximized, fullscreen
//   power/state                   suspend, resume, lock, unlock, on AC or battery, shutdown
//
// Main-process lines carry no room code (the renderer's carry one), so scripts/session-report.js
// attaches them to a watch session by time.

const WINDOW_EVENTS = [
  ['minimize', 'minimized'],
  ['restore', 'restored'],
  ['maximize', 'maximized'],
  ['unmaximize', 'unmaximized'],
  ['show', 'shown'],
  ['hide', 'hidden'],
  ['focus', 'focused'],
  ['blur', 'blurred'],
  ['enter-full-screen', 'fullscreen'],
  ['leave-full-screen', 'windowed'],
]

const POWER_EVENTS = [
  ['suspend', 'suspend'],
  ['resume', 'resume'],
  ['lock-screen', 'lock'],
  ['unlock-screen', 'unlock'],
  ['on-ac', 'ac'],
  ['on-battery', 'battery'],
  ['shutdown', 'shutdown'],
]

const text = (value, max = 80) => (typeof value === 'string' && value ? value.slice(0, max) : undefined)
const number = (value) => (Number.isFinite(value) ? value : undefined)

// Electron's details objects, cut down to what explains a crash. `clean-exit` is a process that ended
// on purpose, which is not worth a warning.
function describeGone(details) {
  const reason = text(details?.reason) || 'unknown'
  return {
    data: {reason, exitCode: number(details?.exitCode), type: text(details?.type), name: text(details?.name), service: text(details?.serviceName)},
    level: reason === 'clean-exit' ? 'info' : 'error',
  }
}

function watchApp({app, record}) {
  app.on('render-process-gone', (_event, _contents, details) => {
    const {data, level} = describeGone(details)
    record('crash', 'render-process-gone', data, level)
  })
  app.on('child-process-gone', (_event, details) => {
    const {data, level} = describeGone(details)
    record('crash', 'child-process-gone', data, level)
  })
}

// `win` is a BrowserWindow (or anything with .on and .webContents.on). A window that goes
// unresponsive is the other half of a hang: the log's `app/main-stall` says how long main was late,
// this says the window itself noticed.
function watchWindow({win, record}) {
  for (const [event, state] of WINDOW_EVENTS) win.on(event, () => record('window', 'state', {s: state}))
  win.on('unresponsive', () => record('crash', 'unresponsive', {}, 'warn'))
  win.on('responsive', () => record('crash', 'responsive', {}))
}

// A line written just before the computer sleeps may never reach disk otherwise, and the gap that
// follows is exactly what the line explains.
function watchPower({powerMonitor, record, flush = () => {}}) {
  for (const [event, state] of POWER_EVENTS) {
    powerMonitor.on(event, () => {
      record('power', 'state', {s: state})
      if (state === 'suspend' || state === 'shutdown') flush()
    })
  }
}

module.exports = {POWER_EVENTS, WINDOW_EVENTS, describeGone, watchApp, watchPower, watchWindow}
