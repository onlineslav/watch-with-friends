import test from 'node:test'
import assert from 'node:assert/strict'
import {FaceTracker} from '../renderer/faces.mjs'

function environment(t) {
  const workers = [], frames = [], restore = []
  const replace = (name, value) => {
    const original = Object.getOwnPropertyDescriptor(globalThis, name)
    Object.defineProperty(globalThis, name, {value, configurable: true, writable: true})
    restore.push(() => original ? Object.defineProperty(globalThis, name, original) : delete globalThis[name])
  }
  replace('fetch', async () => new Response('worker'))
  replace('requestAnimationFrame', () => 1)
  replace('cancelAnimationFrame', () => {})
  replace('Worker', class {
    constructor() { this.messages = []; workers.push(this); queueMicrotask(() => this.reply({type: 'ready', delegate: 'GPU', connections: []})) }
    postMessage(message) { this.messages.push(message) }
    reply(data) { this.onmessage({data}) }
    terminate() { this.terminated = true }
  })
  replace('VideoFrame', class {
    constructor(source) { this.timestamp = source.timestamp; frames.push(this) }
    close() { this.closed = true }
  })
  const tracker = new FaceTracker()
  t.after(() => { tracker.close(); restore.forEach(fn => fn()) })
  const source = {videoWidth: 640, videoHeight: 360, readyState: 4, timestamp: 1}
  const complete = (worker, request, detections = []) => worker.reply({type: 'result', ...request,
    detections, thumbnail: new Uint8Array([10]), aspect: 16 / 9, inferenceMs: 12})
  return {tracker, source, workers, frames, complete}
}

test('tracking allows only one inference in flight and skips repeated video frames', async t => {
  const {tracker, source, workers, frames, complete} = environment(t)
  assert.ok(await tracker.start(source))
  const worker = workers[0]
  tracker.detect()
  source.timestamp = 2
  tracker.detect()
  source.timestamp = 3
  tracker.detect()
  assert.equal(worker.messages.length, 1, 'slow inference must not queue video frames')
  complete(worker, worker.messages[0])
  assert.equal(worker.messages.length, 2, 'completion immediately starts the newest frame without waiting for another refresh')
  assert.equal(worker.messages[1].frame.timestamp, 3, 'resume with the newest frame')
  complete(worker, worker.messages[1])
  tracker.detect()
  assert.equal(worker.messages.length, 2, 'paused frames must not be inferred again')
  assert.ok(frames.every(frame => frame.closed), 'all frame handles are released')
})

test('results from an old source cannot repopulate tracking after stop/restart', async t => {
  const {tracker, source, workers, complete} = environment(t)
  await tracker.start(source)
  tracker.detect()
  const worker = workers[0], previous = worker.messages[0]
  tracker.stop()
  await tracker.start({...source, timestamp: 2})
  complete(worker, previous)
  assert.equal(tracker.stats.frames, 0)
  assert.equal(tracker.tracked.length, 0)
  tracker.detect()
  complete(worker, worker.messages[1])
  assert.equal(tracker.stats.frames, 1)
})

test('a paused face remains visible; advancing frames without a detection fade it', async t => {
  const {tracker, source, workers, complete} = environment(t)
  await tracker.start(source)
  const landmarks = Array.from({length: 478}, () => ({x: 0.5, y: 0.5}))
  landmarks[33] = {x: 0.4, y: 0.4}; landmarks[263] = {x: 0.6, y: 0.4}
  tracker.detect()
  complete(workers[0], workers[0].messages[0], [landmarks])
  const at = tracker.lastFrameAt
  assert.equal(tracker.visible(at + 10000)[0].opacity, 1)
  tracker.lastFrameAt = at + 250
  tracker.accept({detections: [], thumbnail: new Uint8Array([10]), aspect: 16 / 9, at: at + 250, inferenceMs: 12})
  assert.ok(tracker.visible(at + 250)[0].opacity < 1)
  tracker.lastFrameAt = at + 400
  assert.equal(tracker.visible(at + 400).length, 0)
})

test('a worker error is reported, releases the worker, and permits a later restart', async t => {
  const {tracker, source, workers} = environment(t)
  await tracker.start(source)
  workers[0].reply({type: 'error', error: 'GPU context lost'})
  assert.match(tracker.error.message, /GPU context lost/)
  assert.ok(workers[0].terminated)
  assert.equal(tracker.worker, null)
  assert.ok(await tracker.start(source))
  assert.equal(workers.length, 2)
  assert.equal(tracker.error, null)
})

test('closing during model loading cannot resurrect a worker', async t => {
  const {tracker, source, workers} = environment(t)
  const starting = tracker.start(source)
  tracker.close()
  assert.equal(await starting, false)
  assert.equal(tracker.worker, null)
  assert.equal(workers.length, 0)
})

