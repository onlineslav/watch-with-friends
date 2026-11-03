'use strict'

// Writes the synthetic logs test/report.test.js reads: node scripts/make-report-fixtures.js [dir]
// (default test/fixtures/report). Two watch sessions of one host and two viewers, none of it real:
// 0.8.0 (no M1.2 fields) and 0.9.0 (all of them, plus M1.9: edge round trips `er`, one-way delays `ow`, marks and
// context events). In the 0.9.0 session the host's own link fills up around the loss (its edge RTT climbs, the
// viewer's stays flat), so the report's bottleneck line names the host's upload. Everything is a pure function of the sample index,
// so rerunning it reproduces the committed files byte for byte. Viewer three has no log of its own.
// After changing it, regenerate the expected output with UPDATE_GOLDEN=1 node --test test/report.test.js.
const fs = require('fs')
const path = require('path')
const root = path.resolve(process.argv[2] || path.join(__dirname, '..', 'test', 'fixtures', 'report'))
const ROOM = 'FIXT-ROOM'
const HOST = {folder: 'host-one-0000-0000', from: 'host-one#0000-0000', id: 'hostid01'}
const V2 = {folder: 'viewer-two-0000-0000', from: 'viewer-two#0000-0000', id: 'viewid02'}
const V3 = {id: 'viewid03', name: 'viewer-three#0000-0000'}

const line = (at, mono, sc, ev, ctx, data, lv = 'info') => JSON.stringify({t: new Date(at).toISOString(), m: mono, lv, sc, ev, ...ctx, ...data})
const write = (who, day, version, lines) => {
  const file = path.join(root, who.folder, `${day}.log`)
  fs.mkdirSync(path.dirname(file), {recursive: true})
  const meta = {sent: `${day}T12:00:00.000Z`, from: who.from, version, platform: 'win32 test', arch: 'x64', packaged: true}
  fs.writeFileSync(file, `# upload ${JSON.stringify(meta)}\n${lines.join('\n')}\n`)
}

