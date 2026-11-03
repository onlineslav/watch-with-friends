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
// (so this is renegotiation on a live connection, as when a host adds its film). It follows the
// browser's signalling rules: every call is refused in a state the spec refuses it in, and calls run
// one at a time in order, each taking a few turns of the event loop, so a remote offer can arrive
// between a createOffer() and the setLocalDescription() that follows it, as it does in Chromium.
let offers = 0
const fakeSdp = (type) => ['v=0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=rtpmap:111 opus/48000/2', 'a=fmtp:111 minptime=10;useinbandfec=1', `a=x-test:${type}:${++offers}`, ''].join('\r\n')
class FakeConnection extends EventTarget {
  static slow = false // each call takes a turn of the event loop, so signals cross in transit
  #signalingState = 'stable'
  get signalingState() { return this.#signalingState }
  set signalingState(next) {
    if (next === this.#signalingState) return
    this.#signalingState = next
    this.dispatchEvent(new Event('signalingstatechange'))
  }
  // What a description does to the transceivers; NegotiatingConnection below fills these in.
  appliedLocalOffer() {}
  rolledBack() {}
  appliedRemoteAnswer() {}
  connectionState = 'connected'
  iceConnectionState = 'connected'
  iceGatheringState = 'complete'
  localDescription = null
  remoteDescription = null
  chain = Promise.resolve()
  created = []
  refuseEdited = 0
  wrong(what) { return new Error(`InvalidStateError: ${what} in ${this.signalingState}`) }
  queue(body) {
    const run = this.chain.then(async () => { await Promise.resolve(); await Promise.resolve(); if (FakeConnection.slow) await settle(); return body() })
    this.chain = run.catch(() => {})
    return run
  }
  createDataChannel() { return {readyState: 'open', send() {}, close() {}} }
  restartIce() { this.restarted = (this.restarted || 0) + 1 }
  createOffer(options) {
    return this.queue(() => {
      if (!['stable', 'have-local-offer'].includes(this.signalingState)) throw this.wrong('createOffer')
      this.created.push({iceRestart: Boolean(options?.iceRestart)})
      return {type: 'offer', sdp: fakeSdp('offer')}
    })
  }
  createAnswer() {
    return this.queue(() => {
      if (!['have-remote-offer', 'have-local-pranswer'].includes(this.signalingState)) throw this.wrong('createAnswer')
      return {type: 'answer', sdp: fakeSdp('answer')}
    })
  }
  setLocalDescription(description) {
    return this.queue(() => {
      if (description?.type === 'rollback') {
        if (this.signalingState === 'stable') throw this.wrong('rollback')
        if (this.signalingState === 'have-local-offer') this.rolledBack()
        this.signalingState = 'stable'
        return
      }
      if (description?.sdp?.includes('stereo=1') && this.refuseEdited > 0) { this.refuseEdited--; throw new Error('InvalidModificationError: refused') }
      const type = description?.type ?? (this.signalingState === 'have-remote-offer' ? 'answer' : 'offer')
      if (type === 'offer' && !['stable', 'have-local-offer'].includes(this.signalingState)) throw this.wrong('setLocalDescription(offer)')
      if (type === 'answer' && this.signalingState !== 'have-remote-offer') throw this.wrong('setLocalDescription(answer)')
      this.localDescription = {type, sdp: description?.sdp ?? fakeSdp(type)}
      if (type === 'offer') this.appliedLocalOffer()
      this.signalingState = type === 'offer' ? 'have-local-offer' : 'stable'
    })
  }
  setRemoteDescription(description) {
    return this.queue(() => {
      if (description.type === 'answer') {
        if (this.signalingState !== 'have-local-offer') throw this.wrong('setRemoteDescription(answer)')
        this.appliedRemoteAnswer()
        this.signalingState = 'stable'
      } else {
        if (!['stable', 'have-remote-offer'].includes(this.signalingState)) throw this.wrong('setRemoteDescription(offer)')
        this.signalingState = 'have-remote-offer'
      }
      this.remoteDescription = description
    })
  }
  transceivers = [] // every one ever made, stopped or not
  detached = [] // senders taken off with removeTrack()
  addTransceiver(track, {direction, streams} = {}) {
    const sender = {track, replaceTrack: async (next) => { sender.track = next }, setStreams() {}}
    const transceiver = {sender, receiver: {track: {kind: track.kind}}, direction, streams, stopped: false, mid: String(this.transceivers.length), currentDirection: 'sendonly', stop() { this.stopped = true }}
    this.transceivers.push(transceiver)
    return transceiver
  }
  addTrack(track) { throw new Error('the peer must make its own transceiver (addTransceiver), not let addTrack pick one') }
  removeTrack(sender) { this.detached.push(sender); sender.track = null }
  getTransceivers() { return this.transceivers.filter((t) => !t.stopped) }
  getSenders() { return this.getTransceivers().map((t) => t.sender) }
  close() { this.connectionState = 'closed' }
}
const settle = () => new Promise((resolve) => setImmediate(resolve))

// Transceivers the way Chromium keeps them through negotiation (the M1.11 re-audit's glare case): a transceiver
// gets its mid from the local offer that first carries its section, and loses it again if that offer is rolled
// back; currentDirection comes with the answer; a stopped one is rejected by the next offer and only gone once
// that is answered. Negotiation is needed while any transceiver has no section, is stopping, or wants a direction
// other than the one negotiated. A stopping transceiver with no mid (stopped while its only offer was rolled back)
// is in no offer, so nothing ever takes it away: negotiation is needed again after every round, as in Electron 44
// (a two-connection probe counted 83 negotiationneeded events in 2s).
class NegotiatingConnection extends FakeConnection {
  needed = 0 // negotiationneeded events fired
  nextMid = 1 // 0 is the data channel
  #flag = false
  #offered = null // [{transceiver, direction}] in the unanswered local offer
  #stableLocal = null
  constructor(...args) {
    super(...args)
    this.addEventListener('signalingstatechange', () => {
      if (this.signalingState !== 'stable') return
      this.#stableLocal = this.localDescription
      this.#flag = false
      this.checkNeeded()
    })
  }
  addTransceiver(track, {direction = 'sendrecv', streams = []} = {}) {
    const pc = this
    const sender = {track, replaceTrack: async (next) => { sender.track = next }, setStreams() {}}
    let wanted = direction
    const transceiver = {
      sender, receiver: {track: {kind: track.kind}}, streams, mid: null, currentDirection: null, negotiated: null, stopping: false, removed: false,
      get direction() { return this.stopping ? 'stopped' : wanted },
      set direction(next) {
        if (this.stopping) throw new Error('InvalidStateError: the transceiver is stopped')
        wanted = next
        pc.checkNeeded()
      },
      stop() { this.stopping = true; pc.checkNeeded() },
    }
    this.transceivers.push(transceiver)
    this.checkNeeded()
    return transceiver
  }
  removeTrack(sender) {
    const transceiver = this.getTransceivers().find((t) => t.sender === sender)
    super.removeTrack(sender)
    if (transceiver && !transceiver.stopping) transceiver.direction = {sendrecv: 'recvonly', sendonly: 'inactive'}[transceiver.direction] ?? transceiver.direction
  }
  getTransceivers() { return this.transceivers.filter((t) => !t.removed) }
  isNeeded() { return this.getTransceivers().some((t) => t.stopping || t.mid == null || t.direction !== t.negotiated) }
  checkNeeded() {
    if (this.#flag || this.signalingState !== 'stable' || this.connectionState === 'closed' || !this.isNeeded()) return
    this.#flag = true
    setImmediate(() => {
      if (this.signalingState !== 'stable' || this.connectionState === 'closed' || !this.isNeeded()) return
      this.needed++
      this.dispatchEvent(new Event('negotiationneeded'))
      this.onnegotiationneeded?.()
    })
  }
  appliedLocalOffer() {
    this.#offered = []
    for (const transceiver of this.getTransceivers()) {
      if (transceiver.mid == null) {
        if (transceiver.stopping) continue // no section to reject
        transceiver.mid = String(this.nextMid++)
        transceiver.midFromPendingOffer = true
      }
      this.#offered.push({transceiver, direction: transceiver.direction})
    }
  }
  rolledBack() {
    for (const {transceiver} of this.#offered || []) {
      if (transceiver.midFromPendingOffer) transceiver.mid = null
      transceiver.midFromPendingOffer = false
    }
    this.#offered = null
    this.localDescription = this.#stableLocal
  }
  appliedRemoteAnswer() {
    for (const {transceiver, direction} of this.#offered || []) {
      transceiver.midFromPendingOffer = false
      if (transceiver.stopping) {
        transceiver.removed = true
        transceiver.currentDirection = 'stopped'
      } else {
        // The other end of these tests sends nothing back.
        transceiver.currentDirection = {sendrecv: 'sendonly', sendonly: 'sendonly', recvonly: 'inactive', inactive: 'inactive'}[direction]
        transceiver.negotiated = direction
      }
    }
    this.#offered = null
  }
}

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
  await peer.signal({type: 'answer', sdp: 'v=0\r\nm=audio 9 X 111\r\na=rtpmap:111 opus answer'})
  assert.equal(peer.connection.signalingState, 'stable')
  t.mock.timers.tick(60_000)
  await settle()
  assert.equal(offersSent().length, 2, 'answered: no more repeats')
  await peer.signal({type: 'answer', sdp: 'v=0\r\nm=audio 9 X 111\r\na=rtpmap:111 opus answer'}) // the repeat's answer
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

// ---------- Opus parameters in the local description (M1.6) ----------

const OPUS_LINE = 'stereo=1;sprop-stereo=1;useinbandfec=1;usedtx=0;maxplaybackrate=48000;maxaveragebitrate=510000'
const ticks = async (n) => { for (let i = 0; i < n; i++) await Promise.resolve() }
const turns = async (n) => { for (let i = 0; i < n; i++) await settle() }

// Two real peers (an offerer and an answerer, as Trystero makes them) with a wire between them that
// takes a turn of the event loop per signal and can be cut.
// Signals can be held (log.held = []) and let go later, in order, so two offers cross.
function wiredPair(Connection = FakeConnection) {
  const a = createPeer(true, {rtcPolyfill: Connection, trickleIce: true})
  const b = createPeer(false, {rtcPolyfill: Connection, trickleIce: true})
  const log = {a: [], b: [], errors: [], cut: false, held: null}
  const wire = (name, from, to) => from.setHandlers({
    signal: (signal) => {
      log[name].push(signal)
      if (log.held) log.held.push(() => to.signal(signal))
      else if (!log.cut) setImmediate(() => to.signal(signal))
    },
    error: (error) => log.errors.push(`${name}: ${error.message}`),
  })
  wire('a', a, b)
  wire('b', b, a)
  return {a, b, log}
}
const bothStable = ({a, b}) => a.connection.signalingState === 'stable' && b.connection.signalingState === 'stable' && a.connection.localDescription && b.connection.localDescription
async function untilStable(pair, ms = 1000) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (bothStable(pair)) { await turns(10); if (bothStable(pair)) return Date.now() - start }
    await settle()
  }
  throw new Error(`not stable within ${ms}ms: a ${pair.a.connection.signalingState}, b ${pair.b.connection.signalingState}`)
}
const offersIn = (signals) => signals.filter((signal) => signal.type === 'offer')

test('every local offer and answer carries the app\'s Opus parameters, so the receiver decodes stereo', async () => {
  const pair = wiredPair()
  await untilStable(pair)
  assert.deepEqual(pair.log.errors, [])
  for (const side of [pair.a, pair.b]) {
    const { sdp } = side.connection.localDescription
    assert.ok(sdp.includes(`a=fmtp:111 minptime=10;${OPUS_LINE}`), sdp)
  }
  assert.equal(offersIn(pair.log.a)[0].sdp.includes(OPUS_LINE), true, 'the offer on the wire is the edited one')
  assert.equal(pair.log.b.find((signal) => signal.type === 'answer').sdp.includes(OPUS_LINE), true, 'and so is the answer')
  pair.a.destroy(); pair.b.destroy()
})

test('both peers add a stream at the same moment (glare, at every timing): both settle quickly, nothing resent, no errors', async (t) => {
  FakeConnection.slow = true
  t.after(() => { FakeConnection.slow = false })
  for (let gap = 0; gap <= 8; gap++) {
    const pair = wiredPair()
    await untilStable(pair)
    const before = {a: offersIn(pair.log.a).length, b: offersIn(pair.log.b).length}
    const started = Date.now()
    pair.a.connection.onnegotiationneeded()
    await turns(gap)
    pair.b.connection.onnegotiationneeded()
    const took = await untilStable(pair)
    assert.deepEqual(pair.log.errors, [], `gap ${gap}: no "failed to ..." errors`)
    assert.ok(Date.now() - started < 1000 && took < 1000, `gap ${gap}: both stable in under a second`)
    for (const [name, signals] of [['a', pair.log.a], ['b', pair.log.b]]) {
      const sdps = offersIn(signals).map((signal) => signal.sdp)
      assert.equal(new Set(sdps).size, sdps.length, `gap ${gap}: ${name} never sent the same offer twice (no watchOffer resend)`)
    }
    assert.equal(offersIn(pair.log.a).length, before.a + 1, `gap ${gap}: the offerer made one new offer`)
    assert.ok(pair.a.connection.localDescription.sdp.includes(OPUS_LINE) && pair.b.connection.localDescription.sdp.includes(OPUS_LINE), `gap ${gap}: and both ends kept the Opus parameters`)
    pair.a.destroy(); pair.b.destroy()
  }
})

test('an ICE restart offer is edited too, from a stable connection and over an unanswered offer', async () => {
  const pair = wiredPair()
  await untilStable(pair)
  await pair.a.getOffer(true)
  await untilStable(pair)
  assert.deepEqual(pair.a.connection.created.at(-1), {iceRestart: true})
  assert.ok(pair.a.connection.localDescription.sdp.includes(OPUS_LINE), 'the restart offer carries the parameters')
  // An offer nobody answered (the wire is cut), then a restart: it rolls back first.
  pair.log.cut = true
  pair.a.connection.onnegotiationneeded()
  await turns(10)
  assert.equal(pair.a.connection.signalingState, 'have-local-offer')
  pair.log.cut = false
  await pair.a.getOffer(true)
  await untilStable(pair)
  assert.deepEqual(pair.log.errors, [])
  assert.equal(pair.a.connection.restarted, 2)
  assert.ok(pair.a.connection.localDescription.sdp.includes(OPUS_LINE))
  pair.a.destroy(); pair.b.destroy()
})

test('a description the browser refuses after editing is replaced by its own, never an error', async (t) => {
  t.mock.method(console, 'warn', () => {})
  const pair = wiredPair()
  pair.a.connection.refuseEdited = 1
  await untilStable(pair)
  assert.deepEqual(pair.log.errors, [])
  assert.equal(pair.a.connection.localDescription.sdp.includes('stereo=1'), false, 'the offer went out as the browser wrote it')
  assert.ok(pair.b.connection.localDescription.sdp.includes(OPUS_LINE), 'the other end is unaffected')
  pair.a.destroy(); pair.b.destroy()
})

// ---------- stopping transceivers (M1.11) ----------

test('removeStream and removeTrack stop the transceiver, so its m-section can be recycled instead of piling up', async () => {
  const peer = createPeer(true, {rtcPolyfill: FakeConnection, trickleIce: true})
  const pc = peer.connection
  await settle()
  const track = (kind) => ({kind, id: `${kind}-${++offers}`})
  const stream = {id: 'film'}
  const [audio, video] = [track('audio'), track('video')]
  stream.getTracks = () => [audio, video]
  peer.addStream(stream)
  assert.equal(pc.transceivers.length, 2)
  assert.ok(pc.transceivers.every((t) => t.direction === 'sendrecv' && t.streams[0] === stream), 'each made by addTransceiver, with the stream')
  assert.equal(pc.getSenders().length, 2, 'two senders on the connection')
  peer.removeStream(stream)
  assert.ok(pc.transceivers.every((t) => t.stopped), 'both transceivers were stopped, not just detached')
  assert.deepEqual(pc.detached, [], 'removeTrack() is not what ended them: that would leave the section behind')
  assert.equal(pc.getSenders().length, 0, 'nothing left to send on')
  // A track added on its own and taken off on its own.
  const solo = track('audio')
  peer.addTrack(solo, stream)
  assert.equal(pc.getSenders().length, 1)
  peer.removeTrack(solo)
  assert.equal(pc.getSenders().length, 0)
  assert.equal(pc.transceivers.filter((t) => t.stopped).length, 3)
  // Taking off something that is not there is harmless.
  peer.removeTrack(track('audio'))
  peer.removeStream({id: 'other', getTracks: () => [track('audio')]})
  assert.equal(pc.transceivers.length, 3)
  peer.destroy()
})

test('a transceiver the other end sends on too is only detached, so its picture is not ended with ours', async () => {
  const peer = createPeer(true, {rtcPolyfill: FakeConnection, trickleIce: true})
  const pc = peer.connection
  await settle()
  const audio = {kind: 'audio', id: 'a-shared'}
  peer.addTrack(audio, {id: 's'})
  pc.transceivers[0].currentDirection = 'sendrecv' // negotiated both ways: a copy from before M1.11 reused it for its own share
  peer.removeTrack(audio)
  assert.equal(pc.transceivers[0].stopped, false)
  assert.equal(pc.detached.length, 1)
  peer.destroy()
})

test('a detached transceiver that never got a section is reused by the next track of its kind', async () => {
  const peer = createPeer(true, {rtcPolyfill: FakeConnection, trickleIce: true})
  const pc = peer.connection
  await settle()
  const first = {kind: 'audio', id: 'a-1'}
  peer.addTrack(first, {id: 's'})
  Object.assign(pc.transceivers[0], {mid: null, currentDirection: null})
  peer.removeTrack(first)
  const second = {kind: 'audio', id: 'a-2'}
  peer.addTrack(second, {id: 's2'})
  await settle()
  assert.equal(pc.transceivers.length, 1, 'no second transceiver')
  assert.equal(pc.transceivers[0].sender.track, second)
  assert.equal(pc.transceivers[0].direction, 'sendrecv')
  const video = {kind: 'video', id: 'v-1'}
  peer.addTrack(video, {id: 's2'})
  assert.equal(pc.transceivers.length, 2, 'another kind gets its own')
  peer.destroy()
})

test('a transceiver that never got a section is only detached, not stopped (stopping it makes negotiation needed for good)', async () => {
  const peer = createPeer(true, {rtcPolyfill: FakeConnection, trickleIce: true})
  const pc = peer.connection
  await settle()
  const audio = {kind: 'audio', id: 'a-fresh'}
  peer.addTrack(audio, {id: 's'})
  Object.assign(pc.transceivers[0], {mid: null, currentDirection: null}) // added, and no offer has been made yet
  peer.removeTrack(audio)
  assert.equal(pc.transceivers[0].stopped, false)
  assert.equal(pc.detached.length, 1)
  peer.destroy()
})

test('if stopping a transceiver is refused the sender is detached the old way', async () => {
  const peer = createPeer(true, {rtcPolyfill: FakeConnection, trickleIce: true})
  const pc = peer.connection
  await settle()
  const audio = {kind: 'audio', id: 'a-refuse'}
  peer.addTrack(audio, {id: 's'})
  pc.transceivers[0].stop = () => { throw new Error('InvalidStateError') }
  peer.removeTrack(audio)
  assert.equal(pc.detached.length, 1, 'removeTrack(sender) was the fallback')
  peer.destroy()
})

test('an offer that only ends media sections (all rejected, no codecs) is answered, one with no media section at all is not', async () => {
  // A host stopping its film with nothing yet in its place sends exactly this. It used to be dropped for having no
  // a=rtpmap line, and the sender stayed in have-local-offer for good.
  const pair = wiredPair()
  await untilStable(pair)
  const answersBefore = pair.log.a.filter((signal) => signal.type === 'answer').length
  await pair.a.signal({type: 'offer', sdp: ['v=0', 'm=audio 0 UDP/TLS/RTP/SAVPF 0', 'a=mid:1', 'm=video 0 UDP/TLS/RTP/SAVPF 0', 'a=mid:2', ''].join('\r\n')})
  assert.equal(pair.log.a.filter((signal) => signal.type === 'answer').length, answersBefore + 1, 'the all-rejected offer got its answer')
  await pair.a.signal({type: 'offer', sdp: ['v=0', 'a=group:BUNDLE', ''].join('\r\n')})
  assert.equal(pair.log.a.filter((signal) => signal.type === 'answer').length, answersBefore + 1, 'an SDP with no media section is still ignored')
  assert.deepEqual(pair.log.errors, [])
  pair.a.destroy(); pair.b.destroy()
})

test('a transceiver whose offer is not answered yet is only detached (it may still lose its mid to a rollback)', async () => {
  const peer = createPeer(true, {rtcPolyfill: FakeConnection, trickleIce: true})
  const pc = peer.connection
  await settle()
  const audio = {kind: 'audio', id: 'a-offered'}
  peer.addTrack(audio, {id: 's'})
  pc.transceivers[0].currentDirection = null // in the local offer (so it has a mid), not answered
  peer.removeTrack(audio)
  assert.equal(pc.transceivers[0].stopped, false)
  assert.equal(pc.detached.length, 1)
  peer.destroy()
})

test('a transceiver detached before it was negotiated is stopped once it is, unless the other end now sends on it', async () => {
  for (const [negotiated, stopped] of [['inactive', true], ['sendonly', true], ['recvonly', false], ['sendrecv', false]]) {
    const peer = createPeer(true, {rtcPolyfill: FakeConnection, trickleIce: true})
    const pc = peer.connection
    await settle()
    const audio = {kind: 'audio', id: `a-later-${negotiated}`}
    peer.addTrack(audio, {id: 's'})
    pc.transceivers[0].currentDirection = null // its offer is out, not answered
    peer.removeTrack(audio)
    assert.equal(pc.transceivers[0].stopped, false, 'detached, not stopped')
    pc.signalingState = 'have-local-offer'
    pc.signalingState = 'stable' // rolled back: still nothing negotiated, so still not stopped
    assert.equal(pc.transceivers[0].stopped, false)
    pc.signalingState = 'have-local-offer'
    pc.transceivers[0].currentDirection = negotiated // offered again, and answered
    pc.signalingState = 'stable'
    // recvonly/sendrecv: Chromium gave the detached transceiver to the other end's next section of its kind (seen in
    // the Electron probe), so it now carries the other end's sound; stopping it would end that.
    assert.equal(pc.transceivers[0].stopped, stopped, `negotiated ${negotiated}: ${stopped ? 'stopped' : 'left alone'}`)
    peer.destroy()
  }
})

test('a room peer (a shared connection) takes off only tracks it was given one at a time: those of an added stream go with the stream', () => {
  // Why renderer/app.js stops the senders of a film's audio clones itself (stopSendersOf): they reach the room with
  // addStream, and every room peer is one of these proxies.
  const manager = new SharedPeerManager()
  const calls = []
  const peer = {
    created: 0, isDead: false, connection: {getSenders: () => []}, setHandlers() {}, sendData() {},
    addStream: (stream) => calls.push(`addStream ${stream.id}`), removeStream: (stream) => calls.push(`removeStream ${stream.id}`),
    addTrack: (track) => calls.push(`addTrack ${track.id}`), removeTrack: (track) => calls.push(`removeTrack ${track.id}`),
  }
  const shared = manager.register('app', 'peer', peer, 100)
  const {proxy} = manager.bind('watch', Promise.resolve('watch'), shared, {onDetach() {}})
  const clone = {id: 'clone'}
  const stream = {id: 'film', getTracks: () => [clone]}
  proxy.addStream(stream)
  proxy.removeTrack(clone)
  assert.deepEqual(calls, ['addStream film'], 'removeTrack found nothing to take off')
  const solo = {id: 'solo'}
  proxy.addTrack(solo, stream)
  proxy.removeTrack(solo)
  proxy.removeStream(stream)
  assert.deepEqual(calls, ['addStream film', 'addTrack solo', 'removeTrack solo', 'removeStream film'])
  manager.clear('app', 'peer', {destroyPeer: false})
})

// Every negotiation the pair still has to do, done: stable on both ends, and nothing more needed for a while.
async function untilSettled(pair, ms = 2000) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    await untilStable(pair, ms)
    const needed = pair.a.connection.needed + pair.b.connection.needed
    await turns(60)
    if (bothStable(pair) && pair.a.connection.needed + pair.b.connection.needed === needed) return
  }
  throw new Error(`negotiation never settled: negotiationneeded a ${pair.a.connection.needed}, b ${pair.b.connection.needed}`)
}

