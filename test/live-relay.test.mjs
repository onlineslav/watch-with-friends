import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {createRequire} from 'node:module'
import worker from '../relay/worker.mjs'
import {LiveHub, clearDecisions, live, platform} from '../relay/live.mjs'

const require = createRequire(import.meta.url)
const {unwrapRelayFrame} = require('../shared/live')

const TOKEN = 'gho_0123456789abcdefghijklmnopqrstuvwxyz'
const OTHER_TOKEN = 'gho_zyxwvutsrqponmlkjihgfedcba9876543210'

// --- fakes for what only exists inside workerd -----------------------------------------------------

class FakeSocket {
  constructor() { this.readyState = 1; this.sent = []; this.closed = null; this.tags = []; this.attachment = null }
  send(data) { if (this.readyState !== 1) throw new Error('socket closed'); this.sent.push(data) }
  close(code, reason) { this.readyState = 3; this.closed = {code, reason} }
  serializeAttachment(value) { this.attachment = structuredClone(value) }
  deserializeAttachment() { return this.attachment }
  get texts() { return this.sent.filter((item) => typeof item === 'string').map((item) => JSON.parse(item)) }
  get frames() { return this.sent.filter((item) => typeof item !== 'string') }
}

function room() {
  const sockets = []
  const ctx = {
    autoResponse: null,
    acceptWebSocket(socket, tags) { socket.tags = tags; sockets.push(socket) },
    getWebSockets: (tag) => sockets.filter((socket) => socket.tags.includes(tag)),
    setWebSocketAutoResponse() {},
    getWebSocketAutoResponseTimestamp: (socket) => (socket.lastPing ? new Date(socket.lastPing) : null),
  }
  const originals = {...platform}
  platform.pair = () => ({client: {isClient: true}, server: new FakeSocket()})
  platform.upgraded = (webSocket) => ({status: 101, webSocket})
  platform.autoResponse = (target) => { target.autoResponse = ['ping', 'pong'] }
  const env = {DIAGNOSTICS_REPO: 'owner/diag', RATE_LIMITER: {limit: async () => ({success: true})}}
  const hub = new LiveHub(ctx, env)
  env.LIVE = {idFromName: (name) => name, get: () => ({fetch: (request) => hub.fetch(request)})}
  return {ctx, env, hub, sockets, restore: () => Object.assign(platform, originals)}
}

// GitHub, as the Worker sees it. `answer` returns a Response (or throws) per call.
function stubGitHub(answer = () => new Response(JSON.stringify({permissions: {pull: true}}), {status: 200})) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, options) => { calls.push({url: String(url), headers: options?.headers}); return answer(calls.length) }
  return {calls, restore: () => (globalThis.fetch = original)}
}

const viewRequest = (token = TOKEN, extra = {}) => new Request('https://relay.test/live?role=view', {headers: {Upgrade: 'websocket', ...(token ? {Authorization: `Bearer ${token}`} : {}), ...extra}})
const appRequest = (from = 'aya#abcd-1234') => new Request(`https://relay.test/live?role=app&from=${encodeURIComponent(from)}`, {headers: {Upgrade: 'websocket'}})

async function connect(env, request) {
  const response = await live(request, env)
  assert.equal(response.status, 101, `connected (got ${response.status})`)
  return room.last.sockets.at(-1)
}

function setup() {
  clearDecisions()
  const r = room()
  room.last = r
  return r
}

test('a reader without a GitHub token gets 401, one whose token cannot read the repository gets 403', async () => {
  const r = setup()
  const github = stubGitHub((n) => (n === 1 ? new Response('{}', {status: 401}) : n === 2 ? new Response('{}', {status: 404}) : new Response(JSON.stringify({permissions: {pull: false}}), {status: 200})))
  try {
    const none = await live(viewRequest(null), r.env)
    assert.equal(none.status, 401)
    assert.equal(github.calls.length, 0, 'no token, no question to GitHub')
    assert.equal((await live(viewRequest('short'), r.env)).status, 401, 'not shaped like a token')
    assert.equal((await live(viewRequest(TOKEN), r.env)).status, 401, 'GitHub says the token is bad')
    assert.equal((await live(viewRequest(OTHER_TOKEN), r.env)).status, 403, 'a token that cannot see the repository')
    const readonly = 'gho_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    assert.equal((await live(viewRequest(readonly), r.env)).status, 403, 'visible but not readable')
    assert.equal(r.sockets.length, 0, 'none of them got a socket')
  } finally { github.restore(); r.restore() }
})

