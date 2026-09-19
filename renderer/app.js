import {joinRoom, selfId} from 'trystero'
import {PROTOCOL, MAX_PEERS, HOST_TIMEOUT_MS, isRevision, nextRevision, sameClaim, newerClaim, acceptsState, cleanState, cleanTelemetry, cleanCues, validCommand, SubtitleCatalog, messageLimiter, sessionHandler} from './protocol.mjs'
import {createNetwork} from './network.mjs'
import {authenticateRoomPeer} from './room-auth.mjs'
import {estimatedMediaTime, updateClock, chooseSendQuality, aggregateLinks} from './sync.mjs'
import {
  errorMessage,
  formatRoomCode,
  formatTime,
  generateRoomCode,
  isImageMime,
  isImagePath,
  MAX_IMAGE_BYTES,
  normalizeRoomCode,
  preferHighStartBitrate,
  preferStereoOpus,
} from './lib.mjs'
import {captureVideoFrames} from './frames.mjs'
import {StreamPlayer} from './player.mjs'
import {YouTubePlayer} from './youtube.mjs'
import {parseYouTubeUrl, droppedYouTubeUrl} from '../shared/youtube.mjs'
import {roomConnection} from './connection.mjs'
import {FriendNetwork, presenceText} from './friends.mjs'
import {HANDLE_HINT, createIdentity, createKeys, isValidIdentity, normalizeHandle, normalizeUsername, usernameFor} from './identity.mjs'
import {cleanDisplayName, cleanText} from './profile.mjs'
import {cleanRoomDetails, MAX_ROOM_NAME_LENGTH, newerRoomDetails, renameRoom} from './room-name.mjs'
import {RoomHistory} from './room-history.mjs'
import {RoomPresence} from './room-presence.mjs'
import {drawConfetti, launchConfetti, stepConfetti} from './confetti.mjs'
import {FILTERS, FILTER_IDS, cleanFilterId} from './filters.mjs'
import {FaceTracker, captureElement} from './faces.mjs'
import {FilterRenderer} from './filter-gl.mjs'
import {REACTIONS, createRateLimiter, playReactionSound} from './reactions.mjs'
import {clampZoom, stepZoom, parseZoom, formatZoom, zoomPercent, MIN_ZOOM, MAX_ZOOM, DEFAULT_ZOOM} from './zoom.mjs'
import {captionHtml} from './subtitles.mjs'
import {
  DRAWER,
  MAX_ITEMS,
  MAX_REMOVED,
  addItem,
  createPlaylist,
  draggedWidth,
  maxDrawerWidth,
  mergePlaylist,
  nextItem,
  orderedItems,
  playlistSnapshot,
  clampDrag,
  dropIndex,
  slotShift,
  endPosition,
  moveItem,
  positionAt,
  removeItem,
  recordProgress,
  settledWidth,
} from './playlist.mjs'
import {averageLuminance, sourceRegion, toneFor} from './overlay.mjs'
import {
  BRUSH_SIZES,
  COLORS,
  addStrokeChunk,
  boardSnapshot,
  clearBoard,
  createBoard,
  orderedStrokes,
  MAX_COORDINATES,
  drawStroke,
  ERASER,
  mergeSnapshot,
  pictureRect,
} from './whiteboard.mjs'
import {
  MIN_BUFFER_MS,
  adaptBuffer,
  describeLink,
  describePeer,
  inboundDelta,
  isSteady,
  isTroubled,
  nextSteady,
  readStats,
} from './telemetry.mjs'

const APP_ID = 'synced-video-player-7c1e4b-v2'
const STATE_INTERVAL_MS = 1000
const VIDEO_MAX_BITRATE = 10_000_000
const AUDIO_MAX_BITRATE = 256_000
const MAX_STREAM_WIDTH = 1920
const TELEMETRY_INTERVAL_MS = 2000
const SUBTITLE_FILE = /\.(srt|ass|ssa|vtt)$/i
const LOAD_SUBTITLE = '__load__'
const LOCAL_SUBTITLE = 'local:' // a subtitle file only this person loaded
const CUES_TIMEOUT_MS = 180_000 // reading a track out of a large file can take a while
const DECODE_DELAY_MS = 40
const CHROME_IDLE_MS = 2500

// The host's encoder follows hints in the viewer's SDP; both sides run this app.
const setRemoteDescription = RTCPeerConnection.prototype.setRemoteDescription
RTCPeerConnection.prototype.setRemoteDescription = function (description, ...rest) {
  if (description?.sdp) {
    description = {type: description.type, sdp: preferHighStartBitrate(preferStereoOpus(description.sdp))}
  }
  return setRemoteDescription.call(this, description, ...rest)
}

// VP8, WebRTC's default, is encoded in software; H.264 gets hardware encode/decode on both
// Mac and Windows, leaving the host's CPU for playback and conversion.
function preferH264(pc) {
  const codecs = RTCRtpReceiver.getCapabilities?.('video')?.codecs
  if (!codecs) return
  const isH264 = (c) => c.mimeType.toLowerCase() === 'video/h264'
  const ordered = [...codecs.filter(isH264), ...codecs.filter((c) => !isH264(c))]
  for (const transceiver of pc.getTransceivers()) {
    if (transceiver.receiver.track?.kind !== 'video') continue
    try {
      transceiver.setCodecPreferences(ordered)
    } catch {}
  }
}
for (const method of ['createOffer', 'createAnswer', 'setLocalDescription']) {
  const original = RTCPeerConnection.prototype[method]
  RTCPeerConnection.prototype[method] = function (...args) {
    preferH264(this)
    return original.apply(this, args)
  }
}

const $ = (id) => document.getElementById(id)
const ui = {
  startup: $('startup'),
  startupStatus: $('startup-status'),
  welcome: $('welcome'),
  welcomeForm: $('welcome-form'),
  welcomeTitle: $('welcome-title'),
  welcomeLede: $('welcome-lede'),
  handle: $('handle'),
  handleTag: $('handle-tag'),
  handleHint: $('handle-hint'),
  welcomeName: $('welcome-name'),
  welcomeSubmit: $('welcome-submit'),
  welcomeCancel: $('welcome-cancel'),
  home: $('home'),
  appVersion: $('app-version'),
  savedRooms: $('saved-rooms'),
  savedRoomItems: $('saved-room-items'),
  roomSaveError: $('room-save-error'),
  profileAvatar: $('profile-avatar'),
  profileName: $('profile-name'),
  username: $('username'),
  newUsername: $('new-username'),
  openSettings: $('open-settings'),
  roomSettings: $('room-settings'),
  friendsToggles: document.querySelectorAll('.friends-toggle'),
  friends: $('friends'),
  homeInvites: $('home-invites'),
  inviteFriends: $('invite-friends'),
  pinButtons: document.querySelectorAll('[data-pin]'),
  settings: $('settings'),
  zoomRow: document.querySelector('.zoom-row'),
  zoomSlider: $('zoom-slider'),
  zoomPercent: $('zoom-percent'),
  zoomReset: $('zoom-reset'),
  zoomBadge: $('zoom-badge'),
  settingsUsername: $('settings-username'),
  settingsBack: $('settings-back'),
  addFriend: $('add-friend'),
  friendUsername: $('friend-username'),
  friendError: $('friend-error'),
  friendRequests: $('friend-requests'),
  friendRequestsTitle: $('friend-requests-title'),
  friendNotification: $('friend-notification'),
  friendNotificationText: $('friend-notification-text'),
  reviewFriendRequests: $('review-friend-requests'),
  friendsOnline: $('friends-online'),
  friendList: $('friend-list'),
  friendsEmpty: $('friends-empty'),
  joinRequests: $('join-requests'),
  reactions: $('reactions'),
  reactionsToggle: $('reactions-toggle'),
  reactionFeed: $('reaction-feed'),
  confetti: $('confetti'),
  create: $('create'),
  joinForm: $('join-form'),
  joinCode: $('join-code'),
  room: $('room'),
  code: $('code'),
  peerStatus: $('peer-status'),
  link: $('link'),
  linkWarning: $('link-warning'),
  linkWarningTip: $('link-warning-tip'),
  pausedTitle: $('paused-title'),
  role: $('role'),
  peopleToggle: $('people-toggle'),
  peopleCount: $('people-count'),
  people: $('people'),
  roomNameForm: $('room-name-form'),
  roomName: $('room-name'),
  boardMenu: $('board-menu'),
  filterMenu: $('filter-menu'),
  filterToggle: $('filter-toggle'),
  filterTools: $('filter-tools'),
  filterCanvas: $('filter-canvas'),
  boardToggle: $('board-toggle'),
  boardVisibility: $('board-visibility'),
  board: $('board'),
  pen: $('pen'),
  swatches: $('swatches'),
  sizes: $('sizes'),
  boardClear: $('board-clear'),
  eraser: $('eraser'),
  playlist: $('playlist'),
  playlistTab: $('playlist-tab'),
  playlistEdge: $('playlist-edge'),
  playlistAdd: $('playlist-add'),
  playlistAddArea: $('playlist-add-area'),
  playlistUrlReveal: $('playlist-url-reveal'),
  playlistAddUrl: $('playlist-add-url'),
  playlistUrlForm: $('playlist-url-form'),
  playlistUrlStatus: $('playlist-url-status'),
  playlistItems: $('playlist-items'),
  playlistEmpty: $('playlist-empty'),
  openButtons: document.querySelectorAll('[data-open-media]'),
  audioOnly: $('audio-only'),
  audioOnlyTitle: $('audio-only-title'),
  leave: $('leave'),
  stage: $('stage'),
  localVideo: $('local-video'),
  youtubePlayer: $('youtube-player'),
  mediaUrlForm: $('media-url-form'),
  mediaUrl: $('media-url'),
  mediaUrlStatus: $('media-url-status'),
  remoteVideo: $('remote-video'),
  picture: $('picture'),
  captions: $('captions'),
  emptyText: $('empty-text'),
  spinner: $('spinner'),
  toast: $('toast'),
  controls: $('controls'),
  play: $('play'),
  loop: $('loop'),
  time: $('time'),
  seek: $('seek'),
  duration: $('duration'),
  audio: $('audio-select'),
  subtitles: $('subtitle-select'),
  volume: $('volume'),
  volumeControl: $('volume-control'),
  volumeReadout: $('volume-readout'),
  mute: $('mute'),
  fullscreen: $('fullscreen'),
}

const player = new StreamPlayer(ui.localVideo)
const youtube = new YouTubePlayer(ui.youtubePlayer)

const blankSession = () => ({
  code: null,
  details: null,
  detailsAction: null,
  closed: false,
  lifetime: new AbortController(),
  ownFiles: new Map(),
  availableFiles: new Set(),
  peerFiles: new Map(),
  identities: new Map(),
  openingMedia: false,
  preview: false, // a restored, paused local view; never claims the room until Play
  observed: null,
  restorePending: null,
  catalog: new SubtitleCatalog(),
  authority: null,
  sequence: 0,
  mediaError: null,
  sendPending: false,
  sendDirty: false,
  imageSend: null,
  imageTransfers: new Map(),
  imageRetryAt: 0,
  receiveLimits: messageLimiter(),
  clock: null,
  sampling: false,
  frameDelayMs: null,
  lastFrameAt: 0,
  room: null,
  connection: {joining: false, connectedBefore: false, waitingSince: 0, error: null, hasTurn: false},
  stateAction: null,
  commandAction: null,
  peers: new Set(),
  peerStreams: new Map(),
  people: new Map(), // peerId -> {name, rttMs, relayed, receiver}
  profileAction: null,
  boardAction: null,
  board: createBoard(),
  filterAction: null,
  filter: null, // the face filter everyone in the room is seeing, or null
  filterAt: 0, // revision of the last filter change, so the newer choice wins
  reactAction: null,
  role: 'idle', // 'idle' | 'host' | 'viewer'
  hostId: null,
  claimedAt: 0,
  loop: false, // shared: the host restarts the video when it ends, and whoever hosts next keeps it
  remote: null, // latest host state, for viewers
  stream: null, // outgoing stream, for the host
  captured: null, // video.captureStream() backing it
  seeking: false,
  telemetryAction: null,
  link: null, // {rttMs, relayed, sender, receiver} for the connection badge
  lastInbound: null,
  buffer: {bufferMs: MIN_BUFFER_MS, calmMs: 0},
  epoch: 0, // host: bumps whenever ffmpeg restarts, so viewers can tell a restart from a freeze
  steady: {since: null, epoch: 0}, // viewer: when the host's playback last became uninterrupted
  playoutDelayMs: null, // viewer: how far the picture trails the host's clock
  cuesAction: null,
  captions: {mediaKey: null, id: null, cues: [], token: null}, // this person's own text subtitles
  localSubtitles: [], // subtitle files only this person loaded
  imageAction: null,
  image: null, // host: the picture being shown {id, name, mime, bytes, url}
  images: new Map(), // peerId -> {id, url}: the last picture each host sent
  imageProgress: null, // viewer: {id, percent} while a picture is arriving
  playlistAction: null,
  playlist: createPlaylist(),
  playing: null, // host: the playlist item being hosted {id, at}, so the next one can follow it
})
let session = blankSession()
let roomHistory = null

function saveRoom() {
  if (!session.code || !roomHistory) return
  rememberObservedPlayback()
  try {
    roomHistory.save(session)
    ui.roomSaveError.hidden = true
  } catch {
    ui.roomSaveError.hidden = false
    if (!session.saveErrorShown) toast('Could not save this room on this device.', true)
    session.saveErrorShown = true
  }
}

function rememberObservedPlayback() {
  const id = isHost() ? session.playing?.id : session.remote?.playlistId
  if (!id || !session.playlist.items.has(id) || session.openingMedia || session.mediaError ||
      (isHost() ? !player.loaded && !youtube.loaded && !session.image : !session.remote || session.remote.loading || session.remote.ended)) return
  const duration = currentDuration()
  if (youtube.videoId && !youtube.duration) return // the embed has not cued the saved position yet
  const time = youtube.videoId ? youtube.time : currentTime()
  session.observed = {id, time: Math.max(0, Math.min(time, duration || time)), duration}
}

function restoreObservedPlayback() {
  const saved = session.restorePending
  if (session.closed || session.role !== 'idle' || session.authority) return
  const local = (item) => item && (item.youtubeId || (item.owner === identity.username && session.availableFiles.has(item.id)))
  const observed = session.playlist.items.get(saved?.id)
  const item = local(observed) ? observed : [resumeItem(), ...orderedItems(session.playlist)].find(local)
  if (!item) return
  const start = item.id === saved?.id ? saved.time : undefined
  // A local preview cannot retrieve another person's file or command their player.
  if (item.youtubeId) hostYouTube(item, {preview: true, start})
  else if (item.owner === identity.username && session.availableFiles.has(item.id)) {
    hostFile(session.ownFiles.get(item.id), item, {preview: true, start})
  }
}

function activatePreview() {
  if (!session.preview || session.closed) return
  session.preview = false
  session.claimedAt = nextRevision(session.claimedAt, session.playlist.revision)
  session.authority = {hostId: selfId, claimedAt: session.claimedAt, sequence: 0}
  session.sequence = 0
  if (session.image) { session.image.id = String(session.claimedAt); sendImage() }
  else if (player.loaded) publishStream()
  broadcastState()
}

function renderSavedRooms() {
  const rooms = roomHistory?.list() || []
  ui.savedRooms.hidden = !rooms.length
  ui.savedRoomItems.replaceChildren(...rooms.map((saved) => {
    const row = element('li', 'saved-room')
    const open = element('button', 'saved-room-open sheen')
    open.dataset.code = saved.code
    const current = saved.playlist.items.get(saved.playlist.current?.id)
    const progress = current && saved.playlist.progress.get(current.id)
    open.append(element('strong', '', saved.details?.name || 'Saved room'),
      element('span', 'hint', `${saved.playlist.items.size} items`),
      element('span', 'saved-room-members hint'))
    if (current) open.append(element('span', 'hint', `${current.title} · ${progress?.completed ? 'Finished' : formatTime(progress?.time || 0)}`))
    open.addEventListener('click', () => enterRoom(saved.code, {joining: false}))
    const leave = element('button', 'saved-room-leave ghost', '×')
    const roomName = saved.details?.name || 'this room'
    leave.title = `Leave ${roomName}`
    leave.setAttribute('aria-label', `Leave ${roomName}`)
    leave.addEventListener('click', () => leaveSavedRoom(saved.code, roomName))
    row.append(open, leave)
    return row
  }))
  renderRoomMembers()
}

async function leaveSavedRoom(code, roomName) {
  const dialog = $('leave-room-dialog')
  if (dialog.open) return
  const history = roomHistory
  $('leave-room-name').textContent = roomName
  dialog.returnValue = 'cancel'
  const answer = new Promise((resolve) => dialog.addEventListener('close', () => resolve(dialog.returnValue), {once: true}))
  dialog.showModal()
  if (await answer !== 'leave' || roomHistory !== history || session.code === code) return
  try {
    roomHistory.remove(code)
    ui.roomSaveError.hidden = true
    updateRoomPresence()
    renderSavedRooms()
    const nextButton = ui.savedRoomItems.querySelector('.saved-room-leave') || ui.create
    nextButton.focus()
  } catch {
    ui.roomSaveError.hidden = false
  }
}

function renderRoomMembers() {
  for (const card of ui.savedRoomItems.querySelectorAll('.saved-room-open')) {
    const {members, error} = roomPresence.list(card.dataset.code)
    const label = card.querySelector('.saved-room-members')
    label.textContent = members.length ? `In room: ${members.map((member) => member.name || member.username).join(', ')}`
      : error ? 'Presence unavailable' : 'No one connected'
  }
}

function updateRoomPresence() {
  if (!identity || roomPresence.identity !== identity) return
  const activeCode = session.room && !session.closed ? session.code : null
  roomPresence.update(activeCode ? [activeCode] : roomHistory.codes(), activeCode, myName)
}

// ---------- Room ----------

let enteringRoom = false
let leavingRoom = null
async function enterRoom(code, {joining = true} = {}) {
  if (leavingRoom) await leavingRoom
  if (enteringRoom || session.room) return
  enteringRoom = true
  ui.create.disabled = ui.joinForm.querySelector('button').disabled = true
  try {
    await openRoom(code, joining)
  } catch (error) {
    if (session.room) await leaveRoom()
    toast(`Could not open the room: ${errorMessage(error)}`, true)
  } finally {
    enteringRoom = false
    ui.create.disabled = ui.joinForm.querySelector('button').disabled = false
  }
}

