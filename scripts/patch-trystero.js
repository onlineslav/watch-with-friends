// Deliberate, version-checked local fixes. Keep these until equivalent upstream fixes
// pass test/transport.test.mjs. Never silently patch a different dependency release.
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const core = path.join(root, 'node_modules/@trystero-p2p/core')
if (JSON.parse(fs.readFileSync(path.join(core, 'package.json'))).version !== '0.25.4') throw new Error('Review the Trystero transport patch before upgrading')
const marker = '// watch-with-friends transport hardening v2\n'
// The app was renamed after 0.4.3. A node_modules patched under the old name is already correct,
// so the guard accepts either marker rather than patching the same file a second time.
const patched = /^\/\/ (watch-with-friends|synced-video-player) transport hardening v2\n/
function patch(name, edits) {
  const file = path.join(core, 'dist', name)
  let text = fs.readFileSync(file, 'utf8')
  if (patched.test(text)) return
  for (const [before, after] of edits) {
    if (!text.includes(before)) throw new Error(`Trystero patch context changed: ${name}`)
    text = text.replace(before, after)
  }
  fs.writeFileSync(file, marker + text)
}
fs.copyFileSync(path.join(root, 'shared/receive-budget.mjs'), path.join(core, 'dist/receive-budget.mjs'))
fs.copyFileSync(path.join(root, 'shared/opus-sdp.mjs'), path.join(core, 'dist/opus-sdp.mjs'))
fs.copyFileSync(path.join(root, 'shared/transceivers.mjs'), path.join(core, 'dist/transceivers.mjs'))
patch('handshake.mjs', [
  ['state.pendingHandshakePayloads.push(payload);', `if (state.pendingHandshakePayloads.length >= 8) {
      failPeerHandshake(id, state.peer, mkErr("too many pending handshake messages"));
      return;
    }
    state.pendingHandshakePayloads.push(payload);`],
])
patch('action-wire.mjs', [
  ['//#region src/action-wire.ts', 'import {createReceiveBudget} from "./receive-budget.mjs";\n//#region src/action-wire.ts'],
  ['const pendingTransmissions = {};', 'const pendingTransmissions = {};\n\tconst budget = createReceiveBudget((id, type, nonce) => { if (pendingTransmissions[id]?.[type]) delete pendingTransmissions[id][type][nonce]; });'],
  ['if (!didDrain) break;', 'if (!didDrain) throw mkErr("data channel stalled");'],
  ['if (!currentPeer || currentPeer !== peer) break;', 'if (!currentPeer || currentPeer !== peer) throw mkErr("peer disconnected during transfer");'],
  ['const handleData = (id, data) => {\n\t\tconst buffer = new Uint8Array(data);', 'const handleData = (id, data) => {\n\t\tconst buffer = new Uint8Array(data);\n\t\tif (buffer.byteLength < 36 || buffer.byteLength > 65536) return;'],
  ['const action = actions[type];', 'const action = actions[type];\n\t\tif (!action) return;\n\t\tif (type === "@_leave" && !canReceiveFromPeer(id, false)) return;'],
  ['pendingTransmissions[id] ??= {};', `if ((isMeta && payload.byteLength > 4096) || !budget.accept(id, type, nonce, payload.byteLength, isLast)) {
      budget.clearPeer(id);
      delete pendingTransmissions[id];
      getPeer(id, true)?.connection.close();
      return;
    }
    pendingTransmissions[id] ??= {};`],
  ['\t\tdelete pendingTransmissions[id][type][nonce];', '\t\tdelete pendingTransmissions[id][type][nonce];\n\t\tif (!Object.keys(pendingTransmissions[id][type]).length) delete pendingTransmissions[id][type];'],
  ['clearPeer: (id) => {\n\t\t\tdelete pendingTransmissions[id];', 'clearPeer: (id) => {\n\t\t\tbudget.clearPeer(id);\n\t\t\tdelete pendingTransmissions[id];'],
])
patch('shared-peer.mjs', [
  ['pendingDataByToken: /* @__PURE__ */ new Map(),', 'pendingDataByToken: /* @__PURE__ */ new Map(),\n\t\t\tretiredTokens: new Set(),'],
  ['delete shared.bindings[roomId];', `delete shared.bindings[roomId];
      if (binding.roomToken) {
        shared.pendingDataByToken.delete(binding.roomToken);
        shared.retiredTokens.add(binding.roomToken);
        if (shared.retiredTokens.size > 128) { shared.peer.destroy(); return; }
      }`],
  ['binding.roomToken = roomToken;', 'binding.roomToken = roomToken;\n\t\t\tshared.retiredTokens.delete(roomToken);'],
  ['if (!binding) {\n\t\t\tconst pending', `if (!binding) {
      // Room leave frames have no meaning in a future incarnation of this room.
      if (shared.retiredTokens.has(decoded.roomToken) || decodeBytes(new Uint8Array(decoded.payload).subarray(0, 32)).replaceAll("\\0", "") === "@_leave") return;
      const bytes = [...shared.pendingDataByToken.values()].flat().reduce((n, p) => n + p.byteLength, 0);
      if (shared.pendingDataByToken.size >= 16 || bytes + decoded.payload.byteLength > 65536) return;
      const pending`],
])

