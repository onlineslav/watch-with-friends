// Real-audio check for native/win-app-audio, which compiling cleanly says nothing about (see
// CLAUDE.md on mac-app-audio). Plays two quiet tones from two separate windowed processes,
// 440Hz and 1000Hz, captures one window's audio with the built helper and checks:
//   - only that window's tone comes through (the other process is excluded),
//   - the stream runs at real-time rate, and keeps running through silence,
//   - a closed window and the target app exiting are reported as errors.
// This plays sound through the default output device, so run it by hand only:
// `node scripts/check-win-app-audio.js` (after `node scripts/build-win-app-audio.js`).
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const {spawn} = require('node:child_process')

const helper = path.join(__dirname, '..', 'native/win-app-audio/win-app-audio.exe')
const RATE = 48000
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'check-win-app-audio-'))

function writeTone(file, frequency, seconds) {
  const frames = RATE * seconds
  const data = Buffer.alloc(frames * 4)
  for (let i = 0; i < frames; i++) {
    const sample = Math.round(Math.sin((2 * Math.PI * frequency * i) / RATE) * 0.05 * 32767)
    data.writeInt16LE(sample, i * 4)
    data.writeInt16LE(sample, i * 4 + 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(2, 22)
  header.writeUInt32LE(RATE, 24)
  header.writeUInt32LE(RATE * 4, 28)
  header.writeUInt16LE(4, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  fs.writeFileSync(file, Buffer.concat([header, data]))
}

// A PowerShell process that owns a window (never shown) and optionally loops a WAV file,
// printing the window's handle once it exists.
function windowProcess(wav, {delay = 0} = {}) {
  const play = wav ? `Start-Sleep -Milliseconds ${delay}; $p = New-Object System.Media.SoundPlayer '${wav}'; $p.PlayLooping();` : ''
  const script = `Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.Form; [Console]::Out.WriteLine($f.Handle.ToInt64()); [Console]::Out.Flush(); ${play} Start-Sleep -Seconds 60`
  const proc = spawn('powershell.exe', ['-NoProfile', '-Command', script], {stdio: ['ignore', 'pipe', 'inherit']})
  const handle = new Promise((resolve, reject) => {
    let text = ''
    proc.stdout.on('data', (chunk) => {
      text += chunk
      if (text.includes('\n')) resolve(text.trim())
    })
    proc.on('exit', () => reject(new Error('window process exited early')))
  })
  return {proc, handle}
}

// Runs the helper for `seconds` (or until it exits), collecting its output.
function capture(args, seconds, {during} = {}) {
  return new Promise((resolve) => {
    const proc = spawn(helper, args, {stdio: ['ignore', 'pipe', 'pipe']})
    const chunks = []
    let stderr = ''
    let readyAt = null
    proc.stdout.on('data', (chunk) => chunks.push(chunk))
    proc.stderr.on('data', (chunk) => {
      stderr += chunk
      if (readyAt == null && stderr.startsWith('ready\n')) {
        readyAt = performance.now()
        during?.()
      }
    })
    const timer = setTimeout(() => proc.kill(), seconds * 1000)
    proc.on('close', (code) => {
      clearTimeout(timer)
      const elapsed = readyAt == null ? 0 : (performance.now() - readyAt) / 1000
      resolve({code, stderr, elapsed, pcm: Buffer.concat(chunks)})
    })
  })
}

// Goertzel power of one frequency in the left channel, normalized per sample.
function power(pcm, frequency) {
  const samples = new Float32Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 4))
  const coefficient = 2 * Math.cos((2 * Math.PI * frequency) / RATE)
  let previous = 0
  let beforePrevious = 0
  let count = 0
  for (let i = 0; i < samples.length; i += 2, count++) {
    const value = samples[i] + coefficient * previous - beforePrevious
    beforePrevious = previous
    previous = value
  }
  return (previous * previous + beforePrevious * beforePrevious - coefficient * previous * beforePrevious) / (count * count)
}

const rms = (pcm) => {
  const samples = new Float32Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 4))
  return Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / (samples.length || 1))
}

