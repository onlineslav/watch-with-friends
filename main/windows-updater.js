const {EventEmitter} = require('node:events')

// NSIS remains the Windows installer. Only the restart gate is shared with Mac.
function windowsDriver(updater) {
  const driver = new EventEmitter()
  updater.autoDownload = true
  updater.autoInstallOnAppQuit = true
  updater.allowDowngrade = false
  let version
  updater.on('update-available', (info) => {
    version = info.version
    driver.emit('status', {phase: 'downloading', version, progress: 0})
  })
  updater.on('download-progress', (info) => driver.emit('status', {phase: 'downloading', version, progress: Math.floor(info.percent)}))
  updater.on('update-downloaded', (info) => driver.emit('status', {phase: 'ready', version: info.version}))
  updater.on('update-not-available', () => driver.emit('status', {phase: 'current'}))
  updater.on('error', (error) => driver.emit('status', {phase: 'error', message: error.message}))
  driver.check = () => updater.checkForUpdates().catch(() => {}) // error event is authoritative
  driver.install = () => updater.quitAndInstall(true, true)
  return driver
}
module.exports = {windowsDriver}
