import test from 'node:test'
import assert from 'node:assert/strict'
import {DEVICE_KINDS, audioDeviceKey, classifyAudioDevice, describeAudioOutput, diffSettings, pickOutputDevice, stripPossessive} from '../renderer/context.mjs'
import {MARK_LIMIT, MARK_NOTE_MAX, MARK_WINDOW_MS, cleanMark, messageLimiter, newMarkId} from '../renderer/protocol.mjs'
import {hostToViewerMs, oneWayDelayMs, toHostClock, updateClock, viewerToHostMs} from '../renderer/sync.mjs'
import {DelayTally} from '../renderer/machine.mjs'
import {createNetwork} from '../renderer/network.mjs'

// ---------- audio output device ----------

test('device kinds come from the label, and an empty or odd label is "unknown", never an error', () => {
  const cases = {
    'Speakers (Realtek(R) Audio)': 'builtin',
    'MacBook Pro Speakers': 'builtin',
    'Built-in Output': 'builtin',
    'Headphones (Realtek(R) Audio)': 'wired',
    'External Headphones': 'wired',
    'USB Audio Device': 'wired',
    'Speakers (Scarlett 2i2 USB)': 'wired',
    'Headset Earphone (WH-1000XM4 Hands-Free AG Audio)': 'bluetooth',
    'Speakers (AirPods Pro)': 'bluetooth',
    "Aya's AirPods": 'bluetooth',
    'Headphones (Bluetooth Stereo)': 'bluetooth',
    'LG ULTRAWIDE (NVIDIA High Definition Audio)': 'hdmi',
    'DELL U2720Q (AMD High Definition Audio Device)': 'hdmi',
    'Digital Output (HDMI)': 'hdmi',
    'CABLE Input (VB-Audio Virtual Cable)': 'virtual',
    'BlackHole 2ch': 'virtual',
    'Voicemeeter Input (VB-Audio Voicemeeter VAIO)': 'virtual',
    'Multi-Output Device': 'virtual',
    "Rob's Headphones": 'wired', // "obs" inside a word is not OBS
    'Arctis 7 Game': 'unknown',
    '': 'unknown',
    '   ': 'unknown',
  }
  for (const [label, kind] of Object.entries(cases)) assert.equal(classifyAudioDevice(label), kind, label)
  for (const odd of [null, undefined, 42, {}, []]) assert.equal(classifyAudioDevice(odd), 'unknown')
  assert.ok(Object.values(cases).every((kind) => DEVICE_KINDS.includes(kind)))
})

test('the default output is named by the real device in its group, and hidden labels fall back to unknown', () => {
  const devices = [
    {kind: 'audioinput', deviceId: 'mic', label: 'Microphone', groupId: 'g0'},
    {kind: 'audiooutput', deviceId: 'default', label: 'Default - Headphones (WH-1000XM4 Stereo)', groupId: 'g1'},
    {kind: 'audiooutput', deviceId: 'communications', label: 'Communications - Headset (WH-1000XM4 Hands-Free)', groupId: 'g1'},
    {kind: 'audiooutput', deviceId: 'abc', label: 'Headphones (WH-1000XM4 Stereo)', groupId: 'g1'},
    {kind: 'audiooutput', deviceId: 'def', label: 'Speakers (Realtek(R) Audio)', groupId: 'g2'},
  ]
  assert.deepEqual(pickOutputDevice(devices), {label: 'Headphones (WH-1000XM4 Stereo)', kind: 'bluetooth', outs: 4})
  // The browser withholds names until media permission: empty labels, still a result.
  const hidden = [{kind: 'audiooutput', deviceId: 'default', label: '', groupId: 'g1'}, {kind: 'audiooutput', deviceId: 'abc', label: '', groupId: 'g1'}]
  assert.deepEqual(pickOutputDevice(hidden), {label: null, kind: 'unknown', outs: 2})
  assert.deepEqual(pickOutputDevice([]), {label: null, kind: 'unknown', outs: 0})
  assert.deepEqual(pickOutputDevice(null), {label: null, kind: 'unknown', outs: 0})
  assert.equal(pickOutputDevice([{kind: 'audiooutput', deviceId: 'x', label: 'L'.repeat(300)}]).label.length, 80)
})

