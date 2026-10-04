import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {createRequire} from 'node:module'
import {RoomDownloads} from '../renderer/downloads.mjs'
const require = createRequire(import.meta.url)
const {DownloadFiles} = require('../main/downloads')
const {DOWNLOAD_CHUNK_BYTES, downloadName} = require('../shared/downloads')

async function fixture(t, size = DOWNLOAD_CHUNK_BYTES * 3 + 73) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wwf-download-test-'))
  const source = path.join(directory, 'original.mp4'), target = path.join(directory, 'saved.mp4')
  const bytes = Buffer.alloc(size)
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251
  await fs.writeFile(source, bytes)
  const owner = new DownloadFiles(), viewer = new DownloadFiles()
  const messages = [], failures = [], completed = [], closing = []
  let available = true
  const ownerApi = {
    downloadInfo: (file) => owner.info(file), downloadOpen: (file, length) => owner.open(file, length),
    downloadRead: (id, offset) => owner.read(id, offset), downloadCancel: (id) => owner.cancel(id),
  }
  const server = new RoomDownloads({api: ownerApi, resolveFile: (id) => available && id === 'item-1' && source, isActive: () => true})
  const request = (handler) => ({request: async (value, options) => {
    messages.push({value, target: options.target})
    options.signal.throwIfAborted()
    const result = await handler(value, 'viewer')
    options.signal.throwIfAborted()
    return result instanceof Uint8Array ? result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength) : result
  }})
  const api = {
    downloadSave: (info) => viewer.save(target, info.size), downloadWrite: (id, offset, chunk) => viewer.write(id, offset, chunk),
    downloadFinish: (id) => viewer.finish(id), downloadCancel: (id) => viewer.cancel(id),
  }
  const client = new RoomDownloads({api, resolveFile: () => null, isActive: () => true,
    infoAction: request(server.info.bind(server)), chunkAction: request(server.chunk.bind(server)),
    closeAction: {send: (value) => { const pending = server.close(value, 'viewer'); closing.push(pending); return pending }}, failed: (message) => failures.push(message), completed: (name) => completed.push(name),
  })
  t.after(async () => {
    server.dispose(); client.dispose()
    await Promise.all([owner.dispose(), viewer.dispose()])
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(directory).startsWith('wwf-download-test-'))
    await fs.rm(directory, {recursive: true, force: true})
  })
  return {source, target, directory, bytes, owner, viewer, server, client, api, ownerApi, messages, failures, completed,
    waitForClose: () => Promise.all(closing), revoke: () => { available = false }}
}

test('peer download saves exact bytes in bounded chunks and sends IDs instead of paths', async (t) => {
  const f = await fixture(t)
  await f.client.download('item-1', 'owner')
  assert.deepEqual(await fs.readFile(f.target), f.bytes)
  assert.equal(f.messages.filter((message) => message.value.offset !== undefined).length, 4)
  assert.ok(f.messages.every((message) => message.target === 'owner'))
  assert.ok(!JSON.stringify(f.messages).includes(f.source))
  assert.deepEqual(f.failures, [])
  assert.deepEqual(f.completed, ['original.mp4'])
  assert.equal(f.owner.files.size + f.viewer.files.size + f.server.sources.size + f.client.jobs.size, 0)
  assert.deepEqual((await fs.readdir(f.directory)).sort(), ['original.mp4', 'saved.mp4'])
})

test('empty files finish without a chunk request', async (t) => {
  const f = await fixture(t, 0)
  await f.client.download('item-1', 'owner')
  assert.equal((await fs.stat(f.target)).size, 0)
  assert.equal(f.messages.length, 2)
})

test('a source changing during its final chunk cannot replace an existing destination', async (t) => {
  const f = await fixture(t, 8)
  await fs.writeFile(f.target, 'keep this')
  const read = f.ownerApi.downloadRead
  f.ownerApi.downloadRead = async (id, offset) => {
    const handle = f.owner.files.get(id).handle
    const originalRead = handle.read.bind(handle)
    let changed = false
    handle.read = async (buffer, start, length, position) => {
      if (changed) return originalRead(buffer, start, length, position)
      const result = await originalRead(buffer, start, Math.floor(length / 2), position)
      changed = true
      await fs.writeFile(f.source, Buffer.alloc(f.bytes.length, 255))
      const later = new Date(Date.now() + 5000)
      await fs.utimes(f.source, later, later)
      return result
    }
    return read(id, offset)
  }
  await f.client.download('item-1', 'owner')
  assert.equal(await fs.readFile(f.target, 'utf8'), 'keep this')
  assert.deepEqual(f.completed, [])
  assert.equal(f.failures.length, 1)
  assert.equal(f.owner.files.size + f.viewer.files.size, 0)
  assert.ok((await fs.readdir(f.directory)).every((name) => !name.endsWith('.part')))
})

test('cancellation cleans partial downloads and preserves a pre-existing destination', async (t) => {
  const f = await fixture(t)
  await fs.writeFile(f.target, 'keep this')
  const write = f.api.downloadWrite
  f.api.downloadWrite = async (...args) => {
    const result = await write(...args)
    f.client.cancel('item-1')
    return result
  }
  await f.client.download('item-1', 'owner')
  assert.equal(await fs.readFile(f.target, 'utf8'), 'keep this')
  assert.deepEqual(f.completed, [])
  assert.deepEqual(f.failures, [])
  // Peer close is deliberately sent without blocking the client's cancellation.
  // Await the fixture's transport delivery before asserting remote disk cleanup.
  await f.waitForClose()
  assert.equal(f.owner.files.size + f.viewer.files.size, 0)
  assert.ok((await fs.readdir(f.directory)).every((name) => !name.endsWith('.part')))
})

