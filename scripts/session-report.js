'use strict'

// The reader of the diagnostic archive that answers "how did that session go" and "is this version
// better than the last": `npm run diagnostics -- --report [username] [day]` and `-- --compare [username] [day]`.
//
// The first half is pure (text in, text out) and unit-tested against a fixed sample log
// (test/report.test.js, test/fixtures/report/). The second half finds the files (the archive that
// scripts/diagnostics.js unpacks to work/diagnostics/<username>/<day>.log) and prints.
//
// What a log line looks like is in CLAUDE.md ("Diagnostic log", "Log measurements"). The rules this
// file follows, so older logs read cleanly:
//   * A field that is absent means "not measured" (logs from 0.8.0 and before lack the M1.2 fields).
//     It prints as "–" and never counts as zero; nothing here divides by a missing or zero count.
//   * Only samples taken while the host was playing count towards a session's numbers.
//   * Every number printed went through `finite`, so NaN and Infinity cannot reach the output.

const fs = require('node:fs')
const path = require('node:path')

const SAMPLE_S = 2 // seconds between samples (TELEMETRY_INTERVAL_MS in the app)
const SESSION_GAP_MS = 180_000 // silence in one room longer than this ends a session (a crash leaves no leave line)
const PAIR_SLACK_MS = 15_000 // two people's sessions in one room count as one when their clocks overlap this closely
const DASH = '–'
const DAY = /^\d{4}-\d{2}-\d{2}$/

// ---------- small numeric helpers ----------

const finite = (v) => typeof v === 'number' && Number.isFinite(v)
const nums = (list) => list.filter(finite)
const sum = (list) => nums(list).reduce((a, b) => a + b, 0)
const maxOf = (list) => nums(list).reduce((a, b) => (a === null || b > a ? b : a), null)

function median(list) {
  const a = nums(list).sort((x, y) => x - y)
  if (!a.length) return null
  const mid = a.length >> 1
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2
}

const mean = (list) => {
  const a = nums(list)
  return a.length ? sum(a) / a.length : null
}

// ---------- reading a log ----------

// One person's day file → entries {d: the log line, at: ms, user, folder, version}. The version is the
// one in force at that point of the file: each upload begins with a `# upload {...}` comment that names
// the build, and the main process writes `app/launch` with it at every start.
function parseLog(text, folder) {
  const entries = []
  let version = null
  let user = folder
  for (const raw of String(text).split('\n')) {
    if (raw.startsWith('# upload ')) {
      try {
        const meta = JSON.parse(raw.slice(9))
        if (meta?.version) version = String(meta.version)
        if (meta?.from) user = String(meta.from)
      } catch {}
      continue
    }
    if (raw[0] !== '{') continue
    let d
    try { d = JSON.parse(raw) } catch { continue }
    if (!d || typeof d !== 'object' || Array.isArray(d)) continue
    const at = Date.parse(d.t)
    if (!Number.isFinite(at)) continue
    if (d.sc === 'app' && d.ev === 'launch' && typeof d.version === 'string') version = d.version
    entries.push({d, at, user, folder, version: version || 'unknown'})
  }
  return entries
}

const mostCommon = (list) => {
  const counts = new Map()
  for (const item of list) if (item != null) counts.set(item, (counts.get(item) || 0) + 1)
  let best = null
  for (const [item, n] of counts) if (best === null || n > best[1]) best = [item, n]
  return best && best[0]
}

