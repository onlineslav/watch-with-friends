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

function summarizeProbe(probe, externalSubtitlePaths = []) {
  const streams = probe.streams || []
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic)

  const audio = streams
    .filter((s) => s.codec_type === 'audio')
    .map((s, n) => ({
      index: s.index,
      label: trackLabel(s, n, `${s.codec_name}${s.channels > 2 ? ` ${s.channels}ch` : ''}`),
      isDefault: s.disposition?.default === 1,
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
        label: trackLabel(s, n, s.disposition?.forced === 1 ? 'forced' : null),
        isDefault: s.disposition?.default === 1,
      })
    })
  for (const p of externalSubtitlePaths) subtitles.push(externalSubtitle(p))

  return {
    duration: Number(probe.format?.duration) || 0,
    startTime: Number(probe.format?.start_time) || 0,
    title: probe.format?.tags?.title || null,
    video: video
      ? {
          index: video.index,
          codec: video.codec_name,
          pixFmt: video.pix_fmt,
          width: video.width,
          height: video.height,
          transfer: video.color_transfer || null,
        }
      : null,
    audio,
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

  const args = ['-v', 'error', '-nostdin']
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

module.exports = {
  ENCODER_ARGS,
  escapeFilterValue,
  externalSubtitle,
  imageConvertArgs,
  imageMime,
  isSubtitleSidecar,
  parseWebVtt,
  planSession,
  subtitleExtractArgs,
  summarizeProbe,
}
