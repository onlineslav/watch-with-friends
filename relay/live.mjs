// Live telemetry: the Worker's `/live` route and the Durable Object behind it.
//
// Apps (the ones whose owner ticked "Send telemetry for development") hold one WebSocket here and
// push batches of their log lines. A reader (`npm run diagnostics -- --live`) holds another and
// receives every app's batches as they arrive. One object, named "hub", holds all the sockets, so
// fan-out needs no coordination. Nothing is stored: GitHub stays the archive (/telemetry).
//
//   GET /live?role=app&from=<username>   WebSocket, unauthenticated like /telemetry. Sends binary
//                                        frames; receives {"watching": true|false} text frames.
//   GET /live?role=view                  WebSocket, needs `Authorization: Bearer <GitHub token>`
//                                        whose owner can read DIAGNOSTICS_REPO. Receives binary
//                                        frames [label length][label][app's frame] and text
//                                        {"join": name} / {"leave": name} frames.
//   GET /live?role=view without Upgrade  Just the authorization check: 200, 401, 403 or 503. A
//                                        WebSocket client cannot see why an upgrade was refused.
//
// Cost control (the free plan counts requests, and every inbound WebSocket message is a fraction of
// one): the object uses WebSocket hibernation, so idle sockets cost nothing while it sleeps, and
// "ping" is answered by the runtime without waking it. Apps only send while at least one reader is
// connected; the object tells them with {"watching": ...}.

const MAX_APPS = 64
const MAX_VIEWERS = 8
const MAX_FRAME = 64 * 1024
const MAX_FRAMES_PER_SECOND = 5
const MAX_NAME = 80
const OPEN = 1
// A reader pings every 15 s. One whose last word (a ping, or its connecting) is older than this is
// gone: a laptop that slept sends no close frame, and the object would otherwise count it for minutes.
const READER_STALE_MS = 40_000

const ALLOW_FOR_MS = 60_000
const DENY_FOR_MS = 15_000
const CACHE_ENTRIES = 64
const GITHUB_TIMEOUT_MS = 5000

