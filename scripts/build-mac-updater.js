// Pin and checksum the upstream native dependency; no install-time network
// dependency and no source-built security/atomic-replacement implementation.
const fs = require('node:fs')
const path = require('node:path')
const {createHash} = require('node:crypto')
const {execFileSync} = require('node:child_process')
const {pipeline} = require('node:stream/promises')
const {Readable} = require('node:stream')

const VERSION = '2.10.0'
const SHA256 = 'c2bf58aa8387266ac179357b1415d6f2635f044da8be41042af32425dae6da0c'
const root = path.resolve(__dirname, '..')
const vendor = path.join(root, '.cache', 'sparkle', VERSION)
const target = path.join(root, 'build', 'mac-updater', 'WatchWithFriendsUpdater.app')
const run = (tool, args) => execFileSync(tool, args, {stdio: 'inherit'})

async function build(arch = process.arch) {
  if (process.platform !== 'darwin') throw new Error('Build the Mac updater on macOS')
  if (!['arm64', 'x64'].includes(arch)) throw new Error('Unsupported Mac architecture')
  fs.mkdirSync(vendor, {recursive: true})
  const archive = path.join(vendor, `Sparkle-${VERSION}.tar.xz`)
  if (!fs.existsSync(archive)) {
    const response = await fetch(`https://github.com/sparkle-project/Sparkle/releases/download/${VERSION}/Sparkle-${VERSION}.tar.xz`, {signal: AbortSignal.timeout(120_000)})
    if (!response.ok) throw new Error(`Sparkle download failed: ${response.status}`)
    const partial = `${archive}.partial`
    try {
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(partial))
      fs.renameSync(partial, archive)
    } finally { fs.rmSync(partial, {force: true}) }
  }
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(archive)) hash.update(chunk)
  if (hash.digest('hex') !== SHA256) throw new Error('Sparkle archive checksum does not match')
  run('/usr/bin/tar', ['-xf', archive, '-C', vendor])
  const contents = path.join(target, 'Contents')
  fs.mkdirSync(path.join(contents, 'MacOS'), {recursive: true})
  fs.mkdirSync(path.join(contents, 'Frameworks'), {recursive: true})
  run('/usr/bin/ditto', [path.join(vendor, 'Sparkle.framework'), path.join(contents, 'Frameworks', 'Sparkle.framework')])
  fs.copyFileSync(path.join(root, 'native/updater/Info.plist'), path.join(contents, 'Info.plist'))
  run('/usr/bin/clang', ['-arch', arch === 'x64' ? 'x86_64' : 'arm64', '-mmacosx-version-min=12.0', '-fobjc-arc', '-fblocks', '-Wall', '-Werror', '-Wno-unused-parameter',
    '-F', vendor, '-framework', 'AppKit', '-framework', 'Sparkle', '-Wl,-rpath,@executable_path/../Frameworks',
    path.join(root, 'native/updater/main.m'), '-o', path.join(contents, 'MacOS', 'WatchWithFriendsUpdater')])
  run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', target])
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', target])
  console.log(`Built Sparkle ${VERSION} updater for ${arch}`)
  return {target, vendor}
}
if (require.main === module) build(process.argv[2]).catch((error) => { console.error(error.message); process.exitCode = 1 })
module.exports = {build, VERSION, SHA256}