async function openRoom(code, joining) {
  await network.ready
  if (!identity) throw new Error('Finish setting up your profile first')
  const saved = roomHistory.load(code)
  if (saved) joining = false
  const {turnConfig} = network.config()
  const peerIdentities = new Map()
  const verifying = new Set()
  const connection = {
    joining, persistent: Boolean(saved || !joining), connectedBefore: false, waitingSince: performance.now(), error: null,
    hasTurn: turnConfig.some(({urls}) => [].concat(urls).some((url) => /^turns?:/i.test(url))),
  }
  // Keep one transport appId so friends, presence and media reuse an established
  // connection. The room ID isolates the persistent protocol from older rooms.
  const room = joinRoom({appId: APP_ID, password: code, ...network.config()}, `persistent:${code}`, {
    onPeerHandshake: async (peerId, send, receive) => {
      if (verifying.size + peerIdentities.size >= MAX_PEERS) throw new Error('Room is full (8 people)')
      verifying.add(peerId)
      try {
        const username = await authenticateRoomPeer(identity, selfId, code, peerId, send, receive)
        peerIdentities.set(peerId, username)
      } finally { verifying.delete(peerId) }
    },
    onJoinError: ({error, peerId}) => {
      if (peerId) { peerIdentities.delete(peerId); verifying.delete(peerId) }
      connection.error = error
      if (session.connection === connection) render()
    },
  })
  session = {
    ...blankSession(),
    ...(saved && {playlist: saved.playlist, ownFiles: saved.ownFiles, claimedAt: saved.claimedAt, loop: saved.playlist.current?.loop || false,
      observed: saved.observed, restorePending: saved.observed || saved.playlist.current}),
    identities: peerIdentities,
    connection,
    code,
    room,
    details: saved?.details || (joining ? null : {name: `${myName}'s Room`, revision: 1, updatedBy: selfId}),
    detailsAction: room.makeAction('room-details'),
    stateAction: room.makeAction('state'),
    commandAction: room.makeAction('command'),
    telemetryAction: room.makeAction('telemetry'),
    cuesAction: room.makeAction('cues', {kind: 'request'}),
    clockAction: room.makeAction('clock', {kind: 'request'}),
    profileAction: room.makeAction('profile'),
    boardAction: room.makeAction('board'),
    filterAction: room.makeAction('filter'),
    reactAction: room.makeAction('react'),
    imageAction: room.makeAction('image'),
    playlistAction: room.makeAction('playlist'),
  }
  const current = session
  const guard = (handler, options) => sessionHandler(current, () => session, handler, options)
  const limited = (action, handler, options) => guard((data, context) => {
    if (!current.receiveLimits(`${context.peerId}:${action}`)) {
      if (options?.request) throw new Error('Too many requests')
      return
    }
    return handler(data, context)
  }, options)
  session.clockAction.onRequest = limited('clock', () => ({now: performance.now()}), {request: true})
  session.detailsAction.onMessage = (message, {peerId}) => {
    if (session.room !== room || !session.peers.has(peerId)) return
    const details = cleanRoomDetails(message)
    if (!details || !newerRoomDetails(details, session.details)) return
    session.details = details
    saveRoom()
    render()
  }
  session.playlistAction.onMessage = limited('playlist', (message, {peerId}) => receivePlaylist(message, peerId))
  session.imageAction.onMessage = limited('image', (bytes, {peerId, metadata}) => receiveImage(bytes, peerId, metadata))
  // Arrives per 16KB chunk, so it's only stored; the regular render picks it up.
  session.imageAction.onReceiveProgress = guard((percent, {peerId, metadata}) => {
    if (peerId === session.hostId && metadata?.id === session.remote?.image?.id) session.imageProgress = {id: metadata.id, percent}
  })
  session.reactAction.onMessage = limited('react', (message, {peerId}) => receiveReaction(message?.kind, peerId))
  session.cuesAction.onRequest = limited('cues', async (request) => {
    if (!sameClaim(request, {hostId: selfId, claimedAt: current.claimedAt})) throw new Error('Media has changed')
    const catalog = current.catalog
    const cues = await hostCues(request.id)
    if (session !== current || current.closed || current.catalog !== catalog) throw new Error('Media has changed')
    return cleanCues(cues)
  }, {request: true})
  session.boardAction.onMessage = limited('board', (message, {peerId}) => receiveBoard(message, peerId))
  session.filterAction.onMessage = limited('filter', (message, {peerId}) => receiveFilter(message, peerId))
  session.profileAction.onMessage = limited('profile', (profile, {peerId}) => {
    person(peerId).name = cleanDisplayName(profile?.name)
    person(peerId).username = peerIdentities.get(peerId) || null
    render()
  })

  room.onPeerJoin = (peerId) => {
    if (session.room !== room) return
    connection.connectedBefore = true
    connection.persistent = true
    connection.error = null
    session.peers.add(peerId)
    person(peerId).username = peerIdentities.get(peerId) || null
    if (session.details) session.detailsAction.send(session.details, {target: peerId}).catch(() => {})
    session.profileAction.send(myProfile(), {target: peerId}).catch(() => {})
    session.boardAction.send({type: 'sync', ...boardSnapshot(session.board)}, {target: peerId}).catch(() => {})
    if (session.filter) session.filterAction.send({id: session.filter, at: session.filterAt}, {target: peerId}).catch(() => {})
    if (session.playlist.items.size || session.playlist.removed.size) {
      session.playlistAction.send({type: 'sync', ...playlistSnapshot(session.playlist)}, {target: peerId}).catch(() => {})
    }
    shareAvailability(peerId)
    toast('Participant connected')
    if (session.role === 'host' && !session.preview) {
      if (session.stream) Promise.all(room.addStream(session.stream, {target: peerId, metadata: {claimedAt: session.claimedAt}})).then(tuneSenders, () => {})
      if (session.image) sendImage(peerId)
      broadcastState(peerId)
    }
    render()
  }

  room.onPeerLeave = (peerId) => {
    if (session.room !== room) return
    session.peers.delete(peerId)
    session.peerFiles.delete(peerId)
    peerIdentities.delete(peerId)
    if (!session.peers.size) {
      connection.waitingSince = performance.now()
      connection.error = null
    }
    session.peerStreams.delete(peerId)
    session.people.delete(peerId)
    forgetImage(peerId)
    if (session.role === 'viewer' && peerId === session.hostId) {
      const previous = session.playlist.current
      const wasPlaying = session.remote?.playing
      youtube.close()
      session.hostId = null
      session.remote = null
      detachRemoteStream()
      setRole('idle')
      const coordinator = [selfId, ...session.peers].sort()[0]
      if (wasPlaying && coordinator === selfId) playNext(previous)
    }
    toast('Participant left')
    render()
  }

  room.onPeerStream = (stream, peerId, metadata) => {
    if (session.room !== room || !session.peers.has(peerId) || !isRevision(metadata?.claimedAt)) return
    const previous = session.peerStreams.get(peerId)
    if (previous?.claimedAt > metadata.claimedAt) return
    session.peerStreams.set(peerId, {stream, claimedAt: metadata.claimedAt})
    applyViewerBuffer(room.getPeers()[peerId])
    attachRemoteStream()
  }

  session.stateAction.onMessage = limited('state', (state, {peerId}) => receiveState(state, peerId))
  session.commandAction.onMessage = limited('command', (message) => {
    if (session.role === 'host' && !session.preview && sameClaim(message, {hostId: selfId, claimedAt: session.claimedAt})) applyCommand(message.cmd, message.value)
  })
  session.telemetryAction.onMessage = limited('telemetry', (message, {peerId}) => {
    if (!isHost() || !sameClaim(message, {hostId: selfId, claimedAt: session.claimedAt})) return
    const receiver = cleanTelemetry(message.receiver)
    if (receiver) { person(peerId).receiver = receiver; person(peerId).receiverAt = performance.now() }
  })
  session.imageRequest = room.makeAction('get-image')
  session.imageRequest.onMessage = limited('get-image', (message, {peerId}) => {
    if (isHost() && message?.id === session.image?.id && performance.now() - (person(peerId).imageRequestedAt || -Infinity) > 10_000) {
      person(peerId).imageRequestedAt = performance.now()
      sendImage(peerId)
    }
  })

  window.api.setInRoom(true)
  ui.code.textContent = formatRoomCode(code)
  ui.home.hidden = ui.settings.hidden = true
  ui.room.hidden = false
  ui.room.append(ui.friends, ui.friendNotification)
  setFriendsOpen(false)
  renderFriends() // friends get Invite buttons
  setRole('idle')
  saveRoom()
  refreshAvailability()
}

async function leaveRoom() {
  if (leavingRoom) return leavingRoom
  const current = session
  checkpointPlayback()
  saveRoom()
  const finalSnapshot = current.playlistAction?.send({type: 'sync', ...playlistSnapshot(current.playlist)}).catch(() => {})
  current.closed = true
  current.lifetime.abort()
  current.imageSend?.abort()
  current.captions.controller?.abort()
  current.ownFiles.clear()
  ui.mediaUrl.value = ''
  ui.mediaUrlStatus.hidden = true
  ui.playlistUrlForm.reset()
  ui.playlistUrlStatus.hidden = true
  setPlaylistAddOpen(false)
  youtube.close()
  endStroke()
  player.close()
  unpublishStream()
  detachRemoteStream()
  ui.joinRequests.replaceChildren()
  ui.reactionFeed.replaceChildren()
  clearHostImage()
  for (const peerId of [...current.images.keys()]) forgetImage(peerId)
  teardownFilters()
  setFilterOpen(false)
  session = blankSession()
  setRole('idle')
  ui.room.hidden = ui.settings.hidden = true
  ui.home.hidden = false
  ui.home.append(ui.friends, ui.friendNotification)
  setFriendsOpen(false)
  renderFriends()
  renderSavedRooms()
  ui.create.disabled = ui.joinForm.querySelector('button').disabled = true
  leavingRoom = Promise.resolve().then(async () => {
    if (finalSnapshot) await Promise.race([finalSnapshot, new Promise((resolve) => setTimeout(resolve, 500))])
    await current.room?.leave()
  }).catch((error) => toast(errorMessage(error), true)).finally(() => {
    leavingRoom = null
    ui.create.disabled = ui.joinForm.querySelector('button').disabled = false
    window.api.setInRoom(false)
  })
  return leavingRoom
}

function setRole(role) {
  session.role = role
  ui.stage.dataset.role = role
  render()
}

// ---------- Hosting ----------

// `item` is the playlist item this file was started from, if any.
async function hostFile(filePath, item = null, {preview = false, start, autoplay = true} = {}) {
  if (!session.room || session.closed) return
  const current = session
  if (!item) {
    item = [...session.playlist.items.values()].find((entry) => session.ownFiles.get(entry.id) === filePath)
    item ||= addToPlaylist([filePath], {notify: false})[0]
    if (!item) return
  }
  checkpointPlayback()
  saveRoom()
  const resume = session.playlist.progress.get(item.id)
  const claimedAt = nextRevision(session.claimedAt, session.authority?.claimedAt, session.playlist.revision)
  stopHosting()
  session.preview = preview
  session.restorePending = null
  session.openingMedia = true
  session.claimedAt = claimedAt
  session.authority = {hostId: selfId, claimedAt, sequence: 0}
  session.sequence = 0
  session.catalog = new SubtitleCatalog()
  session.mediaError = null
  session.playing = item && {id: item.id, position: item.position}
  session.hostId = selfId
  session.remote = null
  detachRemoteStream()
  setRole('host')
  broadcastState()
  if (isImagePath(filePath)) return hostImage(filePath, claimedAt)
  try {
    const opened = await player.open(filePath, start ?? (resume?.completed ? 0 : resume?.time || 0))
    if (session !== current || current.closed || current.claimedAt !== claimedAt || !isHost()) return
    current.openingMedia = false
    if (opened && autoplay && !current.preview) ui.localVideo.play().catch((error) => {
      if (session === current && !current.closed && current.claimedAt === claimedAt && isHost()) failHosting(error)
    })
  } catch (err) {
    if (session !== current || current.closed || current.claimedAt !== claimedAt || !isHost()) return
    failHosting(err)
  }
  broadcastState()
}

function stopHosting() {
  session.preview = false
  youtube.close()
  session.imageSend?.abort()
  session.captions.controller?.abort()
  player.close()
  unpublishStream()
  clearHostImage()
  session.playing = null
  session.openingMedia = false
  setRole('idle')
}

const hostedTitle = () => session.image?.name || youtube.title || (youtube.videoId && session.playlist.items.get(session.playing?.id)?.title) || player.media?.title || player.media?.name || null

function hostYouTube(item, {preview = false, start, autoplay = true} = {}) {
  if (!session.room || session.closed) return
  checkpointPlayback()
  saveRoom()
  const resume = session.playlist.progress.get(item.id)
  const claimedAt = nextRevision(session.claimedAt, session.authority?.claimedAt, session.playlist.revision)
  stopHosting()
  session.preview = preview
  session.restorePending = null
  session.claimedAt = claimedAt
  session.authority = {hostId: selfId, claimedAt, sequence: 0}
  session.sequence = 0
  session.catalog = new SubtitleCatalog()
  session.mediaError = null
  session.playing = {id: item.id, position: item.position}
  session.hostId = selfId
  session.remote = null
  detachRemoteStream()
  youtube.open(item.youtubeId, start ?? (resume?.completed ? 0 : resume?.time || 0), autoplay && !preview)
  setRole('host')
  broadcastState()
}

// ---------- Pictures ----------
// A picture isn't streamed: the host sends the file itself, so everyone sees it at full resolution.

async function hostImage(filePath, claimedAt) {
  const current = session
  player.close()
  unpublishStream()
  try {
    const {name, mime, bytes} = await window.api.readImage(filePath)
    if (session !== current || current.closed || session.claimedAt !== claimedAt || !isHost()) return
    const url = URL.createObjectURL(new Blob([bytes], {type: mime}))
    session.image = {id: String(claimedAt), name, mime, bytes, url}
    session.openingMedia = false
    sendImage()
  } catch (err) {
    if (session !== current || current.closed || session.claimedAt !== claimedAt || !isHost()) return
    toast(errorMessage(err), true)
    failHosting(err)
  }
  broadcastState()
}

function sendImage(target) {
  if (!session.image || session.closed || session.preview) return
  const current = session
  current.imageSend ??= new AbortController()
  const controller = current.imageSend
  const {id, name, mime, bytes} = current.image
  for (const peerId of target ? [target] : current.peers) {
    if (current.imageTransfers.has(peerId)) continue
    const transfer = current.imageAction.send(bytes, {metadata: {id, name, mime, claimedAt: current.claimedAt}, signal: controller.signal, target: peerId})
      .catch((error) => { if (session === current && !controller.signal.aborted) toast(`Picture transfer failed: ${errorMessage(error)}. The viewer can retry.`, true) })
      .finally(() => { if (current.imageTransfers.get(peerId) === transfer) current.imageTransfers.delete(peerId) })
    current.imageTransfers.set(peerId, transfer)
  }
}

function clearHostImage() {
  session.imageSend?.abort()
  session.imageSend = null
  session.imageTransfers.clear()
  if (session.image) URL.revokeObjectURL(session.image.url)
  session.image = null
}

// Kept per sender until they send another, so a picture that arrives before its state still shows.
function receiveImage(bytes, peerId, metadata) {
  const {id, mime, claimedAt} = metadata || {}
  if (!session.peers.has(peerId) || !(bytes instanceof Uint8Array) || bytes.byteLength > MAX_IMAGE_BYTES || !isRevision(claimedAt) || id !== String(claimedAt) || !isImageMime(mime)) return
  if (session.images.get(peerId)?.claimedAt >= claimedAt) return
  if (session.authority && !sameClaim({hostId: peerId, claimedAt}, session.authority) && !newerClaim({hostId: peerId, claimedAt}, session.authority)) return
  forgetImage(peerId)
  session.images.set(peerId, {id, claimedAt, url: URL.createObjectURL(new Blob([bytes], {type: mime}))})
  render()
}

function forgetImage(peerId) {
  const image = session.images.get(peerId)
  if (image) URL.revokeObjectURL(image.url)
  session.images.delete(peerId)
}

// The host's own picture, or the one the host sent if it's the one their state names.
function shownImage() {
  if (isHost()) return session.image
  const wanted = session.remote?.image?.id
  const received = wanted && session.images.get(session.hostId)
  return received && received.id === wanted ? received : null
}

function showPicture(url) {
  if ((ui.picture.getAttribute('src') || null) === url) return
  if (url) ui.picture.src = url
  else ui.picture.removeAttribute('src')
  ui.picture.hidden = !url
}

// Video comes from captureVideoFrames (true source frame rate); captureStream supplies audio,
// and video too if the frame APIs are unavailable. Audio files get no video track: one that never
// receives a frame can hold the viewer's <video> below HAVE_CURRENT_DATA, so it never plays.
function publishStream() {
  if (session.preview) return
  unpublishStream()
  const video = ui.localVideo
  const captured = video.captureStream()
  const frames = player.media?.video ? captureVideoFrames(video) : null
  const usable = (track) => !(frames && track.kind === 'video')
  for (const track of captured.getTracks()) if (!usable(track)) track.stop()

  const stream = new MediaStream([...(frames ? [frames] : []), ...captured.getTracks().filter(usable)])
  // Films should drop resolution before frame rate when the connection or CPU struggles.
  stream.getVideoTracks().forEach((track) => (track.contentHint = 'motion'))
  session.stream = stream
  session.captured = captured

  // Capture can end/replace tracks without changing the MediaSource. Retaining an
  // old audio sender leaves a silent track alongside its replacement on viewers.
  const removeTrack = (track) => {
    if (session.stream !== stream || !stream.getTracks().includes(track)) return
    session.room.removeTrack(track)
    stream.removeTrack(track)
  }
  const watchTrack = (track) => track.addEventListener('ended', () => removeTrack(track), {once: true})
  captured.getTracks().filter(usable).forEach(watchTrack)
  captured.addEventListener('removetrack', ({track}) => removeTrack(track))
  captured.addEventListener('addtrack', ({track}) => {
    if (session.stream !== stream || !usable(track)) return track.stop()
    if (track.readyState === 'ended') return
    if (track.kind === 'video') track.contentHint = 'motion'
    for (const old of stream.getTracks()) if (old.readyState === 'ended') removeTrack(old)
    stream.addTrack(track)
    watchTrack(track)
    Promise.all(session.room.addTrack(track, stream, {metadata: {claimedAt: session.claimedAt}})).then(tuneSenders, () => {})
  })
  if (session.peers.size) Promise.all(session.room.addStream(stream, {metadata: {claimedAt: session.claimedAt}})).then(tuneSenders, () => {})
}

function unpublishStream() {
  const stream = session.stream
  if (!stream) return
  session.stream = null
  try {
    session.room?.removeStream(stream)
  } catch {}
  stream.getTracks().forEach((track) => track.stop())
  session.captured?.getTracks().forEach((track) => track.stop())
  session.captured = null
}

// Raise WebRTC's conservative defaults so a movie looks and sounds like a movie.
async function tuneSenders() {
  const current = session
  if (current.tuning || !isHost() || current.closed) return
  current.tuning = true
  try {
    for (const [peerId, pc] of Object.entries(current.room?.getPeers() || {})) {
      if (!current.peers.has(peerId)) continue
      const quality = person(peerId).quality
      for (const sender of pc.getSenders()) {
        if (session !== current || current.closed) return
        const track = sender.track
        const params = sender.getParameters()
        if (!track || !params.encodings?.length || !current.stream?.getTracks().includes(track)) continue
        const encoding = params.encodings[0]
        const maxBitrate = track.kind === 'video' ? quality?.bitrate || 4_000_000 : AUDIO_MAX_BITRATE
        const settings = track.getSettings()
        const scale = quality?.scale || Math.max(1, (settings.width || 0) / MAX_STREAM_WIDTH, (settings.height || 0) / 1080)
        if (encoding.maxBitrate === maxBitrate && (track.kind !== 'video' || encoding.scaleResolutionDownBy === scale)) continue
        encoding.maxBitrate = maxBitrate
        if (track.kind === 'video') {
          encoding.scaleResolutionDownBy = scale
          params.degradationPreference = 'maintain-framerate'
        }
        await sender.setParameters(params).catch(() => {})
      }
    }
  } finally { current.tuning = false }
}

