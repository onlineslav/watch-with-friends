// Friends without a server. Every app waits in its own inbox room. Adding someone joins a room
// for just the two of you, plus their inbox until they confirm they got the request. Nothing a
// peer says is believed until it proves its username with a signed hello, so usernames can't be
// impersonated. `joinRoom` is Trystero's, injected so the protocol can be tested in memory.
import {normalizeUsername, sign, verifySigned} from './identity.mjs'
import {cleanDisplayName, cleanText} from './profile.mjs'
import {isId, messageLimiter} from './protocol.mjs'

const MAX_TITLE_LENGTH = 80
export const MAX_FRIENDS = 100
export const MAX_REQUESTS = 100
const ASK_TIMEOUT_MS = 120_000 // how long an ask to join waits for an answer, and an invite shows as sent

export const inboxRoomId = (username) => `inbox:${username}`

// What a friend says they're doing. Only kept while they're online.
export const cleanStatus = (status) => ({
  inRoom: Boolean(status?.inRoom),
  hosting: Boolean(status?.hosting),
  title: status?.hosting ? cleanText(status.title, MAX_TITLE_LENGTH) : null,
})

// A peer on the channel whose hello is still on its way or still being checked. One that has been
// checked and failed isn't proving anything, so it can't leave the list saying "Connecting…" forever.
const stillProving = (link) => [...link.connectedPeers].some((peerId) =>
  !link.peers.has(peerId) && (link.verifying.has(peerId) || !link.attempts.has(peerId)))

// The line under a friend's name.
export function presenceText({confirmed, requested, online, connecting, status, connectionError, delivery}) {
  if (!confirmed) {
    if (delivery === 'expired') return 'Request unanswered · retry to send again'
    if (delivery === 'declined') return 'Request declined'
    if (requested) return 'Request delivered · awaiting acceptance'
    return connectionError ? 'Could not deliver request · still trying' : 'Request queued · waiting for a connection'
  }
  // A peer is on the channel but hasn't proved who it is yet: they're there, just not confirmed.
  // Saying "offline" or blaming the connection would both be wrong, and both sides see this at once.
  if (!online && connecting) return 'Connecting…'
  if (!online && connectionError) return 'Connection unavailable · retrying'
  if (!online) return 'Offline'
  if (status?.hosting) return status.title ? `Hosting ${status.title}` : 'Hosting a room'
  if (status?.inRoom) return 'In a room'
  return 'Online'
}
export const pairRoomId = (a, b) => `pair:${[a, b].sort().join(':')}`
// Binding the room and both peer ids stops a hello being replayed anywhere else.
export const helloText = (roomId, fromPeer, toPeer) => `synced-video-player hello ${roomId} ${fromPeer} ${toPeer}`

const MAX_EARLY_MESSAGES = 10

export class FriendNetwork extends EventTarget {
  // storage: {load(key) -> value | null, save(key, value)}
  constructor({joinRoom, selfId, appId, storage, turnConfig = []}) {
    super()
    Object.assign(this, {joinRoom, selfId, appId, storage, turnConfig})
    this.identity = null
    this.profile = {}
    const saved = (key, limit) => {
      const value = storage.load(key)
      return (Array.isArray(value) ? value : []).filter((f) => normalizeUsername(f?.username) === f.username).slice(0, limit)
    }
    this.friends = new Map(saved('friends', MAX_FRIENDS).map((f) => [f.username, f]))
    this.requests = new Map(saved('friendRequests', MAX_REQUESTS).map((r) => [r.username, r]))
    this.closing = new Map()
    this.running = false
    this.incomingAsks = new Map()
    this.askIds = new Map()
    this.offerIds = new Map()
    const declined = storage.load('declinedRequests')
    this.declined = new Set((Array.isArray(declined) ? declined : []).filter((v) => normalizeUsername(v) === v).slice(0, MAX_REQUESTS))
    this.allowMessage = messageLimiter(10)
    this.requestTimer = null
    this.links = new Map() // roomId -> link
    this.online = new Map() // username -> {link, peerId}
    this.presence = new Map() // username -> cleanStatus(), from their latest profile
    this.asks = new Map() // username -> expiry timer, while waiting to hear if you can join
    this.invites = new Map() // username -> expiry timer, after inviting them into your room
  }

  start(identity, profile) {
    this.identity = identity
    this.profile = profile
    this.running = true
    clearInterval(this.requestTimer)
    this.requestTimer = setInterval(() => this.expireRequests(), 15_000)
    this.requestTimer.unref?.()
    this.syncRooms()
  }

  // A new username: everyone has to be asked again.
  restart(identity) {
    for (const roomId of [...this.links.keys()]) this.leave(roomId)
    for (const friend of this.friends.values()) Object.assign(friend, {confirmed: false, requested: false, delivery: null})
    this.save()
    this.start(identity, this.profile)
    this.changed()
  }

