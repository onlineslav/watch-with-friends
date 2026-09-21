import test from 'node:test'
import assert from 'node:assert/strict'
import {FriendNetwork, helloText, inboxRoomId, pairRoomId, presenceText} from '../renderer/friends.mjs'
import {createIdentity, sign, verifySigned} from '../renderer/identity.mjs'

// Trystero in memory: everyone in a room id is connected to everyone else in it.
function fakeTrystero() {
  const rooms = new Map()
  const joined = []
  const joinRoomAs = (selfId) => (_config, roomId, callbacks) => {
    const members = rooms.get(roomId) || new Map()
    rooms.set(roomId, members)
    joined.push([selfId, roomId])
    const room = {
      callbacks,
      actions: new Map(),
      onPeerJoin: null,
      onPeerLeave: null,
      makeAction(name) {
        const action = {
          onMessage: null,
          send: async (data, {target} = {}) => {
            for (const [id, other] of members) {
              if (id === selfId || (target && target !== id)) continue
              setTimeout(() => other.actions.get(name)?.onMessage?.(structuredClone(data), {peerId: selfId}))
            }
          },
        }
        room.actions.set(name, action)
        return action
      },
      async leave() {
        members.delete(selfId)
        for (const other of members.values()) setTimeout(() => other.onPeerLeave?.(selfId))
      },
    }
    for (const [id, other] of members) {
      setTimeout(() => {
        other.onPeerJoin?.(selfId)
        room.onPeerJoin?.(id)
      })
    }
    members.set(selfId, room)
    return room
  }
  return {joinRoomAs, rooms, joined}
}

const memoryStorage = () => {
  const data = new Map()
  return {load: (key) => structuredClone(data.get(key) ?? null), save: (key, value) => data.set(key, structuredClone(value))}
}

test('renaming with queued requests waits for old recipient inbox disposal', async () => {
  const occupied = new Map()
  const closing = []
  const joinRoom = (_config, id) => {
    if (occupied.has(id)) return occupied.get(id)
    const room = {makeAction: () => ({send: async () => {}}), leave: () => new Promise((resolve) => closing.push(() => { occupied.delete(id); resolve() }))}
    occupied.set(id, room)
    return room
  }
  const network = new FriendNetwork({joinRoom, selfId: 'me', appId: 'test', storage: memoryStorage()})
  network.start(await createIdentity('original'), {})
  const other = await createIdentity('friend')
  network.add(other.username)
  const id = inboxRoomId(other.username), old = network.links.get(id).room
  network.restart(await createIdentity('renamed'))
  assert.equal(network.links.has(id), false)
  await Promise.resolve()
  closing.splice(0).forEach((finish) => finish())
  await until(() => network.links.has(id), 'new inbox')
  assert.notEqual(network.links.get(id).room, old)
  network.stop()
  await Promise.resolve()
  closing.splice(0).forEach((finish) => finish())
})

test('late answers cannot complete a newer join request; failed sends allow retry', async () => {
  const net = fakeTrystero(), a = await person(net, 'a', 'A'), b = await person(net, 'b', 'B')
  a.friends.add(b.identity.username); b.friends.add(a.identity.username)
  await until(() => a.friends.online.size && b.friends.online.size, 'friends')
  let joined = 0
  a.friends.addEventListener('join-invite', () => joined++)
  a.friends.askToJoin(b.identity.username)
  const old = a.friends.askIds.get(b.identity.username)
  a.friends.forgetAsk(b.identity.username)
  a.friends.askToJoin(b.identity.username)
  const entry = b.friends.online.get(a.identity.username)
  await entry.link.actions.join.send({type: 'invite', id: old, code: 'ABCDEFGH'}, {target: entry.peerId})
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(joined, 0)
  assert.ok(a.friends.list()[0].asked)
  a.friends.online.get(b.identity.username).link.actions.join.send = async () => { throw new Error('disconnected') }
  a.friends.askToJoin(b.identity.username)
  await Promise.resolve()
  assert.equal(a.friends.list()[0].asked, false)
  await Promise.all([a.friends.stop(), b.friends.stop()])
})

