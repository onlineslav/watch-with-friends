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

// `pull` matches window.api.pull's shape: resolves {chunk} while data is coming, or
// {done: true, error?} once the source ends. Raw bytes arrive in whatever sizes the native
// process's pipe happens to deliver, so this re-buffers them into whole quanta before handing
// them to AudioData, which needs an exact frame count. `onEnded(error)` fires once, with the
// native process's error message or null for a clean end — without it, a capture that fails
// after starting (the silence timeout, or a crash) stops silently from the caller's point of
// view: the track just stops delivering anything, with no error to show or log.
export function createAppAudioTrack(pull, {onEnded} = {}) {
  if (typeof MediaStreamTrackGenerator !== 'function' || typeof AudioData !== 'function') return null
  const generator = new MediaStreamTrackGenerator({kind: 'audio'})
  const writer = generator.writable.getWriter()
  let buffered = new Uint8Array(0)
  let framesWritten = 0
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
        timestamp: Math.round((framesWritten / SAMPLE_RATE) * 1e6),
        data: piece,
      })
      framesWritten += FRAMES_PER_CHUNK
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
        await flush()
      }
    } finally {
      writer.close().catch(() => {})
    }
  })()

  return {track: generator, stop: () => (stopped = true)}
}
