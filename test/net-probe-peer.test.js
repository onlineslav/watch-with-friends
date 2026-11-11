const test = require('node:test')
const assert = require('node:assert/strict')
const {EventEmitter} = require('node:events')
const {addressKind, createNetProbe, hopEntry, hopHash, isIPv4, parseTraceroute, TRACE_EVERY_MS} = require('../main/net-probe')

function fakeProc() {
  const proc = new EventEmitter()
  proc.stdout = new EventEmitter()
  proc.stdin = {written: [], write(text) { this.written.push(text.trim()) }, on() {}}
  proc.kill = () => { proc.killed = true }
  return proc
}

function windowsProbe() {
  const records = []
  const proc = fakeProc()
  const timers = []
  const clock = {now: 0}
  const probe = createNetProbe({record: (...args) => records.push(args), binaryPath: () => 'x.exe', platform: 'win32',
    spawn: () => proc, exists: () => true, now: () => clock.now,
    setTimer: (fn, ms) => { const t = {fn, ms}; timers.push(t); return t }, clearTimer: (t) => { t.cleared = true }})
  const emit = (text) => proc.stdout.emit('data', Buffer.from(text))
  return {records, proc, timers, clock, probe, emit, traces: () => records.filter(([, e]) => e === 'trace').map(([, , d]) => d)}
}

test('address kinds and hop hashes never carry the address', () => {
  assert.equal(addressKind('192.168.1.1'), 'l')
  assert.equal(addressKind('10.0.0.1'), 'l')
  assert.equal(addressKind('172.20.3.4'), 'l')
  assert.equal(addressKind('172.32.0.1'), 'p')
  assert.equal(addressKind('100.64.0.1'), 'c')
  assert.equal(addressKind('100.128.0.1'), 'p')
  assert.equal(addressKind('8.8.8.8'), 'p')
  assert.equal(addressKind('fe80::1'), null)
  assert.match(hopHash('8.8.8.8'), /^[0-9a-f]{4}$/)
  assert.equal(hopHash('8.8.8.8'), hopHash('8.8.8.8'), 'the same router hashes the same on both sides')
  assert.notEqual(hopHash('8.8.8.8'), hopHash('8.8.4.4'))
  assert.deepEqual(hopEntry({ms: 12, address: '8.8.8.8'}), [12, 'p', hopHash('8.8.8.8')])
  assert.deepEqual(hopEntry({ms: null, address: null}), [null])
  assert.equal(isIPv4('1.2.3.4'), true)
  assert.equal(isIPv4('1.2.3.256'), false)
  assert.equal(isIPv4('abcd.local'), false)
})

test('traceroute output (macOS and Linux) becomes hops', () => {
  const text = 'traceroute to 1.0.0.1 (1.0.0.1), 20 hops max, 52 byte packets\n 1  192.168.1.1  2.345 ms\n 2  *\n 3  100.64.2.1  11.9 ms\n10  1.0.0.1  14.02 ms\n'
  assert.deepEqual(parseTraceroute(text), [
    {ttl: 1, ms: 2.3, address: '192.168.1.1'},
    {ttl: 2, ms: null, address: null},
    {ttl: 3, ms: 11.9, address: '100.64.2.1'},
    {ttl: 10, ms: 14, address: '1.0.0.1'},
  ])
  assert.deepEqual(parseTraceroute(''), [])
})

test('peers set before start are pinged once the helper runs; bad entries are left out', () => {
  const {probe, proc} = windowsProbe()
  probe.setPeers([{peer: 'abc', address: '203.0.113.5'}, {peer: 'v6', address: '2001:db8::1'}, {peer: 'bad id!', address: '1.2.3.4'}, {peer: 'm', address: 'x.local'}])
  assert.deepEqual(proc.stdin.written, [], 'nothing runs before start')
  probe.start()
  assert.deepEqual(proc.stdin.written, ['peer abc 203.0.113.5'])
  probe.setPeers([{peer: 'abc', address: '203.0.113.5'}])
  assert.equal(proc.stdin.written.length, 1, 'an unchanged list sends nothing')
  probe.setPeers([{peer: 'abc', address: '203.0.113.9'}])
  assert.deepEqual(proc.stdin.written.slice(1), ['peer abc -', 'peer abc 203.0.113.9'], 'a new address replaces the old')
  probe.setPeers([])
  assert.equal(proc.stdin.written.at(-1), 'peer abc -')
})

