'use strict'

// Pings this computer's router and the internet every 200ms while it is in a room, for the
// diagnostic log, so a stall in a watch session can be placed on one side: the router slow too is
// this computer's own network (Wi-Fi, cable, router); only the internet slow is the line past the
// router; neither is somewhere else (the other person's side, or between). On Windows
// native/win-net-probe does the pinging (ping.exe can only ping once a second, which misses half of
// a one-second stall); elsewhere the system ping does, one process per target. Each 2s machine
// reading carries the counts (`np`), and each stall is its own `network/probe-stall` line as soon
// as it ends. Pure parts are separate from the processes so they can be unit-tested.

const INTERVAL_MS = 200
const LATE_MS = 1000 // a reply later than this counts as lost (the Windows helper's own timeout)
const STALL_MS = 150 // a probe this slow, or lost, is part of a stall
const LONG_STALL_MS = 10_000 // a stall still going after this is reported, then counted afresh
const INTERNET = '1.1.1.1'

const round = (value) => Math.round(value * 10) / 10

// Probes in, a summary per target out (`take`, each reading), and `onStall` once a run of slow or
// lost probes ends: {on: 'gw'|'net', dur (ms from the first bad probe to the first good one), ms
// (slowest reply, absent if all were lost), lost, n}.
function createProbeStats({onStall = () => {}, stallMs = STALL_MS, longStallMs = LONG_STALL_MS} = {}) {
  const targets = {}
  const end = (t, s, at) => {
    const {start, worst, lost, n} = s.stall
    s.stall = null
    onStall({on: t, dur: Math.round(at - start), ...(worst > 0 && {ms: worst}), lost, n})
  }
  return {
    add(t, ms, at) {
      const s = (targets[t] ||= {n: 0, lost: 0, sum: 0, max: 0, stall: null})
      s.n++
      if (ms == null) s.lost++
      else {
        s.sum += ms
        s.max = Math.max(s.max, ms)
      }
      if (ms == null || ms > stallMs) {
        s.stall ||= {start: at, worst: 0, lost: 0, n: 0}
        s.stall.n++
        if (ms == null) s.stall.lost++
        else s.stall.worst = Math.max(s.stall.worst, ms)
        if (at - s.stall.start >= longStallMs) end(t, s, at)
      } else if (s.stall) end(t, s, at)
    },
    // {gw: {n, lost?, avg?, max?}, net: {...}} since the last call, or null with no probes at all.
    take() {
      const out = {}
      for (const [t, s] of Object.entries(targets)) {
        if (!s.n) continue
        const answered = s.n - s.lost
        out[t] = {n: s.n, ...(s.lost && {lost: s.lost}), ...(answered && {avg: round(s.sum / answered), max: s.max})}
        Object.assign(s, {n: 0, lost: 0, sum: 0, max: 0})
      }
      return Object.keys(out).length ? out : null
    },
  }
}

// The system ping's output for one target, as probes: a reply line gives its time; a sequence
// number skipped over, or not answered within `late` (checked by `tick`), is a lost probe. "Request
// timeout" lines are ignored: macOS prints one for any probe still unanswered when the next is sent,
// which at 200ms includes replies that are merely slow.
function createPingParser({onProbe, interval = INTERVAL_MS, late = LATE_MS}) {
  let lastSeq = null
  let lastAt = 0
  let counted = -1 // highest sequence number already reported, answered or lost
  const lose = (from, to) => { for (let seq = from; seq <= to; seq++) onProbe(null) }
  return {
    line(text, at) {
      const match = /icmp_seq=(\d+).*?time[=<]([\d.]+) ?ms/.exec(text)
      if (!match) return
      const seq = Number(match[1])
      const ms = round(Number(match[2]))
      if (lastSeq !== null && seq <= counted) return // already reported as lost: later than `late`
      if (lastSeq !== null) lose(counted + 1, seq - 1)
      onProbe(ms)
      lastSeq = counted = seq
      lastAt = at
    },
    tick(at) {
      if (lastSeq === null) return
      const overdue = lastSeq + Math.floor((at - lastAt - late) / interval)
      if (overdue > counted) {
        lose(counted + 1, overdue)
        counted = overdue
      }
    },
  }
}

// macOS `route -n get default` -> the gateway's address, or null.
function parseRoute(text) {
  const match = /gateway:\s*([\d.]+)/.exec(String(text || ''))
  return match ? match[1] : null
}