test('the token travels in a header, is checked against the diagnostics repository and is never echoed', async () => {
  const r = setup()
  const github = stubGitHub()
  const logged = []
  const spies = ['log', 'error', 'warn', 'info', 'debug'].map((name) => { const original = console[name]; console[name] = (...args) => logged.push(args.join(' ')); return [name, original] })
  try {
    const response = await live(viewRequest(TOKEN), r.env)
    assert.equal(response.status, 101)
    assert.equal(github.calls.length, 1)
    assert.equal(github.calls[0].url, 'https://api.github.com/repos/owner/diag')
    assert.equal(github.calls[0].headers.Authorization, `Bearer ${TOKEN}`)
    assert.ok(!github.calls[0].url.includes(TOKEN))
    // Not in the URL form either: a token in the query string is not read at all.
    const inUrl = await live(new Request(`https://relay.test/live?role=view&token=${TOKEN}`, {headers: {Upgrade: 'websocket'}}), r.env)
    assert.equal(inUrl.status, 401)
    assert.ok(!logged.join('\n').includes(TOKEN), 'nothing logged')
    const refused = await live(viewRequest(null), r.env)
    assert.ok(!JSON.stringify(await refused.json()).includes(TOKEN))
  } finally { for (const [name, original] of spies) console[name] = original; github.restore(); r.restore() }
})

test('a GitHub rate limit or outage answers 503, never 401 or allowed, and is not remembered', async () => {
  const r = setup()
  const limited = new Response('{"message":"API rate limit exceeded"}', {status: 403, headers: {'x-ratelimit-remaining': '0'}})
  const github = stubGitHub((n) => (n === 1 ? limited : n === 2 ? new Response('', {status: 502}) : n === 3 ? Promise.reject(new Error('network down')) : n === 4 ? new Response('{"message":"abuse detection"}', {status: 403}) : new Response(JSON.stringify({permissions: {pull: true}}), {status: 200})))
  try {
    for (let i = 0; i < 4; i++) assert.equal((await live(viewRequest(), r.env)).status, 503, `answer ${i + 1}`)
    const refused = await live(viewRequest(), r.env)
    assert.equal(refused.status, 101, 'the next ask goes to GitHub again and succeeds: the 503s were not cached')
    assert.equal(github.calls.length, 5)
  } finally { github.restore(); r.restore() }
})

test('a decision is cached by the token, so a long-lived reader reconnecting does not ask GitHub every time', async () => {
  const r = setup()
  const github = stubGitHub()
  try {
    await live(viewRequest(), r.env)
    await live(viewRequest(), r.env)
    await live(viewRequest(), r.env)
    assert.equal(github.calls.length, 1)
    await live(viewRequest(OTHER_TOKEN), r.env)
    assert.equal(github.calls.length, 2, 'another token is another question')
    // The authorization check on its own, without a socket, for the reader's own error messages.
    const probe = await live(new Request('https://relay.test/live?role=view', {headers: {Authorization: `Bearer ${TOKEN}`}}), r.env)
    assert.deepEqual(await probe.json(), {ok: true})
    assert.equal((await live(new Request('https://relay.test/live?role=view'), r.env)).status, 401)
  } finally { github.restore(); r.restore() }
})

