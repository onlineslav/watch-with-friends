import test from 'node:test'
import assert from 'node:assert/strict'
import {
  formatTime,
  generateRoomCode,
  isImageMime,
  isImagePath,
  isNewerClaim,
  normalizeRoomCode,
  preferHighStartBitrate,
  preferStereoOpus,
} from '../renderer/lib.mjs'

test('isImagePath and isImageMime recognise pictures that can be shared', () => {
  assert.ok(isImagePath('C:\\Photos\\Cat.JPG'))
  assert.ok(isImagePath('/scans/page.tiff'))
  assert.ok(!isImagePath('movie.mkv'))
  assert.ok(!isImagePath('C:\\folder.png\\notes'))
  assert.ok(!isImagePath('odd.constructor'))
  assert.ok(isImageMime('image/webp'))
  assert.ok(!isImageMime('image/svg+xml'))
  assert.ok(!isImageMime(undefined))
})

test('preferHighStartBitrate adds the hint to video codecs, with or without an fmtp line', () => {
  const sdp = [
    'm=video 9 UDP/TLS/RTP/SAVPF 96 98',
    'a=rtpmap:96 VP8/90000',
    'a=rtcp-fb:96 nack',
    'a=rtpmap:98 VP9/90000',
    'a=fmtp:98 profile-id=0',
    'a=rtpmap:111 opus/48000/2',
    'a=fmtp:111 minptime=10',
    '',
  ].join('\r\n')
  const out = preferHighStartBitrate(sdp, 5000)
  assert.ok(out.includes('a=rtpmap:96 VP8/90000\r\na=fmtp:96 x-google-start-bitrate=5000\r\n'))
  assert.ok(out.includes('a=fmtp:98 profile-id=0;x-google-start-bitrate=5000\r\n'))
  assert.ok(out.includes('a=fmtp:111 minptime=10\r\n'))
  assert.equal(preferHighStartBitrate(out, 5000), out)
})

test('room codes survive being typed back in any format', () => {
  const code = generateRoomCode()
  assert.match(code, /^[A-Z2-9]{8}$/)
  assert.equal(normalizeRoomCode(` ${code.slice(0, 4).toLowerCase()} - ${code.slice(4)} `), code)
})

test('formatTime', () => {
  assert.equal(formatTime(0), '0:00')
  assert.equal(formatTime(65.9), '1:05')
  assert.equal(formatTime(3725), '1:02:05')
})

test('isNewerClaim breaks ties by host id', () => {
  assert.ok(isNewerClaim({claimedAt: 2, hostId: 'a'}, {claimedAt: 1, hostId: 'b'}))
  assert.ok(isNewerClaim({claimedAt: 1, hostId: 'b'}, {claimedAt: 1, hostId: 'a'}))
  assert.ok(!isNewerClaim({claimedAt: 1, hostId: 'a'}, {claimedAt: 1, hostId: 'b'}))
})

test('preferStereoOpus rewrites only the opus fmtp line', () => {
  const sdp = [
    'm=audio 9 UDP/TLS/RTP/SAVPF 111 63',
    'a=rtpmap:111 opus/48000/2',
    'a=fmtp:111 minptime=10;useinbandfec=1;stereo=0',
    'a=rtpmap:63 red/48000/2',
    'a=fmtp:63 111/111',
    '',
  ].join('\r\n')
  const out = preferStereoOpus(sdp)
  assert.ok(out.includes(`a=fmtp:111 minptime=10;${OPUS}\r\n`), out)
  assert.ok(out.includes('a=fmtp:63 111/111\r\n'))
})

// The parameters the app chooses on purpose (shared/opus-sdp.mjs): stereo both ways, in-band FEC on,
// DTX off, full band, the bitrate ceiling, and neither cbr nor ptime.
const OPUS = 'stereo=1;sprop-stereo=1;useinbandfec=1;usedtx=0;maxplaybackrate=48000;maxaveragebitrate=510000'

// What Chromium writes for a connection that has carried a film, been republished twice (three audio
// sections: two stale, the live one last) and has a video section between them.
const section = (mid, fmtp) => [`m=audio 9 UDP/TLS/RTP/SAVPF 111 63`, `a=mid:${mid}`, 'a=rtpmap:111 opus/48000/2', 'a=rtpmap:63 red/48000/2', ...(fmtp ? [`a=fmtp:111 ${fmtp}`] : []), 'a=fmtp:63 111/111'].join('\r\n')
const THREE_AUDIO = ['v=0', section(0, 'minptime=10;useinbandfec=1'), 'm=video 9 UDP/TLS/RTP/SAVPF 96', 'a=mid:1', 'a=rtpmap:96 H264/90000', section(2, 'minptime=10;useinbandfec=1;stereo=0;cbr=1'), section(3, null), ''].join('\r\n')

test('preferStereoOpus gives every audio section its parameters, not only the first', () => {
  const out = preferStereoOpus(THREE_AUDIO)
  const fmtps = out.split('\r\n').filter((l) => l.startsWith('a=fmtp:111 '))
  assert.equal(fmtps.length, 3, 'a section with no fmtp line gets one')
  assert.equal(fmtps[0], `a=fmtp:111 minptime=10;${OPUS}`)
  assert.equal(fmtps[1], `a=fmtp:111 minptime=10;${OPUS}`, 'a stereo=0 and a cbr=1 are replaced, not kept')
  assert.equal(fmtps[2], `a=fmtp:111 ${OPUS}`)
  assert.equal(out.match(/a=fmtp:96/g), null, 'the video section is not touched')
  assert.equal(out.match(/a=fmtp:63 111\/111/g).length, 3, 'RED lines are not touched')
  assert.ok(!out.includes('cbr='), 'no cbr')
  assert.ok(!/^a=ptime/m.test(out), 'no ptime')
  assert.ok(out.indexOf('a=fmtp:111 ') > out.indexOf('a=rtpmap:111'), 'a new fmtp line follows its rtpmap')
})

test('preferStereoOpus is idempotent, keeps the line endings, and leaves SDP without Opus alone', () => {
  const once = preferStereoOpus(THREE_AUDIO)
  assert.equal(preferStereoOpus(once), once)
  assert.equal(preferStereoOpus(THREE_AUDIO.replace(/\r\n/g, '\n')).includes('\r'), false)
  const nothing = 'v=0\r\nm=audio 9 X 0\r\na=rtpmap:0 PCMU/8000\r\n'
  assert.equal(preferStereoOpus(nothing), nothing)
  assert.equal(preferStereoOpus(null), null)
  assert.equal(preferStereoOpus(''), '')
})
