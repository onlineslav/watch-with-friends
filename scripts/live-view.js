'use strict'

// The reader of live telemetry: `npm run diagnostics -- --live [scope ...]`.
//
// Connects to the relay Worker's /live route (relay/live.mjs) with your own GitHub login (`gh auth
// token`, sent in a header; the Worker lets it in only if it can read the diagnostics repository),
// and prints every connected person's log lines as they arrive, interleaved by their own clock and
// labelled with the username. Lines are held for a second before printing so a batch from one
// person that is slower on the wire still lands in order beside the other's.
//
//   --live                      everything
//   --live telemetry            one scope (the "sc" field); several: telemetry clock
//   --live telemetry/host-sample  scope/event
//   (marks, mark/note, always show whatever the filter: they are the moments to look at)
//   --from aya                  only people whose username starts with this
//   --url https://...           another Worker (or DIAGNOSTICS_LIVE_URL); http://localhost:8787 for wrangler dev
//   --no-color

const {execFileSync} = require('node:child_process')
const {decodeBatch, stripControl, unwrapRelayFrame} = require('../shared/live')

const DEFAULT_URL = 'https://synced-video-relay.watch-with-friends.workers.dev'
// A line reaches the reader about 2.5 s after it happened (the app's batching, the one-a-second batch,
// the socket), and two people's batches can differ by that much. Lines are therefore printed in order
// of their own timestamps once they are LAG_MS old, or have waited HOLD_MS, whichever comes first.
const LAG_MS = 3000
const HOLD_MS = 3000
const PING_EVERY_MS = 15_000
const PONG_WITHIN_MS = 10_000
const COLORS = [36, 33, 35, 32, 34, 91, 96, 93]

