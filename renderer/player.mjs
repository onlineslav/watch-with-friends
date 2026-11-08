// Plays a local file through ffmpeg (main process) into a MediaSource. Seeking outside the
// buffered range restarts ffmpeg at the new position; everything else is plain <video>.
import CODECS from '../shared/codecs.json'
import {errorMessage} from './lib.mjs'
import {whenIdle} from './source-buffer.mjs'

const BUFFER_AHEAD_SECONDS = 45
const KEEP_BEHIND_SECONDS = 15

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const once = (target, type) => new Promise((resolve) => target.addEventListener(type, resolve, {once: true}))

function detectSupport() {
  return Object.fromEntries(
    Object.entries(CODECS).map(([key, codec]) => [key, MediaSource.isTypeSupported(`video/mp4; codecs="${codec}"`)]),
  )
}

export class StreamPlayer extends EventTarget {
  constructor(video) {
    super()
    this.video = video
    this.support = detectSupport()
    this.generation = 0
    this.media = null
    this.audioIndex = null
    this.subtitleId = null
    this.forceTranscode = false
    this.transcoding = false
    this.encoder = null
    this.ffmpegSpeed = null // ffmpeg's own speed against real time, for the diagnostic log
    this.sessionId = null
    this.mediaSource = null
    this.sourceBuffer = null
    this.mime = null
    this.objectUrl = null
    video.addEventListener('error', () => this.recoverFromDecodeError())
  }

  get loaded() {
    return Boolean(this.media)
  }

  get duration() {
    return this.media?.duration || (Number.isFinite(this.video.duration) ? this.video.duration : 0)
  }

  async open(filePath, start = 0) {
    this.close()
    const generation = this.generation
    const media = await window.api.probe(filePath)
    if (generation !== this.generation) return false
    this.media = media
    this.audioIndex = (media.audio.find((a) => a.isDefault) || media.audio[0])?.index ?? null
    // Only image subtitles are burned in; text ones are drawn by each person's app.
    this.subtitleId = media.subtitles.find((s) => s.isDefault && s.image)?.id ?? null
    // The app's language settings (renderer/languages.mjs) can choose instead; the file's own
    // defaults stay if they can't, or if choosing throws.
    try {
      const pick = this.pickTracks?.(media)
      if (pick) {
        if (media.audio.some((a) => a.index === pick.audioIndex)) this.audioIndex = pick.audioIndex
        this.subtitleId = media.subtitles.some((s) => s.id === pick.subtitleId && s.image) ? pick.subtitleId : null
      }
    } catch (error) {
      this.emit('pick-failed', error)
    }
    this.forceTranscode = false
    await this.attachSource()
    if (generation !== this.generation) return false
    this.emit('media')
    await this.startAt(Math.min(Math.max(0, start), Math.max(0, this.duration - 0.5)))
    return true
  }

  close() {
    this.generation++
    this.stopSession()
    this.media = null
    this.transcoding = false
    this.releaseSource()
    this.video.removeAttribute('src')
    this.video.load()
  }

  seek(seconds) {
    if (!this.media) return
    const target = Math.min(Math.max(0, seconds), Math.max(0, this.duration - 0.5))
    if (this.isBuffered(target)) this.video.currentTime = target
    else this.startAt(target)
  }

  setAudio(index) {
    if (!this.media || index === this.audioIndex) return
    this.audioIndex = index
    this.startAt(this.video.currentTime)
  }

  setSubtitle(id) {
    if (!this.media || (id || null) === this.subtitleId) return
    this.subtitleId = id || null
    this.startAt(this.video.currentTime)
  }

  addExternalSubtitle(path) {
    const id = `external:${path}`
    if (this.media && !this.media.subtitles.some((s) => s.id === id)) {
      const label = path.split(/[\\/]/).pop()
      this.media.subtitles.push({id, kind: 'external', path, image: false, label, isDefault: false})
      this.emit('media')
    }
    return id
  }

  async attachSource() {
    this.releaseSource()
    const mediaSource = new MediaSource()
    this.mediaSource = mediaSource
    this.objectUrl = URL.createObjectURL(mediaSource)
    this.video.src = this.objectUrl
    await once(mediaSource, 'sourceopen')
    if (this.media?.duration && this.mediaSource === mediaSource) mediaSource.duration = this.media.duration
  }