function hostState() {
  const media = player.media
  const video = ui.localVideo
  return {
    protocol: PROTOCOL,
    hostId: selfId,
    claimedAt: session.claimedAt,
    sequence: session.sequence,
    sentAt: performance.now(),
    ended: Boolean(session.mediaError),
    error: session.mediaError,
    title: cleanText(hostedTitle(), 200),
    loading: session.openingMedia || (!media && !youtube.loaded && !session.image && !session.mediaError),
    ...(youtube.videoId && {youtubeId: youtube.videoId}),
    image: session.image ? {id: session.image.id} : null,
    playlistId: session.playing?.id || null,
    playlistPosition: session.playing?.position ?? 0,
    finished: Boolean((youtube.videoId ? youtube.ended : video.ended) && !session.loop),
    audioOnly: Boolean(media && !media.video),
    playing: hostPlaying(),
    buffering: hostPlaying() && (youtube.videoId ? youtube.buffering : video.readyState < 3),
    time: currentTime(),
    duration: currentDuration(),
    loop: session.loop,
    transcoding: player.transcoding,
    audio: (media?.audio || []).slice(0, 128).map((a) => ({value: String(a.index), label: cleanText(a.label, 200) || 'Track'})),
    audioSelected: media?.audio.some((a) => a.index === player.audioIndex) ? String(player.audioIndex) : '',
    subtitles: session.catalog.publish(media?.subtitles || []),
    subtitleSelected: media?.subtitles.some((s) => s.id === player.subtitleId) ? session.catalog.remote.get(player.subtitleId) || '' : '',
    sender: session.link?.sender || null,
    // What each viewer reports receiving, so everyone's room list can show it.
    viewers: Object.fromEntries([...session.people].filter(([, p]) => p.receiver).map(([id, p]) => [id, p.receiver])),
    senders: Object.fromEntries([...session.people].filter(([, p]) => p.sender).map(([id, p]) => [id, p.sender])),
    epoch: session.epoch,
  }
}

// ---------- Connection health ----------

function applyViewerBuffer(pc) {
  for (const receiver of pc?.getReceivers() || []) {
    if ('jitterBufferTarget' in receiver && receiver.jitterBufferTarget !== session.buffer.bufferMs) {
      receiver.jitterBufferTarget = session.buffer.bufferMs
    }
  }
}

// Every couple of seconds: measure the connection to everyone in the room. Viewers also adapt
// their buffer and report what they're receiving so the host can see it.
async function sampleConnection() {
  const current = session
  const room = current.room
  if (!room || current.sampling || current.closed) return
  current.sampling = true
  try {
  const pcs = room.getPeers()
  const audioOnly = isHost() ? Boolean(player.media && !player.media.video) : Boolean(current.remote?.audioOnly)
  const readings = new Map(
    await Promise.all(Object.entries(pcs).map(async ([id, pc]) => [id, await pc.getStats().then((report) => readStats(report, {audioOnly}), () => null)])),
  )
  if (session.room !== room) return
  for (const [id, stats] of readings) {
    if (stats && session.peers.has(id)) {
      const p = person(id)
      Object.assign(p, {rttMs: stats.rttMs, relayed: stats.relayed})
      if (isHost()) {
        p.sender = stats.outbound
        if (performance.now() - (p.receiverAt || 0) > HOST_TIMEOUT_MS) p.receiver = null
        const dimensions = current.stream?.getVideoTracks()[0]?.getSettings() || {}
        p.quality = chooseSendQuality(p.quality, {receiver: p.receiver, capacity: stats.capacity, peerCount: current.peers.size, ...dimensions})
      }
    }
  }

  const peerId = session.role === 'viewer' ? session.hostId : [...session.peers][0]
  const stats = readings.get(peerId)
  if (!stats) {
    session.link = null
    return render()
  }
  const pc = pcs[peerId]
  const base = {rttMs: stats.rttMs, relayed: stats.relayed}

  if (isHost()) {
    session.link = aggregateLinks([...session.people.values()])
    tuneSenders()
  } else if (session.role === 'viewer' && stats.inbound) {
    // Packet loss is always the network; freezes and jitter only count during steady playback.
    const steady = isSteady(session.steady, performance.now())
    const measured = inboundDelta(session.lastInbound, stats.inbound)
    const delta = measured && !steady ? {...measured, freezes: 0, droppedFrames: 0} : measured
    session.lastInbound = stats.inbound
    if (measured?.delayMs != null) session.playoutDelayMs = measured.delayMs
    session.buffer = adaptBuffer(session.buffer, isTroubled(delta, steady ? stats.inbound.jitterMs : 0), TELEMETRY_INTERVAL_MS)
    applyViewerBuffer(pc)
    const receiver = {
      lossPct: delta?.lossPct ?? 0,
      freezes: Math.max(0, delta?.freezes || 0, steady && !session.remote?.audioOnly && session.lastFrameAt && performance.now() - session.lastFrameAt > 4000 ? 1 : 0),
      droppedFrames: Math.max(0, delta?.droppedFrames || 0),
      fps: stats.inbound.fps,
      height: stats.inbound.height,
      bufferMs: session.buffer.bufferMs,
      delayMs: Math.max(0, Math.min(10000, session.frameDelayMs ?? (session.playoutDelayMs || session.buffer.bufferMs) + (stats.rttMs || 0) / 2 + DECODE_DELAY_MS)),
    }
    session.link = {...base, receiver, sender: session.remote?.senders?.[selfId] || null}
    session.telemetryAction.send({receiver, hostId: session.hostId, claimedAt: session.remote.claimedAt}, {target: session.hostId, signal: session.lifetime.signal}).catch(() => {})
  } else {
    session.link = base
  }
  if (session.role === 'viewer' && session.hostId) {
    const hostId = session.hostId
    const claimedAt = session.remote?.claimedAt
    const sent = performance.now()
    try {
      const reply = await session.clockAction.request({}, {target: hostId, timeoutMs: 1500, signal: current.lifetime.signal})
      if (session === current && session.hostId === hostId && session.remote?.claimedAt === claimedAt) session.clock = updateClock(session.clock, sent, performance.now(), reply?.now)
    } catch {}
  }
  if (session === current) render()
  } finally { current.sampling = false }
}

function checkpointPlayback(state = null) {
  if (!state) {
    if (!isHost() || session.preview || session.openingMedia || session.mediaError || (!player.loaded && !youtube.loaded && !session.image) || !session.playing) return
    session.sequence = nextRevision(session.sequence)
    state = hostState()
  }
  if (state.loading || state.ended || !state.playlistId) return
  recordProgress(session.playlist, {id: state.playlistId, position: state.playlistPosition,
    time: state.time, duration: state.duration, completed: state.finished, loop: state.loop,
    hostId: state.hostId, claimedAt: state.claimedAt, sequence: state.sequence})
}

function broadcastState(target) {
  if (session.closed || session.role !== 'host' || !session.stateAction) return
  if (session.preview) { saveRoom(); render(); return }
  const current = session
  // Coalesce periodic/event updates behind an outstanding send; don't build a stale queue.
  if (current.sendPending && !target) { current.sendDirty = true; return }
  // A returning peer may carry newer history than the copy we reopened. Keep
  // that history, but let explicitly started playback issue fresh checkpoints.
  if (!current.openingMedia && current.playlist.current && newerClaim(current.playlist.current, {hostId: selfId, claimedAt: current.claimedAt})) {
    current.claimedAt = nextRevision(current.claimedAt, current.playlist.revision)
    current.sequence = 0
    if (current.stream) publishStream()
    if (current.image) {
      current.image.id = String(current.claimedAt)
      sendImage()
    }
  }
  current.sequence = nextRevision(current.sequence)
  checkpointPlayback()
  saveRoom()
  current.authority = {hostId: selfId, claimedAt: current.claimedAt, sequence: current.sequence}
  if (!target) current.sendPending = true
  current.stateAction.send(hostState(), {signal: current.lifetime.signal, ...(target && {target})}).catch(() => {}).finally(() => {
    if (session !== current || current.closed || target) return
    current.sendPending = false
    if (current.sendDirty) { current.sendDirty = false; broadcastState() }
  })
  render()
}

function failHosting(error) {
  if (!isHost() || session.closed) return
  youtube.close()
  // Keep this claim alive with a terminal state so late/rejoining viewers learn it too.
  session.mediaError = 'The host could not play this media. Open another file to continue.'
  session.openingMedia = false
  if (session.playing) session.availableFiles.delete(session.playing.id)
  shareAvailability()
  player.close()
  unpublishStream()
  clearHostImage()
  toast(errorMessage(error), true)
  broadcastState()
}

function applyCommand(cmd, value) {
  if (youtube.videoId) {
    if (!['play', 'pause', 'seek', 'loop'].includes(cmd) || !validCommand(cmd, value, {duration: youtube.duration})) return
    if (cmd === 'loop') session.loop = value
    else if (cmd === 'seek') { session.epoch++; youtube.seek(value) }
    else youtube[cmd]()
    broadcastState()
    return
  }
  if (cmd === 'subtitle' && value) { value = session.catalog.resolve(value); if (!value) return }
  if (!player.loaded || !validCommand(cmd, value, player.media)) return
  const video = ui.localVideo
  if (cmd === 'loop') session.loop = Boolean(value)
  else if (cmd === 'play') video.play().catch(() => {})
  else if (cmd === 'pause') video.pause()
  else if (cmd === 'seek') { session.epoch++; player.seek(value) }
  else if (cmd === 'audio') player.setAudio(value === '' ? null : Number(value))
  else if (cmd === 'subtitle' && (!value || player.media.subtitles.some((s) => s.id === value && s.image))) player.setSubtitle(value || null)
  broadcastState()
}

// ---------- Watching ----------

function receiveState(value, peerId) {
  if (session.closed || !session.peers.has(peerId)) return
  const state = cleanState(value, peerId)
  if (!state || !acceptsState(state, session.preview ? null : session.authority)) return
  session.restorePending = null
  const changed = !sameClaim(state, session.authority)
  if (isHost()) {
    const wasPreview = session.preview
    checkpointPlayback()
    stopHosting()
    if (!wasPreview) toast('Another participant is hosting now')
  }
  if (changed) {
    detachRemoteStream()
    session.clock = null
    session.lastInbound = null
    session.playoutDelayMs = null
    session.buffer = {bufferMs: MIN_BUFFER_MS, calmMs: 0}
    session.catalog = new SubtitleCatalog()
  }
  const now = performance.now()
  session.steady = nextSteady(session.steady, state, session.remote ? viewerTime() : state.time, now)
  session.authority = {hostId: state.hostId, claimedAt: state.claimedAt, sequence: state.sequence}
  session.claimedAt = Math.max(session.claimedAt, state.claimedAt)
  session.hostId = state.hostId
  session.loop = state.loop
  session.remote = {...state, receivedAt: now}
  checkpointPlayback(state)
  saveRoom()
  for (const [id, receiver] of Object.entries(state.viewers)) if (session.peers.has(id)) person(id).receiver = receiver
  session.role = 'viewer'
  ui.stage.dataset.role = 'viewer'
  if (stopRemovedPlayback()) return
  if (state.youtubeId && !state.ended) {
    detachRemoteStream()
    youtube.sync(state.youtubeId, viewerTime(), state.playing && !state.buffering)
  } else {
    youtube.close()
    if (state.ended || state.image) detachRemoteStream()
    else attachRemoteStream()
  }
  render()
}

function attachRemoteStream() {
  if (session.role !== 'viewer' || session.remote?.youtubeId) return
  const entry = session.peerStreams.get(session.hostId)
  const stream = entry?.claimedAt === session.remote?.claimedAt ? entry.stream : null
  if (stream && ui.remoteVideo.srcObject !== stream) {
    detachRemoteStream()
    ui.remoteVideo.srcObject = stream
    session.lastFrameAt = performance.now()
    const current = session
    const onFrame = (now, metadata) => {
      if (session !== current || current.closed || ui.remoteVideo.srcObject !== stream) return
      current.lastFrameAt = now
      if (Number.isFinite(metadata.captureTime)) {
        const delay = metadata.expectedDisplayTime - metadata.captureTime
        if (delay >= 0 && delay < 10000) current.frameDelayMs = delay
      }
      ui.remoteVideo.requestVideoFrameCallback?.(onFrame)
    }
    ui.remoteVideo.requestVideoFrameCallback?.(onFrame)
    remoteAudioLifetime = new AbortController()
    const options = {signal: remoteAudioLifetime.signal}
    const refreshAudio = () => {
      if (ui.remoteVideo.srcObject === stream) routeRemoteAudio(stream)
    }
    const watched = new WeakSet()
    const watchTrack = (track) => {
      if (track.kind !== 'audio' || watched.has(track)) return
      watched.add(track)
      for (const event of ['ended', 'mute', 'unmute']) track.addEventListener(event, refreshAudio, options)
    }
    stream.getTracks().forEach(watchTrack)
    stream.addEventListener('addtrack', ({track}) => { watchTrack(track); refreshAudio() }, options)
    stream.addEventListener('removetrack', refreshAudio, options)
    refreshAudio()
    ui.remoteVideo.play().catch(() => {})
  }
}

function detachRemoteStream() {
  remoteAudioLifetime?.abort()
  remoteAudioLifetime = null
  ui.remoteVideo.srcObject = null
  remoteAudio?.disconnect()
  remoteAudio = null
  session.frameDelayMs = null
  session.lastFrameAt = 0
}

function viewerTime() {
  return estimatedMediaTime(session.remote, performance.now(), session.clock)
}

// ---------- Profile ----------

const DEFAULT_NAME = 'Karlie Chirp' // the display name when the welcome screen's name is left empty
let myName = DEFAULT_NAME
let identity = null // {username, publicKey, privateKey}
const myProfile = () => ({name: myName, username: identity?.username || null, status: myStatus()})

// Friends see whether you're in a room, and what you're hosting.
function myStatus() {
  const hosting = session.role === 'host' && !session.preview && (player.loaded || youtube.loaded || Boolean(session.image))
  return {inRoom: Boolean(session.room), hosting, title: hosting ? hostedTitle() : null}
}

let sharedStatus = ''
function syncPresence() {
  updateRoomPresence()
  const status = JSON.stringify(myStatus())
  if (!friendNetwork.identity || status === sharedStatus) return
  sharedStatus = status
  friendNetwork.updateProfile(myProfile())
  renderFriends() // "Ask to join" only shows while you're not in a room
}

async function loadIdentity() {
  try {
    const stored = JSON.parse(localStorage.getItem('identity'))
    if (await isValidIdentity(stored)) return stored
  } catch {}
  return null
}

function saveIdentity(next) {
  try {
    localStorage.setItem('identity', JSON.stringify(next))
  } catch {}
  return next
}

function renderProfile() {
  if (document.activeElement !== ui.profileName) ui.profileName.value = myName
  syncNameSave(ui.profileName)
  ui.profileAvatar.textContent = myName.trim()[0]?.toUpperCase() || '?'
  ui.username.textContent = ui.settingsUsername.textContent = identity?.username || '…'
}

// The display name is what people see; the username stays the same when it changes.
function setMyName(input) {
  const name = cleanDisplayName(input)
  if (name && name !== myName) {
    myName = name
    try {
      localStorage.setItem('displayName', name)
    } catch {}
  }
  shareProfile()
  render()
}

// The checkmark in the field only shows while what's typed would change the saved name.
function syncNameSave(input) {
  const name = cleanDisplayName(input.value)
  markUnsaved(input, Boolean(name) && name !== myName)
}

function markUnsaved(input, unsaved) {
  input.closest('.save-field')?.classList.toggle('unsaved', unsaved)
}

function bindNameInput(input) {
  const save = () => {
    setMyName(input.value)
    // Show the name as saved: cleaned up, or the previous one if this was blank.
    input.value = myName
    syncNameSave(input)
  }
  input.addEventListener('input', () => syncNameSave(input))
  input.addEventListener('change', save)
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') input.value = myName
    if (event.key === 'Enter' || event.key === 'Escape') input.blur()
    if (event.key === 'Escape') syncNameSave(input)
  })
  input.closest('.save-field')?.querySelector('.field-save')?.addEventListener('click', () => {
    save()
    input.blur()
  })
}

function shareProfile() {
  renderProfile()
  session.profileAction?.send(myProfile()).catch(() => {})
  if (friendNetwork.identity) friendNetwork.updateProfile(myProfile())
}

// ---------- Welcome ----------
// The first screen on a new install: pick a username and a display name. After that the username
// can only be changed from Settings, which comes back here.

let welcome = null // {mode: 'first' | 'change', keys} while the screen is open

async function showWelcome(mode) {
  const changing = mode === 'change'
  welcome = {mode, keys: await createKeys()}
  ui.welcomeTitle.textContent = changing ? 'Change your username' : 'Welcome'
  ui.welcomeLede.textContent = changing
    ? 'Friends who added you will have to add you again.'
    : 'Pick a username friends can add you by, and the name people see.'
  ui.handle.value = changing ? identity.handle : ''
  ui.welcomeName.value = changing ? myName : ''
  ui.welcomeCancel.hidden = !changing
  ui.home.hidden = ui.settings.hidden = true
  ui.startup.hidden = true
  ui.welcome.hidden = false
  ui.handle.focus()
  updateWelcome()
}

async function updateWelcome() {
  const current = welcome
  const handle = normalizeHandle(ui.handle.value)
  const typed = ui.handle.value.trim() !== ''
  ui.welcomeSubmit.disabled = !(current && handle)
  ui.handleHint.textContent = typed && !handle ? `Usernames are ${HANDLE_HINT}` : 'The tag after # is added for you, so the username is yours alone.'
  ui.handleHint.classList.toggle('invalid', typed && !handle)
  const username = current && handle ? await usernameFor(current.keys.publicKey, handle) : null
  if (welcome !== current || normalizeHandle(ui.handle.value) !== handle) return
  ui.handleTag.textContent = username ? `#${username.split('#')[1]}` : '#····-····'
}

function finishWelcome(next, mode) {
  identity = next
  roomHistory = new RoomHistory(localStorage, identity.username)
  renderSavedRooms()
  welcome = null
  ui.startup.hidden = true
  ui.welcome.hidden = true
  // A changed username goes back to Settings, where it was changed from.
  ui.home.hidden = false
  showSettings(mode === 'change')
  delete ui.username.dataset.original
  startFriends(identity, mode)
  shareProfile()
}

// ---------- Friends ----------

const localStore = {
  load(key) {
    try {
      return JSON.parse(localStorage.getItem(key))
    } catch {
      return null
    }
  },
  save(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {}
  },
}

