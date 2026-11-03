// ffprobe/ffmpeg process management. The renderer pulls fragmented MP4 bytes from a session
// and appends them to a MediaSource; pulling is what applies backpressure to ffmpeg.
const {execFile, spawn} = require('node:child_process')
const fs = require('node:fs/promises')
const path = require('node:path')
const {maxBytes: MAX_IMAGE_BYTES} = require('../shared/images.json')
const {
  ENCODER_ARGS,
  externalSubtitle,
  imageConvertArgs,
  imageMime,
  isSubtitleSidecar,
  lastMessage,
  parseProgress,
  parseWebVtt,
  planSession,
  sourceFacts,
  subtitleExtractArgs,
  summarizeProbe,
} = require('./plan')

// Binaries can't execute from inside the asar archive; electron-builder unpacks them beside it.
const unpacked = (p) => p.replace('app.asar', 'app.asar.unpacked')
const FFMPEG = unpacked(require('ffmpeg-static'))
const FFPROBE = unpacked(require('ffprobe-static').path)

const HIGH_WATER_BYTES = 32 * 1024 * 1024
const MAX_PULL_BYTES = 8 * 1024 * 1024

const lastLine = (text) => String(text).trim().split(/\r?\n/).pop()

function run(bin, args, encoding = 'utf8') {
  return new Promise((resolve, reject) => {
    execFile(bin, args, {encoding, maxBuffer: 64 * 1024 * 1024, windowsHide: true}, (err, stdout, stderr) => {
      if (err) reject(new Error(lastLine(stderr) || err.message))
      else resolve(stdout)
    })
  })
}

const probeCache = new Map()

async function probe(filePath) {
  const json = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath])
  const dir = path.dirname(filePath)
  const siblings = await fs.readdir(dir).catch(() => [])
  const sidecars = siblings.map((name) => path.join(dir, name)).filter((p) => isSubtitleSidecar(filePath, p))
  const media = {...summarizeProbe(JSON.parse(json), sidecars), filePath, name: path.basename(filePath)}
  probeCache.set(filePath, media)
  return media
}

// ffprobe intervals and packet times are absolute; player times are relative to the file start.
async function keyframeAtOrBefore(media, seconds) {
  const out = await run(FFPROBE, [
    '-v', 'error',
    '-read_intervals', `${(seconds + media.startTime).toFixed(3)}%+#1`,
    '-select_streams', String(media.video.index),
    '-show_entries', 'packet=pts_time',
    '-of', 'csv=p=0',
    media.filePath,
  ]).catch(() => '')
  const keyframe = parseFloat(out) - media.startTime
  return Number.isFinite(keyframe) ? keyframe : seconds
}

let capabilities = null

// Picks the first hardware H.264 encoder that actually works on this machine.
function detectCapabilities() {
  capabilities ??= (async () => {
    const candidates = {
      darwin: ['h264_videotoolbox'],
      win32: ['h264_nvenc', 'h264_qsv', 'h264_amf'],
    }[process.platform] || []
    let encoder = 'libx264'
    for (const candidate of candidates) {
      const test = ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-frames:v', '15']
      const ok = await run(FFMPEG, [...test, '-pix_fmt', 'nv12', ...ENCODER_ARGS[candidate], '-f', 'null', '-'])
        .then(() => true, () => false)
      if (ok) {
        encoder = candidate
        break
      }
    }
    const filters = await run(FFMPEG, ['-v', 'error', '-filters']).catch(() => '')
    return {encoder, canTonemap: /\bzscale\b/.test(filters) && /\btonemap\b/.test(filters)}
  })()
  return capabilities
}

const sessions = new Map()
let nextSessionId = 1

