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
const PEER_SLOTS = 4 // the Windows helper's limit too
const TRACE_EVERY_MS = 60_000 // at most one traceroute per peer per minute
const BASELINE_TRACE_MS = 5000 // a calm traceroute this long after a peer is first pinged
const STALL_TRACE_PROBES = 3 // consecutive slow or lost pings to a peer that has answered before
const MAX_HOPS = 20

const round = (value) => Math.round(value * 10) / 10

// Probes in, a summary per target out (`take`, each reading), and `onStall` once a run of slow or
// lost probes ends: {on: 'gw'|'net', dur (ms from the first bad probe to the first good one), ms
// (slowest reply, absent if all were lost), lost, n}.
function createProbeStats({onStall = () => {}, stallMs = STALL_MS, longStallMs = LONG_STALL_MS} = {}) {
  const targets = {}
  const end = (t, s, at) => {
    const {start, worst, lost, n} = s.stall
    s.stall = null
    const where = t.startsWith('p:') ? {on: 'peer', peer: t.slice(2)} : {on: t}
    onStall({...where, dur: Math.round(at - start), ...(worst > 0 && {ms: worst}), lost, n})
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
    // {gw: {n, lost?, avg?, max?}, net: {...}, peer: {<peerId>: {...}}} since the last call, or null
    // with no probes at all.
    take() {
      const out = {}
      for (const [t, s] of Object.entries(targets)) {
        if (!s.n) continue
        const answered = s.n - s.lost
        const summary = {n: s.n, ...(s.lost && {lost: s.lost}), ...(answered && {avg: round(s.sum / answered), max: s.max})}
        if (t.startsWith('p:')) (out.peer ||= {})[t.slice(2)] = summary
        else out[t] = summary
        Object.assign(s, {n: 0, lost: 0, sum: 0, max: 0})
      }
      return Object.keys(out).length ? out : null
    },
    // A peer that left: its numbers and any stall in progress are dropped, not reported.
    forget(t) { delete targets[t] },
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

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
const isIPv4 = (text) => typeof text === 'string' && IPV4.test(text)

// What kind of address a hop is, without saying which: 'l' private or link-local (a home or office
// network), 'c' carrier-grade NAT (100.64.0.0/10, the ISP's own NAT), 'p' public.
function addressKind(address) {
  if (!isIPv4(address)) return null
  const [a, b] = address.split('.').map(Number)
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 127) return 'l'
  if (a === 100 && b >= 64 && b <= 127) return 'c'
  return 'p'
}

// A 16-bit FNV-1a of a hop's address, 4 hex digits: enough to see that two traces (one from each
// side, or the same side an hour apart) pass the same router, while ~65,000 addresses share each
// value, so the log never says where anyone is.
function hopHash(address) {
  let h = 0x811c9dc5
  for (const ch of String(address)) {
    h ^= ch.charCodeAt(0)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return ((h ^ (h >>> 16)) & 0xffff).toString(16).padStart(4, '0')
}

// Hops as logged: [ms or null, kind, hash] per hop, unanswered hops [null].
const hopEntry = ({ms, address}) => (address ? [ms, addressKind(address), hopHash(address)] : [null])

// `traceroute -n -q 1` output (macOS and Linux) -> [{ttl, ms, address}].
function parseTraceroute(text) {
  const hops = []
  for (const line of String(text || '').split('\n')) {
    const match = /^\s*(\d+)\s+(?:(\*)|([\d.]+)\s+([\d.]+)\s*ms)/.exec(line)
    if (!match) continue
    hops.push(match[2] ? {ttl: Number(match[1]), ms: null, address: null} : {ttl: Number(match[1]), ms: round(Number(match[4])), address: match[3]})
  }
  return hops
}

// The running probe. `record(scope, event, data, level)` is main/log.js's; `binaryPath` the Windows
// helper's. start/stop are idempotent; `take()` is the reading's `np`. `setPeers` names the other
// people in the room by peer id and the address their connection reaches them at (IPv4 only); while
// running each is pinged like the router (`np.peer`), and `trace` (or `trouble`, the renderer's word
// that a connection is struggling) runs one traceroute to them, logged as `network/trace` with each
// hop's kind and hash, never an address. A peer is traced once 5s after it is first pinged (the calm
// route to compare with), again when 3 pings in a row go slow or missing after it has answered, and
// whenever the renderer reports trouble; at most once a minute each.
function createNetProbe({record, binaryPath, platform = process.platform, spawn = require('node:child_process').spawn,
  execFile = require('node:child_process').execFile, exists = require('node:fs').existsSync, now = () => performance.now(),
  setTimer = setTimeout, clearTimer = clearTimeout}) {
  const stats = createProbeStats({onStall: (stall) => record('network', 'probe-stall', stall, 'warn')})
  let procs = []
  let ticker = null
  let running = false
  let helper = null // the Windows helper, which also takes peer and trace commands on stdin
  let wanted = new Map() // peerId -> address, kept while stopped so a start picks them up
  const active = new Map() // peerId -> {address, answered, bad, lastTraceAt, timer, proc, trace}

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

  const tell = (line) => {
    try { helper?.stdin?.write(line + '\n') } catch {}
  }

  function peerProbe(id, ms) {
    const peer = active.get(id)
    if (!peer) return
    stats.add('p:' + id, ms, now())
    if (ms != null && ms <= STALL_MS) {
      peer.answered = true
      peer.bad = 0
    } else if (peer.answered && ++peer.bad === STALL_TRACE_PROBES) trace(id, 'stall')
  }

  function logTrace(id, why, hops, reached) {
    const peer = active.get(id)
    record('network', 'trace', {peer: id, why, n: hops.length, reached: Boolean(reached), ...(peer && {pinged: peer.answered}), hops: hops.map(hopEntry)})
  }

  // One traceroute to a peer, if one may run now. True when it started.
  function trace(id, why) {
    const peer = active.get(id)
    if (!running || !peer || peer.trace) return false
    if (peer.lastTraceAt != null && now() - peer.lastTraceAt < TRACE_EVERY_MS) return false
    peer.lastTraceAt = now()
    peer.trace = {why, hops: []}
    if (helper) {
      tell('trace ' + id)
      return true
    }
    const command = platform === 'darwin' ? '/usr/sbin/traceroute' : 'traceroute'
    execFile(command, ['-n', '-q', '1', '-w', '1', '-m', String(MAX_HOPS), peer.address], {timeout: 40_000}, (error, stdout) => {
      if (active.get(id) !== peer) return
      peer.trace = null
      const hops = parseTraceroute(stdout)
      if (!hops.length) return record('network', 'trace-failed', {peer: id, why, message: error?.code === 'ENOENT' ? 'no traceroute' : error?.message || 'no output'}, 'warn')
      logTrace(id, why, hops, hops.at(-1)?.address === peer.address)
    })
    return true
  }

  function addPeer(id, address) {
    const peer = {address, answered: false, bad: 0, lastTraceAt: null, timer: null, proc: null, trace: null}
    active.set(id, peer)
    if (helper) tell('peer ' + id + ' ' + address)
    else if (platform !== 'win32') peer.proc = startPing('p:' + id, address, INTERVAL_MS, (ms) => peerProbe(id, ms), () => active.get(id) === peer)
    peer.timer = setTimer(() => { peer.timer = null; trace(id, 'baseline') }, BASELINE_TRACE_MS)
    peer.timer?.unref?.()
  }

  function dropPeer(id) {
    const peer = active.get(id)
    if (!peer) return
    active.delete(id)
    if (peer.timer) clearTimer(peer.timer)
    if (helper) tell('peer ' + id + ' -')
    if (peer.proc) try { peer.proc.kill() } catch {}
    stats.forget('p:' + id)
  }

  function applyPeers() {
    if (!running) return
    for (const [id, peer] of active) if (wanted.get(id) !== peer.address) dropPeer(id)
    for (const [id, address] of wanted) if (!active.has(id) && active.size < PEER_SLOTS) addPeer(id, address)
  }

  function helperLine(line) {
    const parts = line.split(' ')
    const [t] = parts
    if (t === 'gw' || t === 'net') {
      const value = Number(parts[1])
      stats.add(t, value < 0 ? null : value, now())
    } else if (t === 'p') {
      const value = Number(parts[2])
      peerProbe(parts[1], value < 0 ? null : value)
    } else if (t === 'hop') {
      const pending = active.get(parts[1])?.trace
      const ms = Number(parts[3])
      if (pending && pending.hops.length < MAX_HOPS) pending.hops.push({ttl: Number(parts[2]), ms: ms < 0 ? null : ms, address: isIPv4(parts[4]) ? parts[4] : null})
    } else if (t === 'trace-end') {
      const peer = active.get(parts[1])
      if (!peer?.trace) return
      const {why, hops} = peer.trace
      peer.trace = null
      logTrace(parts[1], why, hops, parts[2] === '1')
    }
  }

  function startWindows() {
    const file = binaryPath?.()
    if (!file || !exists(file)) {
      record('network', 'probe-failed', {name: 'win-net-probe', message: 'helper missing'}, 'warn')
      return
    }
    // stdin is a pipe: it carries peer and trace commands, and its closing tells the helper to exit.
    const proc = track(spawn(file, [], {stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true}), 'win-net-probe')
    proc.stdin?.on?.('error', () => {})
    helper = proc
    proc.on('exit', () => { if (helper === proc) helper = null })
    lines(proc, helperLine)
    record('network', 'probe', {how: 'helper', every: INTERVAL_MS})
  }

  // One ping per target. A system that refuses 0.2s for an ordinary user (some only allow 1s) gets
  // 1s, and the log says so. `wanted()` false means it was stopped on purpose (a peer that left).
  function startPing(t, address, interval = INTERVAL_MS, onProbe = (ms) => stats.add(t, ms, now()), wanted = () => true) {
    const seconds = interval / 1000
    const args = platform === 'darwin' ? ['-n', '-i', String(seconds), '-W', String(LATE_MS), address] : ['-n', '-i', String(seconds), '-W', '1', address]
    const proc = track(spawn(platform === 'darwin' ? '/sbin/ping' : 'ping', args, {stdio: ['ignore', 'pipe', 'ignore']}), 'ping ' + t)
    const parser = createPingParser({interval, onProbe})
    const startedAt = now()
    lines(proc, (line) => parser.line(line, now()))
    proc.parsers = [parser]
    proc.on('exit', (code) => {
      procs = procs.filter((p) => p !== proc)
      if (!running || !wanted()) return
      const name = t.startsWith('p:') ? 'peer' : t
      if (interval === INTERVAL_MS && now() - startedAt < 3000) {
        record('network', 'probe-fallback', {t: name, every: 1000, code})
        const next = startPing(t, address, 1000, onProbe, wanted)
        const peer = t.startsWith('p:') && active.get(t.slice(2))
        if (peer) peer.proc = next
      } else record('network', 'probe-failed', {name: 'ping ' + name, code}, 'warn')
    })
    return proc
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
        applyPeers()
      } catch (error) {
        record('network', 'probe-failed', {message: error.message}, 'warn')
      }
    },
    stop() {
      running = false
      for (const id of [...active.keys()]) dropPeer(id)
      clearInterval(ticker)
      ticker = null
      for (const proc of procs) try { proc.kill() } catch {}
      procs = []
      helper = null
      stats.take()
    },
    take: () => stats.take(),
    // [{peer, address}] from the renderer: anything that isn't a peer id and an IPv4 literal is left
    // out (an IPv6 or mDNS candidate), at most PEER_SLOTS.
    setPeers(list) {
      const next = new Map()
      for (const item of Array.isArray(list) ? list : []) {
        if (next.size >= PEER_SLOTS) break
        if (typeof item?.peer === 'string' && /^[\w-]{1,64}$/.test(item.peer) && isIPv4(item.address)) next.set(item.peer, item.address)
      }
      wanted = next
      applyPeers()
    },
    // The renderer saw a connection struggle (loss, a long round trip, ICE disconnected).
    trouble(peer, why = 'trouble') {
      return trace(String(peer), ['loss', 'rtt', 'quiet', 'disconnected', 'feedback'].includes(why) ? why : 'trouble')
    },
  }
}

module.exports = {INTERVAL_MS, LATE_MS, STALL_MS, PEER_SLOTS, TRACE_EVERY_MS, addressKind, createNetProbe, createPingParser, createProbeStats, hopEntry, hopHash, isIPv4, parseRoute, parseTraceroute}
