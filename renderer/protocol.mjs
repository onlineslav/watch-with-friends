// Small, explicit boundaries for data that comes from another computer.
import {cleanIntro} from './skip.mjs'
import {cleanText} from './profile.mjs'
import {isYouTubeId} from '../shared/youtube.mjs'
import {cleanShare} from './screenshare.mjs'

export const PROTOCOL = 2
export const MAX_PEERS = 7 // eight people including this app
export const MAX_REVISION = 2 ** 48
export const HOST_TIMEOUT_MS = 8000
export const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
export const isId = (v) => typeof v === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(v)
export const isRevision = (v) => Number.isSafeInteger(v) && v >= 0 && v < MAX_REVISION
export const finite = (v, min = 0, max = Number.MAX_SAFE_INTEGER) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
export const nextRevision = (...values) => {
  const next = Math.max(0, ...values.filter(isRevision)) + 1
  if (!isRevision(next)) throw new Error('This room has reached its revision limit. Open a new room.')
  return next
}
export const sameClaim = (a, b) => Boolean(a && b && a.hostId === b.hostId && a.claimedAt === b.claimedAt)
export const newerClaim = (a, b) => !b || (a.claimedAt !== b.claimedAt ? a.claimedAt > b.claimedAt : a.hostId > b.hostId)
export const acceptsState = (state, current) => !current || newerClaim(state, current) || (sameClaim(state, current) && state.sequence > current.sequence)
// True only when a host reports nothing hosted at all (e.g. right after stopping a share): no
// file, image, YouTube video or playlist item, and so still "loading". A file genuinely still
// opening already has a playlistId by the time it claims host, so this can't mistake one for the other.
export const stateIsIdle = (state) => state.loading && !state.ended && !state.image && !state.screen && !state.youtubeId && !state.playlistId

export function cleanTelemetry(value) {
  if (!isRecord(value)) return null
  const ranges = {lossPct: 100, freezes: 10000, droppedFrames: 1e6, fps: 240, height: 16384, bufferMs: 2000, delayMs: 10000}
  const result = {}
  for (const [key, max] of Object.entries(ranges)) {
    if (value[key] === undefined && key === 'delayMs') continue
    if (!finite(value[key], 0, max)) return null
    result[key] = value[key]
  }
  return result
}

// A mark: one person's "something is wrong right now", sent to everyone in the room so each log can
// say what was going on at that moment (M1.9). `id` names the mark; the same id again is the same mark
// with a note added, so a one-key-press mark can be explained a moment later. This is a room action
// of its own ('mark'): copies from before M1.9 never register it, and Trystero drops a message for an
// action nobody registered before any handler sees it, so for them it does not exist.
export const MARK_NOTE_MAX = 80
export const MARK_LIMIT = 6 // marks and note edits one person may send, and one may show, per MARK_WINDOW_MS
export const MARK_WINDOW_MS = 10_000
const MARK_ID = /^[a-z0-9]{6,16}$/
const NOTE_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g

export function cleanMark(value) {
  if (!isRecord(value) || typeof value.id !== 'string' || !MARK_ID.test(value.id)) return null
  if (value.note !== undefined && typeof value.note !== 'string') return null
  const note = typeof value.note === 'string' ? value.note.replace(NOTE_CONTROLS, ' ').replace(/\s+/g, ' ').trim().slice(0, MARK_NOTE_MAX) : ''
  return {id: value.id, note}
}

export function newMarkId(random = Math.random, now = Date.now) {
  return `${now().toString(36).slice(-5)}${Math.floor(random() * 36 ** 4).toString(36).padStart(4, '0')}`
}

export function cleanSender(value) {
  return isRecord(value) && finite(value.fps, 0, 240) && finite(value.height, 0, 16384) && ['none', 'cpu', 'bandwidth', 'other'].includes(value.limit)
    ? {fps: value.fps, height: value.height, limit: value.limit} : null
}

function tracks(value, subtitles) {
  if (!Array.isArray(value) || value.length > 128) return null
  const seen = new Set()
  const result = []
  for (const item of value) {
    if (!isRecord(item) || typeof item.value !== 'string' || !(subtitles ? /^track:\d{1,3}$/ : /^\d{1,5}$/).test(item.value) || seen.has(item.value)) return null
    if (typeof item.label !== 'string' || item.label.length > 500) return null
    seen.add(item.value)
    result.push({value: item.value, label: cleanText(item.label, 200) || 'Track', ...(subtitles && {image: item.image === true, isDefault: item.isDefault === true})})
  }
  return result
}

