// `npm run test:compat`: does this build still talk to an older copy of the app, in both directions?
//
// One window runs the renderer of an earlier release (default v0.8.0, extracted with the transport it
// shipped with by scripts/old-tree.js), the other this tree's. They meet over real WebRTC through local
// discovery, like check-network.js and the bench, with every window muted and the output feeding a
// zero-gain tap (nothing is audible). For each direction (old host -> new viewer, new host -> old viewer):
//
//   film       the host opens a clip; the viewer must receive picture and sound. A NEW viewer must decode
//              it in stereo: that is the M1.6 fix (the old viewer's SDP made its decoder mono), and the
//              old host sends stereo already, so it works against a copy that was never fixed.
//   republish  the host publishes its film again, twice (a new audio section each time); sound goes on
//              arriving, in stereo for a new viewer.
//   glare      the host publishes again at the very moment the viewer starts a share: both ends renegotiate
//              at once. Both connections must settle to "stable", no page may log an error, and the share
//              must reach the host.
//
// The first run downloads the 0.25.4 transport once (npm pack) into work/compat. No sockets other than
// loopback, no public relays.
//
//   npm run test:compat                      against v0.8.0
//   npm run test:compat -- --tag=v0.8.1
const {app, BrowserWindow, ipcMain} = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {pathToFileURL} = require('node:url')
const {execFileSync} = require('node:child_process')
const esbuild = require('esbuild')
const lib = require('./bench-lib')
const {benchHooks} = require('./bench-hooks')
const {prepare} = require('./old-tree')

