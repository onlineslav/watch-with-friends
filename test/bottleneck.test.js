const test = require('node:test')
const assert = require('node:assert/strict')
const {diagnoseBottleneck, linkFull, rise} = require('../scripts/bottleneck')

// A 60-second session sampled every 2 seconds, with trouble (loss) from 20s to 26s. Each test says which
// series climb during it.
const T0 = 1_800_000_000_000
const ticks = Array.from({length: 30}, (_, i) => i)
const at = (i) => T0 + i * 2000
const troubled = (i) => i >= 10 && i <= 13
const around = (i) => i >= 9 && i <= 14

function session({hostEdge = false, viewerEdge = false, hv = false, hostCpu = false, hostBw = false, slowEncode = false, slowDecode = false, hostLongTasks = false, viewerLongTasks = false, edges = true, loss = true} = {}) {
  return {
    viewer: ticks.map((i) => ({at: at(i), loss: loss && troubled(i) ? 8 : 0, freezes: 0, frz: 0, dec: slowDecode && around(i) ? 40 : 3})),
    host: ticks.map((i) => ({at: at(i), bw: hostBw && troubled(i) ? 1500 : 0, cpu: hostCpu && troubled(i) ? 1500 : 0, enc: slowEncode && around(i) ? 35 : 4})),
    hostEdge: edges ? ticks.map((i) => ({at: at(i), er: hostEdge && around(i) ? 240 : 25 + (i % 3)})) : [],
    viewerEdge: edges ? ticks.map((i) => ({at: at(i), er: viewerEdge && around(i) ? 190 : 30 + (i % 2)})) : [],
    hv: ticks.map((i) => ({at: at(i), ms: hv && around(i) ? 180 : 15})),
    vh: ticks.map((i) => ({at: at(i), ms: 16})),
    hostBusy: ticks.map((i) => ({at: at(i), ltMs: hostLongTasks && around(i) ? 300 : 0})),
    viewerBusy: ticks.map((i) => ({at: at(i), ltMs: viewerLongTasks && around(i) ? 300 : 0})),
  }
}

test('the host\'s edge RTT climbs with the loss and the viewer\'s does not: the host\'s upload', () => {
  const result = diagnoseBottleneck(session({hostEdge: true, hv: true, hostBw: true}))
  assert.equal(result.verdict, 'host-upload')
  assert.ok(result.numbers.hostEdge.rise > 150 && result.numbers.viewerEdge.rise < 5)
  assert.match(result.reasons.join(';'), /host edge RTT 2\d -> 240 ms/)
  assert.match(result.reasons.join(';'), /host-to-viewer delay \+16\d ms/)
  assert.match(result.reasons.join(';'), /held back by bandwidth/)
})

test('the viewer\'s edge RTT climbs and the host\'s does not: their network', () => {
  const result = diagnoseBottleneck(session({viewerEdge: true, hv: true}))
  assert.equal(result.verdict, 'viewer-network')
  assert.ok(result.numbers.viewerEdge.rise > 140 && result.numbers.hostEdge.rise < 5)
  assert.match(result.reasons.join(';'), /viewer edge RTT/)
})

test('the encoder held back by CPU while both links stay flat: the host\'s computer', () => {
  for (const input of [session({hostCpu: true}), session({slowEncode: true}), session({hostLongTasks: true})]) {
    const result = diagnoseBottleneck(input)
    assert.equal(result.verdict, 'host-computer')
  }
  assert.match(diagnoseBottleneck(session({hostCpu: true})).reasons.join(';'), /held back by CPU/)
})

test('a decoder that cannot keep up while both links stay flat: the viewer\'s computer', () => {
  for (const input of [session({slowDecode: true}), session({viewerLongTasks: true})]) {
    assert.equal(diagnoseBottleneck(input).verdict, 'viewer-computer')
  }
  assert.match(diagnoseBottleneck(session({slowDecode: true})).reasons.join(';'), /decode 40 ms per frame/)
})

test('a slow computer is not blamed when its own link filled up, which is the likelier cause', () => {
  assert.equal(diagnoseBottleneck(session({hostEdge: true, slowEncode: true})).verdict, 'host-upload')
  assert.equal(diagnoseBottleneck(session({viewerEdge: true, slowDecode: true})).verdict, 'viewer-network')
})