export function cleanState(value, peerId) {
  if (!isRecord(value) || value.protocol !== PROTOCOL || value.hostId !== peerId || !isId(peerId)) return null
  if (!isRevision(value.claimedAt) || !value.claimedAt || !isRevision(value.sequence) || !isRevision(value.epoch)) return null
  if (!finite(value.time, 0, 1e9) || !finite(value.duration, 0, 1e9) || !finite(value.sentAt, 0, 1e15)) return null
  for (const key of ['loading', 'playing', 'buffering', 'loop', 'audioOnly', 'transcoding', 'ended']) if (typeof value[key] !== 'boolean') return null
  const audio = tracks(value.audio, false), subtitles = tracks(value.subtitles, true)
  if (!audio || !subtitles || typeof value.audioSelected !== 'string' || typeof value.subtitleSelected !== 'string') return null
  if (value.audioSelected && !audio.some((t) => t.value === value.audioSelected)) return null
  if (value.subtitleSelected && !subtitles.some((t) => t.value === value.subtitleSelected)) return null
  if (value.image !== null && (!isRecord(value.image) || value.image.id !== String(value.claimedAt))) return null
  const screen = value.screen == null ? null : cleanShare(value.screen, value.claimedAt)
  if (value.screen != null && !screen) return null
  if (screen && value.image) return null
  if (value.playlistId !== null && !isId(value.playlistId)) return null
  if (value.playlistPosition !== undefined && !Number.isFinite(value.playlistPosition)) return null
  if (value.finished !== undefined && typeof value.finished !== 'boolean') return null
  if (value.youtubeId != null && (!isYouTubeId(value.youtubeId) || value.image || screen)) return null
  if (value.title != null && (typeof value.title !== 'string' || value.title.length > 1000)) return null
  const viewers = {}, senders = {}
  for (const [field, cleaner, out] of [['viewers', cleanTelemetry, viewers], ['senders', cleanSender, senders]]) {
    if (!isRecord(value[field]) || Object.keys(value[field]).length > MAX_PEERS) return null
    for (const [id, stats] of Object.entries(value[field])) {
      const clean = cleaner(stats)
      if (!isId(id) || !clean) return null
      out[id] = clean
    }
  }
  return {
    protocol: PROTOCOL, hostId: peerId, claimedAt: value.claimedAt, sequence: value.sequence,
    epoch: value.epoch, sentAt: value.sentAt, time: value.time, duration: value.duration,
    title: cleanText(value.title, 200), loading: value.loading, playing: value.playing,
    buffering: value.buffering, loop: value.loop, audioOnly: value.audioOnly,
    transcoding: value.transcoding, ended: value.ended, image: value.image && {id: value.image.id}, screen,
    error: typeof value.error === 'string' ? cleanText(value.error, 200) : null,
    playlistId: value.playlistId, playlistPosition: value.playlistPosition ?? 0, finished: value.finished === true,
    ...(value.youtubeId && {youtubeId: value.youtubeId}),
    intro: cleanIntro(value.intro, value.duration),
    audio, subtitles, audioSelected: value.audioSelected,
    subtitleSelected: value.subtitleSelected, sender: cleanSender(value.sender), viewers, senders,
  }
}

export function validCommand(cmd, value, media) {
  if (cmd === 'play' || cmd === 'pause') return true
  if (cmd === 'loop') return typeof value === 'boolean'
  if (cmd === 'seek') return finite(value, 0, Math.max(0, media?.duration || 0))
  if (cmd === 'audio') return value === '' || (typeof value === 'string' && media?.audio.some((a) => String(a.index) === value))
  if (cmd === 'subtitle') return value === '' || value === null || media?.subtitles.some((s) => s.id === value && s.image)
  return false
}

export function cleanCues(cues) {
  if (!Array.isArray(cues) || cues.length > 30000) throw new Error('Invalid or oversized subtitles')
  let bytes = 0
  return cues.map((cue) => {
    if (!isRecord(cue) || !finite(cue.start, 0, 1e9) || !finite(cue.end, cue.start, 1e9) || typeof cue.text !== 'string' || cue.text.length > 16000 || (bytes += cue.text.length) > 2e6) throw new Error('Invalid or oversized subtitles')
    return {start: cue.start, end: cue.end, text: cue.text}
  })
}

// IDs, not paths, cross the room boundary. Each instance belongs to one media claim.
export class SubtitleCatalog {
  constructor() { this.local = new Map(); this.remote = new Map() }
  publish(subtitles) {
    for (const subtitle of subtitles) if (!this.remote.has(subtitle.id)) {
      if (this.remote.size >= 128) break
      this.remote.set(subtitle.id, `track:${this.remote.size}`)
    }
    return subtitles.filter((s) => this.remote.has(s.id)).slice(0, 128).map((s) => ({value: this.remote.get(s.id), label: cleanText(s.label, 200) || 'Track', image: Boolean(s.image), isDefault: Boolean(s.isDefault)}))
  }
  resolve(id) { return [...this.remote].find(([, opaque]) => opaque === id)?.[0] ?? null }
  addLocal(path) {
    const existing = [...this.local].find(([, value]) => value === path)
    if (existing) return existing[0]
    if (this.local.size >= 128) throw new Error('Too many local subtitle files')
    const id = `local:${crypto.randomUUID()}`
    this.local.set(id, path)
    return id
  }
}

// A sliding burst allowance with bounded keys, suitable for room-sized maps.
export function messageLimiter(max = 30, interval = 1000) {
  const buckets = new Map()
  return (key, now = performance.now()) => {
    for (const [id, bucket] of buckets) if (now - bucket.at >= interval) buckets.delete(id)
    let bucket = buckets.get(key)
    if (!bucket) {
      if (buckets.size >= 256) return false
      buckets.set(key, bucket = {at: now, count: 0})
    }
    return ++bucket.count <= max
  }
}

export function sessionHandler(current, getCurrent, handler, {request = false} = {}) {
  return (data, context) => {
    if (getCurrent() !== current || current.closed || !current.peers.has(context?.peerId)) {
      if (request) throw new Error('Room is no longer active')
      return
    }
    return handler(data, context)
  }
}
