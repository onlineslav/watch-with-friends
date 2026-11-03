// A viewer plays the stream the room hands over for a peer (room.onPeerStream). Over a connection that is kept
// between visits that stream can be a stale object: the host's film was taken off and put back while the viewer
// was away, the connection's receivers got their tracks again, but the transport matched the host's announcement to
// the first MediaStream it ever saw for that id (now empty, or holding only the audio) and never announced the new
// one. The sound or the picture is then missing although the receivers are carrying both (found by the rejoin loop in
// scripts/check-network.js, M1.7). The connection's own receivers are the truth, so this checks the stream against
// them and, when it lacks something that is flowing, builds a stream from the receivers' tracks instead.
const repaired = new WeakSet()
const sameTracks = (a, b) => a.length === b.length && a.every((track) => b.includes(track))

// stream: what the room gave (or a stream this made before); receiverTracks: the connection's receiver tracks.
// Returns the stream to play, the same object whenever it still serves.
export function repairedStream(stream, receiverTracks, make = (tracks) => new MediaStream(tracks)) {
  const flowing = receiverTracks.filter((track) => track.readyState === 'live' && !track.muted)
  const have = stream.getTracks()
  if (repaired.has(stream)) {
    // Only grows while it is in use (a receiver mutes briefly on a stall; that must not drop the picture).
    const kept = have.filter((track) => track.readyState === 'live')
    const wanted = [...kept, ...flowing.filter((track) => !kept.includes(track))]
    if (sameTracks(wanted, have)) return stream
    const next = make(wanted)
    repaired.add(next)
    return next
  }
  if (flowing.every((track) => have.includes(track))) return stream
  const next = make(flowing)
  repaired.add(next)
  return next
}
