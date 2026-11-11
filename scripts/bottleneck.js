'use strict'

// "Whose network is the bottleneck?" (M1.9), the pure half: given the numbers one viewer's session
// logged, say which of five things the evidence points at, and show the numbers behind the answer.
// scripts/session-report.js collects the series and prints the result; test/bottleneck.test.js
// checks every outcome.
//
// The idea. Each app pings the Cloudflare edge every 2 seconds while it is in a room (`er` on the
// machine-sample) and the room's clock offset gives a one-way delay in each direction (`ow.hv`
// host-to-viewer on the viewer's sample, `ow.vh` viewer-to-host on the host's). A link that is full of
// our own video queues everything else on it, so ITS edge RTT climbs while the other person's stays
// flat. That is what tells the host's upload from the viewer's network. A slow computer shows instead
// as an encoder or decoder that cannot keep up while the links stay calm.
//
// Everything is compared against the same person's calm self: "troubled" samples (loss, a freeze, the
// encoder held back by bandwidth or CPU) against samples well away from any trouble, so a link that is
// simply far from Cloudflare is not mistaken for a full one.

const TROUBLE_LOSS_PCT = 2 // the same line the sender's quality ladder uses
const NEAR_MS = 3500 // a sample this close to a troubled one is part of the trouble (two clocks, two seconds apart)
const CALM_MS = 8000 // a sample this far from every troubled one is calm
const MIN_CALM = 3
const EDGE_RISE_MS = 40 // a full link adds at least this much to its edge round trip...
const EDGE_RISE_RATIO = 1.5 // ...and at least this fraction
const QUEUE_RISE_MS = 40 // one-way delay that grew by this much
const CPU_LIMITED_MS = 1000 // of a 2s sample the encoder was held back by CPU / bandwidth
const ENCODE_SLOW_MS = 25
const DECODE_SLOW_MS = 25
const LONG_TASK_MS = 100 // renderer long-task ms per troubled sample (5% of a 2s sample), as a rate: one stray task in a long session is not a slow computer

const finite = (v) => typeof v === 'number' && Number.isFinite(v)
const nums = (list) => list.filter(finite)

function median(list) {
  const a = nums(list).sort((x, y) => x - y)
  if (!a.length) return null
  const mid = a.length >> 1
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2
}

function lowQuantile(list, q = 0.1) {
  const a = nums(list).sort((x, y) => x - y)
  return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * q))] : null
}

// Points {at, value} split into those near trouble and those calm, and what changed between them.
// `base` is the median of the calm points, or the low end of everything when there are too few.
function rise(points, troubleTimes) {
  const clean = points.filter((p) => finite(p.at) && finite(p.value))
  if (!clean.length) return null
  const distance = (at) => troubleTimes.reduce((best, t) => Math.min(best, Math.abs(at - t)), Infinity)
  const bad = clean.filter((p) => distance(p.at) <= NEAR_MS).map((p) => p.value)
  const calm = clean.filter((p) => distance(p.at) > CALM_MS).map((p) => p.value)
  if (!bad.length) return null
  const base = calm.length >= MIN_CALM ? median(calm) : lowQuantile(clean.map((p) => p.value))
  const during = median(bad)
  return {base, during, rise: during - base, worst: Math.max(...bad), n: bad.length, calmN: calm.length}
}

const linkFull = (r) => Boolean(r) && r.rise >= EDGE_RISE_MS && r.during >= r.base * EDGE_RISE_RATIO
const queueGrew = (r) => Boolean(r) && r.rise >= QUEUE_RISE_MS

/**
 * @param {object} input series are arrays of {at (ms), ...}; every one may be empty or missing
 *   viewer:  viewer-side samples {at, loss, freezes, frz, dec, lt}   (viewer-sample, or the host's record of it)
 *   host:    host-side samples for this viewer {at, bw, cpu, enc}    (host-sample)
 *   hostEdge, viewerEdge: [{at, er}]   edge round trips from each side's machine-sample
 *   hostBusy, viewerBusy: [{at, ltMs}] renderer long-task time per sample
 *   hv: [{at, ms}] host-to-viewer one-way delay;  vh: [{at, ms}] viewer-to-host
 * @returns {{verdict, reasons: string[], numbers: object}} verdict is one of
 *   none | host-upload | viewer-network | viewer-computer | host-computer | unclear
 */
// The samples that count as trouble: loss, a freeze, or the encoder held back by bandwidth or CPU.
function troubledSamples(viewer = [], host = []) {
  return [
    ...viewer.filter((s) => s.loss > TROUBLE_LOSS_PCT || s.freezes > 0 || s.frz > 0),
    ...host.filter((s) => s.bw >= CPU_LIMITED_MS || s.cpu >= CPU_LIMITED_MS),
  ].filter((s) => finite(s.at))
}

