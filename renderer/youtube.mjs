import {isYouTubeId, isYouTubePlaylist} from '../shared/youtube.mjs'

const errors = {2: 'The YouTube video URL is invalid.', 5: 'YouTube could not play this video.',
  100: 'This YouTube video is private or no longer available.',
  101: 'This video does not allow playback outside YouTube.', 150: 'This video does not allow playback outside YouTube.',
  153: 'YouTube could not identify this app. Please update SVP and try again.'}

// How long a requested play/pause is believed before the embed's own reports take over again.
// Long enough to cover the postMessage round trip, short enough that a refused command (blocked
// autoplay, a video that will not start) stops being reported as playback.
const INTENT_MS = 2000

export class YouTubePlayer extends EventTarget {
  constructor(container) {
    super()
    this.container = container
    this.frame = null
    this.token = 0
    this.volume = 1
    this.reset()
    this.onMessage = (event) => this.receive(event)
    window.addEventListener('message', this.onMessage)
  }

  reset() {
    this.videoId = null
    this.state = -1
    this.time = 0
    this.duration = 0
    this.title = ''
    this.pending = null
    this.lastCorrection = 0
    this.intent = null
    this.intentAt = 0
  }

  get loaded() { return Boolean(this.videoId && this.ready) }
  // The embed only reports its state on a timer, so for a moment after play() or pause() it still
  // says the old thing. A <video> flips `paused` synchronously and the room broadcasts host state
  // the instant a command is applied, so without this a viewer's pause is answered with "still
  // playing" and the viewer starts itself again.
  get playing() {
    if (this.intent !== null && performance.now() - this.intentAt < INTENT_MS) return this.intent
    return this.reportedPlaying
  }
  get reportedPlaying() { return this.state === 1 || this.state === 3 }
  get ended() { return this.state === 0 }
  get buffering() { return this.state === -1 || this.state === 3 }

  ensureFrame() {
    if (this.frame) return
    const frame = document.createElement('iframe')
    frame.src = 'svp-youtube://player/index.html'
    frame.title = 'YouTube video player'
    frame.allow = 'autoplay; fullscreen; encrypted-media; picture-in-picture'
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation')
    this.frame = frame
    this.ready = false
    this.container.replaceChildren(frame)
    this.timeout = setTimeout(() => this.fail('YouTube did not respond. Check your connection and try again.'), 20000)
  }

  post(command, value) {
    this.frame?.contentWindow.postMessage({channel: 'svp-youtube', token: this.token, command, value}, '*')
  }

  open(videoId, time = 0, playing = true) {
    if (!isYouTubeId(videoId)) throw new Error('Invalid YouTube video')
    this.close()
    this.videoId = videoId
    this.pending = {videoId, time, playing}
    this.expect(playing)
    this.ensureFrame()
  }

  importPlaylist(playlistId) {
    if (!isYouTubePlaylist(playlistId)) return Promise.reject(new Error('Invalid YouTube playlist'))
    this.close()
    return new Promise((resolve, reject) => {
      this.importing = {playlistId, resolve, reject}
      this.ensureFrame()
    })
  }

  receive({source, origin, data}) {
    if (!this.frame || source !== this.frame.contentWindow || origin !== 'svp-youtube://player' || data?.channel !== 'svp-youtube') return
    if (data.type === 'ready') {
      this.ready = true
      this.setVolume(this.volume)
      if (this.importing) this.post('playlist', this.importing.playlistId)
      else {
        clearTimeout(this.timeout)
        this.post('load', this.pending)
      }
      this.dispatchEvent(new Event('ready'))
      return
    }
    if (data.token !== this.token && data.type !== 'error') return
    if (data.type === 'error') return this.fail(errors[data.value] || 'Could not load YouTube. Check the URL and your connection.')
    if (data.type === 'blocked') return this.dispatchEvent(new Event('blocked'))
    if (data.type === 'playlist' && this.importing) {
      if (!Array.isArray(data.value) || !data.value.length || !data.value.every(isYouTubeId)) return this.fail('YouTube returned an invalid playlist.')
      const {resolve} = this.importing
      this.importing = null
      clearTimeout(this.timeout)
      resolve(data.value)
      return
    }
    const value = data.value
    if (data.type !== 'state' || !value || ![-1, 0, 1, 2, 3, 5].includes(value.state) ||
        !Number.isFinite(value.time) || value.time < 0 || value.time > 1e9 ||
        !Number.isFinite(value.duration) || value.duration < 0 || value.duration > 1e9) return
    const ended = this.ended
    const playing = this.playing
    Object.assign(this, {state: value.state, time: value.time, duration: value.duration,
      title: typeof value.title === 'string' ? value.title.slice(0, 200) : ''})
    // Once the embed agrees, or the video has ended, its own state is the truth again.
    if (this.intent === this.reportedPlaying || this.ended) this.intent = null
    this.dispatchEvent(new Event('state'))
    // Only the turnover, so the room can broadcast a play or pause the way a <video> does rather
    // than on every one of the embed's four reports a second.
    if (this.playing !== playing) this.dispatchEvent(new Event('playstate'))
    if (this.ended && !ended) this.dispatchEvent(new Event('ended'))
  }

  // Host time is already adjusted for the measured peer clock by the room layer.
  sync(videoId, time, playing) {
    if (this.videoId !== videoId) this.open(videoId, time, playing)
    this.pending = {videoId, time, playing}
    if (!this.ready) return
    const now = performance.now()
    if (now - this.lastCorrection < 1000) return
    this.lastCorrection = now
    if (Math.abs(this.time - time) > 1.25) this.seek(time)
    if (playing && !this.playing) this.play()
    else if (!playing && this.playing) this.pause()
  }

  play() { this.expect(true); this.post('play') }
  pause() { this.expect(false); this.post('pause') }

  expect(playing) {
    const was = this.playing
    this.intent = playing
    this.intentAt = performance.now()
    if (this.playing !== was) this.dispatchEvent(new Event('playstate'))
  }
  seek(time) { this.post('seek', time) }
  setVolume(volume) { this.volume = volume; if (this.ready) this.post('volume', Math.min(100, Math.max(0, volume * 100))) }

  fail(message) {
    clearTimeout(this.timeout)
    if (this.importing) {
      const {reject} = this.importing
      this.importing = null
      reject(new Error(message))
    } else this.dispatchEvent(new CustomEvent('error', {detail: message}))
  }

  close() {
    clearTimeout(this.timeout)
    this.importing?.reject(new Error('YouTube playlist import was cancelled.'))
    this.importing = null
    this.frame?.remove()
    this.frame = null
    this.ready = false
    this.token++
    this.reset()
  }

  dispose() {
    this.close()
    window.removeEventListener('message', this.onMessage)
  }
}
