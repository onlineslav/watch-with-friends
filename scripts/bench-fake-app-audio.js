// Stands in for native/win-app-audio and native/mac-app-audio in `npm run bench` (main/app-audio.js
// spawns it through the SVP_APP_AUDIO_FAKE seam). It speaks the real helpers' protocol: one line of
// "ready" on stderr, then raw interleaved float32 stereo PCM at 48kHz on stdout, paced in real time like a
// loopback capture (a 10ms block is delivered when its 10ms have elapsed, silence while nothing plays).
// The PCM is the benchmark clip's own audio, so the only thing skipped is the OS capture call, which
// would play sound. Nothing here touches an audio device.
//
// BENCH_PCM         raw f32le stereo 48kHz file of the clip's audio
// BENCH_EPOCH_FILE  a file that will hold the wall-clock time (ms since 1970) at which clip time 0 is
//                   delivered; silence flows until it appears
// BENCH_STATS_FILE  where to keep how late each block was delivered against its schedule (JSON)
const fs = require('node:fs')

const RATE = 48000
const BLOCK = 480 // frames: the 10ms period of a WASAPI shared-mode capture
const BYTES = BLOCK * 2 * 4
const pcm = fs.readFileSync(process.env.BENCH_PCM)
const late = []
let epoch = null

const clock = () => Date.now() // the wall clock: the page that draws the matching flashes reads the same one
const silence = Buffer.alloc(BYTES)
process.stderr.write('ready\n')

const readEpoch = () => {
  if (epoch != null) return
  try {
    const value = Number(fs.readFileSync(process.env.BENCH_EPOCH_FILE, 'utf8'))
    if (Number.isFinite(value) && value > 0) epoch = value
  } catch {}
}

const writeStats = () => {
  if (!process.env.BENCH_STATS_FILE || !late.length) return
  const sorted = [...late].sort((a, b) => a - b)
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
  fs.writeFileSync(process.env.BENCH_STATS_FILE, JSON.stringify({blocks: late.length, medianLateMs: at(0.5), p95LateMs: at(0.95), maxLateMs: sorted.at(-1)}))
}
setInterval(writeStats, 2000).unref()

// A steady stream from the moment the helper starts (silence while no clip is scheduled), like a real
// loopback capture: block j is the 10ms that end at start + (j+1)*10ms and is delivered then. When the
// epoch (clip time 0) is known, a block carries whatever clip samples fall in its 10ms, so the clip may
// begin anywhere between blocks and the stream never changes pace.
const start = clock()
const samples = pcm.length / 8
let j = 0
function next() {
  readEpoch()
  const due = start + (j + 1) * 10
  // Polled, not slept: this process gets Windows' default 15.6ms timer tick, so setTimeout would deliver a
  // block up to that late. One busy core for the length of a bench run is the price of delivering on time.
  if (clock() < due) return setImmediate(next)
  late.push(clock() - due)
  let block = silence
  if (epoch != null) {
    const first = Math.round((start + j * 10 - epoch) * (RATE / 1000)) // the clip sample at the block's first frame
    if (first + BLOCK > 0 && first < samples) {
      block = Buffer.alloc(BYTES)
      const from = Math.max(0, first)
      const to = Math.min(samples, first + BLOCK)
      pcm.copy(block, (from - first) * 8, from * 8, to * 8)
    }
  }
  process.stdout.write(block)
  j++
  setImmediate(next)
}
next()
