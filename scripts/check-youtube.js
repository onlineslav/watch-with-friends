// Optional live-service smoke check. Uses a hidden window and a disposable profile.
const {app, BrowserWindow, webContents} = require('electron')
const {prepareYouTube, registerYouTube, guardWebviews} = require('../main/youtube')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const esbuild = require('esbuild')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'svp-youtube-check-'))
app.setPath('userData', path.join(temporary, 'profile'))
prepareYouTube()
const root = path.resolve(__dirname, '..')
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

app.whenReady().then(async () => {
  registerYouTube()
  const win = new BrowserWindow({show: false, width: 960, height: 640, webPreferences: {backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required', webviewTag: true}})
  guardWebviews(win.webContents)
  // Nothing here listens to the sound, and a test run should not be audible.
  win.webContents.setAudioMuted(true)
  const run = (source) => win.webContents.executeJavaScript(source)
  const until = async (condition) => {
    for (let i = 0; i < 300; i++) {
      const error = await run('window.failure')
      if (error) throw new Error(error)
      if (await run(condition)) return
      await pause(100)
    }
    throw new Error(`Timed out: ${condition}`)
  }
  try {
    // The same Content-Security-Policy the real renderer runs under, so this check proves a
    // webview attaches under it and not only in a bare page.
    const policy = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8').match(/content="(default-src[^"]+)"/)[1]
    fs.writeFileSync(path.join(temporary, 'index.html'), `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}" /></head><body><div id="player" style="width:900px;height:500px"></div></body></html>`)
    await win.loadFile(path.join(temporary, 'index.html'))
    const bundle = await esbuild.build({stdin: {contents: `
      import {YouTubePlayer} from './renderer/youtube.mjs';
      window.player = new YouTubePlayer(document.getElementById('player'));
      window.failure = null;
      player.addEventListener('error', ({detail}) => window.failure = detail);
    `, resolveDir: root}, bundle: true, write: false, format: 'iife'})
    await run(bundle.outputFiles[0].text)
    await run("player.open('M7lc1UVf-VE')")
    await until('player.ready')
    assert.equal(await run("Boolean(document.querySelector('webview') && player.guestId && player.ready)"), true)
    console.log('PASS: Isolated YouTube bridge and player API initialize')
    const bridge = webContents.fromId(await run('player.guestId'))
    assert.equal(bridge.getURL().startsWith('svp-youtube://player/'), true)
    assert.equal(await bridge.executeJavaScript('typeof window.api'), 'undefined')
    assert.equal(await bridge.executeJavaScript('typeof require'), 'undefined')
    await until('player.playing && player.time > 1 && player.duration > 0')
    console.log('PASS: YouTube playback advances with public video metadata')
    await run('player.pause()')
    await until('player.state === 2')
    await run('player.seek(10); player.play()')
    await until('player.playing && player.time >= 10')
    console.log('PASS: YouTube pause, seek and resume')
    await run("window.importResult = null; player.importPlaylist('PLBCF2DAC6FFB574DE').then(ids => window.importResult = ids, error => window.failure = error.message)")
    await until('window.importResult?.length > 0')
    assert.equal(await run('window.importResult.every(id => /^[\\w-]{11}$/.test(id))'), true)
    console.log(`PASS: YouTube playlist import returns ${await run('window.importResult.length')} video IDs in source order`)
    await run('player.close()')
    assert.equal(await run('document.querySelectorAll("webview").length'), 0)
  } finally { win.destroy() }
}).then(() => app.exit(0), (error) => { console.error(error); app.exit(1) })