// The running probe. `record(scope, event, data, level)` is main/log.js's; `binaryPath` the Windows
// helper's. start/stop are idempotent; `take()` is the reading's `np`.
function createNetProbe({record, binaryPath, platform = process.platform, spawn = require('node:child_process').spawn,
  execFile = require('node:child_process').execFile, exists = require('node:fs').existsSync, now = () => performance.now()}) {
  const stats = createProbeStats({onStall: (stall) => record('network', 'probe-stall', stall, 'warn')})
  let procs = []
  let ticker = null
  let running = false

  const lines = (proc, onLine) => {
    let text = ''
    proc.stdout.on('data', (buf) => {
      text += buf.toString('utf8')
      let at
      while ((at = text.indexOf('\n')) !== -1) {
        onLine(text.slice(0, at).trim())
        text = text.slice(at + 1)
      }
      if (text.length > 4096) text = ''
    })
  }

  const track = (proc, name) => {
    procs.push(proc)
    proc.on('error', (error) => record('network', 'probe-failed', {name, message: error.message}, 'warn'))
    return proc
  }

  function startWindows() {
    const file = binaryPath?.()
    if (!file || !exists(file)) {
      record('network', 'probe-failed', {name: 'win-net-probe', message: 'helper missing'}, 'warn')
      return
    }
    const proc = track(spawn(file, [], {stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true}), 'win-net-probe')
    lines(proc, (line) => {
      const [t, ms] = line.split(' ')
      if (t !== 'gw' && t !== 'net') return
      const value = Number(ms)
      stats.add(t, value < 0 ? null : value, now())
    })
    record('network', 'probe', {how: 'helper', every: INTERVAL_MS})
  }

  // One ping per target. A system that refuses 0.2s for an ordinary user (some only allow 1s) gets
  // 1s, and the log says so.
  function startPing(t, address, interval = INTERVAL_MS) {
    const seconds = interval / 1000
    const args = platform === 'darwin' ? ['-n', '-i', String(seconds), '-W', String(LATE_MS), address] : ['-n', '-i', String(seconds), '-W', '1', address]
    const proc = track(spawn(platform === 'darwin' ? '/sbin/ping' : 'ping', args, {stdio: ['ignore', 'pipe', 'ignore']}), `ping ${t}`)
    const parser = createPingParser({interval, onProbe: (ms) => stats.add(t, ms, now())})
    const startedAt = now()
    lines(proc, (line) => parser.line(line, now()))
    proc.parsers = [parser]
    proc.on('exit', (code) => {
      procs = procs.filter((p) => p !== proc)
      if (!running) return
      if (interval === INTERVAL_MS && now() - startedAt < 3000) {
        record('network', 'probe-fallback', {t, every: 1000, code})
        startPing(t, address, 1000)
      } else record('network', 'probe-failed', {name: `ping ${t}`, code}, 'warn')
    })
  }

  function startPings() {
    startPing('net', INTERNET)
    const route = platform === 'darwin' ? ['/sbin/route', ['-n', 'get', 'default']] : ['ip', ['route', 'show', 'default']]
    execFile(route[0], route[1], {timeout: 3000}, (error, stdout) => {
      if (!running) return
      const gateway = platform === 'darwin' ? parseRoute(stdout) : /via\s+([\d.]+)/.exec(String(stdout || ''))?.[1]
      if (gateway) startPing('gw', gateway)
      record('network', 'probe', {how: 'ping', every: INTERVAL_MS, gw: Boolean(gateway)})
    })
    ticker = setInterval(() => { for (const proc of procs) for (const parser of proc.parsers || []) parser.tick(now()) }, 250)
    ticker.unref?.()
  }

  return {
    start() {
      if (running) return
      running = true
      try {
        platform === 'win32' ? startWindows() : startPings()
      } catch (error) {
        record('network', 'probe-failed', {message: error.message}, 'warn')
      }
    },
    stop() {
      running = false
      clearInterval(ticker)
      ticker = null
      for (const proc of procs) try { proc.kill() } catch {}
      procs = []
      stats.take()
    },
    take: () => stats.take(),
  }
}

module.exports = {INTERVAL_MS, LATE_MS, STALL_MS, createNetProbe, createPingParser, createProbeStats, parseRoute}