function diagnoseBottleneck(input = {}) {
  const viewer = input.viewer || []
  const host = input.host || []
  const troubled = troubledSamples(viewer, host)
  const times = troubled.map((s) => s.at)
  const numbers = {troubled: troubled.length, samples: viewer.length || host.length}
  if (!times.length) return {verdict: 'none', reasons: ['no loss, freezes or encoder limits'], numbers}

  const series = (list, pick) => list.map((s) => ({at: s.at, value: pick(s)}))
  const hostEdge = rise(series(input.hostEdge || [], (s) => s.er), times)
  const viewerEdge = rise(series(input.viewerEdge || [], (s) => s.er), times)
  const hv = rise(series(input.hv || [], (s) => s.ms), times)
  const vh = rise(series(input.vh || [], (s) => s.ms), times)
  const decode = rise(series(viewer, (s) => s.dec), times)
  const encode = rise(series(host, (s) => s.enc), times)
  Object.assign(numbers, {hostEdge, viewerEdge, hv, vh})
  numbers.worstLoss = Math.max(0, ...nums(viewer.map((s) => s.loss)))

  const hostLimited = host.filter((s) => times.some((t) => Math.abs(t - s.at) <= NEAR_MS))
  const cpuHeld = hostLimited.length ? hostLimited.filter((s) => s.cpu >= CPU_LIMITED_MS).length / hostLimited.length : 0
  const bwHeld = hostLimited.length ? hostLimited.filter((s) => s.bw >= CPU_LIMITED_MS).length / hostLimited.length : 0
  numbers.hostCpuHeld = cpuHeld
  numbers.hostBwHeld = bwHeld
  const near = (s) => times.some((t) => Math.abs(t - s.at) <= NEAR_MS)
  // Long-task ms per sample near the trouble (a rate), so a long session with one stray task does not look slow.
  const longTasks = (list) => {
    const nearby = (list || []).filter((s) => finite(s.at) && finite(s.ltMs) && near(s))
    return nearby.length ? nearby.reduce((sum, s) => sum + s.ltMs, 0) / nearby.length : 0
  }
  numbers.viewerLongTaskMs = longTasks(input.viewerBusy)
  numbers.hostLongTaskMs = longTasks(input.hostBusy)

  const hostFull = linkFull(hostEdge)
  const viewerFull = linkFull(viewerEdge)
  const hostSlowPc = cpuHeld >= 0.5 || (finite(encode?.during) && encode.during >= ENCODE_SLOW_MS) || numbers.hostLongTaskMs >= LONG_TASK_MS
  const viewerSlowPc = (finite(decode?.during) && decode.during >= DECODE_SLOW_MS) || numbers.viewerLongTaskMs >= LONG_TASK_MS
  const reasons = []
  const edgeText = (name, r) => (r ? `${name} edge RTT ${Math.round(r.base)} -> ${Math.round(r.during)} ms while troubled (${r.rise >= 0 ? '+' : ''}${Math.round(r.rise)})` : null)
  const push = (...texts) => reasons.push(...texts.filter(Boolean))
  const done = (verdict) => ({verdict, reasons, numbers})

  // A computer is only blamed when the other side's link did not fill: that is the likelier cause of the trouble.
  if (hostSlowPc && !hostFull && !viewerFull) {
    push(cpuHeld >= 0.5 ? `encoder held back by CPU in ${Math.round(cpuHeld * 100)}% of the troubled samples` : null,
      encode && encode.during >= ENCODE_SLOW_MS ? `encode ${Math.round(encode.during)} ms per frame while troubled` : null,
      numbers.hostLongTaskMs >= LONG_TASK_MS ? `${Math.round(numbers.hostLongTaskMs)} ms of renderer long tasks per troubled sample` : null,
      edgeText('host', hostEdge) || 'host link not measured')
    return done('host-computer')
  }
  if (viewerSlowPc && !viewerFull && !hostFull) {
    push(decode && decode.during >= DECODE_SLOW_MS ? `decode ${Math.round(decode.during)} ms per frame while troubled` : null,
      numbers.viewerLongTaskMs >= LONG_TASK_MS ? `${Math.round(numbers.viewerLongTaskMs)} ms of renderer long tasks per troubled sample` : null,
      edgeText('viewer', viewerEdge) || 'viewer link not measured')
    return done('viewer-computer')
  }
  if (hostFull && !viewerFull) {
    push(edgeText('host', hostEdge), viewerEdge ? edgeText('viewer', viewerEdge) : "viewer's own link not measured",
      queueGrew(hv) ? `host-to-viewer delay +${Math.round(hv.rise)} ms` : null,
      bwHeld > 0 ? `encoder held back by bandwidth in ${Math.round(bwHeld * 100)}% of the troubled samples` : null)
    return done('host-upload')
  }
  if (viewerFull && !hostFull) {
    push(edgeText('viewer', viewerEdge), hostEdge ? edgeText('host', hostEdge) : "host's own link not measured",
      queueGrew(hv) ? `host-to-viewer delay +${Math.round(hv.rise)} ms` : null,
      queueGrew(vh) ? `viewer-to-host delay +${Math.round(vh.rise)} ms` : null)
    return done('viewer-network')
  }
  if (hostFull && viewerFull) {
    push(edgeText('host', hostEdge), edgeText('viewer', viewerEdge), 'both ends filled their links: shared bottleneck, or too much video for both')
    return done('unclear')
  }
  if (hostSlowPc) {
    push(cpuHeld >= 0.5 ? `encoder held back by CPU in ${Math.round(cpuHeld * 100)}% of the troubled samples` : null, edgeText('host', hostEdge))
    return done('host-computer')
  }
  if (!hostEdge && !viewerEdge) {
    push('no edge round trips in these logs (telemetry off, or a build from before 0.8.1)',
      queueGrew(hv) ? `host-to-viewer delay +${Math.round(hv.rise)} ms` : null)
    return done('unclear')
  }
  push(edgeText('host', hostEdge), edgeText('viewer', viewerEdge),
    queueGrew(hv) ? `host-to-viewer delay +${Math.round(hv.rise)} ms` : null,
    hostEdge && viewerEdge ? "neither person's own link filled up: the trouble is somewhere between them"
      : `${hostEdge ? "viewer's" : "host's"} own link was not measured, and the ${hostEdge ? "host's" : "viewer's"} did not fill up: the cause is not clear`)
  return done('unclear')
}

module.exports = {
  CALM_MS, CPU_LIMITED_MS, DECODE_SLOW_MS, EDGE_RISE_MS, ENCODE_SLOW_MS, NEAR_MS, TROUBLE_LOSS_PCT,
  diagnoseBottleneck, linkFull, rise, troubledSamples,
}
