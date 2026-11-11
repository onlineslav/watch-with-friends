import test from 'node:test'
import assert from 'node:assert/strict'
import {shortcutGroups, SHORTCUTS_KEY} from '../renderer/shortcuts.mjs'
import {REACTIONS} from '../renderer/reactions.mjs'
import {MARK_KEY} from '../renderer/context.mjs'

const all = (platform) => shortcutGroups(platform).flatMap((g) => g.items)

test('the shortcuts panel lists every reaction, the mark key and itself', () => {
  const caps = all('win32').map((i) => i.keys.join('+'))
  for (const {key} of Object.values(REACTIONS)) assert.ok(caps.includes(key.replace('Digit', '')), key)
  assert.ok(caps.includes(MARK_KEY.replace('Key', '')))
  assert.ok(caps.includes(SHORTCUTS_KEY))
  assert.ok(caps.includes('S'), 'skip intro')
})

test('the size keys name the platform\'s modifier', () => {
  assert.ok(all('darwin').some((i) => i.keys[0] === '⌘'))
  assert.ok(!all('win32').some((i) => i.keys.includes('⌘')))
  assert.ok(all('win32').some((i) => i.keys[0] === 'Ctrl'))
})

test('every line has a label and at least one key', () => {
  for (const item of all('linux')) {
    assert.ok(item.label && item.keys.length, JSON.stringify(item))
    assert.ok(item.keys.every((k) => typeof k === 'string' && k))
  }
})