// Chromium 152 never gathers ICE again for a pooled offer peer regenerated with an ICE
// restart (rollback + restartIce + createOffer({iceRestart})): gathering goes complete -> new
// and stays new, so the connection dies after "exchanging SDP". Peers older than offerTtl are
// therefore destroyed and replaced by fresh peers (checkout allocates the missing ones) rather
// than regenerated. No timer refreshes the pool, so idle apps stay quiet.
patch('offer-pool.mjs', [
  ['const peer = this.pool.shift();\n\t\t\tif (!peer) break;\n\t\t\tthis.pooled.delete(peer);',
   'const peer = this.pool.shift();\n\t\t\tif (!peer) break;\n\t\t\tthis.pooled.delete(peer);\n\t\t\tif (Date.now() - peer.created > offerTtl) {\n\t\t\t\tpeer.destroy();\n\t\t\t\tcontinue;\n\t\t\t}'],
  ['this.recycling.add(peer);', 'if (Date.now() - peer.created > offerTtl) {\n\t\t\tpeer.destroy();\n\t\t\treturn;\n\t\t}\n\t\tthis.recycling.add(peer);'],
  ['peer.getOffer(true).then(', 'peer.getOffer().then('],
])
patch('strategy.mjs', [
  ['peer.getOffer(Date.now() - peer.created > offerTtl)', 'peer.getOffer()'],
])

// Room contexts capture getMap(appId) for their entire lifetime. Deleting an
// empty map strands those contexts, and register() can write a replacement
// peer into the deleted map when replacing the last connection. Keep the map
// identity stable while still clearing every peer, binding and timer. Append
// an independent marker so already-hardened installs receive this fix too.
const sharedPath = path.join(core, 'dist/shared-peer.mjs')
const registryMarker = '// watch-with-friends stable shared registry v1'
let shared = fs.readFileSync(sharedPath, 'utf8')
if (!shared.includes(registryMarker)) {
  const before = 'if (keys(map).length === 0) delete this.byApp[appId];'
  if (!shared.includes(before)) throw new Error('Trystero shared registry patch context changed')
  shared = shared.replace(before, registryMarker + '\n\t\t// Existing room contexts retain this map; only peer entries are removed.')
  fs.writeFileSync(sharedPath, shared)
}

// The upstream socket disables itself after six consecutive failures. A laptop
// waking up or a temporary discovery outage then requires a full app restart.
// Keep the existing capped backoff, but never turn a transient close into a
// permanent shutdown. Explicit close (including a rejected Nostr relay) remains
// final. This separate marker also updates already-hardened installations.
const utilsPath = path.join(core, 'dist/utils.mjs')
const retryMarker = '// watch-with-friends discovery retry v1\n'
let utils = fs.readFileSync(utilsPath, 'utf8')
if (!utils.startsWith(retryMarker)) {
  const before = `			if (period >= maxRetryMs) {
				client.isClosed = true;
				return;
			}
			retryTimer = setTimeout(init, Math.random() * period);`
  const after = `			const retryMs = Math.max(1000, Math.random() * period);
			console.warn(libName + ": discovery relay disconnected - " + url + "; retrying in " + Math.round(retryMs) + "ms (code " + (event?.code ?? "unknown") + ")");
			retryTimer = setTimeout(init, retryMs);`
  if (!utils.includes(before) || !utils.includes('socket.onclose = () => {')) throw new Error('Trystero discovery retry patch context changed')
  utils = utils.replace('socket.onclose = () => {', 'socket.onclose = (event) => {').replace(before, after)
  fs.writeFileSync(utilsPath, retryMarker + utils)
}

