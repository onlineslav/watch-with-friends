'use strict'

// Stand-ins for a WebSocket and for time, shared by the live telemetry tests (test/live.test.js)
// and the traffic measurement in scripts/check-network.js. Not in test/ because `node --test`
// runs every .js file in a directory called test.

function createFakeWebSocket() {
  class FakeWebSocket {
    constructor(url) {
      this.url = url
      this.readyState = 0
      this.sent = []
      this.closedWith = null
      this.listeners = {}
      FakeWebSocket.instances.push(this)
    }
    addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener) }
    emit(type, event = {}) { for (const listener of this.listeners[type] || []) listener(event) }
    send(data) {
      if (this.readyState !== 1) throw new Error('socket is not open')
      this.sent.push(data)
      this.onSend?.(data)
      if (data === 'ping' && FakeWebSocket.answerPings) queueMicrotask(() => this.readyState === 1 && this.receive('pong'))
    }
    close(code, reason) { this.readyState = 3; this.closedWith = {code, reason} }
    // The server's side of the conversation.
    open() { this.readyState = 1; this.emit('open') }
    receive(data) { this.emit('message', {data}) }
    drop(code = 1006) { this.readyState = 3; this.emit('close', {code}) }
    fail() { this.readyState = 3; this.emit('error') }
    get frames() { return this.sent.filter((item) => typeof item !== 'string') }
    get texts() { return this.sent.filter((item) => typeof item === 'string') }
  }
  FakeWebSocket.instances = []
  FakeWebSocket.answerPings = false // the Worker's auto-response, when a test wants a healthy connection
  return FakeWebSocket
}

// A clock that only moves when told to; timers fire in order as it passes them.
function createClock(start = 1_000_000) {
  let time = start
  let nextId = 1
  const timers = new Map()
  return {
    now: () => time,
    setTimer(fn, ms) {
      const id = nextId++
      timers.set(id, {fn, at: time + Math.max(0, ms)})
      return {id, unref() {}}
    },
    clearTimer(handle) { if (handle) timers.delete(handle.id) },
    get pending() { return timers.size },
    async advance(ms) {
      const until = time + ms
      for (;;) {
        let next = null
        for (const [id, timer] of timers) if (timer.at <= until && (!next || timer.at < next.timer.at)) next = {id, timer}
        if (!next) break
        timers.delete(next.id)
        time = Math.max(time, next.timer.at)
        next.timer.fn()
        await settle()
      }
      time = until
      await settle()
    },
  }
}

// Lets promise continuations (the sender awaits its endpoint) run.
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)) }

module.exports = {createClock, createFakeWebSocket, settle}