test('audio/device carries sample rate and latencies in ms, and no latency that is zero or missing', () => {
  const devices = [{kind: 'audiooutput', deviceId: 'default', label: 'Default - Speakers (Realtek(R) Audio)', groupId: 'g'}]
  const info = describeAudioOutput(devices, {sampleRate: 48000, baseLatency: 0.01, outputLatency: 0.0305, state: 'running'})
  assert.deepEqual(info, {kind: 'builtin', label: 'Speakers (Realtek(R) Audio)', outs: 1, sr: 48000, base: 10, out: 30.5, state: 'running'})
  const settling = describeAudioOutput(devices, {sampleRate: 44100, baseLatency: 0.01, outputLatency: 0, state: 'suspended'})
  assert.equal(settling.out, null)
  assert.deepEqual(describeAudioOutput(devices, null), {kind: 'builtin', label: 'Speakers (Realtek(R) Audio)', outs: 1})
  // A change worth a second line is the device moving, not the latency settling.
  assert.equal(audioDeviceKey(info), audioDeviceKey({...info, out: 12, base: 9}))
  assert.notEqual(audioDeviceKey(info), audioDeviceKey({...info, label: 'Other'}))
  assert.notEqual(audioDeviceKey(info), audioDeviceKey({...info, sr: 44100}))
})

// ---------- Settings ----------

test('settings changes list only what moved, and never an audio device id', () => {
  const before = {resolution: '1080', frameRate: 30, audioDeviceId: 'system', audioFirst: true}
  assert.deepEqual(diffSettings(before, {...before}, Object.keys(before)), {})
  assert.deepEqual(diffSettings(before, {...before, frameRate: 60, audioFirst: false}, Object.keys(before)), {frameRate: [30, 60], audioFirst: [true, false]})
  assert.deepEqual(diffSettings(before, {...before, audioDeviceId: '3f9a0c7e11d2'}, ['audioDeviceId']), {audioDeviceId: ['system', 'device']})
  assert.deepEqual(diffSettings({audioDeviceId: 'abc'}, {audioDeviceId: 'def'}, ['audioDeviceId']), {}, 'two devices are both just "device"')
  assert.deepEqual(diffSettings({}, {zoom: 1.1}, ['zoom', 'missing']), {zoom: [null, 1.1]})
})

// ---------- marks ----------

test('a mark is an id and a short note; anything else is refused', () => {
  assert.deepEqual(cleanMark({id: 'k3x9f2a1'}), {id: 'k3x9f2a1', note: ''})
  assert.deepEqual(cleanMark({id: 'k3x9f2a1', note: '  audio   crackles\n now '}), {id: 'k3x9f2a1', note: 'audio crackles now'})
  assert.equal(cleanMark({id: 'k3x9f2a1', note: 'x'.repeat(500)}).note.length, MARK_NOTE_MAX)
  assert.equal(cleanMark({id: 'k3x9f2a1', note: 'a\u0007b‮c'}).note, 'a b c', 'control and bidi characters are stripped')
  for (const bad of [null, undefined, 'mark', [], 7, {}, {id: ''}, {id: 'ab'}, {id: 'UPPER123'}, {id: 'has space1'}, {id: 'x'.repeat(40)}, {id: 12345678}, {id: 'k3x9f2a1', note: 5}, {id: 'k3x9f2a1', note: {}}]) {
    assert.equal(cleanMark(bad), null, JSON.stringify(bad))
  }
  assert.deepEqual(Object.keys(cleanMark({id: 'k3x9f2a1', note: 'n', extra: 'ignored', __proto__: {x: 1}})), ['id', 'note'])
  const id = newMarkId()
  assert.deepEqual(cleanMark({id}), {id, note: ''}, 'a fresh id is always acceptable')
  assert.notEqual(newMarkId(), newMarkId())
})

test('marks are rate-limited per sender, so a flood from one peer does not hide another', () => {
  const allow = messageLimiter(MARK_LIMIT, MARK_WINDOW_MS)
  let now = 0
  const accepted = Array.from({length: 20}, () => allow('peer-a', now))
  assert.equal(accepted.filter(Boolean).length, MARK_LIMIT)
  assert.equal(allow('peer-b', now), true)
  now += MARK_WINDOW_MS
  assert.equal(allow('peer-a', now), true, 'and the window reopens')
})

// ---------- one-way delay ----------

