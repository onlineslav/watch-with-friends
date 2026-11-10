import test from 'node:test'
import assert from 'node:assert/strict'
import {relayAudio} from '../renderer/audio-relay.mjs'

class FakeTrack extends EventTarget {
  constructor(kind = 'audio') { super(); this.kind = kind; this.readyState = 'live'; this.clones = [] }
  clone() { const c = new FakeTrack(this.kind); this.clones.push(c); return c }
  stop() { this.readyState = 'ended' }
}
globalThis.MediaStream ??= class { constructor(tracks) { this.tracks = tracks } getAudioTracks() { return this.tracks.filter((t) => t.kind === 'audio') } }

function fakeContext() {
  const ctx = {sources: [], dests: []}
  ctx.createMediaStreamSource = (stream) => {
    const node = {stream, connected: [], disconnected: false, connect(d) { this.connected.push(d) }, disconnect() { this.disconnected = true }}
    ctx.sources.push(node)
    return node
  }
  ctx.createMediaStreamDestination = () => {
    const out = new FakeTrack()
    const dest = {channelCount: 2, channelCountMode: 'max', stream: new MediaStream([out])}
    ctx.dests.push(dest)
    return dest
  }
  return ctx
}

test('relays a clone of the source through a stereo destination', () => {
  const ctx = fakeContext()
  const source = new FakeTrack()
  const track = relayAudio(ctx, source)
  const [node] = ctx.sources
  const [dest] = ctx.dests
  assert.equal(node.stream.tracks[0], source.clones[0], 'the source itself is never consumed, a clone is')
  assert.deepEqual(node.connected, [dest])
  assert.equal(dest.channelCount, 2)
  assert.equal(dest.channelCountMode, 'explicit')
  assert.equal(track, dest.stream.getAudioTracks()[0])
  assert.equal(track.relayed, source.clones[0])
  assert.equal(source.readyState, 'live')
})

test('stopping the relay stops the inner clone and unhooks the graph, once', () => {
  const ctx = fakeContext()
  const source = new FakeTrack()
  const track = relayAudio(ctx, source)
  let ended = 0
  track.addEventListener('ended', () => ended++)
  track.stop()
  track.stop()
  assert.equal(track.readyState, 'ended')
  assert.equal(source.clones[0].readyState, 'ended')
  assert.equal(ctx.sources[0].disconnected, true)
  assert.equal(ended, 0, 'stop() fires no ended, like a real track')
})

test('the inner clone ending ends the relay and fires ended', () => {
  const ctx = fakeContext()
  const source = new FakeTrack()
  const track = relayAudio(ctx, source)
  let ended = 0
  track.addEventListener('ended', () => ended++)
  const inner = source.clones[0]
  inner.readyState = 'ended'
  inner.dispatchEvent(new Event('ended'))
  assert.equal(track.readyState, 'ended')
  assert.equal(ended, 1)
  assert.equal(ctx.sources[0].disconnected, true)
})