// Renegotiation (a host adding its film or share to a connection) is one offer and one answer
// over the data channel, and nothing recovers if the answer never comes back: the connection
// sits in have-local-offer forever and the viewer never gets the host's video (the network
// check's intermittent "viewer video never ready", caught with the host's connection to one
// viewer stuck in have-local-offer while that viewer had already answered). An offer still
// unanswered after a few seconds on a live connection is sent again; the other side answers a
// repeated offer like any other. And an answer that arrives with no offer pending (a repeat) is
// ignored rather than applied, which would fail and make the shared connection tear itself down.
patch('peer.mjs', [
  ['\tlet makingOffer = false;', '\tlet makingOffer = false;\n\tlet offerWatch = null;'],
  [`			await pc.setLocalDescription(restartIce ? await pc.createOffer({ iceRestart: true }) : void 0);
			return await emitLocalDescriptionSignal();`,
   `			await pc.setLocalDescription(restartIce ? await pc.createOffer({ iceRestart: true }) : void 0);
			const sent = await emitLocalDescriptionSignal();
			watchOffer(pc.localDescription?.sdp);
			return sent;`],
  ['\tpc.onnegotiationneeded = async () => createOffer(false);',
   `\tconst watchOffer = (sdp, attempt = 1) => {
		resetTimer(offerWatch);
		offerWatch = setTimeout(() => {
			offerWatch = null;
			if (!sdp || pc.signalingState !== "have-local-offer" || pc.localDescription?.sdp !== sdp || pc.connectionState === "closed") return;
			emitSignal(localDescriptionSignal(pc));
			if (attempt < 4) watchOffer(sdp, attempt + 1);
		}, 3e3 * attempt);
	};
	pc.onnegotiationneeded = async () => createOffer(false);`],
  [`				if (sdp.type === answerType) {
					isSettingRemoteAnswerPending = true;`,
   `				if (sdp.type === answerType) {
					if (pc.signalingState !== "have-local-offer") return;
					isSettingRemoteAnswerPending = true;`],
  ['\t\tdestroy: () => {\n\t\t\tclearDisconnectedCloseTimer();', '\t\tdestroy: () => {\n\t\t\tclearDisconnectedCloseTimer();\n\t\t\tresetTimer(offerWatch);'],
])

// A room pairs each incoming stream (or added track) with the next pending metadata message,
// first come first served, and dropped a stream that arrived with none pending. Over a reused
// connection the tracks for a just-joined room arrive at once, while the host's metadata for that
// room can still be held until the room's token resolves: the stream was dropped, the metadata
// then waited for it forever, and the viewer never got the host's video (the network check's
// intermittent "viewer video never ready", with an empty stream list on the viewer). Streams and
// tracks are now matched to metadata by the ids it already carries, and one that arrives first is
// kept for its metadata to find (the existing cache lookup in receiveStreamMeta/receiveTrackMeta).
// Matching by id also stops a stream meant for another room on the same connection from taking
// this room's metadata.
patch('media.mjs', [
  ['getRemoteStream: (key, streamId) => remoteStreamsByKey.get(key) ?? (streamId ? remoteStreamsById.get(streamId) : void 0),',
   `getRemoteStream: (key, streamId) => remoteStreamsByKey.get(key) ?? (streamId ? remoteStreamsById.get(streamId) : void 0),
		rememberArrivedStream: (stream) => {
			if (typeof stream?.id === "string") remoteStreamsById.set(stream.id, stream);
		},`],
  ['getRemoteTrack: (key, trackId) => remoteTracksByKey.get(key) ?? (trackId ? remoteTracksById.get(trackId) : void 0),',
   `getRemoteTrack: (key, trackId) => remoteTracksByKey.get(key) ?? (trackId ? remoteTracksById.get(trackId) : void 0),
		rememberArrivedTrack: (track, stream) => {
			if (typeof track?.id === "string") remoteTracksById.set(track.id, { track, stream });
		},`],
  [`			const next = pendingStreamMetas[id]?.shift();
			if (!next) return;
			emitStream(id, next.key, stream, next.metadata);`,
   `			const pending = pendingStreamMetas[id] ?? [];
			let index = pending.findIndex((meta) => meta.streamId === stream.id);
			if (index < 0) index = pending.findIndex((meta) => meta.streamId === void 0);
			if (index < 0) {
				getSharedMediaPeer(id)?.__trysteroMedia?.rememberArrivedStream(stream);
				return;
			}
			const [next] = pending.splice(index, 1);
			emitStream(id, next.key, stream, next.metadata);`],
  [`			const next = pendingTrackMetas[id]?.shift();
			if (!next) return;
			emitTrack(id, next.key, track, stream, next.metadata);`,
   `			const pending = pendingTrackMetas[id] ?? [];
			let index = pending.findIndex((meta) => meta.trackId === track.id);
			if (index < 0) index = pending.findIndex((meta) => meta.trackId === void 0);
			if (index < 0) {
				getSharedMediaPeer(id)?.__trysteroMedia?.rememberArrivedTrack(track, stream);
				return;
			}
			const [next] = pending.splice(index, 1);
			emitTrack(id, next.key, track, stream, next.metadata);`],
])