const network = createNetwork({getIceServers: () => window.api.iceServers(), PeerConnection: RTCPeerConnection})
const friendNetwork = new FriendNetwork({joinRoom: (config, ...rest) => joinRoom({...config, ...network.config()}, ...rest), selfId, appId: APP_ID, storage: localStore})
const roomPresence = new RoomPresence({joinRoom: (config, ...rest) => joinRoom({...config, ...network.config()}, ...rest), selfId, appId: APP_ID})
roomPresence.addEventListener('change', renderRoomMembers)
const networkReady = network.ready.then(() => network.config().turnConfig)
network.addEventListener('change', () => {
  if (network.error) showFriendNotice(network.error)
  else if (ui.friendError.textContent.startsWith('Connection relay')) showFriendNotice(null)
})
window.addEventListener('online', () => network.reconnect())
let lastNetworkTick = Date.now()
setInterval(() => {
  const now = Date.now()
  if (now - lastNetworkTick > 15_000) network.reconnect()
  lastNetworkTick = now
}, 5000)

// Local screens never wait for TURN credentials or peer discovery. Let the screen
// paint before Trystero creates its initial pool of WebRTC connections, too.
async function startFriends(next, mode) {
  try {
    const turnConfig = await networkReady
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
    if (identity !== next) return // the username changed while network setup was pending
    roomPresence.start(next)
    updateRoomPresence()
    friendNetwork.turnConfig = turnConfig
    if (mode === 'change') friendNetwork.restart(next)
    else friendNetwork.start(next, myProfile())
    friendNetwork.updateProfile(myProfile())
    renderFriends()
  } catch (error) {
    if (identity === next) showFriendNotice(`Could not connect to friends: ${errorMessage(error)}`)
  }
}

const presenceOf = (friend) => {
  if (!friend.confirmed) return 'pending'
  if (!friend.online) return 'offline'
  return friend.status?.hosting ? 'hosting' : friend.status?.inRoom ? 'room' : 'online'
}
const PRESENCE_ORDER = ['hosting', 'room', 'online', 'offline', 'pending']

function renderFriends() {
  const friendsReady = Boolean(identity && friendNetwork.identity === identity)
  ui.addFriend.querySelector('button').disabled = !friendsReady
  const requests = friendNetwork.requestList()
  const label = (friend) => friend.name || friend.username
  const friends = friendNetwork
    .list()
    .sort((a, b) => PRESENCE_ORDER.indexOf(presenceOf(a)) - PRESENCE_ORDER.indexOf(presenceOf(b)) || label(a).localeCompare(label(b)))

  ui.friendRequests.replaceChildren(
    ...requests.map(({username, name}) => {
      const row = element('li', 'friend friend-request')
      const main = element('div', 'person-main')
      main.append(element('div', 'person-name', name || username), element('div', 'person-stats', 'Wants to be friends'))
      main.lastChild.title = `Username: ${username}`
      const accept = element('button', 'primary small', 'Accept')
      accept.disabled = !friendsReady
      accept.addEventListener('click', () => showFriendNotice(friendNetwork.add(username)))
      const ignore = element('button', 'ghost small', 'Decline')
      ignore.addEventListener('click', () => friendNetwork.ignoreRequest(username))
      const actions = element('div', 'friend-actions')
      actions.append(accept, ignore)
      row.append(element('span', 'avatar', (name || username)[0].toUpperCase()), main, actions)
      return row
    }),
  )

  ui.friendList.replaceChildren(
    ...friends.map((friend) => {
      const label = friend.name || friend.username
      const row = element('li', 'friend')
      row.dataset.presence = presenceOf(friend)
      const main = element('div', 'person-main')
      main.append(element('div', 'person-name', label), element('div', 'person-stats', presenceText(friend)))
      main.firstChild.title = `Username: ${friend.username}`
      if (friend.connectionError) {
        main.lastChild.classList.add('friend-connection-error')
        main.lastChild.title = 'Could not connect to your friend. Both apps need to be open and able to connect. Some networks require a TURN relay. The app will keep trying.'
      }
      const remove = element('button', 'friend-remove', '×')
      remove.title = 'Remove friend'
      remove.setAttribute('aria-label', `Remove ${label}`)
      remove.addEventListener('click', () => {
        if (confirm(`Remove ${label} from your friends?`)) friendNetwork.remove(friend.username)
      })
      row.append(element('span', 'avatar', label[0].toUpperCase()), main)
      if (friend.online && session.room) {
        const invite = element('button', 'small friend-ask', friend.invited ? 'Invited' : 'Invite')
        invite.disabled = friend.invited
        invite.addEventListener('click', () => showFriendNotice(friendNetwork.inviteToRoom(friend.username, session.code)))
        row.append(invite)
      } else if (friend.online && friend.status?.inRoom) {
        const ask = element('button', 'small friend-ask', friend.asked ? 'Asked…' : 'Ask to join')
        ask.disabled = friend.asked
        ask.addEventListener('click', () => showFriendNotice(friendNetwork.askToJoin(friend.username)))
        row.append(ask)
      }
      row.append(remove)
      if (!friend.confirmed && ['expired', 'declined'].includes(friend.delivery)) {
        const retry = element('button', 'small', 'Retry')
        retry.addEventListener('click', () => friendNetwork.retry(friend.username))
        row.append(retry)
      }
      return row
    }),
  )
  ui.friendsEmpty.hidden = friends.length + requests.length > 0
  const online = friends.filter((friend) => friend.confirmed && friend.online).length
  ui.friendsOnline.textContent = friendsReady ? `${online} online` : 'Connecting…'
  ui.friendRequestsTitle.hidden = !requests.length
  ui.friendRequestsTitle.textContent = `Friend requests (${requests.length})`
  ui.friendNotification.hidden = !requests.length
  const notification = requests.length === 1
    ? `${requests[0].name || requests[0].username} sent you a friend request`
    : `${requests.length} friend requests`
  if (ui.friendNotificationText.textContent !== notification) ui.friendNotificationText.textContent = notification
  for (const toggle of ui.friendsToggles) {
    toggle.dataset.dot = requests.length ? 'request' : online ? 'online' : ''
    toggle.dataset.requestCount = requests.length > 99 ? '99+' : String(requests.length)
    const label = `Friends · ${online} online${requests.length ? ` · ${requests.length} pending ${requests.length === 1 ? 'request' : 'requests'}` : ''}`
    toggle.title = label
    toggle.setAttribute('aria-label', label)
  }
}

function showFriendNotice(message, {error = true} = {}) {
  ui.friendError.textContent = message || ''
  ui.friendError.hidden = !message
  ui.friendError.classList.toggle('notice', !error)
}

// A friend asks to join: you can only let them into a room you're in.
function receiveJoinAsk({username, name}) {
  if (!session.room) return friendNetwork.answerJoin(username, null)
  if ([...ui.joinRequests.children].some((card) => card.dataset.username === username)) return
  const card = element('div', 'join-request')
  card.dataset.username = username
  const answer = (code) => {
    card.remove()
    friendNetwork.answerJoin(username, code)
  }
  const letIn = element('button', 'primary small', 'Let in')
  letIn.addEventListener('click', () => answer(session.code))
  const notNow = element('button', 'ghost small', 'Not now')
  notNow.addEventListener('click', () => answer(null))
  card.append(element('span', null, `${name} wants to join`), letIn, notNow)
  ui.joinRequests.append(card)
  setTimeout(() => card.remove(), 120_000)
}

async function joinFriendRoom(name, code, leaveQuestion) {
  const roomCode = normalizeRoomCode(code)
  if (roomCode.length !== 8 || session.code === roomCode) return
  if (session.room) {
    if (!confirm(leaveQuestion)) return
    await leaveRoom()
  }
  showFriendNotice(null)
  await enterRoom(roomCode)
}

const receiveJoinInvite = ({name, code}) => joinFriendRoom(name, code, `${name} let you in. Leave this room and join theirs?`)

// A friend invites you into their room. It's only a card: nothing happens unless you click Join.
function receiveJoinOffer({username, name, code}) {
  if (session.code === normalizeRoomCode(code)) return
  const holder = ui.room.hidden ? ui.homeInvites : ui.joinRequests
  if ([...holder.children].some((card) => card.dataset.offerFrom === username)) return
  const card = element('div', 'join-request')
  card.dataset.offerFrom = username
  const join = element('button', 'primary small', 'Join')
  join.addEventListener('click', () => {
    card.remove()
    joinFriendRoom(name, code, `Leave this room and join ${name}'s?`)
  })
  const notNow = element('button', 'ghost small', 'Not now')
  notNow.addEventListener('click', () => card.remove())
  card.append(element('span', null, `${name} invited you to their room`), join, notNow)
  holder.append(card)
  setTimeout(() => card.remove(), 120_000)
}

// ---------- People ----------

function person(peerId) {
  if (!session.people.has(peerId)) session.people.set(peerId, {name: null, username: null, rttMs: null, relayed: false, receiver: null})
  return session.people.get(peerId)
}

function element(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

function renderPeople() {
  if (document.activeElement !== ui.roomName) ui.roomName.value = session.details?.name || ''
  ui.roomName.placeholder = session.connection.joining ? 'Joining room…' : 'Room name'
  syncRoomNameSave()
  const host = isHost()
  const hostId = host ? selfId : session.hostId
  const me = {id: selfId, self: true, name: myName, username: identity?.username, ...(host ? {sender: session.link?.sender} : {receiver: session.role === 'viewer' ? session.link?.receiver : null})}
  const others = [...session.peers].map((id) => {
    const p = person(id)
    return {id, name: p.name, username: p.username, rttMs: p.rttMs, relayed: p.relayed, receiver: p.receiver, sender: id === hostId ? session.remote?.sender : null}
  })
  const rows = [me, ...others]
    .map((row) => ({...row, host: row.id === hostId, stats: describePeer(row)}))
    .sort((a, b) => b.host - a.host)

  ui.peopleCount.textContent = String(rows.length)
  const signature = JSON.stringify(rows.map(({name, username, self, host, stats}) => [name, username, self, host, stats]))
  if (ui.people.dataset.signature === signature) return
  ui.people.dataset.signature = signature
  ui.people.replaceChildren(
    ...rows.map(({name, username, self, host, stats}) => {
      const shownName = name || 'Joining…'
      const row = element('li', 'person')
      if (stats.level) row.dataset.level = stats.level
      // Your own name is changed in Settings, not here.
      const nameLine = element('div', 'person-name', shownName)
      if (username) nameLine.title = `Username: ${username}`
      if (self) nameLine.append(element('span', 'person-tag', 'you'))
      const statsLine = element('div', 'person-stats', [host ? 'Hosting' : null, stats.text].filter(Boolean).join(' · ') || ' ')
      if (stats.detail) statsLine.title = stats.detail
      const main = element('div', 'person-main')
      main.append(nameLine, statsLine)
      row.append(element('span', 'avatar', shownName.trim()[0]?.toUpperCase() || '?'), main)
      return row
    }),
  )
}

function setPeopleOpen(open) {
  ui.room.classList.toggle('people-open', open)
  ui.peopleToggle.setAttribute('aria-expanded', String(open))
  try {
    localStorage.setItem('peopleOpen', open ? '1' : '0')
  } catch {}
}

// ---------- Face filters ----------
// One filter at a time, chosen by anyone, seen by everyone. Only the *choice* travels: each app
// finds the faces in the picture it is showing and draws the warp itself, the way subtitles are
// rendered per person rather than burned into the stream. That costs nothing on the wire, and it
// puts the filter on the frame this screen is actually displaying, which is a frame or two behind
// the host's.
//
// Whoever changes it last wins, ordered by revision like the whiteboard's clear, so the choice
// survives the host leaving.

const filters = {renderer: null, tracker: null, capture: null, capturing: false, source: null, installed: null, retryAt: 0, attempts: 0}

// Reaching the YouTube picture can fail for reasons that pass on their own: the window is covered or
// minimized, or the player has not painted its first frame yet. None of those mean the filter was a
// mistake, so it stays chosen and keeps trying, backing off so a genuinely dead path is not retried
// in a tight loop.
const CAPTURE_RETRY_MS = 600
const CAPTURE_RETRY_MAX_MS = 4000
// Long enough that a filter switched on a second early never says anything.
const CAPTURE_QUIET_ATTEMPTS = 6

const filterOpen = () => ui.room.classList.contains('filter-open')

// Filters need a moving picture. A still photograph has nothing to track, and there is no point
// running the detector before any media is open.
const canFilter = () => session.role !== 'idle' && !shownImage() && !session.mediaError

function teardownFilters() {
  filters.tracker?.stop()
  releaseCapture()
  filters.source = null
  if (ui.filterCanvas) ui.filterCanvas.hidden = true
}

function releaseCapture() {
  filters.capture?.stop()
  filters.capture = null
  filters.capturing = false
  filters.retryAt = 0
  filters.attempts = 0
  if (ui.filterToggle) {
    ui.filterToggle.classList.remove('waiting')
    ui.filterToggle.title = 'Face filters'
  }
}

// A filter that genuinely cannot run here — no WebGL, no model — is switched off here only, and
// everyone else keeps seeing it: one computer's missing hardware should not decide for the room.
// Anything that might fix itself goes through the retry above instead of coming here.
function filterUnavailable(message) {
  teardownFilters()
  if (session.filter) toast(message, true)
  session.filter = null
  renderFilterTools()
}

// The <video> holding the picture to look for faces in. YouTube plays inside a cross-origin iframe
// whose pixels are out of reach, so there the app captures its own window instead. Returning null
// only means there is nothing to look at this frame; the filter stays on and this is asked again.
function filterSource() {
  if (youtube.videoId) {
    if (filters.capture) return filters.capture.video
    if (!filters.capturing && performance.now() >= filters.retryAt) {
      filters.capturing = true
      captureElement(ui.youtubePlayer)
        .then((capture) => {
          if (!session.filter || !youtube.videoId) return capture.stop()
          filters.capture = capture
          filters.attempts = 0
          ui.filterToggle.classList.remove('waiting')
          ui.filterToggle.title = 'Face filters'
        })
        .catch(() => {
          // Keep the filter on and come back to it. Say nothing for the first few tries, then mark
          // the button rather than interrupting with a message over the video.
          filters.attempts++
          filters.retryAt = performance.now() + Math.min(CAPTURE_RETRY_MAX_MS, CAPTURE_RETRY_MS * filters.attempts)
          if (filters.attempts >= CAPTURE_QUIET_ATTEMPTS) {
            ui.filterToggle.classList.add('waiting')
            ui.filterToggle.title = 'Face filters are waiting for the YouTube picture. Bring the window to the front if it is covered.'
          }
        })
        .finally(() => (filters.capturing = false))
    }
    return null
  }
  releaseCapture()
  return isHost() ? ui.localVideo : ui.remoteVideo
}

// Runs every frame while a filter is on, and returns immediately when one is not. Detection is not
// done here: the tracker runs on its own slower clock and this only draws what it last found.
function drawFilters() {
  requestAnimationFrame(drawFilters)
  const filter = session.filter && FILTERS[session.filter]
  if (!filter || !canFilter()) return teardownFilters()
  const source = filterSource()
  if (!source?.videoWidth) {
    ui.filterCanvas.hidden = true
    return
  }
  if (filters.source !== source) {
    filters.source = source
    filters.tracker ||= new FaceTracker()
    filters.tracker.start(source).then((started) => {
      if (!started && filters.source === source) filterUnavailable(`Face filters could not start: ${errorMessage(filters.tracker.error)}`)
    })
  }
  if (!filters.renderer) {
    try {
      filters.renderer = new FilterRenderer(ui.filterCanvas)
    } catch (error) {
      return filterUnavailable(errorMessage(error))
    }
  }
  const dpr = window.devicePixelRatio || 1
  const rect = currentPictureRect()
  filters.renderer.resize(Math.round(ui.stage.clientWidth * dpr), Math.round(ui.stage.clientHeight * dpr))
  ui.filterCanvas.hidden = false
  filters.renderer.draw(source, filters.tracker.visible(), filter, {
    x: Math.round(rect.x * dpr),
    y: Math.round(rect.y * dpr),
    width: Math.round(rect.width * dpr),
    height: Math.round(rect.height * dpr),
  })
}

function setFilter(id) {
  const next = cleanFilterId(id)
  session.filterAt = nextRevision(session.filterAt)
  session.filter = next
  session.filterAction?.send({id: next, at: session.filterAt}).catch(() => {})
  renderFilterTools()
}

function receiveFilter(message, peerId) {
  const off = message?.id === null || message?.id === undefined
  const id = off ? null : cleanFilterId(message.id)
  if (!off && !id) return
  if (!isRevision(message?.at) || !(message.at > session.filterAt)) return
  session.filterAt = message.at
  session.filter = id
  renderFilterTools()
  const who = person(peerId).name || 'Someone'
  toast(id ? `${who} turned on the ${FILTERS[id].name} filter` : `${who} turned the filter off`)
}

// The strip is built from FILTERS, so a new entry in that table shows up here with no other change.
function buildFilterTools() {
  const choices = [{id: '', label: 'Off'}, ...FILTER_IDS.map((id) => ({id, label: FILTERS[id].name}))]
  ui.filterTools.replaceChildren(
    ...choices.map(({id, label}) => {
      const button = element('button', 'tool filter-choice', label)
      button.dataset.filter = id
      button.addEventListener('click', () => setFilter(id || null))
      return button
    }),
  )
}

function renderFilterTools() {
  for (const button of ui.filterTools.querySelectorAll('[data-filter]')) {
    const active = (button.dataset.filter || null) === session.filter
    button.classList.toggle('active', active)
    button.setAttribute('aria-pressed', String(active))
  }
  ui.filterToggle.setAttribute('aria-pressed', String(filterOpen()))
  ui.filterToggle.classList.toggle('active', Boolean(session.filter))
  ui.filterToggle.disabled = !canFilter()
}

function setFilterOpen(open) {
  ui.room.classList.toggle('filter-open', open)
  renderFilterTools()
}

// The model and its runtime are fetched after install rather than committed, so they can genuinely
// be missing. Say so once, on the way in, instead of failing when someone picks a filter.
async function openFilters() {
  if (filterOpen()) return setFilterOpen(false)
  if (filters.installed === null) filters.installed = await window.api.visionReady().catch(() => false)
  if (!filters.installed) return toast('Face filters are not installed. Run npm install again to fetch them.', true)
  setFilterOpen(true)
}

buildFilterTools()
ui.filterToggle.addEventListener('click', () => openFilters())

// ---------- Whiteboard ----------
// Everyone in the room draws on one board over the video. Showing it is a personal choice; the
// strokes keep arriving either way.

const tools = {tool: 'pen', color: COLORS[0], size: 1} // tool: 'pen', 'eraser' or null
let drawing = null // {stroke, sent} while this person is drawing
let strokeCount = 0
let boardLayout = null // what the canvas was last fully drawn for

const boardOpen = () => ui.room.classList.contains('board-open')

function currentPictureRect() {
  if (youtube.videoId) {
    const frame = ui.youtubePlayer
    const rect = pictureRect(frame.clientWidth, frame.clientHeight, 16, 9)
    return {...rect, x: rect.x + frame.offsetLeft, y: rect.y + frame.offsetTop}
  }
  const {picture} = ui
  if (shownImage() && picture.complete && picture.naturalWidth) {
    return pictureRect(ui.stage.clientWidth, ui.stage.clientHeight, picture.naturalWidth, picture.naturalHeight)
  }
  const video = isHost() ? ui.localVideo : ui.remoteVideo
  const playing = session.role !== 'idle'
  return pictureRect(ui.stage.clientWidth, ui.stage.clientHeight, playing ? video.videoWidth : 0, playing ? video.videoHeight : 0)
}

function boardContext() {
  const ctx = ui.board.getContext('2d')
  ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0)
  return ctx
}

