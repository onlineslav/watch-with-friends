#!/usr/bin/env node
// Fetches development telemetry for reading. Run with `npm run diagnostics [username]`.
//
// Uploads land in a private GitHub repository (relay/worker.mjs, /telemetry) as one small gzip per
// upload: telemetry/<username>/<day>/<time>.log.gz. This keeps a shallow clone of that repository in
// work/diagnostics-repo, pulls it, and writes one readable file per person per day to
// work/diagnostics/<username>/<day>.log, oldest upload first. Reading it needs only access to the
// repository through your own `gh` login, so any collaborator on it can run this.
//
//   npm run diagnostics              every person, every day
//   npm run diagnostics -- aya       only folders starting with "aya"
//   DIAGNOSTICS_REPO=owner/name      a different repository
//   npm run diagnostics -- --live [scope]   watch everyone's lines as they happen (scripts/live-view.js)
//   npm run diagnostics -- --report [username] [day]   scorecard per session and viewer, host and viewer
//                                    logs of one room paired (scripts/session-report.js); newest day by default,
//                                    a YYYY-MM-DD day or "all" to pick
//   npm run diagnostics -- --compare [username] [day]  the same numbers grouped by app version
//                                    (--report/--compare fetch first; --no-fetch or --dir <path> read what is there)

const {execFileSync} = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const REPO = process.env.DIAGNOSTICS_REPO || 'onlineslav/watch-with-friends-diagnostics'
const root = path.resolve(__dirname, '..')
const clone = path.join(root, 'work', 'diagnostics-repo')
const out = path.join(root, 'work', 'diagnostics')
const filter = (process.argv[2] || '').toLowerCase()
const reporting = process.argv.includes('--report') || process.argv.includes('--compare')

const run = (command, args, options = {}) => execFileSync(command, args, {stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...options})

function sync() {
  try {
    if (fs.existsSync(path.join(clone, '.git'))) run('git', ['-C', clone, 'pull', '--ff-only', '--quiet'])
    else run('gh', ['repo', 'clone', REPO, clone, '--', '--depth', '1', '--quiet'])
  } catch (error) {
    const detail = String(error.stderr || error.message).trim().split('\n').pop()
    throw new Error(`Could not fetch ${REPO}: ${detail}\nYou need \`gh auth login\` with access to that repository.`)
  }
}

const list = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [])

function unpack(only = filter) {
  const people = list(path.join(clone, 'telemetry')).filter((name) => name.startsWith(only))
  const rows = []
  for (const person of people) {
    for (const day of list(path.join(clone, 'telemetry', person))) {
      const uploads = list(path.join(clone, 'telemetry', person, day)).filter((name) => name.endsWith('.log.gz'))
      if (!uploads.length) continue
      const text = uploads.map((name) => {
        try { return zlib.gunzipSync(fs.readFileSync(path.join(clone, 'telemetry', person, day, name))).toString('utf8') }
        catch { return `# ${name}: could not be unpacked\n` }
      }).join('')
      const target = path.join(out, person, `${day}.log`)
      fs.mkdirSync(path.dirname(target), {recursive: true})
      fs.writeFileSync(target, text)
      rows.push({person, day, uploads: uploads.length, kb: Math.round(Buffer.byteLength(text) / 1024), last: uploads.at(-1).slice(0, 6).replace(/(..)(..)(..)/, '$1:$2:$3')})
    }
  }
  return rows
}

function archive() {
  try { sync() } catch (error) { console.error(error.message); process.exit(1) }
  const rows = unpack()
  if (!rows.length) {
    console.log(filter ? `No telemetry from anyone matching "${filter}" yet.` : 'No telemetry has arrived yet.')
    return
  }
  console.table(rows.slice(-20).map(({person, day, uploads, kb, last}) => ({person, day, uploads, 'size KB': kb, 'last upload (UTC)': last})))
  const latest = rows.reduce((a, b) => (`${b.day}${b.last}` > `${a.day}${a.last}` ? b : a))
  console.log(`Unpacked to ${path.relative(root, out)}. Newest: ${path.relative(root, path.join(out, latest.person, `${latest.day}.log`))}`)
}

if (process.argv.includes('--live')) {
  require('./live-view').run(process.argv.slice(2)).then((code) => process.exit(code), (error) => { console.error(error.message); process.exit(1) })
} else if (reporting) {
  // Every person's files are unpacked, whatever the name filter: a report pairs a host's file with its viewers'.
  const code = require('./session-report').run(process.argv.slice(2), {defaultDir: out, fetchArchive: () => { sync(); unpack('') }})
  process.exitCode = code
} else {
  archive()
}
