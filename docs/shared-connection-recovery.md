# Shared connection recovery

## Failure and evidence

The October 6 Windows 0.5.5 log shows a connected friend leaving at
03:58:57 UTC. Subsequent room entries had no peers. Restarting at 04:02:13
allowed the same room to connect immediately. That build's logs do not
identify the exact failed transport stage.

Two tests against the actual pinned Trystero 0.25.4 dependency reproduce
a separate registry defect:

- Replacing the last shared peer deletes the per-app registry, then writes
  the replacement into the old, unregistered map. `get()` cannot find it.
- Clearing the last shared peer deletes the map that existing room contexts
  captured. Later registrations create a different map, invisible to those
  contexts.

Both tests fail before the patch and pass afterward. These are confirmed
recovery defects consistent with restarting fixing a connection; the old log
does not prove which defect affected that session.

## Fix

Keep the per-app registry object stable. Departed peer entries, room bindings,
buffers and timers still receive their existing cleanup. Empty registries
contain no peer connections. The app uses one fixed transport app ID, so this
retains one small empty map rather than accumulating maps per room.

The independent patch marker updates dependencies that already carry the
transport hardening patch, without applying that patch twice. App IDs, room
IDs, signed admission and wire formats are unchanged.

## Verification

`node --test test/transport.test.mjs` covers replacement, registry identity,
destruction of the replaced connection and removal of departed entries.

`npm run test:connections` now also keeps one real Electron client running
while its final physical peer disconnects and the other client restarts.
It verifies restored friend presence, room connection with discovery disabled,
preservation of the recovered friend connection when leaving the old room,
and rejoining through that connection. This integration scenario also passed
before the registry patch; it verifies supported recovery behavior rather
than reproducing either precise registry race above.
