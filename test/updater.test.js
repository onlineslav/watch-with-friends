const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const {EventEmitter} = require('node:events')
const {PassThrough, Writable} = require('node:stream')
const {UpdateController, CHECK_MS, RETRY_MS, INSTALL_DELAY_MS} = require('../main/update-controller')
const {SparkleDriver, appBundle, parseStatus, MAX_LINE, STALL_MS} = require('../main/sparkle')
const {windowsDriver} = require('../main/windows-updater')

function clock() {
  const tasks = new Map()
  let id = 0
  return {
    tasks,
    schedule(fn, delay) { const token = ++id; tasks.set(token, {fn, delay}); return token },
    cancel(token) { tasks.delete(token) },
    async run(delay) {
      for (const [token, task] of [...tasks]) if (task.delay === delay && tasks.delete(token)) await task.fn()
    },
  }
}
function controller(t) {
  const timer = clock()
  const driver = new EventEmitter()
  driver.checks = driver.installs = 0
  driver.check = () => { driver.checks++ }
  driver.install = () => { driver.installs++ }
  const control = new UpdateController(driver, timer)
  t.after(() => control.dispose())
  control.start()
  return {timer, driver, control}
}
test('a download finishes during a film, waits indefinitely, then restarts once on leaving', async (t) => {
  const {timer, driver, control} = controller(t)
  control.setInRoom(true)
  driver.emit('status', {phase: 'ready', version: '1.2.3'})
  await timer.run(INSTALL_DELAY_MS)
  assert.equal(driver.installs, 0)
  assert.equal(control.snapshot().inRoom, true)
  control.setInRoom(false)
  await timer.run(INSTALL_DELAY_MS)
  assert.equal(driver.installs, 1)
  control.setInRoom(false)
  await timer.run(INSTALL_DELAY_MS)
  assert.equal(driver.installs, 1)
})
test('joining/rejoining cancels a pending restart, including repeated leave IPC', async (t) => {
  const {timer, driver, control} = controller(t)
  driver.emit('status', {phase: 'ready'})
  control.setInRoom(true)
  await timer.run(INSTALL_DELAY_MS)
  assert.equal(driver.installs, 0)
  control.setInRoom(false)
  control.setInRoom(false)
  assert.equal(timer.tasks.size, 1)
  control.setInRoom(true)
  await timer.run(INSTALL_DELAY_MS)
  assert.equal(driver.installs, 0)
})
test('an error after staging cancels installation and retries with bounded backoff', async (t) => {
  const {timer, driver, control} = controller(t)
  driver.emit('status', {phase: 'ready'})
  driver.emit('status', {phase: 'error', message: 'verification failed'})
  await timer.run(INSTALL_DELAY_MS)
  assert.equal(driver.installs, 0)
  for (const delay of [...RETRY_MS, CHECK_MS]) {
    await timer.run(delay)
    assert.equal(control.status.phase, 'checking')
    driver.emit('status', {phase: 'error', message: 'offline'})
  }
  driver.emit('status', {phase: 'current'})
  assert.equal(control.failures, 0)
})
test('launch, resume and retry calls never start overlapping checks or duplicate installs', async (t) => {
  const {timer, driver, control} = controller(t)
  control.start()
  await Promise.all([control.check(), control.check(), control.check()])
  assert.equal(driver.checks, 1)
  driver.emit('status', {phase: 'downloading', progress: 40})
  await control.check()
  assert.equal(driver.checks, 1)
  driver.emit('status', {phase: 'current'})
  await timer.run(CHECK_MS)
  assert.equal(driver.checks, 2)
  driver.emit('status', {phase: 'ready'})
  await control.check()
  await timer.run(INSTALL_DELAY_MS)
  assert.equal(driver.installs, 1)
})
test('thrown checks and failed installs leave the app usable and schedule retries', async (t) => {
  const {timer, driver, control} = controller(t)
  driver.emit('status', {phase: 'current'})
  driver.check = () => { throw new Error('missing helper') }
  await control.check()
  assert.equal(control.status.phase, 'error')
  assert.match(control.status.message, /missing helper/)
  driver.emit('status', {phase: 'ready'})
  driver.install = () => Promise.reject(new Error('permission denied'))
  await timer.run(INSTALL_DELAY_MS)
  assert.equal(control.status.phase, 'error')
  assert.match(control.status.message, /permission denied/)
})
test('normal quit clears scheduled restarts and future checks', async (t) => {
  const {timer, driver, control} = controller(t)
  driver.emit('status', {phase: 'ready'})
  control.dispose()
  await timer.run(INSTALL_DELAY_MS)
  assert.equal(driver.installs, 0)
  assert.equal(timer.tasks.size, 0)
})
test('the app bundle comes only from an executable at Contents/MacOS, including spaces', () => {
  const root = path.resolve('Fixture with spaces.app')
  assert.equal(appBundle(path.join(root, 'Contents/MacOS/Watch With Friends')), root)
  for (const invalid of [null, 'relative.app/Contents/MacOS/app', path.join(root, 'Contents/Other/app'), path.resolve('app')]) assert.throws(() => appBundle(invalid))
})
test('native messages reject malformed/oversized JSON and discard unexpected fields', () => {
  for (const invalid of ['garbage', 'null', '{}', '{"phase":"run-command"}', ' '.repeat(MAX_LINE + 1)]) assert.throws(() => parseStatus(invalid))
  assert.deepEqual(parseStatus('{"phase":"downloading","progress":120,"version":"1.2.3","url":"file:///unsafe"}'), {phase: 'downloading', version: '1.2.3', progress: 100})
  assert.equal(parseStatus('{"phase":"ready","version":"<script>"}').version, undefined)
})
function sparkle(t) {
  const timer = clock()
  const children = []
  const driver = new SparkleDriver({executable: path.resolve('Fixture.app/Contents/MacOS/Fixture'), resources: path.resolve('Fixture.app/Contents/Resources'), ...timer,
    spawnHelper(executable, args) {
      assert.deepEqual(args, [path.resolve('Fixture.app')])
      const child = new EventEmitter()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.commands = []
      child.stdin = new Writable({write(chunk, enc, cb) { child.commands.push(chunk.toString()); cb() }})
      child.kill = () => { child.killed = true }
      children.push(child)
      return child
    },
  })
  const statuses = []
  driver.on('status', (status) => statuses.push(status))
  t.after(() => driver.dispose())
  driver.check()
  return {driver, child: children[0], children, statuses, timer}
}
test('native status framing handles split Unicode/multiple lines; install needs a verified ready event', async (t) => {
  const {driver, child, statuses, timer} = sparkle(t)
  assert.throws(() => driver.install(), /No verified/)
  child.stdout.write('{"phase":"downloa')
  child.stdout.write('ding","progress":50}\n{"phase":"ready","version":"1.2.3"}\n')
  assert.deepEqual(statuses.map((s) => s.phase), ['downloading', 'ready'])
  assert.equal(timer.tasks.size, 0)
  await driver.install()
  assert.deepEqual(child.commands, ['install\n'])
  assert.throws(() => driver.install(), /No verified/)
})
test('stalled, crashed or missing native helper never grants an installation', async (t) => {
  const {driver, child, statuses, timer} = sparkle(t)
  driver.check()
  await timer.run(STALL_MS)
  assert.equal(child.killed, true)
  assert.equal(statuses.at(-1).phase, 'error')
  child.emit('close', 1)
  assert.throws(() => driver.install())
  driver.check()
  assert.equal(driver.child === child, false)
  driver.child.emit('error', new Error('ENOENT'))
  assert.equal(statuses.at(-1).phase, 'error')
})
test('malformed/oversized native output is bounded; stale child events are ignored', (t) => {
  const {driver, child, statuses} = sparkle(t)
  child.stdout.write('x'.repeat(MAX_LINE + 1))
  assert.equal(child.killed, true)
  child.emit('close', 1)
  driver.check()
  child.stdout.write('{"phase":"ready"}\n')
  assert.equal(driver.ready, false)
  assert.equal(statuses.at(-1).phase, 'error')
})
test('quitting while ready closes the channel instead of killing Sparkle installation', (t) => {
  const {driver, child} = sparkle(t)
  child.stdout.write('{"phase":"ready"}\n')
  driver.dispose()
  assert.equal(child.stdin.writableEnded, true)
  assert.notEqual(child.killed, true)
})
test('unexpected native exit after ready discards the staged signal', (t) => {
  const {driver, child, statuses} = sparkle(t)
  child.stdout.write('{"phase":"ready"}\n')
  child.emit('close', 1, null)
  assert.equal(driver.ready, false)
  assert.equal(statuses.at(-1).phase, 'error')
})
test('a manual retry while a failed helper is closing cannot leave the controller checking forever', (t) => {
  const {driver, child, statuses} = sparkle(t)
  child.stdout.write('{"phase":"error","message":"offline"}\n')
  driver.check()
  assert.equal(statuses.at(-1).phase, 'error')
  assert.match(statuses.at(-1).message, /finishing/)
  assert.throws(() => driver.install())
})
test('Windows retains automatic download, installation on ordinary quit, silent install and relaunch', async () => {
  const updater = new EventEmitter()
  let checks = 0, installArguments
  updater.checkForUpdates = async () => {checks++}
  updater.quitAndInstall = (...args) => {installArguments = args}
  const driver = windowsDriver(updater)
  const statuses = []
  driver.on('status', (value) => statuses.push(value))
  assert.equal(updater.autoDownload, true)
  assert.equal(updater.autoInstallOnAppQuit, true)
  assert.equal(updater.allowDowngrade, false)
  await driver.check()
  assert.equal(checks, 1)
  updater.emit('update-available', {version: '1.2.3'})
  updater.emit('download-progress', {percent: 12.5})
  updater.emit('update-downloaded', {version: '1.2.3'})
  assert.deepEqual(statuses.map((s) => s.phase), ['downloading', 'downloading', 'ready'])
  assert.equal(statuses[1].progress, 12)
  driver.install()
  assert.deepEqual(installArguments, [true, true])
  updater.emit('error', new Error('offline'))
  assert.equal(statuses.at(-1).phase, 'error')
  updater.emit('update-not-available')
  assert.equal(statuses.at(-1).phase, 'current')
})

test('Windows consumes the separate automatic download rejection and reports one authoritative error', async () => {
  const updater = new EventEmitter()
  updater.checkForUpdates = async () => ({downloadPromise: Promise.resolve().then(() => {
    const error = new Error('sha512 checksum mismatch')
    updater.emit('error', error)
    throw error
  })})
  const driver = windowsDriver(updater)
  const statuses = []
  driver.on('status', (status) => statuses.push(status))
  await driver.check()
  assert.deepEqual(statuses, [{phase: 'error', message: 'sha512 checksum mismatch'}])
})
