// Does a <webview> keep the postMessage channel the YouTube player already uses?
//
// If contentWindow.postMessage works both ways, swapping the iframe for a webview is a small,
// low-risk change. If it does not, the play/pause/seek sync channel has to be rewritten onto
// ipcRenderer, which is a much bigger change to the part of the app that matters most.
const {app, BrowserWindow} = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const say = (line = '') => fs.writeSync(1, `${line}\n`)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svp-msg-'))
app.setPath('userData', path.join(dir, 'profile'))

// The guest answers a command the way renderer/youtube/bridge.js does today.
fs.writeFileSync(path.join(dir, 'guest.html'), `<!doctype html><body style="margin:0;background:#0a0">
<script>
  window.addEventListener('message', (event) => {
    if (event.data && event.data.channel === 'svp-youtube') {
      (event.source || window.parent).postMessage({channel: 'svp-youtube', reply: 'got:' + event.data.command}, '*')
    }
  })
</script>
</body></html>`)

fs.writeFileSync(path.join(dir, 'host.html'), `<!doctype html><html><body style="margin:0;background:#000">
<webview id="w" src="file://${path.join(dir, 'guest.html').split(path.sep).join('/')}" style="width:400px;height:300px"></webview>
<script>
  window.result = {ready: false, sent: null, reply: null, error: null}
  const w = document.getElementById('w')
  window.addEventListener('message', (event) => {
    if (event.data && event.data.channel === 'svp-youtube') window.result.reply = event.data.reply
  })
  w.addEventListener('dom-ready', () => {
    window.result.ready = true
    try {
      w.contentWindow.postMessage({channel: 'svp-youtube', command: 'play'}, '*')
      window.result.sent = 'contentWindow.postMessage did not throw'
    } catch (e) {
      window.result.error = String(e)
    }
  })
</script>
</body></html>`)

app.whenReady().then(async () => {
  const win = new BrowserWindow({show: true, width: 600, height: 500, webPreferences: {webviewTag: true}})
  try {
    await win.loadFile(path.join(dir, 'host.html'))
    let out = null
    for (let i = 0; i < 60; i++) {
      out = await win.webContents.executeJavaScript('window.result')
      if (out && (out.reply || out.error)) break
      await new Promise((r) => setTimeout(r, 200))
    }
    say(`dom-ready fired:  ${out.ready}`)
    say(`host -> guest:    ${out.sent || 'threw'}`)
    say(`error:            ${out.error || 'none'}`)
    say(`guest -> host:    ${out.reply || 'NO REPLY'}`)
    say('')
    if (out.reply === 'got:play') say('RESULT: postMessage works both ways through a webview. Small change.')
    else if (out.error) say('RESULT: contentWindow is not usable. The sync channel must move to ipcRenderer.')
    else say('RESULT: the host could send but nothing came back. Return path must move to ipcRenderer.')
  } catch (error) {
    say(`FAILED: ${error.stack || error}`)
    app.exit(1)
    return
  }
  app.exit(0)
})
