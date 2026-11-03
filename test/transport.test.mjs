import test from 'node:test'
import assert from 'node:assert/strict'
import {SharedPeerManager} from '../node_modules/@trystero-p2p/core/dist/shared-peer.mjs'
import {createActionWireManager} from '../node_modules/@trystero-p2p/core/dist/action-wire.mjs'
import {createReceiveBudget} from '../shared/receive-budget.mjs'
import {OfferPool, offerTtl} from '../node_modules/@trystero-p2p/core/dist/offer-pool.mjs'
import {createHandshakeManager} from '../node_modules/@trystero-p2p/core/dist/handshake.mjs'
import {createMediaIdentityCache, createMediaManager} from '../node_modules/@trystero-p2p/core/dist/media.mjs'
import createPeer from '../node_modules/@trystero-p2p/core/dist/peer.mjs'

// Just enough RTCPeerConnection for peer.mjs's offer/answer handling, with an open data channel
// (so this is renegotiation on a live connection, as when a host adds its film).
let offers = 0
class FakeConnection extends EventTarget {
  signalingState = 'stable'
  connectionState = 'connected'
  iceConnectionState = 'connected'
  iceGatheringState = 'complete'
  localDescription = null
  remoteDescription = null
  createDataChannel() { return {readyState: 'open', send() {}, close() {}} }
  async setLocalDescription(description) {
    if (description?.type === 'rollback') { this.signalingState = 'stable'; return }
    const type = this.signalingState === 'have-remote-offer' ? 'answer' : 'offer'
    this.localDescription = {type, sdp: `v=0 a=rtpmap:111 opus ${type} ${++offers}`}
    this.signalingState = type === 'offer' ? 'have-local-offer' : 'stable'
  }
  async setRemoteDescription(description) {
    if (description.type === 'answer') {
      if (this.signalingState !== 'have-local-offer') throw new Error('Called in wrong state: ' + this.signalingState)
      this.signalingState = 'stable'
    } else this.signalingState = 'have-remote-offer'
    this.remoteDescription = description
  }
  getSenders() { return [] }
  close() { this.connectionState = 'closed' }
}
const settle = () => new Promise((resolve) => setImmediate(resolve))

test('an offer whose answer never arrives is sent again, and a repeated answer is ignored', async (t) => {
  t.mock.timers.enable({apis: ['setTimeout']})
  const peer = createPeer(true, {rtcPolyfill: FakeConnection, trickleIce: true})
  const sent = []
  const errors = []
  peer.setHandlers({signal: (signal) => sent.push(signal), error: (error) => errors.push(error.message)})
  await settle()
  const offersSent = () => sent.filter((signal) => signal.type === 'offer')
  assert.equal(offersSent().length, 1, 'the offer goes out')
  t.mock.timers.tick(2999)
  await settle()
  assert.equal(offersSent().length, 1, 'not repeated straight away')
  t.mock.timers.tick(1)
  await settle()
  assert.equal(offersSent().length, 2, 'unanswered after 3s: sent again')
  assert.equal(offersSent()[1].sdp, offersSent()[0].sdp, 'the same offer')
  await peer.signal({type: 'answer', sdp: 'v=0 a=rtpmap:111 opus answer'})
  assert.equal(peer.connection.signalingState, 'stable')
  t.mock.timers.tick(60_000)
  await settle()
  assert.equal(offersSent().length, 2, 'answered: no more repeats')
  await peer.signal({type: 'answer', sdp: 'v=0 a=rtpmap:111 opus answer'}) // the repeat's answer
  assert.deepEqual(errors, [], 'a repeated answer is ignored, not an error that tears the connection down')
  peer.destroy()
})

test('an offer is repeated a few times at most', async (t) => {
  t.mock.timers.enable({apis: ['setTimeout']})
  const peer = createPeer(true, {rtcPolyfill: FakeConnection, trickleIce: true})
  const sent = []
  peer.setHandlers({signal: (signal) => sent.push(signal)})
  await settle()
  for (let i = 0; i < 20; i++) {
    t.mock.timers.tick(10_000)
    await settle()
  }
  assert.equal(sent.filter((signal) => signal.type === 'offer').length, 5, 'the offer and four repeats, then it stops')
  peer.destroy()
})

// A room's media manager over one shared connection, recording what reaches onPeerStream/onPeerTrack.
function mediaRoom() {
  const shared = {__trysteroMedia: createMediaIdentityCache()}
  const media = createMediaManager({iterate() {}, isActive: () => true, getSharedMediaPeer: () => shared})
  const streams = []
  const tracks = []
  media.onPeerStream = (stream, id, metadata) => streams.push({stream, id, metadata})
  media.onPeerTrack = (track, stream, id, metadata) => tracks.push({track, stream, id, metadata})
  return {media, streams, tracks}
}

