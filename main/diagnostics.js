'use strict'

// Development telemetry: with Settings' "Send telemetry for development" on, the diagnostic log is
// uploaded to the developer automatically, a little at a time.
//
// The app holds no secret. It posts the new part of the log (gzipped, base64) to the relay Worker's
// /telemetry route, and the Worker, which keeps a GitHub token in Cloudflare's secret storage,
// commits it to the private diagnostics repository under telemetry/<username>/<day>/. Collaborators
// on that repository read it with `npm run diagnostics`.
//
// When: shortly after it's turned on, every 15 minutes while there's anything new, and right after
// leaving a room (the end of a watch session is when a report is most useful). Nothing on quit,
// since holding the quit open would fight the updater's relaunch; the cursor in main/log.js keeps
// what wasn't sent, and the next launch sends it, which also covers a crash.
//
// The request body is one line of JSON (who, which build) and then the base64 gzip. Splitting at the
// first newline keeps the Worker's CPU time near zero where parsing a megabyte of JSON would not.

const fs = require('node:fs/promises')
const fsSync = require('node:fs')
const zlib = require('node:zlib')

const INTERVAL_MS = 15 * 60_000
const FIRST_DELAY_MS = 10_000
const TIMEOUT_MS = 60_000
const MAX_FROM = 80
// Matches the Worker's cap. Two full log files gzip to about a tenth of this.
const MAX_BODY_BYTES = 12 * 1024 * 1024

const cleanFrom = (from) => String(from || '').replace(/[^\w#.\- ]/g, '').trim().slice(0, MAX_FROM) || null

// The `telemetry` key of the relay configuration (config/turn.json in a dev run, resources/turn.json
// in a packaged app). No file or no key means this build has nowhere to send, and the checkbox says so.
async function loadEndpoint(configPath, {readFile = fs.readFile} = {}) {
  let config
  try { config = JSON.parse(await readFile(configPath, 'utf8')) } catch { return null }
  const value = config?.telemetry
  if (typeof value !== 'string' || !/^https:\/\//.test(value)) return null
  const url = new URL(value)
  return url.username || url.password ? null : value
}

const buildMeta = ({from, info = {}, now = new Date()}) => ({
  sent: now.toISOString(),
  from: cleanFrom(from),
  version: info.version ?? null,
  platform: info.platform ?? null,
  arch: info.arch ?? null,
  packaged: info.packaged ?? null,
})

// The meta line also goes inside the gzip, as a comment, so a chunk read on its own still says
// which build wrote it and the developer's concatenated day file shows where each upload starts.
function buildRequest({meta, text, gzip = zlib.gzipSync}) {
  const body = gzip(Buffer.from(`# upload ${JSON.stringify(meta)}\n${text}`, 'utf8')).toString('base64')
  if (body.length > MAX_BODY_BYTES) throw new Error('Upload too large')
  return `${JSON.stringify(meta)}\n${body}`
}

function createSender({fetchImpl = fetch, timeoutMs = TIMEOUT_MS} = {}) {
  return async function send(endpoint, request) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        signal: controller.signal,
        redirect: 'error',
        headers: {'Content-Type': 'text/plain; charset=utf-8'},
        body: request,
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
    } catch (error) {
      throw new Error(controller.signal.aborted ? 'timed out' : error.message)
    } finally {
      clearTimeout(timer)
    }
  }
}

// `settingsFile` holds {enabled, from} so main knows at launch, before any window, whether to send
// and under which name. Off unless the person turns it on.
function createUploader({log, settingsFile, endpoint, send = createSender(), record = log.record, now = () => new Date(), intervalMs = INTERVAL_MS, firstDelayMs = FIRST_DELAY_MS}) {
  let settings = {enabled: false, from: null}
  try {
    const saved = JSON.parse(fsSync.readFileSync(settingsFile, 'utf8'))
    settings = {enabled: saved.enabled === true, from: cleanFrom(saved.from)}
  } catch {}
  let available = null
  let lastSentAt = null
  let lastError = null
  let busy = null
  let interval = null
  let soon = null

  const save = () => {
    try { fsSync.writeFileSync(settingsFile, JSON.stringify(settings)) } catch {}
  }

  async function upload() {
    if (!settings.enabled) return false
    if (busy) return busy
    busy = (async () => {
      const target = await endpoint()
      available = Boolean(target)
      if (!target) return false
      const chunk = log.takeUnsent()
      if (!chunk) return true
      try {
        await send(target, buildRequest({meta: buildMeta({from: settings.from, info: log.headerInfo(), now: now()}), text: chunk.text}))
        chunk.commit()
        lastSentAt = now().getTime()
        lastError = null
        return true
      } catch (error) {
        lastError = error.message
        record('log', 'telemetry-failed', {message: error.message}, 'warn')
        return false
      }
    })().finally(() => { busy = null })
    return busy
  }

  function schedule() {
    clearInterval(interval)
    clearTimeout(soon)
    interval = soon = null
    if (!settings.enabled) return
    soon = setTimeout(upload, firstDelayMs)
    interval = setInterval(upload, intervalMs)
    soon.unref?.()
    interval.unref?.()
  }

  async function status() {
    available = Boolean(await endpoint())
    return {enabled: settings.enabled, available, lastSentAt, lastError}
  }

  function set({enabled, from} = {}) {
    const wasEnabled = settings.enabled
    if (typeof enabled === 'boolean') settings.enabled = enabled
    if (from !== undefined) settings.from = cleanFrom(from) || settings.from
    save()
    if (settings.enabled !== wasEnabled) {
      record('log', 'telemetry', {enabled: settings.enabled})
      schedule()
    }
    return status()
  }

  return {
    start: schedule,
    stop() { clearInterval(interval); clearTimeout(soon) },
    upload,
    set,
    status,
  }
}

module.exports = {INTERVAL_MS, MAX_BODY_BYTES, buildMeta, buildRequest, cleanFrom, createSender, createUploader, loadEndpoint}
