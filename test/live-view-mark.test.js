const test = require('node:test')
const assert = require('node:assert/strict')
const view = require('../scripts/live-view')
const {encodeBatch} = require('../shared/live')

const mark = {t: '2026-11-03T20:00:24.000Z', m: 1, lv: 'info', sc: 'mark', ev: 'note', id: 'k3x9f2a1', src: 'peer', by: 'viewer-two#0000-0000', note: 'audio crackles'}
const sample = {t: '2026-11-03T20:00:24.100Z', m: 2, lv: 'info', sc: 'telemetry', ev: 'viewer-sample', rttMs: 31}
const item = (line) => ({label: 'host-one', line, text: JSON.stringify(line), at: Date.parse(line.t)})

test('--live: a mark is a banner with the note and who pressed it; a sample is not', () => {
  const plain = view.formatLine(item(mark), {color: false})
  assert.match(plain, />>> MARK by viewer-two#0000-0000 "audio crackles" <<<  mark\/note/)
  assert.doesNotMatch(view.formatLine(item(sample), {color: false}), /MARK/)
  const colored = view.formatLine(item(mark), {color: true, colorOf: () => 36})
  assert.match(colored, /\u001b\[1;91m>>> MARK/, 'bold red where there is colour')
  assert.match(colored, /\u001b\[0m$/)
  // A mark with nothing else on it still reads.
  assert.match(view.formatLine(item({...mark, note: undefined, by: undefined}), {color: false}), />>> MARK <<<  mark\/note/)
})

test('--live: a note cannot smuggle terminal control codes into the banner', () => {
  const hostile = view.formatLine(item({...mark, note: 'hi\u001b[2J\u0007there', by: 'x‮y'}), {color: false})
  assert.doesNotMatch(hostile, /[\u0000-\u001f\u007f-\u009f‮]/)
})

test('--live: marks pass every scope filter, so they are never missed while watching one thing', () => {
  assert.equal(view.wanted(mark, ['telemetry']), true)
  assert.equal(view.wanted(mark, ['telemetry/host-sample']), true)
  assert.equal(view.wanted(sample, ['clock']), false)
  assert.equal(view.wanted(sample, ['telemetry']), true)
  const frame = Buffer.concat([Buffer.from([4]), Buffer.from('aya!'), encodeBatch([JSON.stringify(mark), JSON.stringify(sample)])])
  const lines = view.linesFromFrame(frame, {scopes: ['clock']})
  assert.deepEqual(lines.map((l) => l.line.ev), ['note'], 'through a whole frame, with a filter that excludes everything else')
})
