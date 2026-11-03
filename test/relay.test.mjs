import test from 'node:test'
import assert from 'node:assert/strict'
import worker, {folder, parseMeta, uploadPath} from '../relay/worker.mjs'

const env = {DIAGNOSTICS_GITHUB_TOKEN: 'token', DIAGNOSTICS_REPO: 'owner/diag', RATE_LIMITER: {limit: async () => ({success: true})}}
const post = (path, body, headers = {}) => new Request(`https://relay.test${path}`, {method: 'POST', body, headers: {'CF-Connecting-IP': '203.0.113.1', ...headers}})

function stubGitHub(responses) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    calls.push({url, ...options, body: JSON.parse(options.body)})
    return new Response('{}', {status: responses.shift() ?? 201})
  }
  return {calls, restore: () => (globalThis.fetch = original)}
}

test('an upload is filed per person and per day, under a name nobody can steer', () => {
  assert.equal(folder('Aya#ABCD-1234'), 'aya-abcd-1234')
  assert.equal(folder('../../etc'), 'etc')
  assert.equal(folder(null), 'unknown')
  assert.equal(uploadPath({from: 'aya#abcd-1234'}, new Date('2026-11-02T21:04:05.678Z')), 'telemetry/aya-abcd-1234/2026-11-02/210405678.log.gz')
  assert.deepEqual(parseMeta('{"from":"a#b<script>","version":"1.0","extra":"x"}'), {from: 'a#bscript', version: '1.0', platform: null})
  assert.equal(parseMeta('not json'), null)
})

test('a well-formed upload is committed to the diagnostics repository', async () => {
  const github = stubGitHub([201])
  try {
    const response = await worker.fetch(post('/telemetry', '{"from":"aya#abcd-1234","version":"0.8.0","platform":"win32"}\nH4sIAAAA'), env)
    assert.equal(response.status, 200)
    const {path} = await response.json()
    assert.match(path, /^telemetry\/aya-abcd-1234\/\d{4}-\d\d-\d\d\/\d{9}\.log\.gz$/)
    assert.equal(github.calls.length, 1)
    assert.equal(github.calls[0].url, `https://api.github.com/repos/owner/diag/contents/${path}`)
    assert.equal(github.calls[0].method, 'PUT')
    assert.equal(github.calls[0].headers.Authorization, 'Bearer token')
    assert.equal(github.calls[0].body.content, 'H4sIAAAA')
    assert.match(github.calls[0].body.message, /aya#abcd-1234 \(v0\.8\.0, win32\)/)
  } finally { github.restore() }
})

test('two uploads racing on the branch retry instead of failing', async () => {
  const github = stubGitHub([409, 201])
  try {
    const response = await worker.fetch(post('/telemetry', '{"from":"a"}\nAAAA'), env)
    assert.equal(response.status, 200)
    assert.equal(github.calls.length, 2)
  } finally { github.restore() }
})

test('malformed, oversized, unconfigured and rate-limited uploads never reach GitHub', async () => {
  const github = stubGitHub([])
  try {
    assert.equal((await worker.fetch(post('/telemetry', 'no newline'), env)).status, 400)
    assert.equal((await worker.fetch(post('/telemetry', '{"from":"a"}\nnot base64!'), env)).status, 400)
    assert.equal((await worker.fetch(post('/telemetry', '{"from":"a"}\nAAAA', {'Content-Length': String(13 * 1024 * 1024)}), env)).status, 413)
    assert.equal((await worker.fetch(post('/telemetry', '{"from":"a"}\nAAAA'), {...env, DIAGNOSTICS_GITHUB_TOKEN: undefined})).status, 503)
    assert.equal((await worker.fetch(post('/telemetry', '{"from":"a"}\nAAAA'), {...env, RATE_LIMITER: {limit: async () => ({success: false})}})).status, 429)
    assert.equal((await worker.fetch(post('/elsewhere', ''), env)).status, 404)
    assert.equal(github.calls.length, 0)
  } finally { github.restore() }
})
