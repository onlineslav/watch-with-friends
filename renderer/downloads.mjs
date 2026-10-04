import {isId} from './protocol.mjs'
import constants from '../shared/downloads.js'
const {DOWNLOAD_CHUNK_BYTES, MAX_DOWNLOADS, validFileSize, downloadName} = constants
const TIMEOUT_MS = 30_000
const abort = () => { throw new DOMException('Download cancelled', 'AbortError') }
const check = (signal) => { if (signal.aborted) abort() }
const validInfo = (info) => info && typeof info.name === 'string' && info.name.length <= 200 &&
  downloadName(info.name) === info.name && validFileSize(info.size)

// Pull one chunk only after the preceding chunk has been written to disk. The same
// paths serve local Save As and peer downloads, and every instance belongs to one room.
export class RoomDownloads {
  constructor({api, infoAction, chunkAction, closeAction, resolveFile, isActive, changed = () => {}, completed = () => {}, failed = () => {}}) {
    Object.assign(this, {api, infoAction, chunkAction, closeAction, resolveFile, isActive, changed, completed, failed})
    this.sources = new Map()
    this.jobs = new Map()
    this.closed = false
  }
  path(id) {
    const filePath = isId(id) && !this.closed && this.isActive() && this.resolveFile(id)
    if (!filePath) throw new Error('File is no longer available in this room')
    return filePath
  }
  async info(request, peerId) {
    const filePath = this.path(request?.id)
    if (request.type === 'info') {
      try {
        const info = await this.api.downloadInfo(filePath)
        if (this.path(request.id) !== filePath) throw new Error('File changed')
        return info
      }
      catch { throw new Error('File is no longer available') }
    }
    if (request.type !== 'open' || !isId(request.transferId) || !validFileSize(request.size)) throw new Error('Invalid download request')
    const key = `${peerId}:${request.transferId}`
    if (this.sources.has(key) || [...this.sources.values()].filter((source) => source.peerId === peerId).length >= MAX_DOWNLOADS) throw new Error('Too many downloads')
    const source = {id: request.id, peerId, transferId: request.transferId, filePath, closed: false, busy: false, token: null}
    this.sources.set(key, source)
    try {
      source.token = await this.api.downloadOpen(filePath, request.size)
      if (source.closed || this.path(source.id) !== filePath) throw new Error('File is no longer available')
      this.touch(source)
      return {ready: true}
    } catch (error) { await this.drop(source); throw new Error('File is no longer available. Try downloading again.') }
  }
  touch(source) {
    clearTimeout(source.timer)
    source.timer = setTimeout(() => this.drop(source).catch(() => {}), 60_000)
    source.timer.unref?.()
  }
  async chunk(request, peerId) {
    if (!isId(request?.transferId) || !validFileSize(request.offset)) throw new Error('Invalid download request')
    const source = this.sources.get(`${peerId}:${request.transferId}`)
    if (!source || source.closed || !source.token || source.busy) throw new Error('File transfer unavailable')
    source.busy = true
    this.touch(source)
    try {
      if (this.path(source.id) !== source.filePath) throw new Error('File transfer unavailable')
      const bytes = await this.api.downloadRead(source.token, request.offset)
      if (source.closed || this.path(source.id) !== source.filePath) throw new Error('File transfer unavailable')
      this.touch(source)
      return bytes
    } catch (error) { await this.drop(source); throw new Error('File changed or is no longer available') }
    finally { source.busy = false }
  }
  close(request, peerId) {
    if (!isId(request?.transferId)) return Promise.resolve()
    return this.drop(this.sources.get(`${peerId}:${request.transferId}`))
  }
  async drop(source) {
    if (!source) return
    source.closed = true
    clearTimeout(source.timer)
    const key = `${source.peerId}:${source.transferId}`
    if (this.sources.get(key) === source) this.sources.delete(key)
    if (source.token) await this.api.downloadCancel(source.token)
  }
  async download(id, peerId, local = false) {
    if (this.closed || this.jobs.has(id)) return
    if (this.jobs.size >= MAX_DOWNLOADS) { this.failed('Wait for a download to finish first.'); return }
    const controller = new AbortController()
    const {signal} = controller
    const transferId = crypto.randomUUID()
    const job = {id, peerId, local, controller, transferId, received: 0, size: 0, phase: 'Preparing download', destination: null}
    this.jobs.set(id, job)
    this.changed()
    const request = (action, value, handler) => local ? handler.call(this, value, peerId)
      : action.request(value, {target: peerId, timeoutMs: TIMEOUT_MS, signal})
    try {
      const info = await request(this.infoAction, {type: 'info', id}, this.info)
      check(signal)
      if (!validInfo(info)) throw new Error('The owner sent invalid file information')
      job.size = info.size
      job.phase = 'Choose save location'
      this.changed()
      job.destination = await this.api.downloadSave(info)
      check(signal)
      if (!job.destination) return
      job.phase = 'Downloading'
      this.changed()
      const ready = await request(this.infoAction, {type: 'open', id, transferId, size: info.size}, this.info)
      check(signal)
      if (ready?.ready !== true) throw new Error('The owner could not start the download')
      while (job.received < job.size) {
        check(signal)
        const reply = await request(this.chunkAction, {transferId, offset: job.received}, this.chunk)
        check(signal)
        const bytes = reply instanceof ArrayBuffer ? new Uint8Array(reply) : reply
        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== Math.min(DOWNLOAD_CHUNK_BYTES, job.size - job.received)) throw new Error('Invalid download chunk')
        const received = await this.api.downloadWrite(job.destination, job.received, bytes)
        check(signal)
        if (received !== job.received + bytes.byteLength) throw new Error('Could not save download')
        job.received = received
      }
      check(signal)
      job.phase = 'Saving'
      this.changed()
      await this.api.downloadFinish(job.destination)
      job.destination = null
      this.completed(info.name)
    } catch (error) {
      if (!signal.aborted) this.failed(error?.kind === 'timeout'
        ? 'Download timed out. Keep the owner online and check that both apps are up to date.'
        : error?.message || 'Download failed. Try again.')
    } finally {
      if (job.destination) await this.api.downloadCancel(job.destination).catch(() => {})
      if (local) await this.close({transferId}, peerId).catch(() => {})
      else this.closeAction.send({transferId}, {target: peerId}).catch(() => {})
      this.jobs.delete(id)
      this.changed()
    }
  }
  cancel(id) {
    const job = this.jobs.get(id)
    if (!job || job.phase === 'Saving') return
    job.controller.abort()
    job.phase = 'Cancelling'
    this.changed()
  }
  remove(id) {
    this.cancel(id)
    for (const source of this.sources.values()) if (source.id === id) this.drop(source).catch(() => {})
  }
  peerLeft(peerId) {
    for (const job of this.jobs.values()) if (!job.local && job.peerId === peerId && job.phase !== 'Saving') {
      this.cancel(job.id)
      this.failed('Download stopped because the owner left the room.')
    }
    for (const source of this.sources.values()) if (source.peerId === peerId) this.drop(source).catch(() => {})
  }
  dispose() {
    this.closed = true
    for (const job of this.jobs.values()) job.controller.abort()
    for (const source of this.sources.values()) this.drop(source).catch(() => {})
  }
}
