// Context for the diagnostic log (M1.9), the pure half: what the person's sound output is, which of their
// Settings changed, and how a mark is made and checked. Everything here is a small function over plain
// data so it can be unit-tested; app.js does the listening and the logging.

const round = (value, places = 0) => (Number.isFinite(value) ? Math.round(value * 10 ** places) / 10 ** places : null)

// ---------- audio output device ----------

export const DEVICE_KINDS = ['builtin', 'wired', 'bluetooth', 'hdmi', 'virtual', 'unknown']

// A device name says what it is more often than not, and an empty one (the browser hides labels until
// media permission has been granted) must never fail: it is just "unknown". Order matters: a virtual
// cable named "CABLE Output (VB-Audio Virtual Cable)" is virtual however it sounds, and a headset
// whose name has "Hands-Free" in it is Bluetooth before it is a headset.
const KIND_PATTERNS = [
  ['virtual', /virtual|vb-audio|\bcable\b|voicemeeter|blackhole|loopback|soundflower|steam streaming|wave link|elgato|sonar|equalizer apo|obs\b|ndi\b|remote audio|vac\b|aggregate|multi-output/i],
  ['bluetooth', /bluetooth|airpods|\bbuds\b|galaxy buds|hands-?free|a2dp|\bbt\b|wh-1000|wf-1000|beats (?:studio|solo|flex|fit|pro)|powerbeats|jabra elite|bose (?:qc|quietcomfort|nc|700)|sony (?:wh|wf)|pixel buds|soundcore|sennheiser (?:momentum|ie)/i],
  ['hdmi', /hdmi|display ?port|\bdp\b|display audio|high definition audio.*(?:nvidia|amd|ati|intel)|(?:nvidia|amd|ati) high definition audio|intel\(r\) display|\btv\b|monitor|\blg\b ultrafine/i],
  ['wired', /headphone|headset|earphone|earbud|line[ -]?out|\baux\b|\busb\b|external|focusrite|scarlett|audient|behringer|motu|\brme\b|\bdac\b|\bsteinberg\b|presonus|speakers? \((?:usb|\d+-)/i],
  ['builtin', /built-?in|internal|macbook|imac|laptop|realtek|conexant|speakers?\b|high definition audio|cirrus|apple (?:inc|silicon)|surface|snapdragon|amd audio|ac97/i],
]

export function classifyAudioDevice(label) {
  const text = typeof label === 'string' ? label.trim() : ''
  if (!text) return 'unknown'
  for (const [kind, pattern] of KIND_PATTERNS) if (pattern.test(text)) return kind
  return 'unknown'
}

// Chromium lists the system default twice: as "default" ("Default - Speakers (Realtek)") and as the
// device itself, with the same group. The default entry says which one is in use.
const withoutPrefix = (label) => String(label || '').replace(/^(?:default|communications)\s*[-:]\s*/i, '').trim()

// enumerateDevices() output → {label, kind, outs}: the output the app plays through right now.
// `label` is null when the browser withholds names; `outs` is how many outputs exist.
export function pickOutputDevice(devices) {
  const outputs = (Array.isArray(devices) ? devices : []).filter((d) => d && d.kind === 'audiooutput')
  const chosen = outputs.find((d) => d.deviceId === 'default') || outputs[0] || null
  let label = withoutPrefix(chosen?.label)
  if (chosen?.deviceId === 'default' && chosen.groupId) {
    const real = outputs.find((d) => d !== chosen && d.groupId === chosen.groupId && d.deviceId !== 'communications' && d.label)
    if (real) label = withoutPrefix(real.label)
  }
  label = label ? label.slice(0, 80) : null
  return {label, kind: classifyAudioDevice(label), outs: outputs.length}
}

// What goes in the `audio/device` line: the device, and what the Web Audio graph reports about the way
// out (sample rate, base latency, output latency; the last is 0 or missing until sound has played).
export function describeAudioOutput(devices, context) {
  const picked = pickOutputDevice(devices)
  const seconds = (value) => (Number.isFinite(value) && value > 0 ? round(value * 1000, 1) : null)
  const out = {kind: picked.kind, label: picked.label, outs: picked.outs}
  if (context) {
    out.sr = Number.isFinite(context.sampleRate) ? context.sampleRate : null
    out.base = seconds(context.baseLatency)
    out.out = seconds(context.outputLatency)
    out.state = context.state ?? null
  }
  return out
}

// A change worth a second line: the device or the way out moved. Latency is left out of the comparison
// on purpose, because it settles a moment after sound starts and would log twice for one device.
export const audioDeviceKey = (info) => JSON.stringify([info.kind, info.label, info.outs, info.sr ?? null])

// ---------- Settings ----------

// {key: [before, after]} for the keys that differ. A value that names a device is reduced to the fact
// that it is one, since an id says nothing to a reader and a label says too much.
const SPECIAL = new Set(['system', 'app', 'none', 'default'])
const tidy = (key, value) => (key === 'audioDeviceId' && typeof value === 'string' && value && !SPECIAL.has(value) ? 'device' : value ?? null)

export function diffSettings(before, after, keys) {
  const changes = {}
  for (const key of keys) {
    const a = tidy(key, before?.[key])
    const b = tidy(key, after?.[key])
    if (a !== b) changes[key] = [a, b]
  }
  return changes
}

// ---------- marks ("something's wrong now") ----------

// The key that marks a bad moment. What a mark is, and how one from another computer is checked,
// lives in protocol.mjs beside the other messages that cross the room.
export const MARK_KEY = 'KeyX'
export const MARK_KEY_LABEL = 'X'
