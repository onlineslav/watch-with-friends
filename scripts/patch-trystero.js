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
