'use strict'

// "Where on the path did it break?" (M1.13), the pure half. scripts/bottleneck.js says whose link or
// computer was full; this reads the net probe (main/net-probe.js) to say where between the two homes the
// trouble sat: one person's own home network (their router answered slowly), their internet provider
// (the router was fine, 1.1.1.1 was not), the route between the two homes (pings to each other went bad
// while both homes were fine; a traceroute shows from which hop), or the video flow alone (pings to each
// other stayed clean while the video struggled, so the route carried small packets fine and only the
// stream was queued or policed). The route's own ICE counters (`cp`) add which direction broke.
// scripts/session-report.js collects the series and prints the line; test/path-verdict.test.js checks it.

const NEAR_MS = 3500 // the same window bottleneck.js uses
const CALM_MS = 8000
const SLOW_MS = 150 // a probe this slow is part of a stall (STALL_MS in main/net-probe.js)
const WORST_MS = 500
const LOST_SHARE = 0.1 // a tenth of the probes in a sample lost
const PEER_RISE_MS = 40 // pings to the other person grew by this much...
const PEER_RISE_RATIO = 1.5 // ...and this fraction over their calm self
const HOP_RISE_MS = 40
const QUEUE_MS = 1000 // a one-way delay this long is trouble even without loss
const QUIET_MS = 2000 // nothing arrived on the route for this long

const finite = (v) => typeof v === 'number' && Number.isFinite(v)

function median(list) {
  const a = list.filter(finite).sort((x, y) => x - y)
  if (!a.length) return null
  const mid = a.length >> 1
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2
}

// One probe summary {n, lost?, avg?, max?} from a 2s machine-sample: slow or lossy?
function probeBad(s, base = null) {
  if (!s || !finite(s.n) || s.n <= 0) return null
  if ((s.lost || 0) / s.n >= LOST_SHARE) return true
  if (!finite(s.avg)) return Boolean(s.lost)
  if (finite(base)) return (s.avg - base >= PEER_RISE_MS && s.avg >= base * PEER_RISE_RATIO) || s.max >= WORST_MS + base
  return s.avg >= SLOW_MS || s.max >= WORST_MS
}

const nearAny = (at, times, within) => times.some((t) => Math.abs(at - t) <= within)
const farFromAll = (at, times) => times.every((t) => Math.abs(at - t) > CALM_MS)

// Share of the troubled-time samples in which a probe was bad: {bad, n} or null when never measured.
function share(points, times, pick, base) {
  const near = points.filter((p) => finite(p.at) && nearAny(p.at, times, NEAR_MS))
  const judged = near.map((p) => probeBad(pick(p), base)).filter((v) => v !== null)
  return judged.length ? {bad: judged.filter(Boolean).length, n: judged.length} : null
}
const mostlyBad = (s) => Boolean(s) && s.bad * 2 >= s.n && s.bad > 0

// The traceroute taken during trouble against the baseline one from the start of the visit.
// hops are [ms|null, kind, hash] (main/net-probe.js hopEntry); returns a sentence or null.
const KIND = {l: 'inside a home network', c: "an internet provider's shared address range", p: 'on the internet'}
function traceText(traces, who, other) {
  const list = (traces || []).filter((t) => t && Array.isArray(t.hops))
  const trouble = [...list].reverse().find((t) => t.why !== 'baseline')
  if (!trouble) return null
  const baseline = list.find((t) => t.why === 'baseline')
  const hops = trouble.hops
  const total = hops.length
  const where = (i) => `hop ${i + 1} of ${total}${hops[i]?.[1] && KIND[hops[i][1]] ? ` (${KIND[hops[i][1]]})` : ''}`
  const answered = hops.map((h, i) => (finite(h?.[0]) ? i : -1)).filter((i) => i >= 0)
  if (!answered.length) return `${who}'s traceroute to ${other} got no answers at all during the trouble`
  if (baseline) {
    const raised = (i) => {
      const b = baseline.hops[i]?.[0]
      const t = hops[i]?.[0]
      if (!finite(t)) return finite(b) ? true : null
      return finite(b) ? t - b >= HOP_RISE_MS : null
    }
    // The first hop from which every hop that can be compared is slower (or now silent) than at the start.
    for (let i = 0; i < total; i++) {
      const rest = hops.slice(i).map((_, k) => raised(i + k)).filter((v) => v !== null)
      if (rest.length && rest.every(Boolean) && raised(i)) {
        const b = baseline.hops[i]?.[0]
        const t = hops[i]?.[0]
        return `${who}'s traceroute to ${other}: the delay starts at ${where(i)}${finite(b) ? `, ${Math.round(b)} -> ${finite(t) ? `${Math.round(t)} ms` : 'no answer'}` : ''}`
      }
    }
  }
  if (!trouble.reached) {
    const last = answered[answered.length - 1]
    return `${who}'s traceroute to ${other} stopped getting answers after ${where(last)}`
  }
  const slow = answered.find((i) => answered.filter((k) => k >= i).every((k) => hops[k][0] >= SLOW_MS))
  if (slow !== undefined) return `${who}'s traceroute to ${other}: slow from ${where(slow)} on (${Math.round(hops[slow][0])} ms)`
  return `${who}'s traceroute to ${other} reached them with no slow hop${baseline ? ' compared with the start of the visit' : ''}`
}

