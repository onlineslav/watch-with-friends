// The Opus parameters this app wants on every audio section, written into SDP before it is applied.
// Shared by the renderer (the remote description, renderer/app.js) and the Trystero peer, which
// scripts/patch-trystero.js copies this file next to (the local offer/answer, node_modules/.../peer.mjs).
//
// Chosen on purpose:
//   stereo=1 sprop-stereo=1   two channels both ways. WebRTC's Opus is mono unless the *receiver's* SDP
//                             says otherwise, and the decoder follows the receiver's own (local) SDP: a
//                             viewer that only munged the host's SDP decoded mono (M1.4 bench: L/R
//                             separation 0 at the viewer).
//   useinbandfec=1            Opus's built-in forward error correction: a lost packet is rebuilt from
//                             the next one. Costs a little bitrate, only while the sender sees loss.
//   usedtx=0                  no discontinuous transmission: music and quiet passages keep flowing,
//                             nothing is cut as "silence" and the receiver's clock never has gaps.
//   maxplaybackrate=48000     full bandwidth, not Opus's narrower modes.
//   maxaveragebitrate=510000  the format's own ceiling; the real cap is the sender's maxBitrate
//                             (AUDIO_MAX_BITRATE for films, Settings' choice for shares).
// Not set: cbr (constant bitrate wastes the quiet parts and loses the ladder's headroom) and ptime (the
// default 20ms packet is what the receiver's concealment and FEC are tuned for).
export const OPUS_PARAMS = ['stereo=1', 'sprop-stereo=1', 'useinbandfec=1', 'usedtx=0', 'maxplaybackrate=48000', 'maxaveragebitrate=510000']
const OWNED = /^(stereo|sprop-stereo|useinbandfec|usedtx|maxplaybackrate|maxaveragebitrate|cbr)=/i
const OPUS_RTPMAP = /^a=rtpmap:(\d+) opus\/48000\/2$/i

const withOpusParams = (params) => [
  ...params.split(';').map((p) => p.trim()).filter((p) => p && !OWNED.test(p)),
  ...OPUS_PARAMS,
].join(';')

// Every audio section that offers Opus gets the parameters, not just the first one: a connection
// that has carried several films or shares has several audio sections, and the first is usually a
// stale one. Already-correct SDP comes back unchanged, so applying this on both ends is harmless.
export function preferStereoOpus(sdp) {
  if (typeof sdp !== 'string' || !/opus\/48000\/2/i.test(sdp)) return sdp
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n'
  const out = []
  let audio = false
  let start = 0
  let pending = [] // opus payload types in the current audio section whose fmtp line is still to be seen
  const flush = () => {
    // An Opus codec with no fmtp line at all: add one right after its rtpmap line.
    for (const pt of pending) {
      const at = out.findIndex((line, i) => i >= start && line.startsWith(`a=rtpmap:${pt} `))
      if (at >= 0) out.splice(at + 1, 0, `a=fmtp:${pt} ${OPUS_PARAMS.join(';')}`)
    }
    pending = []
  }
  for (const line of sdp.split(/\r?\n/)) {
    if (line.startsWith('m=')) {
      flush()
      start = out.length
      audio = line.startsWith('m=audio ')
    }
    if (audio) {
      const map = OPUS_RTPMAP.exec(line)
      if (map) pending.push(map[1])
      const fmtp = /^a=fmtp:(\d+) (.*)$/.exec(line)
      if (fmtp && pending.includes(fmtp[1])) {
        pending = pending.filter((pt) => pt !== fmtp[1])
        out.push(`a=fmtp:${fmtp[1]} ${withOpusParams(fmtp[2])}`)
        continue
      }
    }
    out.push(line)
  }
  flush()
  return out.join(eol)
}