// A person's entries → their room visits. A visit ends at `room/leave`, when the room changes, or when
// the room goes quiet for SESSION_GAP_MS (a crash writes no leave line); `room/entered` starts a new one.
function buildSessions(entries) {
  const sorted = entries.map((e, i) => [e, i]).sort((a, b) => a[0].at - b[0].at || a[1] - b[1]).map(([e]) => e)
  const sessions = []
  let current = null
  const finish = () => {
    if (!current) return
    current.self = mostCommon(current.entries.map((e) => e.d.self)) || null
    current.version = current.entries[0].version
    sessions.push(current)
    current = null
  }
  for (const e of sorted) {
    const room = e.d.room
    if (!room) continue
    const entered = e.d.sc === 'room' && e.d.ev === 'entered'
    if (current && (current.room !== room || e.at - current.end > SESSION_GAP_MS || (entered && current.entries.some((x) => x.d.sc !== 'room')))) finish()
    if (!current) current = {user: e.user, folder: e.folder, room, start: e.at, end: e.at, entries: []}
    current.entries.push(e)
    current.end = Math.max(current.end, e.at)
    if (e.d.sc === 'room' && e.d.ev === 'leave') finish()
  }
  finish()
  return sessions
}

// Everyone's sessions → one group per room and stretch of time, so a host's file and its viewers' files
// of the same watch session are read together.
function groupSessions(sessions) {
  const byRoom = new Map()
  for (const s of sessions) byRoom.set(s.room, [...(byRoom.get(s.room) || []), s])
  const groups = []
  for (const [room, list] of byRoom) {
    list.sort((a, b) => a.start - b.start)
    let group = null
    for (const s of list) {
      if (group && s.start <= group.end + PAIR_SLACK_MS) {
        group.sessions.push(s)
        group.end = Math.max(group.end, s.end)
      } else {
        group = {room, start: s.start, end: s.end, sessions: [s]}
        groups.push(group)
      }
    }
  }
  return groups.sort((a, b) => a.start - b.start || (a.room < b.room ? -1 : 1))
}

// ---------- the measurements ----------

const playing = (d) => (d.playback ? d.playback.playing !== false : true)

// What a viewer experienced, from its viewer-sample lines (or, with no log of its own, from what the
// host logged of the viewer's reports). Anything the lines lack stays null.
function viewerMetrics(lines) {
  const p = lines.filter(playing)
  const n = p.length
  const out = {n, seconds: n * SAMPLE_S}
  out.rtt = {median: median(p.map((d) => d.rttMs)), worst: maxOf(p.map((d) => d.rttMs))}
  out.loss = {avg: mean(p.map((d) => d.lossPct)), worst: maxOf(p.map((d) => d.lossPct))}

  const withFrz = p.filter((d) => finite(d.v?.frz))
  if (withFrz.length) out.frozen = {pct: Math.min(100, (100 * sum(withFrz.map((d) => d.v.frz))) / (withFrz.length * SAMPLE_S * 1000)), by: 'time'}
  else if (p.some((d) => finite(d.freezes))) out.frozen = {pct: (100 * p.filter((d) => d.freezes > 0).length) / p.length, by: 'ticks'}
  else out.frozen = null

  const audio = p.filter((d) => finite(d.a?.conc) && finite(d.a?.smp))
  const samples = sum(audio.map((d) => d.a.smp))
  out.concealed = samples > 0 ? Math.min(100, (100 * sum(audio.map((d) => d.a.conc))) / samples) : null

  // A/V offset, positive = the sound is behind the picture. `s.av` (the difference of the two tracks'
  // estimated playout clocks) when logged; otherwise the audio path's delay (jitter buffer + media
  // playout + Web Audio output latency) minus the video's jitter buffer.
  const offsets = []
  const methods = new Set()
  for (const d of p) {
    if (finite(d.s?.av)) { offsets.push(d.s.av); methods.add('av') }
    else if (finite(d.s?.aJb) && finite(d.s?.vJb)) {
      offsets.push(d.s.aJb + (finite(d.s.aPlay) ? d.s.aPlay : 0) + (finite(d.s.out) ? d.s.out : 0) - d.s.vJb)
      methods.add('delay')
    }
  }
  out.av = offsets.length ? {ms: median(offsets), method: [...methods].sort().join('+'), n: offsets.length} : null

  out.videoRx = median(p.map((d) => d.receivedBitrateBps))
  out.audioRx = median(p.map((d) => d.audioReceivedBitrateBps))
  out.decode = {median: median(p.map((d) => d.v?.dec)), worst: maxOf(p.map((d) => d.v?.dec))}
  return out
}

