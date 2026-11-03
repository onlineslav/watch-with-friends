// AudioWorklet loaded only by `npm run bench` (scripts/bench.js), hung off the app's output gain as a
// side branch. It reports the first sample of each beep (the frame number, so the page can turn it into
// a time with getOutputTimestamp) and how loud the beep is, and keeps per-channel energy so a stereo path
// can be told from a mono one. It passes nothing on: the bench routes it into a zero-gain node.
class BenchTap extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const o = options.processorOptions || {}
    this.threshold = o.threshold ?? 0.15 // beep peak is 0.5; the bed tones are 0.03
    this.refractory = Math.round(sampleRate * (o.refractorySeconds ?? 1))
    this.loud = Math.round(sampleRate * 0.1) // loudness is read over the 100ms after the onset
    this.window = Math.round(sampleRate * 0.25) // and nothing of the beep (150ms, mono) may leak into the stereo reading
    this.quiet = 0
    this.pending = null
    this.channels = 0
    this.energy = {l: 0, r: 0, side: 0, mid: 0, samples: 0}
    this.blocks = 0
    this.port.onmessage = (event) => {
      if (event.data === 'stereo') {
        this.port.postMessage({type: 'stereo', channels: this.channels, ...this.energy, blocks: this.blocks})
        this.energy = {l: 0, r: 0, side: 0, mid: 0, samples: 0}
      }
    }
  }

  process(inputs) {
    const input = inputs[0]
    this.blocks++
    if (!input || !input.length) return true
    this.channels = Math.max(this.channels, input.length)
    const left = input[0]
    const right = input[1] || input[0]
    for (let i = 0; i < left.length; i++) {
      const l = left[i]
      const r = right[i]
      const frame = currentFrame + i
      if (this.quiet > 0) this.quiet--
      else if (Math.max(Math.abs(l), Math.abs(r)) > this.threshold) {
        this.pending = {frame, sum: 0, count: 0}
        this.quiet = this.refractory
        this.port.postMessage({type: 'onset', frame, time: currentTime})
      }
      if (this.pending) {
        if (this.pending.count < this.loud) this.pending.sum += (l * l + r * r) / 2
        if (++this.pending.count === this.loud) this.port.postMessage({type: 'level', frame: this.pending.frame, rms: Math.sqrt(this.pending.sum / this.loud)})
        if (this.pending.count >= this.window) this.pending = null
      } else {
        // The bed tone alone (no beep within 100ms): left and right differ only on a stereo path.
        const e = this.energy
        e.l += l * l
        e.r += r * r
        e.side += (l - r) * (l - r) / 2
        e.mid += (l + r) * (l + r) / 2
        e.samples++
      }
    }
    return true
  }
}
registerProcessor('bench-tap', BenchTap)