  stop() {
    this.running = false
    clearInterval(this.requestTimer)
    const pending = [...this.links.keys()].map((roomId) => this.leave(roomId))
    return Promise.allSettled(pending)
  }

  expireRequests(now = Date.now()) {
    let changed = false
    for (const friend of this.friends.values()) if (!friend.confirmed && friend.requested) {
      friend.requestedAt ||= now
      if (now - friend.requestedAt < ASK_TIMEOUT_MS) continue
      Object.assign(friend, {requested: false, delivery: 'expired'})
      changed = true
    }
    for (const [name, ask] of this.incomingAsks) if (ask.until < now) this.incomingAsks.delete(name)
    if (changed) { this.save(); this.syncRooms(); this.changed() }
  }

  retry(username) {
    const friend = this.friends.get(username)
    if (!friend || friend.confirmed) return
    Object.assign(friend, {requested: false, requestedAt: null, delivery: null})
    this.save()
    this.syncRooms()
    this.changed()
  }

  list() {
    return [...this.friends.values()].map((friend) => {
      const online = this.online.has(friend.username)
      const status = online ? this.presence.get(friend.username) || null : null
      const pair = this.links.get(pairRoomId(this.identity?.username, friend.username))
      const request = this.links.get(inboxRoomId(friend.username))
      const connecting = !online && Boolean(pair && stillProving(pair))
      const connectionError = !online && !connecting && (request?.error || pair?.error)
      const {requestedAt, ...shown} = friend
      return {...shown, online, status, asked: this.asks.has(friend.username), invited: this.invites.has(friend.username),
        ...(connecting && {connecting}), ...(connectionError && {connectionError})}
    })
  }

  // Asks a friend who's in a room to let you in. Returns an error message, or null when sent.
  askToJoin(username) {
    const entry = this.online.get(username)
    if (!entry) return "They're offline."
    clearTimeout(this.asks.get(username))
    const id = crypto.randomUUID()
    this.askIds.set(username, id)
    const timer = setTimeout(() => {
      if (this.forgetAsk(username)) this.emit('notice', {message: 'No answer to your join request. You can ask again.'})
    }, ASK_TIMEOUT_MS)
    timer.unref?.()
    this.asks.set(username, timer)
    entry.link.actions.join.send({type: 'ask', id}, {target: entry.peerId}).catch(() => { if (this.askIds.get(username) === id) { this.forgetAsk(username); this.emit('notice', {message: 'Could not send your join request. Try again.'}) } })
    this.changed()
    return null
  }

  // Answers a friend's ask with your room code, or null for no.
  answerJoin(username, code) {
    const entry = this.online.get(username)
    const ask = this.incomingAsks.get(username)
    if (!ask || ask.until < Date.now()) return
    this.incomingAsks.delete(username)
    const answer = code ? {type: 'invite', code, id: ask.id} : {type: 'declined', id: ask.id}
    entry?.link.actions.join.send(answer, {target: entry.peerId}).catch(() => {})
  }

  forgetAsk(username) {
    clearTimeout(this.asks.get(username))
    const asked = this.asks.delete(username)
    this.askIds.delete(username)
    if (asked) this.changed()
    return asked
  }

  // Invites a friend into the room you're in. It only shows them a card: they choose whether to come.
  // Returns an error message, or null when sent.
  inviteToRoom(username, code) {
    const entry = this.online.get(username)
    if (!entry) return "They're offline."
    clearTimeout(this.invites.get(username))
    const id = crypto.randomUUID()
    this.offerIds.set(username, id)
    const timer = setTimeout(() => { this.forgetInvite(username); this.emit('notice', {message: 'Your invitation expired. You can invite them again.'}) }, ASK_TIMEOUT_MS)
    timer.unref?.()
    this.invites.set(username, timer)
    entry.link.actions.join.send({type: 'offer', code, id}, {target: entry.peerId}).catch(() => { if (this.offerIds.get(username) === id) { this.forgetInvite(username); this.emit('notice', {message: 'Could not send your invitation. Try again.'}) } })
    this.changed()
    return null
  }

  forgetInvite(username) {
    clearTimeout(this.invites.get(username))
    this.offerIds.delete(username)
    if (this.invites.delete(username)) this.changed()
  }

  requestList() {
    return [...this.requests.values()]
  }

  // Returns an error message, or null when added.
  add(input) {
    const username = normalizeUsername(input)
    if (!username) return "That isn't a username. They look like moviefan#k7qm-x3pa."
    if (username === this.identity?.username) return "That's your own username."
    if (this.friends.has(username)) return 'Already in your friends.'
    if (this.friends.size >= MAX_FRIENDS) return 'Your friends list is full (100 people).'
    this.declined.delete(username)
    const name = this.requests.get(username)?.name ?? null
    this.friends.set(username, {username, name, confirmed: false, requested: false})
    this.requests.delete(username)
    this.save()
    this.syncRooms()
    this.changed()
    return null
  }