// What the host did for one viewer (or for all of them): encoder cost, the bitrate it aimed for, and
// what the quality ladder decided. `changes` are the send-quality-change lines.
function hostMetrics(lines, changes = []) {
  const p = lines.filter(playing)
  const out = {n: p.length, seconds: p.length * SAMPLE_S}
  out.encode = {median: median(p.map((d) => d.e?.enc)), worst: maxOf(p.map((d) => d.e?.enc))}
  out.videoTarget = median(p.map((d) => d.bitrate))
  const ab = mostCommon(p.map((d) => d.set?.ab).filter(finite))
  out.audioTarget = ab
  const limited = p.filter((d) => finite(d.e?.cpu) || finite(d.e?.bw))
  out.limited = limited.length ? {
    cpu: Math.min(100, (100 * sum(limited.map((d) => d.e.cpu))) / (limited.length * SAMPLE_S * 1000)),
    bandwidth: Math.min(100, (100 * sum(limited.map((d) => d.e.bw))) / (limited.length * SAMPLE_S * 1000)),
  } : null
  const decisions = new Map()
  for (const d of lines) if (typeof d.decision === 'string') decisions.set(d.decision, (decisions.get(d.decision) || 0) + 1)
  out.decisions = [...decisions].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
  const moves = changes.filter((c) => finite(c.from) && finite(c.to))
  const reasons = new Map()
  for (const c of moves) {
    const key = `${c.to > c.from ? 'up' : 'down'}:${typeof c.reason === 'string' ? c.reason : '?'}`
    reasons.set(key, (reasons.get(key) || 0) + 1)
  }
  out.changes = {
    up: moves.filter((c) => c.to > c.from).length,
    down: moves.filter((c) => c.to < c.from).length,
    reasons: [...reasons].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)),
  }
  const targets = nums(p.map((d) => d.bitrate))
  out.targetRange = targets.length ? [Math.min(...targets), Math.max(...targets)] : null
  return out
}

// Whole-computer CPU, from machine-sample's per-process [cpu% of one core, MB]: the busiest tick.
const CPU_KEYS = [['r', 'renderer'], ['g', 'gpu'], ['m', 'main'], ['o', 'other']]
function cpuMetrics(lines) {
  let best = null
  for (const d of lines) {
    const parts = CPU_KEYS.map(([key, name]) => [name, d.p?.[key]?.[0]]).filter(([, v]) => finite(v))
    if (!parts.length) continue
    const total = sum(parts.map(([, v]) => v))
    if (!best || total > best.peak) best = {peak: total, parts}
  }
  return best
}

// ---------- scoring one watch session ----------