test('both ends filling their links, or neither, or no measurements at all, is unclear and says why', () => {
  const both = diagnoseBottleneck(session({hostEdge: true, viewerEdge: true}))
  assert.equal(both.verdict, 'unclear')
  assert.match(both.reasons.join(';'), /both ends filled their links/)
  const neither = diagnoseBottleneck(session({hv: true}))
  assert.equal(neither.verdict, 'unclear')
  assert.match(neither.reasons.join(';'), /neither person's own link filled up/)
  const blind = diagnoseBottleneck(session({edges: false}))
  assert.equal(blind.verdict, 'unclear')
  assert.match(blind.reasons.join(';'), /no edge round trips in these logs/)
})

test('a missing side is said, not guessed at', () => {
  const input = session({hostEdge: true})
  input.viewerEdge = []
  const result = diagnoseBottleneck(input)
  assert.equal(result.verdict, 'host-upload')
  assert.match(result.reasons.join(';'), /viewer's own link not measured/)
})

test('no trouble, no verdict: a link far from Cloudflare is not a full one', () => {
  const calm = session({edges: true, loss: false})
  calm.hostEdge = calm.hostEdge.map((p) => ({...p, er: 220})) // always slow
  const result = diagnoseBottleneck(calm)
  assert.equal(result.verdict, 'none')
  // And with trouble but a link that was always this slow, the rise is zero: not blamed.
  const slowAlways = session()
  slowAlways.hostEdge = slowAlways.hostEdge.map((p) => ({...p, er: 220}))
  assert.equal(diagnoseBottleneck(slowAlways).verdict, 'unclear')
  assert.equal(diagnoseBottleneck({}).verdict, 'none')
  assert.equal(diagnoseBottleneck().verdict, 'none')
})

test('freezes and an encoder limited by bandwidth count as trouble without any loss', () => {
  const input = session({hostEdge: true, loss: false})
  input.viewer = input.viewer.map((s, i) => ({...s, freezes: troubled(i) ? 1 : 0}))
  assert.equal(diagnoseBottleneck(input).verdict, 'host-upload')
  const bandwidthOnly = session({hostEdge: true, hostBw: true, loss: false})
  assert.equal(diagnoseBottleneck(bandwidthOnly).verdict, 'host-upload')
})

test('clocks a second or two apart still line the series up', () => {
  const input = session({hostEdge: true})
  input.hostEdge = input.hostEdge.map((p) => ({...p, at: p.at + 1900})) // the host's wall clock runs 1.9s ahead
  assert.equal(diagnoseBottleneck(input).verdict, 'host-upload')
})

test('missing or non-numeric values never reach the numbers', () => {
  const input = session({hostEdge: true})
  input.hostEdge[10].er = NaN
  input.hostEdge[11].er = undefined
  input.viewer[3].loss = undefined
  input.hv = null
  const result = diagnoseBottleneck(input)
  assert.equal(result.verdict, 'host-upload')
  assert.doesNotMatch(JSON.stringify(result), /NaN|undefined|Infinity/)
})

test('rise and linkFull on their own', () => {
  const points = (values) => values.map((value, i) => ({at: at(i), value}))
  const r = rise(points([20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 90, 100, 90, 95, 20, 20, 20, 20, 20, 20, 20]), [at(10), at(11), at(12), at(13)])
  assert.equal(r.base, 20)
  assert.equal(r.during, 90)
  assert.equal(r.rise, 70)
  assert.equal(r.worst, 100)
  assert.equal(linkFull(r), true)
  assert.equal(linkFull({base: 100, during: 130, rise: 30}), false, 'too small a step')
  assert.equal(linkFull({base: 300, during: 345, rise: 45}), false, 'a big step on an already slow link is not 50% more')
  assert.equal(linkFull(null), false)
  assert.equal(rise([], [at(1)]), null)
  assert.equal(rise(points([20, 20]), [at(50)]), null, 'no sample near the trouble')
})

test('a stray host long task in ten minutes of viewer trouble does not turn their network into the host\'s computer', () => {
  const n = 300 // 10 minutes of 2s samples; the viewer has loss from 50 to 250
  const idx = Array.from({length: n}, (_, i) => i)
  const bad = (i) => i >= 50 && i < 250
  const input = {
    viewer: idx.map((i) => ({at: at(i), loss: bad(i) ? 6 : 0, freezes: 0, frz: 0, dec: 3})),
    host: idx.map((i) => ({at: at(i), bw: 0, cpu: 0, enc: 4})),
    hostEdge: idx.map((i) => ({at: at(i), er: 20})),
    viewerEdge: idx.map((i) => ({at: at(i), er: bad(i) ? 200 : 20})),
    hostBusy: idx.map((i) => ({at: at(i), ltMs: i % 60 === 0 ? 60 : 0})), // one 60 ms task every 2 minutes
    viewerBusy: idx.map((i) => ({at: at(i), ltMs: 0})),
  }
  const result = diagnoseBottleneck(input)
  assert.equal(result.verdict, 'viewer-network')
  assert.ok(result.numbers.hostLongTaskMs < 5, `${result.numbers.hostLongTaskMs} ms per troubled sample`)
})

test('a computer is never blamed while the other side\'s link is full, whatever its own numbers say', () => {
  assert.equal(diagnoseBottleneck(session({viewerEdge: true, hostCpu: true})).verdict, 'viewer-network')
  assert.equal(diagnoseBottleneck(session({viewerEdge: true, slowEncode: true, hostLongTasks: true})).verdict, 'viewer-network')
  assert.equal(diagnoseBottleneck(session({hostEdge: true, slowDecode: true, viewerLongTasks: true})).verdict, 'host-upload')
})

test('one side measured and calm, the other not measured at all: says which one was not measured', () => {
  const input = session({hv: true})
  input.viewerEdge = []
  const result = diagnoseBottleneck(input)
  assert.equal(result.verdict, 'unclear')
  assert.match(result.reasons.join(';'), /viewer's own link was not measured, and the host's did not fill up/)
  assert.doesNotMatch(result.reasons.join(';'), /neither person's/)
  const other = session({hv: true})
  other.hostEdge = []
  assert.match(diagnoseBottleneck(other).reasons.join(';'), /host's own link was not measured, and the viewer's did not fill up/)
})
