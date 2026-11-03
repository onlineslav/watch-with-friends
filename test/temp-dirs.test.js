const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {create, removeStale} = require('../scripts/temp-dirs')

const sandbox = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wwf-tempdirs-test-'))
const folder = (tmp, name, {owner, ageMs = 0, file = true} = {}) => {
  const dir = path.join(tmp, name)
  fs.mkdirSync(path.join(dir, 'profile'), {recursive: true})
  if (file) fs.writeFileSync(path.join(dir, 'profile', 'big.bin'), 'x')
  if (owner != null) fs.writeFileSync(path.join(dir, 'owner.pid'), String(owner))
  const when = new Date(Date.now() - ageMs)
  fs.utimesSync(dir, when, when)
  return dir
}

test('removes folders of dead owners and old ownerless ones, keeps live and recent ones and other prefixes', () => {
  const tmp = sandbox()
  try {
    const deadPid = 2 ** 22 + 12345 // not a pid in use
    const dead = folder(tmp, 'synced-x-dead', {owner: deadPid})
    const live = folder(tmp, 'synced-x-live', {owner: process.pid})
    const oldNoOwner = folder(tmp, 'synced-x-old', {ageMs: 2 * 3600 * 1000})
    const freshNoOwner = folder(tmp, 'synced-x-fresh', {ageMs: 1000})
    const other = folder(tmp, 'other-dead', {owner: deadPid})
    assert.equal(removeStale('synced-x-', {tmp}), 2)
    assert.ok(!fs.existsSync(dead) && !fs.existsSync(oldNoOwner))
    assert.ok(fs.existsSync(live) && fs.existsSync(freshNoOwner) && fs.existsSync(other))
  } finally { fs.rmSync(tmp, {recursive: true, force: true}) }
})

test('create clears stale folders, records its owner, and release removes the folder', () => {
  const tmp = sandbox()
  try {
    const stale = folder(tmp, 'synced-y-stale', {owner: 2 ** 22 + 999})
    const run = create('synced-y-', {tmp})
    assert.ok(!fs.existsSync(stale))
    assert.equal(fs.readFileSync(path.join(run.dir, 'owner.pid'), 'utf8'), String(process.pid))
    fs.writeFileSync(path.join(run.dir, 'sample.mp4'), 'data')
    run.release()
    assert.ok(!fs.existsSync(run.dir))
    run.release() // twice is harmless
  } finally { fs.rmSync(tmp, {recursive: true, force: true}) }
})

test('keep leaves the folder for inspection', () => {
  const tmp = sandbox()
  try {
    const run = create('synced-z-', {tmp, keep: true})
    run.release()
    assert.ok(fs.existsSync(run.dir))
  } finally { fs.rmSync(tmp, {recursive: true, force: true}) }
})
