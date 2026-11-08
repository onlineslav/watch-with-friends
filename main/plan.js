// Pure decisions about how to turn any file ffmpeg can read into a fragmented MP4 that
// Chromium's MediaSource can play. No I/O here so it stays unit-testable.
const CODECS = require('../shared/codecs.json')
const IMAGES = require('../shared/images.json')

const IMAGE_SUBTITLE_CODECS = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub'])
const SUBTITLE_EXTENSIONS = ['.srt', '.ass', '.ssa', '.vtt']
const HDR_TRANSFERS = new Set(['smpte2084', 'arib-std-b67'])

// Near-transparent first encode: this output only crosses a local pipe to the host's own MediaSource, then WebRTC re-encodes it, so bandwidth is free.
const ENCODER_ARGS = {
  libx264: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17'],
  h264_nvenc: ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '18', '-b:v', '0'],
  h264_qsv: ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '19'],
  h264_amf: ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', '17', '-qp_p', '19'],
  h264_videotoolbox: ['-c:v', 'h264_videotoolbox', '-b:v', '20M', '-realtime', '1'],
}

const baseName = (p) => p.split(/[\\/]/).pop()
const dirName = (p) => p.slice(0, p.length - baseName(p).length) || '.'

function trackLabel(stream, n, extra) {
  const tags = stream.tags || {}
  const lang = tags.language && tags.language !== 'und' ? tags.language.toUpperCase() : null
  const parts = [tags.title, lang, extra].filter(Boolean)
  return parts.length ? parts.join(' · ') : `Track ${n + 1}`
}

// What renderer/languages.mjs needs to pick a default track from the person's language settings.
// Viewers only see the label, so the flags a title doesn't already say are added to it (trackFlagLabel).
function trackFacts(stream) {
  const tags = stream.tags || {}
  const d = stream.disposition || {}
  return {
    language: tags.language || null,
    title: tags.title || null,
    original: d.original === 1,
    dub: d.dub === 1,
    commentary: d.comment === 1,
    described: d.visual_impaired === 1,
    forced: d.forced === 1,
    sdh: d.hearing_impaired === 1,
  }
}

function trackFlagLabel(stream, kind) {
  const d = stream.disposition || {}
  const title = stream.tags?.title || ''
  if (kind === 'audio' && d.comment === 1 && !/commentary/i.test(title)) return 'commentary'
  if (kind === 'subtitle' && d.forced === 1) return 'forced'
  if (kind === 'subtitle' && d.hearing_impaired === 1 && !/sdh|cc/i.test(title)) return 'SDH'
  return null
}

// ffprobe writes a frame rate as "24000/1001", and "0/0" for a stream that has none.
function frameRate(text) {
  const [n, d] = String(text || '').split('/').map(Number)
  const fps = d ? n / d : n
  return Number.isFinite(fps) && fps > 0 ? Math.round(fps * 1000) / 1000 : null
}

function summarizeProbe(probe, externalSubtitlePaths = []) {
  const streams = probe.streams || []
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic)

  const audioStreams = streams.filter((s) => s.codec_type === 'audio')
  const audio = audioStreams
    .map((s, n) => ({
      index: s.index,
      label: trackLabel(s, n, [trackFlagLabel(s, 'audio'), `${s.codec_name}${s.channels > 2 ? ` ${s.channels}ch` : ''}`].filter(Boolean).join(' · ')),
      isDefault: s.disposition?.default === 1,
      ...trackFacts(s),
    }))

  const subtitles = []
  // n counts every subtitle stream: ffmpeg's `si=` and `0:s:N` both index that way.
  streams
    .filter((s) => s.codec_type === 'subtitle')
    .forEach((s, n) => {
      if (!s.codec_name) return
      subtitles.push({
        id: `embedded:${n}`,
        kind: 'embedded',
        subIndex: n,
        image: IMAGE_SUBTITLE_CODECS.has(s.codec_name),
        label: trackLabel(s, n, trackFlagLabel(s, 'subtitle')),
        isDefault: s.disposition?.default === 1,
        ...trackFacts(s),
      })
    })
  for (const p of externalSubtitlePaths) subtitles.push(externalSubtitle(p))

  return {
    duration: Number(probe.format?.duration) || 0,
    startTime: Number(probe.format?.start_time) || 0,
    title: probe.format?.tags?.title || null,
    container: probe.format?.format_name ? String(probe.format.format_name) : null,
    video: video
      ? {
          index: video.index,
          codec: video.codec_name,
          pixFmt: video.pix_fmt,
          width: video.width,
          height: video.height,
          transfer: video.color_transfer || null,
          fps: frameRate(video.avg_frame_rate) ?? frameRate(video.r_frame_rate),
        }
      : null,
    audio,
    // What each audio stream is, beside `audio` (whose shape the room state is built from).
    audioInfo: audioStreams.map((s) => ({index: s.index, codec: s.codec_name || null, channels: s.channels ?? null})),
    subtitles,
  }
}

