const test = require('node:test')
const assert = require('node:assert/strict')
const {EventEmitter} = require('node:events')
const {createNetProbe, createPingParser, createProbeStats, parseRoute} = require('../main/net-probe')
const {readMachine} = require('../main/machine')

test('probe stats summarise each target and reset on take', () => {
  const stats = createProbeStats()
  assert.equal(stats.take(), null)
  for (const ms of [2, 4, 3]) stats.add('gw', ms, 0)
  stats.add('net', 20, 0)
  stats.add('net', null, 0)
  assert.deepEqual(stats.take(), {gw: {n: 3, avg: 3, max: 4}, net: {n: 2, lost: 1, avg: 20, max: 20}})
  assert.equal(stats.take(), null)
  stats.add('net', null, 0)
  assert.deepEqual(stats.take(), {net: {n: 1, lost: 1}}, 'all lost: no average or maximum, never 0')
})

test('a run of slow or lost probes is one stall, reported when a good probe ends it', () => {
  const stalls = []
  const stats = createProbeStats({onStall: (stall) => stalls.push(stall)})
  stats.add('gw', 2, 0)
  stats.add('gw', 400, 200)
  stats.add('gw', null, 400)
  stats.add('gw', 880, 1400)
  assert.equal(stalls.length, 0, 'still going')
  stats.add('gw', 3, 1600)
  assert.deepEqual(stalls, [{t: 'gw', dur: 1400, ms: 880, lost: 1, n: 3}])
  stats.add('net', null, 0)
  stats.add('net', 10, 1000)
  assert.deepEqual(stalls[1], {t: 'net', dur: 1000, lost: 1, n: 1}, 'all lost: no ms')
})

test('a stall that never ends is still reported every ten seconds', () => {
  const stalls = []
  const stats = createProbeStats({onStall: (stall) => stalls.push(stall)})
  for (let at = 0; at <= 21_000; at += 1000) stats.add('net', null, at) // 0-10s, then 11-21s
  assert.equal(stalls.length, 2)
  assert.equal(stalls[0].dur, 10_000)
})

test('ping parser: replies, skipped sequence numbers and silence become probes', () => {
  const probes = []
  const parser = createPingParser({onProbe: (ms) => probes.push(ms), interval: 200, late: 1000})
  parser.line('PING 1.1.1.1 (1.1.1.1): 56 data bytes', 0)
  parser.line('64 bytes from 1.1.1.1: icmp_seq=0 ttl=57 time=12.345 ms', 10)
  parser.line('Request timeout for icmp_seq 1', 200)
  parser.line('64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=300.1 ms', 500)
  parser.line('64 bytes from 1.1.1.1: icmp_seq=4 ttl=57 time=11 ms', 810)
  assert.deepEqual(probes, [12.3, 300.1, null, null, 11], 'a slow reply after a timeout line still counts; 2 and 3 were skipped')
  parser.tick(1500)
  assert.equal(probes.length, 5, 'nothing overdue yet')
  parser.tick(2410) // seq 5..7 sent at 1010, 1210, 1410: each is overdue a second later
  assert.deepEqual(probes.slice(5), [null, null, null])
  parser.line('64 bytes from 1.1.1.1: icmp_seq=6 ttl=57 time=1300 ms', 2420)
  assert.equal(probes.length, 8, 'a reply already counted lost is not counted again')
  parser.line('64 bytes from 1.1.1.1: icmp_seq=8 ttl=57 time=9 ms', 2430)
  assert.deepEqual(probes.slice(8), [9])
})

test('ping parser reads Linux output too', () => {
  const probes = []
  const parser = createPingParser({onProbe: (ms) => probes.push(ms)})
  parser.line('64 bytes from 192.168.1.1: icmp_seq=1 ttl=64 time=0.412 ms', 0)
  parser.line('64 bytes from 192.168.1.1: icmp_seq=2 ttl=64 time=1.03 ms', 200)
  assert.deepEqual(probes, [0.4, 1])
})

test('route output gives the gateway', () => {
  assert.equal(parseRoute('   route to: default\ndestination: default\n    gateway: 192.168.18.1\n  interface: en0\n'), '192.168.18.1')
  assert.equal(parseRoute('route: writing to routing socket: not in table'), null)
})

test('the machine reading carries the probes only when there are some', () => {
  const base = {getMetrics: () => [], systemMemory: () => ({}), power: {}}
  assert.equal('np' in readMachine({...base, netProbe: () => null}), false)
  assert.deepEqual(readMachine({...base, netProbe: () => ({gw: {n: 10, avg: 1, max: 2}})}).np, {gw: {n: 10, avg: 1, max: 2}})
  assert.equal('np' in readMachine({...base, netProbe: () => { throw new Error('x') }}), false)
})

function fakeProc() {
  const proc = new EventEmitter()
  proc.stdout = new EventEmitter()
  proc.kill = () => { proc.killed = true }
  return proc
}

test('on Windows the helper lines feed the stats and a stall is logged', () => {
  const records = []
  const proc = fakeProc()
  let clock = 0
  const probe = createNetProbe({record: (...args) => records.push(args), binaryPath: () => 'x.exe', platform: 'win32',
    spawn: () => proc, exists: () => true, now: () => clock})
  probe.start()
  probe.start()
  proc.stdout.emit('data', Buffer.from('gw 1\nnet 13\ngw -1\nne'))
  clock = 600
  proc.stdout.emit('data', Buffer.from('t 14\ngw 2\n'))
  assert.deepEqual(probe.take(), {gw: {n: 3, lost: 1, avg: 1.5, max: 2}, net: {n: 2, avg: 13.5, max: 14}})
  assert.deepEqual(records.find(([, event]) => event === 'probe-stall'), ['network', 'probe-stall', {t: 'gw', dur: 600, lost: 1, n: 1}, 'warn'])
  probe.stop()
  assert.equal(proc.killed, true)
})

test('a missing Windows helper is logged, not thrown', () => {
  const records = []
  const probe = createNetProbe({record: (...args) => records.push(args), binaryPath: () => 'x.exe', platform: 'win32', exists: () => false})
  probe.start()
  assert.equal(records[0][1], 'probe-failed')
  assert.equal(probe.take(), null)
})