test('a stream that arrives before its room has its metadata is still delivered (reused connection, new room)', () => {
  // Rejoining over a reused connection, the host's stream metadata for the new room can be held
  // until the room's token resolves while the tracks themselves arrive at once. The stream used
  // to be dropped, and the late metadata then waited for it forever: a viewer with no video.
  const {media, streams} = mediaRoom()
  const stream = {id: 'film'}
  media.receiveRemoteStream('host', stream) // video track
  media.receiveRemoteStream('host', stream) // audio track of the same stream
  assert.equal(streams.length, 0, 'nothing to deliver without metadata yet')
  media.receiveStreamMeta({k: 'key-1', s: 'film', m: {claimedAt: 1}}, 'host')
  assert.equal(streams.length, 1)
  assert.equal(streams[0].stream, stream)
  assert.deepEqual(streams[0].metadata, {claimedAt: 1})
})

test('streams are matched to their own metadata by id, not by arrival order', () => {
  const {media, streams} = mediaRoom()
  media.receiveStreamMeta({k: 'key-a', s: 'a', m: {claimedAt: 1}}, 'host')
  media.receiveStreamMeta({k: 'key-b', s: 'b', m: {claimedAt: 2}}, 'host')
  media.receiveRemoteStream('host', {id: 'b'})
  media.receiveRemoteStream('host', {id: 'a'})
  assert.deepEqual(streams.map(({stream, metadata}) => [stream.id, metadata.claimedAt]), [['b', 2], ['a', 1]])
})

test('metadata first, then the stream, still works the usual way', () => {
  const {media, streams} = mediaRoom()
  media.receiveStreamMeta({k: 'key-1', s: 'film', m: {claimedAt: 3}}, 'host')
  media.receiveRemoteStream('host', {id: 'film'})
  media.receiveRemoteStream('host', {id: 'film'}) // its second track: delivered once
  assert.deepEqual(streams.map(({stream, metadata}) => [stream.id, metadata.claimedAt]), [['film', 3]])
})

test('a single added track that arrives before its metadata is still delivered', () => {
  const {media, tracks} = mediaRoom()
  const stream = {id: 'film'}
  const track = {id: 'audio-2'}
  media.receiveRemoteTrack('host', track, stream)
  media.receiveTrackMeta({k: 'key-t', s: 'film', t: 'audio-2', m: {claimedAt: 4}}, 'host')
  assert.equal(tracks.length, 1)
  assert.equal(tracks[0].track, track)
  assert.equal(tracks[0].stream, stream)
})

function payload(type, body = [], {last = true, nonce = 0} = {}) {
  const out = new Uint8Array(36 + body.length)
  out.set(new TextEncoder().encode(type)); out[33] = nonce
  out[34] = 4 | Number(last); out[35] = last ? 255 : 0
  out.set(body, 36)
  return out.buffer
}
function wrap(token, data) {
  const bytes = new TextEncoder().encode(token)
  const frame = new Uint8Array(3 + bytes.length + data.byteLength)
  frame[0] = 1; frame[2] = bytes.length; frame.set(bytes, 3); frame.set(new Uint8Array(data), 3 + bytes.length)
  return frame.buffer
}

test('shared friend connection does not replay departed-room frames into a rejoin', async () => {
  const manager = new SharedPeerManager()
  const peer = {created: 0, isDead: false, connection: {}, setHandlers() {}, sendData() {}, removeStream() {}, removeTrack() {}}
  const shared = manager.register('app', 'peer', peer, 100)
  manager.bind('friends', Promise.resolve('friends'), shared, {onDetach() {}})
  const old = manager.bind('watch', Promise.resolve('watch'), shared, {onDetach() {}})
  await Promise.resolve()
  old.proxy.destroy()
  manager.dispatchData(shared, wrap('watch', payload('@_leave')))
  manager.dispatchData(shared, wrap('watch', payload('state', [1, 2])))
  assert.equal(shared.pendingDataByToken.size, 0)
  const next = manager.bind('watch', Promise.resolve('watch'), shared, {onDetach() {}})
  const received = []
  next.proxy.setHandlers({data: (data) => received.push(data)})
  await Promise.resolve()
  assert.equal(received.length, 0)
  manager.dispatchData(shared, wrap('watch', payload('state', [3])))
  assert.equal(received.length, 1)
  assert.ok(shared.bindings.friends)
  manager.clear('app', 'peer', {destroyPeer: false})
})