test('peer pings land in np.peer and a peer stall is logged with its id', () => {
  const {probe, emit, records, clock} = windowsProbe()
  probe.start()
  probe.setPeers([{peer: 'abc', address: '203.0.113.5'}])
  emit('p abc 20\np abc 22\n')
  clock.now = 200
  emit('p abc -1\n')
  clock.now = 400
  emit('p abc 21\n')
  assert.deepEqual(probe.take().peer, {abc: {n: 4, lost: 1, avg: 21, max: 22}})
  assert.deepEqual(records.find(([, e]) => e === 'probe-stall')[2], {on: 'peer', peer: 'abc', dur: 200, lost: 1, n: 1})
  emit('p zzz 5\n')
  assert.equal(probe.take(), null, 'a peer nobody asked for is ignored')
})

test('a baseline trace runs 5s after a peer is added, and hops are logged hashed', () => {
  const {probe, emit, proc, timers, traces} = windowsProbe()
  probe.start()
  probe.setPeers([{peer: 'abc', address: '203.0.113.5'}])
  assert.equal(timers[0].ms, 5000)
  timers[0].fn()
  assert.equal(proc.stdin.written.at(-1), 'trace abc')
  emit('hop abc 1 1 192.168.1.1\nhop abc 2 -1 *\nhop abc 3 14 203.0.113.5\ntrace-end abc 1\n')
  const [trace] = traces()
  assert.deepEqual(trace, {peer: 'abc', why: 'baseline', n: 3, reached: true, pinged: false,
    hops: [[1, 'l', hopHash('192.168.1.1')], [null], [14, 'p', hopHash('203.0.113.5')]]})
  assert.equal(JSON.stringify(trace).includes('203.0.113'), false, 'no address in the log line')
})

test('three bad pings after the peer has answered start a trace; traces are at most one a minute', () => {
  const {probe, emit, proc, clock} = windowsProbe()
  probe.start()
  probe.setPeers([{peer: 'abc', address: '203.0.113.5'}])
  emit('p abc -1\np abc -1\np abc -1\n')
  assert.equal(proc.stdin.written.includes('trace abc'), false, 'a peer that never answers pings is not a stall')
  emit('p abc 20\np abc 400\np abc -1\n')
  assert.equal(proc.stdin.written.includes('trace abc'), false)
  emit('p abc -1\n')
  assert.equal(proc.stdin.written.filter((l) => l === 'trace abc').length, 1)
  emit('trace-end abc 0\n')
  clock.now = 30_000
  assert.equal(probe.trouble('abc', 'loss'), false, 'too soon')
  clock.now = TRACE_EVERY_MS + 1
  assert.equal(probe.trouble('abc', 'loss'), true)
  assert.equal(probe.trouble('abc', 'loss'), false, 'one in flight')
})

test('trouble reasons are checked; unknown peers and a stopped probe do nothing', () => {
  const {probe, emit, records} = windowsProbe()
  assert.equal(probe.trouble('abc', 'loss'), false, 'not running')
  probe.start()
  probe.setPeers([{peer: 'abc', address: '203.0.113.5'}])
  assert.equal(probe.trouble('nobody', 'loss'), false)
  assert.equal(probe.trouble('abc', '<script>'), true)
  emit('trace-end abc 0\n')
  assert.equal(records.find(([, e]) => e === 'trace')[2].why, 'trouble')
  probe.stop()
  assert.equal(probe.trouble('abc', 'loss'), false)
})

test('on macOS each peer gets its own ping and traceroute runs through execFile', () => {
  const records = []
  const spawned = []
  const timers = []
  let traceArgs = null
  let finishTrace = null
  const probe = createNetProbe({record: (...args) => records.push(args), platform: 'darwin',
    spawn: (cmd, args) => { const proc = fakeProc(); proc.args = args; spawned.push(proc); return proc },
    execFile: (cmd, args, opts, cb) => { if (cmd.endsWith('traceroute')) { traceArgs = args; finishTrace = cb } },
    now: () => 0, setTimer: (fn, ms) => { const t = {fn, ms}; timers.push(t); return t }, clearTimer: () => {}})
  probe.start()
  probe.setPeers([{peer: 'abc', address: '203.0.113.5'}])
  const peerPing = spawned.find((p) => p.args.includes('203.0.113.5'))
  assert.ok(peerPing)
  peerPing.stdout.emit('data', Buffer.from('64 bytes from 203.0.113.5: icmp_seq=0 ttl=55 time=21.0 ms\n'))
  assert.deepEqual(probe.take().peer, {abc: {n: 1, avg: 21, max: 21}})
  timers[0].fn()
  assert.deepEqual(traceArgs.slice(-1), ['203.0.113.5'])
  finishTrace(null, ' 1  192.168.1.1  2.0 ms\n 2  203.0.113.5  20.1 ms\n')
  const trace = records.find(([, e]) => e === 'trace')[2]
  assert.equal(trace.reached, true)
  assert.equal(trace.n, 2)
  probe.setPeers([])
  assert.equal(peerPing.killed, true)
})
