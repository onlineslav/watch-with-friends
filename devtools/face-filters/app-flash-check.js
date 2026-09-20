// The YouTube picture flashes in the real app since the player became a <webview>, with no filter
// running. `flash-check.js` puts a real video in a real webview on a bare page and measures nothing
// wrong, so whatever causes it belongs to the app's own page, not to the swap on its own.
//
// This runs the real renderer — real index.html, real styles, real room logic — in one visible
// window, plays a YouTube video through the app's own URL form, and samples the window 20 times a
// second. A blink shows as a trough in the sparkline.
//
//   node scripts/electron.js devtools/face-filters/app-flash-check.js [--seconds=10]
//
// The window has to be visible and uncovered: a flash is a compositing artifact and a window that
// is not being shown does not composite.
const {app, BrowserWindow, ipcMain, webContents} = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {pathToFileURL} = require('node:url')
const esbuild = require('esbuild')
const {prepareYouTube, registerYouTube, guardWebviews} = require('../../main/youtube')

prepareYouTube()
const root = path.resolve(__dirname, '../..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'svp-app-flash-'))
app.setPath('userData', path.join(temporary, 'profile'))
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

const say = (line = '') => fs.writeSync(1, `${line}\n`)
const arg = (name, fallback) => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`))
  return found ? Number(found.slice(name.length + 3)) : fallback
}
const SECONDS = arg('seconds', 10)
const HZ = 20
const VIDEO = 'https://www.youtube.com/watch?v=M7lc1UVf-VE'

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const run = (win, source) => win.webContents.executeJavaScript(source)
async function until(win, condition, timeoutMs = 45000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await run(win, condition)) return
    await pause(100)
  }
  throw new Error(`Timed out: ${condition}`)
}

// The room layer needs a discovery transport. Nothing else joins, so it only has to exist.
function scaffold() {
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
  const source = fs.readFileSync(path.join(root, 'renderer/app.js'), 'utf8') + `
    window.__test = {get session() { return session }, enterRoom, youtube, errors: [],
      rect: () => { const r = document.getElementById('youtube-player').getBoundingClientRect(); return {x: r.x, y: r.y, width: r.width, height: r.height} }};
    window.addEventListener('error', (e) => __test.errors.push(e.message));
    window.addEventListener('unhandledrejection', (e) => __test.errors.push(String(e.reason)));
  `
  return esbuild.build({stdin: {contents: source, resolveDir: path.join(root, 'renderer')}, bundle: true, format: 'iife',
    target: 'chrome130', outfile: path.join(temporary, 'bundle.js'), plugins: [{
      name: 'local-discovery', setup(build) {
        build.onResolve({filter: /^trystero$/}, () => ({path: 'trystero', namespace: 'local'}))
        build.onLoad({filter: /.*/, namespace: 'local'}, () => ({resolveDir: root, contents: `
          import {createTopicStrategy, selfId} from './node_modules/@trystero-p2p/core/dist/index.mjs';
          const join = createTopicStrategy({
            init: () => [{}], steadyAnnounceIntervalMs: 1000,
            subscribeTopic: (_relay, topic, handler) => window.__signal.subscribe(topic, handler),
            publishTopic: (_relay, topic, message) => window.__signal.publish(topic, message),
          });
          export {selfId};
          export const joinRoom = (config, code, callbacks) => join({...config, rtcConfig: {iceServers: []}, turnConfig: []}, code, callbacks);
        `}))
      },
    }]}).then(() => {
    const html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8')
      .replace('href="styles.css"', `href="${pathToFileURL(path.join(root, 'renderer/styles.css'))}"`)
    fs.writeFileSync(path.join(temporary, 'index.html'), html)
  })
}

// Mean brightness of the middle of the player, which is where a playing video always has something.
// The YouTube controls and the app's own bars are deliberately outside this box.
function brightness(image, box) {
  const {width, height} = image.getSize()
  if (!width || !height) return 0
  const bitmap = image.toBitmap()
  const scale = width / box.pageWidth
  const left = Math.max(0, ((box.x + box.width * 0.3) * scale) | 0)
  const right = Math.min(width, ((box.x + box.width * 0.7) * scale) | 0)
  const top = Math.max(0, ((box.y + box.height * 0.3) * scale) | 0)
  const bottom = Math.min(height, ((box.y + box.height * 0.7) * scale) | 0)
  let total = 0
  let counted = 0
  for (let y = top; y < bottom; y += 4) {
    for (let x = left; x < right; x += 4) {
      const at = (y * width + x) * 4
      total += bitmap[at] + bitmap[at + 1] + bitmap[at + 2]
      counted++
    }
  }
  return counted ? total / (counted * 3) : 0
}

const BARS = '_.:-=+*#%@'
const spark = (values, peak) => values.map((v) => BARS[Math.min(BARS.length - 1, Math.round((v / (peak || 1)) * (BARS.length - 1)))]).join('')

app.whenReady().then(async () => {
  await scaffold()
  require('../../main/main').registerIpc()
  ipcMain.removeHandler('net:ice-servers')
  ipcMain.handle('net:ice-servers', () => [])
  const win = new BrowserWindow({show: true, width: 1280, height: 780, backgroundColor: '#0b0b0f',
    webPreferences: {preload: path.join(temporary, 'preload.js'), backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required', webviewTag: true}})
  win.webContents.setAudioMuted(true)
  guardWebviews(win.webContents)
  registerYouTube(win.webContents.session)
  win.webContents.on('console-message', (details) => {
    if (details.level === 'error') say(`  console: ${details.message}`)
  })
  try {
    await win.loadFile(path.join(temporary, 'index.html'))
    await until(win, 'window.__test && !document.getElementById("welcome").hidden')
    await run(win, `document.getElementById('handle').value='flash'; document.getElementById('welcome-name').value='flash'; document.getElementById('welcome-form').dispatchEvent(new Event('submit', {cancelable:true}));`)
    await until(win, '__test.session && !document.getElementById("home").hidden')
    await run(win, '__test.enterRoom("ABCDEFGH", {joining:false})')
    await run(win, `document.getElementById('media-url').value = ${JSON.stringify(VIDEO)}; document.getElementById('media-url-form').requestSubmit()`)
    await until(win, '__test.youtube.loaded && __test.youtube.duration > 0')
    await run(win, '__test.youtube.play()')
    await until(win, '__test.youtube.playing && __test.youtube.time > 1')

    const box = await run(win, '({...__test.rect(), pageWidth: innerWidth})')
    say(`playing in the real app, player at ${Math.round(box.width)}x${Math.round(box.height)}, sampling ${SECONDS}s at ${HZ}Hz`)
    say('')

    const guestId = await run(win, '__test.youtube.guestId')
    const guest = guestId ? webContents.fromId(guestId) : null
    const fromWindow = []
    const fromGuest = []
    const states = []
    for (let i = 0; i < SECONDS * HZ; i++) {
      const started = Date.now()
      fromWindow.push(brightness(await win.webContents.capturePage(), box))
      if (guest) fromGuest.push(brightness(await guest.capturePage(), {...box, x: 0, y: 0, pageWidth: box.width}))
      states.push(await run(win, '__test.youtube.state'))
      await pause(Math.max(0, 1000 / HZ - (Date.now() - started)))
    }

    const report = (label, values) => {
      if (!values.length) return
      const peak = Math.max(...values)
      const dark = values.filter((v) => v < peak * 0.25).length
      say(`${label.padEnd(8)} ${spark(values, peak)}`)
      say(`${''.padEnd(8)} peak ${peak.toFixed(0)}, ${dark} of ${values.length} samples below a quarter of it`)
    }
    report('window', fromWindow)
    report('guest', fromGuest)
    say(`state    ${states.map((s) => (s === null ? '?' : String(s).replace('-1', 'b'))).join('')}   (1 playing, 2 paused, 3 buffering, b starting)`)
    const errors = await run(win, '__test.errors')
    if (errors.length) say(`\nrenderer errors: ${JSON.stringify(errors.slice(0, 5))}`)
    say('')
    say('A trough in `window` while `guest` stays level is a compositing flash. Both dropping')
    say('together is the player really going blank, and `state` says whether it rebuffered.')
  } catch (error) {
    say(`FAILED: ${error.stack || error}`)
    win.destroy()
    app.exit(1)
    return
  }
  win.destroy()
  app.exit(0)
})
