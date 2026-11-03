const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const report = require('../scripts/session-report')

// Synthetic logs (scripts/make-report-fixtures.js): a host and two viewers, once as 0.8.0 (none of the
// M1.2 fields) and once as 0.9.0. Viewer three has no log of its own, only the host's view of it.
const FIXTURES = path.join(__dirname, 'fixtures', 'report')
const EXPECTED = path.join(__dirname, 'fixtures', 'report-expected')
const normal = (text) => text.replace(/\r\n/g, '\n')

function capture(args) {
  const lines = []
  const code = report.run(args, {out: (t) => lines.push(t), err: (t) => lines.push(`ERR ${t}`)})
  return {code, text: `${lines.join('\n')}\n`}
}

// The golden outputs. UPDATE_GOLDEN=1 rewrites them after an intended change; read the diff before committing it.
function golden(name, text) {
  const file = path.join(EXPECTED, name)
  if (process.env.UPDATE_GOLDEN) {
    fs.mkdirSync(EXPECTED, {recursive: true})
    fs.writeFileSync(file, text)
  }
  assert.equal(text, normal(fs.readFileSync(file, 'utf8')), `${name} differs from the golden output (UPDATE_GOLDEN=1 to accept)`)
}

test('golden: the report for the newest day of the fixture archive', () => {
  const {code, text} = capture(['--report', '--dir', FIXTURES])
  assert.equal(code, 0)
  golden('report-newest.txt', text)
})

test('golden: a 0.8.0-era session (no M1.2 fields) prints dashes, never NaN', () => {
  const {code, text} = capture(['--report', '--dir', FIXTURES, '2026-09-20'])
  assert.equal(code, 0)
  golden('report-old.txt', text)
  assert.doesNotMatch(text, /NaN|undefined|null|Infinity|\[object/)
  assert.match(text, /Audio concealed +–/)
  assert.match(text, /A\/V offset +–/)
})

test('golden: the comparison groups the same numbers by app version', () => {
  const {code, text} = capture(['--compare', '--dir', FIXTURES])
  assert.equal(code, 0)
  golden('compare.txt', text)
  assert.doesNotMatch(text, /NaN|undefined|null|Infinity|\[object/)
})

test('host and viewer files of one room are paired by room code and wall clock', () => {
  const {byFolder} = report.loadEntries(FIXTURES, '2026-10-01')
  const groups = report.selectGroups(byFolder, {user: '', chosen: '2026-10-01'})
  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0].sessions.map((s) => s.user).sort(), ['host-one#0000-0000', 'viewer-two#0000-0000'])
  const score = report.scoreGroup(groups[0])
  assert.deepEqual(score.rows.map((r) => [r.hostName, r.viewerName, r.sources.viewerLog]), [
    ['host-one#0000-0000', 'viewer-three#0000-0000', false], // named from the host's peer/join line
    ['host-one#0000-0000', 'viewer-two#0000-0000', true],
  ])
})

test('sessions in other rooms, or hours apart, are not paired', () => {
  const at = (iso, room, who) => ({d: {t: iso, sc: 'telemetry', ev: 'viewer-sample', room, self: who, host: 'h', playback: {playing: true}}, at: Date.parse(iso), user: who, folder: who, version: '1'})
  const a = report.buildSessions([at('2026-10-01T10:00:00Z', 'R1', 'a'), at('2026-10-01T10:00:10Z', 'R1', 'a')])
  const b = report.buildSessions([at('2026-10-01T10:00:05Z', 'R2', 'b'), at('2026-10-01T10:00:15Z', 'R2', 'b')])
  const c = report.buildSessions([at('2026-10-01T14:00:00Z', 'R1', 'c'), at('2026-10-01T14:00:10Z', 'R1', 'c')])
  assert.equal(report.groupSessions([...a, ...b, ...c]).length, 3)
})

