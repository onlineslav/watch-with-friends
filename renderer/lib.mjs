import IMAGES from '../shared/images.json' with {type: 'json'}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const IMAGE_MIMES = new Set(Object.values(IMAGES.native))

export const MAX_IMAGE_BYTES = IMAGES.maxBytes

// Pictures are sent to everyone as files instead of being streamed.
export function isImagePath(filePath) {
  const ext = (/\.([^.\\/]+)$/.exec(String(filePath))?.[1] || '').toLowerCase()
  return Object.hasOwn(IMAGES.native, ext) || IMAGES.convert.includes(ext)
}

export const isImageMime = (mime) => IMAGE_MIMES.has(mime)

export function generateRoomCode(random = (bytes) => crypto.getRandomValues(bytes)) {
  const bytes = random(new Uint8Array(8))
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('')
}

export const normalizeRoomCode = (input) => String(input).toUpperCase().replace(/[^A-Z0-9]/g, '')

export const formatRoomCode = (code) => `${code.slice(0, 4)}-${code.slice(4)}`

export function formatTime(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0))
  const pad = (n) => String(n).padStart(2, '0')
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

// When two people open a video at the same moment, the later claim wins everywhere.
export function isNewerClaim(a, b) {
  return a.claimedAt !== b.claimedAt ? a.claimedAt > b.claimedAt : a.hostId > b.hostId
}

// WebRTC sends mono ~32kbps Opus unless the receiver's SDP asks for stereo. The Opus parameters this
// app uses, and why, are in shared/opus-sdp.mjs (the Trystero peer munges its own offers and answers
// with the same function; renderer/app.js munges the remote description).
export {preferStereoOpus} from '../shared/opus-sdp.mjs'

// Chromium starts video around 300kbps and takes ~20s to ramp up, so the first seconds look
// blurry. A start-bitrate hint in the receiver's SDP lets the sender begin near full quality.
export function preferHighStartBitrate(sdp, kbps = 6000) {
  const lines = sdp.split('\r\n')
  const videoPts = new Set(
    lines.map((l) => l.match(/^a=rtpmap:(\d+) (VP8|VP9|H264|AV1)\/90000/i)?.[1]).filter(Boolean),
  )
  const hint = `x-google-start-bitrate=${kbps}`
  const hasFmtp = new Set()
  const updated = lines.map((line) => {
    const match = line.match(/^a=fmtp:(\d+) (.*)$/)
    if (!match || !videoPts.has(match[1])) return line
    hasFmtp.add(match[1])
    const params = match[2].split(';').filter((p) => p && !p.startsWith('x-google-start-bitrate='))
    return `a=fmtp:${match[1]} ${[...params, hint].join(';')}`
  })
  return updated
    .flatMap((line) => {
      const pt = line.match(/^a=rtpmap:(\d+) /)?.[1]
      return pt && videoPts.has(pt) && !hasFmtp.has(pt) ? [line, `a=fmtp:${pt} ${hint}`] : [line]
    })
    .join('\r\n')
}

export const errorMessage = (err) =>
  String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
