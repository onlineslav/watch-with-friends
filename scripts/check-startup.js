// Run with npm run test:startup. Isolated profiles and hidden windows keep this
// check away from the installed app's identity, friends, and cache.
const {app, BrowserWindow, ipcMain} = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'synced-startup-test-'))
app.setPath('userData', profile)
const root = path.resolve(__dirname, '..')
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const run = (win, source) => win.webContents.executeJavaScript(source)

async function until(win, condition, timeoutMs = 2500) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await run(win, condition)) return
    await pause(25)
  }
  assert.fail(`Timed out: ${condition}`)
}

app.whenReady().then(async () => {
  const windows = []
  const pendingNetwork = []
  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('net:ice-servers', () => new Promise((resolve) => pendingNetwork.push(resolve)))
  ipcMain.handle('update:check', () => null)
  ipcMain.handle('session:stop', () => {})
  ipcMain.handle('log:events', () => {}) // this check has no log file; the renderer flushes anyway
  try {
    const win = new BrowserWindow({show: false, webPreferences: {
      backgroundThrottling: false,
      preload: path.join(root, 'main/preload.js'),
    }})
    windows.push(win)
    const started = Date.now()
    await win.loadFile(path.join(root, 'renderer/index.html'))
    await until(win, '!document.getElementById("welcome").hidden')
    assert.ok(pendingNetwork.length, 'network setup is still pending')
    assert.equal(await run(win, 'document.getElementById("startup").hidden'), true)
    console.log(`PASS: New-user Welcome appears in ${Date.now() - started} ms while network setup is stalled`)

    await run(win, `
      document.getElementById('handle').value = 'startuptest';
      document.getElementById('welcome-name').value = 'Startup Test';
      document.getElementById('welcome-form').dispatchEvent(new Event('submit', {cancelable: true}));
    `)
    await until(win, '!document.getElementById("home").hidden')
    const username = await run(win, 'document.getElementById("username").textContent')
    assert.match(username, /^startuptest#/)
    assert.equal(await run(win, 'document.querySelector("#add-friend button").disabled'), true)
    console.log('PASS: Completing Welcome reaches Home before network setup finishes')

    const reloaded = Date.now()
    await win.loadFile(path.join(root, 'renderer/index.html'))
    await until(win, '!document.getElementById("home").hidden')
    assert.equal(await run(win, 'document.getElementById("username").textContent'), username)
    assert.equal(await run(win, 'document.getElementById("app-version").textContent'), `Version ${app.getVersion()}`)
    assert.equal(await run(win, 'document.getElementById("startup").hidden'), true)
    console.log(`PASS: Returning-user Home appears in ${Date.now() - reloaded} ms while network setup is stalled`)

    // A late result still initializes friends and enables their controls. Only
    // synthetic test identities enter discovery; no real profiles are loaded.
    for (const resolve of pendingNetwork.splice(0)) resolve([])
    await until(win, '!document.querySelector("#add-friend button").disabled', 5000)
    assert.equal(await run(win, 'document.getElementById("friends-online").textContent'), '0 online')
    console.log('PASS: Friends initialize when delayed network settings arrive')
  } finally {
    for (const win of windows) if (!win.isDestroyed()) win.destroy()
  }
}).then(() => app.exit(0), (error) => {
  console.error(error)
  app.exit(1)
})
