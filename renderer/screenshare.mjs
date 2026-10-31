// Pure decisions for screen/window sharing. Capture (desktopCapturer, getDisplayMedia) and WebRTC
// plumbing live in main/main.js and renderer/app.js; this module only shapes and validates data.

export const MAX_SOURCES = 50
export const MAX_SOURCE_NAME = 200

// Shapes raw desktopCapturer sources into what the picker shows: capped list, bounded label,
// a thumbnail data URL or null. Main lists what it will accept; this never adds an id of its own.
export function shareSources(sources) {
  if (!Array.isArray(sources)) return []
  const result = []
  for (const source of sources) {
    if (result.length >= MAX_SOURCES) break
    if (typeof source?.id !== 'string' || !source.id) continue
    result.push({
      id: source.id,
      name: typeof source.name === 'string' ? source.name.slice(0, MAX_SOURCE_NAME) : '',
      thumbnail: typeof source.thumbnail === 'string' ? source.thumbnail : null,
    })
  }
  return result
}

// A share claims host the same way opening a file does, and plays the "no timeline" role that
// `image: {id}` plays for pictures: `id` is the claim revision as a string. `audio` records
// whether any audio track came through: whole-system loopback, or a chosen input device.
export function cleanShare(value, claimedAt) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  if (value.id !== String(claimedAt)) return null
  if (value.name !== undefined && (typeof value.name !== 'string' || value.name.length > MAX_SOURCE_NAME)) return null
  if (value.audio !== undefined && typeof value.audio !== 'boolean') return null
  return {id: value.id, name: typeof value.name === 'string' ? value.name : '', audio: value.audio === true}
}

// Whether playback controls (play/pause/seek/loop) should be disabled, matching imageMode.
export const hidesTimeline = (share) => Boolean(share)

// Each sharer also announces its own share on the room's `share` action, host or not, so several
// people can share at once: {id, name, audio} while sharing, {id: null} once stopped. `id` is the
// claimedAt the share's stream carries. Returns the share, null for a stop, undefined for junk.
export function cleanPeerShare(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  if (value.id === null) return null
  if (typeof value.id !== 'string' || !/^\d{1,15}$/.test(value.id)) return undefined
  return cleanShare(value, value.id) ?? undefined
}

// What the share grid shows: your own share first, then everyone else's by peer id. A peer's tile
// appears once the stream carrying that share's id has arrived. The host's share is also read from
// its state, so a host on a build without the `share` action still shows.
export function shareTiles({self = null, shares = new Map(), hostId = null, hostScreen = null, streams = new Map()}) {
  const tiles = []
  if (self) tiles.push({key: 'self', peerId: null, self: true, name: self.name, audio: self.audio, stream: self.stream})
  const announced = new Map(shares)
  if (hostId && hostScreen && !announced.has(hostId)) announced.set(hostId, hostScreen)
  for (const peerId of [...announced.keys()].sort()) {
    const share = announced.get(peerId)
    const entry = streams.get(peerId)
    if (!entry || String(entry.claimedAt) !== share.id) continue
    tiles.push({key: peerId, peerId, self: false, name: share.name, audio: share.audio, stream: entry.stream})
  }
  return tiles
}

// 'all', or the key of the one tile shown full size. A focus on a tile that's gone falls back to all.
export const shareView = (view, tiles) => (tiles.length > 1 && tiles.some((tile) => tile.key === view) ? view : 'all')

// Equal tiles: 2 side by side, 3–4 as 2×2, 5–8 as 3 columns.
export const gridColumns = (count) => Math.max(1, Math.ceil(Math.sqrt(count)))