  remove(username) {
    this.friends.delete(username)
    this.goOffline(username)
    this.save()
    this.syncRooms()
    this.changed()
  }

  ignoreRequest(username) {
    this.declined.add(username)
    if (this.declined.size > MAX_REQUESTS) this.declined.delete(this.declined.values().next().value)
    this.requests.delete(username)
    this.save()
    this.changed()
  }

  updateProfile(profile) {
    this.profile = profile
    for (const {link, peerId} of this.online.values()) link.actions.profile.send(profile, {target: peerId}).catch(() => {})
  }

  // ---------- Rooms ----------

  syncRooms() {
    const me = this.identity?.username
    if (!me || !this.running) return
    const wanted = new Map([[inboxRoomId(me), {kind: 'inbox'}]])
    for (const friend of this.friends.values()) {
      wanted.set(pairRoomId(me, friend.username), {kind: 'pair', username: friend.username})
      if (!friend.confirmed && !friend.requested && !['expired', 'declined'].includes(friend.delivery)) wanted.set(inboxRoomId(friend.username), {kind: 'request', username: friend.username})
    }
    for (const roomId of [...this.links.keys()]) if (!wanted.has(roomId)) this.leave(roomId)
    for (const [roomId, purpose] of wanted) if (!this.links.has(roomId) && !this.closing.has(roomId)) this.join(roomId, purpose)
  }

  join(roomId, purpose) {
    const config = {appId: this.appId, password: roomId, ...(this.turnConfig.length && {turnConfig: this.turnConfig})}
    const link = {roomId, ...purpose, peers: new Map(), connectedPeers: new Set(), early: new Map(), actions: {}, error: null, verifying: new Set(), attempts: new Set()}
    const room = this.joinRoom(config, roomId, {onJoinError: ({error}) => {
      if (this.links.get(roomId) !== link) return
      link.error = error
      this.changed()
    }})
    link.room = room
    for (const name of ['hello', 'profile', 'request', 'ack', 'join']) link.actions[name] = room.makeAction(name)
    this.links.set(roomId, link)

    room.onPeerJoin = (peerId) => {
      if (this.links.get(roomId) !== link) return
      if (link.connectedPeers.size >= 32) { room.getPeers?.()[peerId]?.close(); return }
      // A failure is reported per peer attempt, so one stale peer id left on a relay must not
      // describe the channel for as long as it lasts. A peer connecting is the newer fact.
      link.error = null
      link.connectedPeers.add(peerId)
      this.sendHello(link, peerId).catch(() => {})
      if (link.kind === 'pair') this.changed()
    }
    room.onPeerLeave = (peerId) => {
      if (this.links.get(roomId) !== link) return
      link.connectedPeers.delete(peerId)
      if (!link.connectedPeers.size) link.error = null // a clean departure is not a connection fault
      const username = link.peers.get(peerId)
      link.peers.delete(peerId)
      link.early.delete(peerId)
      link.attempts.delete(peerId)
      link.verifying.delete(peerId)
      // A peer has the same id in every room; only leaving the room you're friends through counts.
      const entry = this.online.get(username)
      if (entry?.link === link && entry.peerId === peerId) {
        this.goOffline(username)
        this.changed()
      }
    }
    link.actions.hello.onMessage = async (hello, {peerId}) => {
      // The room caps connections at 32; verify each once without dropping a
      // legitimate hello just because other participants arrived together.
      if (this.links.get(roomId) !== link || !link.connectedPeers.has(peerId) || link.peers.has(peerId) || link.attempts.has(peerId)) return
      link.attempts.add(peerId)
      link.verifying.add(peerId)
      let genuine
      try { genuine = await verifySigned(hello, helloText(roomId, peerId, this.selfId)) }
      finally { link.verifying.delete(peerId) }
      if (!genuine || this.links.get(roomId) !== link || !link.connectedPeers.has(peerId) || link.peers.has(peerId)) return
      link.peers.set(peerId, hello.username)
      this.verified(link, peerId, hello.username)
      for (const replay of link.early.get(peerId) || []) replay()
      link.early.delete(peerId)
      link.attempts.delete(peerId)
      link.verifying.delete(peerId)
    }
    // Anything else waits until its sender's hello has been checked.
    const onVerified = (handler) => (data, {peerId}) => {
      if (this.links.get(roomId) !== link || !link.connectedPeers.has(peerId)) return
      if (!this.allowMessage(`${roomId}:${peerId}`)) return
      if (link.peers.has(peerId)) return handler(data, link.peers.get(peerId), peerId)
      const queue = link.early.get(peerId) || []
      if (queue.length < MAX_EARLY_MESSAGES) queue.push(() => handler(data, link.peers.get(peerId), peerId))
      link.early.set(peerId, queue)
    }
    link.actions.profile.onMessage = onVerified((profile, username) => {
      const friend = this.friends.get(username)
      if (link.kind !== 'pair' || username !== link.username || !friend) return
      const name = cleanDisplayName(profile?.name) ?? friend.name
      const changed = friend.name !== name
      friend.name = name
      this.presence.set(username, cleanStatus(profile?.status))
      if (changed) this.save()
      this.changed()
    })
    link.actions.request.onMessage = onVerified((request, username, peerId) => {
      if (link.kind !== 'inbox') return
      if (this.declined.has(username)) { link.actions.ack.send({declined: true}, {target: peerId}).catch(() => {}); return }
      if (!this.friends.has(username)) {
        if (!this.requests.has(username) && this.requests.size >= MAX_REQUESTS) return
        this.requests.set(username, {username, name: cleanDisplayName(request?.name)})
        this.save()
        this.changed()
      }
      link.actions.ack.send({}, {target: peerId}).catch(() => {})
    })
    link.actions.join.onMessage = onVerified((message, username) => {
      const friend = this.friends.get(username)
      if (link.kind !== 'pair' || username !== link.username || !friend?.confirmed) return
      const detail = {username, name: friend.name || username}
      if (message?.type === 'ask' && isId(message.id)) {
        this.incomingAsks.set(username, {id: message.id, until: Date.now() + ASK_TIMEOUT_MS})
        this.emit('join-ask', detail)
      }
      // Only an answer to your own ask counts, so nobody can pull you into a room.
      else if (message?.type === 'invite' && /^[A-Z0-9]{8}$/.test(message.code) && message.id === this.askIds.get(username) && this.forgetAsk(username)) {
        this.emit('join-invite', {...detail, code: message.code})
      } else if (message?.type === 'declined' && message.id === this.askIds.get(username) && this.forgetAsk(username)) this.emit('join-declined', detail)
      // An offer only asks the person; nothing happens unless they accept it.
      else if (message?.type === 'offer' && isId(message.id) && /^[A-Z0-9]{8}$/.test(message.code)) this.emit('join-offer', {...detail, code: message.code})
    })
    link.actions.ack.onMessage = onVerified((_ack, username) => {
      const friend = this.friends.get(username)
      if (link.kind !== 'request' || username !== link.username || !friend) return
      friend.requested = !_ack?.declined
      friend.requestedAt = Date.now()
      if (_ack?.declined) friend.delivery = 'declined'
      this.save()
      this.syncRooms()
      this.changed()
    })
  }

