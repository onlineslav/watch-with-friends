// Installed resources may contain an endpoint, never a shared minting token.
const fs = require('node:fs/promises')

function cleanIceServers(value) {
  if (!Array.isArray(value) || value.length > 16) throw new Error('Invalid relay server list')
  return value.map((server) => {
    const urls = [].concat(server?.urls || [])
    if (!urls.length || urls.length > 16 || urls.some((url) => typeof url !== 'string' || url.length > 500 || !/^(stun|stuns|turn|turns):[^\s]+$/i.test(url))) throw new Error('Invalid relay URL')
    const turn = urls.some((url) => /^turns?:/i.test(url))
    if (turn && (typeof server.username !== 'string' || typeof server.credential !== 'string' || server.username.length > 1000 || server.credential.length > 1000)) throw new Error('Invalid relay credentials')
    return {urls, ...(turn && {username: server.username, credential: server.credential})}
  })
}

// `endpoint` issues TURN credentials; `telemetry` receives development telemetry (main/diagnostics.js).
// Both are routes on the same Worker, and both are addresses only.
const PUBLIC_KEYS = ['endpoint', 'telemetry']
function validatePublicConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some((key) => !PUBLIC_KEYS.includes(key))) throw new Error('Packaged TURN config may contain only HTTPS endpoints. Do not package API tokens or static credentials.')
  for (const key of PUBLIC_KEYS) {
    if (config[key] !== undefined && (typeof config[key] !== 'string' || !/^https:\/\//.test(config[key]) || new URL(config[key]).username || new URL(config[key]).password)) throw new Error(`The ${key} endpoint must use HTTPS without embedded credentials`)
  }
  return config
}

function createIceLoader({readFile = fs.readFile, fetchImpl = fetch, now = Date.now, timeoutMs = 4000} = {}) {
  const cache = new Map(), pending = new Map()
  async function load(configPath, {publicOnly = false} = {}) {
    const key = `${configPath}:${publicOnly}`
    const saved = cache.get(key)
    if (saved && saved.expiresAt - now() > 120_000) return saved
    if (pending.has(key)) return pending.get(key)
    const work = (async () => {
      let config
      try { config = JSON.parse(await readFile(configPath, 'utf8')) }
      catch (error) {
        if (error.code === 'ENOENT') return {iceServers: [], expiresAt: now() + 60_000}
        throw new Error('Connection relay configuration could not be read')
      }
      if (publicOnly) validatePublicConfig(config)
      if (config.cloudflare) throw new Error('Connection relay uses an unsafe API token. Configure a credential endpoint instead.')
      if (!publicOnly && config.iceServers) return {iceServers: cleanIceServers(config.iceServers), expiresAt: now() + 60_000}
      validatePublicConfig(config)
      if (!config.endpoint) return {iceServers: [], expiresAt: now() + 60_000}
      const controller = new AbortController()
      let timer
      try {
        const result = await Promise.race([
          (async () => {
            const res = await fetchImpl(config.endpoint, {method: 'POST', signal: controller.signal, redirect: 'error', headers: {'Content-Type': 'application/json'}, body: '{}'})
            if (!res.ok) throw new Error(`Connection relay returned HTTP ${res.status}`)
            let body = ''
            for await (const chunk of res.body) {
              body += Buffer.from(chunk).toString('utf8')
              if (body.length > 32000) throw new Error('Connection relay response is too large')
            }
            const value = JSON.parse(body)
            if (!Number.isFinite(value.expiresAt) || value.expiresAt <= now() + 120_000 || value.expiresAt > now() + 86400_000) throw new Error('Connection relay returned expired or invalid credentials')
            return {iceServers: cleanIceServers(value.iceServers), expiresAt: value.expiresAt}
          })(),
          new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Connection relay timed out. Retrying in the background.')) }, timeoutMs) }),
        ])
        cache.set(key, result)
        return result
      } finally { clearTimeout(timer); controller.abort() }
    })().catch((error) => {
      if (saved?.expiresAt > now()) return {...saved, error: error.message}
      return {iceServers: [], expiresAt: now() + 15_000, error: error.message}
    }).finally(() => pending.delete(key))
    pending.set(key, work)
    return work
  }
  return load
}

const loadIceServers = createIceLoader()
module.exports = {loadIceServers, createIceLoader, cleanIceServers, validatePublicConfig}
