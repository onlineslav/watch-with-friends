// Compare tagged renderers with the same Electron, dependency, network and flow.
// Disposable identities only. --relay-outage uses local discovery that can be
// disabled; otherwise discovery uses public Nostr. WebRTC hosts use loopback.
const assert = require('node:assert/strict')
const {app, BrowserWindow, ipcMain} = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {execFileSync} = require('node:child_process')
const {randomBytes} = require('node:crypto')
const esbuild = require('esbuild')

const root = path.resolve(__dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'connection-regression-'))
const relayOutage = process.argv.includes('--relay-outage')
const refs = process.argv.slice(2).filter(arg => !arg.startsWith('--'))
if (!refs.length) refs.push('v0.3.0', 'v0.4.0')
app.setPath('userData', path.join(temp, 'profile'))
app.on('window-all-closed', () => {})
let blockDiscovery = false
const subscriptions = new Map()
ipcMain.on('probe:subscribe', (event, topic, active) => {
  const topics = subscriptions.get(event.sender) || new Set()
  if (active) topics.add(topic)
  else topics.delete(topic)
  subscriptions.set(event.sender, topics)
})
ipcMain.on('probe:publish', (event, topic, message) => {
  if (blockDiscovery) return
  for (const [contents, topics] of subscriptions) {
    if (contents !== event.sender && !contents.isDestroyed() && topics.has(topic)) contents.send('probe:signal', topic, message)
  }
})
const preload = path.join(temp, 'preload.js')
fs.writeFileSync(preload, fs.readFileSync(path.join(root, 'main/preload.js'), 'utf8') + `
  const subscriptions = new Map();
  ipcRenderer.on('probe:signal', (_event, topic, message) => {
    for (const handler of subscriptions.get(topic) || []) handler(topic, message);
  });
  contextBridge.exposeInMainWorld('__signal', {
    subscribe(topic, handler) {
      if (!subscriptions.has(topic)) subscriptions.set(topic, new Set());
      subscriptions.get(topic).add(handler);
      ipcRenderer.send('probe:subscribe', topic, true);
      return () => {
        subscriptions.get(topic)?.delete(handler);
        if (!subscriptions.get(topic)?.size) ipcRenderer.send('probe:subscribe', topic, false);
      };
    },
    publish: (topic, message) => ipcRenderer.send('probe:publish', topic, message),
  });
`)
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const run = (win, source) => win.webContents.executeJavaScript(source)
const snapshot = (win) => run(win, `({
  friends: __probe.friendNetwork.list().map(f => ({online:f.online, error:f.connectionError})),
  room: __probe.session.connection, peers: __probe.session.peers.size,
  firstNamespace: __probe.joins[0]?.appId,
  joinErrors: __probe.joinErrors, errors: __probe.errors,
  connections: __probe.connections.reduce((counts, pc) => {
    const key = pc.connectionState + '/' + pc.iceGatheringState;
    counts[key] = (counts[key] || 0) + 1; return counts;
  }, {}),
})`)
async function until(windows, condition, label, timeout = 70000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if ((await Promise.all(windows.map(win => run(win, condition)))).every(Boolean)) {
      console.log(`PASS ${label} (${Date.now() - start} ms)`)
      return
    }
    await pause(100)
  }
  console.log(JSON.stringify(await Promise.all(windows.map(snapshot)), null, 2))
  throw new Error(`Timed out: ${label}`)
}