// A connection that stays "disconnected" for 5s is given up on: every room drops the peer. Upstream
// only reported that (emitClose) and left the RTCPeerConnection open, and a shared connection's
// manager deliberately doesn't destroy a peer that reported its own close. So when the network came
// back a moment after the deadline, the connection recovered with nobody on this side using it,
// while the other side never saw a close and kept treating us as still in the room: a viewer sat on
// a frozen frame for nine minutes after the host's app had dropped them (both logs, 0.7.1, with the
// host's connection back 150ms after its 5s deadline and the viewer's back after 2.4s). Giving up now
// closes the connection, so the other side's data channel closes too (or its own consent checks
// fail) and both apps drop each other and reconnect through discovery. Separate marker, so
// already-hardened installs receive it.
const peerPath = path.join(core, 'dist/peer.mjs')
const giveUpMarker = '// watch-with-friends close abandoned connections v1\n'
let peerText = fs.readFileSync(peerPath, 'utf8')
if (!peerText.includes(giveUpMarker)) {
  const before = 'if (pc.connectionState === "disconnected" || pc.iceConnectionState === "disconnected") emitClose();'
  const after = `if (pc.connectionState === "disconnected" || pc.iceConnectionState === "disconnected") {
					dataChannel?.close();
					pc.close();
					emitClose();
				}`
  if (!peerText.includes(before)) throw new Error('Trystero abandoned-connection patch context changed')
  // Appended, not prepended: the hardening patch above recognises a patched file by its first line.
  fs.writeFileSync(peerPath, peerText.replace(before, after) + giveUpMarker)
}

