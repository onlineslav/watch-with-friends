import test from 'node:test'
import assert from 'node:assert/strict'
import {chainSkip, cleanIntro, formatSkip, introShowing, previousAction, skipText, SKIP_CHAIN_MS} from '../renderer/skip.mjs'
import {createPlaylist, addItem, previousItem} from '../renderer/playlist.mjs'

test('intro from the wire', () => {
  assert.deepEqual(cleanIntro({start: 60, end: 120, extra: 1}, 1500), {start: 60, end: 120})
  assert.equal(cleanIntro(null), null)
  assert.equal(cleanIntro({start: 60}), null)
  assert.equal(cleanIntro({start: -1, end: 40}), null)
  assert.equal(cleanIntro({start: 10, end: 12}), null, 'too short')
  assert.equal(cleanIntro({start: 0, end: 900}), null, 'too long')
  assert.equal(cleanIntro({start: 60, end: 120}, 100), null, 'past the end')
  assert.equal(cleanIntro({start: '60', end: 120}), null)
})

test('the button shows during the intro only', () => {
  const intro = {start: 100, end: 160}
  assert.equal(introShowing(intro, 99), false)
  assert.equal(introShowing(intro, 99.6), true)
  assert.equal(introShowing(intro, 130), true)
  assert.equal(introShowing(intro, 158.4), true)
  assert.equal(introShowing(intro, 158.6), false)
  assert.equal(introShowing(null, 130), false)
  assert.equal(introShowing(intro, NaN), false)
})

test('skips in a row add up, a pause or a change of direction starts again', () => {
  let s = chainSkip(null, 30, 0)
  s = chainSkip(s, 30, 500)
  s = chainSkip(s, 30, 1000)
  assert.equal(s.total, 90)
  assert.equal(skipText(s.total), 'Skipped forward 1m 30s')
  assert.equal(chainSkip(s, 30, 1000 + SKIP_CHAIN_MS).total, 30)
  assert.equal(chainSkip(s, -10, 1100).total, -10)
  assert.equal(skipText(-10), 'Skipped back 10s')
  assert.equal(formatSkip(120), '2m')
})

test('previous restarts unless the item just began', () => {
  assert.equal(previousAction(30, true), 'restart')
  assert.equal(previousAction(2, true), 'previous')
  assert.equal(previousAction(2, false), 'restart')
})

test('previous item in playlist order', () => {
  const playlist = createPlaylist()
  for (const [id, position] of [['a', 1], ['b', 2], ['c', 3]]) addItem(playlist, {id, title: id, position}, 'me#x')
  assert.equal(previousItem(playlist, {id: 'c', position: 3})?.id, 'b')
  assert.equal(previousItem(playlist, {id: 'c', position: 3}, (item) => item.id !== 'b')?.id, 'a')
  assert.equal(previousItem(playlist, {id: 'a', position: 1}), null)
  assert.equal(previousItem(playlist, null), null)
})
