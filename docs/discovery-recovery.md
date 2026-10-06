# Discovery retry recovery

## Observed failure

On October 6, 2026, a Windows 0.5.5 session entered several rooms without a
connected peer. After restarting, the same room connected to the friend and
exchanged clock requests with roughly 71–80 ms round trips. The existing log
did not record discovery warnings or failed peer negotiations, so it cannot
establish which connection stage caused those attempts to stall.

## Reproduced defect

Trystero 0.25.4's `makeSocket` marks a discovery client permanently closed
after six consecutive WebSocket failures. Its exponential retry period reaches
60 seconds and is treated as a stopping condition. The app can stay open
indefinitely with that relay disabled, even after the network recovers.

`test/discovery-retry.test.mjs` exercises the actual dependency with controlled
WebSocket failures and timers. Both initial discovery and an established relay
stop at six attempts before the patch. With the patch, they survive twelve
failures, reconnect when the relay returns, and still cancel scheduled retries
when explicitly closed. This is a confirmed defect consistent with restart
recovery; it is not proof of the cause of the observed session.

## Change

`scripts/patch-trystero.js` independently patches the pinned dependency's
socket retry loop, including installations that already have the transport
hardening patches. Backoff remains capped at 60 seconds and each retry waits
at least one second. Transient socket closes no longer permanently disable a
relay. Explicit closes remain final, including Nostr relay rejections; this
change does not override server refusals or supply TURN infrastructure.

Diagnostics now preserve Trystero console warnings, join failures for media,
friends and presence channels, and WebRTC state transitions. Each physical
connection gets a local number and records whether remote negotiation has
started and whether TURN is configured. SDP and credentials are not copied.
Existing main-process redaction still removes paths and IP addresses. The
Electron logging check verifies that discovery warnings reach the exported
file with addresses redacted.

## Verification

Run `npm test`, `npm run test:logging`, `npm run test:connections`,
`npm run test:network`, and `npm run test:discovery`. Public discovery uses
real Nostr relays but local media connections; it is not a cross-network NAT
traversal check. A connected stream does not establish that every configured
discovery relay is healthy.
