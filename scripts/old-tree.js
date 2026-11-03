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
//
// Every step is a child process with a time limit, run asynchronously so the caller's own watchdog
// still runs, and killed with its whole process tree on a timeout or when this process exits. The old
// patch script runs under `process.execPath`, which is electron.exe when check-compat calls this: it
// needs ELECTRON_RUN_AS_NODE=1, or Electron starts as an app, never exits and holds the folder open.
const fs = require('node:fs')
const path = require('node:path')
const {spawn, spawnSync} = require('node:child_process')

const root = path.resolve(__dirname, '..')
const compat = path.join(root, 'work', 'compat')
const STEP_TIMEOUT_MS = 3 * 60 * 1000

const running = new Set()
function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {stdio: 'ignore', windowsHide: true})
  else try { child.kill('SIGKILL') } catch {}
}
// Kills every step still running; check-compat calls it before app.exit (which need not emit 'exit').
function stopAll() { for (const child of running) killTree(child) }
process.on('exit', stopAll)

// Runs one step; rejects with the step's name and its output on a non-zero exit or a timeout.
function step(label, command, args, {cwd, env = process.env, shell = false, timeoutMs = STEP_TIMEOUT_MS} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {cwd, env, shell, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']})
    running.add(child)
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    const timer = setTimeout(() => {
      killTree(child)
      reject(new Error(`old-tree: ${label} timed out after ${timeoutMs}ms\n${output.slice(-2000)}`))
    }, timeoutMs)
    child.on('error', (error) => { clearTimeout(timer); running.delete(child); reject(new Error(`old-tree: ${label}: ${error.message}`)) })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      running.delete(child)
      if (code === 0) resolve(output)
      else reject(new Error(`old-tree: ${label} exited with ${code ?? signal}\n${output.slice(-2000)}`))
    })
  })
}

async function pristineCore() {
  const dir = path.join(compat, 'pristine-core')
  if (fs.existsSync(path.join(dir, 'package', 'dist', 'index.mjs'))) return path.join(dir, 'package')
  fs.mkdirSync(dir, {recursive: true})
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const packed = (await step('npm pack', npm, ['pack', '@trystero-p2p/core@0.25.4', '--silent'], {cwd: dir, shell: process.platform === 'win32'})).trim().split(/\r?\n/).pop()
  await step('unpack the transport', 'tar', ['-xzf', packed], {cwd: dir})
  return path.join(dir, 'package')
}

async function prepare(tag) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error(`a release tag like v0.8.0, not ${tag}`)
  const target = path.join(compat, tag)
  const marker = path.join(target, '.prepared')
  if (fs.existsSync(marker)) return target
  try {
    fs.rmSync(target, {recursive: true, force: true, maxRetries: 5, retryDelay: 200})
  } catch (error) {
    throw new Error(`old-tree: cannot clear ${target} (${error.code}); a process left by an earlier run may still hold it: look for command lines containing work\\compat\\${tag}`)
  }
  fs.mkdirSync(target, {recursive: true})
  const archive = path.join(compat, `${tag}.tar`)
  await step(`git archive ${tag}`, 'git', ['archive', '--format=tar', '-o', archive, tag], {cwd: root})
  await step(`extract ${tag}`, 'tar', ['-xf', path.relative(target, archive)], {cwd: target})
  fs.rmSync(archive)
  const core = path.join(target, 'node_modules', '@trystero-p2p', 'core')
  fs.mkdirSync(path.dirname(core), {recursive: true})
  fs.cpSync(await pristineCore(), core, {recursive: true})
  await step(`${tag}'s patch-trystero.js`, process.execPath, [path.join(target, 'scripts', 'patch-trystero.js')], {cwd: target, env: {...process.env, ELECTRON_RUN_AS_NODE: '1'}, timeoutMs: 60000})
  fs.writeFileSync(marker, tag)
  return target
}

if (require.main === module) {
  prepare(process.argv[2] || 'v0.8.0').then((target) => console.log(target), (error) => { console.error(error.message); process.exitCode = 1 })
}
module.exports = {prepare, stopAll, step}
