// Disposable NSIS install/update/relaunch QA. Hosted Windows CI only: the QA
// installer has its own app ID, no shortcuts and an isolated Chromium profile.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const {spawn} = require('node:child_process')
const {createHash} = require('node:crypto')
const asar = require('@electron/asar')
const {build, Platform} = require('electron-builder')
const root = path.resolve(__dirname, '..')
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(condition, description, timeout = 120_000) {
  const start = Date.now()
  while (Date.now() - start < timeout) { if (await condition()) return; await pause(100) }
  throw new Error(`Timed out: ${description}`)
}
function run(exe, args = []) {
  const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(exe, args, {env, windowsHide: true, stdio: 'inherit'})
  return new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${path.basename(exe)} exited ${signal || code}`)))
  })
}
async function main() {
  assert.equal(process.platform, 'win32', 'NSIS QA requires Windows')
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'NSIS QA installs only on disposable hosted CI')
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted', 'do not install fixtures on a personal/self-hosted runner')
  const production = path.join(root, 'dist/win-unpacked')
  assert.ok(fs.existsSync(path.join(production, 'Watch With Friends.exe')), 'build the production Windows app first')
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'wwf-nsis-qa-'))
  const installed = path.join(scratch, 'installed with spaces')
  const profile = path.join(scratch, 'profile')
  const command = path.join(scratch, 'commands.json')
  const marker = path.join(scratch, 'state.json')
  const data = {identity: 'qa-identity', friends: '["friend#qa"]', rooms: '{"QA123456":{"progress":42}}', settings: '{"uiScale":125,"volume":0.7}'}
  const storage = (seed) => `(() => {const initial=${JSON.stringify(data)}; const saved={}; for (const [key,value] of Object.entries(initial)) {if (${seed} && !localStorage.getItem(key)) localStorage.setItem(key,value); saved[key]=localStorage.getItem(key)}; return saved})()`
  const routes = new Map()
  const server = http.createServer((req, res) => {
    const bytes = routes.get(req.url.split('?')[0])
    if (!bytes) {res.writeHead(404); res.end(); return}
    res.writeHead(200, {'Content-Length': bytes.length}); res.end(bytes)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  let running
  const read = () => {try {return JSON.parse(fs.readFileSync(marker))} catch {return {}}}
  const control = (inRoom, retry = 0, quit = false) => fs.writeFileSync(command, JSON.stringify({inRoom, retry, quit}))
  async function fixture(version) {
    const directory = path.join(scratch, version)
    const app = path.join(directory, 'app')
    const expanded = path.join(directory, 'expanded')
    fs.cpSync(production, app, {recursive: true})
    asar.extractAll(path.join(app, 'resources/app.asar'), expanded)
    const pkg = JSON.parse(fs.readFileSync(path.join(expanded, 'package.json')))
    pkg.main = 'qa-main.js'; pkg.version = version; pkg.name = 'wwf-updater-qa'; delete pkg.build
    fs.writeFileSync(path.join(expanded, 'package.json'), JSON.stringify(pkg))
    fs.writeFileSync(path.join(expanded, 'qa.html'), '<!doctype html><title>NSIS Updater QA</title>')
    fs.writeFileSync(path.join(expanded, 'qa-main.js'), `
const {app,BrowserWindow}=require('electron'); const fs=require('node:fs');
app.setPath('userData',${JSON.stringify(profile)}); app.setPath('sessionData',${JSON.stringify(profile)});
const updater=require('./main/updater'); let win; let retry=0; const faults=[];
process.on('unhandledRejection',(error)=>faults.push(String(error?.message||error)));
app.whenReady().then(async()=>{
  win=new BrowserWindow({show:false}); await win.loadFile(require('node:path').join(__dirname,'qa.html'));
  const data=await win.webContents.executeJavaScript(${JSON.stringify(storage(version === '1.0.0'))});
  updater.setInRoom(true); updater.checkForUpdates();
  setInterval(()=>{let c; try{c=JSON.parse(fs.readFileSync(${JSON.stringify(command)}))}catch{return}
    updater.setInRoom(c.inRoom); if(c.retry>retry){retry=c.retry; updater.retry()}
    fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({version:app.getVersion(),pid:process.pid,data,faults,status:updater.getStatus()}));
    if(c.quit) app.quit();
  },100);
}); app.on('before-quit',()=>updater.dispose());
`)
    fs.rmSync(path.join(app, 'resources/app.asar'))
    await asar.createPackage(expanded, path.join(app, 'resources/app.asar'))
    fs.writeFileSync(path.join(app, 'resources/app-update.yml'), `provider: generic\nurl: ${base}\nupdaterCacheDirName: wwf-nsis-qa-${path.basename(scratch)}\n`)
    const output = path.join(directory, 'installers')
    await build({projectDir: expanded, prepackaged: app, targets: Platform.WINDOWS.createTarget('nsis'), publish: 'never', config: {
      extends: null, electronVersion: require('electron/package.json').version,
      appId: 'app.syncedvideoplayer.updaterqa', productName: 'WWF Updater QA', executableName: 'Watch With Friends',
      directories: {output}, win: {target: 'nsis', signAndEditExecutable: false},
      nsis: {oneClick: true, perMachine: false, runAfterFinish: false, createDesktopShortcut: false, createStartMenuShortcut: false, artifactName: 'qa-${version}.exe'},
      publish: {provider: 'generic', url: base},
    }})
    return path.join(output, `qa-${version}.exe`)
  }
  try {
    control(true)
    const old = await fixture('1.0.0')
    const next = await fixture('1.0.1')
    const bytes = fs.readFileSync(next)
    routes.set('/qa-1.0.1.exe', bytes)
    const feed = (hash) => Buffer.from(`version: 1.0.1\nfiles:\n  - url: qa-1.0.1.exe\n    sha512: ${hash}\n    size: ${bytes.length}\npath: qa-1.0.1.exe\nsha512: ${hash}\nreleaseDate: 2026-10-04T00:00:00.000Z\n`)
    routes.set('/latest.yml', feed(Buffer.alloc(64).toString('base64')))
    await run(old, ['/S', `/D=${installed}`])
    const executable = path.join(installed, 'Watch With Friends.exe')
    const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE
    running = spawn(executable, [], {env, stdio: 'inherit', windowsHide: true})
    running.on('error', (error) => console.error(error))
    await until(() => read().status?.phase === 'error', 'real NSIS checksum rejection')
    assert.equal(read().version, '1.0.0', 'bad bytes cannot replace the installed app')
    assert.match(read().status.message, /sha512|checksum/i)
    assert.deepEqual(read().faults, [], 'a failed download cannot leave an unhandled rejection')
    console.log('PASS: real Windows updater rejects a checksum mismatch without installing')
    routes.set('/latest.yml', feed(createHash('sha512').update(bytes).digest('base64')))
    control(true, 1)
    await until(() => read().status?.phase === 'ready', 'NSIS download and staging')
    await pause(3500)
    assert.equal(read().version, '1.0.0', 'a room postpones the real installer')
    control(false, 1); await pause(500); control(true, 1)
    await pause(3500)
    assert.equal(read().version, '1.0.0', 'rejoining cancels a pending restart')
    control(false, 1)
    await until(() => read().version === '1.0.1', 'NSIS silent replacement and relaunch', 180_000)
    assert.deepEqual(read().data, data, 'identity, friends, rooms and settings survive the real NSIS update')
    assert.deepEqual(read().faults, [])
    console.log('PASS: real NSIS install updates silently, defers rooms/rejoining, relaunches and preserves saved data')
    control(false, 1, true)
    await pause(1500)
  } catch (error) {console.error('NSIS fixture state:', read()); throw error}
  finally {
    control(true, 0, true)
    await pause(1500)
    running?.kill()
    const uninstaller = path.join(installed, 'Uninstall Watch With Friends.exe')
    // _? keeps NSIS from returning early after copying/spawning itself, so disk
    // cleanup waits for the actual uninstallation (including paths with spaces).
    if (fs.existsSync(uninstaller)) await run(uninstaller, ['/S', `_?=${installed}`])
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve))
    // Every recursive cleanup target was allocated directly under this fixture.
    assert.equal(path.dirname(path.resolve(scratch)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(scratch).startsWith('wwf-nsis-qa-'))
    await fs.promises.rm(scratch, {recursive: true, force: true, maxRetries: 25, retryDelay: 200})
  }
}
main().then(() => process.exit(0), (error) => {console.error(error); process.exit(1)})