// Redraw everything when the window, the picture or the board itself changed since last time.
function syncBoardLayout(force = false) {
  const dpr = window.devicePixelRatio || 1
  const width = Math.round(ui.stage.clientWidth * dpr)
  const height = Math.round(ui.stage.clientHeight * dpr)
  const rect = currentPictureRect()
  const layout = {board: session.board, key: JSON.stringify([width, height, rect])}
  if (!force && boardLayout?.board === layout.board && boardLayout.key === layout.key) return
  boardLayout = layout
  if (ui.board.width !== width || ui.board.height !== height) Object.assign(ui.board, {width, height})
  const ctx = boardContext()
  ctx.clearRect(0, 0, ui.stage.clientWidth, ui.stage.clientHeight)
  for (const stroke of orderedStrokes(session.board)) drawStroke(ctx, stroke, rect)
}

function receiveBoard(message, peerId) {
  if (message?.type === 'stroke') {
    const stroke = addStrokeChunk(session.board, message)
    if (!stroke) return
    syncBoardLayout(true)
    if (!boardOpen() && !ui.room.classList.contains('board-visible')) ui.boardToggle.classList.add('activity')
  } else if (message?.type === 'clear') {
    clearBoard(session.board, message.at)
    syncBoardLayout(true)
    toast(`${person(peerId).name || 'Someone'} cleared the board`)
  } else if (message?.type === 'sync') {
    mergeSnapshot(session.board, message)
    syncBoardLayout(true)
  }
}

// Samples closer together than this (in picture heights) are dropped: a high-rate pointer reports
// hundreds of near-identical positions a second, which fills a stroke without drawing anything more.
const MIN_POINT_STEP = 0.002

// `previous` is the last coordinate pair already in the stroke, so decimation carries across events.
function boardPoints(event, previous) {
  const box = ui.stage.getBoundingClientRect()
  const rect = currentPictureRect()
  const events = event.getCoalescedEvents?.() || []
  const aspect = rect.height ? rect.width / rect.height : 1
  const points = []
  let last = previous
  for (const e of events.length ? events : [event]) {
    const x = Math.round(((e.clientX - box.left - rect.x) / rect.width) * 10000) / 10000
    const y = Math.round(((e.clientY - box.top - rect.y) / rect.height) * 10000) / 10000
    if (last) {
      const dx = (x - last[0]) * aspect
      const dy = y - last[1]
      if (dx * dx + dy * dy < MIN_POINT_STEP * MIN_POINT_STEP) continue
    }
    points.push(x, y)
    last = [x, y]
  }
  return points
}

const lastPoint = (stroke) => (stroke.points.length >= 2 ? stroke.points.slice(-2) : null)

// Starts the stroke this person is drawing, flushing whatever the previous one still owes.
function startStroke(points, color, size) {
  sendStroke()
  const id = `${selfId}:${Date.now().toString(36)}:${strokeCount++}`
  const stroke = addStrokeChunk(session.board, {id, color, size, at: nextRevision(session.board.revision), points})
  drawing = stroke ? {stroke, sent: 0} : null
  return Boolean(stroke)
}

// A stroke holds at most MAX_COORDINATES coordinates. When one fills up the line continues as a new
// stroke that begins at the last point, so a long drawing carries on instead of stopping dead.
function extendStroke(points) {
  let rest = points
  while (rest.length) {
    const {stroke} = drawing
    const room = MAX_COORDINATES - stroke.points.length
    if (room <= 0) {
      if (!startStroke(lastPoint(stroke), stroke.color, stroke.size)) return false
      continue
    }
    const chunk = rest.slice(0, room)
    rest = rest.slice(room)
    if (!addStrokeChunk(session.board, {...stroke, offset: stroke.points.length, points: chunk})) return false
  }
  return true
}

function sendStroke() {
  if (!drawing || !session.boardAction) return
  const {stroke, sent} = drawing
  if (stroke.points.length <= sent) return
  const {id, color, size, at} = stroke
  session.boardAction.send({type: 'stroke', id, color, size, at, offset: sent, points: stroke.points.slice(sent, sent + MAX_COORDINATES)}).catch(() => {})
  drawing.sent = stroke.points.length
}

function endStroke() {
  sendStroke()
  drawing = null
}

// The board holds MAX_STROKES strokes. Say so instead of letting the pen go quiet.
let boardFullAt = 0
function boardFull() {
  if (Date.now() - boardFullAt < 5000) return
  boardFullAt = Date.now()
  toast('The board is full — clear it to keep drawing')
}

function clearBoardForEveryone() {
  // Cover strokes stamped by a clock slightly ahead of ours, too.
  const at = nextRevision(session.board.revision, session.board.clearedAt)
  clearBoard(session.board, at)
  session.boardAction?.send({type: 'clear', at}).catch(() => {})
  syncBoardLayout(true)
}

// The visibility eye hangs under the whiteboard button. It follows the pointer rather than :hover,
// so a click can't leave it focused and stuck open, and it closes when drawing is switched off.
let boardMenuTimer = null
function holdBoardMenu() {
  clearTimeout(boardMenuTimer)
  boardMenuTimer = null
  ui.boardMenu.classList.add('menu-open')
}
function releaseBoardMenu(delay = 400) {
  clearTimeout(boardMenuTimer)
  boardMenuTimer = setTimeout(() => ui.boardMenu.classList.remove('menu-open'), delay)
}

function setBoardOpen(open) {
  endStroke()
  if (!open) releaseBoardMenu(0)
  ui.room.classList.toggle('board-open', open)
  ui.boardToggle.setAttribute('aria-pressed', String(open))
  if (open) ui.boardToggle.classList.remove('activity')
  renderTools()
}

// The cursor is the tool in your hand: a pencil whose body carries the colour you're drawing in, and
// an eraser cut on the same diagonal. The silhouette does the contrast work — a soft dark halo under a
// thin white outline — so it reads over black, white or anything between. The segments inside it
// (graphite, bare wood, ferrule, rubber) are what make it read as a pencil rather than a wedge.
const PENCIL = {
  hot: '3 29',
  outline: 'M3 29 L6.61 21.29 L25.7 2.2 L29.8 6.3 L10.71 25.39 Z',
  // Tip last, so it paints over the segment behind it. A null fill takes the drawing colour.
  parts: [
    ['M22.16 5.74 L25.7 2.2 L29.8 6.3 L26.26 9.84 Z', '#efa3a3'],
    ['M19.33 8.56 L22.16 5.74 L26.26 9.84 L23.44 12.67 Z', '#c8ccd4'],
    ['M6.61 21.29 L19.33 8.56 L23.44 12.67 L10.71 25.39 Z', null],
    ['M3 29 L6.61 21.29 L10.71 25.39 Z', '#f1e3c6'],
    ['M3 29 L4.58 25.63 L6.37 27.42 Z', '#33333d'],
  ],
  seams: ['M6.61 21.29 L10.71 25.39', 'M19.33 8.56 L23.44 12.67', 'M22.16 5.74 L26.26 9.84'],
}
const RUBBER = {
  hot: '4 28',
  outline: 'M1.74 25.74 L15.88 11.6 L20.4 16.12 L6.26 30.26 Z',
  parts: [
    ['M6.33 21.14 L15.88 11.6 L20.4 16.12 L10.86 25.67 Z', '#6f8fc0'],
    ['M1.74 25.74 L6.33 21.14 L10.86 25.67 L6.26 30.26 Z', '#f8f5ef'],
  ],
  seams: ['M6.33 21.14 L10.86 25.67'],
}

function toolCursor() {
  const tool = tools.tool === 'eraser' ? RUBBER : PENCIL
  const path = (d, attrs) => `<path d="${d}" ${attrs}/>`
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">' +
    path(tool.outline, 'fill="none" stroke="#000" stroke-opacity=".45" stroke-width="2.6" stroke-linejoin="round"') +
    tool.parts.map(([d, fill]) => path(d, `fill="${fill || tools.color}"`)).join('') +
    tool.seams.map((d) => path(d, 'fill="none" stroke="#000" stroke-opacity=".22" stroke-width=".8"')).join('') +
    path(tool.outline, 'fill="none" stroke="#fff" stroke-width="1.05" stroke-linejoin="round"') +
    '</svg>'
  // The hotspot is the point of the tool, not its middle.
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${tool.hot}, crosshair`
}

function renderTools() {
  ui.room.classList.toggle('pen', Boolean(tools.tool) && boardOpen())
  ui.board.style.cursor = tools.tool ? toolCursor() : ''
  ui.pen.classList.toggle('active', tools.tool === 'pen')
  ui.eraser.classList.toggle('active', tools.tool === 'eraser')
  for (const swatch of ui.swatches.children) swatch.classList.toggle('active', swatch.dataset.color === tools.color)
  for (const size of ui.sizes.children) size.classList.toggle('active', Number(size.dataset.size) === tools.size)
}

// ---------- Playlist ----------
// Anyone adds files from their own computer. A file never leaves its owner's app: playing an item
// asks the owner to host it, and when it ends the host starts the next one it can.

const PLAY_ICON = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>'
// File capabilities are restored only from this identity's local copy of this room.
let itemCount = 0

function loadAddedMedia(items, {replace = false} = {}) {
  if (!items.length || (!replace && session.role !== 'idle')) return
  const item = items[0]
  const options = {start: 0, autoplay: false}
  if (item.youtubeId) hostYouTube(item, options)
  else hostFile(session.ownFiles.get(item.id), item, options)
}

function addToPlaylist(filePaths, {notify = true} = {}) {
  if (!session.room) return []
  const added = []
  for (const filePath of filePaths.filter((p) => p && !SUBTITLE_FILE.test(p))) {
    const id = `${selfId}:${Date.now().toString(36)}:${itemCount++}`
    const message = {id, title: filePath.split(/[\\/]/).pop(), position: endPosition(session.playlist), ownerName: myName}
    const item = addItem(session.playlist, message, identity.username)
    if (!item) { toast('Playlist limit reached. Remove items, or open a new room if its history is full.', true); break }
    session.ownFiles.set(message.id, filePath)
    session.playlistAction.send({type: 'add', ...message}).catch(() => {})
    added.push(item)
  }
  if (added.length && notify) toast(added.length === 1 ? 'Added to the playlist' : `Added ${added.length} files to the playlist`)
  saveRoom()
  refreshAvailability()
  render()
  return added
}

function removeFromPlaylist(id) {
  removeItem(session.playlist, id)
  session.ownFiles.delete(id)
  session.availableFiles.delete(id)
  stopRemovedPlayback()
  session.playlistAction?.send({type: 'remove', id}).catch(() => {})
  saveRoom()
  shareAvailability()
  render()
}

// Tombstones also cover removals learned from snapshots and delayed host states.
function stopRemovedPlayback() {
  const id = isHost() ? session.playing?.id : session.remote?.playlistId
  if (!id || !session.playlist.removed.has(id)) return false
  const advance = isHost()
  const options = {autoplay: false, preview: Boolean(session.preview)}
  const cursor = session.playing || session.playlist.current
  const remaining = orderedItems(session.playlist).filter(playable)
  const next = nextItem(session.playlist, cursor, playable) || remaining.at(-1)
  session.remote = null
  session.hostId = null
  session.mediaError = null
  session.role = 'idle'
  detachRemoteStream()
  stopHosting()
  // Only the host advances; viewers follow its replacement claim.
  if (advance && next) playItem(next.id, null, options)
  return true
}

// Moves item `id` to `index` among the other items, for everyone.
function moveInPlaylist(id, index) {
  const item = session.playlist.items.get(id)
  const position = item && positionAt(session.playlist, id, index)
  if (position == null) return
  // Stamped after the item's last move, so it wins even if that came from a clock running ahead.
  const move = {id, position, movedAt: nextRevision(session.playlist.revision), movedBy: selfId}
  if (moveItem(session.playlist, move)) session.playlistAction?.send({type: 'move', ...move}).catch(() => {})
  saveRoom()
  render()
}

function receivePlaylist(message, peerId) {
  const username = session.identities.get(peerId)
  if (!username) return
  if (message?.type === 'add') addItem(session.playlist, message, username)
  else if (message?.type === 'remove') {
    removeItem(session.playlist, message.id)
    session.ownFiles.delete(message.id)
    session.availableFiles.delete(message.id)
  } else if (message?.type === 'move') moveItem(session.playlist, {...message, movedBy: peerId})
  else if (message?.type === 'sync') {
    mergePlaylist(session.playlist, message, {selfId: identity.username, ownFiles: session.ownFiles})
    for (const id of session.ownFiles.keys()) if (!session.playlist.items.has(id)) {
      session.ownFiles.delete(id)
      session.availableFiles.delete(id)
    }
    if (session.role === 'idle') session.loop = session.playlist.current?.loop || false
    stopRemovedPlayback()
    if (isHost()) broadcastState()
  }
  else if (message?.type === 'availability') {
    if (!Array.isArray(message.ids) || message.ids.length > 500) return
    session.peerFiles.set(peerId, new Set(message.ids.filter((id) => typeof id === 'string' && id.length <= 100)))
  }
  else if (message?.type === 'play') playItem(message.id, peerId, {autoplay: message.autoplay !== false})
  stopRemovedPlayback()
  saveRoom()
  render()
}

function ownerPeer(item) {
  if (item.owner === identity?.username) return selfId
  return [...session.peers].find((id) => session.identities.get(id) === item.owner) || null
}
const playable = (item) => item.youtubeId ? true : item.owner === identity?.username
  ? session.ownFiles.has(item.id) && session.availableFiles.has(item.id)
  : Boolean(session.peerFiles.get(ownerPeer(item))?.has(item.id))
const ownerName = (item) => (item.owner === identity?.username ? 'you' : session.people.get(ownerPeer(item))?.name || item.ownerName || 'Someone')

function shareAvailability(target) {
  session.playlistAction?.send({type: 'availability', ids: [...session.availableFiles]}, target ? {target} : {}).catch(() => {})
}

async function refreshAvailability() {
  const current = session
  const entries = [...current.ownFiles]
  const generation = current.availabilityGeneration = (current.availabilityGeneration || 0) + 1
  try {
    const available = await window.api.availableFiles(entries.map(([, path]) => path))
    if (session !== current || current.closed || generation !== current.availabilityGeneration) return
    current.availableFiles = new Set(entries.filter(([id, path], i) => available[i] && current.ownFiles.get(id) === path).map(([id]) => id))
    shareAvailability()
    render()
    restoreObservedPlayback()
  } catch {
    if (session === current && !current.closed) toast('Could not check saved media files.', true)
  }
}

// Plays an item for everyone. `from` is the peer who asked, when the request came from someone else.
async function playItem(id, from = null, {autoplay = true, preview = false} = {}) {
  const item = session.playlist.items.get(id)
  if (!item) return
  if (item.youtubeId) return hostYouTube(item, {autoplay, preview})
  if (item.owner === identity.username) {
    const current = session
    const filePath = session.ownFiles.get(id)
    if (!filePath) return
    let available
    try { [available] = await window.api.availableFiles([filePath]) } catch {
      if (session === current && !current.closed) toast('Could not check this media file. Try again.', true)
      return
    }
    if (session !== current || current.closed || current.ownFiles.get(id) !== filePath || !current.playlist.items.has(id)) return
    if (available) {
      current.availableFiles.add(id)
      return hostFile(filePath, item, {autoplay, preview})
    }
    current.availableFiles.delete(id)
    shareAvailability()
    render()
    toast(`${item.title} is unavailable on this computer`, true)
    playNext(item)
  } else if (from == null) {
    // Only the owner's app has the file, so it hosts; nobody relays requests for someone else's.
    if (!playable(item)) return toast(`${item.title} is unavailable`, true)
    session.playlistAction.send({type: 'play', id, autoplay}, {target: ownerPeer(item)}).catch(() => {})
  }
}

function playNext(current = session.playing || session.playlist.current) {
  const next = nextItem(session.playlist, current, playable)
  if (next) playItem(next.id)
}

function resumeItem() {
  const current = session.playlist.current
  const item = session.playlist.items.get(current?.id)
  if (item && playable(item) && !session.playlist.progress.get(item.id)?.completed) return item
  return (current && nextItem(session.playlist, current, playable)) || orderedItems(session.playlist).find(playable) || null
}

// A row says where its playback stands: the live clock for what's playing, the saved checkpoint
// otherwise. No "Playing" label — the row is highlighted and the time is moving.
function playlistStatus({item, current, available, owner, progress}) {
  const live = current && session.role !== 'idle'
  const time = live ? currentTime() : progress?.time
  const duration = live ? currentDuration() : progress?.duration
  const position = !live && progress?.completed ? 'Finished'
    : live || progress ? `${formatTime(time)}${duration ? `/${formatTime(duration)}` : ''}` : ''
  return `${!available ? 'Unavailable · ' : ''}Added by ${owner}${position ? ` · ${position}` : ''}`
}

// Rewrite the status lines in place, matching by id so a half-dragged list still updates.
function paintPlaylistStatus(rows) {
  const statuses = new Map(rows.map((row) => [row.item.id, playlistStatus(row)]))
  for (const row of ui.playlistItems.children) {
    const stats = row.querySelector('.person-stats')
    const status = statuses.get(row.dataset.id)
    if (stats && status != null && stats.textContent !== status) stats.textContent = status
  }
}

function renderPlaylist() {
  const items = orderedItems(session.playlist)
  const current = isHost() ? session.playing?.id : session.remote?.playlistId || session.playlist.current?.id
  ui.playlistEmpty.hidden = items.length > 0
  const rows = items.map((item) => ({item, current: item.id === current, available: playable(item), owner: ownerName(item), progress: session.playlist.progress.get(item.id)}))
  // The playing row's position comes from the clock, so it's painted every render and left out of
  // the signature; rebuilding the list four times a second would throw away focus and hover.
  const signature = JSON.stringify(rows.map(({item, current, available, owner, progress}) => [item.id, item.title, current, available, owner,
    ...(current ? [] : [Math.floor(progress?.time || 0), Math.floor(progress?.duration || 0), progress?.completed])]))
  // Don't rebuild the rows under someone dragging one; the list catches up when they let go.
  if (ui.playlistItems.dataset.signature === signature || itemDrag) return paintPlaylistStatus(rows)
  ui.playlistItems.dataset.signature = signature
  ui.playlistItems.replaceChildren(
    ...rows.map(({item, current, available}, index) => {
      const row = element('li', 'playlist-item')
      row.dataset.id = item.id
      row.title = 'Drag to reorder'
      row.classList.toggle('current', current)
      row.classList.toggle('missing', !available)
      const play = element('button', 'playlist-play')
      play.innerHTML = PLAY_ICON
      play.disabled = !available
      play.title = available ? 'Play for everyone from the saved position' : item.owner === identity?.username ? 'File missing on this computer' : 'Unavailable until the owner rejoins with this file'
      play.setAttribute('aria-label', `Play ${item.title}`)
      play.addEventListener('click', () => playItem(item.id))
      const main = element('div', 'person-main')
      main.append(element('div', 'person-name', item.title), element('div', 'person-stats', playlistStatus(rows[index])))
      main.firstChild.title = item.title
      const remove = element('button', 'playlist-remove', '×')
      remove.title = 'Remove for everyone'
      remove.setAttribute('aria-label', `Remove ${item.title}`)
      remove.addEventListener('click', () => removeFromPlaylist(item.id))
      row.addEventListener('dblclick', (event) => {
        if (available && !event.target.closest('button')) playItem(item.id)
      })
      row.append(play, main, remove)
      return row
    }),
  )
}

// The drawer: click the tab to open or close it, or drag the tab or the open panel's left edge to
// pull it out to any width or push it closed.
let playlistWidth = DRAWER.defaultWidth // the width it opens at
let tabDrag = null // {startX, startWidth, width} while the tab or edge is held
let tabDragged = false // the click that follows a drag shouldn't also toggle

const playlistOpen = () => ui.room.classList.contains('playlist-open')
const fittedPlaylistWidth = () => Math.min(playlistWidth, maxDrawerWidth(innerWidth))

function showPlaylistWidth(width) {
  ui.room.style.setProperty('--playlist-width', `${width}px`)
  ui.room.classList.toggle('playlist-open', width > 0)
  ui.playlistTab.setAttribute('aria-expanded', String(width > 0))
}

function setPlaylistOpen(open) {
  showPlaylistWidth(open ? fittedPlaylistWidth() : 0)
  try {
    localStorage.setItem('playlist', JSON.stringify({open, width: playlistWidth}))
  } catch {}
}

function endTabDrag() {
  const drag = tabDrag
  tabDrag = null
  ui.room.classList.remove('resizing')
  tabDragged = drag?.width != null
  if (!tabDragged) return
  const width = settledWidth(drag.width, maxDrawerWidth(innerWidth))
  if (width) playlistWidth = width
  setPlaylistOpen(width > 0)
}

// The tab turns black over bright pictures: a few times a second, read the pixels behind it.
const toneCanvas = Object.assign(document.createElement('canvas'), {width: 4, height: 12})
const toneContext = toneCanvas.getContext('2d', {willReadFrequently: true})
let tabTone = 'light'

// What's showing on the stage, with its own pixel size; null for a blank or audio-only stage.
function visibleSource() {
  if (shownImage()) {
    const {picture} = ui
    return picture.complete && picture.naturalWidth ? {element: picture, width: picture.naturalWidth, height: picture.naturalHeight} : null
  }
  if (session.role === 'idle') return null
  const video = isHost() ? ui.localVideo : ui.remoteVideo
  return video.videoWidth && video.readyState >= 2 ? {element: video, width: video.videoWidth, height: video.videoHeight} : null
}

function sampleTabTone() {
  if (ui.room.hidden || ui.room.classList.contains('idle')) return
  const stage = ui.stage.getBoundingClientRect()
  const tab = ui.playlistTab.querySelector('svg').getBoundingClientRect() // the chevron, not its large hit area
  const target = {x: tab.left - stage.left, y: tab.top - stage.top, width: tab.width, height: tab.height}
  const source = visibleSource()
  const rect = source && pictureRect(stage.width, stage.height, source.width, source.height)
  const region = source && sourceRegion(target, rect, source.width, source.height)
  let luminance = 0
  if (region) {
    try {
      toneContext.clearRect(0, 0, toneCanvas.width, toneCanvas.height)
      toneContext.drawImage(source.element, region.sx, region.sy, region.sw, region.sh, 0, 0, toneCanvas.width, toneCanvas.height)
      luminance = averageLuminance(toneContext.getImageData(0, 0, toneCanvas.width, toneCanvas.height).data)
    } catch {}
  }
  tabTone = toneFor(luminance, tabTone)
  if (ui.playlistTab.dataset.tone !== tabTone) ui.playlistTab.dataset.tone = tabTone
}

// ---------- Reactions ----------
// Air horn, golf clap, quack and confetti: everyone in the room sees who sent one and hears it.

const REACTION_SHOWN_MS = 2600
const allowReaction = createRateLimiter()
let audio = null
let confetti = []
let confettiFrame = null
let confettiTime = 0

function react(kind) {
  if (!session.room || !REACTIONS[kind] || !allowReaction(selfId, performance.now())) return
  session.reactAction.send({kind}).catch(() => {})
  showReaction(kind, myName)
}

function receiveReaction(kind, peerId) {
  if (!REACTIONS[kind] || !session.peers.has(peerId) || !allowReaction(peerId, performance.now())) return
  showReaction(kind, person(peerId).name || 'Someone')
}

function showReaction(kind, name) {
  const {emoji, label} = REACTIONS[kind]
  const bubble = element('div', 'reaction-bubble')
  bubble.title = label
  bubble.append(element('span', 'reaction-emoji', emoji), element('span', null, name))
  ui.reactionFeed.append(bubble)
  setTimeout(() => bubble.remove(), REACTION_SHOWN_MS)
  playReaction(kind)
  if (kind === 'confetti') startConfetti()
}

// Reactions follow the app's volume, so muting silences them too.
function playReaction(kind) {
  const volume = Number(ui.volume.value)
  if (!volume) return
  try {
    const out = audioOutput()
    const gain = audio.createGain()
    gain.connect(out)
    playReactionSound(audio, gain, kind)
    setTimeout(() => gain.disconnect(), 3000)
  } catch {}
}

function startConfetti() {
  const dpr = window.devicePixelRatio || 1
  Object.assign(ui.confetti, {width: Math.round(innerWidth * dpr), height: Math.round(innerHeight * dpr)})
  confetti.push(...launchConfetti(innerWidth, innerHeight))
  ui.confetti.hidden = false
  if (confettiFrame != null) return
  confettiTime = performance.now()
  confettiFrame = requestAnimationFrame(animateConfetti)
}

function animateConfetti(now) {
  const dt = Math.min(0.05, Math.max(0, now - confettiTime) / 1000)
  confettiTime = now
  confetti = stepConfetti(confetti, dt, innerHeight)
  const ctx = ui.confetti.getContext('2d')
  const dpr = window.devicePixelRatio || 1
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, innerWidth, innerHeight)
  drawConfetti(ctx, confetti)
  if (confetti.length) {
    confettiFrame = requestAnimationFrame(animateConfetti)
  } else {
    confettiFrame = null
    ui.confetti.hidden = true
  }
}

// ---------- Subtitles ----------
// Text subtitles are drawn by each person's own app, so everyone picks their own track (or none).
// Image subtitles (PGS, VobSub) can only be burned into the stream, so they show for everyone.

function hostCues(id) {
  const subtitleId = session.catalog.resolve(id)
  if (!isHost() || !player.media?.subtitles.some((s) => s.id === subtitleId && !s.image)) throw new Error('Subtitle track not found')
  return window.api.subtitleCues({filePath: player.media.filePath, subtitleId})
}

function loadCues(id, signal) {
  const localPath = session.catalog.local.get(id)
  if (localPath) return window.api.subtitleCues({subtitleId: `external:${localPath}`})
  if (typeof id !== 'string' || !/^track:\d{1,3}$/.test(id)) throw new Error('Subtitle track not found')
  if (isHost()) return hostCues(id)
  return session.cuesAction.request({id, hostId: session.hostId, claimedAt: session.remote.claimedAt}, {target: session.hostId, timeoutMs: CUES_TIMEOUT_MS, signal})
}

async function selectSubtitle(id) {
  const current = session
  current.captions.controller?.abort()
  const controller = new AbortController()
  const captions = current.captions = {...current.captions, id: id || null, cues: [], controller}
  if (!id) return
  const active = () => session === current && !current.closed && current.captions === captions && !controller.signal.aborted
  const slow = setTimeout(() => { if (active()) toast('Loading subtitles…') }, 400)
  try {
    const cues = await loadCues(id, controller.signal)
    if (active()) captions.cues = cleanCues(cues)
  } catch (err) {
    if (!active()) return
    captions.id = null
    toast(`Couldn't load subtitles: ${errorMessage(err)}`, true)
  } finally { clearTimeout(slow) }
}