async function main() {
  assert.ok(fs.existsSync(helper), 'build the helper first: node scripts/build-win-app-audio.js')
  writeTone(path.join(work, 'a.wav'), 440, 10)
  writeTone(path.join(work, 'b.wav'), 1000, 10)
  const a = windowProcess(path.join(work, 'a.wav'))
  const b = windowProcess(path.join(work, 'b.wav'))
  const quiet = windowProcess(null)
  const late = windowProcess(path.join(work, 'a.wav'), {delay: 2500})
  try {
    const [handleA, , handleQuiet, handleLate] = await Promise.all([a.handle, b.handle, quiet.handle, late.handle])
    await new Promise((resolve) => setTimeout(resolve, 1000))

    // Starts silent, then the app starts playing: the silence filler must hand over cleanly,
    // never cutting zeros into the sound once it's flowing.
    const starting = await capture([handleLate], 4)
    const samples = new Float32Array(starting.pcm.buffer, starting.pcm.byteOffset, starting.pcm.length / 4)
    const first = samples.findIndex((value) => value !== 0)
    let longestGap = 0
    for (let i = first, run = 0; first >= 0 && i < samples.length; i += 2) {
      run = samples[i] === 0 ? run + 1 : 0
      longestGap = Math.max(longestGap, run)
    }
    const startingRatio = starting.pcm.length / 8 / RATE / starting.elapsed
    console.log(`sound starts mid-capture: at ${(first / 2 / RATE).toFixed(2)}s, longest zero run after it ${longestGap} frames, ${startingRatio.toFixed(3)}x real time`)
    assert.ok(first > 0, 'the late tone never arrived')
    assert.ok(longestGap < 4, `a ${longestGap}-frame gap was cut into the sound`)
    assert.ok(startingRatio > 0.9 && startingRatio < 1.1, `stream ran at ${startingRatio.toFixed(2)}x real time`)

    const own = await capture([handleA], 3)
    assert.match(own.stderr, /^ready\n/, `helper did not start: ${own.stderr}`)
    const ratio = own.pcm.length / 8 / RATE / own.elapsed
    const [p440, p1000] = [power(own.pcm, 440), power(own.pcm, 1000)]
    console.log(`window A: ${(own.pcm.length / 8 / RATE).toFixed(2)}s of audio in ${own.elapsed.toFixed(2)}s, rms ${rms(own.pcm).toFixed(4)}, 440Hz ${p440.toExponential(2)}, 1000Hz ${p1000.toExponential(2)}`)
    assert.ok(ratio > 0.9 && ratio < 1.1, `stream ran at ${ratio.toFixed(2)}x real time`)
    assert.ok(rms(own.pcm) > 0.01, 'captured audio is silent')
    assert.ok(p440 > 100 * p1000, 'the other process\'s tone leaked into the capture')

    const silent = await capture([handleQuiet], 2)
    const silentRatio = silent.pcm.length / 8 / RATE / silent.elapsed
    console.log(`silent window: ${(silent.pcm.length / 8 / RATE).toFixed(2)}s of audio in ${silent.elapsed.toFixed(2)}s, rms ${rms(silent.pcm).toFixed(4)}`)
    assert.ok(silentRatio > 0.85 && silentRatio < 1.1, `silence ran at ${silentRatio.toFixed(2)}x real time`)
    assert.equal(rms(silent.pcm), 0, 'a silent app produced sound')

    const closed = await capture(['1'], 2)
    console.log(`closed window: ${closed.stderr.trim()}`)
    assert.equal(closed.code, 1)
    assert.match(closed.stderr, /^error: That window is no longer open/)

    const exited = await capture([handleA], 5, {during: () => setTimeout(() => a.proc.kill(), 500)})
    console.log(`app exits: ${exited.stderr.trim().replace(/\n/g, ' / ')}`)
    assert.equal(exited.code, 1)
    assert.match(exited.stderr, /error: The shared app closed\./)
    console.log('win-app-audio: all checks passed')
  } finally {
    for (const {proc} of [a, b, quiet, late]) proc.kill()
    setTimeout(() => fs.rmSync(work, {recursive: true, force: true}), 500)
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
