# Streaming quality recovery

`renderer/sync.mjs` owns per-viewer application ceilings. WebRTC still owns
instantaneous congestion control and its actual encoding bitrate/resolution.

## Regression

The previous controller immediately capped video at 80% of every outgoing
bandwidth estimate, including estimates received during otherwise clean playback.
It also lowered the picture's resolution using that cap. Recovery added only 15%
after each 12-second calm interval: recovering from 300 kbps to the 3.5 Mbps
full-resolution tier took 216 seconds, even with ample available bandwidth.

An October 2026 diagnostic pair showed the result: 86.4% of viewer samples with
incoming frames were 360p or lower. Most logged reductions were attributed to
capacity estimates. That observation does not identify the physical bottleneck,
and replaying old feedback cannot predict the network's response to a new sender.

## Controller behavior

- Bandwidth estimates alone do not lower the application's ceiling. WebRTC can
  reduce its actual bitrate and picture when the network requires it.
- Fresh reports of loss above 2% or freezes reduce the ceiling by 25%; an available
  bandwidth estimate can further bound that reduction. The 300 kbps floor remains.
- After six seconds of clean feedback, every fresh sample probes upward by 25%
  or 300 kbps, whichever is larger. Available headroom can accelerate that recovery
  to at most twice the previous ceiling per sample. Low estimates do not prevent
  recovery probes.
- Pauses, loading/buffering and missing feedback reset the calm window. Each
  received report is consumed once, so differing host/viewer timer phases cannot
  apply one loss report repeatedly or reuse one clean report as a recovery.
- The 10 Mbps per-viewer and 18 Mbps group ceilings and 1080p maximum remain.

## Verification

`node --test test/sync.test.mjs test/telemetry.test.mjs` covers reductions,
recovery, stale reports, paused playback, missing feedback and the group budget.
With 6 Mbps estimated headroom, the controller reopens from 300 kbps to at least
4 Mbps in 12 seconds; with an unchanged 1.2 Mbps estimate, it does so in 22 seconds.
These are ceiling recovery times, not promises of delivered bitrate.

`npm run test:network` uses a synthetic 720p movie and real Electron/WebRTC
senders and receivers. A test-only stats override injects a low bandwidth estimate
and loss/freezes. The check observes the receiving picture fall to 360p and return
to 720p after clean feedback, checks the applied sender parameters, and verifies
that pausing does not change the ceiling. Recovery samples are advanced directly
to keep the check short. Production bundles contain no test hooks or overrides.

`npm run bundle` and `npm run test:logging` verify bundling and the diagnostic IPC
and export path. A real cross-platform internet session remains necessary to
confirm the improvement on the original connection.

## Diagnostics in 0.5.4

Host samples retain the requested `bitrate` and `scale` and now include measured
`sentBitrateBps` and `sendIntervalMs`. Viewer samples include measured
`receivedBitrateBps` and `receiveIntervalMs`. These rates use RTP media byte-counter
deltas and the actual stats timestamps, not a presumed two-second interval. A first
sample, missing counter, changed stream or reset counter produces `null`; a valid
sample without new bytes produces zero. `mediaKind` distinguishes video from an
audio-only session. Counters stay local and do not extend the room protocol.

Host samples also include source dimensions, playback state/time/epoch, feedback
arrival time and age, freshness, the group ceiling, and the controller's actual
decision: `inactive`, `no-feedback`, `duplicate-feedback`, `settling`, `loss`,
`freezes`, `recovery`, `ceiling`, or `group-budget`. Quality-change events use that
decision instead of inferring the reason from whether bitrate went up or down.
`send-parameters-applied` and `send-parameters-failed` distinguish requested
ceilings from accepted sender settings; actual transmitted resolution remains in
the sender/receiver samples.

The network integration check verifies these fields in a real redacted diagnostic
export alongside the real 720p/360p/720p receiving picture.
