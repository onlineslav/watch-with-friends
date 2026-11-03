import test from 'node:test'
import assert from 'node:assert/strict'
import {IntervalMeter, LongTaskTally, freshMachine, settingsTag, watchLongTasks} from '../renderer/machine.mjs'

test('LongTaskTally counts between samples and tells "none" from "cannot tell"', () => {
  const tally = new LongTaskTally()
  assert.equal(tally.take(), null, 'observer not installed: cannot tell')
  tally.supported = true
  assert.equal(tally.take(), 0, 'supported and quiet')
  tally.add([{duration: 64.4}, {duration: 180.2}, {duration: NaN}, null, {duration: -5}, {}])
  assert.deepEqual(tally.take(), {n: 2, ms: 245, max: 180})
  assert.equal(tally.take(), 0, 'taking resets')
})

test('watchLongTasks installs only where the browser supports long tasks', () => {
  const tally = new LongTaskTally()
  assert.equal(watchLongTasks(tally, undefined), false)
  assert.equal(watchLongTasks(tally, class { static supportedEntryTypes = ['mark'] }), false)
  assert.equal(tally.supported, false)
  let callback
  class Fake {
    static supportedEntryTypes = ['longtask']
    constructor(cb) { callback = cb }
    observe(options) { this.options = options }
  }
  assert.equal(watchLongTasks(tally, Fake), true)
  callback({getEntries: () => [{duration: 70}]})
  assert.deepEqual(tally.take(), {n: 1, ms: 70, max: 70})
  const broken = class { static supportedEntryTypes = ['longtask']; observe() { throw new Error('no') } }
  assert.equal(watchLongTasks(new LongTaskTally(), broken), false)
})

test('IntervalMeter reports mean and worst spacing, skips, and forgets the gap after a pause', () => {
  const meter = new IntervalMeter()
  assert.equal(meter.take(), null, 'nothing forwarded')
  for (const t of [1000, 1042, 1083, 1125, 1250]) meter.mark(t)
  meter.skip()
  assert.deepEqual(meter.take(), {n: 4, avg: 62.5, max: 125, busy: 1})
  meter.reset() // paused
  meter.mark(9000)
  meter.mark(9041)
  assert.deepEqual(meter.take(), {n: 1, avg: 41, max: 41, busy: null}, 'the pause is not a 7.7 s stall')
  meter.skip()
  assert.deepEqual(meter.take(), {n: 0, avg: null, max: null, busy: 1})
  meter.mark(8000) // clock went backwards: no negative gap
  assert.equal(meter.take(), null)
})

test('freshMachine drops a reading that is too old to belong to this sample', () => {
  const latest = {reading: {p: {m: [1, 2]}}, at: 1000}
  assert.deepEqual(freshMachine(latest, 5000), latest.reading)
  assert.equal(freshMachine(latest, 8000), null)
  assert.equal(freshMachine(null, 8000), null)
})

test('settingsTag keeps the share settings that explain a quality change', () => {
  assert.deepEqual(settingsTag({priority: 'text', audioBitrate: 510000, audioFirst: true}), {pri: 'text', ab: 510000, af: 1})
  assert.deepEqual(settingsTag({priority: 'balanced', audioBitrate: 128000, audioFirst: false}), {pri: 'balanced', ab: 128000, af: 0})
  assert.deepEqual(settingsTag({}), {pri: null, ab: null, af: 1})
})