// A new video starts everyone on its default text track, if it has one.
function syncCaptionsToMedia(state) {
  const key = state && !state.loading ? `${state.hostId}:${state.claimedAt}` : null
  if (key === session.captions.mediaKey) return
  session.captions.mediaKey = key
  session.localSubtitles = []
  selectSubtitle(state?.subtitles?.find((s) => s.isDefault && !s.image)?.value)
}

function addSubtitleFile(filePath) {
  if (session.role === 'idle') return toast('Open media first')
  if (isHost()) {
    const id = player.addExternalSubtitle(filePath)
    session.catalog.publish(player.media.subtitles)
    return selectSubtitle(session.catalog.remote.get(id))
  }
  const value = session.catalog.addLocal(filePath)
  if (!session.localSubtitles.some((s) => s.value === value)) session.localSubtitles.push({value, label: filePath.split(/[\\/]/).pop()})
  selectSubtitle(value)
}

// The viewer's picture trails the host's clock by the jitter buffer, so captions wait for it.
let captionsShown = ''
function drawCaptions() {
  requestAnimationFrame(drawCaptions)
requestAnimationFrame(drawFilters)
  const {cues} = session.captions
  const delayMs = isHost() || youtube.videoId ? 0 : session.frameDelayMs ?? ((session.playoutDelayMs ?? session.buffer.bufferMs) + (session.link?.rttMs || 0) / 2 + DECODE_DELAY_MS)
  const html = cues.length && session.role !== 'idle' ? captionHtml(cues, currentTime() - delayMs / 1000) : ''
  if (html !== captionsShown) ui.captions.innerHTML = captionsShown = html
}

// ---------- Shared controls ----------

const isHost = () => session.role === 'host'
const currentTime = () => (isHost() ? youtube.videoId ? youtube.time : ui.localVideo.currentTime : viewerTime())
const currentDuration = () => (isHost() ? youtube.videoId ? youtube.duration : player.duration : session.remote?.duration || 0)
// A video that reaches its end is paused just before 'ended' fires. With loop on it restarts
// straight away, so that moment still counts as playing: the UI stays hidden and viewers never see a pause.
const hostPlaying = () => youtube.videoId ? youtube.playing || (session.loop && youtube.ended) : !ui.localVideo.paused || (session.loop && ui.localVideo.ended)
const isPlaying = () => (isHost() ? hostPlaying() : Boolean(session.remote?.playing))

function control(cmd, value) {
  if (session.preview && cmd === 'play') activatePreview()
  if (isHost() ? session.image : session.remote?.image) return // a picture has nothing to play
  if (isHost()) return applyCommand(cmd, value)
  const r = session.remote
  if (session.role !== 'viewer' || !r || r.ended || performance.now() - r.receivedAt > HOST_TIMEOUT_MS) return
  session.commandAction.send({cmd, value, hostId: session.hostId, claimedAt: r.claimedAt}, {target: session.hostId, signal: session.lifetime.signal}).catch(() => toast('Playback command was not delivered. Try again.', true))
  session.steady = {...session.steady, since: null}
  // Reflect the change immediately; the host's next state message confirms it.
  const now = performance.now()
  r.sentAt = now + (session.clock?.offset || 0)
  if (cmd === 'play' || cmd === 'pause') Object.assign(r, {time: viewerTime(), playing: cmd === 'play', receivedAt: now})
  else if (cmd === 'seek') Object.assign(r, {time: Number(value), receivedAt: now})
  else if (cmd === 'loop') session.loop = Boolean(value)
  else if (cmd === 'audio') r.audioSelected = value
  else if (cmd === 'subtitle') r.subtitleSelected = value
  render()
}

const togglePlay = () => control(isPlaying() ? 'pause' : 'play')
const toggleLoop = () => control('loop', !session.loop)

// Plex-style skips: 10 seconds back, 30 forward. The arrow keys do the same.
function skip(seconds) {
  const duration = currentDuration()
  const target = Math.max(0, currentTime() + seconds)
  control('seek', duration ? Math.min(target, duration) : target)
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen()
  else ui.room.requestFullscreen().catch(() => {})
}

function fillSelect(select, options, selected) {
  const signature = JSON.stringify(options)
  if (select.dataset.signature !== signature) {
    select.replaceChildren(...options.map((o) => new Option(o.label, o.value)))
    select.dataset.signature = signature
  }
  if (document.activeElement !== select) select.value = selected
}

function render() {
  const role = session.role
  const host = role === 'host'
  const r = session.remote
  const stale = role === 'viewer' && r && performance.now() - r.receivedAt > HOST_TIMEOUT_MS
  const mediaError = host ? session.mediaError : r?.error
  const ready = host ? player.loaded || youtube.loaded || Boolean(session.image) : Boolean(r && !r.loading && !r.ended && !stale)
  const duration = currentDuration()
  const time = currentTime()

  const peerCount = session.peers.size
  const connection = roomConnection(session.connection, peerCount, performance.now())
  ui.peerStatus.textContent = connection.text
  ui.peerStatus.title = connection.detail
  ui.peerStatus.classList.toggle('problem', connection.problem)
  ui.peerStatus.classList.toggle('connected', peerCount > 0)
  renderPeople()
  renderPlaylist()
  const resume = role === 'idle' ? resumeItem() : null
  ui.stage.classList.toggle('has-playlist', session.playlist.items.size > 0)
  sampleTabTone()
  syncBoardLayout()
  syncPresence()
  const health = peerCount && session.link ? describeLink({selfRole: role, ...session.link}) : null
  ui.link.hidden = !health
  if (health) {
    ui.link.textContent = health.text
    ui.link.title = health.detail
    ui.link.dataset.level = health.level
  }
  // Problems show as a faint caution sign on the video; hover it for the explanation.
  const problem = connection.problem || stale || Boolean(network.error) || (health && health.level !== 'good')
  ui.linkWarning.hidden = !problem
  if (problem) ui.linkWarningTip.textContent = stale ? 'The host stopped responding. Waiting for playback to recover.' : network.error || (connection.problem ? connection.detail : health?.detail)
  const title = (host ? hostedTitle() : r?.title) || ''
  const converting = (host ? player.transcoding : r?.transcoding) ? ' · converting' : ''
  ui.role.textContent = {host: session.preview ? 'Ready to resume' : `Hosting${converting}`, viewer: `Watching${converting}`, idle: session.connection.joining && !peerCount ? 'Joining room' : ''}[role]

  const image = shownImage()
  const imageMode = Boolean(host ? session.image : r?.image)
  ui.pausedTitle.textContent = title || resume?.title || ''
  ui.pausedTitle.hidden = !ui.pausedTitle.textContent || imageMode || Boolean(youtube.videoId) || !(resume || (ready && !isPlaying()))
  const receivingImage = role === 'viewer' && imageMode && !image
  if (receivingImage && performance.now() - session.imageRetryAt > 15_000) {
    session.imageRetryAt = performance.now()
    session.imageRequest.send({id: r.image.id}, {target: session.hostId, signal: session.lifetime.signal}).catch(() => {})
  }
  ui.stage.classList.toggle('showing-image', imageMode)
  const youtubeMode = Boolean(host ? youtube.videoId : r?.youtubeId)
  ui.stage.classList.toggle('showing-youtube', youtubeMode)
  ui.youtubePlayer.hidden = !youtubeMode
  if (youtubeMode && !host && stale) youtube.pause()
  showPicture(image?.url || null)

  ui.stage.classList.toggle('waiting', Boolean(mediaError) || (role === 'viewer' && (!ready || receivingImage)))
  const progress = receivingImage && session.imageProgress?.id === r.image.id ? session.imageProgress.percent : 0
  ui.emptyText.textContent = mediaError ? mediaError : stale ? 'The host stopped responding. Waiting for playback to recover…' : receivingImage
    ? `Receiving the picture… ${Math.round(progress * 100)}%`
    : role === 'viewer'
      ? 'Your friend is opening something…'
      : connection.problem ? connection.detail : ''
  const audioOnly = ready && (host ? Boolean(player.media && !player.media.video) : Boolean(r?.audioOnly))
  ui.audioOnly.hidden = !audioOnly
  if (audioOnly) ui.audioOnlyTitle.textContent = title
  const stalled = youtubeMode ? youtube.buffering : host ? player.loaded && hostPlaying() && ui.localVideo.readyState < 3 : role === 'viewer' && (r?.buffering || (ready && ui.remoteVideo.readyState < 2))
  ui.spinner.hidden = !stalled || Boolean(mediaError) || Boolean(stale)

  ui.controls.classList.toggle('disabled', !ready)
  // A picture has nothing to play, seek or loop (control ignores them), so say so.
  ui.play.disabled = ui.loop.disabled = ui.seek.disabled = imageMode
  ui.play.dataset.state = isPlaying() ? 'playing' : 'paused'
  ui.loop.classList.toggle('active', session.loop)
  ui.loop.setAttribute('aria-pressed', String(session.loop))
  ui.time.textContent = formatTime(time)
  ui.duration.textContent = formatTime(duration)
  if (!session.seeking) ui.seek.value = duration ? String(Math.round((time / duration) * 1000)) : '0'

  const state = host ? hostState() : r
  const audio = state?.audio || []
  fillSelect(ui.audio, audio, state?.audioSelected ?? '')
  ui.audio.hidden = audio.length <= 1
  syncCaptionsToMedia(role === 'idle' ? null : state)
  const subtitles = [
    {value: '', label: 'Subtitles off'},
    ...(state?.subtitles || []).map((s) => ({value: s.value, label: s.image ? `${s.label} · for everyone` : s.label})),
    ...session.localSubtitles,
  ]
  // With no tracks there's nothing to pick; dropping a subtitle file on the stage adds one.
  ui.subtitles.hidden = subtitles.length <= 1
  if (ready) subtitles.push({value: LOAD_SUBTITLE, label: 'Load subtitle file…'})
  fillSelect(ui.subtitles, subtitles, session.captions.id ?? state?.subtitleSelected ?? '')

  if (!isPlaying()) ui.room.classList.remove('idle')
  else if (!chromeTimer && !ui.room.classList.contains('idle')) wakeChrome()
}

let toastTimer = null
function toast(message, isError = false) {
  ui.toast.textContent = message
  ui.toast.classList.toggle('error', isError)
  ui.toast.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (ui.toast.hidden = true), isError ? 7000 : 2500)
}

// ---------- Wiring ----------

ui.create.addEventListener('click', () => enterRoom(generateRoomCode(), {joining: false}))

ui.joinForm.addEventListener('submit', (event) => {
  event.preventDefault()
  const code = normalizeRoomCode(ui.joinCode.value)
  const valid = code.length === 8
  ui.joinCode.classList.toggle('invalid', !valid)
  if (valid) enterRoom(code)
})

ui.code.addEventListener('click', async () => {
  await navigator.clipboard.writeText(formatRoomCode(session.code)).catch(() => {})
  toast('Room code copied')
})

ui.leave.addEventListener('click', leaveRoom)

