// Drivers download/stage; this owns when a restart is allowed. Independent of
// Electron so session races and failures can be tested with controlled clocks.
const {EventEmitter} = require('node:events')
const CHECK_MS = 60 * 60 * 1000
const RETRY_MS = [60_000, 300_000, 900_000, CHECK_MS]
const INSTALL_DELAY_MS = 3000
const ACTIVE = new Set(['checking', 'downloading', 'extracting', 'ready', 'installing'])

class UpdateController extends EventEmitter {
  constructor(driver, {schedule = setTimeout, cancel = clearTimeout, record = () => {}} = {}) {
    super()
    Object.assign(this, {driver, schedule, cancel, record})
    this.status = {phase: 'idle'}
    this.inRoom = this.started = false
    this.failures = 0
    this.checkTimer = this.installTimer = null
    driver.on('status', (status) => this.receive(status))
  }
  snapshot() { return {...this.status, inRoom: this.inRoom} }
  publish(status) {
    const changed = this.status.phase !== status.phase
    this.status = status
    if (changed) this.record('update', status.phase, status, status.phase === 'error' ? 'warn' : 'info')
    this.emit('status', this.snapshot())
  }
  start() {
    if (this.started) return
    this.started = true
    this.check()
  }
  later(delay) {
    this.cancel(this.checkTimer)
    this.checkTimer = this.schedule(() => { this.checkTimer = null; this.check() }, delay)
    this.checkTimer?.unref?.()
  }
  async check() {
    if (!this.started || ACTIVE.has(this.status.phase)) return this.snapshot()
    this.cancel(this.checkTimer)
    this.checkTimer = null
    this.publish({phase: 'checking'})
    try { await this.driver.check() }
    catch (error) { this.receive({phase: 'error', message: String(error?.message || error)}) }
    return this.snapshot()
  }
  receive(status) {
    if (!this.started) return
    if (!status || !['checking', 'downloading', 'extracting', 'ready', 'installing', 'current', 'error', 'blocked'].includes(status.phase)) return
    this.cancel(this.installTimer)
    this.installTimer = null
    this.publish({...status})
    if (status.phase === 'ready') {
      this.failures = 0
      this.installWhenIdle()
    } else if (status.phase === 'current') {
      this.failures = 0
      this.later(CHECK_MS)
    } else if (status.phase === 'error' || status.phase === 'blocked') {
      this.later(RETRY_MS[Math.min(this.failures++, RETRY_MS.length - 1)])
    }
  }
  setInRoom(value) {
    if (this.inRoom === Boolean(value)) return
    this.inRoom = Boolean(value)
    this.cancel(this.installTimer)
    this.installTimer = null
    this.emit('status', this.snapshot())
    this.installWhenIdle()
  }
  installWhenIdle() {
    if (this.inRoom || this.status.phase !== 'ready' || this.installTimer !== null) return
    // Leaving/joining IPC can race a download; recheck at the actual restart.
    this.installTimer = this.schedule(async () => {
      this.installTimer = null
      if (this.inRoom || this.status.phase !== 'ready') return
      this.publish({...this.status, phase: 'installing'})
      try { await this.driver.install() }
      catch (error) { this.receive({phase: 'error', message: String(error?.message || error)}) }
    }, INSTALL_DELAY_MS)
    this.installTimer?.unref?.()
  }
  dispose() {
    this.started = false
    this.cancel(this.checkTimer)
    this.cancel(this.installTimer)
    this.checkTimer = this.installTimer = null
    this.driver.dispose?.()
  }
}
module.exports = {UpdateController, CHECK_MS, RETRY_MS, INSTALL_DELAY_MS}