function scoreGroup(group) {
  const sessions = group.sessions
  const names = new Map() // transport peer id → username
  for (const s of sessions) if (s.self) names.set(s.self, s.user)
  for (const s of sessions) {
    for (const e of s.entries) {
      if (e.d.sc === 'peer' && e.d.ev === 'join' && e.d.peer && typeof e.d.username === 'string' && !names.has(e.d.peer)) names.set(e.d.peer, e.d.username)
    }
  }
  const pairs = new Map()
  const pair = (host, viewer) => {
    const key = `${host}\u0000${viewer}`
    if (!pairs.has(key)) pairs.set(key, {host, viewer, viewerLines: [], hostLines: [], changes: [], viewerSession: null, hostSession: null})
    return pairs.get(key)
  }
  for (const s of sessions) {
    const me = s.self || s.user
    for (const {d} of s.entries) {
      if (d.sc !== 'telemetry' && d.sc !== 'machine') continue
      if (d.ev === 'viewer-sample' && d.host) {
        const x = pair(d.host, d.self || me)
        x.viewerLines.push(d)
        x.viewerSession = s
      } else if (d.ev === 'host-sample' && d.peer) {
        const x = pair(d.self || me, d.peer)
        x.hostLines.push(d)
        x.hostSession = s
      } else if (d.ev === 'send-quality-change' && d.peer) {
        pair(d.self || me, d.peer).changes.push(d)
      }
    }
  }
  const nameOf = (id) => names.get(id) || String(id).slice(0, 8)
  const machineOf = (s, role) => cpuMetrics(s.entries.filter((e) => e.d.ev === 'machine-sample' && (!e.d.role || e.d.role === role)).map((e) => e.d))
  const hostIds = new Set([...pairs.values()].map((x) => x.host))
  const people = sessions.map((s) => {
    const id = s.self || s.user
    return {user: s.user, version: s.version, hosting: hostIds.has(id), cpuHost: machineOf(s, 'host'), cpuViewer: machineOf(s, 'viewer')}
  })
  const rows = [...pairs.values()].map((x) => {
    const own = x.viewerLines.length > 0
    // Without the viewer's own log, what the host recorded of the viewer's reports stands in for it.
    const stand = x.hostLines.map((d) => ({rttMs: d.rttMs, lossPct: d.receiver?.lossPct, freezes: d.receiver?.freezes, playback: d.playback}))
    const viewer = viewerMetrics(own ? x.viewerLines : stand)
    const host = hostMetrics(x.hostLines, x.changes)
    // The host's own round-trip reading fills in when the viewer's is missing.
    if (viewer.rtt.median == null && x.hostLines.length) viewer.rtt = {median: median(x.hostLines.filter(playing).map((d) => d.rttMs)), worst: maxOf(x.hostLines.filter(playing).map((d) => d.rttMs))}
    return {
      hostName: nameOf(x.host), viewerName: nameOf(x.viewer),
      hostVersion: x.hostSession?.version || null, viewerVersion: x.viewerSession?.version || null,
      sources: {viewerLog: own, hostLog: x.hostLines.length > 0},
      viewer, host,
      viewerCpu: x.viewerSession ? machineOf(x.viewerSession, 'viewer') : null,
    }
  }).sort((a, b) => (a.hostName < b.hostName ? -1 : a.hostName > b.hostName ? 1 : a.viewerName < b.viewerName ? -1 : a.viewerName > b.viewerName ? 1 : 0))
  return {room: group.room, start: group.start, end: group.end, people, rows}
}

// ---------- printing ----------

const pad = (n) => String(n).padStart(2, '0')
const stamp = (at) => new Date(at).toISOString().replace('T', ' ').slice(0, 19)
const clockOf = (at) => new Date(at).toISOString().slice(11, 19)
const duration = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s >= 3600 ? `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m` : s >= 60 ? `${Math.floor(s / 60)}m ${pad(s % 60)}s` : `${s}s`
}

const fixed = (v, digits = 1) => (finite(v) ? v.toFixed(digits) : DASH)
const ms = (v) => (finite(v) ? `${Math.round(v)} ms` : DASH)
const ms1 = (v) => (finite(v) ? `${v.toFixed(1)} ms` : DASH)
const pct = (v, digits = 1) => (finite(v) ? `${v.toFixed(digits)}%` : DASH)
const bps = (v) => (!finite(v) ? DASH : v >= 1e6 ? `${(v / 1e6).toFixed(2)} Mbps` : `${Math.round(v / 1e3)} kbps`)
const signed = (v) => (finite(v) ? `${v > 0 ? '+' : ''}${Math.round(v)} ms` : DASH)
const pair2 = (a, b, format) => (finite(a) || finite(b) ? `${format(a)} / ${format(b)}` : DASH)

function cpuText(cpu) {
  if (!cpu) return DASH
  return `${Math.round(cpu.peak)}% of one core (${cpu.parts.map(([name, v]) => `${name} ${Math.round(v)}`).join(', ')})`
}

function decisionsText(h) {
  const moves = h.changes.up + h.changes.down
  const parts = []
  if (h.n || h.decisions.length) {
    parts.push(moves ? `${moves} bitrate change${moves === 1 ? '' : 's'} (${h.changes.up} up, ${h.changes.down} down)` : 'no bitrate changes')
    if (h.changes.reasons.length) parts.push(h.changes.reasons.slice(0, 5).map(([k, n]) => `${k.replace(':', ' ')} x${n}`).join(', '))
    if (h.targetRange) parts.push(`target ${bps(h.targetRange[0])}-${bps(h.targetRange[1])}`)
  }
  return parts.length ? parts.join('; ') : DASH
}

