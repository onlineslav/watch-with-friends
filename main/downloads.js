const fs = require('node:fs/promises')
const path = require('node:path')
const {randomUUID} = require('node:crypto')
const {DOWNLOAD_CHUNK_BYTES, validFileSize, downloadName} = require('../shared/downloads')

// Capabilities are scoped to one renderer; neither source nor destination paths cross the network.
class DownloadFiles {
  constructor() {
    this.files = new Map()
    this.closed = false
    this.opening = 0
    this.timer = setInterval(() => {
      for (const [id, file] of this.files) if (!file.pending && Date.now() - file.touched > 120_000) this.cancel(id).catch(() => {})
    }, 30_000)
    this.timer.unref?.()
  }
  async info(filePath) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('File unavailable')
    const stat = await fs.stat(filePath)
    if (!stat.isFile() || !validFileSize(stat.size)) throw new Error('File unavailable')
    return {name: downloadName(path.basename(filePath)), size: stat.size}
  }
  async open(filePath, size) {
    return this.create(async () => {
      if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('File unavailable')
      const handle = await fs.open(filePath, 'r')
      try {
        const stat = await handle.stat()
        if (!stat.isFile() || !validFileSize(stat.size) || stat.size !== size) throw new Error('File changed. Try downloading again.')
        return {handle, kind: 'source', size: stat.size, mtime: stat.mtimeMs, offset: 0}
      } catch (error) { await handle.close(); throw error }
    })
  }
  async save(filePath, size) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || !validFileSize(size)) throw new Error('Invalid download')
    return this.create(async () => {
      const partial = path.join(path.dirname(filePath), `.wwf-${randomUUID()}.part`)
      const handle = await fs.open(partial, 'wx')
      return {handle, kind: 'destination', path: filePath, partial, size, offset: 0}
    })
  }
  async create(open) {
    if (this.closed || this.files.size + this.opening >= 32) throw new Error('Too many file transfers')
    this.opening++
    try {
      const file = await open()
      const id = randomUUID()
      Object.assign(file, {touched: Date.now(), cancelled: false, pending: null})
      this.files.set(id, file)
      if (this.closed) { await this.cancel(id); throw new Error('Download closed') }
      return id
    } finally { this.opening-- }
  }
  operate(id, kind, action) {
    const file = this.files.get(id)
    if (!file || file.kind !== kind || file.cancelled || file.pending) return Promise.reject(new Error('File transfer unavailable'))
    file.touched = Date.now()
    const pending = Promise.resolve().then(() => action(file))
    file.pending = pending
    return pending.finally(() => { file.pending = null; file.touched = Date.now() })
  }
  read(id, offset) {
    return this.operate(id, 'source', async (file) => {
      if (!validFileSize(offset) || offset !== file.offset || offset >= file.size) throw new Error('Invalid file offset')
      const stat = await file.handle.stat()
      if (stat.size !== file.size || stat.mtimeMs !== file.mtime) throw new Error('File changed during download')
      const bytes = Buffer.alloc(Math.min(DOWNLOAD_CHUNK_BYTES, file.size - offset))
      let read = 0
      while (read < bytes.length) {
        if (file.cancelled) throw new Error('Download cancelled')
        const result = await file.handle.read(bytes, read, bytes.length - read, offset + read)
        if (!result.bytesRead) throw new Error('File ended during download')
        read += result.bytesRead
      }
      const after = await file.handle.stat()
      if (file.cancelled) throw new Error('Download cancelled')
      if (after.size !== file.size || after.mtimeMs !== file.mtime) throw new Error('File changed during download')
      file.offset += bytes.length
      return new Uint8Array(bytes)
    })
  }
  write(id, offset, bytes) {
    return this.operate(id, 'destination', async (file) => {
      if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > DOWNLOAD_CHUNK_BYTES ||
          offset !== file.offset || offset + bytes.byteLength > file.size) throw new Error('Invalid download chunk')
      let written = 0
      while (written < bytes.byteLength) {
        if (file.cancelled) throw new Error('Download cancelled')
        const result = await file.handle.write(bytes, written, bytes.byteLength - written, offset + written)
        if (!result.bytesWritten) throw new Error('Could not write download')
        written += result.bytesWritten
      }
      file.offset += bytes.byteLength
      return file.offset
    })
  }
  finish(id) {
    return this.operate(id, 'destination', async (file) => {
      if (file.offset !== file.size) throw new Error('Download is incomplete')
      await file.handle.sync()
      await file.handle.close()
      if (file.cancelled) throw new Error('Download cancelled')
      await fs.rename(file.partial, file.path)
      this.files.delete(id)
      return file.path
    })
  }
  async cancel(id) {
    const file = this.files.get(id)
    if (!file) return
    file.cancelled = true
    await file.pending?.catch(() => {})
    await file.handle.close().catch(() => {})
    if (file.partial) await fs.unlink(file.partial).catch((error) => { if (error.code !== 'ENOENT') throw error })
    this.files.delete(id)
  }
  async dispose() {
    this.closed = true
    clearInterval(this.timer)
    await Promise.all([...this.files.keys()].map((id) => this.cancel(id)))
  }
}
module.exports = {DownloadFiles}