test('one-way delay in each direction from the room clock offset', () => {
  // Host clock = ours + 1000. The host stamped a state at 1500 (host clock); it arrived at 560 on ours (= 1560).
  assert.equal(hostToViewerMs(1500, 560, 1000), 60)
  // We stamp a report with the host's clock as we reckon it, and the host reads its own clock on arrival.
  const stamp = toHostClock(700, 1000)
  assert.equal(stamp, 1700)
  assert.equal(viewerToHostMs(stamp, 1725), 25)
  // The two directions of one round trip add up to the round trip the offset was measured from.
  const clock = updateClock(null, 100, 160, 1130)
  assert.equal(clock.offset, 1000)
  const there = hostToViewerMs(1130, 160, clock.offset) // the reply, seen the way a state would be
  assert.equal(there, 30)
  // A queue building in one direction moves that direction only.
  assert.equal(hostToViewerMs(1500, 760, 1000), 260)
  assert.equal(viewerToHostMs(toHostClock(700, 1000), 1725), 25)
  // Nonsense is null, not a number in the log.
  for (const args of [[NaN, 1, 0], [1, NaN, 0], [1, 2, NaN], [-1, 2, 0], [0, 1e9, 0], [6000, 1, 0], [0, 1e5, 0]]) assert.equal(oneWayDelayMs(...args), null, args.join())
  assert.equal(toHostClock(NaN, 1), null)
  assert.equal(viewerToHostMs(undefined, 5), null, 'a report from a copy that does not stamp it adds nothing')
})

test('DelayTally keeps the worst delay since the last sample, then starts over', () => {
  const tally = new DelayTally()
  assert.equal(tally.take(), null, 'nothing arrived')
  tally.add(12.34); tally.add(160.06); tally.add(30); tally.add(NaN); tally.add(null); tally.add(undefined)
  assert.equal(tally.take(), 160.1)
  assert.equal(tally.take(), null)
  tally.add(-3)
  assert.equal(tally.take(), -3, 'a small negative delay is logged as it is')
})

// ---------- connection state and ICE restarts ----------

class Peer extends EventTarget {
  constructor(config) { super(); this.config = config; this.connectionState = 'new'; this.iceConnectionState = 'new'; this.iceGatheringState = 'new'; this.signalingState = 'stable'; this.remoteDescription = null; this.restarts = 0 }
  getConfiguration() { return this.config }
  setConfiguration(config) { this.config = config }
  restartIce() { this.restarts++ }
  close() { this.connectionState = 'closed' }
}

test('connection-state lines say which state moved and from what; ICE restarts say why', () => {
  const lines = []
  const network = createNetwork({getIceServers: () => [], PeerConnection: Peer, record: (event, data) => lines.push({event, ...data})})
  const pc = new network.PeerConnection({})
  assert.equal(lines.length, 1)
  assert.equal(lines[0].change, undefined, 'the first line has nothing before it')
  pc.connectionState = 'connected'
  pc.dispatchEvent(new Event('connectionstatechange'))
  pc.iceConnectionState = 'disconnected'
  pc.dispatchEvent(new Event('iceconnectionstatechange'))
  pc.dispatchEvent(new Event('iceconnectionstatechange')) // unchanged: no new line
  const states = lines.filter((l) => l.event === 'peer-state')
  assert.equal(states.length, 3)
  assert.deepEqual(states[1].change, {on: 'conn', from: 'new', to: 'connected'})
  assert.deepEqual(states[2].change, {on: 'ice', from: 'new', to: 'disconnected'})
  assert.equal(states[2].remoteDescription, false, 'the fields the integration check reads are still there')

  pc.restartIce() // Trystero's own recovery
  pc.restartIce('reconnect')
  const restarts = lines.filter((l) => l.event === 'ice-restart')
  assert.deepEqual(restarts.map((l) => l.reason), ['transport', 'reconnect'])
  assert.equal(restarts[0].connection, states[0].connection)
  assert.equal(restarts[0].iceState, 'disconnected')
  assert.equal(pc.restarts, 2, 'and the browser still restarts')
})

test('a device named after its owner is logged without the owner', () => {
  assert.equal(stripPossessive("Headphones (Lenna's AirPods Pro)"), 'Headphones (AirPods Pro)')
  assert.equal(stripPossessive('Speakers (Aya’s Buds)'), 'Speakers (Buds)')
  assert.equal(stripPossessive("Rob's Headphones"), 'Headphones')
  assert.equal(stripPossessive('José María’s MacBook Pro Speakers'), 'MacBook Pro Speakers')
  assert.equal(stripPossessive('Speakers (Realtek(R) Audio)'), 'Speakers (Realtek(R) Audio)', 'nothing to strip')
  assert.equal(stripPossessive(null), '')
  const devices = [{kind: 'audiooutput', deviceId: 'default', label: "Default - Headphones (Lenna's AirPods Pro)", groupId: 'g'}]
  const picked = pickOutputDevice(devices)
  assert.equal(picked.label, 'Headphones (AirPods Pro)')
  assert.equal(picked.kind, 'bluetooth', 'and it is still recognised')
  assert.ok(!JSON.stringify(describeAudioOutput(devices, null)).includes('Lenna'))
})
