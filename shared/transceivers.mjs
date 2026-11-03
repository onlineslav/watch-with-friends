// Putting a track on a connection and taking it off again without leaving media sections behind (M1.11).
// Used by Trystero's peer.mjs (scripts/patch-trystero.js copies this file beside it) and by renderer/app.js,
// which takes a film's audio clones off by hand: they reach the room with addStream, and a room's removeTrack
// only finds tracks it was given one at a time (shared-peer.mjs keeps trackOwners for addTrack alone).
//
// RTCPeerConnection.removeTrack() only detaches the sender: the transceiver keeps its section and its codec list
// for good, and ten films' worth of them pushed the offer past what a signalling message may be. Stopping the
// transceiver lets the section be rejected, then recycled. But stopping is only safe once that section was
// negotiated (measured with two connections in Electron 44): a transceiver gets its mid from the local offer that
// first carries it, before any answer, and if that offer is then rolled back (the polite end, when the other end's
// offer collides with it) a stopped one is left with no mid, in no offer, and nothing ever takes it away:
// negotiation was "needed" after every round, 83 times in 2s (280 offers in a 5s run), for as long as the
// connection lasted, and a reused connection carries it from room to room.

const STOP_LATER = Symbol.for('watch-with-friends.stopWhenNegotiated') // one per connection, whichever copy of this module made it

export const isStopped = (t) => t.stopped === true || t.direction === 'stopped' || t.currentDirection === 'stopped'

// Negotiated, and the other end does not send on it: sendrecv or recvonly would mean it does (a copy from before
// M1.11 reuses its receiving transceiver for its own share, and Chromium hands a detached transceiver to the
// other end's next section of its kind), and stopping it would end that picture or sound too.
export const canStop = (t) => !isStopped(t) && (t.currentDirection === 'sendonly' || t.currentDirection === 'inactive')

// A transceiver detached before it was negotiated is stopped the next time the connection is stable with its
// section negotiated, if it is still unused then. After a rollback it is offered again (receive-only), answered,
// then stopped and rejected: two short rounds, then nothing.
function stopLater(pc, transceiver) {
  let pending = pc[STOP_LATER]
  if (!pending) {
    pending = pc[STOP_LATER] = new Set()
    pc.addEventListener('signalingstatechange', () => {
      if (pc.signalingState !== 'stable') return
      for (const t of pending) {
        if (isStopped(t) || t.sender.track) pending.delete(t)
        else if (t.currentDirection != null) {
          pending.delete(t)
          if (canStop(t)) try { t.stop() } catch {}
        }
      }
    })
  }
  pending.add(transceiver)
}

// Takes a sender's track off: stops its transceiver when that is safe, otherwise detaches it (removeTrack: the
// direction becomes recvonly or inactive) and, if it was never negotiated, stops it once it is.
export function stopSender(pc, sender) {
  const transceiver = pc.getTransceivers().find((t) => t.sender === sender)
  if (transceiver && canStop(transceiver)) {
    try {
      transceiver.stop()
      return
    } catch {}
  }
  try { pc.removeTrack(sender) } catch {}
  if (transceiver && !isStopped(transceiver) && transceiver.currentDirection == null) stopLater(pc, transceiver)
}

// Puts a track on with a transceiver of our own (addTransceiver), never one the other end made (native addTrack
// takes those, and stopping our film would then end the share the other end put on that very section). A
// detached one that never got a section is reused first; a stopped one never is (setting its direction throws
// InvalidStateError), and if reusing one is refused a new one is made.
export function addSender(pc, track, stream) {
  const idle = pc.getTransceivers().find((t) => t.mid == null && t.sender.track === null && !isStopped(t) && t.receiver.track.kind === track.kind)
  if (idle) {
    try {
      idle.direction = 'sendrecv'
      idle.sender.replaceTrack(track).catch(() => {})
      idle.sender.setStreams(stream)
      return idle.sender
    } catch {}
  }
  return pc.addTransceiver(track, {direction: 'sendrecv', streams: [stream]}).sender
}