// Opus parameters in the local description (M1.6). WebRTC's decoder follows the receiver's OWN
// SDP, so a viewer that only edited the host's SDP (renderer/app.js, setRemoteDescription) decoded
// mono: the M1.4 bench read L/R separation 0 at the viewer while the host's send side said stereo=1.
// Every local offer and answer is therefore created, edited (shared/opus-sdp.mjs, copied beside
// peer.mjs above) and then set, in place of the argument-less setLocalDescription() that left the
// browser to write it. That includes the ICE-restart offer; a rollback is left alone.
//
// Creating and setting are two steps now, and the browser runs its own calls in order, so a remote
// offer applied between them leaves the second step in the wrong state (createOffer in
// have-remote-offer; a rollback in stable). Everything that touches the descriptions therefore runs
// one job at a time here: our offers and answers, remote offers and remote answers. Each job reads the
// signalling state when its turn comes, which is what the argument-less call did for free. A remote
// offer waits for a local one in flight and then rolls back (the state is really have-local-offer by
// then); an offerer still ignores a remote offer that collides with its own. Descriptions go out
// after the job, never inside it, so waiting for ICE gathering without trickle cannot hold the line.
// If the edited description is refused, the browser's own is used, so a negotiation never fails
// because of this (the audio just is not stereo on that pass).
const opusMarker = '// watch-with-friends opus sdp v2\n'
let opusPeer = fs.readFileSync(peerPath, 'utf8')
if (!opusPeer.includes(opusMarker)) {
  const edits = [
    ['import { all, alloc, candidateType, resetTimer, toError } from "./utils.mjs";',
     'import { preferStereoOpus } from "./opus-sdp.mjs";\nimport { all, alloc, candidateType, resetTimer, toError } from "./utils.mjs";'],
    ['\tlet offerWatch = null;',
     [
       '\tlet offerWatch = null;',
       '\tlet negotiation = Promise.resolve();',
       '\tconst serializeNegotiation = (job) => {',
       '\t\tconst run = negotiation.catch(() => {}).then(job);',
       '\t\tnegotiation = run;',
       '\t\treturn run;',
       '\t};',
       '\tconst setLocalNow = async (restartIce = false) => {',
       '\t\tconst answering = !restartIce && (pc.signalingState === "have-remote-offer" || pc.signalingState === "have-local-pranswer");',
       '\t\tconst created = answering ? await pc.createAnswer() : await pc.createOffer(restartIce ? { iceRestart: true } : void 0);',
       '\t\ttry {',
       '\t\t\tawait pc.setLocalDescription({ type: created.type, sdp: preferStereoOpus(created.sdp) });',
       '\t\t} catch (err) {',
       '\t\t\tconsole.warn("trystero: edited local description refused, using the browser\'s own: " + (err?.message ?? err));',
       '\t\t\tawait pc.setLocalDescription(created);',
       '\t\t}',
       '\t};',
     ].join('\n')],
    [[
      '\t\t\tif (restartIce) {',
      '\t\t\t\tif (pc.signalingState !== "stable" && pc.signalingState !== "closed" && pc.localDescription?.type === offerType) await pc.setLocalDescription({ type: "rollback" });',
      '\t\t\t\tif (typeof pc.restartIce === "function") pc.restartIce();',
      '\t\t\t}',
      '\t\t\tawait pc.setLocalDescription(restartIce ? await pc.createOffer({ iceRestart: true }) : void 0);',
    ].join('\n'),
    [
      '\t\t\tawait serializeNegotiation(async () => {',
      '\t\t\t\tif (restartIce) {',
      '\t\t\t\t\tif (pc.signalingState !== "stable" && pc.signalingState !== "closed" && pc.localDescription?.type === offerType) await pc.setLocalDescription({ type: "rollback" });',
      '\t\t\t\t\tif (typeof pc.restartIce === "function") pc.restartIce();',
      '\t\t\t\t}',
      '\t\t\t\tawait setLocalNow(restartIce);',
      '\t\t\t});',
    ].join('\n')],
    [[
      '\t\t\t\tif (sdp.type === offerType) {',
      '\t\t\t\t\tif (makingOffer || pc.signalingState !== "stable" && !isSettingRemoteAnswerPending) {',
      '\t\t\t\t\t\tif (initiator) return;',
      '\t\t\t\t\t\tawait all([pc.setLocalDescription({ type: "rollback" }), pc.setRemoteDescription(rtcSdp)]);',
      '\t\t\t\t\t} else await pc.setRemoteDescription(rtcSdp);',
      '\t\t\t\t\tawait flushPendingRemoteCandidates();',
      '\t\t\t\t\tawait pc.setLocalDescription();',
      '\t\t\t\t\treturn await emitLocalDescriptionSignal();',
      '\t\t\t\t}',
      '\t\t\t\tif (sdp.type === answerType) {',
      '\t\t\t\t\tif (pc.signalingState !== "have-local-offer") return;',
      '\t\t\t\t\tisSettingRemoteAnswerPending = true;',
      '\t\t\t\t\ttry {',
      '\t\t\t\t\t\tawait pc.setRemoteDescription(rtcSdp);',
      '\t\t\t\t\t\tawait flushPendingRemoteCandidates();',
      '\t\t\t\t\t} finally {',
      '\t\t\t\t\t\tisSettingRemoteAnswerPending = false;',
      '\t\t\t\t\t}',
      '\t\t\t\t}',
    ].join('\n'),
    [
      '\t\t\t\tif (sdp.type === offerType) {',
      '\t\t\t\t\tconst collides = () => pc.signalingState !== "stable" && !isSettingRemoteAnswerPending;',
      '\t\t\t\t\tif (initiator && (makingOffer || collides())) return;',
      '\t\t\t\t\tconst answered = await serializeNegotiation(async () => {',
      '\t\t\t\t\t\tif (initiator && collides()) return false;',
      '\t\t\t\t\t\tif (collides()) await all([pc.setLocalDescription({ type: "rollback" }), pc.setRemoteDescription(rtcSdp)]);',
      '\t\t\t\t\t\telse await pc.setRemoteDescription(rtcSdp);',
      '\t\t\t\t\t\tawait flushPendingRemoteCandidates();',
      '\t\t\t\t\t\tawait setLocalNow();',
      '\t\t\t\t\t\treturn true;',
      '\t\t\t\t\t});',
      '\t\t\t\t\treturn answered ? await emitLocalDescriptionSignal() : void 0;',
      '\t\t\t\t}',
      '\t\t\t\tif (sdp.type === answerType) {',
      '\t\t\t\t\tawait serializeNegotiation(async () => {',
      '\t\t\t\t\t\tif (pc.signalingState !== "have-local-offer") return;',
      '\t\t\t\t\t\tisSettingRemoteAnswerPending = true;',
      '\t\t\t\t\t\ttry {',
      '\t\t\t\t\t\t\tawait pc.setRemoteDescription(rtcSdp);',
      '\t\t\t\t\t\t\tawait flushPendingRemoteCandidates();',
      '\t\t\t\t\t\t} finally {',
      '\t\t\t\t\t\t\tisSettingRemoteAnswerPending = false;',
      '\t\t\t\t\t\t}',
      '\t\t\t\t\t});',
      '\t\t\t\t}',
    ].join('\n')],
  ]
  for (const [before, after] of edits) {
    if (!opusPeer.includes(before)) throw new Error('Trystero Opus patch context changed: peer.mjs')
    opusPeer = opusPeer.replace(before, () => after)
  }
  fs.writeFileSync(peerPath, opusPeer + opusMarker)
}

