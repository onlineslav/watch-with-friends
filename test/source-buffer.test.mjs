import test from 'node:test'
import assert from 'node:assert/strict'
import {whenIdle} from '../renderer/source-buffer.mjs'

// A SourceBuffer that behaves as the spec says: abort() ends a running operation and queues its updateend, remove() starts
// a new one that ends later with its own updateend.
class FakeBuffer extends EventTarget {
  updating = false
  startRemove(ms) {
    this.updating = true
    this.timer = setTimeout(() => { this.updating = false; this.dispatchEvent(new Event('updateend')) }, ms)
  }
  abort() {
    clearTimeout(this.timer)
    if (!this.updating) return
    this.updating = false
    queueMicrotask(() => this.dispatchEvent(new Event('updateend'))) // the abort's own event, delivered later
  }
}

test('returns at once when nothing is running', async () => {
  await whenIdle(new FakeBuffer())
})

test('one updateend from an earlier abort does not end the wait for a remove that started after it', async () => {
  const buffer = new FakeBuffer()
  buffer.startRemove(5) // the old pump's remove
  buffer.abort() // the new session resets the parser: queues an updateend
  buffer.startRemove(30) // and removes everything
  let waited = false
  const done = whenIdle(buffer).then(() => { waited = true; assert.equal(buffer.updating, false, 'idle when it returns') })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(waited, false, 'still waiting while the remove runs')
  await done
})

test('the old way (one updateend) returns while the buffer is still busy', async () => {
  const buffer = new FakeBuffer()
  buffer.startRemove(5)
  buffer.abort()
  buffer.startRemove(30)
  await new Promise((resolve) => buffer.addEventListener('updateend', resolve, {once: true}))
  assert.equal(buffer.updating, true, 'the first event came from the abort, not from the remove')
  await whenIdle(buffer)
})
