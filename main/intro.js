// Finds a TV episode's intro so the player can offer "Skip intro".
//
// Two sources, cheapest first:
// 1. A chapter the file itself names as the intro ("Intro", "Opening", "OP", "Opening Credits").
// 2. The neighbouring episode in the same folder (Plex's method): the first ten minutes of each
//    are turned into an audio fingerprint, and the longest stretch the two share (15s to 3 min) is
//    the intro. Recaps and cold opens differ between episodes; the theme does not.
//
// The pure parts (chapterIntro, fingerprint, findShared, naturalCompare, neighbours) are tested in
// test/intro.test.js. Fingerprinting runs on the main thread in slices of a few milliseconds, so the
// event loop never stalls (app/main-stall stays quiet).
const {execFile} = require('node:child_process')
const fs = require('node:fs/promises')
const path = require('node:path')

const SAMPLE_RATE = 4000
const FFT_SIZE = 1024 // 256ms window
const HOP = 256 // 64ms between frames: 75% overlap, so two copies never sit more than 32ms out of step
const FRAME_S = HOP / SAMPLE_RATE
const SCAN_S = 600 // intros start within the first ten minutes, cold open included
const MIN_INTRO_S = 15
const MAX_INTRO_S = 180
const BANDS = 33 // 32 bits from the differences between neighbouring bands (Haitsma & Kalker)
const LOW_HZ = 200
const HIGH_HZ = 1800
const SILENT_RMS = 60 // int16 units; a near-silent frame's bits are noise
const MATCH_BITS = 11 // frames match when at most this many of 32 bits differ (chance: ~10%)
const WINDOW = 32 // 2s of frames
const WINDOW_HITS = 14 // matches needed in a window for it to count as shared
const EDGE = 8 // half a second of frames at each end of a stretch...
const EDGE_HITS = 5 // ...must be mostly hits
const JOIN_GAP = Math.round(3 / FRAME_S) // a quiet beat inside the theme doesn't split it
const SLICE_MS = 4

const VIDEO_EXTENSIONS = new Set(['mkv', 'mp4', 'm4v', 'mov', 'avi', 'webm', 'wmv', 'flv', 'ts', 'm2ts', 'mts', 'mpg', 'mpeg', 'vob', 'ogv', 'divx', 'rmvb', 'asf', 'f4v'])

// ---------- Chapters ----------

const INTRO_TITLE = /^(?:intro(?:duction)?|opening(?: (?:credits|titles|theme|song|sequence))?|op ?\d{0,2}|main (?:titles?|title sequence)|title sequence|theme song|opening theme|credits opening)$/i

// ffprobe's chapters ({start_time, end_time, tags: {title}}) to the intro, in player time.
function chapterIntro(chapters, {startTime = 0, duration = 0} = {}) {
  for (const chapter of chapters || []) {
    const title = String(chapter?.tags?.title || '').replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim()
    if (!INTRO_TITLE.test(title)) continue
    const start = Number(chapter.start_time) - startTime
    const end = Number(chapter.end_time) - startTime
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0) continue
    if (end - start < 10 || end - start > 240) continue
    if (duration && start > duration / 2) continue
    return {start: round(start), end: round(end), source: 'chapter'}
  }
  return null
}

// ---------- Fingerprint ----------

const fftTables = (() => {
  const bits = Math.log2(FFT_SIZE)
  const reverse = new Uint16Array(FFT_SIZE)
  for (let i = 0; i < FFT_SIZE; i++) {
    let r = 0
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b)
    reverse[i] = r
  }
  const cos = new Float64Array(FFT_SIZE / 2), sin = new Float64Array(FFT_SIZE / 2)
  for (let i = 0; i < FFT_SIZE / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / FFT_SIZE)
    sin[i] = -Math.sin((2 * Math.PI * i) / FFT_SIZE)
  }
  const hann = new Float64Array(FFT_SIZE)
  for (let i = 0; i < FFT_SIZE; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1))
  // Log-spaced band edges as FFT bins, every band at least one bin wide.
  const edges = new Uint16Array(BANDS + 1)
  for (let b = 0; b <= BANDS; b++) {
    const hz = LOW_HZ * (HIGH_HZ / LOW_HZ) ** (b / BANDS)
    edges[b] = Math.max(b ? edges[b - 1] + 1 : 0, Math.round((hz * FFT_SIZE) / SAMPLE_RATE))
  }
  return {reverse, cos, sin, hann, edges}
})()

