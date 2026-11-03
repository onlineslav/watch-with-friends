// Scratch folders for the long checks (test:network, bench): a run builds a ~300 MB profile, fixtures and bundle in
// %TEMP%, and until M1.7 nothing ever removed them, so a few hundred runs filled the disk (ENOSPC). A run now
//   - removes folders of finished or crashed earlier runs when it starts (`removeStale`),
//   - removes its own folder when it ends, pass or fail (`release`), unless --keep / KEEP_TEMP=1.
// A folder records its owner's pid, so a run in progress (this repo's, or a second one) is never touched.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const OWNER_FILE = 'owner.pid'
const STALE_WITHOUT_OWNER_MS = 30 * 60 * 1000 // older folders from before the owner file existed

function alive(pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}

function remove(dir) {
  // The big files first: a window's profile can stay locked a moment after it closes.
  try {
    for (const name of fs.readdirSync(dir)) if (name !== 'profile' && name !== OWNER_FILE) fs.rmSync(path.join(dir, name), {recursive: true, force: true, maxRetries: 5, retryDelay: 100})
  } catch {}
  try { fs.rmSync(dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 200}) } catch {}
  return !fs.existsSync(dir)
}

// Removes the folders `prefix`* in the temp directory that nothing is using. Returns how many it removed.
function removeStale(prefix, {now = Date.now(), tmp = os.tmpdir()} = {}) {
  let removed = 0
  let names = []
  try { names = fs.readdirSync(tmp).filter((name) => name.startsWith(prefix)) } catch {}
  for (const name of names) {
    const dir = path.join(tmp, name)
    try {
      if (!fs.statSync(dir).isDirectory()) continue
      let owner = null
      try { owner = Number(fs.readFileSync(path.join(dir, OWNER_FILE), 'utf8')) } catch {}
      const stale = owner ? !alive(owner) : now - fs.statSync(dir).mtimeMs > STALE_WITHOUT_OWNER_MS
      if (stale && remove(dir)) removed++
    } catch {}
  }
  return removed
}

// Makes this run's folder (after clearing stale ones). `release()` removes it; it also runs when the process exits.
function create(prefix, {keep = false, tmp = os.tmpdir()} = {}) {
  removeStale(prefix, {tmp})
  const dir = fs.mkdtempSync(path.join(tmp, prefix))
  fs.writeFileSync(path.join(dir, OWNER_FILE), String(process.pid))
  let released = false
  const release = () => {
    if (released) return
    released = true
    if (!keep) remove(dir)
  }
  process.on('exit', release)
  return {dir, release}
}

module.exports = {create, removeStale, remove, alive}
