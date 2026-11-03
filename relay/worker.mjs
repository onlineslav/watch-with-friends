// Optional Worker. Deploy separately; its secrets never enter Electron.
//
// Routes:
//   /credentials  issues one-hour TURN credentials (secrets TURN_KEY_ID, TURN_API_TOKEN)
//   /telemetry    stores development telemetry from apps that opted in (secret
//                 DIAGNOSTICS_GITHUB_TOKEN, var DIAGNOSTICS_REPO): each upload is committed to the
//                 private diagnostics repository as telemetry/<username>/<day>/<time>.log.gz, where
//                 `npm run diagnostics` fetches and unpacks it.
//   GET /live     live telemetry over WebSocket (relay/live.mjs): apps push their log lines, a
//                 reader with access to the diagnostics repository watches them arrive.
//
// A /telemetry body is one line of JSON metadata and then the base64 gzip (main/diagnostics.js
// builds it). Splitting on the first newline keeps CPU time near zero on a megabyte of body, which
// parsing it as JSON would not.

import {live} from './live.mjs'
export {LiveHub} from './live.mjs'

const MAX_BODY = 12 * 1024 * 1024
const MAX_META = 8 * 1024
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

const reply = (data, status = 200) => Response.json(data, {status, headers: {'Cache-Control': 'no-store'}})

async function credentials(request, env) {
  if (!env.TURN_KEY_ID || !env.TURN_API_TOKEN) return reply({error: 'Relay is not configured'}, 503)
  const ttl = 3600
  try {
    const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate-ice-servers`, {
      method: 'POST', signal: AbortSignal.timeout(3000),
      headers: {Authorization: `Bearer ${env.TURN_API_TOKEN}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({ttl}),
    })
    if (!response.ok) return reply({error: 'Relay temporarily unavailable'}, 503)
    const {iceServers} = await response.json()
    return reply({iceServers: [].concat(iceServers || []), expiresAt: Date.now() + ttl * 1000})
  } catch { return reply({error: 'Relay temporarily unavailable'}, 503) }
}

const clean = (value, max) => (typeof value === 'string' ? value.slice(0, max).replace(/[^\w#.\- ]/g, '').trim() : '') || null

// Only what the path and commit message need. Anything else in the line is ignored.
export function parseMeta(line) {
  if (line.length > MAX_META) return null
  let meta
  try { meta = JSON.parse(line) } catch { return null }
  if (!meta || typeof meta !== 'object') return null
  return {from: clean(meta.from, 80), version: clean(meta.version, 40), platform: clean(meta.platform, 80)}
}

// "aya#abcd-1234" → "aya-abcd-1234": one folder per install's username, readable in a file list.
export const folder = (from) => (from || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown'

export function uploadPath(meta, now = new Date()) {
  const iso = now.toISOString()
  return `telemetry/${folder(meta.from)}/${iso.slice(0, 10)}/${iso.slice(11, 23).replace(/[:.]/g, '')}.log.gz`
}

async function commit(env, file, content, message) {
  // Two uploads landing at once can race on the branch head; GitHub answers 409 and a retry wins.
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`https://api.github.com/repos/${env.DIAGNOSTICS_REPO}/contents/${file}`, {
      method: 'PUT', signal: AbortSignal.timeout(20000),
      headers: {
        Authorization: `Bearer ${env.DIAGNOSTICS_GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'watch-with-friends-relay',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({message, content}),
    })
    if (response.ok) return
    if (response.status !== 409 || attempt >= 2) throw new Error(`GitHub answered ${response.status}`)
    await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)))
  }
}

export async function telemetry(request, env) {
  if (!env.DIAGNOSTICS_GITHUB_TOKEN || !env.DIAGNOSTICS_REPO) return reply({error: 'Telemetry is not configured'}, 503)
  if (Number(request.headers.get('Content-Length')) > MAX_BODY) return reply({error: 'Upload too large'}, 413)
  const raw = await request.text()
  if (raw.length > MAX_BODY) return reply({error: 'Upload too large'}, 413)
  const newline = raw.indexOf('\n')
  const meta = newline > 0 ? parseMeta(raw.slice(0, newline)) : null
  const content = newline > 0 ? raw.slice(newline + 1).trim() : ''
  if (!meta || !content || !BASE64.test(content)) return reply({error: 'Malformed upload'}, 400)
  const file = uploadPath(meta)
  try {
    await commit(env, file, content, `Telemetry from ${meta.from || 'someone'}${meta.version ? ` (v${meta.version}, ${meta.platform || '?'})` : ''}`)
    return reply({ok: true, path: file})
  } catch (error) {
    return reply({error: `Could not store the upload (${error.message})`}, 502)
  }
}

export default {
  async fetch(request, env) {
    const {pathname} = new URL(request.url)
    const route = request.method === 'POST' ? {'/credentials': credentials, '/telemetry': telemetry}[pathname]
      : request.method === 'GET' && pathname === '/live' ? live : null
    if (!route) return reply({error: 'Not found'}, 404)
    if (!env.RATE_LIMITER) return reply({error: 'Relay is not configured'}, 503)
    const ip = request.headers.get('CF-Connecting-IP')
    if (!ip) return reply({error: 'Missing client address'}, 400)
    if (!(await env.RATE_LIMITER.limit({key: ip})).success) return reply({error: 'Try again later'}, 429)
    return route(request, env)
  },
}