const root = path.resolve(__dirname, '..')
const tagArg = process.argv.find((arg) => arg.startsWith('--tag='))
const tag = tagArg ? tagArg.split('=')[1] : 'v0.8.0'

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'synced-compat-'))
app.setPath('userData', path.join(temporary, 'profile'))
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.on('window-all-closed', () => {})

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const run = (win, source) => win.webContents.executeJavaScript(source).catch((error) => { throw new Error(`${error.message}\nExecuting: ${source.slice(0, 300)}`) })
async function until(win, condition, timeoutMs = 30000, label = condition) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await run(win, condition)) return
    await pause(100)
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`)
}

// The page's own app.js plus the test hooks every window needs, bundled for one tree. Names used here
// all exist in the older release: the hooks are plain reads of its module state.
async function bundleFor(treeRoot, name) {
  const dir = path.join(temporary, name)
  fs.mkdirSync(dir, {recursive: true})
  let source = fs.readFileSync(path.join(treeRoot, 'renderer/app.js'), 'utf8')
  const windowsShare = "const APP_WINDOWS = window.api.platform === 'win32'"
  assert.ok(source.includes(windowsShare), `${name}: app.js declares APP_WINDOWS the way the harness expects`)
  source = source.replace(windowsShare, 'const APP_WINDOWS = false')
  source += `
    window.__test = {
      get session() { return session }, friendNetwork, enterRoom, leaveRoom, hostFile, startShare, stopShare, shareSettings, tileViews, control, publishStream, selfId, errors: [],
    };
    window.addEventListener('error', (e) => __test.errors.push(e.message));
    window.addEventListener('unhandledrejection', (e) => __test.errors.push(String(e.reason)));
    (${benchHooks.toString()})();
  `
  await esbuild.build({stdin: {contents: source, resolveDir: path.join(treeRoot, 'renderer')}, bundle: true, format: 'iife', target: 'chrome130', outfile: path.join(dir, 'bundle.js'), plugins: [{
    name: 'local-discovery', setup(build) {
      build.onResolve({filter: /^trystero$/}, () => ({path: 'trystero', namespace: 'local'}))
      build.onLoad({filter: /.*/, namespace: 'local'}, () => ({resolveDir: treeRoot, contents: `
        import {createTopicStrategy, selfId} from './node_modules/@trystero-p2p/core/dist/index.mjs';
        const join = createTopicStrategy({
          init: () => [{}], steadyAnnounceIntervalMs: 1000,
          subscribeTopic: (_relay, topic, handler) => window.__signal.subscribe(topic, handler),
          publishTopic: (_relay, topic, message) => window.__signal.publish(topic, message),
        });
        export {selfId};
        export const joinRoom = (config, code, callbacks) => join({...config,
          rtcConfig: {iceServers: []}, turnConfig: [], _test_only_mdnsHostFallbackToLoopback: true,
        }, code, callbacks);
      `}))
    },
  }]})
  const html = fs.readFileSync(path.join(treeRoot, 'renderer/index.html'), 'utf8')
    .replace('href="styles.css"', `href="${pathToFileURL(path.join(treeRoot, 'renderer/styles.css'))}"`)
  fs.writeFileSync(path.join(dir, 'index.html'), html)
  fs.copyFileSync(path.join(__dirname, 'bench-tap.js'), path.join(dir, 'bench-tap.js'))
  return dir
}

async function fixtures(oldRoot) {
  const subscriptions = new Map()
  ipcMain.on('test:subscribe', (event, topic, active) => {
    const topics = subscriptions.get(event.sender) || new Set()
    if (active) topics.add(topic)
    else topics.delete(topic)
    subscriptions.set(event.sender, topics)
  })
  ipcMain.on('test:publish', (event, topic, message) => {
    for (const [contents, topics] of subscriptions) {
      if (contents !== event.sender && !contents.isDestroyed() && topics.has(topic)) contents.send('test:signal', topic, message)
    }
  })
  fs.writeFileSync(path.join(temporary, 'preload.js'), fs.readFileSync(path.join(root, 'main/preload.js'), 'utf8') + `
    const subscriptions = new Map();
    ipcRenderer.on('test:signal', (_event, topic, message) => {
      for (const handler of subscriptions.get(topic) || []) handler(topic, message);
    });
    contextBridge.exposeInMainWorld('__signal', {
      subscribe(topic, handler) {
        if (!subscriptions.has(topic)) subscriptions.set(topic, new Set());
        subscriptions.get(topic).add(handler);
        ipcRenderer.send('test:subscribe', topic, true);
        return () => {
          subscriptions.get(topic)?.delete(handler);
          if (!subscriptions.get(topic)?.size) ipcRenderer.send('test:subscribe', topic, false);
        };
      },
      publish: (topic, message) => ipcRenderer.send('test:publish', topic, message),
    });
  `)
  const dirs = {new: await bundleFor(root, 'new'), old: await bundleFor(oldRoot, 'old')}
  const schedule = lib.makeSchedule({seed: 1, count: 24, first: 3, minGap: 2, maxGap: 2.6})
  const clip = path.join(temporary, 'compat-clip.mkv')
  execFileSync(require('ffmpeg-static'), lib.clipArgs(schedule, clip), {windowsHide: true, timeout: 120000})
  return {dirs, clip, schedule}
}

async function openWindow(env, name, side) {
  const win = new BrowserWindow({show: false, width: 1280, height: 720, webPreferences: {partition: `compat-${side}-${name}`, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required', preload: path.join(temporary, 'preload.js')}})
  win.webContents.setAudioMuted(true)
  assert.equal(win.webContents.isAudioMuted(), true)
  win.webContents.on('console-message', (details) => { if (details.level === 'error') console.error(`${name}(${side}): ${details.message}`) })
  await win.loadFile(path.join(env.dirs[side], 'index.html'))
  await until(win, 'window.__test && !document.getElementById("welcome").hidden', 30000, `${name} welcome screen`)
  await run(win, `document.getElementById('handle').value=${JSON.stringify(name)}; document.getElementById('welcome-name').value=${JSON.stringify(name)}; document.getElementById('welcome-form').dispatchEvent(new Event('submit', {cancelable:true}));`)
  await until(win, '__test.friendNetwork.identity && !document.getElementById("home").hidden', 30000, `${name} home`)
  win.setBounds({x: -20000, y: -20000, width: 1280, height: 720})
  win.showInactive()
  return win
}

const separation = (stereo) => lib.round(stereo.side / Math.max(1e-12, stereo.side + stereo.mid), 3)
const audible = (stereo) => stereo.mid + stereo.side > 1 // silence reads exactly 0

// Restart the tap's reading, wait, then read what arrived meanwhile.
async function listen(win, ms = 4500) {
  await run(win, '__bench.collect().then(() => true)')
  await pause(ms)
  const data = JSON.parse(await run(win, '__bench.collect().then(JSON.stringify)'))
  return {stereo: data.stereo, separation: separation(data.stereo), audible: audible(data.stereo)}
}

const signalingStates = (win) => run(win, 'Object.values(__test.session.room.getPeers()).map((pc) => pc.signalingState)')

async function direction(env, hostSide, viewerSide, index) {
  const label = `${hostSide} host -> ${viewerSide} viewer`
  const host = await openWindow(env, `host${index}`, hostSide)
  const viewer = await openWindow(env, `viewer${index}`, viewerSide)
  const checks = []
  try {
    const code = `COMPAT${index}`.padEnd(8, 'X').slice(0, 8)
    await run(host, `__test.enterRoom(${JSON.stringify(code)}, {joining:false})`)
    await run(viewer, `__test.enterRoom(${JSON.stringify(code)})`)
    await until(host, '__test.session.peers.size === 1', 30000, 'host sees the viewer')
    await until(viewer, '__test.session.peers.size === 1', 30000, 'viewer sees the host')
    await Promise.all([run(host, '__bench.installTap()'), run(viewer, '__bench.installTap()')])
    const frames = () => run(viewer, 'document.getElementById("remote-video").getVideoPlaybackQuality().totalVideoFrames')
    const nextPicture = async (what) => {
      const before = await frames()
      return () => until(viewer, `document.getElementById("remote-video").getVideoPlaybackQuality().totalVideoFrames > ${before + 40}`, 45000, `picture after ${what}`)
    }
    const expectSound = (what, heard) => {
      assert.ok(heard.audible, `${label}: ${what}: the viewer heard nothing`)
      if (viewerSide === 'new') assert.ok(heard.separation >= 0.4, `${label}: ${what}: a new viewer decodes stereo (separation ${heard.separation})`)
      checks.push(`${what}: sound arrived${viewerSide === 'new' ? `, stereo (separation ${heard.separation})` : ` (separation ${heard.separation}, a copy from before the fix decodes mono)`}`)
    }

    // film
    const filmPicture = await nextPicture('the film')
    await run(host, `__test.hostFile(${JSON.stringify(env.clip)})`)
    await filmPicture()
    await pause(2000)
    expectSound('film', await listen(viewer))

    // republish, twice
    for (const n of [1, 2]) {
      const picture = await nextPicture(`republish ${n}`)
      await run(host, '__test.publishStream(); true')
      await picture()
      await pause(2500)
      expectSound(`republish ${n}`, await listen(viewer))
    }

    // glare: the host publishes again as the viewer starts a share
    await run(viewer, '__bench.installWindow({fps: 30, flashFrames: 3, events: []}); __test.shareSettings.audioDeviceId = "none"; true')
    const viewerId = await run(viewer, '__test.selfId')
    const started = Date.now()
    await Promise.all([
      run(host, '__test.publishStream(); true'),
      run(viewer, "__test.startShare({id: 'window:4242:0', name: 'Compat window'}); true"),
    ])
    await until(host, `__test.tileViews.has(${JSON.stringify(viewerId)}) && __test.tileViews.get(${JSON.stringify(viewerId)}).video.readyState >= 3`, 30000, 'the share reaches the host')
    const settled = Date.now() - started
    await pause(3000)
    for (const win of [host, viewer]) {
      assert.deepEqual([...new Set(await signalingStates(win))], ['stable'], `${label}: glare: every connection is stable afterwards`)
    }
    const errors = [...await run(host, '__test.errors'), ...await run(viewer, '__test.errors')]
    assert.deepEqual(errors, [], `${label}: no page errors`)
    checks.push(`glare: the share reached the host in ${settled}ms, both connections stable, no page errors`)
    return checks
  } finally {
    require('../main/media').stopAll()
    host.destroy()
    viewer.destroy()
  }
}

app.whenReady().then(async () => {
  const watchdog = setTimeout(() => { console.error('Compatibility check timed out'); app.exit(1) }, 8 * 60 * 1000)
  let exitCode = 0
  try {
    const oldRoot = prepare(tag)
    const env = await fixtures(oldRoot)
    require('../main/main').registerIpc()
    ipcMain.removeHandler('net:ice-servers')
    ipcMain.handle('net:ice-servers', () => [])
    ipcMain.removeHandler('screenshare:select')
    ipcMain.handle('screenshare:select', () => true)
    console.log(`Compatibility check against ${tag}: every window muted and off-screen; nothing is played aloud.`)
    let index = 0
    for (const [hostSide, viewerSide] of [['old', 'new'], ['new', 'old']]) {
      const checks = await direction(env, hostSide, viewerSide, ++index)
      for (const line of checks) console.log(`PASS: ${hostSide} host -> ${viewerSide} viewer, ${line}`)
      await pause(2000)
    }
  } catch (error) {
    console.error(error)
    exitCode = 1
  } finally {
    clearTimeout(watchdog)
    require('../main/app-audio').stopAll()
    require('../main/media').stopAll()
    try { fs.rmSync(temporary, {recursive: true, force: true, maxRetries: 3}) } catch {}
  }
  app.exit(exitCode)
})
