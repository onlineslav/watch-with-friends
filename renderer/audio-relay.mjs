// Sends a captured film's sound through Web Audio, so the published track never stops producing samples.
//
// A `<video>.captureStream()` audio track produces nothing while the element is paused. The track's RTP clock
// counts samples, so after a pause of N seconds the audio's timeline is N seconds behind the picture's, which
// `frames.mjs` stamps with the wall clock. The viewer's lip-sync then holds the sound back to line the two up:
// its audio jitter buffer grew from 250ms to 2.2s over ~30s after a 4s pause, "off by about a second" until a
// seek reset it (Lenna, 2026-11-10). A MediaStreamAudioDestinationNode renders on the AudioContext's clock
// whether or not anything feeds it, so through it a pause is silence and the timeline stays on the wall clock.
//
// The returned track behaves like the clone it replaces: `stop()` also stops the inner clone and unhooks the
// graph, and when the inner clone ends the relay stops and fires `ended` (a stopped track fires none itself).
export function relayAudio(ctx, source) {
  const inner = source.clone()
  const node = ctx.createMediaStreamSource(new MediaStream([inner]))
  const dest = ctx.createMediaStreamDestination()
  dest.channelCount = 2 // the film's stereo survives (the destination is stereo by default; said, not assumed)
  dest.channelCountMode = 'explicit'
  node.connect(dest)
  const track = dest.stream.getAudioTracks()[0]
  const stopTrack = track.stop.bind(track)
  let stopped = false
  track.stop = () => {
    if (stopped) return
    stopped = true
    stopTrack()
    inner.stop()
    try { node.disconnect() } catch {}
  }
  inner.addEventListener('ended', () => {
    if (stopped) return
    track.stop()
    track.dispatchEvent(new Event('ended'))
  }, {once: true})
  track.relayed = inner
  return track
}
