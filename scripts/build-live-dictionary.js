#!/usr/bin/env node
// Builds shared/live-dictionary.txt, the preset deflate dictionary for live telemetry frames, from
// real log lines. A dictionary only helps text that looks like it, so it is made of sample lines:
// the latest few of each kind (scope/event), the common kinds last, because deflate finds nearby
// matches cheapest.
//
//   LIVE_RATE_DUMP=work/lines.log node scripts/electron.js scripts/check-network.js --live-rate=2
//   node scripts/build-live-dictionary.js work/lines.log [more.log ...]
//
// Changing the text changes what a frame decodes to, so a rebuilt dictionary needs a new VERSION in
// shared/live.js (readers keep the old dictionaries for the apps still sending them).

const fs = require('node:fs')
const path = require('node:path')

const OUT = path.join(__dirname, '..', 'shared', 'live-dictionary.txt')
const MAX_BYTES = 24 * 1024 // deflate's window is 32 KB; leave room for the batch itself
const FREQUENT_KEEP = 2
const RARE_KEEP = 1

const files = process.argv.slice(2)
if (!files.length) { console.error('usage: node scripts/build-live-dictionary.js <lines.log> [...]'); process.exit(1) }

const groups = new Map()
for (const file of files) {
  for (const text of fs.readFileSync(file, 'utf8').split('\n')) {
    let line
    try { line = JSON.parse(text) } catch { continue }
    if (!line?.sc || !line?.ev) continue
    // Samples differ by role (host or viewer side), and the dictionary should hold both.
    const key = `${line.sc}/${line.ev}/${line.role || ''}`
    const group = groups.get(key) || {count: 0, lines: []}
    group.count += 1
    group.lines.push(text)
    groups.set(key, group)
  }
}

const ordered = [...groups.values()].sort((a, b) => a.count - b.count)
const picked = ordered.map((group) => group.lines.slice(-(group.count >= 10 ? FREQUENT_KEEP : RARE_KEEP)))
let total = picked.reduce((sum, lines) => sum + lines.reduce((s, l) => s + l.length + 1, 0), 0)
// Over budget: drop the rarest kinds first (they come first in the list).
while (total > MAX_BYTES && picked.length) {
  total -= picked.shift().reduce((s, l) => s + l.length + 1, 0)
}
const text = `${picked.flat().join('\n')}\n`
fs.writeFileSync(OUT, text)
console.log(`${path.relative(process.cwd(), OUT)}: ${Buffer.byteLength(text)} bytes from ${picked.length} kinds of line`)