/**
 * @param {object} input
 *   times: [ms] troubled moments (bottleneck.js troubleTimes, plus long one-way delays; see extraTrouble)
 *   hostName, viewerName
 *   hostNp, viewerNp: [{at, gw, net, peer}] each side's np from machine-sample, `peer` already the probe
 *     summary for the other person (the host's pings to this viewer, the viewer's to the host)
 *   hostCp, viewerCp: [{at, cp}] the route counters each side logged for the other
 *   hostTraces, viewerTraces: network/trace lines each side logged toward the other, oldest first
 * @returns {{verdict, reasons: string[]} | null} null when there is no trouble or no path data. verdict:
 *   host-home | viewer-home | host-isp | viewer-isp | between | flow | unclear
 */
function diagnosePath(input = {}) {
  const times = (input.times || []).filter(finite)
  const host = input.hostName || 'host'
  const viewer = input.viewerName || 'viewer'
  const hostNp = input.hostNp || []
  const viewerNp = input.viewerNp || []
  const traces = [...(input.hostTraces || []), ...(input.viewerTraces || [])]
  const hasData = hostNp.length || viewerNp.length || traces.length || (input.hostCp || []).length || (input.viewerCp || []).length
  if (!times.length || !hasData) return null

  const reasons = []
  const push = (...texts) => reasons.push(...texts.filter(Boolean))
  const pct = (s) => `${s.bad} of ${s.n} troubled samples`
  const side = (name, np) => ({name, gw: share(np, times, (p) => p.gw), net: share(np, times, (p) => p.net)})
  const sides = [side(host, hostNp), side(viewer, viewerNp)]
  const peerShare = (np) => {
    const base = median(np.filter((p) => finite(p.at) && farFromAll(p.at, times)).map((p) => p.peer?.avg))
    return {s: share(np, times, (p) => p.peer, base), base}
  }
  const hostPeer = peerShare(hostNp)
  const viewerPeer = peerShare(viewerNp)

  // Which direction of the route broke: checks this side sent went unanswered while the other side's arrived.
  const oneWay = (list, from, to) => {
    const near = (list || []).filter((p) => finite(p.at) && p.cp && nearAny(p.at, times, NEAR_MS))
    const broken = near.filter((p) => p.cp.rq > 0 && p.cp.rs === 0 && p.cp.rr > 0).length
    return broken ? `${broken} sample${broken === 1 ? '' : 's'} where ${from}'s connection checks went unanswered while ${to}'s still arrived: the ${from} -> ${to} direction broke` : null
  }
  const directions = [oneWay(input.hostCp, host, viewer), oneWay(input.viewerCp, viewer, host)]
  const traceLines = [traceText(input.hostTraces, host, viewer), traceText(input.viewerTraces, viewer, host)]
  const done = (verdict) => {
    push(...directions)
    return {verdict, reasons}
  }

  const home = sides.find((s) => mostlyBad(s.gw))
  if (home) {
    push(`${home.name}'s router answered slowly or not at all in ${pct(home.gw)}`, home.net ? `1.1.1.1 bad in ${pct(home.net)} too` : null)
    return done(home.name === host ? 'host-home' : 'viewer-home')
  }
  const isp = sides.find((s) => mostlyBad(s.net))
  if (isp) {
    push(`${isp.name}'s router was fine but 1.1.1.1 was slow or lost in ${pct(isp.net)}: past the router, at their internet provider`)
    return done(isp.name === host ? 'host-isp' : 'viewer-isp')
  }
  const homesFine = sides.filter((s) => s.gw || s.net).map((s) => s.name)
  const peerBad = [[host, viewer, hostPeer], [viewer, host, viewerPeer]].filter(([, , p]) => mostlyBad(p.s))
  if (peerBad.length) {
    for (const [from, to, p] of peerBad) push(`${from}'s pings to ${to} went slow or lost in ${pct(p.s)}${finite(p.base) ? ` (calm ${Math.round(p.base)} ms)` : ''}`)
    push(homesFine.length ? `${homesFine.join(' and ')}'s own router and internet stayed clean` : null, ...traceLines)
    return done('between')
  }
  const peerMeasured = [hostPeer.s, viewerPeer.s].filter(Boolean)
  if (peerMeasured.length) {
    push(`pings to each other stayed clean (${peerMeasured.map(pct).join(', ')} bad) while the video struggled: the route carried small packets fine and only the video flow was held up`,
      ...traceLines)
    return done('flow')
  }
  push(homesFine.length ? `${homesFine.join(' and ')}'s own router and internet stayed clean` : null,
    hostNp.length || viewerNp.length ? 'neither side could ping the other (a router that ignores pings)' : null, ...traceLines)
  if (!reasons.length && !directions.some(Boolean)) return null
  return done('unclear')
}

// Moments a path line counts as troubled on top of bottleneck.js's: a one-way delay over a second, or a
// route that went quiet for 2s, even with no loss reported (a queue fills before anything is lost).
function extraTrouble({hv = [], vh = [], hostCp = [], viewerCp = []} = {}) {
  return [
    ...hv.filter((p) => p.ms >= QUEUE_MS), ...vh.filter((p) => p.ms >= QUEUE_MS),
    ...hostCp.filter((p) => p.cp?.quiet >= QUIET_MS), ...viewerCp.filter((p) => p.cp?.quiet >= QUIET_MS),
  ].map((p) => p.at).filter(finite)
}

module.exports = {diagnosePath, extraTrouble, probeBad, traceText}