const makeFace = (x, scale = 0.2) => {
  const landmarks = Array.from({length: 478}, () => ({x, y: 0.5}))
  landmarks[33] = {x: x - scale / (2 * (16 / 9)), y: 0.4}
  landmarks[263] = {x: x + scale / (2 * (16 / 9)), y: 0.4}
  return landmarks
}

test('video callbacks drive tracking and are cancelled when the source stops', async t => {
  const {tracker, source, workers, complete} = environment(t)
  let callback, cancelled
  source.requestVideoFrameCallback = fn => { callback = fn; return 42 }
  source.cancelVideoFrameCallback = id => { cancelled = id }
  await tracker.start(source)
  assert.equal(workers[0].messages.length, 1, 'already-paused videos still get an initial detection')
  complete(workers[0], workers[0].messages[0])
  source.timestamp++
  callback()
  assert.equal(workers[0].messages.length, 2)
  tracker.stop()
  assert.equal(cancelled, 42)
  callback()
  assert.equal(workers[0].messages.length, 2, 'a late video callback cannot restart inference')
})

test('seeking clears the overlay immediately and discards the pending result', async t => {
  const {tracker, source, workers, complete} = environment(t)
  const events = new EventTarget()
  source.addEventListener = events.addEventListener.bind(events)
  source.removeEventListener = events.removeEventListener.bind(events)
  await tracker.start(source)
  complete(workers[0], workers[0].messages[0], [makeFace(0.5)])
  assert.equal(tracker.tracked.length, 1)
  source.timestamp++
  tracker.detect()
  source.seeking = true
  events.dispatchEvent(new Event('seeking'))
  assert.equal(tracker.tracked.length, 0)
  complete(workers[0], workers[0].messages[1], [makeFace(0.5)])
  assert.equal(tracker.tracked.length, 0)
  assert.equal(workers[0].messages.length, 2)
  source.seeking = false
  tracker.detect()
  complete(workers[0], workers[0].messages[2], [makeFace(0.3)])
  assert.equal(tracker.tracked.length, 1)
  tracker.stop()
  const generation = tracker.generation
  events.dispatchEvent(new Event('seeking'))
  assert.equal(tracker.generation, generation, 'seeking listener is removed on stop')
})

test('nearby faces keep the globally closest histories regardless of detection order', async t => {
  const {tracker, source} = environment(t)
  await tracker.start(source)
  const accept = (detections, at) => tracker.accept({detections, at, aspect: 16 / 9,
    thumbnail: new Uint8Array([10]), inferenceMs: 1})
  accept([makeFace(0.4), makeFace(0.48)], 1000)
  const [left, right] = tracker.tracked
  accept([makeFace(0.43), makeFace(0.405)], 1033)
  assert.equal(tracker.tracked[0], right)
  assert.equal(tracker.tracked[1], left)
  accept([makeFace(0.407), makeFace(0.435)], 1066)
  assert.equal(tracker.tracked[0], left)
  assert.equal(tracker.tracked[1], right)
})

test('a different-sized face and a scene cut start fresh tracking histories', async t => {
  const {tracker, source} = environment(t)
  await tracker.start(source)
  const accept = (scale, at, shade = 10) => tracker.accept({detections: [makeFace(0.5, scale)], at,
    aspect: 16 / 9, thumbnail: new Uint8Array([shade]), inferenceMs: 1})
  accept(0.04, 1000)
  const small = tracker.tracked[0]
  accept(0.2, 1033)
  assert.notEqual(tracker.tracked[0], small)
  const previous = tracker.tracked[0]
  accept(0.2, 1066, 240)
  assert.equal(tracker.tracked.length, 1)
  assert.notEqual(tracker.tracked[0], previous)
})

test('late inference is discarded on advancing video but is valid on an unchanged frame', async t => {
  const {tracker, source, frames} = environment(t)
  await tracker.start(source)
  const result = {detections: [makeFace(0.5)], at: performance.now() - 500,
    timestamp: source.timestamp, aspect: 16 / 9, thumbnail: new Uint8Array([10]), inferenceMs: 500}
  tracker.accept(result)
  assert.equal(tracker.tracked.length, 1, 'an unchanged frame can use a slow first inference')
  source.timestamp++
  tracker.accept(result)
  assert.equal(tracker.tracked.length, 0, 'stale landmarks must not flash over a newer picture')
  assert.equal(tracker.stats.discarded, 1)
  assert.ok(frames.every(frame => frame.closed))
})

test('a stalled worker cannot freeze the old face over playing video', async t => {
  const {tracker, source, workers, complete} = environment(t)
  await tracker.start(source)
  complete(workers[0], workers[0].messages[0], [makeFace(0.5)])
  const at = tracker.tracked[0].at
  source.timestamp++
  source.paused = false
  tracker.detect()
  assert.equal(tracker.visible(at + 400).length, 0)
  source.paused = true
  assert.equal(tracker.visible(at + 400).length, 1, 'paused video can retain its overlay')
})