function session({day, t0, version, modern, rttExtra = 0, samples}) {
  const hostCtx = (role) => ({room: ROOM, self: HOST.id, role})
  const v2Ctx = {room: ROOM, self: V2.id, role: 'viewer'}
  const h = [line(t0 - 1000, 10, 'app', 'launch', {}, {version, platform: 'win32 test', arch: 'x64'}), line(t0, 20, 'room', 'entered', {room: ROOM, self: HOST.id}, {joining: false})]
  const v = [line(t0 - 1000, 10, 'app', 'launch', {}, {version, platform: 'win32 test', arch: 'x64'}), line(t0 + 500, 20, 'room', 'entered', {room: ROOM, self: V2.id}, {joining: true})]
  h.push(line(t0 + 600, 25, 'peer', 'join', hostCtx('host'), {peer: V3.id, username: V3.name, peers: 2}))
  let bitrate = 4_000_000
  const pairs = [[V2, 0], [V3, 1]]
  for (let i = 0; i < samples; i++) {
    const at = t0 + 2000 * (i + 1)
    const play = i >= 2
    const trouble = i >= 10 && i <= 12
    const loss = trouble ? 8.5 : (i % 7 === 0 ? 0.4 : 0)
    const freezes = i === 11 ? 1 : 0
    let decision = !play ? 'inactive' : trouble ? (freezes ? 'freezes' : 'loss') : 'settling'
    const before = bitrate
    if (trouble) bitrate = Math.round(bitrate * 0.75)
    if (i === 20) { bitrate = Math.round(bitrate + 600_000); decision = 'recovery' }
    const playback = {playing: play, loading: !play, buffering: false, time: i * 2, readyState: 4}
    const rtt = 30 + rttExtra + (i % 5) * 2 + (trouble ? 180 : 0)
    const near = i >= 9 && i <= 13 // within a sample or two of the trouble
    for (const [peer, k] of pairs) {
      const rep = peer === V2 && modern
      const d = {peer: peer.id, rttMs: rtt + k * 20, relayed: false, capacity: 9_000_000, sender: {fps: 30, height: 1080, limit: 'none'},
        receiver: {lossPct: loss + k * 0.1, freezes, droppedFrames: 0, fps: 30, height: 1080, bufferMs: 250, delayMs: 310},
        bitrate, scale: 1, calmMs: 0, decision, ceiling: 9_000_000, mediaKind: 'video', sentBitrateBps: bitrate - 100_000, audioSentBitrateBps: 120_000, playback}
      if (modern) { d.e = {enc: 3 + (i % 4) * 0.5, cpu: trouble ? 400 : 0, bw: trouble ? 1200 : 0, oth: 0, pli: 0, nack: 1, fir: 0}; d.set = {pri: 'balanced', ab: 256000, af: 1} }
      if (rep) d.ow = {vh: 15 + (i % 2) + (near ? 3 : 0)}
      h.push(line(at, 100 + i, 'telemetry', 'host-sample', hostCtx('host'), d))
      if (trouble && bitrate !== before && peer === V2 && i === 10) {
        h.push(line(at, 101 + i, 'telemetry', 'send-quality-change', hostCtx('host'), {peer: peer.id, from: before, to: bitrate, change: '-25%', reason: decision, lossPct: loss, freezes, capacity: 9_000_000, scaleFrom: 1, scaleTo: 1, feedbackAgeMs: 400}, 'warn'))
      }
      if (i === 20 && peer === V2) h.push(line(at, 101 + i, 'telemetry', 'send-quality-change', hostCtx('host'), {peer: peer.id, from: before, to: bitrate, change: '+9%', reason: 'recovery', lossPct: 0, freezes: 0, capacity: 9_000_000, scaleFrom: 1, scaleTo: 1, feedbackAgeMs: 300}, 'warn'))
    }
    // viewer two's own log
    const vs = {host: HOST.id, rttMs: rtt, relayed: false, steady: play, jitterMs: 3, lossPct: loss, freezes, droppedFrames: 0, fps: 30, height: 1080, bufferMs: 250, delayMs: 310,
      sender: {fps: 30, height: 1080, limit: 'none'}, epoch: 1, mediaKind: 'video', receivedBitrateBps: play ? bitrate - 150_000 : 0, receiveIntervalMs: 2000, audioReceivedBitrateBps: play ? 110_000 + (i % 3) * 5000 : 0, playback: {playing: play, loading: !play, buffering: false, time: i * 2, readyState: 4}}
    if (modern) {
      vs.a = {lost: 0, rx: 100, jit: 2, conc: trouble ? 4800 : 96, sil: 0, smp: 96000, ins: 0, rem: 0, jb: 60, lvl: 0.1}
      if (i % 2) vs.s = {aJb: 60, vJb: 20, aPlay: 15, out: 30, base: 10}
      else vs.s = {aEpt: 1000, vEpt: 1040 + i, av: 40 + i, aJb: 60, vJb: 20, aPlay: 15, out: 30, base: 10}
      vs.v = {dec: 2 + (i % 3) * 0.4, pli: 0, nack: 0, fir: 0, frz: freezes ? 600 : 0, pau: 0}
      vs.set = {pri: 'balanced', ab: 256000, af: 1}
      vs.ow = {hv: near ? 150 + 10 * (i - 9) : 14 + (i % 3)}
    }
    v.push(line(at + 50, 100 + i, 'telemetry', 'viewer-sample', v2Ctx, vs))
    if (modern) {
      h.push(line(at + 60, 100 + i, 'telemetry', 'machine-sample', hostCtx('host'), {role: 'host', p: {m: [8, 120], r: [40 + i, 400], g: [30 + (i === 15 ? 90 : 0), 300], o: [5, 80, 3]}, free: 4000, lt: 0, er: near ? 205 + 10 * (i - 9) : 25 + (i % 3), host: {ff: 1.5, ahead: 40, fr: {n: 60, avg: 33, max: 40, busy: 0}}, cost: 1.2}))
      v.push(line(at + 70, 100 + i, 'telemetry', 'machine-sample', v2Ctx, {role: 'viewer', p: {m: [4, 100], r: [25, 300], g: [20, 250], o: [2, 40, 2]}, free: 6000, lt: 0, er: 30 + (i % 2), cost: 0.9}))
    }
    if (i === 0) v.push(line(at + 80, 101, 'clock', 'offset', v2Ctx, {host: HOST.id, offsetMs: 12, rttMs: 31}))
    if (modern && i === 0) {
      v.push(line(t0 + 600, 21, 'audio', 'device', v2Ctx, {why: 'room', kind: 'bluetooth', label: 'Headphones (Test Buds)', outs: 3, sr: 48000, base: 10, out: 30, state: 'running'}))
      h.push(line(t0 + 700, 22, 'audio', 'device', hostCtx('host'), {why: 'room', kind: 'builtin', label: 'Speakers (Test Audio)', outs: 2, sr: 48000, base: 10, out: 30, state: 'running'}))
      h.push(line(t0 + 800, 23, 'media', 'source', {}, {c: 'matroska,webm', dur: 5400, mode: 'transcode', v: {codec: 'hevc', pix: 'yuv420p10le', w: 3840, h: 2160, fps: 23.976, hdr: 1}, why: ['pixel-format'], enc: 'h264_nvenc', tm: 1, a: {codec: 'dts', ch: 6}, af: 'flac'}))
    }
    if (modern && i === 11) {
      // Viewer two marks it with one key press; the host logs the same id as a peer's mark.
      v.push(line(at + 300, 150, 'mark', 'note', v2Ctx, {id: 'k3x9f2a1', src: 'self', by: V2.from, pos: 22, playing: true}))
      h.push(line(at + 380, 150, 'mark', 'note', hostCtx('host'), {id: 'k3x9f2a1', src: 'peer', by: V2.from, peer: V2.id, pos: 22, playing: true}))
      v.push(line(at + 900, 151, 'window', 'state', {}, {s: 'minimized'}))
      h.push(line(at + 1200, 152, 'crash', 'child-process-gone', {}, {reason: 'crashed', exitCode: -1073741819, type: 'Utility', name: 'Audio Service'}, 'error'))
    }
    if (modern && i === 12) {
      v.push(line(at + 200, 153, 'mark', 'note', v2Ctx, {id: 'k3x9f2a1', src: 'self', by: V2.from, note: 'audio crackles', pos: 24, playing: true}))
      h.push(line(at + 290, 153, 'mark', 'note', hostCtx('host'), {id: 'k3x9f2a1', src: 'peer', by: V2.from, peer: V2.id, note: 'audio crackles', pos: 24, playing: true}))
    }
    if (modern && i === 14) h.push(line(at + 100, 160, 'action', 'pause', hostCtx('host'), {via: 'host'}))
    if (modern && i === 22) {
      h.push(line(at + 100, 170, 'mark', 'note', hostCtx('host'), {id: 'm7q1z8b4', src: 'self', by: HOST.from, pos: 44, playing: true}))
      v.push(line(at + 180, 170, 'mark', 'note', v2Ctx, {id: 'm7q1z8b4', src: 'peer', by: HOST.from, peer: HOST.id, pos: 44, playing: true}))
    }
  }
  const end = t0 + 2000 * (samples + 1)
  h.push(line(end, 900, 'room', 'leave', hostCtx('host'), {peers: 2, role: 'host'}))
  v.push(line(end + 200, 900, 'room', 'leave', v2Ctx, {peers: 1, role: 'viewer'}))
  write(HOST, day, version, h)
  write(V2, day, version, v)
}

session({day: '2026-09-20', t0: Date.parse('2026-09-20T19:00:00Z'), version: '0.8.0', modern: false, samples: 24})
session({day: '2026-10-01', t0: Date.parse('2026-10-01T20:00:00Z'), version: '0.9.0', modern: true, rttExtra: 30, samples: 30})
