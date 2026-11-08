import {test} from 'node:test'
import assert from 'node:assert/strict'
import {fitLayout, SEEK_ROOM, trackMenu, parseTrackChoice} from '../renderer/controls-layout.mjs'

// A fake bar: `width` of room, fixed controls taking `fixed`, two dropdowns of `dropdowns` px
// (one of `merged` px when merged), and a timeline that gets whatever is left, at least 120px.
function bar({width, fixed = 600, dropdowns = 300, merged = 160}) {
  return (steps) => {
    const menus = steps.includes('merged-tracks') ? merged : dropdowns
    if (steps.includes('stacked')) return {seek: width, overflow: Math.max(0, fixed + menus - width)}
    const left = width - fixed - menus
    return {seek: Math.max(120, left), overflow: Math.max(0, 120 - left)}
  }
}

test('a wide bar keeps both dropdowns and one row', () => {
  assert.deepEqual(fitLayout(bar({width: 1400}), true), [])
})

test('the dropdowns merge before the timeline gets short', () => {
  // 1100 - 600 - 300 = 200 left for the timeline: under SEEK_ROOM, so merge (then 340).
  assert.ok(200 < SEEK_ROOM)
  assert.deepEqual(fitLayout(bar({width: 1100}), true), ['merged-tracks'])
})

test('the timeline takes its own row only when merging is not enough', () => {
  assert.deepEqual(fitLayout(bar({width: 900}), true), ['merged-tracks', 'stacked'])
})

test('with one dropdown there is nothing to merge, so a short timeline stacks', () => {
  assert.deepEqual(fitLayout(bar({width: 980, dropdowns: 160}), false), ['stacked'])
})

test('the merged dropdown has a summary and a section each for language and subtitles', () => {
  const audio = [{value: '0', label: 'English'}, {value: '1', label: 'Japanese'}]
  const subtitles = [{value: '', label: 'Subtitles off'}, {value: 's2', label: 'English (SDH)'}, {value: '__load__', label: 'Load subtitle file…'}]
  const menu = trackMenu(audio, '1', subtitles, '')
  assert.equal(menu.summary, 'Japanese · Subtitles off')
  assert.deepEqual(menu.groups.map((g) => g.label), ['Language', 'Subtitles'])
  assert.deepEqual(menu.groups[0].options, [
    {value: 'a:0', label: 'English', current: false},
    {value: 'a:1', label: 'Japanese', current: true},
  ])
  assert.deepEqual(menu.groups[1].options.map((o) => [o.value, o.current]), [['s:', true], ['s:s2', false], ['s:__load__', false]])
})

test('a merged value says which dropdown it belongs to', () => {
  assert.deepEqual(parseTrackChoice('a:1'), {kind: 'audio', value: '1'})
  assert.deepEqual(parseTrackChoice('s:'), {kind: 'subtitles', value: ''})
  assert.deepEqual(parseTrackChoice('s:a:odd'), {kind: 'subtitles', value: 'a:odd'})
  assert.equal(parseTrackChoice(''), null)
  assert.equal(parseTrackChoice(undefined), null)
})