ui.boardToggle.addEventListener('click', () => setBoardOpen(!boardOpen()))
ui.boardMenu.addEventListener('pointerenter', holdBoardMenu)
ui.boardMenu.addEventListener('pointerleave', () => releaseBoardMenu())
ui.boardMenu.addEventListener('focusin', holdBoardMenu)
ui.boardMenu.addEventListener('focusout', () => releaseBoardMenu())
ui.room.classList.add('board-visible')
ui.boardVisibility.addEventListener('click', () => {
  const visible = ui.room.classList.toggle('board-visible')
  ui.boardVisibility.setAttribute('aria-pressed', String(visible))
  if (visible) ui.boardToggle.classList.remove('activity')
})
for (const [button, tool] of [[ui.pen, 'pen'], [ui.eraser, 'eraser']]) {
  button.addEventListener('click', () => {
    tools.tool = tools.tool === tool ? null : tool
    renderTools()
  })
}
for (const color of COLORS) {
  const swatch = element('button', 'swatch')
  swatch.dataset.color = color
  swatch.style.background = color
  swatch.title = 'Pen colour'
  swatch.addEventListener('click', () => {
    Object.assign(tools, {color, tool: 'pen'})
    renderTools()
  })
  ui.swatches.append(swatch)
}
BRUSH_SIZES.forEach((_, size) => {
  const button = element('button', 'size')
  button.dataset.size = String(size)
  button.title = ['Thin', 'Medium', 'Thick', 'Marker'][size]
  const dot = element('span')
  dot.style.width = dot.style.height = `${[4, 7, 11, 16][size]}px`
  button.append(dot)
  button.addEventListener('click', () => {
    // Sizes apply to the eraser too, so picking one keeps it selected.
    Object.assign(tools, {size, tool: tools.tool || 'pen'})
    renderTools()
  })
  ui.sizes.append(button)
})
ui.boardClear.addEventListener('click', clearBoardForEveryone)
renderTools()

ui.board.addEventListener('pointerdown', (event) => {
  if (!tools.tool || event.button !== 0 || !session.room) return
  ui.board.setPointerCapture(event.pointerId)
  const color = tools.tool === 'eraser' ? ERASER : tools.color
  if (!startStroke(boardPoints(event).slice(0, 2), color, tools.size)) return boardFull()
  drawStroke(boardContext(), drawing.stroke, currentPictureRect())
})
ui.board.addEventListener('pointermove', (event) => {
  if (!drawing) return
  const points = boardPoints(event, lastPoint(drawing.stroke))
  if (!points.length) return
  if (!extendStroke(points)) {
    drawing = null
    boardFull()
  }
  syncBoardLayout(true)
})
ui.board.addEventListener('pointerup', endStroke)
ui.board.addEventListener('pointercancel', endStroke)
window.addEventListener('resize', () => syncBoardLayout())

ui.peopleToggle.addEventListener('click', () => setPeopleOpen(!ui.room.classList.contains('people-open')))
document.addEventListener('pointerdown', (event) => {
  // Clicking anywhere off the sidebar puts it away. The toggle is left out so its own click still toggles.
  if (ui.room.classList.contains('people-open') && !event.target.closest('.sidebar, .people-toggle')) setPeopleOpen(false)
})
function syncRoomNameSave() {
  const typed = cleanText(ui.roomName.value, MAX_ROOM_NAME_LENGTH)
  markUnsaved(ui.roomName, Boolean(typed) && typed !== (session.details?.name || ''))
}

function saveRoomName() {
  if (!session.room) return
  const details = renameRoom(ui.roomName.value, session.details, selfId)
  if (details !== session.details) {
    session.details = details
    saveRoom()
    session.detailsAction.send(session.details).catch(() => toast('Room name could not be shared. Try again.', true))
  }
  ui.roomName.value = session.details?.name || ''
  syncRoomNameSave()
}
ui.roomNameForm.addEventListener('submit', (event) => {
  event.preventDefault()
  saveRoomName()
  ui.roomName.blur()
})
ui.roomName.addEventListener('input', syncRoomNameSave)
ui.roomName.addEventListener('change', saveRoomName)
ui.roomName.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  ui.roomName.value = session.details?.name || ''
  syncRoomNameSave()
  ui.roomName.blur()
})
try {
  setPeopleOpen(localStorage.getItem('peopleOpen') !== '0')
} catch {
  setPeopleOpen(true)
}

// The hover sheen follows the pointer (`.sheen` in styles.css). One listener on home covers the
// saved-room rows too, which are rebuilt whenever the list changes.
ui.home.addEventListener('pointermove', (event) => {
  const shape = event.target.closest?.('.sheen')
  if (!shape) return
  const box = shape.getBoundingClientRect()
  shape.style.setProperty('--sheen-x', `${event.clientX - box.left}px`)
  shape.style.setProperty('--sheen-y', `${event.clientY - box.top}px`)
})

for (const handle of [ui.playlistTab, ui.playlistEdge]) {
  const trackPlaylistHover = (event) => {
    const y = event.clientY - ui.playlist.getBoundingClientRect().top
    ui.playlist.style.setProperty('--playlist-hover-y', `${y}px`)
  }
  handle.addEventListener('pointerenter', trackPlaylistHover)
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    event.preventDefault() // no text selection while dragging the edge
    handle.setPointerCapture(event.pointerId)
    tabDragged = false
    tabDrag = {startX: event.clientX, startWidth: playlistOpen() ? fittedPlaylistWidth() : 0, width: null}
  })
  handle.addEventListener('pointermove', (event) => {
    trackPlaylistHover(event)
    if (!tabDrag) return
    const dx = event.clientX - tabDrag.startX
    if (tabDrag.width == null && Math.abs(dx) < 4) return // still a click
    ui.room.classList.add('resizing')
    tabDrag.width = draggedWidth(tabDrag.startWidth, dx, maxDrawerWidth(innerWidth))
    showPlaylistWidth(tabDrag.width)
  })
  handle.addEventListener('pointerup', endTabDrag)
  handle.addEventListener('pointercancel', endTabDrag)
}
ui.playlistTab.addEventListener('click', () => {
  if (tabDragged) tabDragged = false
  else setPlaylistOpen(!playlistOpen())
})
ui.playlistEdge.addEventListener('dblclick', () => {
  if (!tabDragged && playlistOpen()) setPlaylistOpen(false)
})
window.addEventListener('resize', () => {
  if (playlistOpen() && !tabDrag) showPlaylistWidth(fittedPlaylistWidth())
})
try {
  const saved = JSON.parse(localStorage.getItem('playlist'))
  if (Number.isFinite(saved?.width)) playlistWidth = Math.min(DRAWER.maxWidth, Math.max(DRAWER.minWidth, saved.width))
  setPlaylistOpen(Boolean(saved?.open))
} catch {
  setPlaylistOpen(false)
}

function setPlaylistAddOpen(open) {
  ui.playlistAddArea.classList.toggle('url-open', open)
  ui.playlistUrlReveal.inert = !open
  ui.playlistAddUrl.setAttribute('aria-expanded', String(open))
}
ui.playlistAdd.addEventListener('click', async () => {
  const current = session
  setPlaylistAddOpen(false)
  const paths = await window.api.chooseMediaFiles()
  if (session === current && !current.closed) loadAddedMedia(addToPlaylist(paths))
})
ui.playlistAddUrl.addEventListener('click', () => {
  const open = ui.playlistAddUrl.getAttribute('aria-expanded') !== 'true'
  setPlaylistAddOpen(open)
  if (open) {
    const input = ui.playlistUrlForm.querySelector('input')
    input.focus()
    input.select()
  }
})
document.addEventListener('pointerdown', (event) => {
  if (!ui.playlistAddArea.contains(event.target) && !ui.playlistUrlForm.querySelector('input').value.trim() && !ui.playlistUrlForm.querySelector('button').disabled) setPlaylistAddOpen(false)
})
ui.playlistAddArea.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  setPlaylistAddOpen(false)
  ui.playlistAddUrl.focus()
})

// Reordering, like Spotify: hold a row and drag it. It follows the pointer (kept inside the list), the
// rows it passes slide aside to open a gap where it will land, and near the top or bottom edge the
// list scrolls. On release it glides into the gap, then the list is reordered for everyone.
const SETTLE_MS = 170
let itemDrag = null // {id, row, rows, tops, from, to, startY, startScroll, y, lifted, settling} while a row is held

function updateItemDrag() {
  const {row, rows, tops, from, startY, startScroll, y} = itemDrag
  const dy = clampDrag(tops, from, y - startY + ui.playlistItems.scrollTop - startScroll)
  const to = dropIndex(tops, from, dy)
  row.style.transform = `translateY(${dy}px)`
  if (to === itemDrag.to) return
  itemDrag.to = to
  rows.forEach((r, i) => {
    if (r !== row) r.style.transform = `translateY(${slotShift(tops, i, from, to)}px)`
  })
}

function scrollItemDrag() {
  if (!itemDrag?.lifted || itemDrag.settling) return
  const box = ui.playlistItems.getBoundingClientRect()
  const edge = 40
  const over = itemDrag.y < box.top + edge ? itemDrag.y - box.top - edge : itemDrag.y > box.bottom - edge ? itemDrag.y - box.bottom + edge : 0
  if (over) {
    ui.playlistItems.scrollTop += Math.max(-14, Math.min(14, over / 3))
    updateItemDrag()
  }
  requestAnimationFrame(scrollItemDrag)
}

function endItemDrag(commit) {
  const drag = itemDrag
  if (!drag || drag.settling) return
  if (!drag.lifted) return void (itemDrag = null)
  drag.settling = true
  const to = commit ? drag.to : drag.from
  drag.row.classList.add('settling')
  drag.row.style.transform = `translateY(${drag.tops[to] - drag.tops[drag.from]}px)`
  if (!commit) drag.rows.forEach((r) => r !== drag.row && (r.style.transform = ''))
  setTimeout(() => {
    itemDrag = null
    // Without the reordering class the rows lose their transition, so clearing the shifts is
    // instant and the rebuilt list appears exactly where the rows already are.
    ui.playlist.classList.remove('reordering')
    for (const r of drag.rows) {
      r.classList.remove('lifted', 'settling')
      r.style.transform = ''
    }
    if (commit) moveInPlaylist(drag.id, to)
    render()
  }, SETTLE_MS)
}

ui.playlistItems.addEventListener('pointerdown', (event) => {
  const row = event.target.closest('.playlist-item')
  if (itemDrag || !row || event.button !== 0 || event.target.closest('button')) return
  row.setPointerCapture(event.pointerId)
  const rows = [...ui.playlistItems.children]
  const from = rows.indexOf(row)
  const tops = rows.map((r) => r.offsetTop)
  const start = {startY: event.clientY, startScroll: ui.playlistItems.scrollTop, y: event.clientY}
  itemDrag = {id: row.dataset.id, row, rows, tops, from, to: from, ...start, lifted: false, settling: false}
})
ui.playlistItems.addEventListener('pointermove', (event) => {
  if (!itemDrag || itemDrag.settling) return
  itemDrag.y = event.clientY
  if (!itemDrag.lifted) {
    if (Math.abs(event.clientY - itemDrag.startY) < 4) return // still a click
    itemDrag.lifted = true
    itemDrag.row.classList.add('lifted')
    ui.playlist.classList.add('reordering')
    requestAnimationFrame(scrollItemDrag)
  }
  updateItemDrag()
})
ui.playlistItems.addEventListener('pointerup', () => endItemDrag(true))
ui.playlistItems.addEventListener('pointercancel', () => endItemDrag(false))
ui.playlistItems.addEventListener('lostpointercapture', () => endItemDrag(false))
// Files and YouTube links dropped on the playlist (or its closed tab) join the queue.
ui.playlist.addEventListener('dragover', (event) => {
  event.preventDefault()
  event.dataTransfer.dropEffect = 'copy'
  ui.playlist.classList.add('dropping')
  if (!playlistOpen()) setPlaylistOpen(true)
})
ui.playlist.addEventListener('dragleave', (event) => {
  if (!ui.playlist.contains(event.relatedTarget)) ui.playlist.classList.remove('dropping')
})
ui.playlist.addEventListener('drop', (event) => {
  event.preventDefault()
  ui.playlist.classList.remove('dropping')
  if (event.dataTransfer.files.length) {
    loadAddedMedia(addToPlaylist([...event.dataTransfer.files].map((file) => window.api.pathForFile(file)).filter(Boolean)))
    return
  }
  if (importingYouTube) return toast('A YouTube import is already in progress. Try again when it finishes.')
  try {
    const url = droppedYouTubeUrl({uriList: event.dataTransfer.getData('text/uri-list'),
      text: event.dataTransfer.getData('text/plain'), mozUrl: event.dataTransfer.getData('text/x-moz-url')})
    setPlaylistAddOpen(true)
    ui.playlistUrlForm.querySelector('input').value = url
    importYouTube(ui.playlistUrlForm, {replace: false})
  } catch (error) { toast(errorMessage(error), true) }
})

// The display name picked on the welcome screen, or changed since.
let savedName = null
try {
  savedName = cleanDisplayName(localStorage.getItem('displayName'))
} catch {}
if (savedName) myName = savedName
bindNameInput(ui.profileName)

// A new install, or an identity from before usernames had handles, starts on the welcome screen.
loadIdentity().then((loaded) => {
  if (loaded && savedName) finishWelcome(loaded, 'first')
  else return showWelcome('first')
}).catch((error) => {
  ui.startup.hidden = false
  ui.startupStatus.textContent = `Could not load your profile: ${errorMessage(error)}. Restart the app to try again.`
})

window.api.getVersion().then((version) => {
  if (typeof version === 'string' && version.length <= 40) ui.appVersion.textContent = `Version ${version}`
}, () => {})
ui.appVersion.addEventListener('click', () => window.api.openProject())

// Mac can't install updates itself, so home shows a card when a newer release is out.
window.api.checkForUpdate().then((update) => {
  if (!update) return
  const card = element('div', 'join-request')
  const label = element('span', null, `Version ${update.version} is out`)
  const download = element('button', 'primary small', 'Download')
  const steps = element('button', 'small', 'Install steps')
  const close = element('button', 'ghost small', 'Not now')
  download.addEventListener('click', () => {
    window.api.openUpdate('download')
    label.textContent = 'Open the download and drag the app into Applications'
    download.replaceWith(steps)
    close.textContent = 'Done'
  })
  steps.addEventListener('click', () => window.api.openUpdate('page'))
  close.addEventListener('click', () => card.remove())
  card.append(label, download, close)
  ui.homeInvites.append(card)
}, () => {})

ui.handle.addEventListener('input', updateWelcome)
ui.welcomeName.addEventListener('input', updateWelcome)
ui.welcomeCancel.addEventListener('click', () => {
  welcome = null
  ui.welcome.hidden = true
  ui.home.hidden = false
  showSettings(true)
})
ui.welcomeForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  const handle = normalizeHandle(ui.handle.value)
  const name = cleanDisplayName(ui.welcomeName.value) || DEFAULT_NAME
  const current = welcome
  if (!current || !handle) return
  ui.welcomeSubmit.disabled = true
  const next = saveIdentity(await createIdentity(handle, current.keys))
  myName = name
  try {
    localStorage.setItem('displayName', name)
  } catch {}
  finishWelcome(next, current.mode)
})

friendNetwork.addEventListener('change', renderFriends)
friendNetwork.addEventListener('join-ask', ({detail}) => receiveJoinAsk(detail))
friendNetwork.addEventListener('join-invite', ({detail}) => receiveJoinInvite(detail))
friendNetwork.addEventListener('join-offer', ({detail}) => receiveJoinOffer(detail))
friendNetwork.addEventListener('notice', ({detail}) => { showFriendNotice(detail.message); toast(detail.message, true) })
friendNetwork.addEventListener('join-declined', ({detail}) => showFriendNotice(`${detail.name} can't let you in right now.`, {error: false}))
renderFriends()

ui.addFriend.addEventListener('submit', (event) => {
  event.preventDefault()
  const error = identity && friendNetwork.identity === identity ? friendNetwork.add(ui.friendUsername.value) : 'Friends are still connecting. Try again in a moment.'
  showFriendNotice(error)
  if (!error) {
    ui.friendUsername.value = ''
    showFriendNotice('Friend added to your list. Delivery status appears below.', {error: false})
  }
})

// Home has no toast, so buttons confirm by briefly changing their own text.
function flashButton(button, text) {
  const original = button.dataset.original ?? button.textContent
  button.dataset.original = original
  button.textContent = text
  clearTimeout(Number(button.dataset.timer))
  button.dataset.timer = String(setTimeout(() => (button.textContent = original), 1500))
}

ui.username.addEventListener('click', async () => {
  if (!identity) return
  const copied = await navigator.clipboard.writeText(identity.username).then(() => true, () => false)
  flashButton(ui.username, copied ? 'Copied' : "Couldn't copy")
})

// Settings opens over the current screen. In a room it goes inside the room so it shows in fullscreen,
// and changing your username waits until you leave, because the welcome screen takes the whole window.
function showSettings(open) {
  if (open) {
    const inRoom = !ui.room.hidden
    const parent = inRoom ? ui.room : document.body
    parent.append(ui.settings)
    ui.newUsername.disabled = inRoom
    ui.newUsername.title = inRoom ? 'Leave the room to change your username' : ''
  }
  ui.settings.hidden = !open
}

// ---------- UI scale ----------
// Electron scales the whole page, video included. main/zoom.js hands us Ctrl +/-/0 and Ctrl+wheel
// because the default menu's zoom-in accelerator needs Ctrl+Shift+= on a US keyboard.
let zoom = DEFAULT_ZOOM
try {
  zoom = clampZoom(localStorage.getItem('uiScale') ?? DEFAULT_ZOOM)
} catch {}

// typing: the percent box is mid-edit, so it keeps what was typed until it loses focus.
function applyZoom(factor, {badge = false, typing = false} = {}) {
  zoom = clampZoom(factor)
  const percent = zoomPercent(zoom)
  ui.zoomSlider.value = String(percent)
  ui.zoomRow.style.setProperty('--ratio', String((zoom - MIN_ZOOM) / (MAX_ZOOM - MIN_ZOOM)))
  if (!typing) ui.zoomPercent.value = String(percent)
  ui.zoomReset.hidden = zoom === DEFAULT_ZOOM
  window.api.setZoom(zoom)
  try {
    localStorage.setItem('uiScale', String(zoom))
  } catch {}
  if (badge && ui.settings.hidden) showZoomBadge()
}

// A badge, because the keyboard and the wheel work from anywhere. Clicking it goes back to 100%,
// and hovering it holds it open long enough to click. It is position: fixed, so in a room it has to
// live inside .room, which is the element that goes fullscreen.
let zoomBadgeTimer = null
function showZoomBadge() {
  ;(ui.room.hidden ? document.body : ui.room).append(ui.zoomBadge)
  ui.zoomBadge.textContent = formatZoom(zoom)
  if (zoom !== DEFAULT_ZOOM) ui.zoomBadge.append(element('span', 'zoom-badge-hint', 'click to reset'))
  ui.zoomBadge.hidden = false
  hideZoomBadge()
}
function hideZoomBadge(delay = 1600) {
  clearTimeout(zoomBadgeTimer)
  zoomBadgeTimer = setTimeout(() => (ui.zoomBadge.hidden = true), delay)
}

window.api.onZoomStep((direction) => applyZoom(stepZoom(zoom, direction), {badge: true}))
ui.zoomBadge.addEventListener('click', () => {
  applyZoom(DEFAULT_ZOOM)
  hideZoomBadge(600)
})
ui.zoomBadge.addEventListener('pointerenter', () => clearTimeout(zoomBadgeTimer))
ui.zoomBadge.addEventListener('pointerleave', () => hideZoomBadge(400))