function formatGroup(score) {
  const out = []
  const names = new Set([...score.people.map((p) => p.user), ...score.rows.flatMap((r) => [r.hostName, r.viewerName])])
  out.push(`Room ${score.room}   ${stamp(score.start)} to ${clockOf(score.end)} UTC (${duration(score.end - score.start)}), ${names.size} ${names.size === 1 ? 'person' : 'people'}`)
  for (const p of score.people) {
    out.push(`  ${p.hosting ? 'Host  ' : 'Viewer'} ${p.user} (${p.version || 'unknown'})${p.hosting ? `   CPU peak ${cpuText(p.cpuHost)}` : ''}`)
  }
  if (!score.rows.length) out.push('  No host or viewer samples in this session (nobody was playing, or the logs are missing).')
  const used = new Set()
  for (const r of score.rows) {
    const v = r.viewer
    const h = r.host
    const source = r.sources.viewerLog ? (r.sources.hostLog ? "viewer's log + host's log" : "viewer's log only") : "host's log only (viewer's log missing)"
    out.push('')
    out.push(`  ${r.viewerName} watching ${r.hostName}   [${source}; ${v.n} playing samples = ${duration(v.seconds * 1000)}]`)
    const line = (label, text) => out.push(`    ${label.padEnd(18)}${text}`)
    line('RTT', `typical ${ms(v.rtt.median)}, worst ${ms(v.rtt.worst)}`)
    line('Loss', `average ${pct(v.loss.avg, 2)}, worst ${pct(v.loss.worst, 1)} (video, per 2s)`)
    line('Frozen', v.frozen ? (v.frozen.by === 'ticks' ? `~${pct(v.frozen.pct)} (of samples with a freeze; no freeze durations in this log)` : `${pct(v.frozen.pct)} of playing time`) : DASH)
    line('Audio concealed', pct(v.concealed, 2))
    if (v.av) { used.add(v.av.method); line('A/V offset', `${signed(v.av.ms)}   [${v.av.method}]`) } else line('A/V offset', DASH)
    line('Video bitrate', `received ${bps(v.videoRx)} / target ${bps(h.videoTarget)}`)
    line('Audio bitrate', `received ${bps(v.audioRx)} / target ${bps(h.audioTarget)}`)
    line('Encode / decode', `encode ${pair2(h.encode.median, h.encode.worst, ms1)} (typical / worst), decode ${pair2(v.decode.median, v.decode.worst, ms1)}`)
    line('Encoder limited', h.limited ? `by cpu ${pct(h.limited.cpu)}, by bandwidth ${pct(h.limited.bandwidth)} of time` : DASH)
    line('CPU peak', `viewer ${cpuText(r.viewerCpu)}`)
    line('Quality decisions', decisionsText(h))
    if (h.decisions.length) line('  per sample', h.decisions.slice(0, 6).map(([k, n]) => `${k} ${n}`).join(', '))
  }
  if (used.size) {
    out.push('')
    out.push('  A/V offset: positive = sound behind the picture; an estimate. [av] = difference of the two tracks\' estimated playout clocks (s.av);')
    out.push('  [delay] = audio jitter buffer + playout + Web Audio output latency, minus video jitter buffer. Audio target = Settings\' audio bitrate.')
  }
  return out.join('\n')
}

function formatReport(scores) {
  return scores.map(formatGroup).join('\n\n')
}

// ---------- comparing versions ----------

const versionKey = (v) => String(v).split(/[.\-+]/).map((part) => (/^\d+$/.test(part) ? Number(part) : -1))
function compareVersions(a, b) {
  const x = versionKey(a)
  const y = versionKey(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d) return d
  }
  return a < b ? -1 : a > b ? 1 : 0
}