function bandEnergies(samples, offset, re, im, out) {
  const {reverse, cos, sin, hann, edges} = fftTables
  let power = 0
  for (let i = 0; i < FFT_SIZE; i++) {
    const v = samples[offset + i] || 0
    power += v * v
    re[reverse[i]] = v * hann[i]
    im[reverse[i]] = 0
  }
  for (let size = 2; size <= FFT_SIZE; size <<= 1) {
    const half = size >> 1, step = FFT_SIZE / size
    for (let start = 0; start < FFT_SIZE; start += size) {
      for (let k = 0; k < half; k++) {
        const a = start + k, b = a + half
        const c = cos[k * step], s = sin[k * step]
        const tr = re[b] * c - im[b] * s, ti = re[b] * s + im[b] * c
        re[b] = re[a] - tr; im[b] = im[a] - ti
        re[a] += tr; im[a] += ti
      }
    }
  }
  for (let band = 0; band < BANDS; band++) {
    let sum = 0
    for (let bin = edges[band]; bin < edges[band + 1]; bin++) sum += re[bin] * re[bin] + im[bin] * im[bin]
    out[band] = sum
  }
  return Math.sqrt(power / FFT_SIZE)
}

// Int16 mono PCM at SAMPLE_RATE to {hashes, silent}: one 32-bit hash per 64ms frame. Async in
// slices so a ten-minute clip (~9,400 frames) never holds the event loop.
async function fingerprint(samples, {yieldEvery = SLICE_MS} = {}) {
  const frames = Math.max(0, Math.floor((samples.length - FFT_SIZE) / HOP) + 1)
  const hashes = new Uint32Array(frames), silent = new Uint8Array(frames)
  const re = new Float64Array(FFT_SIZE), im = new Float64Array(FFT_SIZE)
  let previous = new Float64Array(BANDS), current = new Float64Array(BANDS)
  let sliceStart = Date.now()
  for (let n = 0; n < frames; n++) {
    const rms = bandEnergies(samples, n * HOP, re, im, current)
    silent[n] = rms < SILENT_RMS ? 1 : 0
    let hash = 0
    if (n > 0) for (let b = 0; b < BANDS - 1; b++) {
      if (current[b] - current[b + 1] - (previous[b] - previous[b + 1]) > 0) hash |= 1 << b
    }
    hashes[n] = hash >>> 0
    ;[previous, current] = [current, previous]
    if (yieldEvery && Date.now() - sliceStart >= yieldEvery) {
      await new Promise((resolve) => setImmediate(resolve))
      sliceStart = Date.now()
    }
  }
  if (frames) silent[0] = 1 // its hash has no previous frame to differ from
  return {hashes, silent}
}

function popcount(x) {
  x -= (x >>> 1) & 0x55555555
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333)
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
}

// ---------- Matching ----------

// Likely alignments between a and b: votes from frames whose upper or lower 16 bits agree exactly.
// One vote in ~65,000 by chance, so the real offset of a shared minute stands far above the rest.
function candidateOffsets(a, b, limit = 6) {
  const buckets = [new Map(), new Map()]
  for (let j = 0; j < b.hashes.length; j++) {
    if (b.silent[j]) continue
    const keys = [b.hashes[j] >>> 16, b.hashes[j] & 0xffff]
    for (let k = 0; k < 2; k++) {
      const list = buckets[k].get(keys[k])
      if (list) list.push(j); else buckets[k].set(keys[k], [j])
    }
  }
  const base = a.hashes.length
  const votes = new Uint32Array(a.hashes.length + b.hashes.length + 1)
  for (let i = 0; i < a.hashes.length; i++) {
    if (a.silent[i]) continue
    const keys = [a.hashes[i] >>> 16, a.hashes[i] & 0xffff]
    for (let k = 0; k < 2; k++) {
      const list = buckets[k].get(keys[k])
      if (!list || list.length > 64) continue // a hash that common says nothing
      for (const j of list) votes[j - i + base]++
    }
  }
  const smooth = (d) => (votes[d - 1] || 0) + votes[d] + (votes[d + 1] || 0)
  const picked = []
  const order = [...votes.keys()].filter((d) => votes[d]).sort((x, y) => smooth(y) - smooth(x))
  for (const d of order) {
    if (picked.length >= limit || smooth(d) < 4) break
    if (picked.some((p) => Math.abs(p - d) <= 3)) continue
    picked.push(d)
  }
  return picked.flatMap((d) => [d - 1, d, d + 1]).map((d) => d - base)
}

