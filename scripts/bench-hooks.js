// Source appended to renderer/app.js by `npm run bench` (scripts/bench.js) in its temporary bundle only.
// It lives in the page because it reads app.js's own state (the output gain, the share tiles, the
// session), but it ships nowhere: production bundles contain none of it. Kept as a plain function whose
// text is injected, so it is linted and read like code, not like a string.
//
// Measurement points (see CLAUDE.md "Benchmark"):
//   video  requestVideoFrameCallback on the element the picture shows in; each callback samples the
//          flash patch's brightness. The time is the frame's expectedDisplayTime.
//   audio  an AudioWorklet hung off the output gain (after routeRemoteAudio / routeTileAudio and the
//          volume), reporting the frame of each beep's first sample; getOutputTimestamp() turns a
//          context frame into the page's clock, so the Web Audio output path's latency is included.
function benchHooks() {
  const state = {tap: null, sampleRate: 0, beeps: [], levels: [], clock: [], stereo: [], video: null, window: null}

  async function installTap() {
    audioOutput() // creates the context, the output gain and the element source
    await audio.audioWorklet.addModule('bench-tap.js')
    const tap = new AudioWorkletNode(audio, 'bench-tap', {numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2]})
    const silent = audio.createGain()
    silent.gain.value = 0
    // The speakers get nothing even if the window were not muted: the output gain feeds only the tap, and
    // the tap reaches the destination through a gain of zero. The tap sees exactly what the destination would.
    output.disconnect(audio.destination)
    output.connect(tap)
    tap.connect(silent)
    silent.connect(audio.destination)
    tap.port.onmessage = (event) => {
      const m = event.data
      if (m.type === 'onset') state.beeps.push({frame: m.frame, at: performance.now()})
      else if (m.type === 'level') state.levels.push({frame: m.frame, rms: m.rms})
      else if (m.type === 'stereo') state.stereo.push(m)
    }
    state.tap = tap
    state.sampleRate = audio.sampleRate
    setInterval(() => {
      const t = audio.getOutputTimestamp()
      state.clock.push({ctx: t.contextTime, perf: t.performanceTime, cur: audio.currentTime, now: performance.now()})
    }, 100)
    return {sampleRate: audio.sampleRate, state: audio.state, outputLatency: audio.outputLatency, baseLatency: audio.baseLatency}
  }

  // `pick` returns the <video> to watch; called again if the element is replaced.
  function watchVideo(pick) {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 8
    const ctx = canvas.getContext('2d', {willReadFrequently: true})
    const rec = state.video = {frames: [], callbacks: 0, lastAt: performance.now(), width: 0, height: 0}
    let id = 0
    let element = null
    rec.pending = 0
    const onFrame = (now, meta) => {
      rec.callbacks++
      rec.lastAt = performance.now()
      const video = element
      id = video.requestVideoFrameCallback(onFrame)
      const entry = [meta.expectedDisplayTime, meta.mediaTime, meta.presentedFrames, -1, now]
      rec.frames.push(entry)
      if (!video.videoWidth) return
      rec.width = video.videoWidth
      rec.height = video.videoHeight
      // The flash patch is the top-left quarter of the picture; its inside, shrunk to 8x8 on the GPU. The
      // bitmap is taken now (it is this frame) and read later, so the callback itself stays cheap.
      rec.pending++
      createImageBitmap(video, video.videoWidth * 0.04, video.videoHeight * 0.04, video.videoWidth * 0.17, video.videoHeight * 0.17, {resizeWidth: 8, resizeHeight: 8, resizeQuality: 'low'}).then((bitmap) => {
        ctx.drawImage(bitmap, 0, 0)
        bitmap.close()
        const d = ctx.getImageData(0, 0, 8, 8).data
        let sum = 0
        for (let i = 0; i < d.length; i += 4) sum += d[i] * 0.2126 + d[i + 1] * 0.7152 + d[i + 2] * 0.0722
        entry[3] = sum / 64
      }).catch(() => {}).finally(() => { rec.pending-- })
    }
    const attach = () => {
      const next = pick()
      if (!next) return false
      if (next !== element) {
        try { element?.cancelVideoFrameCallback(id) } catch {}
        element = next
        id = element.requestVideoFrameCallback(onFrame)
      }
      return true
    }
    attach()
    // An element can be replaced or a callback lost across a source change: look again once a second.
    state.watchTimer = setInterval(() => {
      if (!attach() || performance.now() - rec.lastAt < 1500 || element.paused) return
      try { element.cancelVideoFrameCallback(id) } catch {}
      id = element.requestVideoFrameCallback(onFrame)
    }, 1000)
    return true
  }

  function stereoReading() {
    return new Promise((resolve) => {
      const before = state.stereo.length
      state.tap.port.postMessage('stereo')
      const wait = () => (state.stereo.length > before ? resolve(state.stereo.at(-1)) : setTimeout(wait, 20))
      wait()
    })
  }

  const pickRtp = (s, keys) => Object.fromEntries(keys.filter((k) => s[k] !== undefined).map((k) => [k, s[k]]))

  async function rtp() {
    const out = {audioIn: null, videoIn: null, audioOut: null, videoOut: null, codecs: {}, senders: []}
    for (const [peerId, pc] of Object.entries(session.room.getPeers())) {
      const report = await pc.getStats()
      report.forEach((s) => {
        if (s.type === 'codec') out.codecs[s.id] = pickRtp(s, ['mimeType', 'channels', 'clockRate', 'sdpFmtpLine'])
      })
      report.forEach((s) => {
        const fields = {
          audioIn: ['timestamp', 'bytesReceived', 'packetsReceived', 'packetsLost', 'jitter', 'concealedSamples', 'silentConcealedSamples', 'totalSamplesReceived', 'insertedSamplesForDeceleration', 'removedSamplesForAcceleration', 'jitterBufferDelay', 'jitterBufferEmittedCount', 'codecId', 'totalAudioEnergy', 'totalSamplesDuration'],
          videoIn: ['timestamp', 'bytesReceived', 'framesReceived', 'framesDecoded', 'framesDropped', 'framesPerSecond', 'frameWidth', 'frameHeight', 'freezeCount', 'totalFreezesDuration', 'pliCount', 'nackCount', 'firCount', 'keyFramesDecoded', 'totalDecodeTime', 'packetsLost', 'packetsReceived', 'jitterBufferDelay', 'jitterBufferEmittedCount', 'decoderImplementation', 'codecId'],
          audioOut: ['timestamp', 'bytesSent', 'packetsSent', 'codecId'],
          videoOut: ['timestamp', 'bytesSent', 'framesEncoded', 'framesPerSecond', 'frameWidth', 'frameHeight', 'qualityLimitationReason', 'encoderImplementation', 'powerEfficientEncoder', 'pliCount', 'nackCount', 'firCount', 'keyFramesEncoded', 'totalEncodeTime', 'codecId'],
        }
        const key = s.type === 'inbound-rtp' ? s.kind + 'In' : s.type === 'outbound-rtp' ? s.kind + 'Out' : null
        if (!key) return
        const reading = {peerId, ...pickRtp(s, fields[key])}
        const current = out[key]
        if (!current || (reading.packetsReceived || reading.packetsSent || 0) >= (current.packetsReceived || current.packetsSent || 0)) out[key] = reading
      })
      for (const sender of pc.getSenders()) {
        if (!sender.track) continue
        const e = sender.getParameters().encodings?.[0] || {}
        out.senders.push({kind: sender.track.kind, maxBitrate: e.maxBitrate ?? null, priority: e.priority ?? null, networkPriority: e.networkPriority ?? null})
      }
    }
    for (const key of ['audioIn', 'audioOut', 'videoIn', 'videoOut']) if (out[key]?.codecId) out[key].codec = out.codecs[out[key].codecId] || null
    return out
  }

  async function collect() {
    while (state.video?.pending > 0) await new Promise((r) => setTimeout(r, 20))
    const stereo = await stereoReading()
    return {
      frames: state.video?.frames ?? [], callbacks: state.video?.callbacks ?? 0, width: state.video?.width, height: state.video?.height,
      beeps: state.beeps, levels: state.levels, clock: state.clock, stereo,
      timeOrigin: performance.timeOrigin, sampleRate: state.sampleRate, outputLatency: audio.outputLatency, baseLatency: audio.baseLatency, audioState: audio.state,
      channelsIn: stereo.channels,
    }
  }

  // The "window" a share bench shares: a canvas drawn at a steady 30fps on the clip's schedule. A frame is
  // drawn at its scheduled instant and handed to the stream at once, so the flash is in the
  // stream when the beep leaves the fake helper, within the lateness recorded here.
  function installWindow(schedule) {
    const canvas = Object.assign(document.createElement('canvas'), {width: 1280, height: 720})
    const g = canvas.getContext('2d')
    // A generator stamped with performance.now(), the way the Windows window share's composite worker
    // (renderer/app-share-worker.mjs) and the film pipeline (frames.mjs) send frames: a canvas capture
    // stream stamps frames differently, and WebRTC's lip-sync reads those stamps.
    const generator = new MediaStreamTrackGenerator({kind: 'video'})
    generator.frameSize = {width: 1280, height: 720}
    const writer = generator.writable.getWriter()
    const stream = new MediaStream([generator])
    const emit = () => {
      const frame = new VideoFrame(canvas, {timestamp: Math.round(performance.now() * 1000)})
      writer.write(frame).then(() => frame.close(), () => frame.close())
    }
    const flashing = new Set()
    for (const e of schedule.events) for (let i = 0; i < schedule.flashFrames; i++) flashing.add(e.frame + i)
    const w = state.window = {epoch: null, late: [], frames: 0, stopped: false}
    const interval = 1000 / schedule.fps
    const now = () => Date.now() // the one clock the fake helper shares with this page
    const draw = (k) => {
      g.fillStyle = '#1b2a41'
      g.fillRect(0, 0, 1280, 720)
      g.fillStyle = '#e07a5f'
      g.fillRect(((k * 14) % 1400) - 100, 300, 160, 160) // something moving, so the encoder works for it
      g.fillStyle = '#81b29a'
      g.fillRect(0, 600 + (k % 90), 1280, 8)
      g.fillStyle = flashing.has(k) ? '#fff' : '#000'
      g.fillRect(0, 0, 320, 180)
    }
    // One loop for the whole run: idle frames at the clip's rate until the epoch is near, then every frame
    // at its scheduled instant (a timer up to 3ms early, then a spin to the instant itself).
    const tick = (k) => {
      if (w.stopped) return
      if (w.epoch == null || w.epoch - now() > interval) {
        draw(-1)
        emit()
        return setTimeout(() => tick(null), interval)
      }
      if (k == null) k = 0
      const due = w.epoch + k * interval
      const wait = due - now()
      if (wait > 3) return setTimeout(() => tick(k), wait - 3)
      while (now() < due);
      w.late.push(now() - due)
      draw(k)
      emit()
      w.frames++
      setTimeout(() => tick(k + 1), 0)
    }
    navigator.mediaDevices.getDisplayMedia = async () => stream
    w.start = (epoch) => { w.epoch = epoch }
    tick(0)
    return true
  }

  function windowReport() {
    const late = [...(state.window?.late ?? [])].sort((a, b) => a - b)
    const at = (p) => late[Math.min(late.length - 1, Math.floor(late.length * p))]
    return {frames: late.length, medianLateMs: at(0.5), p95LateMs: at(0.95), maxLateMs: late.at(-1)}
  }

  // Point every remote ICE candidate at a relay in the main process (scripts/bench-net.js) that damages
  // what passes. Only IPv4 UDP candidates are kept: anything else (IPv6, TCP) would be a way around the relay.
  function installNetwork() {
    const ports = new Map()
    const front = (host, port) => {
      const key = host + ':' + port
      if (!ports.has(key)) ports.set(key, window.__benchRelay.open(host, port))
      return ports.get(key)
    }
    const shape = /^(a=)?candidate:(\S+) (\d+) (\S+) (\d+) (\S+) (\d+) typ (\S+)(.*)$/
    const rewrite = async (line) => {
      const m = shape.exec(line)
      if (!m) return line
      if (m[4].toLowerCase() !== 'udp' || !/^\d+\.\d+\.\d+\.\d+$/.test(m[6])) return null
      const port = await front(m[6], Number(m[7])).catch(() => null)
      return port == null ? null : `${m[1] || ''}candidate:${m[2]} ${m[3]} ${m[4]} ${m[5]} ${m[6]} ${port} typ ${m[8]}${m[9]}`
    }
    const addIceCandidate = RTCPeerConnection.prototype.addIceCandidate
    RTCPeerConnection.prototype.addIceCandidate = async function (candidate, ...rest) {
      if (candidate && typeof candidate.candidate === 'string' && candidate.candidate) {
        const line = await rewrite(candidate.candidate)
        if (line == null) return
        candidate = new RTCIceCandidate({...(candidate.toJSON ? candidate.toJSON() : candidate), candidate: line})
      }
      return addIceCandidate.call(this, candidate, ...rest)
    }
    const setRemoteDescription = RTCPeerConnection.prototype.setRemoteDescription
    RTCPeerConnection.prototype.setRemoteDescription = async function (description, ...rest) {
      if (description?.sdp && description.sdp.includes('a=candidate:')) {
        const eol = description.sdp.includes('\r\n') ? '\r\n' : '\n'
        const lines = await Promise.all(description.sdp.split(/\r?\n/).map((line) => (line.startsWith('a=candidate:') ? rewrite(line) : line)))
        description = {type: description.type, sdp: lines.filter((line) => line != null).join(eol)}
      }
      return setRemoteDescription.call(this, description, ...rest)
    }
    return true
  }

  window.__bench = {
    installNetwork, installTap, watchVideo, collect, rtp, installWindow, windowReport,
    startWindow: (epoch) => state.window.start(epoch),
    stopWindow: () => { if (state.window) state.window.stopped = true },
    now: () => Date.now(),
    tileVideo: (id) => tileViews.get(id)?.video ?? null,
  }
}
module.exports = {benchHooks}
