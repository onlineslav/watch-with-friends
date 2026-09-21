const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const {app, BrowserWindow, dialog, ipcMain, shell} = require('electron')
const log = require('./log')
const media = require('./media')
const {loadIceServers} = require('./turn')
const updater = require('./updater')
const {focusWindow} = require('./startup')
const {watchZoom, zoomFactor} = require('./zoom')
const IMAGES = require('../shared/images.json')
const {prepareYouTube, registerYouTube, youTubeTitles} = require('./youtube')

const MEDIA_EXTENSIONS = [
  'mkv', 'mp4', 'm4v', 'mov', 'avi', 'webm', 'wmv', 'flv', 'ts', 'm2ts', 'mts',
  'mpg', 'mpeg', 'vob', 'ogv', '3gp', 'divx', 'rmvb', 'asf', 'f4v',
  'mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'oga', 'opus', 'wma', 'aiff', 'aif', 'alac', 'ape', 'mka', 'ac3', 'dts',
  ...Object.keys(IMAGES.native), ...IMAGES.convert,
]
const SUBTITLE_EXTENSIONS = ['srt', 'ass', 'ssa', 'vtt']

// Written at the top of every log file and repeated in an export, because the first question
// about any of this is which build, on what, and whether it was a packaged app or a dev run.
const systemInfo = () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  platform: `${process.platform} ${os.release()}`,
  arch: process.arch,
  cpus: os.cpus().length,
  memoryGb: Math.round(os.totalmem() / 1e9),
  packaged: app.isPackaged,
})

const turnConfigPath = () =>
  app.isPackaged ? path.join(process.resourcesPath, 'turn.json') : path.join(__dirname, '..', 'config', 'turn.json')

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 780,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#0b0b0f',
    title: 'Watch With Friends',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // The host keeps streaming while its window is minimized or behind other windows.
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  })
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
  watchZoom(win.webContents)
  return win
}

async function pickFiles(event, name, extensions, multiple = false) {
  const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
    properties: ['openFile', ...(multiple ? ['multiSelections'] : [])],
    filters: [{name, extensions}, {name: 'All files', extensions: ['*']}],
  })
  return result.canceled ? [] : result.filePaths
}

const pickFile = (event, name, extensions) => pickFiles(event, name, extensions).then((paths) => paths[0] || null)

function registerIpc() {
  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('app:open-project', () => shell.openExternal('https://github.com/onlineslav/watch-with-friends'))
  ipcMain.handle('youtube:titles', (_event, ids) => youTubeTitles(ids))
  ipcMain.handle('dialog:media', (event) => pickFile(event, 'Media', MEDIA_EXTENSIONS))
  ipcMain.handle('dialog:media-files', (event) => pickFiles(event, 'Media', MEDIA_EXTENSIONS, true))
  ipcMain.handle('dialog:subtitle', (event) => pickFile(event, 'Subtitles', SUBTITLE_EXTENSIONS))
  ipcMain.handle('media:probe', (_event, filePath) => media.probe(filePath))
  ipcMain.handle('media:available-files', async (_event, paths) => {
    if (!Array.isArray(paths) || paths.length > 500) return []
    return Promise.all(paths.map(async (filePath) => {
      if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return false
      try { return (await fs.promises.stat(filePath)).isFile() } catch { return false }
    }))
  })
  ipcMain.handle('media:image', (_event, filePath) => media.readImage(filePath))
  ipcMain.handle('session:start', async (_event, options) => {
    try {
      const started = await media.startSession(options)
      log.record('ffmpeg', 'start', {...started, start: options?.start, forceTranscode: options?.forceTranscode})
      return started
    } catch (error) {
      log.record('ffmpeg', 'start-failed', {message: error?.message, start: options?.start}, 'error')
      throw error
    }
  })
  ipcMain.handle('session:pull', async (_event, id) => {
    const result = await media.pull(id)
    if (result?.error) log.record('ffmpeg', 'failed', {id, message: result.error}, 'error')
    else if (result?.done) log.record('ffmpeg', 'done', {id})
    return result
  })
  ipcMain.handle('session:stop', (_event, id) => {
    log.record('ffmpeg', 'stop', {id})
    return media.stopSession(id)
  })
  ipcMain.handle('subtitle:cues', (_event, options) => media.subtitleCues(options))
  ipcMain.handle('net:ice-servers', () => {
    const local = path.join(app.getPath('userData'), 'turn.json')
    return fs.existsSync(local) ? loadIceServers(local) : loadIceServers(turnConfigPath(), {publicOnly: app.isPackaged})
  })
  ipcMain.handle('window:zoom', (event, factor) => {
    const contents = event.sender
    contents.setZoomFactor(zoomFactor(factor))
    return contents.getZoomFactor()
  })
  ipcMain.handle('window:pin', (event, pinned) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win.setAlwaysOnTop(Boolean(pinned), 'floating')
    return win.isAlwaysOnTop()
  })
  ipcMain.on('app:in-room', (_event, inRoom) => updater.setInRoom(inRoom))
  ipcMain.handle('log:events', (_event, entries) => log.recordBatch(entries))
  ipcMain.handle('log:save', async (event, {note} = {}) => {
    const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
      title: 'Save diagnostics',
      defaultPath: path.join(app.getPath('desktop'), log.defaultExportName()),
      filters: [{name: 'Log', extensions: ['log']}],
    })
    if (result.canceled || !result.filePath) return null
    log.record('log', 'export', {note: Boolean(note)})
    const saved = log.exportTo(result.filePath, {note})
    shell.showItemInFolder(saved)
    return saved
  })
  ipcMain.handle('update:check', () => updater.checkMacUpdate())
  ipcMain.handle('update:open', (_event, which) => updater.openMacUpdate(which))
}

function start() {
  // Main-process faults otherwise leave nothing behind but a closed window. Registered before
  // anything else runs; log.record buffers until whenReady opens the file.
  const trace = (error) => String(error?.stack || '').split('\n').slice(0, 6).join(' | ') || null
  process.on('uncaughtException', (error) => log.record('error', 'main-uncaught', {message: error?.message, stack: trace(error)}, 'error'))
  process.on('unhandledRejection', (reason) => log.record('error', 'main-rejection', {message: String(reason?.message || reason), stack: trace(reason)}, 'error'))
  prepareYouTube()
  app.on('second-instance', () => focusWindow(BrowserWindow.getAllWindows()[0]))
  app.whenReady().then(() => {
    // app.getPath('logs') is only meaningful once the app name is settled, so the file opens here.
    log.start({dir: app.getPath('logs'), info: systemInfo()})
    registerYouTube()
    registerIpc()
    createWindow()
    // warm up so the first transcode starts instantly, and record which encoder this machine got
    media.detectCapabilities().then(
      (caps) => log.record('media', 'capabilities', caps),
      (error) => log.record('media', 'capabilities-failed', {message: error?.message}, 'warn'),
    )
    updater.checkForUpdates()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', () => {
    media.stopAll()
    log.record('app', 'quit')
    log.stop()
  })
}

module.exports = {createWindow, registerIpc, start}