// Media sections that go away (M1.11). RTCPeerConnection.removeTrack() only detaches the sender: the transceiver
// keeps its m-section and its full codec list, and a later addTrack() never reuses a sender that has sent. So
// every film opened in a session added an audio and a video section that never went away (measured in Electron
// 44: about 10 KB of offer per file, over the 64 KiB a signalling message may have at the 7th film, where the
// receive budget closes the connection to the viewer; a reused connection carries the growth from room to room).
// transceiver.stop() lets the section be rejected and then recycled: 5 sections and under 20 KB after 25 files.
// What goes with it:
//  - removeStream/removeTrack stop the transceiver (the other end's receiver track ends instead of going mute),
//    unless the other end is sending on it too (currentDirection sendrecv: a copy from before this reused its
//    receiving transceiver for its own share, which native addTrack does), when it is only detached; and
//    unless it never got a section (no mid: added and taken off before any offer), when it is also only
//    detached, because a stopped transceiver nothing can negotiate away keeps negotiation "needed" for good.
//    (v3 below narrows when stopping is safe: only once the section was negotiated.)
//  - addTrack/addStream make their own transceiver (addTransceiver) instead of letting addTrack pick one of the
//    receiving transceivers the other end made: stopping our film must not kill the share the other end put on
//    the very same section. A detached transceiver that never got a section is reused first.
//  - The guard in signal() that drops a data-channel-era SDP "without media" looked for a=rtpmap; it now looks
//    for a media section (m=audio / m=video). In Electron 44 that changes nothing for a real offer: one that
//    only ends sections (every section rejected, port 0) still lists its codecs, and so does its answer
//    (checked with two RTCPeerConnections). What had no codec lines was the fake connection in
//    test/transport.test.mjs. The section test is kept as the plainer rule; a copy from before this accepts
//    those offers as well.
const stopMarker = '// watch-with-friends stop transceivers v2\n'
let stopPeer = fs.readFileSync(peerPath, 'utf8')
if (!stopPeer.includes(stopMarker)) {
  const edits = [
    ['\tpc.onnegotiationneeded = async () => createOffer(false);',
     [
       '\tconst stopSender = (sender) => {',
       '\t\tconst transceiver = pc.getTransceivers().find((t) => t.sender === sender);',
       '\t\ttry {',
       '\t\t\tif (transceiver && transceiver.mid != null && transceiver.currentDirection !== "sendrecv") transceiver.stop();',
       '\t\t\telse pc.removeTrack(sender);',
       '\t\t} catch {',
       '\t\t\ttry { pc.removeTrack(sender); } catch {}',
       '\t\t}',
       '\t};',
       '\tconst addSender = (track, stream) => {',
       '\t\tconst idle = pc.getTransceivers().find((t) => t.mid == null && t.sender.track === null && t.receiver.track.kind === track.kind);',
       '\t\tif (idle) {',
       '\t\t\tidle.sender.replaceTrack(track).catch(() => {});',
       '\t\t\tidle.sender.setStreams(stream);',
       '\t\t\tidle.direction = "sendrecv";',
       '\t\t\treturn idle.sender;',
       '\t\t}',
       '\t\treturn pc.addTransceiver(track, { direction: "sendrecv", streams: [stream] }).sender;',
       '\t};',
       '\tpc.onnegotiationneeded = async () => createOffer(false);',
     ].join('\n')],
    ['forEach((sender) => pc.removeTrack(sender)),', 'forEach(stopSender),'],
    ['\t\t\tif (sender) pc.removeTrack(sender);', '\t\t\tif (sender) stopSender(sender);'],
    ['addStream: (stream) => stream.getTracks().forEach((track) => pc.addTrack(track, stream)),', 'addStream: (stream) => stream.getTracks().forEach((track) => addSender(track, stream)),'],
    ['\t\taddTrack: (track, stream) => pc.addTrack(track, stream),', '\t\taddTrack: (track, stream) => addSender(track, stream),'],
    ['!sdp.sdp?.includes("a=rtpmap")) return;', '!/(^|\\n)m=(audio|video) /.test(sdp.sdp ?? "")) return;'],
  ]
  for (const [before, after] of edits) {
    if (stopPeer.split(before).length !== 2) throw new Error('Trystero stop-transceiver patch context changed: peer.mjs: ' + before.slice(0, 60))
    stopPeer = stopPeer.replace(before, () => after)
  }
  fs.writeFileSync(peerPath, stopPeer + stopMarker)
}

