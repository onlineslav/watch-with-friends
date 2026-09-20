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
  tracker.detect()
  assert.equal(worker.messages.length, 2)
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
