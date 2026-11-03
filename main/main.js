const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const {app, BrowserWindow, dialog, ipcMain, powerMonitor, screen, session, shell, desktopCapturer} = require('electron')
const log = require('./log')
const machine = require('./machine')
const media = require('./media')
const appAudio = require('./app-audio')
const appWindows = require('./app-windows')
const shareSources = require('./share-sources')
const {loadIceServers} = require('./turn')
const diagnostics = require('./diagnostics')
const {createLiveSender} = require('./live')
const context = require('./context')
const updater = require('./updater')
const {focusWindow} = require('./startup')
const {watchZoom, zoomFactor} = require('./zoom')
const IMAGES = require('../shared/images.json')
const {prepareYouTube, registerYouTube, youTubeTitles} = require('./youtube')
const {DownloadFiles} = require('./downloads')
const {downloadName, validFileSize} = require('../shared/downloads')

const MEDIA_EXTENSIONS = [
  'mkv', 'mp4', 'm4v', 'mov', 'avi', 'webm', 'wmv', 'flv', 'ts', 'm2ts', 'mts',
  'mpg', 'mpeg', 'vob', 'ogv', '3gp', 'divx', 'rmvb', 'asf', 'f4v',
  'mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'oga', 'opus', 'wma', 'aiff', 'aif', 'alac', 'ape', 'mka', 'ac3', 'dts',
  ...Object.keys(IMAGES.native), ...IMAGES.convert,
]
const SUBTITLE_EXTENSIONS = ['srt', 'ass', 'ssa', 'vtt']
const downloadStores = new Map()
// Set by screenshare:select (or appwindows:grant) right before the renderer calls
// getDisplayMedia, and read once by the display-media handler below. Only a source this list
// itself just returned, or a window a whole-app share's helper just reported, is ever granted.
let shareSourcesById = new Map()
let pendingShareSource = null
let pendingShareSystemAudio = false
function downloadStore(contents) {
  if (!downloadStores.has(contents.id)) {
    const contentsId = contents.id
    const store = new DownloadFiles()
    downloadStores.set(contentsId, store)
    store.onDestroyed = () => {
      store.dispose().catch(() => {})
      if (downloadStores.get(contentsId) === store) downloadStores.delete(contentsId)
    }
    contents.once('destroyed', store.onDestroyed)
  }
  return downloadStores.get(contents.id)
}

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

// Development telemetry (main/diagnostics.js). Created on first use so registerIpc works without
// start(), as the logging check uses it.
let uploader = null
let liveSender = null
const telemetry = () => (uploader ??= diagnostics.createUploader({
  log,
  settingsFile: path.join(app.getPath('userData'), 'telemetry.json'),
  endpoint: () => diagnostics.loadEndpoint(turnConfigPath()),
  live: (liveSender = createLiveSender({endpoint: () => diagnostics.loadEndpoint(turnConfigPath()), mono: () => performance.now(), record: log.record})),
}))

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
  watchTransportWarnings(win.webContents)
  context.watchWindow({win, record: log.record})
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
  watchZoom(win.webContents)
  return win
}

// Trystero reports discovery failures through console warnings, rather than
// rejected promises. Preserve them in exports even when no peer was found.
function watchTransportWarnings(contents) {
  contents.on('console-message', ({message, level}) => {
    if ((level === 'warning' || level === 'error') && /^Trystero:/.test(message)) {
      log.record('network', 'transport-warning', {message}, level === 'error' ? 'error' : 'warn')
    }
  })
}

async function pickFiles(event, name, extensions, multiple = false) {
  const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
    properties: ['openFile', ...(multiple ? ['multiSelections'] : [])],
    filters: [{name, extensions}, {name: 'All files', extensions: ['*']}],
  })
  return result.canceled ? [] : result.filePaths
}

const pickFile = (event, name, extensions) => pickFiles(event, name, extensions).then((paths) => paths[0] || null)