// Stop a transceiver only once its section was negotiated (M1.11 re-audit, confirmed with two connections in
// Electron 44). A transceiver gets its mid from the local offer that first carries it, before any answer. v2
// stopped it as soon as it had a mid; when that offer was then rolled back (the polite end, when the other end's
// offer collides with it), it was left stopped and without a mid for good: in no offer, so nothing takes it away,
// and negotiation was "needed" after every round (83 times in 2s in the probe, each a full offer and answer;
// 280 offers in a 5s run), and addSender's idle search did not skip stopped transceivers (setting a stopped one's
// direction throws InvalidStateError, which aborts addStream for every track after it). The rules now live in
// shared/transceivers.mjs (copied beside peer.mjs above on every run, so a change there needs no new marker),
// which renderer/app.js uses too for the senders it takes off itself: stop only when currentDirection is sendonly
// or inactive (negotiated, and the other end does not send on it), otherwise only detach, and never stop that one
// later (a copy from before M1.11 may have put its share on it meanwhile; see there); never reuse a stopped
// transceiver. Applied on top of v2, so a fresh install (v2 then v3) and an install already at v2 end up
// byte-identical.
const stopV3Marker = '// watch-with-friends stop transceivers v3\n'
let stopV3Peer = fs.readFileSync(peerPath, 'utf8')
if (!stopV3Peer.includes(stopV3Marker)) {
  const edits = [
    ['import { preferStereoOpus } from "./opus-sdp.mjs";',
     'import { preferStereoOpus } from "./opus-sdp.mjs";\nimport { addSender as addSenderOn, stopSender as stopSenderOn } from "./transceivers.mjs";'],
    [[
      '\tconst stopSender = (sender) => {',
      '\t\tconst transceiver = pc.getTransceivers().find((t) => t.sender === sender);',
      '\t\ttry {',
      '\t\t\tif (transceiver && transceiver.mid != null && transceiver.currentDirection !== "sendrecv") transceiver.stop();',
      '\t\t\telse pc.removeTrack(sender);',
      '\t\t} catch {',
      '\t\t\ttry { pc.removeTrack(sender); } catch {}',
      '\t\t}',
      '\t};',
      '\tconst addSender = (track, stream) => {',
      '\t\tconst idle = pc.getTransceivers().find((t) => t.mid == null && t.sender.track === null && t.receiver.track.kind === track.kind);',
      '\t\tif (idle) {',
      '\t\t\tidle.sender.replaceTrack(track).catch(() => {});',
      '\t\t\tidle.sender.setStreams(stream);',
      '\t\t\tidle.direction = "sendrecv";',
      '\t\t\treturn idle.sender;',
      '\t\t}',
      '\t\treturn pc.addTransceiver(track, { direction: "sendrecv", streams: [stream] }).sender;',
      '\t};',
    ].join('\n'),
    [
      '\tconst stopSender = (sender) => stopSenderOn(pc, sender);',
      '\tconst addSender = (track, stream) => addSenderOn(pc, track, stream);',
    ].join('\n')],
  ]
  for (const [before, after] of edits) {
    if (stopV3Peer.split(before).length !== 2) throw new Error('Trystero stop-transceiver v3 patch context changed: peer.mjs: ' + before.slice(0, 60))
    stopV3Peer = stopV3Peer.replace(before, () => after)
  }
  fs.writeFileSync(peerPath, stopV3Peer + stopV3Marker)
}

