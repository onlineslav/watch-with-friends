'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {createPriorityBoost} = require('../main/priority')

const RAISED = -7
const NORMAL = 0

function harness({platform = 'win32', pids = [10, 11, 12], deny = []} = {}) {
  const priorities = new Map(pids.map((pid) => [pid, NORMAL]))
  const logs = []
  let tick = null
  let cleared = false
  let clock = 0
  const state = {pids}
  const boost = createPriorityBoost({
    platform,
    getMetrics: () => state.pids.map((pid) => ({pid, type: 'Tab'})),
    getPriority: (pid) => {
      if (deny.includes(pid)) throw new Error('EACCES')
      return priorities.get(pid) ?? NORMAL
    },
    setPriority: (pid, value) => {
      if (deny.includes(pid)) throw new Error('EACCES')
      priorities.set(pid, value)
    },
    raised: RAISED,
    normal: NORMAL,
    record: (scope, event, data) => logs.push({scope, event, data}),
    now: () => clock,
    setTimer: (fn) => { tick = fn; return {unref() {}} },
    clearTimer: () => { cleared = true },
  })
  return {
    boost, priorities, logs, state,
    tick: () => tick(),
    advance: (ms) => { clock += ms },
    get cleared() { return cleared },
  }
}

test('raises every app process on Windows and restores them on stop', () => {
  const h = harness()
  assert.deepEqual(h.boost.start(), {n: 3, set: 3, failed: 0})
  assert.ok(h.boost.active)
  assert.deepEqual([...h.priorities.values()], [RAISED, RAISED, RAISED])
  h.boost.stop()
  assert.ok(h.cleared)
  assert.equal(h.boost.active, false)
  assert.deepEqual([...h.priorities.values()], [NORMAL, NORMAL, NORMAL])
  assert.deepEqual(h.logs.map((l) => l.data), [{on: true, n: 3, set: 3, failed: 0}, {on: false, restored: 3}])
})

test('does nothing off Windows (raising needs root on macOS and Linux)', () => {
  const h = harness({platform: 'darwin'})
  assert.equal(h.boost.start(), null)
  assert.equal(h.boost.active, false)
  assert.deepEqual([...h.priorities.values()], [NORMAL, NORMAL, NORMAL])
  h.boost.stop()
  assert.deepEqual(h.logs, [])
})

test('re-applying catches new processes and resets, and leaves raised ones alone', () => {
  const h = harness()
  h.boost.start()
  assert.deepEqual(h.boost.apply(), {n: 3, set: 0, failed: 0})
  h.state.pids = [10, 11, 12, 13]
  h.priorities.set(11, NORMAL) // something reset it
  h.tick()
  assert.equal(h.priorities.get(13), RAISED)
  assert.equal(h.priorities.get(11), RAISED)
})

test('a process that is gone is not restored, and a refused one is counted', () => {
  const h = harness({deny: [12]})
  assert.deepEqual(h.boost.start(), {n: 3, set: 2, failed: 1})
  h.state.pids = [10]
  h.tick()
  h.priorities.set(11, RAISED) // still raised but no longer ours
  h.boost.stop()
  assert.equal(h.priorities.get(10), NORMAL)
  assert.equal(h.priorities.get(11), RAISED)
  assert.deepEqual(h.logs.at(-1).data, {on: false, restored: 1})
})

test('logs the first pass and changes, not every re-apply', () => {
  const h = harness()
  h.boost.start()
  for (let i = 0; i < 5; i++) { h.advance(2000); h.tick() }
  assert.equal(h.logs.length, 1)
  h.state.pids = [10, 11, 12, 14]
  h.advance(2000); h.tick() // a new process inside the minute: raised, not logged
  assert.equal(h.logs.length, 1)
  h.state.pids = [10, 11, 12, 14, 15]
  h.advance(60_000); h.tick()
  assert.equal(h.logs.length, 2)
  assert.deepEqual(h.logs[1].data, {on: true, n: 5, set: 1, failed: 0})
})

test('start twice keeps one timer; a broken metrics call raises nothing', () => {
  const h = harness()
  h.boost.start()
  assert.equal(h.boost.start(), null)
  const broken = createPriorityBoost({platform: 'win32', getMetrics: () => { throw new Error('x') }, setTimer: () => ({}), clearTimer: () => {}})
  assert.deepEqual(broken.start(), {n: 0, set: 0, failed: 0})
})