// Machine load for the diagnostic log (main/machine.js). A window that is in a room gets a reading
// pushed every 2 seconds; nothing is asked of the renderer and nothing waits on it.
const machineSamplers = new Map()
let cpuSpeedLimit = null
let machineStatic = null

const machinePower = {
  isOnBatteryPower: () => powerMonitor.isOnBatteryPower(),
  getCurrentThermalState: () => powerMonitor.getCurrentThermalState(),
  speedLimit: () => cpuSpeedLimit,
}

// Once per room entered, so the facts survive a log file that has rolled over since launch.
async function recordMachineStatic() {
  machineStatic ??= (async () => {
    const info = await Promise.race([app.getGPUInfo('basic'), new Promise((resolve) => setTimeout(resolve, 3000, null))]).catch(() => null)
    return {
      gpu: machine.describeGpu(app.getGPUFeatureStatus(), info),
      displays: machine.describeDisplays(screen.getAllDisplays(), screen.getPrimaryDisplay().id),
      cpu: os.cpus()[0]?.model || null,
    }
  })()
  log.record('machine', 'static', await machineStatic.catch((error) => ({error: error?.message})))
}

function setMachineSampling(contents, active) {
  const existing = machineSamplers.get(contents.id)
  if (!active) {
    existing?.stop()
    machineSamplers.delete(contents.id)
    return
  }
  if (existing) return
  const sampler = machine.createSampler({
    deps: {getMetrics: () => app.getAppMetrics(), systemMemory: () => process.getSystemMemoryInfo(), power: machinePower, edgeRtt: () => liveSender?.edgeRtt() ?? null},
    send: (reading) => { if (!contents.isDestroyed()) contents.send('machine:sample', reading) },
  })
  machineSamplers.set(contents.id, sampler)
  contents.once('destroyed', () => setMachineSampling({id: contents.id}, false))
  sampler.start()
  recordMachineStatic().catch(() => {})
}