// A peer that has just left a room is not attached again by a stray signal (M1.7, found by looping a leave/rejoin
// under CPU load; the 0.8.2 Mac CI run failed the same way). Someone leaving a room says so on the data channel
// ("@_leave", ordered with everything else on it), but the relay announcements and offers of a shared peer travel
// another way, and one sent just before the leave can arrive just after it. signal-handler.mjs attaches a known
// shared peer to the room on any announcement, offer, answer or candidate, so the room opened a binding to a peer that
// was no longer in it and started a handshake with nobody. When the person really came back, their presence frame
// found that binding already there (not new), nobody started a handshake for the new visit, the stale one waited
// for messages the new visit never sent, and everyone's handshake timed out after 10 s ("handshake timed out after
// 10000ms"; the stale handshake was 1 ms after the leave in the trace). The presence frame is ordered after the leave
// on the data channel, so after a "@_leave" only a presence frame (or a new connection) may attach that peer again;
// signals are ignored for 5 s. A copy that never sends presence frames cannot leave a room this way either.
const ghostMarker = '// watch-with-friends ghost attach v1\n'
function patchGhost(name, edits) {
  const file = path.join(core, 'dist', name)
  let text = fs.readFileSync(file, 'utf8')
  if (text.includes(ghostMarker)) return
  for (const [before, after] of edits) {
    if (text.split(before).length !== 2) throw new Error(`Trystero ghost-attach patch context changed: ${name}: ${before.slice(0, 60)}`)
    text = text.replace(before, () => after)
  }
  fs.writeFileSync(file, text + (text.endsWith('\n') ? '' : '\n') + ghostMarker)
}
patchGhost('room.mjs', [
  ['\t\tif (wasActive) listeners.onPeerLeave?.(id);\n\t\tonPeerLeave(id);', '\t\tif (wasActive) listeners.onPeerLeave?.(id);\n\t\tonPeerLeave(id, reason);'],
])
patchGhost('strategy.mjs', [
  [
    '\t\tconst joinedRoom = room_default((f) => onPeerConnect = f, (id) => {\n\t\t\tif (didLeaveRoom) return;\n\t\t\tconst state = ctx.peerStates[id];',
    '\t\tconst joinedRoom = room_default((f) => onPeerConnect = f, (id, reason) => {\n\t\t\tif (didLeaveRoom) return;\n\t\t\tif (/peer left room$/.test(reason?.message ?? "")) getState(ctx.peerStates, id).leftRoomAt = Date.now();\n\t\t\tconst state = ctx.peerStates[id];',
  ],
  [
    '\t\tconst ctx = {\n\t\t\tappId,',
    '\t\tconst attachFromSignal = (peerId, shared) => {\n\t\t\tconst left = ctx.peerStates[peerId]?.leftRoomAt;\n\t\t\tif (left && Date.now() - left < 5e3) return;\n\t\t\tattachSharedPeerToRoom(peerId, shared);\n\t\t};\n\t\tconst ctx = {\n\t\t\tappId,',
  ],
  [
    '\t\t\tconnectPeer,\n\t\t\tdisconnectPeer,\n\t\t\tattachSharedPeerToRoom,\n',
    '\t\t\tconnectPeer,\n\t\t\tdisconnectPeer,\n\t\t\tattachSharedPeerToRoom: attachFromSignal,\n',
  ],
  [
    '\t\t\troomTokenPromise: roomNamespacePromise,\n\t\t\tattachSharedPeerToRoom,\n',
    '\t\t\troomTokenPromise: roomNamespacePromise,\n\t\t\tattachSharedPeerToRoom: (peerId, shared) => {\n\t\t\t\tif (ctx.peerStates[peerId]) ctx.peerStates[peerId].leftRoomAt = 0;\n\t\t\t\tattachSharedPeerToRoom(peerId, shared);\n\t\t\t},\n',
  ],
])
