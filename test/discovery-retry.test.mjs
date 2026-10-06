import test from 'node:test'
import assert from 'node:assert/strict'
import {makeSocket} from '../node_modules/@trystero-p2p/core/dist/utils.mjs'

function sockets(t) {
  const created = []
  const original = globalThis.WebSocket
  globalThis.WebSocket = class {
    constructor(url) { this.url = url; this.readyState = 0; created.push(this) }
    close() { this.readyState = 3; this.onclose?.({code: 1000}) }
    send() {}
  }
  t.after(() => { globalThis.WebSocket = original })
  t.mock.method(console, 'warn', () => {})
  t.mock.timers.enable({apis: ['setTimeout']})
  return created
}

test('discovery keeps retrying through a long outage and resolves when the relay returns', async (t) => {
  const created = sockets(t)
  const client = makeSocket('wss://initial-outage.invalid', () => {})
  t.after(() => client.close())
  for (let failures = 0; failures < 12; failures++) {
    created.at(-1).onclose({code: 1006})
    t.mock.timers.tick(60_000)
    assert.equal(created.length, failures + 2, 'a failed relay must not become permanently disabled')
    assert.equal(client.isClosed, false)
  }
  created.at(-1).readyState = 1
  created.at(-1).onopen()
  assert.equal(await client.ready, client)
  assert.match(console.warn.mock.calls[0].arguments[0], /discovery relay disconnected/)
})

test('a previously connected discovery relay recovers and explicit close cancels its retry', (t) => {
  const created = sockets(t)
  let resubscriptions = 0
  const client = makeSocket('wss://established-outage.invalid', () => {}, () => resubscriptions++)
  t.after(() => client.close())
  created[0].readyState = 1
  created[0].onopen()
  for (let failures = 0; failures < 12; failures++) {
    created.at(-1).onclose({code: 1006})
    t.mock.timers.tick(60_000)
    assert.equal(created.length, failures + 2)
  }
  created.at(-1).readyState = 1
  created.at(-1).onopen()
  assert.equal(resubscriptions, 1)
  created.at(-1).onclose({code: 1006})
  client.close()
  const before = created.length
  t.mock.timers.tick(120_000)
  assert.equal(created.length, before, 'deliberate shutdown must not reconnect')
  assert.equal(client.isClosed, true)
})