test('every reader sees every app\'s batches, labelled, and only readers do', async () => {
  const r = setup()
  const github = stubGitHub()
  try {
    const one = await connect(r.env, viewRequest())
    const two = await connect(r.env, viewRequest())
    const aya = await connect(r.env, appRequest('aya#abcd-1234'))
    const lenna = await connect(r.env, appRequest('lenna#efgh-5678'))
    r.hub.webSocketMessage(aya, new Uint8Array([1, 10, 20, 30]).buffer)
    r.hub.webSocketMessage(lenna, new Uint8Array([1, 40, 50]).buffer)
    for (const reader of [one, two]) {
      const frames = reader.frames.map(unwrapRelayFrame)
      assert.deepEqual(frames.map((f) => f.from), ['aya#abcd-1234', 'lenna#efgh-5678'])
      assert.deepEqual(frames.map((f) => [...f.payload]), [[1, 10, 20, 30], [1, 40, 50]])
    }
    assert.equal(aya.frames.length + lenna.frames.length, 0, 'apps do not hear each other')
    r.hub.webSocketMessage(one, new Uint8Array([9]).buffer)
    assert.equal(two.frames.length, 2, 'a reader cannot publish')
  } finally { github.restore(); r.restore() }
})

test('a label cannot carry control characters or markup into the reader', async () => {
  const r = setup()
  const github = stubGitHub()
  try {
    const reader = await connect(r.env, viewRequest())
    const app = await connect(r.env, appRequest('evil\u001b[31m<b>#1'))
    r.hub.webSocketMessage(app, new Uint8Array([1]).buffer)
    assert.equal(unwrapRelayFrame(reader.frames[0]).from, 'evil31mb#1')
  } finally { github.restore(); r.restore() }
})

test('apps are told whether anyone is watching, join/leave reaches readers, and nothing is forwarded to nobody', async () => {
  const r = setup()
  const github = stubGitHub()
  try {
    const app = await connect(r.env, appRequest())
    assert.deepEqual(app.texts, [{watching: false}], 'a new app starts out told nobody is watching')
    r.hub.webSocketMessage(app, new Uint8Array([1, 2, 3]).buffer)
    r.hub.webSocketMessage(app, new Uint8Array([1, 2, 3]).buffer)
    assert.equal(app.frames.length, 0)

    const first = await connect(r.env, viewRequest())
    assert.deepEqual(app.texts.at(-1), {watching: true})
    assert.deepEqual(first.texts, [{join: 'aya#abcd-1234'}], 'a reader is told who is already connected')
    assert.equal(first.frames.length, 0, 'frames sent to nobody were not kept for the first reader')
    const before = app.texts.length
    const second = await connect(r.env, viewRequest())
    assert.equal(app.texts.length, before, 'a second reader changes nothing for apps')

    r.hub.webSocketClose(first, 1000)
    assert.equal(app.texts.length, before, 'one reader left, one remains')
    r.hub.webSocketClose(second, 1000)
    assert.deepEqual(app.texts.at(-1), {watching: false})

    const late = await connect(r.env, appRequest('lenna#efgh-5678'))
    assert.deepEqual(late.texts, [{watching: false}])
    const third = await connect(r.env, viewRequest())
    const another = await connect(r.env, appRequest('bo#ijkl-9012'))
    assert.deepEqual(another.texts, [{watching: true}], 'an app arriving while someone watches is told at once')
    assert.deepEqual(third.texts.map((t) => t.join).sort(), ['aya#abcd-1234', 'bo#ijkl-9012', 'lenna#efgh-5678'].sort())
    r.hub.webSocketClose(late, 1001)
    assert.deepEqual(third.texts.at(-1), {leave: 'lenna#efgh-5678'})
  } finally { github.restore(); r.restore() }
})

test('idle sockets are answered by the runtime, not by the object', async () => {
  const r = setup()
  const github = stubGitHub()
  try {
    assert.deepEqual(r.ctx.autoResponse, ['ping', 'pong'], 'setWebSocketAutoResponse is set when the object starts')
    const reader = await connect(r.env, viewRequest())
    const app = await connect(r.env, appRequest())
    r.hub.webSocketMessage(app, 'ping')
    assert.equal(reader.frames.length, 0, 'text from an app is never forwarded')
  } finally { github.restore(); r.restore() }
})

