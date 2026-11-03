// `node scripts/old-tree.js v0.8.0`: an exact copy of an earlier release's renderer, ready to bundle, for
// the checks that put an old copy of the app next to the new one (scripts/check-compat.js, and
// `npm run bench -- --tree=...`).
//
//   work/compat/<tag>/   git archive of the tag (renderer/, shared/, main/, scripts/ ...) with its own
//                        node_modules/@trystero-p2p/core: the pristine 0.25.4 package with THAT tag's
//                        scripts/patch-trystero.js applied, so the transport is the old one too.
//
// Nothing here links to or touches the working tree's node_modules (a junction into it was once
// followed by a delete and emptied it): the pristine package is downloaded once into
// work/compat/pristine-core and copied. Delete work/compat/<tag> with an ordinary recursive remove.
const fs = require('node:fs')
const path = require('node:path')
const {execFileSync} = require('node:child_process')

const root = path.resolve(__dirname, '..')
const compat = path.join(root, 'work', 'compat')

function pristineCore() {
  const dir = path.join(compat, 'pristine-core')
  if (fs.existsSync(path.join(dir, 'package', 'dist', 'index.mjs'))) return path.join(dir, 'package')
  fs.mkdirSync(dir, {recursive: true})
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const packed = execFileSync(npm, ['pack', '@trystero-p2p/core@0.25.4', '--silent'], {cwd: dir, encoding: 'utf8', shell: process.platform === 'win32'}).trim().split(/\r?\n/).pop()
  execFileSync('tar', ['-xzf', packed], {cwd: dir})
  return path.join(dir, 'package')
}

function prepare(tag) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error(`a release tag like v0.8.0, not ${tag}`)
  const target = path.join(compat, tag)
  const marker = path.join(target, '.prepared')
  if (fs.existsSync(marker)) return target
  fs.rmSync(target, {recursive: true, force: true, maxRetries: 3})
  fs.mkdirSync(target, {recursive: true})
  const archive = path.join(compat, `${tag}.tar`)
  execFileSync('git', ['archive', '--format=tar', '-o', archive, tag], {cwd: root})
  execFileSync('tar', ['-xf', path.relative(target, archive)], {cwd: target})
  fs.rmSync(archive)
  const core = path.join(target, 'node_modules', '@trystero-p2p', 'core')
  fs.mkdirSync(path.dirname(core), {recursive: true})
  fs.cpSync(pristineCore(), core, {recursive: true})
  execFileSync(process.execPath, [path.join(target, 'scripts', 'patch-trystero.js')], {cwd: target, stdio: 'inherit'})
  fs.writeFileSync(marker, tag)
  return target
}

if (require.main === module) console.log(prepare(process.argv[2] || 'v0.8.0'))
module.exports = {prepare}
