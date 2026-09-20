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
const {prepareVision, registerVision} = require('../../main/vision')

prepareYouTube()
// Order matters: registering vision first makes its corsEnabled privilege not stick.
prepareVision()
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
// --filter=chad turns a face filter on, which is what starts the 15Hz capturePage loop over the
// player. Without it nothing reads the picture back at all.
const FILTER = (process.argv.find((a) => a.startsWith('--filter=')) || '').slice(9)
// --clip serves the user's own sample clip in place of YouTube's page, through the same webview,
// the same capture loop and the same warp. It is the only way to run this path with real faces in
// it: the stock test video has none, so MediaPipe finds nothing and the warp never draws.
const CLIP = process.env.SVP_CLIP || path.join(os.tmpdir(), 'claude', 'c--Software-Development-synced-video-player',
  '91fc36aa-0928-4663-8270-7da07f2ae2ca', 'scratchpad', 'clip.mp4')
const USE_CLIP = process.argv.includes('--clip')
// --watch reads nothing and measures nothing. capturePage() forces the compositor to produce a
// fresh frame, so it returns a good one while the screen shows the flash — it is blind to exactly
// the artifact it may be causing. That makes the person at the window the only working instrument,
// and this mode's job is to tell them which phase they are looking at. The phases separate the app
// from the observation: nothing reading the picture, the harness reading it, a filter reading it.
const WATCH = process.argv.includes('--watch')
// --cost measures what reading the picture costs the *guest*, which is the thing the round-trip
// timing and the embedder's frame rate both miss. Neither noticed a picture that was plainly not
// realtime to watch, because both measure this process and the embedder page rather than the
// surface the video is actually drawn on.
const COST = process.argv.includes('--cost')