test('an app that reconnects replaces its old socket in the readers\' view and keeps streaming', async () => {
  const r = setup()
  const github = stubGitHub()
  try {
    const reader = await connect(r.env, viewRequest())
    const old = await connect(r.env, appRequest())
    r.hub.webSocketMessage(old, new Uint8Array([1, 1]).buffer)
    r.hub.webSocketClose(old, 1006)
    const fresh = await connect(r.env, appRequest())
    assert.deepEqual(fresh.texts, [{watching: true}], 'told at once that someone is watching, so it sends its buffer')
    r.hub.webSocketMessage(fresh, new Uint8Array([1, 2]).buffer)
    assert.deepEqual(reader.texts, [{join: 'aya#abcd-1234'}, {leave: 'aya#abcd-1234'}, {join: 'aya#abcd-1234'}])
    assert.deepEqual(reader.frames.map((f) => [...unwrapRelayFrame(f).payload]), [[1, 1], [1, 2]])
  } finally { github.restore(); r.restore() }
})

test('sockets, frame size and frame rate are capped', async () => {
  const r = setup()
  const github = stubGitHub()
  const now = Date.now
  Date.now = () => 1_800_000_000_000
  try {
    const reader = await connect(r.env, viewRequest())
    const app = await connect(r.env, appRequest())
    r.hub.webSocketMessage(app, new Uint8Array(64 * 1024 + 1).buffer)
    assert.equal(app.closed.code, 1009, 'a frame over 64 KB closes the socket')
    assert.equal(reader.frames.length, 0)

    const fast = await connect(r.env, appRequest('fast#aaaa-aaaa'))
    for (let i = 0; i < 5; i++) r.hub.webSocketMessage(fast, new Uint8Array([1]).buffer)
    assert.equal(fast.closed, null, 'five in a second is allowed')
    r.hub.webSocketMessage(fast, new Uint8Array([1]).buffer)
    assert.equal(fast.closed.code, 1008, 'the sixth closes it')
    assert.equal(reader.frames.length, 5)

    Date.now = () => 1_800_000_001_000
    const slow = await connect(r.env, appRequest('slow#bbbb-bbbb'))
    r.hub.webSocketMessage(slow, new Uint8Array([1]).buffer)
    assert.equal(slow.closed, null, 'a new second starts a new count')

    // Sockets per object
    const fresh = setup()
    for (let i = 0; i < 64; i++) await connect(fresh.env, appRequest(`app${i}#aaaa-aaaa`))
    assert.equal((await live(appRequest(), fresh.env)).status, 503, 'the 65th app is turned away')
    for (let i = 0; i < 8; i++) await connect(fresh.env, viewRequest())
    assert.equal((await live(viewRequest(), fresh.env)).status, 503, 'the 9th reader is turned away')
    fresh.restore()
  } finally { Date.now = now; github.restore(); r.restore() }
})