test('leaving during the save dialog cancels the late destination without opening a source', async (t) => {
  const f = await fixture(t)
  const save = f.api.downloadSave
  f.api.downloadSave = async (info) => { f.client.dispose(); return save(info) }
  await f.client.download('item-1', 'owner')
  assert.equal(f.messages.length, 1)
  assert.equal(f.viewer.files.size, 0)
  assert.deepEqual(await fs.readdir(f.directory), ['original.mp4'])
})

test('save-dialog cancellation does not request any file content', async (t) => {
  const f = await fixture(t)
  f.api.downloadSave = async () => null
  await f.client.download('item-1', 'owner')
  assert.equal(f.messages.length, 1)
  assert.equal(f.owner.files.size + f.viewer.files.size, 0)
})

test('removing an item during source opening closes the late capability', async (t) => {
  const f = await fixture(t)
  const open = f.ownerApi.downloadOpen
  f.ownerApi.downloadOpen = async (...args) => { const token = await open(...args); f.server.remove('item-1'); return token }
  await assert.rejects(f.server.info({type: 'open', id: 'item-1', transferId: 'transfer', size: f.bytes.length}, 'viewer'), /no longer available/)
  assert.equal(f.owner.files.size + f.server.sources.size, 0)
})

test('a transfer is bound to its requesting peer and cannot grant other file paths', async (t) => {
  const f = await fixture(t)
  await assert.rejects(f.server.info({type: 'info', id: f.source}, 'viewer'), /no longer available/)
  await f.server.info({type: 'open', id: 'item-1', transferId: 'transfer', size: f.bytes.length}, 'viewer')
  await assert.rejects(f.server.chunk({transferId: 'transfer', offset: 0}, 'intruder'), /unavailable/)
  await f.server.close({transferId: 'transfer'}, 'intruder')
  assert.equal(f.server.sources.size, 1)
  f.revoke()
  await assert.rejects(f.server.chunk({transferId: 'transfer', offset: 0}, 'viewer'), /no longer available/)
  assert.equal(f.server.sources.size + f.owner.files.size, 0)
})

test('invalid chunks fail safely instead of saving corrupt or oversized files', async (t) => {
  const f = await fixture(t)
  f.client.chunkAction.request = async () => new Uint8Array(DOWNLOAD_CHUNK_BYTES + 1)
  await f.client.download('item-1', 'owner')
  assert.match(f.failures[0], /Invalid download chunk/)
  assert.deepEqual(await fs.readdir(f.directory), ['original.mp4'])
})

test('disk capabilities reject wrong offsets and incomplete finalization', async (t) => {
  const f = await fixture(t)
  const id = await f.viewer.save(f.target, 4)
  await assert.rejects(f.viewer.write(id, 1, new Uint8Array([1])), /Invalid download chunk/)
  await f.viewer.write(id, 0, new Uint8Array([1, 2]))
  await assert.rejects(f.viewer.finish(id), /incomplete/)
  const source = await f.owner.open(f.source, f.bytes.length)
  await assert.rejects(f.owner.read(source, -1), /offset/)
  await assert.rejects(f.owner.read(source, 1), /offset/)
  await fs.writeFile(f.source, 'changed')
  await assert.rejects(f.owner.read(source, 0), /changed/)
  await f.viewer.cancel(id)
  await assert.rejects(f.viewer.write(id, 0, new Uint8Array([1])), /unavailable/)
})

test('peer departure cancels download content and reports why it stopped', async (t) => {
  const f = await fixture(t)
  const write = f.api.downloadWrite
  f.api.downloadWrite = async (...args) => { const received = await write(...args); f.client.peerLeft('owner'); return received }
  await f.client.download('item-1', 'owner')
  assert.match(f.failures[0], /owner left/)
  assert.deepEqual(await fs.readdir(f.directory), ['original.mp4'])
})

test('owner-side filesystem failures never disclose local paths to the room', async (t) => {
  const f = await fixture(t)
  await fs.unlink(f.source)
  await assert.rejects(f.server.info({type: 'info', id: 'item-1'}, 'viewer'), (error) => !error.message.includes(f.directory))
})

test('download names cannot traverse folders or target Windows devices', () => {
  for (const name of ['../movie.mp4', 'C:\\private\\movie.mp4', 'CON', 'LPT1.txt', '..', 'folder/name\x00.mp4', `CON.${'a'.repeat(240)}`, `${'a'.repeat(199)} .mp4`]) {
    const cleaned = downloadName(name)
    assert.ok(cleaned.length > 0 && !/[\\/\x00]/.test(cleaned))
    assert.ok(!/^(con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i.test(cleaned))
    assert.equal(downloadName(cleaned), cleaned)
    assert.ok(cleaned.length <= 200)
  }
  assert.ok(downloadName(`${'a'.repeat(240)}.mp4`).endsWith('.mp4'))
})
