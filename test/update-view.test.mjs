import test from 'node:test'
import assert from 'node:assert/strict'
import {describeUpdate} from '../renderer/update.mjs'
test('Home describes automatic updates and waiting for a room without manual DMG steps', () => {
  assert.match(describeUpdate({phase: 'downloading', version: '1.2.3', progress: 30}).text, /30%/)
  assert.match(describeUpdate({phase: 'ready', inRoom: true}).text, /after you leave/)
  assert.match(describeUpdate({phase: 'ready', inRoom: false}).text, /restart shortly/)
  assert.match(describeUpdate({phase: 'installing'}).text, /reopen automatically/)
  for (const phase of ['current', 'idle', 'checking', 'unknown']) assert.equal(describeUpdate({phase}), null)
})
test('failures allow retry; raw native details and malformed values are never displayed', () => {
  assert.equal(describeUpdate({phase: 'error', message: '/Users/private/secret'}).retry, true)
  assert.doesNotMatch(describeUpdate({phase: 'error', message: '/Users/private/secret'}).text, /secret/)
  assert.equal(describeUpdate({phase: 'blocked'}).retry, true)
  assert.match(describeUpdate({phase: 'downloading', version: '<script>', progress: 1000}).text, /^Update.*100%/)
})