// Sessions → one pool of samples per app version. Each side's numbers come from the log of the build
// that was running on that side: viewer-side from viewers' own files, host-side and targets from hosts'.
function poolByVersion(sessions) {
  const pools = new Map()
  const pool = (version) => {
    if (!pools.has(version)) pools.set(version, {version, sessions: 0, viewer: [], host: [], changes: [], cpuViewer: [], cpuHost: []})
    return pools.get(version)
  }
  for (const s of sessions) {
    const x = pool(s.version || 'unknown')
    x.sessions += 1
    for (const {d} of s.entries) {
      if (d.ev === 'viewer-sample' && d.sc === 'telemetry') x.viewer.push(d)
      else if (d.ev === 'host-sample' && d.sc === 'telemetry') x.host.push(d)
      else if (d.ev === 'send-quality-change' && d.sc === 'telemetry') x.changes.push(d)
      else if (d.ev === 'machine-sample' && d.sc === 'telemetry') (d.role === 'host' ? x.cpuHost : x.cpuViewer).push(d)
    }
  }
  return [...pools.values()].sort((a, b) => compareVersions(a.version, b.version))
}

// Rows of the comparison table. `value` is what the better/worse verdict looks at; `eps` is the change
// too small to call (in the row's own unit), `low` that smaller is better.
function compareRows(pool) {
  const v = viewerMetrics(pool.viewer)
  const h = hostMetrics(pool.host, pool.changes)
  const hours = h.seconds / 3600
  const cpuV = cpuMetrics(pool.cpuViewer)
  const cpuH = cpuMetrics(pool.cpuHost)
  const ratio = (got, want) => (finite(got) && finite(want) && want > 0 ? (100 * got) / want : null)
  return {
    sessions: String(pool.sessions),
    viewing: duration(v.seconds * 1000),
    hosting: duration(h.seconds * 1000),
    rows: [
      {label: 'RTT typical / worst', text: pair2(v.rtt.median, v.rtt.worst, ms), value: v.rtt.median, low: true, eps: 5},
      {label: 'Loss avg / worst', text: pair2(v.loss.avg, v.loss.worst, (x) => pct(x, 2)), value: v.loss.avg, low: true, eps: 0.2},
      {label: 'Frozen', text: v.frozen ? `${v.frozen.by === 'ticks' ? '~' : ''}${pct(v.frozen.pct)}` : DASH, value: v.frozen?.pct, low: true, eps: 0.2},
      {label: 'Audio concealed', text: pct(v.concealed, 2), value: v.concealed, low: true, eps: 0.2},
      {label: 'A/V offset', text: v.av ? signed(v.av.ms) : DASH, value: v.av ? Math.abs(v.av.ms) : null, low: true, eps: 10},
      {label: 'Video received', text: bps(v.videoRx), value: null},
      {label: 'Video target', text: bps(h.videoTarget), value: null},
      {label: 'Video recv/target', text: pct(ratio(v.videoRx, h.videoTarget), 0), value: ratio(v.videoRx, h.videoTarget), low: false, eps: 5},
      {label: 'Audio received', text: bps(v.audioRx), value: null},
      {label: 'Audio target', text: bps(h.audioTarget), value: null},
      {label: 'Encode typical / worst', text: pair2(h.encode.median, h.encode.worst, ms1), value: h.encode.median, low: true, eps: 0.5},
      {label: 'Decode typical / worst', text: pair2(v.decode.median, v.decode.worst, ms1), value: v.decode.median, low: true, eps: 0.5},
      {label: 'CPU peak (viewer)', text: cpuV ? `${Math.round(cpuV.peak)}%` : DASH, value: cpuV?.peak, low: true, eps: 10},
      {label: 'CPU peak (host)', text: cpuH ? `${Math.round(cpuH.peak)}%` : DASH, value: cpuH?.peak, low: true, eps: 10},
      {label: 'Bitrate cuts / viewer-hour', text: hours > 0 ? fixed(h.changes.down / hours, 1) : DASH, value: hours > 0 ? h.changes.down / hours : null, low: true, eps: 0.5},
      {label: 'Bitrate raises / viewer-hour', text: hours > 0 ? fixed(h.changes.up / hours, 1) : DASH, value: null},
    ],
  }
}

