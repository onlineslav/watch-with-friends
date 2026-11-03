const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const report = require('../scripts/session-report')

// M1.9 in the report: marks with the numbers from the seconds around them, the context lines from the
// main process, and the "Likely bottleneck" line. The golden outputs in report.test.js pin the whole text;
// these pin the rules.
const FIXTURES = path.join(__dirname, 'fixtures', 'report')
const score = (day) => {
  const {byFolder} = report.loadEntries(FIXTURES, day)
  return report.scoreGroup(report.selectGroups(byFolder, {user: '', chosen: day})[0])
}

const T0 = Date.parse('2026-11-03T20:00:00Z')
const line = (offsetMs, sc, ev, ctx, data) => JSON.stringify({t: new Date(T0 + offsetMs).toISOString(), m: offsetMs, lv: 'info', sc, ev, ...ctx, ...data})
const parse = (lines, folder = 'someone-0000-0000') => report.parseLog(`# upload ${JSON.stringify({version: '0.9.0', from: `${folder.replace(/-0000-0000$/, '')}#0000-0000`})}\n${lines.join('\n')}\n`, folder)
const ROOM = {room: 'ROOM1', self: 'peerA'}

test('one mark seen by three people is one mark, timed by the marker\'s clock, with the last note', () => {
  const mine = parse([
    line(0, 'room', 'entered', ROOM, {}),
    line(30_000, 'mark', 'note', ROOM, {id: 'abc123', src: 'self', by: 'a#1', pos: 12.5}),
    line(33_000, 'mark', 'note', ROOM, {id: 'abc123', src: 'self', by: 'a#1', note: 'sound is late', pos: 15}),
    line(90_000, 'room', 'leave', ROOM, {}),
  ], 'a-0000-0000')
  const theirs = parse([
    line(0, 'room', 'entered', {room: 'ROOM1', self: 'peerB'}, {}),
    line(30_400, 'mark', 'note', {room: 'ROOM1', self: 'peerB'}, {id: 'abc123', src: 'peer', by: 'a#1', peer: 'peerA'}),
    line(60_000, 'mark', 'note', {room: 'ROOM1', self: 'peerB'}, {id: 'def456', src: 'self', by: 'b#1', note: 'again'}),
    line(90_000, 'room', 'leave', {room: 'ROOM1', self: 'peerB'}, {}),
  ], 'b-0000-0000')
  const sessions = [...report.buildSessions(mine), ...report.buildSessions(theirs)]
  const marks = report.collectMarks(sessions)
  assert.deepEqual(marks.map((m) => [m.id, m.by, m.note, m.at - T0, m.seenBy.sort()]), [
    ['abc123', 'a#0000-0000', 'sound is late', 30_000, ['a#0000-0000', 'b#0000-0000']],
    ['def456', 'b#0000-0000', 'again', 60_000, ['b#0000-0000']],
  ])
  assert.equal(marks[0].pos, 12.5)
})

test('a line from the main process lands in the visit it happened inside, and not outside it', () => {
  const entries = parse([
    line(-5_000, 'crash', 'child-process-gone', {}, {reason: 'before the room'}),
    line(0, 'room', 'entered', ROOM, {}),
    line(20_000, 'window', 'state', {}, {s: 'minimized'}),
    line(21_000, 'power', 'state', {}, {s: 'suspend'}),
    line(22_000, 'telemetry', 'machine-sample', {}, {p: {}}), // not a context scope
    line(60_000, 'room', 'leave', ROOM, {}),
    line(65_000, 'crash', 'render-process-gone', {}, {reason: 'after the room'}),
  ])
  const [visit] = report.buildSessions(entries)
  assert.deepEqual(visit.context.map((e) => `${e.d.sc}/${e.d.ev}`), ['window/state', 'power/state'])
  assert.deepEqual(visit.entries.map((e) => e.d.ev), ['entered', 'leave'], 'and they are not counted as the visit\'s own lines')
  assert.equal(visit.end - visit.start, 60_000, 'nor do they stretch it')
})

test('the fixture\'s mark lists the numbers from 5 seconds either side and what happened around it', () => {
  const s = score('2026-10-01')
  assert.equal(s.marks.length, 2)
  const [first, second] = s.marks
  assert.equal(first.id, 'k3x9f2a1')
  assert.equal(first.note, 'audio crackles')
  assert.equal(first.by, 'viewer-two#0000-0000')
  assert.deepEqual(first.seenBy.sort(), ['host-one#0000-0000', 'viewer-two#0000-0000'])
  const two = first.rows.find((r) => r.viewerName === 'viewer-two#0000-0000')
  assert.ok(two.samples >= 4 && two.samples <= 6, `${two.samples} samples within 5s either side`)
  assert.equal(two.viewer.loss.worst, 8.5)
  assert.equal(two.hostEdge, 225)
  assert.equal(two.viewerEdge, 31)
  assert.ok(two.hv > 100, `host-to-viewer delay ${two.hv}`)
  assert.deepEqual(first.nearby.map((e) => `${e.d.sc}/${e.d.ev}`), ['window/state', 'crash/child-process-gone', 'action/pause'])
  const calm = second.rows.find((r) => r.viewerName === 'viewer-two#0000-0000')
  assert.equal(calm.viewer.loss.worst < 1, true, 'the calm mark shows calm numbers')
  assert.equal(calm.hostEdge < 40, true)
  assert.equal(second.note, null)
  assert.equal(second.by, 'host-one#0000-0000')
})

test('only samples within the window count', () => {
  const s = score('2026-10-01')
  const mark = s.marks[0]
  const all = s.rows.find((r) => r.viewerName === 'viewer-two#0000-0000').raw.viewerLines
  const inside = all.filter((d) => Math.abs(Date.parse(d.t) - mark.at) <= 5000)
  assert.equal(mark.rows.find((r) => r.viewerName === 'viewer-two#0000-0000').samples, inside.length)
  assert.ok(inside.length < all.length / 3)
})

test('the printed report has a Marks section and a Likely bottleneck line per viewer', () => {
  const lines = []
  report.run(['--report', '--dir', FIXTURES, '2026-10-01'], {out: (t) => lines.push(t)})
  const text = lines.join('\n')
  assert.match(text, /Marks \(2\)/)
  assert.match(text, /20:00:24 UTC  by viewer-two#0000-0000: "audio crackles"/)
  assert.equal((text.match(/Likely bottleneck/g) || []).length, 2, 'one per viewer')
  assert.match(text, /Likely bottleneck +host-one#0000-0000's upload \(host\)/)
  assert.match(text, /host edge RTT 2\d -> 2\d\d ms while troubled/)
  assert.match(text, /viewer edge RTT 31 -> 31 ms/)
  assert.doesNotMatch(text, /NaN|undefined|null|Infinity|\[object/)
})

test('a log from before M1.9 has no marks section, and says the bottleneck is unclear for want of numbers', () => {
  const lines = []
  report.run(['--report', '--dir', FIXTURES, '2026-09-20'], {out: (t) => lines.push(t)})
  const text = lines.join('\n')
  assert.doesNotMatch(text, /Marks \(/)
  assert.match(text, /Likely bottleneck +unclear +\[3 troubled samples; no edge round trips in these logs/)
  assert.match(text, /Edge RTT +–/)
  assert.match(text, /One-way delay +–/)
})
