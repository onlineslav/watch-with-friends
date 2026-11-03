import test from 'node:test'
import assert from 'node:assert/strict'
import {createActionWireManager} from '../node_modules/@trystero-p2p/core/dist/action-wire.mjs'
import {cleanMark, cleanTelemetry} from '../renderer/protocol.mjs'

// M1.9 adds one room action, 'mark', and one optional field on the 'telemetry' message ('at'). This is the
// compatibility check: two real wire managers (the dependency's own action layer, with the repo's
// patches) joined back to back, one a copy that registers 'mark' and one from before it existed.
function pair() {
  const managers = {}
  const end = (self, other) => createActionWireManager({
    getPeer: (peer => () => peer)({channel: null, sendData: (chunk) => managers[other].handleData(self, chunk)}),
    getPeerIds: () => [other],
    canReceiveFromPeer: () => true,
    throwIfAborted() {},
  })
  managers.a = end('a', 'b')
  managers.b = end('b', 'a')
  return managers
}

test('a copy from before marks drops a mark without any handler running, an error, or closing the connection', async () => {
  const errors = []
  const closed = []
  const toOlder = {channel: null, sendData: (chunk) => older.handleData('new', chunk)}
  const newer = createActionWireManager({getPeer: () => toOlder, getPeerIds: () => ['old'], canReceiveFromPeer: () => true, throwIfAborted() {}})
  const older = createActionWireManager({getPeer: () => ({connection: {close: () => closed.push(true)}}), getPeerIds: () => ['new'], canReceiveFromPeer: () => true, throwIfAborted() {}})
  const seen = []
  older.makeInternalAction('state').onMessage((value, peerId) => seen.push(['state', value, peerId]))
  older.makeInternalAction('react').onMessage((value) => seen.push(['react', value]))
  const send = {mark: newer.makeInternalAction('mark').send, state: newer.makeInternalAction('state').send, react: newer.makeInternalAction('react').send}
  const originalWarn = console.warn
  console.warn = (...args) => errors.push(args.join(' '))
  try {
    await send.mark({id: 'k3x9f2a1', note: 'audio crackles'})
    await send.mark({id: 'k3x9f2a1'})
    await send.state({hello: 1})
    await send.react({kind: 'clap'})
    await send.mark({id: 'z9y8x7w6', note: 'x'.repeat(80)})
    await send.state({hello: 2})
  } finally {
    console.warn = originalWarn
  }
  assert.deepEqual(seen, [['state', {hello: 1}, 'new'], ['react', {kind: 'clap'}], ['state', {hello: 2}, 'new']], 'everything else still arrives, in order')
  assert.deepEqual(closed, [], 'the connection is left alone')
  assert.deepEqual(errors, [], 'and nothing is warned or thrown')
  // And registering it later does not resurrect what was dropped (a late handler is not handed old marks).
  const late = []
  older.makeInternalAction('mark').onMessage((value) => late.push(value))
  assert.deepEqual(late, [])
})

test('two copies that both know marks deliver them, and the receiver checks them', async () => {
  const { a, b } = pair()
  const got = []
  b.makeInternalAction('mark').onMessage((value, peerId) => got.push([peerId, cleanMark(value)]))
  const send = a.makeInternalAction('mark').send
  await send({id: 'k3x9f2a1', note: '  audio   crackles '})
  await send({id: 'k3x9f2a1', note: 'audio crackles at 22s'})
  await send({id: 'BAD ID', note: 'x'}) // a hostile copy
  await send('not an object')
  assert.deepEqual(got, [
    ['a', {id: 'k3x9f2a1', note: 'audio crackles'}],
    ['a', {id: 'k3x9f2a1', note: 'audio crackles at 22s'}],
    ['a', null],
    ['a', null],
  ])
})

test('the telemetry report gains an optional stamp and an older host reads the report exactly as before', () => {
  const receiver = {lossPct: 0, freezes: 0, droppedFrames: 0, fps: 30, height: 720, bufferMs: 250, delayMs: 300}
  // What a 0.8.0 host does with the message: it reads message.receiver and ignores the rest.
  const message = {receiver, hostId: 'h', claimedAt: 1, at: 123456.5}
  assert.deepEqual(cleanTelemetry(message.receiver), receiver)
  assert.deepEqual(cleanTelemetry({...receiver, at: 5}), receiver, 'even a stray field inside it is dropped')
})
