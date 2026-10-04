const {EventEmitter} = require('node:events')
const {spawn} = require('node:child_process')
const path = require('node:path')
const MAX_LINE = 16 * 1024
const STALL_MS = 5 * 60 * 1000
const PHASES = new Set(['checking', 'downloading', 'extracting', 'ready', 'installing', 'current', 'error', 'blocked', 'installed'])

// Resolve only the running executable's app; never a renderer-supplied path.
function appBundle(executable) {
  if (typeof executable !== 'string' || !path.isAbsolute(executable)) throw new Error('Invalid app executable')
  const bundle = path.resolve(executable, '..', '..', '..')
  if (!bundle.endsWith('.app') || path.dirname(executable) !== path.join(bundle, 'Contents', 'MacOS')) throw new Error('Invalid app bundle')
  return bundle
}
function parseStatus(line) {
  if (line.length > MAX_LINE) throw new Error('Updater message is too large')
  const value = JSON.parse(line)
  if (!value || !PHASES.has(value.phase)) throw new Error('Invalid updater status')
  const status = {phase: value.phase}
  if (typeof value.version === 'string' && /^\d+\.\d+\.\d+$/.test(value.version) && value.version.length <= 40) status.version = value.version
  if (typeof value.message === 'string') status.message = value.message.slice(0, 1000)
  if (Number.isFinite(value.progress)) status.progress = Math.max(0, Math.min(100, Math.floor(value.progress)))
  return status
}
class SparkleDriver extends EventEmitter {
  constructor({executable, resources, spawnHelper = spawn, schedule = setTimeout, cancel = clearTimeout}) {
    super()
    this.bundle = appBundle(executable)
    this.helper = path.join(resources, 'updater', 'WatchWithFriendsUpdater.app', 'Contents', 'MacOS', 'WatchWithFriendsUpdater')
    Object.assign(this, {spawnHelper, schedule, cancel})
    this.child = this.timer = null
    this.ready = this.installing = false
  }
  check() {
    if (this.child) return
    this.ready = this.installing = false
    const child = this.spawnHelper(this.helper, [this.bundle], {stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true})
    this.child = child
    let buffered = ''
    let terminal = false
    const fail = (message) => {
      if (terminal || this.child !== child) return
      terminal = true
      this.ready = false
      this.cancel(this.timer)
      this.timer = null
      this.emit('status', {phase: 'error', message})
      child.kill()
    }
    const watch = () => {
      this.cancel(this.timer)
      this.timer = this.schedule(() => fail('Update stopped responding; it will be retried.'), STALL_MS)
      this.timer?.unref?.()
    }
    watch()
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      if (terminal || this.child !== child) return
      buffered += chunk
      let end
      while ((end = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, end)
        buffered = buffered.slice(end + 1)
        if (!line) continue
        try {
          const status = parseStatus(line)
          if (status.phase === 'ready') {
            this.ready = true
            this.cancel(this.timer)
            this.timer = null // watching a long film is not a stalled updater
          } else if (['current', 'error', 'blocked', 'installed'].includes(status.phase)) {
            terminal = true
            this.cancel(this.timer)
            this.timer = null
          } else watch()
          if (status.phase !== 'installed') this.emit('status', status)
          if (terminal) return
        } catch (error) { fail(error.message); return }
      }
      if (buffered.length > MAX_LINE) fail('Updater message is too large')
    })
    child.stderr.resume()
    child.on('error', (error) => fail(error.message))
    child.stdin.on('error', (error) => fail(error.message))
    child.on('close', (code, signal) => {
      if (this.child !== child) return
      this.child = null
      this.ready = false
      this.cancel(this.timer)
      this.timer = null
      if (!terminal) this.emit('status', {phase: 'error', message: `Updater exited before finishing (${signal || code}).`})
    })
  }
  install() {
    if (!this.child || !this.ready || this.installing || this.child.stdin.destroyed) throw new Error('No verified update is ready')
    this.installing = true
    return new Promise((resolve, reject) => this.child.stdin.write('install\n', (error) => error ? reject(error) : resolve()))
  }
  dispose() {
    this.cancel(this.timer)
    // Closing stdin dismisses the UI. Sparkle's installer can finish on normal
    // quit after staging; killing that process would lose this protection.
    this.child?.stdin.end()
  }
}
module.exports = {SparkleDriver, appBundle, parseStatus, MAX_LINE, STALL_MS}
