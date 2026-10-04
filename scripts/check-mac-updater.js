// Real Sparkle end-to-end QA on macOS, with disposable apps and localhost-only
// feeds. No releases, real profiles, public discovery or Apple accounts touched.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const {spawn, execFileSync} = require('node:child_process')
const {generateKeyPairSync, sign} = require('node:crypto')
const {build} = require('./build-mac-updater')
const {xml} = require('./mac-update-feed')
const root = path.resolve(__dirname, '..')
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const run = (cmd, args, options = {}) => execFileSync(cmd, args, {stdio: 'pipe', ...options})

async function until(condition, description, timeout = 60_000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await condition()) return
    await wait(100)
  }
  throw new Error(`Timed out: ${description}`)
}
function plist(file, values) {
  fs.writeFileSync(file, `<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>${Object.entries(values).map(([key, value]) => `<key>${xml(key)}</key>${typeof value === 'boolean' ? `<${value}/>` : `<string>${xml(value)}</string>`}`).join('')}</dict></plist>`)
}
function keys() {
  const pair = generateKeyPairSync('ed25519')
  return {...pair, secret: pair.privateKey.export({type: 'pkcs8', format: 'der'}).subarray(-32).toString('base64'), public: pair.publicKey.export({type: 'spki', format: 'der'}).subarray(-32).toString('base64')}
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('Run native updater QA on macOS')
  const {target, vendor} = await build()
  const helper = path.join(target, 'Contents/MacOS/WatchWithFriendsUpdater')
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'wwf-updater-qa-'))
  const children = new Set()
  const sessions = []
  const routes = new Map()
  const server = http.createServer((req, res) => {
    const result = routes.get(req.url)
    if (!result) { res.writeHead(404); res.end(); return }
    if (result.drop) { req.socket.destroy(); return }
    const bytes = result.bytes || Buffer.from(result.text || '')
    res.writeHead(result.status || 200, {'Content-Type': result.type || 'application/octet-stream', 'Content-Length': bytes.length})
    res.end(bytes)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  let cases = 0
  const caseKey = keys()
  const fixtureBinary = path.join(scratch, 'Fixture')
  run('/usr/bin/clang', ['-fobjc-arc', '-framework', 'AppKit', path.join(root, 'native/updater/fixture.m'), '-o', fixtureBinary])
  function child(exe, args = []) {
    const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE
    const processChild = spawn(exe, args, {env, stdio: ['pipe', 'pipe', 'pipe']})
    children.add(processChild)
    processChild.on('close', () => children.delete(processChild))
    return processChild
  }
  function nativeSession(app, feed) {
    const processChild = child(helper, [app, feed])
    const events = []
    let output = '', errors = ''
    let done = false
    processChild.stdout.setEncoding('utf8')
    processChild.stdout.on('data', (chunk) => {
      output += chunk
      let end
      while ((end = output.indexOf('\n')) !== -1) {
        const line = output.slice(0, end); output = output.slice(end + 1)
        if (line) events.push(JSON.parse(line))
      }
    })
    processChild.stderr.on('data', (chunk) => { errors = (errors + chunk).slice(-8000) })
    processChild.on('close', () => { done = true })
    processChild.stdin.on('error', () => {})
    const session = {processChild, events, get errors() {return errors}, get done() {return done}}
    sessions.push(session)
    return session
  }
  function fixture(label, version = '1.0.0', publicKey = caseKey.public) {
    const directory = path.join(scratch, label)
    const app = path.join(directory, 'QA Watch With Friends.app')
    fs.mkdirSync(path.join(app, 'Contents/MacOS'), {recursive: true})
    fs.copyFileSync(fixtureBinary, path.join(app, 'Contents/MacOS/Fixture'))
    fs.chmodSync(path.join(app, 'Contents/MacOS/Fixture'), 0o755)
    const marker = path.join(directory, 'launched')
    plist(path.join(app, 'Contents/Info.plist'), {
      CFBundleIdentifier: `app.syncedvideoplayer.qa.${label.replace(/[^a-z0-9]/gi, '')}`,
      CFBundleName: 'QA Watch With Friends', CFBundleExecutable: 'Fixture', CFBundlePackageType: 'APPL', CFBundleVersion: version, CFBundleShortVersionString: version,
      SUFeedURL: `${base}/${label}.xml`, SUPublicEDKey: publicKey, SUVerifyUpdateBeforeExtraction: true, SURequireSignedFeed: true, SUEnableAutomaticChecks: false, SUAllowsAutomaticUpdates: false,
      QAMarker: marker, LSUIElement: true,
    })
    run('/usr/bin/codesign', ['--force', '--sign', '-', app])
    return {app, marker, label, directory}
  }
  function archive(app, name) {
    const file = path.join(scratch, name)
    run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, file])
    return fs.readFileSync(file)
  }
  function feed(label, {version = '1.0.1', archiveBytes, signatureKey = caseKey, signFeed = true, tamper = false, packageUpdate = false, minimumOS = '12.0', drop = false, archiveStatus = 200}) {
    const archiveUrl = `/${label}.zip`
    routes.set(archiveUrl, {bytes: archiveBytes, status: archiveStatus, drop})
    const sig = sign(null, archiveBytes, signatureKey.privateKey).toString('base64')
    const content = `<?xml version="1.0" encoding="utf-8"?><rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><title>QA</title><item>
<sparkle:version>${version}</sparkle:version><sparkle:shortVersionString>${version}</sparkle:shortVersionString><sparkle:minimumSystemVersion>${minimumOS}</sparkle:minimumSystemVersion>
<enclosure url="${base}${archiveUrl}" length="${archiveBytes.length}" type="application/octet-stream" sparkle:edSignature="${sig}"${packageUpdate ? ' sparkle:installationType="package"' : ''}/></item></channel></rss>`
    const file = path.join(scratch, `${label}.xml`)
    fs.writeFileSync(file, content)
    if (signFeed) run(path.join(vendor, 'bin/sign_update'), ['--ed-key-file', '-', file], {input: `${caseKey.secret}\n`})
    let text = fs.readFileSync(file, 'utf8')
    if (tamper) text = text.replace('<title>QA</title>', '<title>Changed</title>')
    routes.set(`/${label}.xml`, {text, type: 'application/xml'})
    return `${base}/${label}.xml`
  }
  async function terminal(session, expected) {
    await until(() => session.events.some((e) => expected.includes(e.phase)) || session.done, `updater status ${expected}: ${session.errors}`)
    assert.ok(session.events.some((e) => expected.includes(e.phase)), JSON.stringify(session.events) + session.errors)
  }
  try {
    const update = fixture('payload', '1.0.1')
    const payload = archive(update.app, 'update.zip')
    const negative = [
      ['wrong-signature', {signatureKey: keys()}, ['error']],
      ['unsigned-feed', {signFeed: false}, ['error']],
      ['tampered-feed', {tamper: true}, ['error']],
      ['corrupt-archive', {archiveBytes: Buffer.from('not an archive')}, ['error']],
      ['missing-archive', {archiveStatus: 404}, ['error']],
      ['interrupted-download', {drop: true}, ['error']],
      ['privileged-package', {packageUpdate: true}, ['error']],
      ['same-version', {version: '1.0.0'}, ['current']],
      ['downgrade', {version: '0.9.0'}, ['current']],
      ['unsupported-macos', {minimumOS: '99.0'}, ['current']],
    ]
    for (const [label, overrides, expected] of negative) {
      const current = fixture(label)
      const infoBefore = fs.readFileSync(path.join(current.app, 'Contents/Info.plist'))
      const url = feed(label, {archiveBytes: payload, ...overrides})
      const session = nativeSession(current.app, url)
      await terminal(session, expected)
      assert.equal(session.events.some((e) => e.phase === 'ready' || e.phase === 'installing'), false, label)
      assert.deepEqual(fs.readFileSync(path.join(current.app, 'Contents/Info.plist')), infoBefore)
      session.processChild.stdin.end()
      console.log(`PASS: ${label} leaves the installed app unchanged`)
      cases++
    }
    const readonly = fixture('read-only')
    fs.chmodSync(readonly.directory, 0o555)
    try {
      const session = nativeSession(readonly.app, `${base}/unused.xml`)
      await terminal(session, ['blocked'])
      console.log('PASS: read-only installation gives actionable status without prompting or replacing')
      cases++
    } finally { fs.chmodSync(readonly.directory, 0o755) }

    // The payload must have the same bundle identity as the installed app.
    const current = fixture('success with spaces')
    const next = fixture('next with spaces', '1.0.1')
    const info = path.join(next.app, 'Contents/Info.plist')
    run('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleIdentifier app.syncedvideoplayer.qa.successwithspaces', info])
    run('/usr/libexec/PlistBuddy', ['-c', `Set :QAMarker ${current.marker}`, info])
    run('/usr/bin/codesign', ['--force', '--sign', '-', next.app])
    const url = feed(current.label, {archiveBytes: archive(next.app, 'success.zip')})
    run('/usr/bin/open', ['-n', '-g', current.app])
    await until(() => fs.existsSync(`${current.marker}-1.0.0`), 'old fixture launch')
    const session = nativeSession(current.app, url)
    await terminal(session, ['ready', 'error'])
    assert.equal(session.events.at(-1).phase, 'ready', session.errors)
    await wait(1500)
    assert.equal(fs.existsSync(`${current.marker}-1.0.1`), false, 'staged update must not restart a watch')
    session.processChild.stdin.write('unknown\n')
    await wait(200)
    assert.equal(fs.existsSync(`${current.marker}-1.0.1`), false)
    session.processChild.stdin.write('install\n')
    await until(() => fs.existsSync(`${current.marker}-1.0.1`), 'native replacement and relaunch', 90_000)
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', current.app])
    run('/usr/bin/osascript', ['-e', 'tell application id "app.syncedvideoplayer.qa.successwithspaces" to quit'])
    console.log('PASS: signed update stages, waits, replaces and relaunches with spaces in the path')
    cases++

    if (process.argv.includes('--packaged')) {
      const asar = require('@electron/asar')
      const dist = path.join(root, 'dist')
      const directory = fs.readdirSync(dist).find((name) => name === (process.arch === 'arm64' ? 'mac-arm64' : 'mac'))
      assert.ok(directory, 'packaged Mac app exists')
      const production = path.join(dist, directory, 'Watch With Friends.app')
      const productionInfo = run('/usr/libexec/PlistBuddy', ['-c', 'Print', path.join(production, 'Contents/Info.plist')]).toString()
      assert.ok(productionInfo.includes(`appcast-${process.arch}.xml`), 'packaged architecture feed is resolved')
      assert.ok(productionInfo.includes(require('../config/update-key.json').publicKey), 'production public key is embedded')
      run('/usr/bin/codesign', ['--verify', '--deep', '--strict', production])
      const qaRoot = path.join(scratch, 'electron-qa')
      fs.mkdirSync(qaRoot)
      const profile = path.join(qaRoot, 'profile')
      const marker = path.join(qaRoot, 'electron.json')
      const command = path.join(qaRoot, 'room.json')
      fs.writeFileSync(command, 'true')
      const label = 'electron'
      async function electronFixture(version, destination) {
        const app = path.join(destination, 'Watch With Friends.app')
        run('/usr/bin/ditto', [production, app])
        const contents = path.join(app, 'Contents')
        const expanded = path.join(destination, 'expanded')
        asar.extractAll(path.join(contents, 'Resources/app.asar'), expanded)
        const pkg = JSON.parse(fs.readFileSync(path.join(expanded, 'package.json')))
        pkg.main = 'qa-main.js'; pkg.version = version
        fs.writeFileSync(path.join(expanded, 'package.json'), JSON.stringify(pkg))
        fs.writeFileSync(path.join(expanded, 'qa.html'), '<!doctype html><title>Updater QA</title>')
        fs.writeFileSync(path.join(expanded, 'qa-main.js'), `
const {app, BrowserWindow} = require('electron'); const fs = require('node:fs');
app.setPath('userData', ${JSON.stringify(profile)}); app.setPath('sessionData', ${JSON.stringify(profile)});
const updater = require('./main/updater'); const log = require('./main/log'); let win;
app.whenReady().then(async () => {
  log.start({dir: ${JSON.stringify(path.join(profile, 'logs'))}});
  win = new BrowserWindow({show:false}); await win.loadFile(require('node:path').join(__dirname, 'qa.html'));
  const identity = await win.webContents.executeJavaScript("localStorage.getItem('identity') || (localStorage.setItem('identity', 'qa-saved-identity'), 'qa-saved-identity')");
  updater.setInRoom(JSON.parse(fs.readFileSync(${JSON.stringify(command)})));
  updater.checkForUpdates();
  setInterval(() => {updater.setInRoom(JSON.parse(fs.readFileSync(${JSON.stringify(command)}))); fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({version:app.getVersion(), identity, status:updater.getStatus()}));}, 200);
}); app.on('before-quit', () => {updater.dispose(); log.stop()}); app.on('window-all-closed',()=>app.quit());
`)
        fs.rmSync(path.join(contents, 'Resources/app.asar'))
        await asar.createPackage(expanded, path.join(contents, 'Resources/app.asar'))
        const info = path.join(contents, 'Info.plist')
        for (const [key, value] of Object.entries({CFBundleIdentifier: 'app.syncedvideoplayer.qa.electron', CFBundleVersion: version, CFBundleShortVersionString: version, SUFeedURL: `${base}/${label}.xml`, SUPublicEDKey: caseKey.public})) {
          run('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, info])
        }
        run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app])
        return app
      }
      const oldApp = await electronFixture('1.0.0', path.join(qaRoot, 'installed'))
      const newApp = await electronFixture('1.0.1', path.join(qaRoot, 'new'))
      feed(label, {archiveBytes: archive(newApp, 'electron.zip')})
      run('/usr/bin/open', ['-n', '-g', oldApp])
      const read = () => { try {return JSON.parse(fs.readFileSync(marker))} catch {return {}} }
      await until(() => read().status?.phase === 'ready' || read().status?.phase === 'error', 'packaged Electron staging', 180_000)
      assert.equal(read().status.phase, 'ready', JSON.stringify(read()))
      assert.equal(read().version, '1.0.0')
      await wait(3500)
      assert.equal(read().version, '1.0.0', 'real Electron stays open in its room')
      fs.writeFileSync(command, 'false')
      await until(() => read().version === '1.0.1', 'packaged Electron replacement/relaunch', 120_000)
      assert.equal(read().identity, 'qa-saved-identity', 'Chromium localStorage survives the update')
      run('/usr/bin/codesign', ['--verify', '--deep', '--strict', oldApp])
      run('/usr/bin/osascript', ['-e', 'tell application id "app.syncedvideoplayer.qa.electron" to quit'])
      console.log('PASS: packaged Electron updater waits for room exit, replaces, relaunches and preserves localStorage')
      cases++
    }
    console.log(`PASS: ${cases} native updater scenarios on ${process.arch}`)
  } catch (error) {
    for (const session of sessions) console.error(JSON.stringify(session.events), session.errors)
    throw error
  } finally {
    for (const processChild of children) processChild.kill()
    for (const bundle of ['app.syncedvideoplayer.qa.successwithspaces', 'app.syncedvideoplayer.qa.electron']) {
      try { run('/usr/bin/osascript', ['-e', `tell application id "${bundle}" to quit`]) } catch {}
    }
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(scratch, {recursive: true, force: true})
  }
}
main().catch((error) => {console.error(error); process.exitCode = 1})