test('unanswered delivered friend requests expire and can be retried', async () => {
  const net = fakeTrystero(), a = await person(net, 'a', 'A'), b = await person(net, 'b', 'B')
  a.friends.add(b.identity.username)
  await until(() => a.friends.list()[0].requested, 'delivered')
  a.friends.expireRequests(Date.now() + 120001)
  assert.equal(a.friends.list()[0].delivery, 'expired')
  assert.match(presenceText(a.friends.list()[0]), /retry/)
  a.friends.retry(b.identity.username)
  assert.equal(a.friends.list()[0].delivery, null)
  await Promise.all([a.friends.stop(), b.friends.stop()])
})

async function person(net, selfId, name) {
  const identity = await createIdentity('tester')
  const storage = memoryStorage()
  const friends = new FriendNetwork({joinRoom: net.joinRoomAs(selfId), selfId, appId: 'test', storage})
  friends.start(identity, {name})
  return {identity, friends, storage, selfId}
}

async function until(check, what) {
  for (let i = 0; i < 200; i++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail(`timed out waiting for ${typeof what === 'function' ? what() : what}`)
}

test('signed hellos prove a username and only for the room and peers they name', async () => {
  const me = await createIdentity('tester')
  const other = await createIdentity('tester')
  const text = helloText('pair:x', 'peerA', 'peerB')
  const hello = {username: me.username, publicKey: me.publicKey, signature: await sign(me, text)}
  assert.ok(await verifySigned(hello, text))
  assert.ok(!(await verifySigned(hello, helloText('pair:x', 'peerA', 'peerC'))), 'other peer')
  assert.ok(!(await verifySigned({...hello, username: other.username}, text)), 'someone else’s username')
  assert.ok(!(await verifySigned({...hello, publicKey: other.publicKey}, text)), 'someone else’s key')
  assert.ok(!(await verifySigned(undefined, text)))
})

test('adding someone sends a request they can accept, and then you are friends', async () => {
  const net = fakeTrystero()
  const alice = await person(net, 'a', 'Alice')
  const bob = await person(net, 'b', 'Bob')

  assert.equal(alice.friends.add(bob.identity.username.toUpperCase()), null)
  await until(() => bob.friends.requestList().length === 1, 'request')
  assert.deepEqual(bob.friends.requestList(), [{username: alice.identity.username, name: 'Alice'}])
  await until(() => alice.friends.list()[0].requested, 'request delivered')
  assert.ok(!net.rooms.get(`inbox:${bob.identity.username}`).has('a'), 'alice stops waiting in bob’s inbox')

  assert.equal(bob.friends.add(alice.identity.username), null)
  await until(
    () => alice.friends.list()[0]?.name === 'Bob' && bob.friends.list()[0]?.name === 'Alice',
    () => `friends connected: ${JSON.stringify({alice: alice.friends.list(), bob: bob.friends.list(), pair: [...(net.rooms.get(pairRoomId(alice.identity.username, bob.identity.username))?.keys() || [])], links: {a: [...alice.friends.links.keys()], b: [...bob.friends.links.keys()]}})}`,
  )
  assert.equal(alice.friends.list()[0].name, 'Bob')
  assert.equal(bob.friends.list()[0].name, 'Alice')
  assert.ok(alice.friends.list()[0].confirmed && bob.friends.list()[0].confirmed)
  assert.equal(bob.friends.requestList().length, 0)
  assert.deepEqual([...net.rooms.get(pairRoomId(alice.identity.username, bob.identity.username)).keys()].sort(), ['a', 'b'])

  // Names follow changes, and friends survive a restart from storage.
  alice.friends.updateProfile({name: 'Alice B'})
  await until(() => bob.friends.list()[0].name === 'Alice B', 'renamed')
  const restored = new FriendNetwork({joinRoom: () => ({}), selfId: 'b2', appId: 'test', storage: bob.storage})
  assert.equal(restored.list()[0].username, alice.identity.username)

  bob.friends.remove(alice.identity.username)
  await until(() => !alice.friends.list()[0].online, 'offline after removal')
  assert.equal(bob.friends.list().length, 0)
})

test('a peer claiming someone else’s username is ignored', async () => {
  const net = fakeTrystero()
  const alice = await person(net, 'a', 'Alice')
  const bob = await createIdentity('tester')
  alice.friends.add(bob.username)

  // Mallory knows both usernames and joins the pair room pretending to be Bob.
  const mallory = await createIdentity('tester')
  const room = net.joinRoomAs('m')({}, pairRoomId(alice.identity.username, bob.username))
  const hello = room.makeAction('hello')
  const profile = room.makeAction('profile')
  room.onPeerJoin = async (peerId) => {
    const signature = await sign(mallory, helloText(pairRoomId(alice.identity.username, bob.username), 'm', peerId))
    hello.send({username: bob.username, publicKey: mallory.publicKey, signature}, {target: peerId})
    profile.send({name: 'Totally Bob'}, {target: peerId})
  }
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.deepEqual(alice.friends.list(), [{username: bob.username, name: null, confirmed: false, requested: false, online: false, status: null, asked: false, invited: false}])
})

test('friends see each other online, in a room and hosting, and then offline', async () => {
  const net = fakeTrystero()
  const alice = await person(net, 'a', 'Alice')
  const bob = await person(net, 'b', 'Bob')
  alice.friends.add(bob.identity.username)
  bob.friends.add(alice.identity.username)
  await until(() => alice.friends.list()[0]?.online && bob.friends.list()[0]?.online, 'online')
  assert.equal(presenceText(bob.friends.list()[0]), 'Online')

  alice.friends.updateProfile({name: 'Alice', status: {inRoom: true}})
  await until(() => bob.friends.list()[0].status?.inRoom, 'in a room')
  assert.equal(presenceText(bob.friends.list()[0]), 'In a room')

  const title = `Heat${String.fromCharCode(0)}   (1995)`
  alice.friends.updateProfile({name: 'Alice', status: {inRoom: true, hosting: true, title}})
  await until(() => bob.friends.list()[0].status?.hosting, 'hosting')
  assert.equal(presenceText(bob.friends.list()[0]), 'Hosting Heat (1995)')

  alice.friends.stop()
  await until(() => !bob.friends.list()[0].online, 'offline')
  assert.equal(bob.friends.list()[0].status, null)
  assert.equal(presenceText(bob.friends.list()[0]), 'Offline')
})

test('asking to join a room: only an answer to your own ask counts', async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const net = fakeTrystero()
  const alice = await person(net, 'a', 'Alice')
  const bob = await person(net, 'b', 'Bob')
  alice.friends.add(bob.identity.username)
  bob.friends.add(alice.identity.username)
  await until(() => alice.friends.list()[0]?.name === 'Bob' && bob.friends.list()[0]?.name === 'Alice', 'friends')

  const events = []
  for (const [who, {friends}] of [['alice', alice], ['bob', bob]]) {
    for (const type of ['join-ask', 'join-invite', 'join-declined']) friends.addEventListener(type, ({detail}) => events.push([who, type, detail]))
  }

  bob.friends.answerJoin(alice.identity.username, 'ABCDEFGH')
  await sleep(50)
  assert.deepEqual(events, [], 'an invite nobody asked for is ignored')

  assert.equal(alice.friends.askToJoin(bob.identity.username), null)
  assert.ok(alice.friends.list()[0].asked)
  await until(() => events.length === 1, 'ask')
  assert.deepEqual(events[0], ['bob', 'join-ask', {username: alice.identity.username, name: 'Alice'}])
  bob.friends.answerJoin(alice.identity.username, 'ABCDEFGH')
  await until(() => events.length === 2, 'invite')
  assert.deepEqual(events[1], ['alice', 'join-invite', {username: bob.identity.username, name: 'Bob', code: 'ABCDEFGH'}])
  assert.ok(!alice.friends.list()[0].asked)

  alice.friends.askToJoin(bob.identity.username)
  await until(() => events.length === 3, 'second ask')
  bob.friends.answerJoin(alice.identity.username, null)
  bob.friends.answerJoin(alice.identity.username, 'ABCDEFGH')
  await until(() => events.length === 4, 'declined')
  await sleep(50)
  assert.deepEqual(events.slice(3).map(([who, type]) => [who, type]), [['alice', 'join-declined']], 'a second answer is ignored')

  assert.equal(alice.friends.askToJoin('nobody#0000-0000'), "They're offline.")
  alice.friends.stop()
  bob.friends.stop()
})

