// A lossy, capacity-limited stand-in for a bad internet link, for `npm run bench --loss N / --link-kbps N`
// (scripts/bench.js). Real WebRTC, real packets: the bench windows' remote ICE candidates are pointed at
// UDP relays in this process, and a relay drops, or queues and delays, what it forwards.
//
// Tried first and did not work: libwebrtc's own fake network (field trial WebRTC-FakeNetworkSendConfig,
// via --force-fieldtrials, with and without the "*" prefix, on the command line and appended at runtime).
// Electron 44 / Chromium 152 accepts the switch and drops nothing: a loopback call with loss_percent:30
// came back with 0 lost of 402 packets. Chromium builds its WebRTC field trials from its own variations
// state, which Electron does not set up.
//
// How a relay sits between two windows: window A is told that window B's candidate (a host address H, port
// T) is H:F, where F is a "front" socket here bound to the same address H. A sends to F; the relay forwards
// from a per-client "back" socket (also on H) to H:T, so B sees a new peer-reflexive address (the back
// socket) and replies to it; the relay forwards the reply from F, the address A expects. Every packet
// either way passes one drop test. B's window does the same for A's candidates, so nothing finds the real
// ports and goes around the relay. All on one machine: the candidates are the machine's own addresses.
const dgram = require('node:dgram')

function createNetwork({lossPct = 0, linkKbps = 0, queuePackets = 50, random = Math.random, now = () => performance.now()} = {}) {
  const sockets = new Set()
  const relays = new Map()
  const shapers = new Map() // one queue per direction of a window's traffic
  const stats = {forwarded: 0, dropped: 0, queueDropped: 0, relays: 0}

  // One packet through one hop: dropped at random, or queued behind the link and delivered when its turn
  // on the wire is over. A full queue drops, as a real bottleneck does.
  function pass(direction, length, deliver) {
    if (lossPct > 0 && random() * 100 < lossPct) { stats.dropped++; return }
    if (!(linkKbps > 0)) { stats.forwarded++; deliver(); return }
    const shaper = shapers.get(direction) || {free: 0, queued: 0}
    shapers.set(direction, shaper)
    if (shaper.queued >= queuePackets) { stats.queueDropped++; return }
    const at = now()
    const done = Math.max(at, shaper.free) + (length * 8) / linkKbps // bits over kbit/s is ms
    shaper.free = done
    shaper.queued++
    setTimeout(() => { shaper.queued--; stats.forwarded++; deliver() }, Math.max(0, done - at))
  }

  function open(type = 'udp4') {
    const socket = dgram.createSocket(type)
    sockets.add(socket)
    socket.on('error', () => {})
    return socket
  }

  // The port a window with id `owner` should use for a remote candidate at `host` whose real port is `targetPort`.
  function relayFor(owner, host, targetPort) {
    const key = `${owner}:${host}:${targetPort}`
    if (relays.has(key)) return relays.get(key)
    const front = open()
    const backs = new Map()
    front.on('message', (message, from) => {
      const client = `${from.address}:${from.port}`
      let back = backs.get(client)
      if (!back) {
        back = open()
        back.bind(0, host)
        back.on('message', (reply) => pass(`to:${owner}`, reply.length, () => front.send(reply, from.port, from.address)))
        backs.set(client, back)
      }
      pass(`from:${owner}`, message.length, () => back.send(message, targetPort, host))
    })
    const ready = new Promise((resolve, reject) => {
      front.once('error', reject)
      front.bind(0, host, () => resolve(front.address().port))
    })
    relays.set(key, ready)
    stats.relays++
    return ready
  }

  function close() {
    for (const socket of sockets) try { socket.close() } catch {}
    sockets.clear()
    relays.clear()
  }

  // A burst of loss on an otherwise clean link (bench --variant=burst): the percentage can change while packets flow.
  function setLoss(pct) { lossPct = pct; options.lossPct = pct }
  const options = {lossPct, linkKbps, queuePackets}

  return {relayFor, close, stats, pass, setLoss, options}
}

module.exports = {createNetwork}
