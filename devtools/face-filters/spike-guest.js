// Why does the real player never signal ready inside a <webview>?
//
// HANDOFF.md lists three candidates: no svp-youtube: handler in the guest session, embedder CSP,
// or a hidden window. This loads the REAL renderer/youtube page in a webview and reports which
// part of the chain breaks:
//
//   protocol hits  - does session's svp-youtube handler get asked for index.html and bridge.js?
//   parent===self  - is the guest a top-level document (so bare `parent.postMessage` talks to
//                    itself and the embedder hears nothing)?
//   host heard     - did the embedder receive ANY message from the guest?
//
// Run: node scripts/electron.js devtools/face-filters/spike-guest.js
const {app, BrowserWindow} = require('electron')
const {prepareYouTube, registerYouTube} = require('../../main/youtube')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const say = (line = '') => fs.writeSync(1, `${line}\n`)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svp-guest-'))
app.setPath('userData', path.join(dir, 'profile'))
prepareYouTube()

const hits = []

fs.writeFileSync(path.join(dir, 'host.html'), `<!doctype html><html><body style="margin:0;background:#111">
<webview id="w" src="svp-youtube://player/index.html" style="width:640px;height:360px"></webview>
<script>
  window.result = {domReady: false, heard: [], sendError: null, probe: null}
  const w = document.getElementById('w')
  window.addEventListener('message', (event) => {
    window.result.heard.push({origin: event.origin, type: event.data && event.data.type})
  })
  w.addEventListener('dom-ready', async () => {
    window.result.domReady = true
    // What does the guest itself see? executeJavaScript runs inside the guest.
    try {
      window.result.probe = await w.executeJavaScript(
        'JSON.stringify({top: parent === window, origin: location.origin, bridge: typeof send, yt: typeof YT})')
    } catch (e) { window.result.probe = 'probe threw: ' + e }
    try { w.contentWindow.postMessage({channel: 'svp-youtube', command: 'ping'}, '*') }
    catch (e) { window.result.sendError = String(e) }
  })
</script>
</body></html>`)

app.whenReady().then(async () => {
  registerYouTube()
  // Wrap the handler the app registered so we can see which files the guest actually asks for.
  const original = require('electron').session.defaultSession.protocol
  const handle = original.handle.bind(original)
  original.unhandle('svp-youtube')
  handle('svp-youtube', async (request) => {
    hits.push(new URL(request.url).pathname)
    const files = {'/index.html': 'text/html', '/bridge.js': 'text/javascript'}
    const url = new URL(request.url)
    if (url.hostname !== 'player' || !Object.hasOwn(files, url.pathname)) return new Response('', {status: 404})
    return new Response(await fs.promises.readFile(path.join(__dirname, '../../renderer/youtube', url.pathname.slice(1))),
      {headers: {'Content-Type': files[url.pathname]}})
  })

  const win = new BrowserWindow({show: true, width: 800, height: 500, webPreferences: {webviewTag: true, autoplayPolicy: 'no-user-gesture-required'}})
  win.webContents.setAudioMuted(true)
  win.webContents.on('did-attach-webview', (_event, guest) => {
    guest.on('console-message', (...args) => {
      const message = args.length > 2 ? args[2] : args[0]?.message
      say(`  guest console: ${message}`)
    })
    guest.on('did-fail-load', (_e, code, description, url) => say(`  guest did-fail-load ${code} ${description} ${url}`))
  })
  try {
    await win.loadFile(path.join(dir, 'host.html'))
    let out = null
    for (let i = 0; i < 100; i++) {
      out = await win.webContents.executeJavaScript('window.result')
      if (out?.heard.length) break
      await new Promise((r) => setTimeout(r, 200))
    }
    say('')
    say(`protocol hits:  ${hits.length ? hits.join(', ') : 'NONE — the guest session never reached the handler'}`)
    say(`dom-ready:      ${out.domReady}`)
    say(`guest probe:    ${out.probe}`)
    say(`host -> guest:  ${out.sendError || 'sent'}`)
    say(`host heard:     ${out.heard.length ? JSON.stringify(out.heard) : 'NOTHING'}`)
    say('')
    if (!hits.length) say('RESULT: the protocol handler is the blocker (candidate 1).')
    else if (out.probe?.includes('"top":true') && !out.heard.length) say("RESULT: the page loads fine; bare `parent.postMessage` in bridge.js talks to itself.")
    else if (!out.heard.length) say('RESULT: page loads, guest is not top-level, and still nothing came back. Look further.')
    else say('RESULT: messages arrive. The blocker is elsewhere.')
  } catch (error) {
    say(`FAILED: ${error.stack || error}`)
    app.exit(1)
    return
  }
  app.exit(0)
})