// Newest build against the one before it. Smaller than both `eps` and 10% of the old value is "same".
function verdict(row, before, after) {
  if (row.value === null || !finite(before) || !finite(after)) return DASH
  const move = after - before
  if (Math.abs(move) <= Math.max(row.eps, Math.abs(before) * 0.1)) return 'same'
  return (move < 0) === row.low ? 'better' : 'worse'
}

function formatCompare(sessions) {
  const pools = poolByVersion(sessions).map((pool) => ({pool, table: compareRows(pool)}))
  if (!pools.length) return 'No sessions found.'
  const labels = ['Logged sessions', 'Viewer time playing', 'Host time (per viewer)', ...pools[0].table.rows.map((r) => r.label)]
  const columns = pools.map(({pool, table}) => [pool.version, table.sessions, table.viewing, table.hosting, ...table.rows.map((r) => r.text)])
  const last = pools.at(-1)
  const prior = pools.length > 1 ? pools.at(-2) : null
  const verdicts = prior
    ? ['', '', '', '', ...last.table.rows.map((r, i) => verdict(r, prior.table.rows[i].value, r.value))].map((x, i) => (i === 0 ? `${last.pool.version} vs ${prior.pool.version}` : x))
    : null
  if (verdicts) columns.push(verdicts)
  const widths = columns.map((col) => Math.max(...col.map((c) => c.length)))
  const labelWidth = Math.max(...labels.map((l) => l.length), 0)
  const lines = [`${' '.repeat(labelWidth)}  ${columns.map((col, i) => col[0].padEnd(widths[i])).join('  ')}`.trimEnd()]
  labels.forEach((label, row) => {
    lines.push(`${label.padEnd(labelWidth)}  ${columns.map((col, i) => col[row + 1].padEnd(widths[i])).join('  ')}`.trimEnd())
  })
  lines.push('')
  lines.push('Each column pools every sample logged by that build. Viewer rows come from viewers\' logs, encode/targets/bitrate cuts from hosts\' logs.')
  lines.push('Last column: newest build against the one before it ("same" = change under 10% and under a small fixed amount). Rows without a verdict are not judged (bitrates). "–" = not measured by that build.')
  return lines.join('\n')
}

// ---------- finding the files and printing ----------

function parseArgs(args) {
  const options = {mode: null, user: '', day: null, dir: null, fetch: true, errors: []}
  const rest = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--report') options.mode = options.mode || 'report'
    else if (arg === '--compare') options.mode = options.mode || 'compare'
    else if (arg === '--dir') { options.dir = args[++i] || null; options.fetch = false }
    else if (arg === '--no-fetch') options.fetch = false
    else if (arg.startsWith('--')) options.errors.push(`Unknown option ${arg}`)
    else rest.push(arg)
  }
  for (const arg of rest) {
    if (DAY.test(arg) || arg === 'all') options.day = arg
    else if (!options.user) options.user = arg.toLowerCase()
    else options.errors.push(`Unexpected argument ${arg}`)
  }
  return options
}

const list = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [])
const shiftDay = (day, by) => new Date(Date.parse(`${day}T00:00:00Z`) + by * 86400000).toISOString().slice(0, 10)