test('early leave frames cannot eject a peer during the new room handshake', () => {
  let active = false, leaves = 0
  const wire = createActionWireManager({getPeer: () => ({}), getPeerIds: () => ['p'], canReceiveFromPeer: (_id, pending) => active || pending, throwIfAborted() {}})
  const action = wire.makeInternalAction('@_leave', {receiveWhilePending: true})
  action.onMessage(() => leaves++)
  wire.handleData('p', payload('@_leave'))
  assert.equal(leaves, 0)
  active = true
  wire.handleData('p', payload('@_leave'))
  assert.equal(leaves, 1)
})

test('receive budget caps bytes, concurrent transfers and expires abandoned chunks', () => {
  let now = 0
  const expired = []
  const budget = createReceiveBudget((...args) => expired.push(args), {now: () => now, idleMs: 10, perPeer: 100, total: 150})
  assert.ok(budget.accept('p', 'image', 0, 80, false))
  assert.equal(budget.accept('p', 'image', 0, 21, false), false)
  assert.equal(budget.accept('q', 'image', 0, 80, false), false)
  now = 11; budget.sweep()
  assert.deepEqual(expired, [['p', 'image', 0]])
  assert.ok(budget.accept('q', 'image', 0, 80, true))
  for (let i = 0; i < 8; i++) assert.ok(budget.accept('q', 'state', i, 0, false))
  assert.equal(budget.accept('q', 'state', 9, 0, false), false)
  budget.clearPeer('q')
})

test('wire rejects oversized state during assembly and unknown actions are discarded', () => {
  let closed = 0, complete = 0
  const wire = createActionWireManager({getPeer: () => ({connection: {close: () => closed++}}), getPeerIds: () => ['p'], canReceiveFromPeer: () => true, throwIfAborted() {}})
  wire.makeInternalAction('state').onMessage(() => complete++)
  const chunk = new Uint8Array(16000)
  for (let i = 0; i < 17; i++) wire.handleData('p', payload('state', chunk, {last: false}))
  assert.equal(closed, 1)
  assert.equal(complete, 0)
  wire.handleData('p', payload('unknown', [1, 2]))
  wire.makeInternalAction('unknown').onMessage(() => complete++)
  assert.equal(complete, 0)
  wire.clearPeer('p')
})

test('empty chunks cannot build an unlimited reassembly array', () => {
  const budget = createReceiveBudget(() => {})
  for (let i = 0; i < 8192; i++) assert.ok(budget.accept('p', 'image', 0, 0, false))
  assert.equal(budget.accept('p', 'image', 0, 0, false), false)
  budget.clearPeer('p')
})

test('handshake queues reject excessive messages before room admission', () => {
  let failures = 0
  const manager = createHandshakeManager({onFailure(id, _peer, error) { failures++; manager.clearPeer(id, error) }})
  manager.addPeer('p', {})
  for (let i = 0; i < 9; i++) manager.receiveHandshakeData({}, 'p')
  assert.equal(failures, 1)
  assert.equal(manager.canReceiveFromPeer('p', true), false)
})

function reconnectPeer() {
  return {
    created: 0, isDead: false, connection: {connectionState: 'connected'}, channel: {readyState: 'open'},
    setHandlers(handlers) { this.handlers = handlers }, sendData() {},
    destroy() { this.isDead = true; this.connection.connectionState = 'closed'; this.handlers?.close?.() },
  }
}

test('replacing the last shared connection keeps its replacement discoverable by other rooms', () => {
  const manager = new SharedPeerManager()
  const oldPeer = reconnectPeer()
  manager.register('app', 'friend', oldPeer, 100)
  const replacement = manager.register('app', 'friend', reconnectPeer(), 100)
  assert.equal(oldPeer.isDead, true, 'replaced connection must still be destroyed')
  assert.equal(manager.get('app', 'friend'), replacement, 'replacement must remain in the shared peer registry')
  manager.clear('app', 'friend', {destroyPeer: true})
  assert.equal(manager.get('app', 'friend'), undefined)
  assert.deepEqual(Object.keys(manager.getMap('app')), [])
})

test('rooms retain a live registry after the last peer leaves and a new connection arrives', () => {
  const manager = new SharedPeerManager()
  const roomRegistry = manager.getMap('app')
  manager.register('app', 'old-friend', reconnectPeer(), 100)
  manager.clear('app', 'old-friend', {destroyPeer: true})
  const reconnected = manager.register('app', 'new-friend', reconnectPeer(), 100)
  assert.equal(manager.getMap('app'), roomRegistry, 'existing room contexts must keep the same registry')
  assert.equal(roomRegistry['new-friend'], reconnected)
  manager.clear('app', 'new-friend', {destroyPeer: true})
  assert.deepEqual(Object.keys(roomRegistry), [], 'preserving the registry must not retain departed peers')
})