function registerIpc() {
  // Our own picker runs in the renderer; this only ever grants a source screenshare:sources
  // just listed and screenshare:select just accepted, never an arbitrary id from the page.
  // 'loopback' only when the renderer actually asked for it. Electron's own Streams.audio doc
  // comment says this is Windows only, but that's stale: Chromium's CoreAudio Tap API backs it
  // on macOS too as of at least Electron 44 (verified directly — a shared window's audio track
  // comes back live, labeled "System audio"). It's whole-system audio either way, not isolated
  // to the shared window's own app. For a specific device instead, the renderer captures it
  // itself via getUserMedia and merges it into the share's stream.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const source = pendingShareSource
    const systemAudio = pendingShareSystemAudio
    pendingShareSource = null
    pendingShareSystemAudio = false
    if (!source) return callback({})
    callback({video: source, ...(systemAudio && {audio: 'loopback'})})
  }, {useSystemPicker: false})
  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('app:open-project', () => shell.openExternal('https://github.com/onlineslav/watch-with-friends'))
  ipcMain.handle('youtube:titles', (_event, ids) => youTubeTitles(ids))
  ipcMain.handle('dialog:media', (event) => pickFile(event, 'Media', MEDIA_EXTENSIONS))
  ipcMain.handle('dialog:media-files', (event) => pickFiles(event, 'Media', MEDIA_EXTENSIONS, true))
  ipcMain.handle('dialog:subtitle', (event) => pickFile(event, 'Subtitles', SUBTITLE_EXTENSIONS))
  ipcMain.handle('download:info', (event, filePath) => downloadStore(event.sender).info(filePath))
  ipcMain.handle('download:open', (event, filePath, size) => downloadStore(event.sender).open(filePath, size))
  ipcMain.handle('download:read', (event, id, offset) => downloadStore(event.sender).read(id, offset))
  ipcMain.handle('download:save', async (event, info) => {
    if (!info || typeof info.name !== 'string' || info.name.length > 200 || !validFileSize(info.size)) throw new Error('Invalid download')
    const store = downloadStore(event.sender)
    const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
      title: 'Download file',
      defaultPath: path.join(app.getPath('downloads'), downloadName(info.name)),
    })
    if (result.canceled || !result.filePath || event.sender.isDestroyed()) return null
    return store.save(result.filePath, info.size)
  })
  ipcMain.handle('download:write', (event, id, offset, bytes) => downloadStore(event.sender).write(id, offset, bytes))
  ipcMain.handle('download:finish', async (event, id) => { await downloadStore(event.sender).finish(id); return true })
  ipcMain.handle('download:cancel', (event, id) => downloadStores.get(event.sender.id)?.cancel(id))
  ipcMain.handle('media:probe', (_event, filePath) => media.probe(filePath))
  ipcMain.handle('media:available-files', async (_event, paths) => {
    if (!Array.isArray(paths) || paths.length > 500) return []
    return Promise.all(paths.map(async (filePath) => {
      if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return false
      try { return (await fs.promises.stat(filePath)).isFile() } catch { return false }
    }))
  })
  ipcMain.handle('media:image', (_event, filePath) => media.readImage(filePath))
  ipcMain.handle('screenshare:sources', async () => {
    // On Windows a helper process lists them: desktopCapturer froze this process for half a
    // second per call (see main/share-sources.js). Its ids are Chromium's own, granted as they are.
    if (shareSources.available()) {
      const sources = await shareSources.list()
      shareSourcesById = new Map(sources.map((source) => [source.id, {id: source.id, name: source.name}]))
      return sources
    }
    const sources = await desktopCapturer.getSources({types: ['screen', 'window'], thumbnailSize: {width: 150, height: 150}})
    shareSourcesById = new Map(sources.map((source) => [source.id, source]))
    return sources.map((source) => ({id: source.id, name: source.name, thumbnail: source.thumbnail.isEmpty() ? null : source.thumbnail.toDataURL()}))
  })
  ipcMain.handle('screenshare:select', (_event, id, options) => {
    pendingShareSource = (typeof id === 'string' && shareSourcesById.get(id)) || null
    pendingShareSystemAudio = Boolean(options?.systemAudio)
    return Boolean(pendingShareSource)
  })
  // A whole-app share: the helper reports every window the shared window's app has open, and the
  // renderer captures each one on its own (appwindows:grant before each getDisplayMedia) and lays
  // them out together. Like screenshare:select, only a source the last listing returned starts
  // one; a plugin window isn't in that listing (desktopCapturer leaves out owned tool windows), so
  // grant accepts a window only while that session's helper reports it as the app's.
  ipcMain.handle('appwindows:start', async (_event, sourceId) => {
    const windowId = typeof sourceId === 'string' && shareSourcesById.has(sourceId) && /^window:(\d+):\d+$/.exec(sourceId)?.[1]
    if (!windowId) throw new Error('That window is no longer available. Try again.')
    try {
      const started = await appWindows.startSession(Number(windowId))
      log.record('appwindows', 'start', {id: started.id, windows: started.layout.windows.length, desktop: started.layout.desktop})
      return started
    } catch (error) {
      log.record('appwindows', 'start-failed', {message: error?.message}, 'error')
      throw error
    }
  })
  ipcMain.handle('appwindows:grant', (_event, id, hwnd) => {
    if (!Number.isSafeInteger(hwnd) || hwnd <= 0 || !appWindows.reports(id, hwnd)) return false
    pendingShareSource = {id: `window:${hwnd}:0`, name: ''}
    pendingShareSystemAudio = false
    return true
  })
  // System audio for a window share, captured on its own: the window may be minimized and so not
  // capturable yet. Rides on a screen from the last listing; the renderer stops its video at once.
  ipcMain.handle('appwindows:system-audio', () => {
    const screen = [...shareSourcesById.values()].find((source) => source.id.startsWith('screen:'))
    if (!screen) return false
    pendingShareSource = screen
    pendingShareSystemAudio = true
    return true
  })
  ipcMain.handle('appwindows:pull', async (_event, id) => {
    const result = await appWindows.pull(id)
    if (result?.error) log.record('appwindows', 'failed', {id, message: result.error}, 'error')
    return result
  })
  ipcMain.handle('appwindows:stop', (_event, id) => {
    log.record('appwindows', 'stop', {id})
    return appWindows.stopSession(id)
  })
  ipcMain.handle('appaudio:start', async (_event, windowId) => {
    if (!Number.isInteger(windowId) || windowId < 0) throw new Error('Invalid window id')
    try {
      const started = await appAudio.startSession(windowId)
      log.record('appaudio', 'start', {windowId, ...started})
      return started
    } catch (error) {
      log.record('appaudio', 'start-failed', {windowId, message: error?.message}, 'error')
      throw error
    }
  })
  ipcMain.handle('appaudio:pull', async (_event, id) => {
    const result = await appAudio.pull(id)
    if (result?.first) log.record('appaudio', 'receiving', {id})
    if (result?.error) log.record('appaudio', 'failed', {id, message: result.error, bytesReceived: result.bytesReceived, exitSignal: result.exitSignal}, 'error')
    else if (result?.done) log.record('appaudio', 'done', {id, bytesReceived: result.bytesReceived})
    return result
  })
  ipcMain.handle('appaudio:stop', (_event, id) => {
    log.record('appaudio', 'stop', {id})
    return appAudio.stopSession(id)
  })
  ipcMain.handle('session:start', async (_event, options) => {
    try {
      const {facts, ...started} = await media.startSession(options)
      log.record('ffmpeg', 'start', {...started, start: options?.start, forceTranscode: options?.forceTranscode})
      if (facts) log.record('media', 'source', facts)
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
  ipcMain.on('app:in-room', (event, inRoom) => {
    updater.setInRoom(inRoom)
    setMachineSampling(event.sender, Boolean(inRoom))
    liveSender?.setFast(Boolean(inRoom)) // the edge round trip is read on the room's 2-second sample
    if (!inRoom) {
      telemetry().upload()
      const store = downloadStores.get(event.sender.id)
      downloadStores.delete(event.sender.id)
      if (store) event.sender.removeListener('destroyed', store.onDestroyed)
      store?.dispose().catch(() => {})
    }
  })
  ipcMain.handle('log:events', (_event, entries) => log.recordBatch(entries))
  ipcMain.handle('telemetry:status', () => telemetry().status())
  ipcMain.handle('telemetry:set', (_event, options) => telemetry().set(options))
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
  ipcMain.handle('update:check', () => updater.getStatus())
  ipcMain.handle('update:retry', () => updater.retry())
}

// This process also moves and repaints the window, so any stretch it spends blocked shows up as
// the window hanging or stuttering. Logged (at most once a second) so a report of stutter comes
// with when and how long, instead of a guess.
const STALL_CHECK_MS = 100
const STALL_LOG_MS = 150
function watchStalls() {
  let expected = performance.now() + STALL_CHECK_MS
  let loggedAt = 0
  setInterval(() => {
    const now = performance.now()
    const late = now - expected
    expected = now + STALL_CHECK_MS
    if (late < STALL_LOG_MS || now - loggedAt < 1000) return
    loggedAt = now
    log.record('app', 'main-stall', {ms: Math.round(late)}, 'warn')
  }, STALL_CHECK_MS).unref()
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
    watchStalls()
    context.watchApp({app, record: log.record})
    context.watchPower({powerMonitor, record: log.record, flush: log.flush})
    powerMonitor.on('speed-limit-change', (details) => { cpuSpeedLimit = Number.isFinite(details?.limit) ? details.limit : null })
    registerYouTube()
    registerIpc()
    telemetry().start()
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
    updater.dispose()
    media.stopAll()
    appAudio.stopAll()
    appWindows.stopAll()
    shareSources.stop()
    log.record('app', 'quit')
    log.stop()
  })
}

module.exports = {createWindow, registerIpc, start, watchTransportWarnings}