// The longest shared stretch on one alignment (b frame = a frame + offset), as frame ranges.
function runAt(a, b, offset) {
  const from = Math.max(0, -offset), to = Math.min(a.hashes.length, b.hashes.length - offset)
  if (to - from < WINDOW) return null
  const hit = new Uint8Array(to - from)
  for (let i = from; i < to; i++) {
    const j = i + offset
    hit[i - from] = !a.silent[i] && !b.silent[j] && popcount((a.hashes[i] ^ b.hashes[j]) >>> 0) <= MATCH_BITS ? 1 : 0
  }
  // A frame is inside a shared stretch when the 2s window starting at it is mostly hits.
  const runs = []
  let count = 0, open = -1
  for (let k = 0; k < WINDOW; k++) count += hit[k]
  for (let k = 0; k + WINDOW <= hit.length; k++) {
    if (k) count += hit[k + WINDOW - 1] - hit[k - 1]
    const inside = count >= WINDOW_HITS
    if (inside && open < 0) open = k
    if (!inside && open >= 0) { runs.push([open, k - 1 + WINDOW]); open = -1 }
  }
  if (open >= 0) runs.push([open, hit.length])
  const joined = []
  for (const run of runs) {
    const last = joined.at(-1)
    if (last && run[0] - last[1] <= JOIN_GAP) last[1] = Math.max(last[1], run[1]); else joined.push([...run])
  }
  let best = null
  for (let [start, end] of joined) {
    // Trim to where the hits are dense: a stray chance hit just past the theme must not stretch it.
    const dense = (from, to) => { let n = 0; for (let k = Math.max(0, from); k < Math.min(hit.length, to); k++) n += hit[k]; return n >= EDGE_HITS }
    while (start < end && !(hit[start] && dense(start, start + EDGE))) start++
    while (end > start && !(hit[end - 1] && dense(end - EDGE, end))) end--
    if (!best || end - start > best[1] - best[0]) best = [start, end]
  }
  return best && {aStart: best[0] + from, aEnd: best[1] + from, bStart: best[0] + from + offset, bEnd: best[1] + from + offset}
}

// The intro both fingerprints share, in seconds for each, or null.
function findShared(a, b) {
  let best = null
  for (const offset of candidateOffsets(a, b)) {
    const run = runAt(a, b, offset)
    if (run && (!best || run.aEnd - run.aStart > best.aEnd - best.aStart)) best = run
  }
  if (!best) return null
  const length = (best.aEnd - best.aStart) * FRAME_S
  if (length < MIN_INTRO_S || length > MAX_INTRO_S) return null
  const range = (start, end) => {
    const s = start * FRAME_S
    // End a beat early: hearing the theme's last note beats losing the episode's first line.
    return {start: round(s < 3 ? 0 : s), end: round(end * FRAME_S + (FFT_SIZE - HOP) / SAMPLE_RATE - 0.3)}
  }
  return {a: range(best.aStart, best.aEnd), b: range(best.bStart, best.bEnd)}
}

// ---------- Neighbouring episodes ----------

const collator = new Intl.Collator(undefined, {numeric: true, sensitivity: 'base'})
const naturalCompare = (x, y) => collator.compare(x, y)

// Video files beside `name`, nearest episode first: next, previous, the one after next, the one before.
// Episodes worth comparing: a double episode (2x) sits beside single ones, so it and its neighbours
// must still be compared, while a film beside a folder of episodes (~4x) is left alone. Only the first
// SCAN_S of each is read either way.
function comparableLength(own, theirs) {
  return own > 0 && theirs >= own * 0.4 && theirs <= own * 2.5
}

function neighbours(name, siblings) {
  const videos = siblings.filter((n) => VIDEO_EXTENSIONS.has(path.extname(n).slice(1).toLowerCase())).sort(naturalCompare)
  const at = videos.indexOf(name)
  if (at < 0) return []
  return [at + 1, at - 1, at + 2, at - 2].filter((i) => i >= 0 && i < videos.length && i !== at).map((i) => videos[i])
}

// ---------- Running it ----------

