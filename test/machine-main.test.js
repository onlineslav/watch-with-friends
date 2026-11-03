const test = require('node:test')
const assert = require('node:assert/strict')
const {createSampler, describeDisplays, describeGpu, readMachine, summarizeMetrics} = require('../main/machine')

const metrics = [
  {pid: 1, type: 'Browser', cpu: {percentCPUUsage: 3.456}, memory: {workingSetSize: 204800}},
  {pid: 2, type: 'Tab', cpu: {percentCPUUsage: 20.04}, memory: {workingSetSize: 512000}},
  {pid: 3, type: 'GPU', cpu: {percentCPUUsage: 7}, memory: {workingSetSize: 102400}},
  {pid: 4, type: 'Utility', cpu: {percentCPUUsage: 1}, memory: {workingSetSize: 51200}},
  {pid: 5, type: 'Utility', cpu: {percentCPUUsage: 0.5}, memory: {workingSetSize: 51200}},
  {pid: 6, type: 'Tab', cpu: {percentCPUUsage: 1}, memory: {workingSetSize: 1024}},
]

test('summarizeMetrics groups processes into main, renderer, GPU and other', () => {
  assert.deepEqual(summarizeMetrics(metrics), {m: [3.5, 200], r: [21, 501], g: [7, 100], o: [1.5, 100, 2]})
})

test('summarizeMetrics tolerates missing or malformed process data', () => {
  assert.deepEqual(summarizeMetrics(undefined), {})
  assert.deepEqual(summarizeMetrics([null, {type: 'Tab'}, {type: 'GPU', cpu: {percentCPUUsage: 'x'}, memory: {}}]), {r: [0, 0], g: [0, 0], o: [0, 0, 1]})
  assert.ok(!JSON.stringify(summarizeMetrics([{type: 'Tab', cpu: {percentCPUUsage: NaN}, memory: {workingSetSize: undefined}}])).match(/NaN|null/))
})

test('readMachine adds battery, thermal state, free memory and the CPU limit, leaving out what the platform lacks', () => {
  const full = readMachine({
    getMetrics: () => metrics,
    systemMemory: () => ({free: 4_194_304}),
    power: {isOnBatteryPower: () => true, getCurrentThermalState: () => 'serious', speedLimit: () => 80},
  })
  assert.deepEqual({...full, p: undefined}, {p: undefined, free: 4096, bat: 1, th: 'serious', lim: 80})
  const bare = readMachine({
    getMetrics: () => [],
    systemMemory: () => { throw new Error('unsupported') },
    power: {isOnBatteryPower: () => { throw new Error('no') }, getCurrentThermalState: () => 'unknown', speedLimit: () => null},
  })
  assert.deepEqual(bare, {p: {}}, 'unknown thermal state, no limit and failing probes are all left out')
  assert.deepEqual(readMachine({getMetrics: () => [], power: {isOnBatteryPower: () => false}}), {p: {}, bat: 0})
})

test('the sampler primes immediately, repeats on a timer, stops cleanly and survives a failing reading', () => {
  const sent = []
  const timers = []
  let fail = false
  const sampler = createSampler({
    deps: {getMetrics: () => { if (fail) throw new Error('metrics gone'); return metrics }},
    send: (reading) => sent.push(reading),
    setTimer: (fn, ms) => { const t = {fn, ms, unref() {}}; timers.push(t); return t },
    clearTimer: (t) => { t.cleared = true },
  })
  sampler.start()
  sampler.start() // idempotent
  assert.equal(sent.length, 1)
  assert.equal(timers.length, 1)
  assert.equal(timers[0].ms, 2000)
  timers[0].fn()
  assert.equal(sent.length, 2)
  fail = true
  assert.doesNotThrow(() => timers[0].fn())
  assert.equal(sent.length, 2)
  assert.ok(sampler.running)
  sampler.stop()
  assert.ok(timers[0].cleared)
  assert.ok(!sampler.running)
  sampler.stop()
})

test('describeGpu and describeDisplays give the once-per-session facts compactly', () => {
  const gpu = describeGpu({video_decode: 'enabled', webgl: 'enabled'}, {gpuDevice: [{active: true, vendorId: 4318, deviceId: 9348, deviceString: 'NVIDIA GeForce', driverVersion: '31.0.15.3623'}, {active: false, vendorId: 32902}]})
  assert.deepEqual(gpu.devices[0], {act: 1, ven: 4318, dev: 9348, name: 'NVIDIA GeForce', drv: '31.0.15.3623'})
  assert.equal(gpu.devices[1].act, 0)
  assert.deepEqual(describeGpu(null, null), {features: null, devices: []})
  assert.deepEqual(describeDisplays([{id: 1, displayFrequency: 144, size: {width: 2560, height: 1440}, scaleFactor: 1.5}, {id: 2, size: {width: 1920, height: 1080}, scaleFactor: 1}], 1), [
    {hz: 144, w: 2560, h: 1440, sf: 1.5, primary: 1},
    {hz: null, w: 1920, h: 1080, sf: 1, primary: 0},
  ])
  assert.deepEqual(describeDisplays(undefined, 1), [])
})