test('a room that goes quiet, or is left and re-entered, is separate sessions of one person', () => {
  const e = (iso, ev = 'viewer-sample', sc = 'telemetry') => ({d: {t: iso, sc, ev, room: 'R', self: 'x'}, at: Date.parse(iso), user: 'x', folder: 'x', version: '1'})
  const sessions = report.buildSessions([
    e('2026-10-01T10:00:00Z'), e('2026-10-01T10:00:10Z'), e('2026-10-01T10:00:12Z', 'leave', 'room'),
    e('2026-10-01T10:05:00Z', 'entered', 'room'), e('2026-10-01T10:05:10Z'),
    e('2026-10-01T10:20:00Z'),
  ])
  assert.equal(sessions.length, 3)
})

test('metrics: only playing samples count, missing fields stay null', () => {
  const m = report.viewerMetrics([
    {rttMs: 10, lossPct: 0, freezes: 0, playback: {playing: true}},
    {rttMs: 30, lossPct: 4, freezes: 1, playback: {playing: true}},
    {rttMs: 999, lossPct: 99, freezes: 9, playback: {playing: false}},
  ])
  assert.equal(m.n, 2)
  assert.deepEqual(m.rtt, {median: 20, worst: 30})
  assert.deepEqual(m.loss, {avg: 2, worst: 4})
  assert.deepEqual(m.frozen, {pct: 50, by: 'ticks'})
  assert.equal(m.concealed, null)
  assert.equal(m.av, null)
  assert.equal(m.videoRx, null)
  assert.deepEqual(m.decode, {median: null, worst: null})
  const none = report.viewerMetrics([])
  assert.equal(none.n, 0)
  assert.equal(none.frozen, null)
  assert.equal(none.rtt.median, null)
})

test('metrics: frozen share from freeze durations, concealment as a share of samples', () => {
  const m = report.viewerMetrics([
    {rttMs: 20, playback: {playing: true}, v: {frz: 400}, a: {conc: 480, smp: 96000}},
    {rttMs: 20, playback: {playing: true}, v: {frz: 0}, a: {conc: 0, smp: 96000}},
  ])
  assert.equal(m.frozen.by, 'time')
  assert.equal(m.frozen.pct, 10) // 400 ms of 4000 ms
  assert.equal(m.concealed, 0.25) // 480 of 192000 samples
})

test('A/V offset: s.off first, then s.av, then the same sum from the logged fields', () => {
  // A log with both fields uses s.off (av cannot see a lip-sync hold: here the picture is held ~700 ms).
  const both = report.viewerMetrics([{s: {off: -632.2, av: 15, aJb: 30, vJb: 697.2}}, {s: {off: -630, av: 20}}])
  assert.deepEqual([both.av.ms, both.av.method], [-631.1, 'off'])
  // 0.8.1: av but no off.
  const ept = report.viewerMetrics([{s: {av: 40, aJb: 100, vJb: 10}}, {s: {av: 60}}])
  assert.deepEqual([ept.av.ms, ept.av.method], [50, 'av'])
  // Neither: the s.off formula, with decode and base taken from where they are logged.
  const delay = report.viewerMetrics([{s: {aJb: 60, aPlay: 15, out: 30, base: 10, vJb: 20}, v: {dec: 4}}])
  assert.deepEqual([delay.av.ms, delay.av.method], [76, 'delay'])
  const noOutput = report.viewerMetrics([{s: {aJb: 60, vJb: 20}}])
  assert.equal(noOutput.av.ms, 40)
  assert.equal(report.viewerMetrics([{s: {aJb: 60}}]).av, null, 'one track alone says nothing about the offset')
  // Mixed logs name every method that fed the median.
  const mixed = report.viewerMetrics([{s: {off: 10}}, {s: {av: 30}}, {s: {aJb: 50, vJb: 20}}])
  assert.deepEqual([mixed.av.ms, mixed.av.method], [30, 'av+delay+off'])
})