function run(bin, args, encoding = 'utf8') {
  return new Promise((resolve, reject) => {
    execFile(bin, args, {encoding, maxBuffer: 32 * 1024 * 1024, windowsHide: true, timeout: 90_000}, (err, stdout) => {
      if (err) reject(err); else resolve(stdout)
    })
  })
}

const round = (n) => Math.round(n * 100) / 100

function createIntroFinder({ffmpeg, ffprobe, cacheFile, record = () => {}}) {
  const prints = new Map() // file key -> fingerprint promise, for the next episode's comparison
  let saved = null
  let queue = Promise.resolve()

  const fileKey = async (filePath) => {
    const stat = await fs.stat(filePath)
    return `${path.resolve(filePath)}|${stat.size}|${Math.round(stat.mtimeMs)}`
  }
  async function loadCache() {
    if (saved) return saved
    try { saved = JSON.parse(await fs.readFile(cacheFile, 'utf8')).entries || {} } catch { saved = {} }
    return saved
  }
  async function remember(key, intro) {
    const entries = await loadCache()
    entries[key] = {...intro, at: Date.now()}
    const keys = Object.keys(entries)
    if (keys.length > 1000) for (const old of keys.sort((x, y) => entries[x].at - entries[y].at).slice(0, keys.length - 1000)) delete entries[old]
    await fs.writeFile(cacheFile, JSON.stringify({version: 1, entries})).catch(() => {})
  }

  async function facts(filePath) {
    const json = JSON.parse(await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_chapters', '-select_streams', 'a:0', '-show_entries', 'stream=index:format=start_time,duration:chapter=start_time,end_time:chapter_tags=title', filePath]))
    return {chapters: json.chapters || [], startTime: Number(json.format?.start_time) || 0, duration: Number(json.format?.duration) || 0, audio: Boolean(json.streams?.length)}
  }

  function printOf(key, filePath) {
    if (!prints.has(key)) {
      const promise = run(ffmpeg, ['-v', 'error', '-nostdin', '-i', filePath, '-map', '0:a:0', '-vn', '-sn', '-dn', '-t', String(SCAN_S), '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-'], 'buffer')
        .then((buffer) => fingerprint(new Int16Array(buffer.buffer, buffer.byteOffset, buffer.byteLength >> 1)))
      promise.catch(() => prints.delete(key))
      prints.set(key, promise)
      while (prints.size > 6) prints.delete(prints.keys().next().value)
    }
    return prints.get(key)
  }

  async function find(filePath) {
    const began = Date.now()
    const key = await fileKey(filePath)
    const cached = (await loadCache())[key]
    if (cached) return {start: cached.start, end: cached.end, source: cached.source}
    const own = await facts(filePath)
    const chapter = chapterIntro(own.chapters, own)
    if (chapter) {
      record('media', 'intro', {source: 'chapter', start: chapter.start, end: chapter.end, ms: Date.now() - began})
      await remember(key, chapter)
      return chapter
    }
    if (!own.audio || own.duration < 5 * 60) return null // films and clips have no intro to match
    const dir = path.dirname(filePath)
    const candidates = neighbours(path.basename(filePath), await fs.readdir(dir).catch(() => []))
    let tried = 0
    for (const name of candidates) {
      const other = path.join(dir, name)
      const theirs = await facts(other).catch(() => null)
      if (!theirs?.audio || !comparableLength(own.duration, theirs.duration)) continue
      tried++
      const otherKey = await fileKey(other)
      const shared = findShared(await printOf(key, filePath), await printOf(otherKey, other))
      if (shared) {
        const intro = {...shared.a, source: 'episodes'}
        record('media', 'intro', {source: 'episodes', start: intro.start, end: intro.end, tried, ms: Date.now() - began})
        await remember(key, intro)
        await remember(otherKey, {...shared.b, source: 'episodes'})
        return intro
      }
      if (tried >= 2) break
    }
    record('media', 'intro', {source: null, tried, ms: Date.now() - began})
    return null
  }

  // One search at a time: two at once would only fight over the disk.
  return {
    find(filePath) {
      const result = queue.then(() => find(filePath))
      queue = result.catch(() => {})
      return result.catch((error) => {
        record('media', 'intro-failed', {message: error?.message}, 'warn')
        return null
      })
    },
  }
}

module.exports = {FRAME_S, SAMPLE_RATE, chapterIntro, comparableLength, createIntroFinder, findShared, fingerprint, naturalCompare, neighbours}