test('glare: a track taken off while its offer is out, then a colliding offer the polite end rolls back for, leaves negotiation settled and the next publish working', async (t) => {
  // The re-audit's case: stopping a transceiver whose mid came from an unanswered offer, then a rollback, left it
  // stopped with no mid for good: negotiation needed after every round, and every later film to that peer failed.
  for (const publishAt of ['once settled', 'right after the rollback']) {
    const pair = wiredPair(NegotiatingConnection)
    t.after(() => { pair.a.destroy(); pair.b.destroy() }) // a failure must not leave them negotiating forever
    await untilSettled(pair)
    const [a, b] = [pair.a.connection, pair.b.connection]
    const neededBefore = b.needed
    pair.log.held = []
    const first = {kind: 'audio', id: `b-film-1-${publishAt}`}
    pair.b.addTrack(first, {id: 'b-1'}) // b is the polite end (not the initiator)
    while (b.signalingState !== 'have-local-offer') await settle()
    const offered = b.transceivers[0]
    assert.ok(offered.mid != null && offered.currentDirection == null, 'the offer gave it a mid; nothing negotiated yet')
    pair.b.removeTrack(first) // the film is gone before its offer was answered
    assert.equal(offered.stopping, false, `${publishAt}: not stopped while the offer that gave it its mid can be rolled back`)
    assert.equal(offered.sender.track, null, 'but detached')
    pair.a.addTrack({kind: 'audio', id: 'a-film'}, {id: 'a-1'})
    while (a.signalingState !== 'have-local-offer') await settle()
    const crossing = pair.log.held
    pair.log.held = null
    crossing.forEach((deliver) => setImmediate(deliver)) // a ignores b's offer; b rolls back and answers a's
    let second = null
    if (publishAt === 'right after the rollback') {
      while (b.signalingState === 'have-local-offer') await settle()
      assert.equal(offered.mid, null, 'the rollback took its mid')
      second = {kind: 'audio', id: 'b-film-2-early'}
      assert.doesNotThrow(() => pair.b.addTrack(second, {id: 'b-2'}), 'the next film can be added')
    }
    await untilSettled(pair)
    assert.ok(b.needed - neededBefore <= 6, `${publishAt}: negotiation was needed ${b.needed - neededBefore} times, not again and again`)
    const settledAt = b.needed
    await turns(200)
    assert.equal(b.needed, settledAt, `${publishAt}: and not once more after it settled`)
    assert.equal(b.getTransceivers().filter((t) => t.stopping).length, 0, 'no stopped transceiver is left behind')
    if (!second) {
      assert.ok(offered.removed, 'the detached transceiver got a section, was stopped once it was negotiated, and is gone')
      second = {kind: 'audio', id: 'b-film-2'}
      assert.doesNotThrow(() => pair.b.addTrack(second, {id: 'b-2'}), 'the next film can be added')
      await untilSettled(pair)
    }
    const sending = b.getTransceivers().find((t) => t.sender.track === second)
    assert.ok(sending, `${publishAt}: the next film has a sender`)
    assert.equal(sending.currentDirection, 'sendonly', `${publishAt}: and it was negotiated`)
    assert.ok(b.getTransceivers().length <= 2, `${publishAt}: ${b.getTransceivers().length} transceivers, nothing piling up`)
    assert.deepEqual(pair.log.errors, [])
    pair.a.destroy(); pair.b.destroy()
  }
})
