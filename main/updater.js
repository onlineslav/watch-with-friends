const {app, BrowserWindow, powerMonitor} = require('electron')
const {windowsDriver} = require('./windows-updater')
const {UpdateController} = require('./update-controller')
const {SparkleDriver} = require('./sparkle')
const log = require('./log')
let controller = null
let inRoom = false

function checkForUpdates() {
  if (controller || !app.isPackaged || !['win32', 'darwin'].includes(process.platform)) return
  const driver = process.platform === 'darwin'
    ? new SparkleDriver({executable: app.getPath('exe'), resources: process.resourcesPath})
    : windowsDriver(require('electron-updater').autoUpdater)
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