test('inviting a friend into your room only offers it, and they choose', async () => {
  const net = fakeTrystero()
  const alice = await person(net, 'a', 'Alice')
  const bob = await person(net, 'b', 'Bob')
  alice.friends.add(bob.identity.username)
  bob.friends.add(alice.identity.username)
  await until(() => alice.friends.list()[0]?.name === 'Bob' && bob.friends.list()[0]?.name === 'Alice', 'friends')

  const offers = []
  bob.friends.addEventListener('join-offer', ({detail}) => offers.push(detail))
  bob.friends.addEventListener('join-invite', () => assert.fail('an offer must not count as an answer to an ask'))
  assert.equal(alice.friends.inviteToRoom(bob.identity.username, 'ABCDEFGH'), null)
  assert.ok(alice.friends.list()[0].invited)
  await until(() => offers.length === 1, 'offer')
  assert.deepEqual(offers[0], {username: alice.identity.username, name: 'Alice', code: 'ABCDEFGH'})

  assert.equal(alice.friends.inviteToRoom('nobody#0000-0000', 'ABCDEFGH'), "They're offline.")
  alice.friends.stop()
  bob.friends.stop()
})

test('presenceText explains friends who have not added you back yet', () => {
  assert.equal(presenceText({confirmed: false, requested: true}), 'Request delivered · awaiting acceptance')
  assert.equal(presenceText({confirmed: false, requested: false}), 'Request queued · waiting for a connection')
  assert.equal(presenceText({confirmed: false, connectionError: 'failed'}), 'Could not deliver request · still trying')
  assert.equal(presenceText({confirmed: true, online: false, connectionError: 'failed'}), 'Connection unavailable · retrying')
  // A peer that is on the channel but not yet verified is neither offline nor a connection fault.
  assert.equal(presenceText({confirmed: true, online: false, connecting: true, connectionError: 'failed'}), 'Connecting…')
  assert.equal(presenceText({confirmed: true, online: true, connectionError: 'old error'}), 'Online')
  assert.equal(presenceText({confirmed: true, online: true, status: {hosting: true, title: null}}), 'Hosting a room')
})

