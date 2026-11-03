const test = require('node:test')
const assert = require('node:assert/strict')
const dgram = require('node:dgram')
const {createNetwork} = require('../scripts/bench-net')

const bind = (socket) => new Promise((resolve) => socket.bind(0, '127.0.0.1', () => resolve(socket.address().port)))
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// A seeded generator so the tests count the same packets every time.
function seeded(seed) {
  let s = seed
  return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296 }
}

async function through(network, count, {size = 100, wait = 300} = {}) {
  const target = dgram.createSocket('udp4')
  const client = dgram.createSocket('udp4')
  let arrived = 0
  let replies = 0
  target.on('message', (message, from) => { arrived++; target.send(message, from.port, from.address) })
  client.on('message', () => replies++)
  const targetPort = await bind(target)
  await bind(client)
  const front = await network.relayFor('a', '127.0.0.1', targetPort)
  assert.notEqual(front, targetPort, 'the window is told another port than the real one')
  for (let i = 0; i < count; i++) client.send(Buffer.alloc(size, i), front, '127.0.0.1')
  await pause(wait)
  target.close()
  client.close()
  return {arrived, replies}
}

test('a relay with no loss and no cap passes everything, both ways', async () => {
  const network = createNetwork()
  const {arrived, replies} = await through(network, 50)
  network.close()
  assert.deepEqual({arrived, replies}, {arrived: 50, replies: 50})
})

test('loss drops about that share at each hop, and the drops are counted', async () => {
  const network = createNetwork({lossPct: 30, random: seeded(7)})
  const {arrived, replies} = await through(network, 600)
  network.close()
  assert.ok(arrived > 600 * 0.6 && arrived < 600 * 0.8, `arrived ${arrived}`)
  assert.ok(replies < arrived && replies > arrived * 0.6, `replies ${replies} of ${arrived}`)
  assert.ok(network.stats.dropped > 200)
})

test('a capped link spreads packets over time and drops what does not fit its queue', async () => {
  // 40 x 1000 bytes into 800 kbps is 400ms of wire; a queue of 10 keeps 10 and drops the rest.
  const network = createNetwork({linkKbps: 800, queuePackets: 10})
  const early = await through(network, 40, {size: 1000, wait: 150})
  assert.ok(early.arrived < 40, `arrived ${early.arrived}`)
  assert.ok(network.stats.queueDropped >= 20, `queue drops ${network.stats.queueDropped}`)
  network.close()
})

test('one relay per window and target, so a candidate is always pointed at the same port', async () => {
  const network = createNetwork()
  const a = await network.relayFor('w1', '127.0.0.1', 40000)
  assert.equal(await network.relayFor('w1', '127.0.0.1', 40000), a)
  assert.notEqual(await network.relayFor('w2', '127.0.0.1', 40000), a)
  network.close()
})