ui.zoomSlider.addEventListener('input', () => applyZoom(Number(ui.zoomSlider.value) / 100))
ui.zoomReset.addEventListener('click', () => applyZoom(DEFAULT_ZOOM))
// Every keystroke that reads as a scale applies live; anything else waits, so a half-typed
// number never snaps the window. Leaving the box (or Enter) settles it on what actually applied.
ui.zoomPercent.addEventListener('input', () => {
  const typed = parseZoom(ui.zoomPercent.value)
  if (typed !== null) applyZoom(typed, {typing: true})
})
ui.zoomPercent.addEventListener('change', () => applyZoom(zoom))
ui.zoomPercent.addEventListener('blur', () => applyZoom(zoom))
ui.zoomPercent.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') ui.zoomPercent.blur()
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
  event.preventDefault() // a text box has no steppers of its own
  applyZoom(zoom + (event.key === 'ArrowUp' ? 0.05 : -0.05))
})

applyZoom(zoom)

ui.openSettings.addEventListener('click', () => showSettings(true))
ui.roomSettings.addEventListener('click', () => showSettings(true))
ui.settingsBack.addEventListener('click', () => showSettings(false))
// Clicking the dimmed backdrop closes it, but a text selection that ends there doesn't.
let backdropPress = false
ui.settings.addEventListener('pointerdown', (event) => (backdropPress = event.target === ui.settings))
ui.settings.addEventListener('click', (event) => {
  if (backdropPress && event.target === ui.settings) showSettings(false)
})

// One friends list: it slides in from the left on home, and floats over the video on the left in a
// room. enterRoom and leaveRoom move it between the two.
function setFriendsOpen(open) {
  for (const screen of [ui.home, ui.room]) screen.classList.toggle('friends-open', open)
  for (const toggle of ui.friendsToggles) toggle.setAttribute('aria-expanded', String(open))
}
for (const toggle of ui.friendsToggles) {
  toggle.addEventListener('click', () => setFriendsOpen(!ui.home.classList.contains('friends-open')))
}
ui.inviteFriends.addEventListener('click', () => setFriendsOpen(true))
ui.reviewFriendRequests.addEventListener('click', () => {
  setFriendsOpen(true)
  wakeChrome()
  ui.friendRequests.querySelector('button')?.focus()
})

// Pinned keeps the window above other apps. Home (bottom right) and the player controls each have a button,
// so you can always unpin from wherever you are.
let pinned = false
async function setPinned(next) {
  pinned = await window.api.setPinned(next).catch(() => pinned)
  for (const button of ui.pinButtons) {
    button.setAttribute('aria-pressed', String(pinned))
    button.title = pinned ? 'Unpin: stop staying on top' : 'Pin: stay on top of other windows'
  }
}
for (const button of ui.pinButtons) button.addEventListener('click', () => setPinned(!pinned))
ui.newUsername.addEventListener('click', () => showWelcome('change'))

for (const button of ui.openButtons) {
  button.addEventListener('click', async () => {
    const current = session
    const filePaths = await window.api.chooseMediaFiles()
    if (session !== current || current.closed || !filePaths.length) return
    const items = addToPlaylist(filePaths)
    if (items.length) {
      if (items.length > 1) setPlaylistOpen(true)
      loadAddedMedia(items, {replace: true})
    }
  })
}

let importingYouTube = false
async function importYouTube(form, {replace = true} = {}) {
  if (importingYouTube || !session.room || session.closed) return
  const input = form.querySelector('input')
  const statusElement = form === ui.mediaUrlForm ? ui.mediaUrlStatus : ui.playlistUrlStatus
  const current = session
  const importer = new YouTubePlayer(document.createElement('div'))
  const cleanup = () => importer.close()
  // The panel holding the status line is hidden while media plays (and the playlist drawer can be
  // closed), so a drop onto the stage would report into nothing. Fall back to the toast.
  const status = (text, isError = false) => {
    statusElement.textContent = text
    statusElement.hidden = !text
    if (text && !statusElement.offsetParent) toast(text, isError)
  }
  try {
    const {videoId, playlistId} = parseYouTubeUrl(input.value)
    importingYouTube = true
    ui.mediaUrlForm.querySelector('button').disabled = true
    ui.playlistUrlForm.querySelector('button').disabled = true
    status(playlistId ? 'Reading YouTube playlist…' : 'Loading YouTube video…')
    // Cueing retrieves the source order without starting playback or disturbing the current host.
    if (playlistId) {
      importer.container.hidden = true
      ui.room.append(importer.container)
    }
    current.lifetime.signal.addEventListener('abort', cleanup, {once: true})
    const ids = playlistId ? await importer.importPlaylist(playlistId) : [videoId]
    if (session !== current || current.closed) return
    if (ids.length + current.playlist.items.size > MAX_ITEMS || ids.length + current.playlist.items.size + current.playlist.removed.size > MAX_REMOVED) {
      throw new Error(`This playlist has ${ids.length} videos and will not fit. SVP supports up to ${MAX_ITEMS} items; remove items or use a new room.`)
    }
    status('Loading video titles…')
    const titles = await window.api.youTubeTitles(ids)
    if (session !== current || current.closed) return
    // Recheck after fetching: another participant may have added media meanwhile.
    if (ids.length + current.playlist.items.size > MAX_ITEMS || ids.length + current.playlist.items.size + current.playlist.removed.size > MAX_REMOVED) throw new Error('The room playlist filled up while importing. Remove items and try again.')
    const added = ids.map((youtubeId, index) => {
      const message = {id: `${selfId}:${Date.now().toString(36)}:${itemCount++}`, youtubeId,
        title: titles[index], position: endPosition(current.playlist), ownerName: myName}
      return addItem(current.playlist, message, identity.username)
    }).filter(Boolean)
    // A single snapshot avoids rate-limiting large playlist imports at the receiving peers.
    current.playlistAction.send({type: 'sync', ...playlistSnapshot(current.playlist)}).catch(() => toast('Could not share the playlist. Rejoin the room to retry.', true))
    saveRoom()
    setPlaylistOpen(true)
    input.value = ''
    status('')
    loadAddedMedia(added, {replace})
    render()
  } catch (error) {
    if (session === current && !current.closed) status(errorMessage(error), true)
  } finally {
    current.lifetime.signal.removeEventListener('abort', cleanup)
    importer.container.remove()
    importer.dispose()
    importingYouTube = false
    ui.mediaUrlForm.querySelector('button').disabled = false
    ui.playlistUrlForm.querySelector('button').disabled = false
  }
}
for (const form of [ui.mediaUrlForm, ui.playlistUrlForm]) {
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    importYouTube(form, {replace: form === ui.mediaUrlForm})
  })
}

ui.play.addEventListener('click', togglePlay)
for (const button of document.querySelectorAll('[data-skip]')) {
  button.addEventListener('click', () => skip(Number(button.dataset.skip)))
}
ui.loop.addEventListener('click', toggleLoop)
ui.localVideo.addEventListener('click', togglePlay)
ui.remoteVideo.addEventListener('click', togglePlay)
ui.stage.addEventListener('dblclick', (event) => {
  if (event.target instanceof HTMLVideoElement || event.target === ui.picture) toggleFullscreen()
})
ui.picture.addEventListener('load', () => render()) // the whiteboard lines up once its size is known
ui.fullscreen.addEventListener('click', toggleFullscreen)

ui.seek.addEventListener('input', () => {
  session.seeking = true
  ui.time.textContent = formatTime((ui.seek.value / 1000) * currentDuration())
})
ui.seek.addEventListener('change', () => {
  session.seeking = false
  control('seek', (ui.seek.value / 1000) * currentDuration())
})

ui.audio.addEventListener('change', () => control('audio', ui.audio.value))

ui.subtitles.addEventListener('change', async () => {
  const value = ui.subtitles.value
  const state = isHost() ? hostState() : session.remote
  if (value === LOAD_SUBTITLE) {
    ui.subtitles.value = session.captions.id ?? state?.subtitleSelected ?? ''
    const filePath = await window.api.chooseSubtitle()
    if (filePath) addSubtitleFile(filePath)
    return
  }
  const image = Boolean(state?.subtitles?.some((s) => s.value === value && s.image))
  // Burned-in subtitles are shared, so only touch them when picking one or turning subtitles off.
  if (image || (!value && state?.subtitleSelected)) control('subtitle', value)
  selectSubtitle(image ? null : value)
})

// Unmuting goes back to the last volume the person chose. Only a released slider counts, so dragging
// down to 0 doesn't remember the tiny value it passed on the way.
let unmutedVolume = 1

// Everything the app plays goes through one gain, because a <video>'s own volume stops at 100%.
// The host's element is routed into Web Audio; Chromium still hands captureStream the audio before
// that routing, so viewers don't hear the host's volume. The viewer's element is muted and its
// WebRTC audio is taken straight from the stream (Chromium plays remote WebRTC audio through Web
// Audio only while the stream is also attached to an element, which remoteVideo is).
let output = null
let remoteAudio = null
let remoteAudioLifetime = null

function audioOutput() {
  if (!output) {
    audio ??= new AudioContext()
    output = audio.createGain()
    output.gain.value = Number(ui.volume.value)
    output.connect(audio.destination)
    audio.createMediaElementSource(ui.localVideo).connect(output)
    ui.remoteVideo.muted = true
  }
  if (audio.state === 'suspended') audio.resume().catch(() => {})
  return output
}

function routeRemoteAudio(stream) {
  const tracks = stream.getAudioTracks().filter((track) => track.readyState === 'live')
  const track = tracks.find((track) => !track.muted) || tracks[0]
  const out = track ? audioOutput() : null
  if (track && remoteAudio?.mediaStream.getAudioTracks()[0] === track) return
  remoteAudio?.disconnect()
  remoteAudio = null
  if (!track) return
  // A source node keeps its originally selected track, even after that track is
  // removed. Give it exactly the live track we want instead of relying on ID order.
  remoteAudio = audio.createMediaStreamSource(new MediaStream([track]))
  remoteAudio.connect(out)
}

function setVolume(volume) {
  youtube.setVolume(volume)
  const gain = audioOutput().gain
  gain.setTargetAtTime(volume, audio.currentTime, 0.015) // a short ramp, so muting doesn't click
  ui.volume.value = String(volume)
  ui.volumeControl.style.setProperty('--ratio', String(volume / Number(ui.volume.max)))
  ui.volumeReadout.value = `${Math.round(volume * 100)}%`
  const muted = volume === 0
  ui.mute.dataset.muted = String(muted)
  ui.mute.title = muted ? 'Unmute (M)' : 'Mute (M)'
  ui.mute.setAttribute('aria-pressed', String(muted))
  try {
    localStorage.setItem('volume', String(volume))
  } catch {}
}

function rememberVolume(volume) {
  if (!(volume > 0)) return
  unmutedVolume = volume
  try {
    localStorage.setItem('unmutedVolume', String(volume))
  } catch {}
}

function toggleMute() {
  const volume = Number(ui.volume.value)
  if (volume > 0) {
    rememberVolume(volume)
    setVolume(0)
  } else {
    setVolume(unmutedVolume)
  }
}

// The percentage shows above the knob while dragging, and briefly after keyboard or wheel changes.
let volumeDragging = false
let volumeReadoutTimer = null

function showVolumeReadout(lingerMs) {
  clearTimeout(volumeReadoutTimer)
  ui.volumeControl.classList.add('adjusting')
  if (lingerMs == null) return
  volumeReadoutTimer = setTimeout(() => ui.volumeControl.classList.remove('adjusting'), lingerMs)
}

function releaseVolume() {
  if (!volumeDragging) return
  volumeDragging = false
  showVolumeReadout(600)
}

ui.volume.addEventListener('pointerdown', () => {
  volumeDragging = true
  showVolumeReadout()
})
ui.volume.addEventListener('pointerup', releaseVolume)
ui.volume.addEventListener('pointercancel', releaseVolume)
ui.volume.addEventListener('input', () => {
  setVolume(Number(ui.volume.value))
  showVolumeReadout(volumeDragging ? null : 1000)
})
ui.volume.addEventListener('change', () => {
  rememberVolume(Number(ui.volume.value))
  releaseVolume()
})
ui.mute.addEventListener('click', toggleMute)
try {
  rememberVolume(Number(localStorage.getItem('unmutedVolume')))
  const saved = localStorage.getItem('volume')
  if (saved != null) setVolume(Number(saved))
  rememberVolume(Number(saved))
} catch {}

for (const type of ['play', 'pause', 'seeked', 'waiting', 'playing']) {
  ui.localVideo.addEventListener(type, () => broadcastState())
}
// Seeking back to the start works whether it's still buffered (a short clip) or ffmpeg has to restart.
// Without loop, a file started from the playlist moves on to the next item.
ui.localVideo.addEventListener('ended', () => {
  if (!isHost()) return
  checkpointPlayback()
  saveRoom()
  if (!session.loop) return playNext()
  player.seek(0)
  ui.localVideo.play().catch(() => {})
})
// A new MediaSource means new tracks, so the captured stream has to be republished.
ui.localVideo.addEventListener('loadedmetadata', () => {
  if (isHost()) publishStream()
})

player.addEventListener('media', () => broadcastState())
player.addEventListener('session', () => {
  session.epoch++
  broadcastState()
})
player.addEventListener('loading', () => render())
player.addEventListener('error', ({detail}) => { if (isHost()) failHosting(detail); else toast(detail, true) })

youtube.addEventListener('ready', () => { if (isHost()) broadcastState() })
youtube.addEventListener('state', () => {
  if (session.preview && youtube.playing) activatePreview()
  render()
})
youtube.addEventListener('error', ({detail}) => { if (isHost()) failHosting(detail); else toast(detail, true) })
youtube.addEventListener('blocked', () => toast('Click Play in the YouTube player to allow playback.'))
youtube.addEventListener('ended', () => {
  if (!isHost()) return
  checkpointPlayback()
  saveRoom()
  if (session.loop) { youtube.seek(0); youtube.play() }
  else playNext()
})

document.addEventListener('keydown', (event) => {
  if (ui.room.hidden || !ui.settings.hidden || event.target.matches('input:not([type=range]), select, textarea')) return
  if (event.code === 'Space') {
    event.preventDefault()
    if (event.target instanceof HTMLButtonElement) event.target.blur()
    togglePlay()
  } else if (event.code === 'ArrowLeft' || event.code === 'ArrowRight') {
    event.preventDefault()
    skip(event.code === 'ArrowLeft' ? -10 : 30)
  } else if (event.code === 'KeyL') {
    toggleLoop()
  } else if (event.code === 'KeyF') {
    toggleFullscreen()
  } else if (event.code === 'KeyP') {
    setPlaylistOpen(!playlistOpen())
  } else if (event.code === 'KeyM') {
    toggleMute()
  } else {
    const kind = Object.keys(REACTIONS).find((k) => REACTIONS[k].key === event.code || REACTIONS[k].key === `Digit${event.key}`)
    if (kind && !event.repeat) react(kind)
  }
})

for (const [kind, {emoji, label, key}] of Object.entries(REACTIONS)) {
  const button = element('button', 'reaction', emoji)
  button.dataset.reaction = kind
  button.title = `${label} (${key.replace('Digit', '')})`
  button.setAttribute('aria-label', label)
  button.addEventListener('click', () => {
    react(kind)
    setReactionsOpen(false)
  })
  ui.reactions.append(button)
}

// Reactions live in a menu that opens upward from one button in the controls.
function setReactionsOpen(open) {
  ui.reactions.hidden = !open
  ui.reactionsToggle.setAttribute('aria-expanded', String(open))
}
ui.reactionsToggle.addEventListener('click', () => setReactionsOpen(ui.reactions.hidden))
document.addEventListener('pointerdown', (event) => {
  if (!ui.reactions.hidden && !event.target.closest('.reaction-menu')) setReactionsOpen(false)
})
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  setReactionsOpen(false)
  endItemDrag(false)
  if (!event.target.matches('input')) {
    showSettings(false) // in the name box, Escape only undoes the edit
    setPeopleOpen(false)
  }
})

// While a video plays, the top bar, sidebar and controls get out of the way until the mouse moves.
let chromeTimer = null
const chromeInUse = () =>
  Boolean(
    drawing ||
      !ui.settings.hidden ||
      tabDrag ||
      itemDrag ||
      !ui.reactions.hidden ||
      ui.room.querySelector('.topbar:hover, .controls:hover, .sidebar:hover, .board-tools:hover, .playlist:hover, .friends-drawer:hover, .friends-drawer:focus-within, select:focus, input:focus'),
  )
function wakeChrome() {
  ui.room.classList.remove('idle')
  clearTimeout(chromeTimer)
  chromeTimer = setTimeout(() => {
    chromeTimer = null
    if (!isPlaying()) return
    if (chromeInUse()) wakeChrome()
    else ui.room.classList.add('idle')
  }, CHROME_IDLE_MS)
}
ui.room.addEventListener('mousemove', wakeChrome)
document.documentElement.addEventListener('mouseleave', () => {
  if (isPlaying() && !chromeInUse()) ui.room.classList.add('idle')
})

// Keep Electron from navigating to files dropped outside the stage.
document.addEventListener('dragover', (event) => event.preventDefault())
document.addEventListener('drop', (event) => event.preventDefault())
// Nothing on the stage is draggable: a dragged picture would drop back in as a file with no path.
ui.stage.addEventListener('dragstart', (event) => event.preventDefault())
ui.stage.addEventListener('dragover', () => ui.stage.classList.add('dragging'))
ui.stage.addEventListener('dragleave', (event) => {
  if (!ui.stage.contains(event.relatedTarget)) ui.stage.classList.remove('dragging')
})
ui.stage.addEventListener('drop', (event) => {
  ui.stage.classList.remove('dragging')
  const file = event.dataTransfer.files[0]
  const filePath = file && window.api.pathForFile(file)
  if (filePath) {
    if (!SUBTITLE_FILE.test(filePath)) return loadAddedMedia(addToPlaylist([filePath]), {replace: true})
    return addSubtitleFile(filePath)
  }
  // Not a file on disk: a link dragged from a browser, or something from inside the app.
  const dropped = {uriList: event.dataTransfer.getData('text/uri-list'),
    text: event.dataTransfer.getData('text/plain'), mozUrl: event.dataTransfer.getData('text/x-moz-url')}
  if (!Object.values(dropped).some((value) => value && value.trim())) return
  if (importingYouTube) return toast('A YouTube import is already in progress. Try again when it finishes.')
  try {
    ui.mediaUrl.value = droppedYouTubeUrl(dropped)
    importYouTube(ui.mediaUrlForm, {replace: true})
  } catch (error) { toast(errorMessage(error), true) }
})

window.addEventListener('beforeunload', () => {
  checkpointPlayback()
  saveRoom()
  session.room?.leave()
  friendNetwork.stop()
  roomPresence.stop()
  network.stop()
})

setInterval(render, 250)
requestAnimationFrame(drawCaptions)
setInterval(sendStroke, 50)
setInterval(() => sampleConnection().catch(() => {}), TELEMETRY_INTERVAL_MS)
setInterval(() => { if (session.room && !session.closed) refreshAvailability() }, 10000)
setInterval(() => {
  if (!isHost()) return
  broadcastState()
  tuneSenders()
}, STATE_INTERVAL_MS)