  leave(roomId) {
    const link = this.links.get(roomId)
    if (!link) return
    this.links.delete(roomId)
    for (const [username, entry] of this.online) if (entry.link === link) this.goOffline(username)
    const promise = Promise.resolve().then(() => link.room.leave()).catch(() => {}).finally(() => {
      if (this.closing.get(roomId) !== promise) return
      this.closing.delete(roomId)
      this.syncRooms()
    })
    this.closing.set(roomId, promise)
    return promise
  }

  goOffline(username) {
    this.online.delete(username)
    this.presence.delete(username)
    clearTimeout(this.asks.get(username))
    this.asks.delete(username)
    clearTimeout(this.invites.get(username))
    this.invites.delete(username)
    this.askIds.delete(username)
    this.offerIds.delete(username)
    this.incomingAsks.delete(username)
  }

  async sendHello(link, peerId) {
    const {username, publicKey} = this.identity
    const signature = await sign(this.identity, helloText(link.roomId, this.selfId, peerId))
    if (this.links.get(link.roomId) === link && link.connectedPeers.has(peerId)) link.actions.hello.send({username, publicKey, signature}, {target: peerId}).catch(() => {})
  }

  verified(link, peerId, username) {
    if (username !== link.username) return // strangers in a pair room or someone else's inbox
    link.error = null
    if (link.kind === 'request') {
      link.actions.request.send({name: this.profile.name}, {target: peerId}).catch(() => {})
    } else if (link.kind === 'pair') {
      const friend = this.friends.get(username)
      if (!friend) return
      this.online.set(username, {link, peerId})
      this.requests.delete(username)
      if (!friend.confirmed) {
        friend.confirmed = true
        this.save()
        this.syncRooms() // no need to keep asking
      }
      link.actions.profile.send(this.profile, {target: peerId}).catch(() => {})
      this.changed()
    }
  }

  save() {
    this.storage.save('friends', [...this.friends.values()])
    this.storage.save('friendRequests', [...this.requests.values()])
    this.storage.save('declinedRequests', [...this.declined])
  }

  changed() {
    this.dispatchEvent(new Event('change'))
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, {detail}))
  }
}