test('an offline recipient gets a queued request after the sender restarts', async (t) => {
  const net = fakeTrystero()
  const alice = await person(net, 'a', 'Alice')
  const bobIdentity = await createIdentity('tester')
  alice.friends.add(bobIdentity.username)
  assert.equal(alice.friends.list()[0].requested, false)
  alice.friends.stop()

  const sender = new FriendNetwork({joinRoom: net.joinRoomAs('a2'), selfId: 'a2', appId: 'test', storage: alice.storage})
  sender.start(alice.identity, {name: 'Alice'})
  const recipient = new FriendNetwork({joinRoom: net.joinRoomAs('b'), selfId: 'b', appId: 'test', storage: memoryStorage()})
  t.after(() => {sender.stop(); recipient.stop()})
  recipient.start(bobIdentity, {name: 'Bob'})
  await until(() => recipient.requestList().length === 1, 'offline request delivered')
  await until(() => sender.list()[0].requested, 'delivery acknowledged')
  assert.equal(sender.list()[0].confirmed, false)
  assert.equal(recipient.requestList()[0].username, alice.identity.username)
})

test('a received request survives restart and accepting it makes both friends online', async (t) => {
  const net = fakeTrystero()
  const alice = await person(net, 'a', 'Alice')
  const bob = await person(net, 'b', 'Bob')
  alice.friends.add(bob.identity.username)
  await until(() => bob.friends.requestList().length === 1 && alice.friends.list()[0].requested, 'request stored and acknowledged')
  bob.friends.stop()

  const restored = new FriendNetwork({joinRoom: net.joinRoomAs('b2'), selfId: 'b2', appId: 'test', storage: bob.storage})
  t.after(() => {alice.friends.stop(); restored.stop()})
  assert.equal(restored.requestList()[0].username, alice.identity.username)
  restored.start(bob.identity, {name: 'Bob'})
  restored.add(alice.identity.username)
  await until(() => restored.list()[0].online && alice.friends.list()[0].online, 'friends after accepting restored request')
  assert.equal(restored.requestList().length, 0)
  assert.deepEqual(bob.storage.load('friendRequests'), [])
})