const json = (data, status = 200, headers = {}) => Response.json(data, {status, headers: {'Cache-Control': 'no-store', ...headers}})
const clean = (value, max) => (typeof value === 'string' ? value.slice(0, max).replace(/[^\w#.\- ]/g, '').trim() : '') || null

// The pieces that exist only inside workerd, so tests can stand in for them.
export const platform = {
  pair() { const pair = new WebSocketPair(); return {client: pair[0], server: pair[1]} },
  upgraded: (webSocket) => new Response(null, {status: 101, webSocket}),
  autoResponse(ctx) { ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong')) },
}

// --- Reader authorization -------------------------------------------------------------------

const tokenFrom = (request) => /^(?:Bearer|token)\s+([\w\-]{20,255})$/i.exec(request.headers.get('Authorization') || '')?.[1] ?? null

async function digest(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Remembered per isolate by the token's hash, never the token. Only definite answers are kept: a
// GitHub outage or rate limit must not turn into a remembered "no".
const decisions = new Map()
export const clearDecisions = () => decisions.clear()

function remember(key, status, now) {
  if (decisions.size >= CACHE_ENTRIES) decisions.delete(decisions.keys().next().value)
  decisions.set(key, {status, until: now + (status === 200 ? ALLOW_FOR_MS : DENY_FOR_MS)})
}

// 200 when this token can read the repository, 401 when it is not a valid token, 403 when it is
// valid but cannot see the repository, 503 when GitHub could not say (outage, rate limit).
async function readerStatus(token, env, now = Date.now()) {
  const key = await digest(token)
  const known = decisions.get(key)
  if (known && known.until > now) return known.status
  let status
  try {
    const response = await fetch(`https://api.github.com/repos/${env.DIAGNOSTICS_REPO}`, {
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      headers: {Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'watch-with-friends-relay'},
    })
    if (response.status === 200) status = (await response.json().catch(() => null))?.permissions?.pull === true ? 200 : 403
    else if (response.status === 401) status = 401
    // 404 is how GitHub says "no such repository" to someone who may not see it.
    else if (response.status === 404) status = 403
    else if (response.status === 403) {
      const limited = response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')
        || /rate limit|abuse/i.test(await response.text().catch(() => ''))
      status = limited ? 503 : 403
    } else return 503
  } catch { return 503 }
  if (status !== 503) remember(key, status, now)
  return status
}

const REFUSALS = {
  401: ['Sign in first: gh auth login', {'WWW-Authenticate': 'Bearer realm="diagnostics"'}],
  403: ['That GitHub account cannot read the diagnostics repository', {}],
  503: ['Could not check with GitHub right now; try again shortly', {'Retry-After': '30'}],
}

// --- The route ------------------------------------------------------------------------------

export async function live(request, env) {
  if (!env.LIVE) return json({error: 'Live telemetry is not configured'}, 503)
  const url = new URL(request.url)
  const role = url.searchParams.get('role') === 'view' ? 'view' : 'app'
  const upgrade = request.headers.get('Upgrade')?.toLowerCase() === 'websocket'
  if (role === 'view') {
    if (!env.DIAGNOSTICS_REPO) return json({error: 'Live telemetry is not configured'}, 503)
    const token = tokenFrom(request)
    const status = token ? await readerStatus(token, env) : 401
    if (status !== 200) {
      const [error, headers] = REFUSALS[status]
      return json({error}, status, headers)
    }
    if (!upgrade) return json({ok: true})
  } else if (!upgrade) {
    return json({error: 'Expected a WebSocket'}, 426, {Upgrade: 'websocket'})
  }
  const target = new URL('https://hub.internal/')
  target.searchParams.set('role', role)
  if (role === 'app') target.searchParams.set('from', clean(url.searchParams.get('from'), MAX_NAME) || 'unknown')
  return env.LIVE.get(env.LIVE.idFromName('hub')).fetch(new Request(target, {headers: {Upgrade: 'websocket'}}))
}

// --- The Durable Object ---------------------------------------------------------------------

export class LiveHub {
  constructor(ctx, env) {
    this.ctx = ctx
    this.env = env
    this.rates = new Map()
    platform.autoResponse(ctx)
  }

  // When the socket last said anything the runtime can see: a ping answered by the auto-response (which
  // never wakes this object) or the moment it connected.
  lastHeard(socket) {
    const pinged = this.ctx.getWebSocketAutoResponseTimestamp?.(socket)
    return Math.max(pinged ? new Date(pinged).getTime() : 0, socket.deserializeAttachment()?.at ?? 0)
  }

  // Open sockets with this tag. Readers gone quiet are closed here, wherever readers are counted or
  // admitted, and apps are told to stop if that leaves nobody watching.
  open(tag, except = null) {
    let sockets = this.ctx.getWebSockets(tag).filter((socket) => socket !== except && socket.readyState === OPEN)
    if (tag === 'view') {
      const stale = sockets.filter((socket) => Date.now() - this.lastHeard(socket) > READER_STALE_MS)
      if (stale.length) {
        for (const socket of stale) { this.rates.delete(socket); try { socket.close(1001, 'No ping') } catch {} }
        sockets = sockets.filter((socket) => !stale.includes(socket))
        if (!sockets.length) this.tell(this.open('app'), {watching: false})
      }
    }
    return sockets
  }

  tell(sockets, message) {
    const text = JSON.stringify(message)
    for (const socket of sockets) { try { socket.send(text) } catch {} }
  }

  async fetch(request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({error: 'Expected a WebSocket'}, 426)
    const url = new URL(request.url)
    const role = url.searchParams.get('role') === 'view' ? 'view' : 'app'
    const from = role === 'app' ? clean(url.searchParams.get('from'), MAX_NAME) || 'unknown' : null
    const apps = this.open('app')
    const viewers = this.open('view')
    if (role === 'app' ? apps.length >= MAX_APPS : viewers.length >= MAX_VIEWERS) return json({error: 'Too many connections'}, 503, {'Retry-After': '60'})
    const {client, server} = platform.pair()
    this.ctx.acceptWebSocket(server, [role])
    server.serializeAttachment({role, from, at: Date.now()})
    if (role === 'app') {
      server.send(JSON.stringify({watching: viewers.length > 0}))
      this.tell(viewers, {join: from})
    } else {
      for (const app of apps) this.tell([server], {join: app.deserializeAttachment()?.from})
      if (!viewers.length) this.tell(apps, {watching: true})
    }
    return platform.upgraded(client)
  }

  // One second of arrivals per socket; a socket past the limit is closing in on being a flood and
  // is cut rather than throttled, because the app that owns it reconnects with a backoff anyway.
  tooFast(socket, now = Date.now()) {
    const second = Math.floor(now / 1000)
    const entry = this.rates.get(socket)
    if (!entry || entry.second !== second) { this.rates.set(socket, {second, count: 1}); return false }
    entry.count += 1
    return entry.count > MAX_FRAMES_PER_SECOND
  }

  webSocketMessage(socket, message) {
    const attachment = socket.deserializeAttachment() || {}
    if (this.tooFast(socket)) return socket.close(1008, 'Too many messages')
    // Readers send nothing, and text from an app is not part of the protocol ("ping" never gets here).
    if (attachment.role !== 'app' || typeof message === 'string') return
    if (message.byteLength > MAX_FRAME) return socket.close(1009, 'Frame too large')
    const viewers = this.open('view')
    if (!viewers.length) return
    const label = new TextEncoder().encode(attachment.from || 'unknown').slice(0, 255)
    const frame = new Uint8Array(1 + label.length + message.byteLength)
    frame[0] = label.length
    frame.set(label, 1)
    frame.set(new Uint8Array(message), 1 + label.length)
    for (const viewer of viewers) { try { viewer.send(frame) } catch {} }
  }

  gone(socket) {
    this.rates.delete(socket)
    const attachment = socket.deserializeAttachment() || {}
    if (attachment.role === 'app') this.tell(this.open('view', socket), {leave: attachment.from})
    else if (attachment.role === 'view' && !this.open('view', socket).length) this.tell(this.open('app'), {watching: false})
  }

  webSocketClose(socket, code) {
    try { socket.close(code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000, 'Closed') } catch {}
    this.gone(socket)
  }

  webSocketError(socket) {
    try { socket.close(1011, 'Error') } catch {}
    this.gone(socket)
  }
}
