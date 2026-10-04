# Automatic updates

Windows retains electron-updater/NSIS. macOS uses pinned Sparkle 2.10.0 through a
small native helper with a custom user driver. Sparkle owns verification,
extraction, replacement and relaunch; the app owns the room-aware restart gate.
No paid Apple certificate or hosted update service is required.

## Runtime behavior

- Check on launch, hourly, and on wake. Concurrent checks are coalesced.
- Download and stage without terminating a room. After leaving, wait three
  seconds and recheck membership before requesting installation.
- The helper retains Sparkle's ready callback until Electron writes `install`.
  If the application quits normally while staged, Sparkle can finish on quit.
- Retry failures after 1, 5, 15 and 60 minutes, capped at an hour. A successful
  check resets backoff. Home uses the existing notification style for progress,
  recovery guidance and manual retry. Native error detail goes to diagnostics.
- Bound native protocol messages and abort a helper that makes no progress for
  five minutes before staging. A staged update may wait for an entire film.

The app must run from a writable installed folder. Read-only DMGs, translocated
apps, and installations not writable by the logged-in user report a blocked
status. The updater never runs as root or installs package-based updates.
It does not remove macOS's first-install Gatekeeper checks or notarize the app.

## Authenticity and release pipeline

The host app embeds `SUPublicEDKey` from `config/update-key.json`,
`SUVerifyUpdateBeforeExtraction=true` and `SURequireSignedFeed=true`.
Both the update ZIP and feed must pass Ed25519 verification. Architecture feeds
are separate: `appcast-arm64.xml` and `appcast-x64.xml`. They are fetched from
the latest GitHub release and reference immutable, version-tagged ZIP assets.
The release job publishes ZIPs and feeds alongside the first-install DMGs.
Unsigned/mismatched releases fail the build rather than shipping a broken feed.

The private signing seed is the GitHub Actions secret `MAC_UPDATE_PRIVATE_KEY`.
It is never bundled, committed, passed in process arguments, or printed.
The initial key was provisioned with `scripts/provision-mac-update-key.js`.
The encrypted local backup lives at
`%USERPROFILE%\.codex\secrets\watch-with-friends-mac-update-key.dpapi` and can only
be decrypted using that Windows user's DPAPI credentials. Back up that profile
and the encrypted file; maintain an additional protected recovery copy if needed.
Do not rerun provisioning or rotate the public key casually: without Apple's
signing identity, existing installs depend on continuity of this update key.

The build downloads Sparkle only on macOS and verifies a pinned SHA-256 before
extracting it. It compiles and ad-hoc signs the helper for the target architecture.
Windows never downloads or loads Sparkle. Development builds never auto-update.

## Verification

```sh
npm run test:updater         # lifecycle, failures, protocol bounds, signing, UI copy
npm run test:updater:mac     # native Sparkle, temporary AppKit bundles and local HTTP
npm run dist:mac -- --dir --publish never
npm run test:updater:mac -- --packaged # actual packaged helper + Electron/localStorage
npm run test:updater:ui      # real preload/IPC, races, retry and zoom (Windows)
npm run test:updater:win     # real NSIS install/update; disposable hosted Windows CI only
```

`Updater QA` runs on Apple Silicon, Intel and Windows. Mac fixtures test invalid
archive signatures, unsigned/tampered feeds, corruption, missing/interrupted
downloads, package rejection, same/older versions, unsupported macOS versions,
read-only installs, paths containing spaces, bounded/partial/invalid native
commands, staging, replacement and relaunch. An ordinary quit finishes the
staged update without reopening an app the user deliberately closed.
The packaged test uses an isolated Electron fixture built from the actual app:
it stages in a room, leaves the room, updates and verifies Chromium localStorage
survives for identity, friends, room progress and settings. Production bundles
contain none of these fixture entry points. The release build repeats packaged
QA before uploading assets.

Windows release QA creates two NSIS fixtures from the actual packaged app with
a separate app ID and no shortcuts. It uses localhost feeds and an isolated
profile, rejects a SHA-512 mismatch, retries, waits through room membership and
rapid rejoining, installs silently and checks relaunch and saved data. It refuses
to run on personal machines or self-hosted runners. Installers and temporary
profiles are removed after testing.

The preservation fixtures seed identity, friends, room progress and settings
only in the old version. The updated version reads the original storage without
recreating missing values, so an empty or replaced profile fails the check.

The native QA override for a localhost feed is accepted only by the helper's
command-line entry point. Production Electron supplies only its own executable's
bundle path; renderer IPC cannot select a feed, app path, archive or command.

## Verified on 2026-10-04

Implementation and native QA commit: `4761fc2` (application version `0.5.2`).
The [Updater QA run](https://github.com/onlineslav/watch-with-friends/actions/runs/37230792324)
passed on Windows, Apple Silicon and Intel. The
[installer build](https://github.com/onlineslav/watch-with-friends/actions/runs/37230792398)
contains the review installers and signed Mac update feeds/ZIPs.

| Check | Result |
| --- | --- |
| Unit suite | 211 tests passed, including lifecycle races and separate Windows download rejection handling. |
| Apple Silicon and Intel Mac | 14 native scenarios passed per architecture, including packaged replacement/relaunch and preservation without reseeding. |
| Windows NSIS | Checksum rejection, full-download fallback, retry, room/rejoin deferral, silent replacement/relaunch and preserved original data passed. No unhandled download rejection; fixture uninstallation/cleanup completed. |
| Actual renderer/preload IPC | Pending join/restart guard, late snapshot race, progress/retry, private error copy and card fit at 50%, 100% and 200% zoom passed. |
| Room regressions | Local three-peer media/download/saved-room integration and friend-first/room-first rejoining during a discovery outage passed. |

QA used disposable profiles and localhost feeds. The manual build did not
publish a release or send updates to existing installs. Older Mac installations
need one manual upgrade to the first public release containing this updater.

References: [Sparkle setup](https://sparkle-project.org/documentation/),
[custom drivers](https://sparkle-project.org/documentation/api-reference/Protocols/SPUUserDriver.html),
[external bundle updates](https://sparkle-project.org/documentation/sparkle-cli/).
