const test = require('node:test')
const assert = require('node:assert/strict')
const {SAMPLE_RATE, chapterIntro, comparableLength, findShared, fingerprint, neighbours} = require('../main/intro')

// Deterministic "audio": music-like notes (a few tones with an envelope) from a seeded generator.
function rng(seed) {
  let s = seed >>> 0
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)
}
function music(seconds, seed) {
  const random = rng(seed)
  const out = new Float64Array(Math.round(seconds * SAMPLE_RATE))
  let i = 0
  while (i < out.length) {
    const length = Math.round((0.15 + random() * 0.5) * SAMPLE_RATE)
    const tones = [0, 1, 2].map(() => 220 * 2 ** (random() * 3))
    for (let k = 0; k < length && i < out.length; k++, i++) {
      const env = Math.min(1, k / 200, (length - k) / 200)
      out[i] = env * tones.reduce((sum, f, n) => sum + Math.sin((2 * Math.PI * f * i) / SAMPLE_RATE) / (n + 1), 0) * 6000
    }
  }
  return out
}
function episode(parts, noiseSeed = 0, noise = 0) {
  const random = rng(noiseSeed + 99)
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Int16Array(total)
  let at = 0
  for (const part of parts) for (let k = 0; k < part.length; k++) out[at++] = Math.max(-32768, Math.min(32767, part[k] + (random() - 0.5) * noise))
  return out
}

test('finds the shared theme between two episodes with different cold opens', async () => {
  const theme = music(50, 7)
  const a = episode([music(40, 1), theme, music(120, 2)], 1, 400)
  const b = episode([music(95, 3), theme, music(120, 4)], 2, 400)
  const shared = findShared(await fingerprint(a), await fingerprint(b))
  assert.ok(shared, 'found an intro')
  assert.ok(Math.abs(shared.a.start - 40) < 0.6, `a start ${shared.a.start}`)
  assert.ok(Math.abs(shared.a.end - 90) < 0.8, `a end ${shared.a.end}`)
  assert.ok(Math.abs(shared.b.start - 95) < 0.6, `b start ${shared.b.start}`)
  assert.ok(shared.a.end <= 90, 'never skips past the theme into the episode')
})

test('an intro at the very start begins at 0', async () => {
  const theme = music(30, 8)
  const shared = findShared(await fingerprint(episode([theme, music(100, 5)])), await fingerprint(episode([music(20, 6), theme, music(100, 9)])))
  assert.equal(shared.a.start, 0)
})

test('unrelated episodes share nothing', async () => {
  const shared = findShared(await fingerprint(episode([music(200, 11)])), await fingerprint(episode([music(200, 12)])))
  assert.equal(shared, null)
})

test('a shared stretch shorter than 15 seconds (a studio logo) is not an intro', async () => {
  const logo = music(8, 13)
  assert.equal(findShared(await fingerprint(episode([logo, music(120, 14)])), await fingerprint(episode([logo, music(120, 15)]))), null)
})

test('silence is not shared content', async () => {
  const quiet = new Float64Array(60 * SAMPLE_RATE)
  assert.equal(findShared(await fingerprint(episode([quiet, music(60, 16)])), await fingerprint(episode([quiet, music(60, 17)]))), null)
})

test('chapters named as the intro', () => {
  const chapters = [
    {start_time: '0', end_time: '62.5', tags: {title: 'Prologue'}},
    {start_time: '62.5', end_time: '152.5', tags: {title: 'Opening'}},
    {start_time: '152.5', end_time: '1300', tags: {title: 'Part A'}},
  ]
  assert.deepEqual(chapterIntro(chapters, {duration: 1400}), {start: 62.5, end: 152.5, source: 'chapter'})
  assert.deepEqual(chapterIntro([{start_time: '10.5', end_time: '40.5', tags: {title: 'Intro'}}], {startTime: 0.5}), {start: 10, end: 40, source: 'chapter'})
  for (const title of ['OP', 'Opening Credits', 'intro', 'OP1', 'Main Title']) {
    assert.ok(chapterIntro([{start_time: 0, end_time: 60, tags: {title}}]), title)
  }
  for (const title of ['Chapter 1', 'Introduction to Act 2 recap', 'Ending', 'Preview', 'Opening Scene Battle']) {
    assert.equal(chapterIntro([{start_time: 0, end_time: 60, tags: {title}}]), null, title)
  }
  assert.equal(chapterIntro([{start_time: 0, end_time: 3, tags: {title: 'Intro'}}]), null, 'too short')
  assert.equal(chapterIntro([{start_time: 900, end_time: 960, tags: {title: 'Intro'}}], {duration: 1200}), null, 'in the second half')
  assert.equal(chapterIntro(undefined), null)
})

test('neighbouring episodes, nearest first, in natural order', () => {
  const files = ['Show S01E10.mkv', 'Show S01E2.mkv', 'Show S01E1.mkv', 'Show S01E3.mkv', 'notes.txt', 'Show S01E2.en.srt']
  assert.deepEqual(neighbours('Show S01E2.mkv', files), ['Show S01E3.mkv', 'Show S01E1.mkv', 'Show S01E10.mkv'])
  assert.deepEqual(neighbours('Show S01E10.mkv', files), ['Show S01E3.mkv', 'Show S01E2.mkv'])
  assert.deepEqual(neighbours('alone.mkv', ['alone.mkv']), [])
})

test('a double episode and its single neighbours are compared, a film beside episodes is not', () => {
  assert.equal(comparableLength(2950, 1474), true, 'double episode, single neighbour')
  assert.equal(comparableLength(1474, 2950), true, 'single episode, double neighbour')
  assert.equal(comparableLength(1474, 1400), true, 'ordinary neighbour')
  assert.equal(comparableLength(5400, 1400), false, 'film beside episodes')
  assert.equal(comparableLength(1400, 5400), false, 'episode beside a film')
  assert.equal(comparableLength(0, 1400), false, 'unknown length')
})