async function startSession({filePath, start = 0, audioIndex = null, subtitleId = null, support = {}, forceTranscode = false}) {
  const media = probeCache.get(filePath) || (await probe(filePath))
  if (subtitleId?.startsWith('external:') && !media.subtitles.some((s) => s.id === subtitleId)) {
    media.subtitles.push(externalSubtitle(subtitleId.slice('external:'.length)))
  }
  const {encoder, canTonemap} = await detectCapabilities()
  const options = {media, filePath, start, audioIndex, subtitleId, support, forceTranscode, encoder, canTonemap}
  let plan = planSession(options)
  if (!plan.transcoding && media.video && start > 0) {
    plan = planSession({...options, keyframe: await keyframeAtOrBefore(media, start)})
  }

  const proc = spawn(FFMPEG, plan.args, {cwd: plan.cwd || undefined, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']})
  const session = {proc, chunks: [], size: 0, done: false, killed: false, error: null, stderr: '', waiter: null}
  const wake = () => {
    const waiter = session.waiter
    session.waiter = null
    waiter?.()
  }
  session.wake = wake

  proc.stdout.on('data', (buf) => {
    session.chunks.push(buf)
    session.size += buf.length
    if (session.size > HIGH_WATER_BYTES) proc.stdout.pause()
    wake()
  })
  proc.stderr.on('data', (buf) => {
    session.stderr = (session.stderr + buf).slice(-4000)
    session.progress = parseProgress(session.stderr) ?? session.progress
  })
  proc.on('error', (err) => {
    session.error = err.message
    session.done = true
    wake()
  })
  proc.on('close', (code) => {
    session.done = true
    if (code !== 0 && !session.killed) session.error = lastMessage(session.stderr) || `ffmpeg exited with code ${code}`
    wake()
  })

  const id = nextSessionId++
  sessions.set(id, session)
  // The facts about this file and what is done to it, once per file opened (probe() makes a new media
  // object each time) and again if how it is converted changes: a retry after a decode failure, a
  // burned-in subtitle. Seeks restart ffmpeg with the same plan and say nothing.
  const facts = sourceFacts(media, plan, {audioIndex, subtitle: media.subtitles.find((s) => s.id === subtitleId) || null, forceTranscode, support, canTonemap})
  const kind = `${facts.mode}|${(facts.why || []).join(',')}|${facts.enc || ''}|${audioIndex}`
  const changed = media.factsKind !== kind
  media.factsKind = kind
  return {id, mime: plan.mime, offset: plan.offset, transcoding: plan.transcoding, encoder: plan.encoder, ...(changed && {facts})}
}

async function pull(id) {
  const session = sessions.get(id)
  if (!session) return {done: true}
  while (!session.size && !session.done && !session.killed) {
    await new Promise((resolve) => (session.waiter = resolve))
  }
  if (session.killed) return {done: true}
  if (session.size) {
    const parts = []
    let taken = 0
    while (session.chunks.length && taken < MAX_PULL_BYTES) {
      const chunk = session.chunks.shift()
      parts.push(chunk)
      taken += chunk.length
    }
    session.size -= taken
    if (session.size < HIGH_WATER_BYTES / 2) session.proc.stdout.resume()
    // `speed` is ffmpeg's own reading against real time, for the host's diagnostic log; null until it prints one.
    return {chunk: Buffer.concat(parts, taken), speed: session.progress?.speed ?? null}
  }
  sessions.delete(id)
  return {done: true, error: session.error}
}

function stopSession(id) {
  const session = sessions.get(id)
  if (!session) return
  sessions.delete(id)
  session.killed = true
  session.proc.kill()
  session.wake()
}

function stopAll() {
  for (const id of [...sessions.keys()]) stopSession(id)
}

const cueCache = new Map()
let cueReads = 0

// Cues [{start, end, text}] for a text subtitle track, or for any subtitle file when filePath is null.
function subtitleCues({filePath = null, subtitleId}) {
  const key = `${filePath}|${subtitleId}`
  if (!cueCache.has(key)) {
    if (cueReads >= 4) return Promise.reject(new Error('Several subtitle tracks are loading. Try again shortly.'))
    cueReads++
    const cues = readCues(filePath, subtitleId).then((result) => {
      if (result.length > 30000 || result.reduce((size, cue) => size + cue.text.length, 0) > 2e6) throw new Error('Subtitle track is too large')
      return result
    }).finally(() => { cueReads-- })
    if (cueCache.size >= 16) cueCache.delete(cueCache.keys().next().value)
    cueCache.set(key, cues)
    cues.catch(() => cueCache.delete(key))
  }
  return cueCache.get(key)
}

async function readCues(filePath, subtitleId) {
  if (typeof subtitleId !== 'string') throw new Error('Invalid subtitle track')
  let subtitle
  if (subtitleId.startsWith('external:')) {
    subtitle = externalSubtitle(subtitleId.slice('external:'.length))
  } else {
    const media = probeCache.get(filePath) || (await probe(filePath))
    subtitle = media.subtitles.find((s) => s.id === subtitleId)
  }
  if (!subtitle || subtitle.image) throw new Error('That subtitle track is not text.')
  const read = (charenc) => run(FFMPEG, subtitleExtractArgs(filePath, subtitle, charenc)).then(parseWebVtt)
  // Older .srt files are often Windows-1252 rather than UTF-8; ffmpeg drops or rejects those lines.
  return read().then(
    (cues) => (subtitle.kind === 'external' && !cues.length ? read('CP1252') : cues),
    (err) => {
      if (subtitle.kind !== 'external') throw err
      return read('CP1252')
    },
  )
}

// Images aren't streamed: the renderer sends the bytes to everyone. Formats Chromium can't show
// are converted to PNG first.
async function readImage(filePath) {
  const mime = imageMime(filePath)
  const tooBig = () => new Error(`That image is too big to share (the limit is ${MAX_IMAGE_BYTES / 2 ** 20} MB).`)
  if (mime && (await fs.stat(filePath)).size > MAX_IMAGE_BYTES) throw tooBig()
  const bytes = mime ? await fs.readFile(filePath) : await run(FFMPEG, imageConvertArgs(filePath), 'buffer')
  if (bytes.length > MAX_IMAGE_BYTES) throw tooBig()
  return {name: path.basename(filePath), mime: mime || 'image/png', bytes}
}

module.exports = {detectCapabilities, probe, pull, readImage, startSession, stopAll, stopSession, subtitleCues}