// Speaks the player's own protocol — the attach handshake, `ready`, and a state report every 250ms
// — so the app drives it exactly as it drives YouTube.
const CLIP_PAGE = `<!doctype html><html><head><style>
  html, body { margin: 0; height: 100%; background: #000; }
  video { width: 100%; height: 100%; object-fit: contain; }
</style></head><body><video id="v" src="clip.mp4" muted playsinline loop></video><script>
  let host = parent === window ? null : parent
  let token = null
  const video = document.getElementById('v')
  const send = (type, value) => { if (host) host.postMessage({channel: 'svp-youtube', token, type, value}, '*') }
  window.addEventListener('message', ({source, data}) => {
    if (!data || data.channel !== 'svp-youtube' || (host ? source !== host : source === window)) return
    if (!host) { host = source; send('ready') }
    const {command, value} = data
    if (command === 'load') { token = data.token; video.currentTime = (value && value.time) || 0; video.play() }
    else if (command === 'play') video.play()
    else if (command === 'pause') video.pause()
    else if (command === 'seek') video.currentTime = value
  })
  setInterval(() => {
    if (token === null) return
    send('state', {state: video.paused ? 2 : 1, time: video.currentTime, duration: video.duration || 0, title: 'sample clip'})
  }, 250)
</script></body></html>`
const HZ = 20
// --video=<url or id> points the player at something else. The video is streamed by the app's own
// player exactly as it would be in use; nothing is downloaded.
const VIDEO = (process.argv.find((a) => a.startsWith('--video=')) || '').slice(8) || 'https://www.youtube.com/watch?v=M7lc1UVf-VE'

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
    window.__test = {get session() { return session }, enterRoom, youtube, setFilter, errors: [],
      frames: 0,
      rect: () => { const r = document.getElementById('youtube-player').getBoundingClientRect(); return {x: r.x, y: r.y, width: r.width, height: r.height} },
      faces: () => filters.tracker ? filters.tracker.visible().length : 0,
      capturing: () => Boolean(filters.capture),
      captureCanvas: () => filters.capture ? filters.capture.video : null};
    // Counting animation frames is the honest measure of "laggy": a page keeping up runs at the
    // display's rate, and one fighting the compositor does not.
    ;(function tick() { __test.frames++; requestAnimationFrame(tick) })();
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
  if (USE_CLIP) {
    if (!fs.existsSync(CLIP)) throw new Error(`no sample clip at ${CLIP} — set SVP_CLIP`)
    const clipBytes = fs.readFileSync(CLIP)
    win.webContents.session.protocol.handle('svp-youtube', async (request) => {
      const {pathname} = new URL(request.url)
      if (pathname !== '/clip.mp4') return new Response(CLIP_PAGE, {headers: {'Content-Type': 'text/html'}})
      // Chromium asks for media by range and refuses a source that will not answer one, which it
      // reports only as "no supported source was found".
      const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('Range') || '')
      const headers = {'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes'}
      if (!range) return new Response(clipBytes, {headers: {...headers, 'Content-Length': String(clipBytes.length)}})
      const start = range[1] ? Number(range[1]) : 0
      const end = range[2] ? Math.min(Number(range[2]), clipBytes.length - 1) : clipBytes.length - 1
      const slice = clipBytes.subarray(start, end + 1)
      return new Response(slice, {status: 206, headers: {...headers,
        'Content-Length': String(slice.length), 'Content-Range': `bytes ${start}-${end}/${clipBytes.length}`}})
    })
  } else registerYouTube(win.webContents.session)
  registerVision(win.webContents.session)
  win.webContents.on('console-message', (details) => {
    if (details.level === 'error') say(`  console: ${details.message}`)
  })
  // The guest is a separate WebContents, so its console and its load failures do not surface on the
  // embedder's. Without this a guest that never loads looks exactly like one that never answers.
  win.webContents.on('did-attach-webview', (_event, guest) => {
    say(`  guest attached: ${guest.id}`)
    guest.on('console-message', (details) => say(`  guest console [${details.level}]: ${details.message}`))
    guest.on('did-fail-load', (_e, code, description, url) => say(`  guest did-fail-load ${code} ${description} ${url}`))
    guest.on('did-finish-load', () => say(`  guest loaded ${guest.getURL()}`))
  })
  try {
    await win.loadFile(path.join(temporary, 'index.html'))
    await until(win, 'window.__test && !document.getElementById("welcome").hidden')
    await run(win, `document.getElementById('handle').value='flash'; document.getElementById('welcome-name').value='flash'; document.getElementById('welcome-form').dispatchEvent(new Event('submit', {cancelable:true}));`)
    await until(win, '__test.session && !document.getElementById("home").hidden')
    await run(win, '__test.enterRoom("ABCDEFGH", {joining:false})')
    await run(win, `document.getElementById('media-url').value = ${JSON.stringify(VIDEO)}; document.getElementById('media-url-form').requestSubmit()`)
    try {
      await until(win, '__test.youtube.loaded && __test.youtube.duration > 0', 20000)
    } catch (error) {
      say(`  player: ${await run(win, 'JSON.stringify({videoId: __test.youtube.videoId, ready: __test.youtube.ready, guestId: __test.youtube.guestId, state: __test.youtube.state, duration: __test.youtube.duration})')}`)
      throw error
    }
    await run(win, '__test.youtube.play()')
    await until(win, '__test.youtube.playing && __test.youtube.time > 1')

    if (COST) {
      const guestId = await run(win, '__test.youtube.guestId')
      const guest = guestId ? webContents.fromId(guestId) : null
      if (!guest) throw new Error('no guest to measure')
      const SECONDS = 5
      // The guest's own animation-frame rate. A compositor being asked for frames it was not going
      // to make cannot also keep the video at the display's rate, and this is where that shows.
      const guestFps = async () => {
        await guest.executeJavaScript('window.__f = 0; if (!window.__ticking) { window.__ticking = true; (function t(){ window.__f++; requestAnimationFrame(t) })() } 0')
        const started = Date.now()
        await pause(SECONDS * 1000)
        const frames = await guest.executeJavaScript('window.__f')
        return frames / ((Date.now() - started) / 1000)
      }
      const rows = []
      rows.push(['nothing reading it', await guestFps()])

      let polling = setInterval(() => guest.capturePage().catch(() => {}), 67)
      rows.push(['OLD: forced capturePage 15x a second', await guestFps()])
      clearInterval(polling)
      await pause(1000)

      await run(win, '__test.poll = setInterval(() => window.api.captureYouTube(__test.youtube.guestId), 67)')
      rows.push(['NEW: frame subscription, read 15x a second', await guestFps()])
      await run(win, 'clearInterval(__test.poll)')
      await pause(1000)

      rows.push(['nothing reading it, again', await guestFps()])
      say('')
      say('What reading the picture costs the guest, measured as its own animation frame rate:')
      say('')
      const base = rows[0][1]
      for (const [label, fps] of rows) {
        say(`  ${label.padEnd(44)} ${fps.toFixed(1)} fps   ${((fps / base) * 100).toFixed(0)}% of idle`)
      }
      say('')
      say('A rate well under the idle one is the guest being taxed, and is what "laggy" looks like')
      say('from the inside. The embedder can sit at a steady 60 throughout and tell you nothing.')
      win.destroy()
      app.exit(0)
      return
    }

    if (WATCH) {
      const guestId = await run(win, '__test.youtube.guestId')
      const guest = guestId ? webContents.fromId(guestId) : null
      // The phase label goes on the window, not in this terminal: whoever is watching the picture
      // cannot read a terminal at the same time, and correlating a flash with a phase is the whole
      // point of the mode. Styles are set through the CSSOM rather than a style attribute, which
      // the app's own `style-src 'self'` policy discards silently.
      const banner = (text) => run(win, `
        (() => {
          let el = document.getElementById('__phase')
          if (!el) {
            el = document.createElement('div')
            el.id = '__phase'
            document.body.appendChild(el)
            const s = el.style
            s.position = 'fixed'
            s.left = s.right = s.top = '0'
            s.zIndex = '99999'
            s.background = 'rgba(0,0,0,0.82)'
            s.color = '#fff'
            s.fontFamily = 'system-ui, sans-serif'
            s.fontSize = '19px'
            s.fontWeight = '600'
            s.padding = '10px 16px'
            s.textAlign = 'center'
            s.pointerEvents = 'none'
          }
          el.textContent = ${JSON.stringify('%TEXT%')}
        })()
      `.replace('%TEXT%', text))

      const SECONDS = 8
      const phase = async (letter, label, note, during) => {
        say(`>> ${letter}: ${label}`)
        say(`   ${note}`)
        for (let left = SECONDS; left > 0; left--) {
          await banner(`${letter}  ·  ${label}  ·  ${left}s`)
          const until = Date.now() + 1000
          while (Date.now() < until) await (during ? during() : pause(50))
        }
        say('')
      }
      // Anything that reads the picture is paced to the rate the real thing uses, so a phase is a
      // fair stand-in for it rather than as fast as the loop will go.
      const at = (hz, work) => async () => {
        const started = Date.now()
        await work()
        await pause(Math.max(0, 1000 / hz - (Date.now() - started)))
      }

      say('')
      say('The video plays throughout. The window names the phase it is in — watch the picture,')
      say('not this terminal, and note which letters flicker.')
      say('')
      await phase('A', 'nothing is reading the picture',
        'the app alone, no capturePage anywhere. Flicker here is the app itself.')
      await phase('B', 'the harness reads the window 20x a second',
        'what my measured runs did. Flicker only here means my sampling caused it.',
        at(20, () => win.webContents.capturePage()))
      // C and D are the before and after of the same readback, and the distinction is easy to lose:
      // C calls capturePage() straight from this process, which is what the filter used to do and
      // is deliberately left unfixed as the control. D goes through the app's own IPC path, which
      // now serves frames from a subscription instead of forcing them. If C flickers and D does
      // not, the fix is doing exactly what it claims.
      await phase('C', 'OLD path: the guest is forced 15x a second',
        'the control, unfixed on purpose. This is expected to flicker.',
        at(15, () => (guest ? guest.capturePage() : pause(0))))
      await run(win, `__test.poll = setInterval(() => window.api.captureYouTube(__test.youtube.guestId), 67)`)
      await phase('D', 'NEW path: the app reads the guest 15x a second',
        'the same rate through the fixed code, no filter. This is expected to be steady.')
      await run(win, 'clearInterval(__test.poll)')
      await run(win, `__test.setFilter('mesh')`)
      await phase('E', 'the Face map filter is on',
        'the real thing: the fixed readback, plus detecting and drawing.')
      await run(win, '__test.setFilter(null)')
      // Last, because it is the state the flicker was reported in and the easiest to judge: a
      // still picture that flickers cannot be the video's own content.
      await run(win, '__test.youtube.pause()')
      await phase('F', 'paused, nothing reading the picture',
        'a still frame. Any flicker at all here is the app painting over the player.')
      await banner('done — closing')
      await pause(1500)
      say('Which letters flickered?')
      say('  expected to flicker:  B and C, the two unfixed forced-capture loops')
      say('  expected to be calm:  A and F (the app alone), D and E (the fixed readback)')
      say('  D or E flickering means the fix did not take')
      win.destroy()
      app.exit(0)
      return
    }

    if (FILTER) {
      await run(win, `__test.setFilter(${JSON.stringify(FILTER)})`)
      await pause(1500)
    }
    // What one frame of the picture costs to fetch. The filter asks for this 15 times a second, so
    // anything near 66ms means the loop cannot keep up and the app spends its time in readback.
    const cost = await run(win, `
      (async () => {
        const id = __test.youtube.guestId
        const times = []
        for (let i = 0; i < 25; i++) {
          const started = performance.now()
          const frame = await window.api.captureYouTube(id)
          times.push(performance.now() - started)
          if (!frame) return {error: 'the capture came back empty'}
        }
        times.sort((a, b) => a - b)
        return {min: times[0], median: times[12], max: times[24]}
      })()
    `)
    say(cost.error ? `capture: ${cost.error}` : `capture: ${cost.min.toFixed(1)}ms min, ${cost.median.toFixed(1)}ms median, ${cost.max.toFixed(1)}ms max (66ms is the budget at 15Hz)`)

    const box = await run(win, '({...__test.rect(), pageWidth: innerWidth})')
    say(`playing in the real app, player at ${Math.round(box.width)}x${Math.round(box.height)}, sampling ${SECONDS}s at ${HZ}Hz`)
    say('')

    const guestId = await run(win, '__test.youtube.guestId')
    const guest = guestId ? webContents.fromId(guestId) : null

    // A paused picture is a still one: every sample must read the same. That makes the paused pass
    // the sharper of the two, because a trough in it cannot be the video's own content changing —
    // it can only be the app painting over, hiding or relaying out the player.
    async function collect(seconds) {
      const framesBefore = await run(win, '__test.frames')
      const startedAt = Date.now()
      const fromWindow = []
      const fromGuest = []
      const states = []
      const faces = []
      const rects = []
      for (let i = 0; i < seconds * HZ; i++) {
        const started = Date.now()
        fromWindow.push(brightness(await win.webContents.capturePage(), box))
        if (guest) fromGuest.push(brightness(await guest.capturePage(), {...box, x: 0, y: 0, pageWidth: box.width}))
        states.push(await run(win, '__test.youtube.state'))
        faces.push(await run(win, '__test.faces()'))
        // The player's own box, every sample. A webview that is being resized or hidden repaints,
        // and that reads as a flash no brightness trough on its own can be traced back to.
        rects.push(await run(win, 'JSON.stringify(__test.rect())'))
        await pause(Math.max(0, 1000 / HZ - (Date.now() - started)))
      }
      const fps = ((await run(win, '__test.frames')) - framesBefore) / ((Date.now() - startedAt) / 1000)
      return {fromWindow, fromGuest, states, faces, rects, fps}
    }

    const report = (label, values) => {
      if (!values.length) return
      const peak = Math.max(...values)
      const dark = values.filter((v) => v < peak * 0.25).length
      say(`${label.padEnd(8)} ${spark(values, peak)}`)
      say(`${''.padEnd(8)} peak ${peak.toFixed(0)}, ${dark} of ${values.length} samples below a quarter of it`)
    }
    const describe = (title, taken) => {
      say('')
      say(`--- ${title} --- ${taken.fps.toFixed(1)} animation frames a second`)
      report('window', taken.fromWindow)
      report('guest', taken.fromGuest)
      say(`state    ${taken.states.map((s) => (s === null ? '?' : String(s).replace('-1', 'b'))).join('')}   (1 playing, 2 paused, 3 buffering, b starting)`)
      say(`faces    ${taken.faces.map((n) => (n > 9 ? '+' : String(n))).join('')}`)
      const shapes = [...new Set(taken.rects)]
      say(shapes.length === 1
        ? `player   steady at ${JSON.parse(shapes[0]).width.toFixed(0)}x${JSON.parse(shapes[0]).height.toFixed(0)}`
        : `player   RESIZED ${shapes.length} times: ${shapes.map((r) => { const b = JSON.parse(r); return `${b.width.toFixed(0)}x${b.height.toFixed(0)}` }).join(' -> ')}`)
      // A still picture that measures differently from one sample to the next is the whole bug.
      const peak = Math.max(...taken.fromWindow)
      const low = Math.min(...taken.fromWindow)
      say(`window   swing ${(((peak - low) / (peak || 1)) * 100).toFixed(1)}% of peak`)
    }

    say(`source: ${USE_CLIP ? 'the sample clip through the player' : 'YouTube'}, filter: ${FILTER || 'off'}`)
    say(`capturing: ${await run(win, '__test.capturing()')}`)
    const playing = await collect(SECONDS)
    describe('playing', playing)

    await run(win, '__test.youtube.pause()')
    await pause(1200)
    const paused = await collect(SECONDS)
    describe('paused', paused)

    // The harness is the host and alone in the room, and a host paused is plainly steady. A viewer
    // is not the same code: receiveState calls youtube.sync() on every state message, which the
    // host broadcasts once a second whether or not anything is playing. sync() corrects at most
    // once a second and re-seeks whenever the player's own clock is more than 1.25s from the
    // host's — so if a paused seek does not land where it was asked, the viewer re-seeks every
    // second forever, and each seek repaints the player. This drives that path by hand.
    const held = await run(win, '__test.youtube.time')
    say('')
    say(`--- as a viewer: sync() once a second against a host paused at ${held.toFixed(2)}s ---`)
    await run(win, `
      __test.seeks = []
      const player = __test.youtube
      const realSeek = player.seek.bind(player)
      player.seek = (t) => { __test.seeks.push({to: t, at: player.time}); realSeek(t) }
      __test.syncTimer = setInterval(() => player.sync(player.videoId, ${held}, false), 1000)
    `)
    const viewer = await collect(SECONDS)
    const seeks = await run(win, 'JSON.stringify(__test.seeks)')
    await run(win, 'clearInterval(__test.syncTimer)')
    describe('paused, driven as a viewer', viewer)
    const list = JSON.parse(seeks)
    say(list.length
      ? `seeks    ${list.length} in ${SECONDS}s — ${list.map((s) => `${s.at.toFixed(2)}->${s.to.toFixed(2)}`).join(', ')}`
      : `seeks    none: sync() left the paused player alone, which is correct`)
    // What the detector is actually being shown. Everything else is inference from numbers.
    const shot = await run(win, `(() => { const c = __test.captureCanvas(); return c ? c.toDataURL('image/png') : null })()`)
    if (shot) {
      const file = path.join(temporary, 'capture.png')
      fs.writeFileSync(file, Buffer.from(shot.split(',')[1], 'base64'))
      say(`captured frame written to ${file}`)
    }
    const errors = await run(win, '__test.errors')
    if (errors.length) say(`\nrenderer errors: ${JSON.stringify(errors.slice(0, 5))}`)
    say('')
    say('A trough in `window` while `guest` stays level is a compositing flash. Both dropping')
    say('together is the player really going blank, and `state` says whether it rebuffered.')
    say('In the paused pass the picture is still, so any swing at all is the app, not the video.')
  } catch (error) {
    say(`FAILED: ${error.stack || error}`)
    win.destroy()
    app.exit(1)
    return
  }
  win.destroy()
  app.exit(0)
})