test('friend connection failures are visible and clear when the friend connects', async (t) => {
  const net = fakeTrystero()
  const alice = await person(net, 'a', 'Alice')
  const bob = await person(net, 'b', 'Bob')
  t.after(() => {alice.friends.stop(); bob.friends.stop()})
  alice.friends.add(bob.identity.username)
  const requestRoom = alice.friends.links.get(inboxRoomId(bob.identity.username)).room
  requestRoom.callbacks.onJoinError({error: 'could not connect after exchanging SDP'})
  assert.match(presenceText(alice.friends.list()[0]), /Could not deliver/)
  assert.equal(alice.friends.list()[0].requested, false)
  await until(() => alice.friends.list()[0].requested, 'request succeeds later')
  assert.equal(alice.friends.list()[0].connectionError, undefined)
  bob.friends.add(alice.identity.username)
  await until(() => alice.friends.list()[0].online && bob.friends.list()[0].online, 'connected')
  alice.friends.inviteToRoom(bob.identity.username, 'ABCDEFGH')
  assert.equal(alice.friends.list()[0].invited, true)
  bob.friends.stop()
  await until(() => !alice.friends.list()[0].online, 'friend offline')
  assert.equal(alice.friends.list()[0].invited, false)
  const pair = alice.friends.links.get(pairRoomId(alice.identity.username, bob.identity.username)).room
  pair.callbacks.onJoinError({error: 'failed to reconnect'})
  assert.equal(presenceText(alice.friends.list()[0]), 'Connection unavailable · retrying')
  alice.friends.remove(bob.identity.username)
  let changes = 0
  alice.friends.addEventListener('change', () => changes++)
  pair.callbacks.onJoinError({error: 'late error after removal'})
  assert.equal(changes, 0)
})

test('a hello still being verified when a peer leaves cannot mark them online', async (t) => {
  const net = fakeTrystero()
  const alice = await person(net, 'a', 'Alice')
  t.after(() => alice.friends.stop())
  const bob = await createIdentity('tester')
  alice.friends.add(bob.username)
  const roomId = pairRoomId(alice.identity.username, bob.username)
  const link = alice.friends.links.get(roomId)
  link.room.onPeerJoin('b')
  const hello = {username: bob.username, publicKey: bob.publicKey, signature: await sign(bob, helloText(roomId, 'b', 'a'))}
  const verifying = link.actions.hello.onMessage(hello, {peerId: 'b'})
  link.room.onPeerLeave('b')
  await verifying
  assert.equal(alice.friends.list()[0].online, false)
  assert.equal(alice.friends.list()[0].confirmed, false)
})

test('add rejects bad input', async () => {
  const net = fakeTrystero()
  const alice = await person(net, 'a', 'Alice')
  assert.match(alice.friends.add('hello'), /isn't a username/)
  assert.match(alice.friends.add(alice.identity.username), /your own/)
  const other = (await createIdentity('tester')).username
  assert.equal(alice.friends.add(other), null)
  assert.match(alice.friends.add(other), /Already/)
  alice.friends.stop()
})
