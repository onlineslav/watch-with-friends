const {app, BrowserWindow, powerMonitor} = require('electron')
const {EventEmitter} = require('node:events')
const {UpdateController} = require('./update-controller')
const {SparkleDriver} = require('./sparkle')
const log = require('./log')
let controller = null
let inRoom = false

function windowsDriver() {
  const updater = require('electron-updater').autoUpdater
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
function checkForUpdates() {
  if (controller || !app.isPackaged || !['win32', 'darwin'].includes(process.platform)) return
  const driver = process.platform === 'darwin'
    ? new SparkleDriver({executable: app.getPath('exe'), resources: process.resourcesPath})
    : windowsDriver()
  controller = new UpdateController(driver, {record: log.record})
  controller.setInRoom(inRoom)
  controller.on('status', (status) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.webContents.isDestroyed()) win.webContents.send('update:status', status)
    }
  })
  controller.start()
  powerMonitor.on('resume', () => controller.check())
}
function setInRoom(value) {
  inRoom = Boolean(value)
  controller?.setInRoom(inRoom)
}
const getStatus = () => controller?.snapshot() || null
const retry = () => controller?.check() || null
const dispose = () => controller?.dispose()
module.exports = {checkForUpdates, getStatus, retry, setInRoom, dispose}