test('pooled offers older than offerTtl are replaced, never regenerated with an ICE restart', async () => {
  const peers = []
  const make = (age) => {
    const peer = {
      created: Date.now() - age, dead: false, offerCalls: [],
      get isDead() { return this.dead },
      destroy() { this.dead = true },
      connection: {remoteDescription: null},
      setHandlers() {},
      async getOffer(restart) { this.offerCalls.push(restart); return {type: 'offer', sdp: 'x'} },
    }
    peers.push(peer)
    return peer
  }
  let fresh = null
  const pool = new OfferPool(() => (fresh = make(0)))
  const stale = make(offerTtl + 1000)
  const young = make(1000)
  pool.active = true
  pool.push(stale)
  pool.push(young)
  const records = await pool.checkout(2, false, async (peer) => peer.getOffer())
  assert.equal(stale.dead, true, 'stale peer must be destroyed')
  assert.deepEqual(stale.offerCalls, [], 'stale peer must never be asked for an offer')
  assert.equal(records[0].peer, young)
  assert.equal(records[1].peer, fresh, 'a fresh peer replaces the stale one')
  assert.notEqual(records[1].peer, stale)
  pool.recycle(young)
  const stale2 = make(offerTtl + 1000)
  pool.recycle(stale2)
  assert.equal(stale2.dead, true, 'stale leased peers are destroyed, not ICE-restarted')
  assert.deepEqual(stale2.offerCalls, [])
  await new Promise((r) => setImmediate(r))
  assert.ok(!young.offerCalls.includes(true), 'no recycled peer is restarted')
  pool.destroy()
})

// A connection given up on after 5s "disconnected" must be closed, not just reported: on a shared
// connection nobody else closes it, so it recovered a moment later with this side's rooms gone and
// the other side still treating us as present (a viewer stuck on a frozen frame for 9 minutes).
function dropConnection(peer) {
  peer.connection.connectionState = 'disconnected'
  peer.connection.iceConnectionState = 'disconnected'
  peer.connection.onconnectionstatechange()
}

test('a connection still disconnected after 5s is closed, so the other side drops us too', async (t) => {
  t.mock.timers.enable({apis: ['setTimeout']})
  const peer = createPeer(true, {rtcPolyfill: FakeConnection, trickleIce: true})
  let closes = 0
  peer.setHandlers({signal() {}, close: () => closes++})
  await settle()
  dropConnection(peer)
  t.mock.timers.tick(4999)
  assert.equal(closes, 0, 'not given up on before 5s')
  assert.notEqual(peer.connection.connectionState, 'closed')
  t.mock.timers.tick(1)
  assert.equal(closes, 1, 'rooms are told once')
  assert.equal(peer.connection.connectionState, 'closed', 'and the connection itself is closed, not left to recover unowned')
  peer.destroy()
  assert.equal(closes, 1, 'destroying afterwards does not report a second close')
})

test('a connection that recovers within 5s is kept', async (t) => {
  t.mock.timers.enable({apis: ['setTimeout']})
  const peer = createPeer(true, {rtcPolyfill: FakeConnection, trickleIce: true})
  let closes = 0
  peer.setHandlers({signal() {}, close: () => closes++})
  await settle()
  dropConnection(peer)
  t.mock.timers.tick(2400)
  peer.connection.connectionState = 'connected'
  peer.connection.iceConnectionState = 'connected'
  peer.connection.onconnectionstatechange()
  t.mock.timers.tick(60_000)
  assert.equal(closes, 0)
  assert.equal(peer.connection.connectionState, 'connected')
  peer.destroy()
})

test('a shared connection given up on is closed and every room on it drops the peer', async (t) => {
  t.mock.timers.enable({apis: ['setTimeout']})
  const manager = new SharedPeerManager()
  const peer = createPeer(true, {rtcPolyfill: FakeConnection, trickleIce: true})
  const shared = manager.register('app', 'friend', peer, 100_000)
  const left = []
  for (const room of ['pair', 'media']) {
    manager.bind(room, Promise.resolve(`${room}-token`), shared, {onDetach() {}}).proxy.setHandlers({close: () => left.push(room)})
  }
  await settle()
  dropConnection(peer)
  t.mock.timers.tick(5000)
  assert.deepEqual(left.sort(), ['media', 'pair'])
  assert.equal(peer.connection.connectionState, 'closed')
  assert.equal(manager.get('app', 'friend'), undefined)
})
