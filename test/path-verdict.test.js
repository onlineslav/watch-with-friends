const test = require('node:test')
const assert = require('node:assert/strict')
const {diagnosePath, extraTrouble, traceText} = require('../scripts/path-verdict')
const report = require('../scripts/session-report')

// M1.13: "Where on the path" between two homes, from the net probe (router, 1.1.1.1, each other),
// the traceroutes it takes and the route's own counters.
const clean = {n: 10, avg: 3, max: 6}
const slow = {n: 10, avg: 300, max: 900}
const lossy = {n: 10, lost: 4, avg: 20, max: 40}
const series = (from, to, make) => {
  const out = []
  for (let at = from; at <= to; at += 2000) out.push({at, ...make(at)})
  return out
}
const TROUBLE = [40_000, 42_000, 44_000]
const inTrouble = (at) => at >= 38_000 && at <= 46_000

test('no trouble or no probe data gives no line', () => {
  assert.equal(diagnosePath({times: [], hostNp: series(0, 60_000, () => ({gw: clean}))}), null)
  assert.equal(diagnosePath({times: TROUBLE}), null)
})

test("a slow router names that person's home network; 1.1.1.1 alone names their provider", () => {
  const home = diagnosePath({times: TROUBLE, hostName: 'aya', viewerName: 'lenna',
    hostNp: series(0, 60_000, () => ({gw: clean, net: clean})),
    viewerNp: series(0, 60_000, (at) => ({gw: inTrouble(at) ? slow : clean, net: inTrouble(at) ? slow : clean}))})
  assert.equal(home.verdict, 'viewer-home')
  assert.match(home.reasons[0], /lenna's router/)
  const isp = diagnosePath({times: TROUBLE, hostName: 'aya', viewerName: 'lenna',
    hostNp: series(0, 60_000, (at) => ({gw: clean, net: inTrouble(at) ? lossy : clean})),
    viewerNp: series(0, 60_000, () => ({gw: clean, net: clean}))})
  assert.equal(isp.verdict, 'host-isp')
})

test('pings to each other going bad while both homes are clean is the route between, with the hop it starts at', () => {
  const p = diagnosePath({times: TROUBLE, hostName: 'aya', viewerName: 'lenna',
    hostNp: series(0, 60_000, (at) => ({gw: clean, net: clean, peer: inTrouble(at) ? {n: 10, avg: 900, max: 1000} : {n: 10, avg: 40, max: 50}})),
    viewerNp: series(0, 60_000, () => ({gw: clean, net: clean})),
    hostTraces: [
      {why: 'baseline', reached: true, hops: [[1, 'l', 'a'], [9, 'c', 'b'], [15, 'p', 'c'], [40, 'p', 'd']]},
      {why: 'stall', reached: true, hops: [[1, 'l', 'a'], [10, 'c', 'b'], [600, 'p', 'c'], [900, 'p', 'd']]},
    ]})
  assert.equal(p.verdict, 'between')
  assert.match(p.reasons[0], /aya's pings to lenna went slow or lost in 5 of 5 troubled samples \(calm 40 ms\)/)
  assert.ok(p.reasons.some((r) => /delay starts at hop 3 of 4 \(on the internet\), 15 -> 600 ms/.test(r)), p.reasons.join(' | '))
})

test('pings to each other staying clean while the video struggles is the flow, not the route', () => {
  const p = diagnosePath({times: TROUBLE, hostNp: series(0, 60_000, () => ({gw: clean, net: clean, peer: {n: 10, avg: 40, max: 55}}))})
  assert.equal(p.verdict, 'flow')
})

test('the route counters name the direction that broke', () => {
  const p = diagnosePath({times: TROUBLE, hostName: 'aya', viewerName: 'lenna',
    hostCp: [{at: 42_000, cp: {rq: 2, rs: 0, rr: 1, ss: 1}}, {at: 10_000, cp: {rq: 2, rs: 0, rr: 1}}]})
  assert.equal(p.verdict, 'unclear')
  assert.deepEqual(p.reasons, ["1 sample where aya's connection checks went unanswered while lenna's still arrived: the aya -> lenna direction broke"])
})

test('trace sentences: silent route, slow tail, nothing to compare', () => {
  assert.equal(traceText([], 'a', 'b'), null)
  assert.equal(traceText([{why: 'baseline', hops: [[1, 'l', 'x']]}], 'a', 'b'), null, 'a baseline alone is not trouble')
  assert.match(traceText([{why: 'loss', reached: false, hops: [[1, 'l', 'x'], [8, 'c', 'y'], [null], [null]]}], 'a', 'b'), /stopped getting answers after hop 2 of 4/)
  assert.match(traceText([{why: 'loss', reached: true, hops: [[1, 'l', 'x'], [200, 'p', 'y'], [250, 'p', 'z']]}], 'a', 'b'), /slow from hop 2 of 3/)
  assert.match(traceText([{why: 'loss', reached: false, hops: [[null], [null]]}], 'a', 'b'), /no answers at all/)
})

test('long one-way delays and a quiet route count as trouble without loss', () => {
  assert.deepEqual(extraTrouble({hv: [{at: 1, ms: 13_000}, {at: 2, ms: 30}], vh: [{at: 3, ms: 1200}], hostCp: [{at: 4, cp: {quiet: 2500}}], viewerCp: [{at: 5, cp: {quiet: 10}}]}), [1, 3, 4])
})

test('the report prints a "Where on the path" line from the logs both sides wrote', () => {
  const T0 = Date.parse('2026-11-11T07:00:00Z')
  const at = (ms) => new Date(T0 + ms).toISOString()
  const write = (folder, user, lines) => report.parseLog(`# upload ${JSON.stringify({version: '0.8.12', from: `${user}#0000-0000`})}\n${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, folder)
  const hostRoom = {room: 'R1', self: 'H'}
  const viewerRoom = {room: 'R1', self: 'V'}
  const hostLines = [{t: at(0), m: 0, lv: 'info', sc: 'room', ev: 'entered', ...hostRoom}]
  const viewerLines = [{t: at(0), m: 0, lv: 'info', sc: 'room', ev: 'entered', ...viewerRoom}]
  for (let ms = 2000; ms <= 60_000; ms += 2000) {
    const bad = ms >= 40_000 && ms <= 44_000
    hostLines.push({t: at(ms), m: ms, lv: 'info', sc: 'telemetry', ev: 'host-sample', ...hostRoom, peer: 'V', rttMs: 40, playback: {playing: true}})
    hostLines.push({t: at(ms), m: ms, lv: 'info', sc: 'telemetry', ev: 'machine-sample', ...hostRoom, role: 'host',
      np: {gw: clean, net: clean, peer: {V: bad ? {n: 10, lost: 6, avg: 800, max: 990} : {n: 10, avg: 40, max: 45}}}})
    viewerLines.push({t: at(ms), m: ms, lv: 'info', sc: 'telemetry', ev: 'viewer-sample', ...viewerRoom, host: 'H', rttMs: 40, lossPct: bad ? 30 : 0, playback: {playing: true}})
    viewerLines.push({t: at(ms), m: ms, lv: 'info', sc: 'telemetry', ev: 'machine-sample', ...viewerRoom, role: 'viewer', np: {gw: clean, net: clean}})
  }
  hostLines.push({t: at(41_000), m: 41_000, lv: 'info', sc: 'network', ev: 'trace', peer: 'V', why: 'stall', n: 3, reached: false, hops: [[1, 'l', 'aaaa'], [9, 'c', 'bbbb'], [null]]})
  hostLines.push({t: at(61_000), m: 61_000, lv: 'info', sc: 'room', ev: 'leave', ...hostRoom})
  viewerLines.push({t: at(61_000), m: 61_000, lv: 'info', sc: 'room', ev: 'leave', ...viewerRoom})
  const sessions = [...report.buildSessions(write('aya-0000-0000', 'aya', hostLines)), ...report.buildSessions(write('lenna-0000-0000', 'lenna', viewerLines))]
  const [group] = report.groupSessions(sessions)
  const score = report.scoreGroup(group)
  assert.equal(score.rows[0].path.verdict, 'between')
  const text = report.formatGroup(score)
  assert.match(text, /Where on the path +the route between the two homes {3}\[aya#0000-0000's pings to lenna#0000-0000 went slow or lost/)
  assert.match(text, /stopped getting answers after hop 2 of 3 \(an internet provider's shared address range\)/)
})
