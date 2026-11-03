// Wraps the appaudio:pull IPC loop (see main/app-audio.js, native/mac-app-audio and
// native/win-app-audio) in a MediaStreamTrackGenerator, the way frames.mjs wraps
// requestVideoFrameCallback for video. This is the per-application audio path (one specific
// app's sound), distinct from the whole-system loopback and device paths in app.js. Untested here for the same reason frames.mjs is: MediaStreamTrackGenerator, AudioData
// and the native capture process are unavailable outside a real renderer/OS.
export const SAMPLE_RATE = 48000
export const CHANNELS = 2
const BYTES_PER_FRAME = CHANNELS * 4 // Float32
const FRAMES_PER_CHUNK = 960 // 20ms at 48kHz, a typical WebRTC audio quantum
const CHUNK_BYTES = FRAMES_PER_CHUNK * BYTES_PER_FRAME

// The timestamps of the audio, on the page's performance.now() clock. WebRTC's lip-sync compares the
// capture times of the audio and video tracks, and the video generators (frames.mjs, the whole-app
// share's worker, rebased to the page's clock) stamp frames with performance.now(). Audio stamped from
// 0 sits on another base, so the video was held back by however old the page was when the track started
// (measured: ~90ms for a fresh page, 2.6s and rising later on).
//
// The first quantum is stamped at `now` minus the audio that arrived with it (the newest sample of what
// was just pulled is "now"), and each later one follows by counting frames, which keeps them contiguous.
// Two things keep that count honest against the page clock. After a delivery gap (the Mac helper sends
// nothing in silence) the clock has moved on, so the stamp is re-anchored to the new data at once. And the
// helper's audio clock never runs at exactly the page's rate (tens of ppm: ~100ms in an hour), so every
// arrival nudges the count a little towards the clock (at most NUDGE_MAX_MS), enough to follow drift or
// settle a backlog burst, too little for pull jitter to move a stamp.
export const GAP_MS = 100
export const NUDGE = 0.01
export const NUDGE_MAX_MS = 2

export function createAudioStamper({now = () => performance.now(), rate = SAMPLE_RATE} = {}) {
  let startMs = null // page-clock time of the frame the count started from
  let stamped = 0 // frames given a stamp since startMs
  const reanchors = {gap: 0}
  return {
    // Call when data has just arrived; `pending` is every frame now waiting for a stamp (it includes the new ones).
    arrive(pending) {
      const at = now() - (pending / rate) * 1000 // when the first waiting frame was captured
      if (startMs == null) startMs = at - (stamped / rate) * 1000
      const drift = at - (startMs + (stamped / rate) * 1000)
      if (drift > GAP_MS) {
        reanchors.gap++
        startMs += drift
      } else {
        startMs += Math.max(-NUDGE_MAX_MS, Math.min(NUDGE_MAX_MS, drift * NUDGE))
      }
    },
    stamp(frames) {
      const us = Math.max(0, Math.round((startMs + (stamped / rate) * 1000) * 1000))
      stamped += frames
      return us
    },
    reanchors,
  }
}

// `pull` matches window.api.pull's shape: resolves {chunk} while data is coming, or
// {done: true, error?} once the source ends. Raw bytes arrive in whatever sizes the native
// process's pipe happens to deliver, so this re-buffers them into whole quanta before handing
// them to AudioData, which needs an exact frame count. `onEnded(error)` fires once, with the
// native process's error message or null for a clean end — without it, a capture that fails
// after starting (the silence timeout, or a crash) stops silently from the caller's point of
// view: the track just stops delivering anything, with no error to show or log.
export function createAppAudioTrack(pull, {onEnded, now} = {}) {
  if (typeof MediaStreamTrackGenerator !== 'function' || typeof AudioData !== 'function') return null
  const generator = new MediaStreamTrackGenerator({kind: 'audio'})
  const writer = generator.writable.getWriter()
  let buffered = new Uint8Array(0)
  const stamper = createAudioStamper({now})
  let stopped = false

  function append(chunk) {
    const merged = new Uint8Array(buffered.length + chunk.length)
    merged.set(buffered)
    merged.set(chunk, buffered.length)
    buffered = merged
  }

  async function flush() {
    while (buffered.length >= CHUNK_BYTES) {
      const piece = buffered.slice(0, CHUNK_BYTES)
      buffered = buffered.slice(CHUNK_BYTES)
      const data = new AudioData({
        format: 'f32',
        sampleRate: SAMPLE_RATE,
        numberOfFrames: FRAMES_PER_CHUNK,
        numberOfChannels: CHANNELS,
        timestamp: stamper.stamp(FRAMES_PER_CHUNK),
        data: piece,
      })
      await writer.write(data).catch(() => data.close())
    }
  }

  ;(async () => {
    try {
      for (;;) {
        if (stopped || generator.readyState === 'ended') return
        const result = await pull()
        if (stopped || generator.readyState === 'ended') return
        if (!result.chunk) {
          if (!stopped) onEnded?.(result.error || null)
          return
        }
        append(result.chunk)
        stamper.arrive(buffered.length / BYTES_PER_FRAME)
        await flush()
      }
    } finally {
      writer.close().catch(() => {})
    }
  })()

  return {track: generator, stop: () => (stopped = true)}
}
