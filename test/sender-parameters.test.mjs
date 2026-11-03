import test from 'node:test'
import assert from 'node:assert/strict'
import {applySenderParameters} from '../renderer/sender-parameters.mjs'

const invalid = () => Object.assign(new Error('Attempted to set RtpParameters with modified RTCP parameters'), {name: 'InvalidModificationError'})
function sender(failures = []) {
  const log = {reads: 0, sets: []}
  let generation = 0
  return {log, getParameters() { log.reads++; return {encodings: [{maxBitrate: 1}], generation} },
    async setParameters(params) {
      log.sets.push(params.generation)
      const failure = failures.shift()
      if (failure) { generation++; throw failure }
    }}
}
const raise = (params) => { params.encodings[0].maxBitrate = 9; return true }

test('sets once when nothing interferes', async () => {
  const s = sender()
  assert.deepEqual(await applySenderParameters(s, raise), {changed: true, retried: false})
  assert.equal(s.log.sets.length, 1)
})

test('does not set when the edit finds nothing to change', async () => {
  const s = sender()
  assert.deepEqual(await applySenderParameters(s, () => false), {changed: false, retried: false})
  assert.equal(s.log.sets.length, 0)
})

test('an InvalidModificationError re-reads the parameters and sets again', async () => {
  const s = sender([invalid()])
  const first = s.getParameters()
  const result = await applySenderParameters(s, raise, first)
  assert.deepEqual(result, {changed: true, retried: true})
  assert.deepEqual(s.log.sets, [0, 1], 'the second try used parameters read after the failure')
})

test('only one retry, then the error reaches the caller', async () => {
  const s = sender([invalid(), invalid()])
  await assert.rejects(applySenderParameters(s, raise), {name: 'InvalidModificationError'})
  assert.equal(s.log.sets.length, 2)
})

test('other errors are not retried', async () => {
  const s = sender([Object.assign(new Error('x'), {name: 'OperationError'})])
  await assert.rejects(applySenderParameters(s, raise), {name: 'OperationError'})
  assert.equal(s.log.sets.length, 1)
})

test('a retry that finds the sender already right stops without setting', async () => {
  const s = sender([invalid()])
  let calls = 0
  const result = await applySenderParameters(s, (params) => (++calls === 1 ? raise(params) : false))
  assert.deepEqual(result, {changed: false, retried: true})
})
