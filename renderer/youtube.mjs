import {isYouTubeId, isYouTubePlaylist} from '../shared/youtube.mjs'

const errors = {2: 'The YouTube video URL is invalid.', 5: 'YouTube could not play this video.',
  100: 'This YouTube video is private or no longer available.',
  101: 'This video does not allow playback outside YouTube.', 150: 'This video does not allow playback outside YouTube.',
  153: 'YouTube could not identify this app. Please update SVP and try again.'}

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
  }

  get loaded() { return Boolean(this.videoId && this.ready) }
  get playing() { return this.state === 1 || this.state === 3 }
  get ended() { return this.state === 0 }
  get buffering() { return this.state === -1 || this.state === 3 }

  ensureFrame() {
    if (this.frame) return
    // A <webview>, not an <iframe>: capturePage() on a webview guest returns the guest's own
    // pixels and excludes what this app paints over the player, which is what the face filters
    // need. It costs the handshake below, because the guest is then a top-level document.
    const frame = document.createElement('webview')
    frame.src = 'svp-youtube://player/index.html'
    this.frame = frame
    this.ready = false
    this.guestId = null
    frame.addEventListener('dom-ready', () => {
      if (this.frame !== frame) return
      this.guestId = frame.getWebContentsId()
      // The guest can only answer a window that has spoken to it first.
      frame.contentWindow?.postMessage({channel: 'svp-youtube', token: this.token, command: 'attach'}, '*')
    })
    this.container.replaceChildren(frame)
    this.timeout = setTimeout(() => this.fail('YouTube did not respond. Check your connection and try again.'), 20000)
  }

  post(command, value) {
    this.frame?.contentWindow?.postMessage({channel: 'svp-youtube', token: this.token, command, value}, '*')
  }

  open(videoId, time = 0, playing = true) {
    if (!isYouTubeId(videoId)) throw new Error('Invalid YouTube video')
    this.close()
    this.videoId = videoId
    this.pending = {videoId, time, playing}
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

  receive({origin, data}) {
    if (!this.frame || origin !== 'svp-youtube://player' || data?.channel !== 'svp-youtube') return
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
    Object.assign(this, {state: value.state, time: value.time, duration: value.duration,
      title: typeof value.title === 'string' ? value.title.slice(0, 200) : ''})
    this.dispatchEvent(new Event('state'))
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

  play() { this.post('play') }
  pause() { this.post('pause') }
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
    this.guestId = null
    this.ready = false
    this.token++
    this.reset()
  }

  dispose() {
    this.close()
    window.removeEventListener('message', this.onMessage)
  }
}