// Loads work/diagnostics: every person's day files (a session is paired with other people's, so the
// username filter is applied after pairing), restricted to the day and its neighbours when one is asked for.
function loadEntries(dir, day) {
  const days = new Set()
  const files = []
  for (const folder of list(dir)) {
    if (!fs.statSync(path.join(dir, folder)).isDirectory()) continue
    for (const name of list(path.join(dir, folder))) {
      if (!name.endsWith('.log')) continue
      const fileDay = name.slice(0, -4)
      days.add(fileDay)
      files.push({folder, fileDay, file: path.join(dir, folder, name)})
    }
  }
  const sorted = [...days].sort()
  const chosen = day === 'all' ? null : day || sorted.at(-1) || null
  const near = chosen ? new Set([shiftDay(chosen, -1), chosen, shiftDay(chosen, 1)]) : null
  const byFolder = new Map()
  for (const f of files) {
    if (near && !near.has(f.fileDay)) continue
    byFolder.set(f.folder, [...(byFolder.get(f.folder) || []), ...parseLog(fs.readFileSync(f.file, 'utf8'), f.folder)])
  }
  return {byFolder, chosen, days: sorted}
}

function selectGroups(byFolder, {user, chosen}) {
  const sessions = [...byFolder.values()].flatMap((entries) => buildSessions(entries))
  const groups = groupSessions(sessions).filter((g) => {
    if (user && !g.sessions.some((s) => s.folder.startsWith(user) || s.user.toLowerCase().startsWith(user))) return false
    if (!chosen) return true
    return new Date(g.start).toISOString().slice(0, 10) === chosen || new Date(g.end).toISOString().slice(0, 10) === chosen
  })
  return groups
}

function selectSessions(byFolder, {user, chosen}) {
  return [...byFolder.values()].flatMap((entries) => buildSessions(entries)).filter((s) => {
    if (user && !(s.folder.startsWith(user) || s.user.toLowerCase().startsWith(user))) return false
    if (!chosen) return true
    return new Date(s.start).toISOString().slice(0, 10) === chosen || new Date(s.end).toISOString().slice(0, 10) === chosen
  })
}

// `fetchArchive` (scripts/diagnostics.js) pulls and unpacks the archive; it is skipped for --dir / --no-fetch.
function run(args, {fetchArchive = null, defaultDir, out = (text) => console.log(text), err = (text) => console.error(text)} = {}) {
  const options = parseArgs(args)
  if (options.errors.length) { err(options.errors.join('\n')); return 1 }
  const dir = options.dir ? path.resolve(options.dir) : defaultDir
  if (options.fetch && fetchArchive) {
    try { fetchArchive() } catch (error) {
      if (!fs.existsSync(dir)) { err(error.message); return 1 }
      err(`${error.message}\nUsing the files already in ${dir}.`)
    }
  }
  if (!fs.existsSync(dir) || !list(dir).length) { err(`No telemetry files in ${dir}. Run \`npm run diagnostics\` first.`); return 1 }
  // The comparison is across days by default; a single report is for the newest day.
  const wantedDay = options.mode === 'compare' && !options.day ? 'all' : options.day
  const {byFolder, chosen, days} = loadEntries(dir, wantedDay)
  if (options.mode === 'compare') {
    const sessions = selectSessions(byFolder, {user: options.user, chosen})
    out(`Comparison by app version${options.user ? ` for ${options.user}*` : ''}, ${chosen ? `day ${chosen}` : `all ${days.length} day${days.length === 1 ? '' : 's'}`}, ${sessions.length} session${sessions.length === 1 ? '' : 's'}\n`)
    out(formatCompare(sessions))
    return 0
  }
  const groups = selectGroups(byFolder, {user: options.user, chosen})
  if (!groups.length) {
    out(`No sessions${options.user ? ` for ${options.user}*` : ''} on ${chosen || 'any day'}. Days with telemetry: ${days.slice(-8).join(', ') || 'none'}.`)
    return 0
  }
  out(`Session report, ${chosen ? `day ${chosen}` : 'all days'}${options.user ? `, ${options.user}*` : ''}${!options.day && chosen ? ' (newest day; give a day or "all" for others)' : ''}\n`)
  out(formatReport(groups.map(scoreGroup)))
  return 0
}

module.exports = {
  buildSessions, compareVersions, cpuMetrics, formatCompare, formatGroup, formatReport, groupSessions, hostMetrics,
  loadEntries, parseArgs, parseLog, poolByVersion, run, scoreGroup, selectGroups, selectSessions, verdict, viewerMetrics,
}