test('host metrics: quality decisions and bitrate changes', () => {
  const h = report.hostMetrics(
    [{decision: 'settling', bitrate: 4e6}, {decision: 'loss', bitrate: 3e6}, {decision: 'settling', bitrate: 3e6}],
    [{from: 4e6, to: 3e6, reason: 'loss'}, {from: 3e6, to: 3.6e6, reason: 'recovery'}, {from: 'x', to: 1}],
  )
  assert.deepEqual(h.decisions, [['settling', 2], ['loss', 1]])
  assert.equal(h.changes.up, 1)
  assert.equal(h.changes.down, 1)
  assert.deepEqual(h.targetRange, [3e6, 4e6])
  assert.equal(h.videoTarget, 3e6)
})

test('cpu peak is the busiest tick summed over the four process groups', () => {
  const cpu = report.cpuMetrics([{p: {m: [5, 1], r: [10, 1]}}, {p: {m: [5, 1], r: [30, 1], g: [20, 1], o: [1, 1, 2]}}, {}])
  assert.equal(cpu.peak, 56)
  assert.equal(report.cpuMetrics([{}, {p: {}}]), null)
})

test('verdict: smaller than 10% and the fixed amount is "same"; direction depends on the row', () => {
  const lowerIsBetter = {value: 1, low: true, eps: 5}
  assert.equal(report.verdict(lowerIsBetter, 100, 104), 'same')
  assert.equal(report.verdict(lowerIsBetter, 100, 60), 'better')
  assert.equal(report.verdict(lowerIsBetter, 100, 140), 'worse')
  assert.equal(report.verdict({value: 1, low: false, eps: 5}, 90, 70), 'worse')
  assert.equal(report.verdict(lowerIsBetter, null, 5), '–')
  assert.equal(report.verdict({value: null}, 1, 2), '–')
})

test('versions sort by number, not as text', () => {
  assert.deepEqual(['0.10.0', '0.9.0', '0.9.10', 'unknown', '0.9.2'].sort(report.compareVersions), ['unknown', '0.9.0', '0.9.2', '0.9.10', '0.10.0'])
})

test('a log with garbage, truncated lines and no room reads without throwing', () => {
  const entries = report.parseLog(['# upload {"version":"0.7.0","from":"someone#1"}', 'not json', '{"t":"nope"}', '{"t":"2026-10-01T10:00:00Z","sc":"telemetry","ev":"viewer-sample","room":"R","host":"h","self":"s","rttMs":null,"playback":{"playing":true}}', '{"t":"2026-10-01T10:00:02Z","sc":"telemetry","ev":"viewer-sample","room":"R","host":"h","self":"s"', ''].join('\n'), 'someone')
  assert.equal(entries.length, 1)
  assert.equal(entries[0].version, '0.7.0')
  assert.equal(entries[0].user, 'someone#1')
  const out = report.formatReport(report.groupSessions(report.buildSessions(entries)).map(report.scoreGroup))
  assert.doesNotMatch(out, /NaN|undefined|null|Infinity|\[object/)
})

test('arguments: username, day, "all", and unknown options', () => {
  assert.deepEqual(
    (({mode, user, day, fetch}) => ({mode, user, day, fetch}))(report.parseArgs(['--report', 'Aya', '2026-10-01'])),
    {mode: 'report', user: 'aya', day: '2026-10-01', fetch: true},
  )
  assert.equal(report.parseArgs(['--compare', 'all', '--no-fetch']).fetch, false)
  assert.equal(report.parseArgs(['--report', '--dir', 'x']).fetch, false)
  assert.equal(report.parseArgs(['--report', '--wat']).errors.length, 1)
})

test('the username filter keeps rooms that person was in, with everyone else in them', () => {
  const some = capture(['--report', '--dir', FIXTURES, 'viewer-two', '2026-10-01'])
  assert.match(some.text, /host-one#0000-0000/)
  const none = capture(['--report', '--dir', FIXTURES, 'nobody', '2026-10-01'])
  assert.match(none.text, /No sessions for nobody\*/)
})

test('a missing archive says so instead of throwing', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'wwf-report-'))
  const result = capture(['--report', '--dir', empty])
  assert.equal(result.code, 1)
  assert.match(result.text, /No telemetry files/)
})