async function bundle(ref, index) {
  const dir = path.join(temp, String(index))
  fs.mkdirSync(dir)
  const read = (file) => ref === 'working' ? fs.readFileSync(path.join(root, file), 'utf8')
    : execFileSync('git', ['show', `${ref}:${file}`], {cwd: root, encoding: 'utf8', windowsHide: true})
  const prefix = `
    window.__probe = {connections: [], joins: [], joinErrors: [], errors: []};
    const NativePeer = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends NativePeer {
      constructor(config) { super(config); __probe.connections.push(this) }
    };
    window.addEventListener('error', e => __probe.errors.push(e.message));
    window.addEventListener('unhandledrejection', e => __probe.errors.push(String(e.reason)));
  `
  const suffix = `
    Object.assign(__probe, {friendNetwork, enterRoom, leaveRoom});
    Object.defineProperties(__probe, {
      identity: {get: () => identity}, session: {get: () => session},
    });
  `
  await esbuild.build({stdin: {contents: read('renderer/app.js') + suffix, resolveDir: path.join(root, 'renderer')},
    banner: {js: prefix}, bundle: true, format: 'iife', target: 'chrome130', outfile: path.join(dir, 'bundle.js'), plugins: [{
      name: 'tagged-renderer', setup(build) {
        build.onLoad({filter: /\.(m?js|json)$/}, ({path: file}) => {
          const relative = path.relative(root, file).replaceAll('\\', '/')
          if (!/^(renderer|shared)\//.test(relative)) return
          return {contents: read(relative), loader: file.endsWith('.json') ? 'json' : 'js'}
        })
        build.onResolve({filter: /^trystero$/}, () => ({path: 'trystero', namespace: 'probe'}))
        build.onLoad({filter: /.*/, namespace: 'probe'}, () => ({resolveDir: root, contents: `
          ${relayOutage ? `
            import {createTopicStrategy, selfId} from '@trystero-p2p/core';
            const join = createTopicStrategy({init: () => [{}], steadyAnnounceIntervalMs: 1000,
              subscribeTopic: (_relay, topic, handler) => window.__signal.subscribe(topic, handler),
              publishTopic: (_relay, topic, message) => window.__signal.publish(topic, message),
            });
          ` : "import {joinRoom as join, selfId} from 'trystero/nostr';"}
          export {selfId};
          export const joinRoom = (config, code, callbacks) => {
            __probe.joins.push({appId: config.appId});
            return join({...config, ${relayOutage ? 'rtcConfig: {iceServers: []}, turnConfig: [],' : ''} _test_only_mdnsHostFallbackToLoopback: true}, code, {...callbacks,
              onJoinError: (error) => { __probe.joinErrors.push(error); callbacks?.onJoinError?.(error) },
            });
          };
        `}))
      },
    }]})
  fs.writeFileSync(path.join(dir, 'index.html'), read('renderer/index.html'))
  fs.writeFileSync(path.join(dir, 'styles.css'), read('renderer/styles.css'))
  return path.join(dir, 'index.html')
}

app.whenReady().then(async () => {
  require('../main/main').registerIpc()
  ipcMain.removeHandler('net:ice-servers')
  ipcMain.handle('net:ice-servers', () => [])
  const results = []
  const cases = refs.flatMap(ref => (relayOutage ? ['friends-first', 'room-first'] : ['normal']).map(flow => ({ref, flow})))
  for (const [index, {ref, flow}] of cases.entries()) {
    const windows = []
    const watchdog = setTimeout(() => { console.error(`Comparison timed out: ${ref}/${flow}`); app.exit(1) }, 180000)
    blockDiscovery = false
    console.log(`Comparing ${ref}/${flow}`)
    try {
      const html = await bundle(ref, index)
      for (const name of ['alpha', 'bravo']) {
        const win = new BrowserWindow({show: false, webPreferences: {partition: `comparison-${index}-${name}`,
          backgroundThrottling: false, preload}})
        win.webContents.setAudioMuted(true)
        windows.push(win)
        win.webContents.on('console-message', d => {
          if (['warning', 'error'].includes(d.level)) console.log(`${ref}/${name}: ${d.message}`)
        })
        await win.loadFile(html)
        await until([win], `__probe.friendNetwork && !document.getElementById('welcome').hidden`, `${ref} welcome`, 10000)
        await run(win, `document.getElementById('handle').value='${name}'; document.getElementById('welcome-name').value='${name}'; document.getElementById('welcome-form').requestSubmit()`)
        await until([win], '__probe.friendNetwork.identity', `${ref} profile`, 10000)
      }
      const code = randomBytes(4).toString('hex').toUpperCase()
      const enter = () => Promise.all(windows.map((win, i) => run(win, `__probe.enterRoom(${JSON.stringify(code)}, {joining:${i !== 0}})`)))
      if (flow === 'room-first') {
        await enter()
        await until(windows, '__probe.session.peers.size === 1', `${ref} room before friends`)
        blockDiscovery = true
      }
      const names = await Promise.all(windows.map(win => run(win, '__probe.identity.username')))
      await Promise.all(windows.map((win, i) => run(win, `__probe.friendNetwork.add(${JSON.stringify(names[1 - i])})`)))
      await until(windows, '__probe.friendNetwork.online.size === 1', `${ref} friends${flow === 'room-first' ? ' during discovery outage' : ''}`, flow === 'room-first' ? 5000 : 70000)
      if (relayOutage) blockDiscovery = true
      if (flow !== 'room-first') {
        await enter()
        await until(windows, '__probe.session.peers.size === 1', `${ref} room${relayOutage ? ' during discovery outage' : ''}`, relayOutage ? 5000 : 70000)
      }
      if (relayOutage) {
        for (const win of windows) assert.equal(await run(win, `(() => {
          const friend = [...__probe.friendNetwork.online.values()][0];
          return friend.link.room.getPeers()[friend.peerId] === __probe.session.room.getPeers()[friend.peerId];
        })()`), true, 'Room and friend presence must use the same established connection')
        await Promise.all(windows.map(win => run(win, '__probe.leaveRoom()')))
        await enter()
        await until(windows, '__probe.session.peers.size === 1 && __probe.friendNetwork.online.size === 1', `${ref} rejoin during discovery outage`, 5000)
        for (const win of windows) assert.deepEqual(await run(win, '__probe.errors'), [])
        results.push({ref, flow, passed: true})
        continue
      }
      await Promise.all(windows.map(win => run(win, '__probe.leaveRoom()')))
      await Promise.all(windows.map(win => win.loadFile(html)))
      await until(windows, '__probe.identity && __probe.friendNetwork.identity', `${ref} saved profiles`, 10000)
      await enter()
      await until(windows, '__probe.friendNetwork.online.size === 1 && __probe.session.peers.size === 1', `${ref} simultaneous restart and join`)
      console.log(JSON.stringify(await Promise.all(windows.map(snapshot)), null, 2))
      results.push({ref, flow, passed: true})
    } catch (error) {
      console.log(String(error))
      results.push({ref, flow, passed: false, error: error.message})
    } finally {
      clearTimeout(watchdog)
      for (const win of windows) win.destroy()
    }
  }
  console.log(JSON.stringify(results))
  app.exit(results.every(r => r.passed) ? 0 : 1)
}).catch(error => { console.error(error); app.exit(1) })