test('the worker routes /live, keeps the old endpoints as they were, and applies the rate limit', async () => {
  const r = setup()
  const github = stubGitHub((n) => new Response('{}', {status: 201}))
  try {
    const env = {...r.env, DIAGNOSTICS_GITHUB_TOKEN: 'token'}
    const old = await worker.fetch(new Request('https://relay.test/telemetry', {method: 'POST', body: '{"from":"aya#abcd-1234","version":"0.8.0","platform":"win32"}\nH4sIAAAA', headers: {'CF-Connecting-IP': '203.0.113.1'}}), env)
    assert.equal(old.status, 200, 'a 0.8.0 upload still lands')
    assert.match((await old.json()).path, /^telemetry\/aya-abcd-1234\//)
    const credentials = await worker.fetch(new Request('https://relay.test/credentials', {method: 'POST', headers: {'CF-Connecting-IP': '203.0.113.1'}}), env)
    assert.equal(credentials.status, 503, 'unconfigured TURN answers as before')

    const upgrade = await worker.fetch(new Request('https://relay.test/live?role=app&from=aya', {headers: {Upgrade: 'websocket', 'CF-Connecting-IP': '203.0.113.1'}}), env)
    assert.equal(upgrade.status, 101)
    const plain = await worker.fetch(new Request('https://relay.test/live?role=app', {headers: {'CF-Connecting-IP': '203.0.113.1'}}), env)
    assert.equal(plain.status, 426)
    assert.equal((await worker.fetch(new Request('https://relay.test/live', {method: 'POST', headers: {'CF-Connecting-IP': '203.0.113.1'}}), env)).status, 404)
    assert.equal((await worker.fetch(new Request('https://relay.test/live?role=app', {headers: {Upgrade: 'websocket'}}), env)).status, 400, 'no client address')
    const limited = {...env, RATE_LIMITER: {limit: async () => ({success: false})}}
    assert.equal((await worker.fetch(new Request('https://relay.test/live?role=app', {headers: {Upgrade: 'websocket', 'CF-Connecting-IP': '203.0.113.1'}}), limited)).status, 429)
    assert.equal((await worker.fetch(new Request('https://relay.test/live?role=app', {headers: {Upgrade: 'websocket', 'CF-Connecting-IP': '203.0.113.1'}}), {...env, LIVE: undefined})).status, 503)
  } finally { github.restore(); r.restore() }
})

test('the Durable Object is declared SQLite-backed, the only kind the free plan allows', () => {
  const config = fs.readFileSync(new URL('../relay/wrangler.jsonc', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '')
  const parsed = JSON.parse(config)
  assert.deepEqual(parsed.migrations, [{tag: 'v1', new_sqlite_classes: ['LiveHub']}])
  assert.deepEqual(parsed.durable_objects.bindings, [{name: 'LIVE', class_name: 'LiveHub'}])
  assert.ok(!JSON.stringify(parsed.migrations).includes('"new_classes"'))
})

test('a reader that went quiet without closing (a sleeping laptop) stops counting', async () => {
  const r = setup()
  const github = stubGitHub()
  const now = Date.now
  let clock = 1_800_000_000_000
  Date.now = () => clock
  try {
    const app = await connect(r.env, appRequest())
    const asleep = await connect(r.env, viewRequest())
    const awake = await connect(r.env, viewRequest())
    assert.deepEqual(app.texts.at(-1), { watching: true })
    // Both connected 50 s ago; only one has pinged since (the runtime records the auto-response).
    clock += 50_000
    awake.lastPing = clock - 10_000
    r.hub.webSocketMessage(app, new Uint8Array([1, 2]).buffer)
    assert.equal(asleep.closed.code, 1001, 'the silent reader is closed')
    assert.equal(awake.closed, null, 'the one that pinged is kept')
    assert.equal(awake.frames.length, 1, 'and gets the frame')
    assert.equal(asleep.frames.length, 0)
    // When the last reader goes quiet the apps are told to stop streaming.
    clock += 50_000
    r.hub.webSocketMessage(app, new Uint8Array([1, 2]).buffer)
    assert.equal(awake.closed.code, 1001)
    assert.deepEqual(app.texts.at(-1), { watching: false })
    assert.equal(awake.frames.length, 1)
  } finally { Date.now = now; github.restore(); r.restore() }
})

test('stale readers do not hold the reader slots', async () => {
  const r = setup()
  const github = stubGitHub()
  const now = Date.now
  let clock = 1_800_000_000_000
  Date.now = () => clock
  try {
    const readers = []
    for (let i = 0; i < 8; i++) readers.push(await connect(r.env, viewRequest()))
    assert.equal((await live(viewRequest(), r.env)).status, 503, 'full')
    clock += 41_000
    for (const reader of readers.slice(0, 7)) reader.lastPing = clock - 5_000
    const admitted = await live(viewRequest(), r.env)
    assert.equal(admitted.status, 101, 'the eighth, silent for 41 s, gave up its slot')
    assert.equal(readers[7].closed.code, 1001)
  } finally { Date.now = now; github.restore(); r.restore() }
})
