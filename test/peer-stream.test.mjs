import test from 'node:test'
import assert from 'node:assert/strict'
import {repairedStream} from '../renderer/peer-stream.mjs'

const track = (id, extra = {}) => ({id, kind: id.split('-')[0], readyState: 'live', muted: false, ...extra})
const stream = (...tracks) => ({tracks, getTracks() { return this.tracks }})
const make = (tracks) => stream(...tracks)

test('a stream that holds everything the connection receives is kept', () => {
  const audio = track('audio-1'), video = track('video-1')
  const s = stream(audio, video)
  assert.equal(repairedStream(s, [audio, video], make), s)
})

test('tracks still muted (nothing arrived yet) do not count as missing', () => {
  const audio = track('audio-1'), video = track('video-1', {muted: true})
  const s = stream(audio)
  assert.equal(repairedStream(s, [audio, video], make), s)
})

test('an empty stale stream is replaced by the receivers that are flowing', () => {
  const audio = track('audio-1'), video = track('video-1')
  const next = repairedStream(stream(), [audio, video], make)
  assert.deepEqual(next.getTracks(), [audio, video])
})

test('a stream with only the sound gets the picture too (the rejoin black screen)', () => {
  const audio = track('audio-1'), video = track('video-1')
  const next = repairedStream(stream(audio), [audio, video], make)
  assert.deepEqual(next.getTracks(), [audio, video])
})

test('a stale stream with nothing flowing yet is left alone, and repaired once it flows', () => {
  const audio = track('audio-1', {muted: true}), video = track('video-1', {muted: true})
  const stale = stream()
  assert.equal(repairedStream(stale, [audio, video], make), stale)
  audio.muted = false
  const first = repairedStream(stale, [audio, video], make)
  assert.deepEqual(first.getTracks(), [audio])
  video.muted = false
  const second = repairedStream(first, [audio, video], make)
  assert.notEqual(second, first)
  assert.deepEqual(second.getTracks(), [audio, video])
  assert.equal(repairedStream(second, [audio, video], make), second, 'stable once complete')
})

test('a repaired stream does not lose its picture when a receiver mutes during a stall', () => {
  const audio = track('audio-1'), video = track('video-1')
  const repairedOnce = repairedStream(stream(), [audio, video], make)
  video.muted = true
  assert.equal(repairedStream(repairedOnce, [audio, video], make), repairedOnce)
})

test('ended tracks drop out of a repaired stream', () => {
  const audio = track('audio-1'), video = track('video-1'), video2 = track('video-2')
  const repairedOnce = repairedStream(stream(), [audio, video], make)
  video.readyState = 'ended'
  const next = repairedStream(repairedOnce, [audio, video, video2], make)
  assert.deepEqual(next.getTracks(), [audio, video2])
})