function externalSubtitle(path) {
  return {id: `external:${path}`, kind: 'external', path, image: false, label: baseName(path), isDefault: false}
}

function isSubtitleSidecar(videoPath, candidate) {
  const stem = baseName(videoPath).replace(/\.[^.]+$/, '').toLowerCase()
  const name = baseName(candidate).toLowerCase()
  return name.startsWith(stem) && SUBTITLE_EXTENSIONS.some((ext) => name.endsWith(ext))
}

// Codec string for MediaSource when the video stream is passed through untouched, or null if
// it has to be transcoded. `support` maps shared/codecs.json keys to MediaSource.isTypeSupported.
function copyCodecString(video, support) {
  // Only 8-bit passes through: Chromium plays 10-bit fine locally, but captureStream hands
  // WebRTC solid black frames for it, so the viewer would see nothing.
  const eightBit = video.pixFmt === 'yuv420p' || (video.codec === 'h264' && video.pixFmt === 'yuvj420p')
  const key = eightBit && ['h264', 'hevc', 'av1', 'vp9'].includes(video.codec) ? video.codec : null
  return key && support[key] ? CODECS[key] : null
}

// Filter-graph escaping: once for the filter option value, once for the graph itself.
function escapeFilterValue(value) {
  const optionLevel = value.replace(/[\\':]/g, (c) => `\\${c}`)
  return optionLevel.replace(/[\\'[\],;]/g, (c) => `\\${c}`)
}

function planSession({
  media,
  filePath,
  start = 0,
  keyframe = null,
  audioIndex = null,
  subtitleId = null,
  support = {},
  forceTranscode = false,
  encoder = 'libx264',
  canTonemap = false,
}) {
  const video = media.video
  const subtitle = media.subtitles.find((s) => s.id === subtitleId) || null
  const copyCodec = video && !subtitle && !forceTranscode ? copyCodecString(video, support) : null
  // Stream copy can only start on a keyframe; transcoding seeks accurately.
  const offset = copyCodec && keyframe != null ? Math.min(keyframe, start) : start
  // ffmpeg backs a seek off by ~0.13s when the video has B-frames, which would land on the
  // previous keyframe. Aim just past the keyframe we want instead.
  const seekTo = copyCodec && keyframe != null && offset > 0 ? offset + 0.2 : offset

  // -stats keeps the progress line (and its speed against real time) coming on stderr despite -v error.
  const args = ['-v', 'error', '-stats', '-nostdin']
  if (seekTo > 0) args.push('-ss', seekTo.toFixed(3))
  // Burned-in subtitles are timed against the source timestamps.
  if (subtitle) args.push('-copyts')
  args.push('-i', filePath)

  const codecs = []
  let cwd = null

  if (video && copyCodec) {
    args.push('-map', `0:${video.index}`, '-c:v', 'copy')
    if (video.codec === 'hevc') args.push('-tag:v', 'hvc1')
    codecs.push(copyCodec)
  } else if (video) {
    const pixelFormat = encoder === 'libx264' ? 'yuv420p' : 'nv12'
    const chain = []
    if (canTonemap && HDR_TRANSFERS.has(video.transfer)) {
      chain.push(
        'zscale=t=linear:npl=100',
        'format=gbrpf32le',
        'zscale=p=bt709',
        'tonemap=tonemap=hable:desat=0',
        'zscale=t=bt709:m=bt709:r=tv',
      )
    }
    chain.push("scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2")

    if (subtitle && subtitle.image) {
      const graph = [
        `[0:${video.index}]${chain.join(',')}[base]`,
        `[base][0:s:${subtitle.subIndex}]overlay=x=(W-w)/2:y=H-h:eof_action=pass[subbed]`,
        `[subbed]format=${pixelFormat}[vout]`,
      ]
      args.push('-filter_complex', graph.join(';'), '-map', '[vout]')
    } else {
      if (subtitle) {
        // Relative filename plus cwd sidesteps drive-letter colons in the filter graph.
        const source = subtitle.kind === 'external' ? subtitle.path : filePath
        cwd = dirName(source)
        const si = subtitle.kind === 'embedded' ? `:si=${subtitle.subIndex}` : ''
        chain.push(`subtitles=filename=${escapeFilterValue(baseName(source))}${si}`)
      }
      chain.push(`format=${pixelFormat}`)
      args.push('-map', `0:${video.index}`, '-vf', chain.join(','))
    }
    args.push(...(ENCODER_ARGS[encoder] || ENCODER_ARGS.libx264), '-g', '48')
    codecs.push(CODECS.h264)
  }

  if (audioIndex != null) {
    // FLAC when Chromium accepts it: this stream only reaches the host's own player, and WebRTC
    // then re-encodes to Opus, so AAC would be a second lossy generation for viewers.
    if (support.flac) {
      args.push('-map', `0:${audioIndex}`, '-c:a', 'flac', '-ac', '2')
      codecs.push(CODECS.flac)
    } else {
      args.push('-map', `0:${audioIndex}`, '-c:a', 'aac', '-b:a', '192k', '-ac', '2')
      codecs.push(CODECS.aac)
    }
  }

  args.push(
    '-map_metadata', '-1',
    '-map_chapters', '-1',
    '-max_muxing_queue_size', '4096',
    '-f', 'mp4',
    '-movflags', 'empty_moov+default_base_moof+frag_keyframe',
    '-frag_duration', '1000000',
    'pipe:1',
  )

  const kind = video ? 'video' : 'audio'
  return {
    args,
    cwd,
    offset,
    mime: `${kind}/mp4; codecs="${codecs.join(',')}"`,
    transcoding: Boolean(video && !copyCodec),
    encoder: video && !copyCodec ? encoder : null,
  }
}

// Why a video stream has to be re-encoded rather than passed through, in the words the log uses.
// Empty means it passes through (or there is no video).
function transcodeReasons(media, {subtitle = null, forceTranscode = false, support = {}} = {}) {
  const video = media.video
  if (!video) return []
  const why = []
  if (forceTranscode) why.push('retry') // Chromium failed to decode the passthrough stream
  if (subtitle) why.push('burn-in') // subtitles are drawn into the picture
  const eightBit = video.pixFmt === 'yuv420p' || (video.codec === 'h264' && video.pixFmt === 'yuvj420p')
  if (!eightBit) why.push('pixel-format') // 10-bit, 4:2:2, 4:4:4: captureStream sends black for these
  if (!['h264', 'hevc', 'av1', 'vp9'].includes(video.codec)) why.push('codec')
  else if (eightBit && !support[video.codec]) why.push('no-decoder') // this Chromium cannot play it in a MediaSource
  return why
}

// One small object describing the file a host just opened and what is done with it: logged once per
// file (main/main.js, `media/source`), so a bad picture can be traced to the source or to the way it
// was converted. Short keys because it travels over the live stream too.
function sourceFacts(media, plan, {audioIndex = null, subtitle = null, forceTranscode = false, support = {}, canTonemap = false} = {}) {
  const video = media.video
  const audioInfo = (media.audioInfo || []).find((a) => a.index === audioIndex)
  const hdr = Boolean(video && HDR_TRANSFERS.has(video.transfer))
  const facts = {
    c: media.container ?? null,
    dur: Number.isFinite(media.duration) && media.duration > 0 ? Math.round(media.duration) : null,
    mode: !video ? 'audio' : plan.transcoding ? 'transcode' : 'copy',
  }
  if (video) {
    facts.v = {codec: video.codec ?? null, pix: video.pixFmt ?? null, w: video.width ?? null, h: video.height ?? null, fps: video.fps ?? null, hdr: hdr ? 1 : 0}
    if (plan.transcoding) {
      facts.why = transcodeReasons(media, {subtitle, forceTranscode, support})
      facts.enc = plan.encoder
      if (hdr) facts.tm = canTonemap ? 1 : 0 // tone-mapped to SDR, or sent as it is
    }
  }
  if (audioInfo) facts.a = {codec: audioInfo.codec, ch: audioInfo.channels}
  facts.af = plan.mime.includes('flac') ? 'flac' : plan.mime.includes('mp4a') ? 'aac' : null
  if (subtitle) facts.sub = subtitle.image ? 'image' : 'text'
  return facts
}

// Text subtitles are converted to WebVTT and drawn by each person's app, so everyone can pick
// their own track. Image subtitles can only be burned into the stream (planSession).
function subtitleExtractArgs(filePath, subtitle, charenc = null) {
  const external = subtitle.kind === 'external'
  return [
    '-v', 'error', '-nostdin',
    ...(charenc ? ['-sub_charenc', charenc] : []),
    '-i', external ? subtitle.path : filePath,
    '-map', `0:s:${external ? 0 : subtitle.subIndex}`,
    '-f', 'webvtt',
    'pipe:1',
  ]
}

function parseVttTime(text) {
  const match = text.match(/^(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})$/)
  return match ? Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000 : NaN
}

// ASS vector drawings ({\p1}m 0 0 l 100 0 …) come through ffmpeg's conversion as plain text.
const isDrawing = (line) => /^m\s+-?[\d.]+\s+-?[\d.]+/.test(line) && /^[mnlbspc\d.\s-]+$/.test(line)

function parseWebVtt(text) {
  const cues = []
  for (const block of text.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n')
    const at = lines.findIndex((line) => line.includes('-->'))
    if (at < 0) continue
    const [start, end] = lines[at].split('-->').map((part) => parseVttTime(part.trim().split(/\s+/)[0]))
    const body = lines
      .slice(at + 1)
      .map((line) => line.replace(/\{[^}]*\}/g, '').trim())
      .filter((line) => line && !isDrawing(line))
      .join('\n')
    if (end > start && body) cues.push({start, end, text: body})
  }
  return cues.sort((a, b) => a.start - b.start)
}

// Mime type of an image Chromium shows as-is, or null if ffmpeg has to convert it to PNG first.
function imageMime(filePath) {
  const ext = (/\.([^.\\/]+)$/.exec(filePath)?.[1] || '').toLowerCase()
  return Object.hasOwn(IMAGES.native, ext) ? IMAGES.native[ext] : null
}

function imageConvertArgs(filePath) {
  return ['-v', 'error', '-nostdin', '-i', filePath, '-frames:v', '1', '-c:v', 'png', '-f', 'image2pipe', 'pipe:1']
}

// ffmpeg prints a status line (`frame= 240 fps= 48 ... time=00:00:10.00 ... speed=2.01x`) to stderr
// every half second, separated by carriage returns. The last complete reading says how fast the encode
// is running against real time: under 1x it cannot keep up with playback, over 1x it has headroom.
// `speed` is ffmpeg's own average since it started, so it eases toward 1x while the renderer's
// backpressure holds ffmpeg back; the seconds buffered ahead say what that means for playback.
function parseProgress(text) {
  const last = (pattern) => Number([...String(text).matchAll(pattern)].at(-1)?.[1])
  const speed = last(/speed=\s*(\d+(?:\.\d+)?)x/g)
  const fps = last(/\bfps=\s*(\d+(?:\.\d+)?)/g)
  const out = {
    speed: Number.isFinite(speed) ? Math.round(speed * 100) / 100 : null,
    fps: Number.isFinite(fps) ? Math.round(fps * 10) / 10 : null,
  }
  return out.speed == null && out.fps == null ? null : out
}

// The last real message on ffmpeg's stderr: progress lines (which end in a carriage return, not a
// newline) are not it.
function lastMessage(text) {
  return String(text).split(/[\r\n]+/).map((line) => line.trim()).filter((line) => line && !/\bspeed=|^(?:frame|size)=/.test(line)).pop() || ''
}

module.exports = {
  ENCODER_ARGS,
  escapeFilterValue,
  externalSubtitle,
  imageConvertArgs,
  imageMime,
  isSubtitleSidecar,
  lastMessage,
  parseProgress,
  parseWebVtt,
  planSession,
  sourceFacts,
  subtitleExtractArgs,
  summarizeProbe,
  transcodeReasons,
}