  releaseSource() {
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl)
    this.objectUrl = null
    this.mediaSource = null
    this.sourceBuffer = null
    this.mime = null
  }

  stopSession() {
    if (this.sessionId != null) window.api.stopSession(this.sessionId)
    this.sessionId = null
  }

  async startAt(seconds) {
    if (!this.media) return
    const generation = ++this.generation
    this.stopSession()
    this.emit('loading')
    try {
      const session = await window.api.startSession({
        filePath: this.media.filePath,
        start: seconds,
        audioIndex: this.audioIndex,
        subtitleId: this.subtitleId,
        support: this.support,
        forceTranscode: this.forceTranscode,
      })
      if (generation !== this.generation) return window.api.stopSession(session.id)
      this.sessionId = session.id
      this.transcoding = session.transcoding
      this.encoder = session.encoder
      this.ffmpegSpeed = null
      await this.resetBuffer(session.mime)
      if (generation !== this.generation) return
      await whenIdle(this.sourceBuffer) // a remove or append of the last session may still be running
      if (generation !== this.generation) return
      this.sourceBuffer.timestampOffset = session.offset
      this.video.currentTime = Math.max(seconds, session.offset)
      this.emit('session')
      this.pump(generation, session.id)
    } catch (err) {
      if (generation === this.generation) this.fail(err)
    }
  }

  async resetBuffer(mime) {
    if (!this.sourceBuffer) {
      this.sourceBuffer = this.mediaSource.addSourceBuffer(mime)
      this.mime = mime
      return
    }
    const buffer = this.sourceBuffer
    // abort() also resets the parser so the next session's init segment starts clean.
    if (this.mediaSource.readyState === 'open') buffer.abort()
    if (mime !== this.mime) {
      buffer.changeType(mime)
      this.mime = mime
    }
    await whenIdle(buffer) // abort() queues an updateend of its own; remove() must not start before the buffer is idle
    if (buffer.buffered.length) {
      buffer.remove(0, Infinity)
      await whenIdle(buffer)
    }
  }

  async pump(generation, sessionId) {
    try {
      for (;;) {
        if (generation !== this.generation) return
        if (this.bufferedAhead() >= BUFFER_AHEAD_SECONDS) {
          await this.evictPlayed()
          await sleep(500)
          continue
        }
        const result = await window.api.pull(sessionId)
        if (generation !== this.generation) return
        if (result.speed != null) this.ffmpegSpeed = result.speed
        if (result.chunk) {
          await this.append(generation, result.chunk)
          continue
        }
        if (result.error) throw new Error(result.error)
        if (this.mediaSource.readyState === 'open' && !this.sourceBuffer.updating) this.mediaSource.endOfStream()
        return
      }
    } catch (err) {
      if (generation === this.generation) this.fail(err)
    }
  }

  async append(generation, chunk) {
    for (;;) {
      if (generation !== this.generation) return
      try {
        this.sourceBuffer.appendBuffer(chunk)
        await whenIdle(this.sourceBuffer)
        this.skipLeadingGap()
        return
      } catch (err) {
        if (err.name !== 'QuotaExceededError') throw err
        await this.evictPlayed()
        await sleep(1000)
      }
    }
  }

  // If the stream starts slightly after the requested time, jump to the first buffered frame.
  skipLeadingGap() {
    const buffered = this.sourceBuffer?.buffered
    if (buffered?.length && this.video.readyState < 3 && this.video.currentTime < buffered.start(0) - 0.25) {
      this.video.currentTime = buffered.start(0)
    }
  }

  async evictPlayed() {
    const buffer = this.sourceBuffer
    const end = this.video.currentTime - KEEP_BEHIND_SECONDS
    if (!buffer || buffer.updating || !buffer.buffered.length || buffer.buffered.start(0) >= end - 1) return
    buffer.remove(0, end)
    await whenIdle(buffer)
  }

  bufferedAhead() {
    const buffered = this.sourceBuffer?.buffered
    const t = this.video.currentTime
    if (!buffered) return 0
    for (let i = 0; i < buffered.length; i++) {
      if (t >= buffered.start(i) - 0.5 && t <= buffered.end(i)) return buffered.end(i) - t
    }
    return 0
  }

  isBuffered(t) {
    const buffered = this.sourceBuffer?.buffered
    if (!buffered) return false
    for (let i = 0; i < buffered.length; i++) {
      if (t >= buffered.start(i) && t <= buffered.end(i) - 1) return true
    }
    return false
  }

  // Chromium sometimes reports a codec as supported but can't decode this particular file
  // (e.g. HEVC without a hardware decoder). Retry once with full conversion.
  async recoverFromDecodeError() {
    if (!this.media || !this.video.error) return
    if (this.forceTranscode) return this.fail(new Error(this.video.error.message || 'This file could not be decoded.'))
    const resumeAt = this.video.currentTime
    const wasPlaying = !this.video.paused
    this.forceTranscode = true
    const generation = ++this.generation
    this.stopSession()
    await this.attachSource()
    if (generation !== this.generation) return
    await this.startAt(resumeAt)
    if (wasPlaying) this.video.play().catch(() => {})
  }

  fail(err) {
    this.emit('error', errorMessage(err))
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, {detail}))
  }
}