// Offered in Settings, and as the constraints passed to getDisplayMedia/applyConstraints.
// Native omits width/height so the capture isn't scaled at all.
export const RESOLUTIONS = [
  {value: 'native', label: 'Native (no scaling)'},
  {value: '2160', label: '4K (3840×2160)', width: 3840, height: 2160},
  {value: '1440', label: '1440p (2560×1440)', width: 2560, height: 1440},
  {value: '1080', label: '1080p (1920×1080)', width: 1920, height: 1080},
  {value: '720', label: '720p (1280×720)', width: 1280, height: 720},
]
export const FRAME_RATES = [15, 24, 30, 60, 120]
export const DEFAULT_RESOLUTION = 'native'
export const DEFAULT_FRAME_RATE = 30
// 510kbps is Opus's own practical ceiling (also the maxaveragebitrate the receiver's SDP already
// asks for in lib.mjs's preferStereoOpus) — "Maximum" here reaches that ceiling rather than
// inventing a higher one Opus can't use.
export const AUDIO_BITRATES = [128_000, 256_000, 510_000]
export const DEFAULT_AUDIO_BITRATE = 256_000

// Validates a bitrate against the offered choices; falls back for anything else (a stale or
// hand-edited localStorage value), the same way shareVideoConstraints does for resolution/fps.
export const shareAudioBitrate = (bitrate) => (AUDIO_BITRATES.includes(bitrate) ? bitrate : DEFAULT_AUDIO_BITRATE)

// What a share gives up when the connection can't carry everything: Balanced lets the browser
// decide, Sharp text keeps resolution (frames drop), Smooth motion keeps frame rate (picture softens).
export const SHARE_PRIORITIES = [
  {value: 'balanced', label: 'Balanced (browser decides when the connection struggles)'},
  {value: 'text', label: 'Sharp text (stays crisp, may get choppy)'},
  {value: 'motion', label: 'Smooth motion (stays smooth, may get blurry)'},
]
export const DEFAULT_SHARE_PRIORITY = 'balanced'
const PRIORITY_SETTINGS = {
  balanced: {contentHint: 'detail', degradation: 'balanced'},
  text: {contentHint: 'text', degradation: 'maintain-resolution'},
  motion: {contentHint: 'motion', degradation: 'maintain-framerate'},
}
// Validates a saved priority; returns the value with the track contentHint and the sender
// degradationPreference it stands for. Junk falls back to balanced.
export function sharePriority(value) {
  const key = typeof value === 'string' && Object.hasOwn(PRIORITY_SETTINGS, value) ? value : DEFAULT_SHARE_PRIORITY
  return {value: key, ...PRIORITY_SETTINGS[key]}
}

// Shapes a resolution/frame rate preference into getDisplayMedia's video constraints, or
// MediaStreamTrack.applyConstraints() for a live change. Falls back silently on nonsense input
// (a stale localStorage value, say) rather than throwing.
export function shareVideoConstraints(resolution, frameRate) {
  const match = RESOLUTIONS.find((r) => r.value === resolution) || RESOLUTIONS[0]
  const fps = FRAME_RATES.includes(frameRate) ? frameRate : DEFAULT_FRAME_RATE
  return {
    frameRate: {ideal: fps, max: fps},
    ...(match.width && {width: {ideal: match.width, max: match.width}, height: {ideal: match.height, max: match.height}}),
  }
}

const WINDOW_SOURCE_ID = /^window:(\d+):\d+$/

// The numeric CGWindowID portion of a desktopCapturer window source id (`window:<id>:<n>`), or
// null for a screen source or anything else. App-audio capture needs a specific window's owning
// application; a whole-screen share has no single app to scope it to.
export function windowIdFromSource(id) {
  const match = typeof id === 'string' ? WINDOW_SOURCE_ID.exec(id) : null
  return match ? Number(match[1]) : null
}

// Shapes enumerateDevices() output for the audio-source picker: only real audio inputs (a
// microphone, or a virtual device like BlackHole that mirrors system/app audio on macOS).
export function audioInputs(devices) {
  if (!Array.isArray(devices)) return []
  return devices
    .filter((d) => d?.kind === 'audioinput' && typeof d.deviceId === 'string' && d.deviceId)
    .slice(0, 50)
    .map((d) => ({deviceId: d.deviceId, label: typeof d.label === 'string' && d.label ? d.label.slice(0, 200) : 'Microphone'}))
}