function parseArgs(args, env = {}) {
  const options = {scopes: [], from: null, url: env.DIAGNOSTICS_LIVE_URL || DEFAULT_URL, color: null}
  const start = args.indexOf('--live')
  if (start < 0) return null
  for (let i = start + 1; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--from') options.from = (args[++i] || '').toLowerCase()
    else if (arg === '--url') options.url = args[++i] || options.url
    else if (arg === '--no-color') options.color = false
    else if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}`)
    else options.scopes.push(...arg.split(',').filter(Boolean))
  }
  return options
}

// `telemetry` matches every event of that scope, `telemetry/host-sample` one event.
const wanted = (line, scopes) => !scopes.length || isMark(line) || scopes.some((scope) => (scope.includes('/') ? scope === `${line.sc}/${line.ev}` : scope === line.sc))

// Lines wait here, kept in order of their own timestamps. A line qualifies once it is `lagMs` old by
// its own clock or has been held `holdMs`; everything ahead of the last qualifying line is released
// with it, so what is printed never goes back in time, within a release or across them (unless a line
// arrives later than the hold allows for).
function createHold({holdMs = HOLD_MS, lagMs = LAG_MS} = {}) {
  let items = []
  let order = 0
  const key = (item) => item.at || item.receivedAt
  return {
    add(item, now) {
      items.push({...item, order: order++, receivedAt: now})
      items.sort((a, b) => key(a) - key(b) || a.order - b.order)
    },
    release(now) {
      let last = -1
      items.forEach((item, index) => { if ((item.at && item.at <= now - lagMs) || now - item.receivedAt >= holdMs) last = index })
      return last < 0 ? [] : items.splice(0, last + 1)
    },
    get size() { return items.length },
  }
}

// One frame from the Worker → lines ready to hold. Anything wrong with a frame skips that frame:
// the sockets apps connect with are unauthenticated.
function linesFromFrame(data, {scopes = [], from = null} = {}) {
  let relayed
  let batch
  try {
    relayed = unwrapRelayFrame(data)
    batch = decodeBatch(relayed.payload)
  } catch { return [] }
  const label = stripControl(relayed.from) || 'unknown'
  if (from && !label.toLowerCase().startsWith(from)) return []
  const out = []
  for (const raw of batch) {
    const text = stripControl(raw)
    let line = null
    try { line = JSON.parse(text) } catch {}
    if (line && typeof line === 'object' && !Array.isArray(line)) {
      if (!wanted(line, scopes)) continue
      out.push({label, line, text, at: Date.parse(line.t) || 0})
    } else if (!scopes.length) {
      out.push({label, line: null, text, at: 0})
    }
  }
  return out
}

// Your own clock: the point is to see an effect right after changing something.
const pad = (n, size = 2) => String(n).padStart(size, '0')
const clock = (at) => {
  if (!at) return ' '.repeat(12)
  const d = new Date(at)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

// A mark ("something is wrong now", M1.9) must stand out in a stream of 2-second samples: a banner in
// front of the line, bold red where there is colour, and the note first so it reads at a glance.
const isMark = (line) => line?.sc === 'mark' && line?.ev === 'note'

function formatLine({label, line, text, at}, {color = false, width = 24, colorOf = () => 0} = {}) {
  // Everything from the wire is stripped after it has been parsed and serialized again, and before any
  // colour is added: a C1 or bidi character written as a JSON unicode escape only becomes a real
  // character when parsed, and JSON.stringify re-escapes just the C0 range.
  const plain = stripControl(label)
  const shown = plain.length > width ? `${plain.slice(0, width - 1)}…` : plain.padEnd(width)
  const tag = color ? `\u001b[${colorOf(label)}m${shown}\u001b[0m` : shown
  if (!line) return `${clock(at)} ${tag} ${stripControl(text)}`
  const {t, m, lv, sc, ev, ...rest} = line
  const level = lv && lv !== 'info' ? ` ${String(lv).toUpperCase()}` : ''
  const body = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : ''
  if (isMark(line)) {
    const note = typeof rest.note === 'string' && rest.note ? ` "${rest.note}"` : ''
    const who = typeof rest.by === 'string' && rest.by ? ` by ${rest.by}` : ''
    const banner = stripControl(`>>> MARK${who}${note} <<<  ${sc}/${ev}${level}${body}`)
    return `${clock(at)} ${tag} ${color ? `\u001b[1;91m${banner}\u001b[0m` : banner}`
  }
  return `${clock(at)} ${tag} ${stripControl(`${sc}/${ev}${level}${body}`)}`
}

function wsUrl(base, role = 'view') {
  const url = new URL(base)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = '/live'
  url.search = `?role=${role}`
  return url.toString()
}

function httpUrl(base) {
  const url = new URL(base)
  url.pathname = '/live'
  url.search = '?role=view'
  return url.toString()
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function ghToken() {
  try { return execFileSync('gh', ['auth', 'token'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim() } catch { return null }
}

// Asks the Worker whether this token may watch, so the reason can be said in words; a WebSocket
// upgrade that is refused only reports "failed".
async function authorize(base, token, fetchImpl = fetch) {
  const response = await fetchImpl(httpUrl(base), {headers: {Authorization: `Bearer ${token}`}, signal: AbortSignal.timeout(10_000)})
  return response.status
}

async function run(args, {env = process.env, out = (text) => process.stdout.write(`${text}\n`), err = (text) => console.error(text), WebSocketImpl = globalThis.WebSocket, getToken = ghToken} = {}) {
  const options = parseArgs(args, env)
  const color = options.color ?? Boolean(process.stdout.isTTY)
  const colors = new Map()
  const colorOf = (label) => { if (!colors.has(label)) colors.set(label, COLORS[colors.size % COLORS.length]); return colors.get(label) }
  const hold = createHold()
  let widest = 13
  const token = getToken()
  if (!token) { err('No GitHub login found. Run `gh auth login` first.'); return 1 }
  err(`Watching ${options.url} as your GitHub account${options.scopes.length ? `, scope ${options.scopes.join(', ')}` : ''}. Ctrl+C to stop.`)

  const printer = setInterval(() => {
    for (const item of hold.release(Date.now())) {
      widest = Math.min(32, Math.max(widest, item.label.length))
      out(formatLine(item, {color, colorOf, width: widest}))
    }
  }, 250)

  let failures = 0
  try {
    for (;;) {
      let status
      try { status = await authorize(options.url, token) } catch (error) { status = 0 }
      if (status === 401) { err('GitHub rejected your login. Run `gh auth login` again.'); return 1 }
      if (status === 403) { err('That GitHub account cannot read onlineslav/watch-with-friends-diagnostics.'); return 1 }
      if (status === 200) {
        const opened = await listen(options, token, {WebSocketImpl, hold, err, out, color, colorOf})
        failures = opened ? 0 : failures + 1
      } else {
        failures += 1
        err(status ? `The Worker could not check with GitHub (${status}).` : 'Could not reach the Worker.')
      }
      const wait = Math.min(30_000, 1000 * 2 ** Math.min(failures, 5))
      err(`Reconnecting in ${Math.round(wait / 1000)}s...`)
      await sleep(wait)
    }
  } finally {
    clearInterval(printer)
  }
}

// One connection's life. Resolves true if it ever opened, once it is gone.
function listen(options, token, {WebSocketImpl, hold, err, out, color, colorOf}) {
  return new Promise((resolve) => {
    let opened = false
    let ping = null
    let pong = null
    const socket = new WebSocketImpl(wsUrl(options.url), {headers: {Authorization: `Bearer ${token}`}})
    socket.binaryType = 'arraybuffer'
    const finish = () => {
      clearInterval(ping)
      clearTimeout(pong)
      try { socket.close() } catch {}
      resolve(opened)
    }
    // A ping every 15 s no matter what else arrives: the Worker treats a reader whose last ping is
    // older than about 40 s as gone (a laptop that slept sends no close). Any message counts as an answer.
    const startPings = () => {
      ping = setInterval(() => {
        try { socket.send('ping') } catch { return finish() }
        clearTimeout(pong)
        pong = setTimeout(() => { err('No answer from the Worker; reconnecting.'); finish() }, PONG_WITHIN_MS)
      }, PING_EVERY_MS)
    }
    socket.addEventListener('open', () => { opened = true; startPings(); err('Connected. Waiting for apps with telemetry on...') })
    socket.addEventListener('message', (event) => {
      clearTimeout(pong)
      if (typeof event.data === 'string') {
        if (event.data === 'pong') return
        let message
        try { message = JSON.parse(event.data) } catch { return }
        const who = stripControl(message?.join || message?.leave || '')
        if (who && (!options.from || who.toLowerCase().startsWith(options.from))) {
          out(`${' '.repeat(13)}${color ? `\u001b[${colorOf(who)}m` : ''}-- ${who} ${message.join ? 'connected' : 'disconnected'} --${color ? '\u001b[0m' : ''}`)
        }
        return
      }
      const now = Date.now()
      for (const item of linesFromFrame(event.data, options)) hold.add(item, now)
    })
    socket.addEventListener('close', () => { err('Disconnected.'); finish() })
    socket.addEventListener('error', () => finish())
  })
}

module.exports = {DEFAULT_URL, HOLD_MS, LAG_MS, authorize, createHold, formatLine, isMark, httpUrl, linesFromFrame, parseArgs, run, wanted, wsUrl}
