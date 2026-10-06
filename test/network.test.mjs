import test from 'node:test'
import assert from 'node:assert/strict'
import {createNetwork, deadline} from '../renderer/network.mjs'

class Peer extends EventTarget {
  constructor(config) { super(); this.config = config; this.restarts = 0; this.connectionState = 'connected' }
  getConfiguration() { return this.config }
  setConfiguration(config) { this.config = config }
  restartIce() { this.restarts++ }
  close() { this.connectionState = 'closed' }
}
const ice = (credential) => [{urls: 'turn:relay.example:3478', username: 'viewer', credential}]

test('relay renewal updates live connections and pooled constructors while preserving STUN', async () => {
  let now = 0, calls = 0, value = {iceServers: ice('first'), expiresAt: 100000}
  const network = createNetwork({getIceServers: async () => { calls++; return value }, PeerConnection: Peer, now: () => now})
  try {
    await network.ready
    const config = network.config()
    const live = new config.rtcPolyfill({iceServers: [{urls: 'stun:stun.example'}, ...ice('stale')]})
    assert.deepEqual(live.config.iceServers, [{urls: 'stun:stun.example'}, ...ice('first')])
    value = {iceServers: ice('second'), expiresAt: 200000}
    await Promise.all([network.refresh(), network.refresh()])
    assert.equal(calls, 2)
    assert.deepEqual(live.config.iceServers.at(-1), ice('second')[0])
    assert.equal(live.restarts, 1)
    const pooled = new config.rtcPolyfill({iceServers: config.turnConfig})
    assert.deepEqual(pooled.config.iceServers, ice('second'))
    value = {error: 'Temporary failure'}
    await network.refresh()
    assert.deepEqual(network.config().turnConfig, ice('second'))
    now = 200001
    await network.refresh()
    assert.deepEqual(network.config().turnConfig, [])
    assert.deepEqual(live.config.iceServers, [{urls: 'stun:stun.example'}])
    assert.deepEqual(pooled.config.iceServers, [])
    live.close(); pooled.close()
  } finally { network.stop() }
})

test('reconnect restarts interrupted peers and stop discards late relay responses', async () => {
  let resolve
  const network = createNetwork({getIceServers: () => [], PeerConnection: Peer})
  try {
    await network.ready
    const pc = new network.PeerConnection()
    pc.connectionState = 'disconnected'
    await network.reconnect()
    assert.equal(pc.restarts, 1)
    pc.close()
  } finally { network.stop() }
  const pending = createNetwork({getIceServers: () => new Promise((done) => { resolve = done }), PeerConnection: Peer})
  await Promise.resolve()
  pending.stop()
  resolve({iceServers: ice('late'), expiresAt: Date.now() + 100000})
  await pending.ready
  assert.deepEqual(pending.config().turnConfig, [])
  await assert.rejects(deadline(new Promise(() => {}), 5), /did not respond/)
})

test('connection diagnostics distinguish negotiation from ICE failures without copying credentials or SDP', async () => {
  const events = []
  const network = createNetwork({getIceServers: () => ice('private-credential'), PeerConnection: Peer,
    record: (event, data) => events.push({event, ...data})})
  try {
    await network.ready
    const pc = new network.PeerConnection()
    assert.equal(events[0].remoteDescription, false)
    assert.equal(events[0].hasTurn, true)
    pc.remoteDescription = {type: 'answer', sdp: 'private SDP 192.168.1.14'}
    pc.iceConnectionState = 'checking'
    pc.connectionState = 'connecting'
    pc.dispatchEvent(new Event('signalingstatechange'))
    assert.equal(events.at(-1).remoteDescription, true)
    assert.equal(events.at(-1).iceState, 'checking')
    const count = events.length
    pc.dispatchEvent(new Event('iceconnectionstatechange'))
    assert.equal(events.length, count, 'duplicate state events do not fill the log')
    pc.iceConnectionState = pc.connectionState = 'failed'
    pc.dispatchEvent(new Event('connectionstatechange'))
    assert.equal(events.at(-1).connectionState, 'failed')
    const error = new Event('icecandidateerror')
    Object.assign(error, {errorCode: 701, errorText: 'STUN request timed out'})
    pc.dispatchEvent(error)
    assert.deepEqual(events.at(-1), {event: 'ice-error', connection: events[0].connection, code: 701, message: 'STUN request timed out'})
    assert.ok(!/private|192\.168/.test(JSON.stringify(events)), 'only state and candidate errors are recorded')
    pc.close()
  } finally { network.stop() }
})
