const test = require('node:test')
const assert = require('node:assert/strict')
const {
  escapeFilterValue,
  imageConvertArgs,
  imageMime,
  isSubtitleSidecar,
  parseWebVtt,
  planSession,
  subtitleExtractArgs,
  summarizeProbe,
} = require('../main/plan')

test('images Chromium can show are sent as-is; others are converted to one PNG frame', () => {
  assert.equal(imageMime('C:\\Photos\\Cat.JPG'), 'image/jpeg')
  assert.equal(imageMime('clip.webp'), 'image/webp')
  assert.equal(imageMime('scan.tiff'), null)
  assert.equal(imageMime('odd.constructor'), null)
  assert.deepEqual(imageConvertArgs('scan.tiff').slice(-6), ['1', '-c:v', 'png', '-f', 'image2pipe', 'pipe:1'])
})

const probe = {
  format: {duration: '5400.5', tags: {title: 'Movie'}},
  streams: [
    {index: 0, codec_type: 'video', codec_name: 'mjpeg', disposition: {attached_pic: 1}},
    {index: 1, codec_type: 'video', codec_name: 'hevc', pix_fmt: 'yuv420p10le', width: 3840, height: 2160, color_transfer: 'smpte2084'},
    {index: 2, codec_type: 'audio', codec_name: 'dts', channels: 6, tags: {language: 'eng'}, disposition: {default: 1}},
    {index: 3, codec_type: 'subtitle', tags: {language: 'jpn'}},
    {index: 4, codec_type: 'subtitle', codec_name: 'ass', tags: {language: 'eng', title: 'Full'}},
    {index: 5, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle', tags: {language: 'eng'}},
  ],
}

const media = summarizeProbe(probe, ['C:\\Movies\\movie.en.srt'])
const allSupported = {h264: true, hevc: true, av1: true, vp9: true}
const media8Bit = summarizeProbe({
  ...probe,
  streams: probe.streams.map((s) => (s.index === 1 ? {...s, pix_fmt: 'yuv420p', color_transfer: undefined} : s)),
})

test('summarizeProbe skips cover art and keeps ffmpeg subtitle indexes', () => {
  assert.equal(media.duration, 5400.5)
  assert.equal(media.video.index, 1)
  assert.deepEqual(media.audio, [{index: 2, label: 'ENG · dts 6ch', isDefault: true}])
  assert.deepEqual(
    media.subtitles.map((s) => [s.id, s.image]),
    [['embedded:1', false], ['embedded:2', true], ['external:C:\\Movies\\movie.en.srt', false]],
  )
})

test('passes supported 8-bit video through and seeks to the keyframe', () => {
  const plan = planSession({media: media8Bit, filePath: 'C:\\Movies\\movie.mkv', start: 100, keyframe: 97.5, audioIndex: 2, support: allSupported})
  assert.equal(plan.transcoding, false)
  assert.equal(plan.offset, 97.5)
  assert.equal(plan.mime, 'video/mp4; codecs="hvc1.1.6.L153.B0,mp4a.40.2"')
  assert.deepEqual(plan.args.slice(3, 7), ['-ss', '97.700', '-i', 'C:\\Movies\\movie.mkv'])
  assert.ok(plan.args.includes('copy'))
})

test('streams an audio file as audio-only mp4, treating cover art as no video', () => {
  const song = summarizeProbe({
    format: {duration: '215.2'},
    streams: [
      {index: 0, codec_type: 'audio', codec_name: 'flac', channels: 2},
      {index: 1, codec_type: 'video', codec_name: 'mjpeg', disposition: {attached_pic: 1}},
    ],
  })
  assert.equal(song.video, null)
  const plan = planSession({media: song, filePath: 'song.flac', audioIndex: 0, support: allSupported})
  assert.equal(plan.transcoding, false)
  assert.equal(plan.mime, 'audio/mp4; codecs="mp4a.40.2"')
  assert.ok(!plan.args.includes('-c:v'))
})

test('transcodes 10-bit video even when Chromium can decode it, and tonemaps HDR', () => {
  const plan = planSession({media, filePath: 'movie.mkv', start: 100, keyframe: 97.5, support: allSupported, encoder: 'h264_nvenc', canTonemap: true})
  assert.equal(plan.transcoding, true)
  assert.equal(plan.offset, 100)
  const vf = plan.args[plan.args.indexOf('-vf') + 1]
  assert.match(vf, /^zscale=t=linear/)
  assert.match(vf, /format=nv12$/)
  assert.ok(plan.args.includes('h264_nvenc'))
})

test('burns external text subtitles using a relative, escaped filename', () => {
  const file = "C:\\Movies\\weird name, [x] 'q'; plain.srt"
  const withSub = summarizeProbe(probe, [file])
  const plan = planSession({media: withSub, filePath: 'C:\\Movies\\movie.mkv', subtitleId: `external:${file}`, support: allSupported})
  assert.equal(plan.cwd, 'C:\\Movies\\')
  assert.ok(plan.args.includes('-copyts'))
  assert.match(plan.args[plan.args.indexOf('-vf') + 1], /subtitles=filename=weird name\\, \\\[x\\\]/)
})

test('overlays image subtitles through filter_complex', () => {
  const plan = planSession({media, filePath: 'movie.mkv', subtitleId: 'embedded:2', support: allSupported})
  const graph = plan.args[plan.args.indexOf('-filter_complex') + 1]
  assert.match(graph, /\[base\]\[0:s:2\]overlay/)
  assert.equal(plan.args[plan.args.indexOf('-map') + 1], '[vout]')
})

test('escapeFilterValue escapes for both filter-graph levels', () => {
  assert.equal(escapeFilterValue("a, [b] 'c'; d:e"), String.raw`a\, \[b\] \\\'c\\\'\; d\\:e`)
})

test('subtitleExtractArgs reads an embedded track or a whole subtitle file as WebVTT', () => {
  const embedded = subtitleExtractArgs('C:\\Movies\\movie.mkv', media.subtitles[0])
  assert.deepEqual(embedded.slice(3), ['-i', 'C:\\Movies\\movie.mkv', '-map', '0:s:1', '-f', 'webvtt', 'pipe:1'])
  const external = subtitleExtractArgs('movie.mkv', media.subtitles[2], 'CP1252')
  assert.deepEqual(external.slice(3, 9), ['-sub_charenc', 'CP1252', '-i', 'C:\\Movies\\movie.en.srt', '-map', '0:s:0'])
})

test('parseWebVtt keeps timed text and drops headers, ASS overrides and drawings', () => {
  const vtt = [
    'WEBVTT',
    '',
    'NOTE a comment',
    '',
    '1',
    '01:00:02.500 --> 01:00:04.000 align:start',
    '{\\an8}<i>Top</i>',
    'second line',
    '',
    '00:01.000 --> 00:03.000',
    'm 0 0 l 100 0 100 100',
    '',
    '00:00.250 --> 00:01.000',
    'First',
    '',
  ].join('\r\n')
  assert.deepEqual(parseWebVtt(vtt), [
    {start: 0.25, end: 1, text: 'First'},
    {start: 3602.5, end: 3604, text: '<i>Top</i>\nsecond line'},
  ])
})

test('isSubtitleSidecar matches subtitles named after the video', () => {
  assert.ok(isSubtitleSidecar('/m/Movie.2020.mkv', '/m/movie.2020.en.SRT'))
  assert.ok(!isSubtitleSidecar('/m/Movie.2020.mkv', '/m/Other.srt'))
  assert.ok(!isSubtitleSidecar('/m/Movie.2020.mkv', '/m/Movie.2020.mkv'))
})

test('encodes FLAC audio when Chromium supports it, AAC otherwise', () => {
  const withFlac = planSession({media: media8Bit, filePath: 'movie.mkv', audioIndex: 2, support: {...allSupported, flac: true}})
  assert.equal(withFlac.mime, 'video/mp4; codecs="hvc1.1.6.L153.B0,flac"')
  assert.deepEqual(withFlac.args.slice(withFlac.args.indexOf('-c:a'), withFlac.args.indexOf('-c:a') + 4), ['-c:a', 'flac', '-ac', '2'])
  assert.ok(!withFlac.args.includes('-b:a'))
  const withoutFlac = planSession({media: media8Bit, filePath: 'movie.mkv', audioIndex: 2, support: allSupported})
  assert.match(withoutFlac.mime, /mp4a\.40\.2"$/)
  assert.ok(withoutFlac.args.includes('aac'))
})
