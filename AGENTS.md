# AGENTS.md

Shared instructions for coding agents on Watch With Friends (folder `synced-video-player`). Claude Code
reads this through CLAUDE.md; Codex reads it directly. Keep it a short map: facts about this project
only. How work is done (stages, item cards, checks) lives in the workflow, not here. The long detail
that used to live in CLAUDE.md is in `docs/`, one file per area: read the file in the table below
before touching that area. **Size cap for this file: 12 KB.**

## Workflow

This project follows Aya's workflow: `I:\Software Development\_workflow\WORKFLOW.md`.
Commands: `/milestones`, `/build-milestone`, `/ratchet`. Without those commands (e.g. in Codex),
follow the matching file in `I:\Software Development\_workflow\process\`.

## What this is

A small-room watch-together app (up to eight people), Electron, Windows and Mac. No server: peers find
each other through Trystero's public Nostr relays, then connect directly over WebRTC. The host opens a
file (or an image, a YouTube video, or shares a screen or window); ffmpeg in the main process turns it
into a fragmented MP4 for the host's MediaSource `<video>`; the picture and sound go to viewers over
WebRTC. Viewers never have the file. The host is authoritative for playback state.

## Commands

| Command | What |
| --- | --- |
| `npm start` | esbuild-bundles the renderer, then launches Electron (goes through `scripts/electron.js`, which unsets `ELECTRON_RUN_AS_NODE`) |
| `npm test` | All unit tests (`node:test` over `test/*.test.js` and `test/*.test.mjs` only) |
| `node --test test/plan.test.js` | One test file |
| `npm run bundle` | `renderer/app.js` to `renderer/bundle.js` (generated, gitignored). Re-run after editing `renderer/` or `shared/` |
| `npm run test:network` | Real renderer, three hidden Electron windows over WebRTC |
| `npm run test:compat` | This build against an older release copy, both directions (before any wire change) |
| `npm run test:connections` | Joining, friend discovery and rejoin during a simulated discovery outage; gates releases |
| `npm run test:logging` | Renderer events reach the log file |
| `npm run bench` | A/V sync and audio/video benchmark, ~15 min; the number every media-path change is checked against |
| `npm run status` | Builds `work/status/index.html` by hand. Nothing rebuilds it after a commit any more: the live page is Control Room's, at http://127.0.0.1:8790/synced-video-player/ |
| `npm run dist:win` / `dist:mac` | Installer in `dist/` (Mac only on macOS; CI builds both) |

Every script with its full notes (flags, variants, caveats): `docs/commands.md`.

## Code layout

| Path | What |
| --- | --- |
| `main/` | Electron main process: `main.js` (started by `index.js`), `plan.js` (pure ffmpeg decisions), `media.js` (ffprobe/ffmpeg sessions), updater, logging, diagnostics, priority, native-helper launchers |
| `renderer/` | The window. `app.js` room and sync layer; `player.mjs` MediaSource pipeline; `protocol.mjs` incoming-data validation; `sync.mjs`; `telemetry.mjs`; `friends.mjs`; `screenshare.mjs`; `frames.mjs`; one `.mjs` per feature |
| `shared/` | Code and data used by both sides (`codecs.json`, `log.js`, `live.js`, Opus SDP helpers) |
| `relay/` | Cloudflare worker for development telemetry and the live view |
| `native/` | Swift and C++ helpers (app audio, window lists, share sources, network probe, Mac updater) |
| `scripts/` | Build, bench and check scripts (`check-*.js` back the `test:*` commands) |
| `test/` | Unit tests |
| `docs/` | Area files (below), plus `TODO.md`, `BUGS.md`, `DEVLOG.md` |

## Hard constraints

Short form of the rules that must always hold. Each links to its detail file; read that before touching
the area.

- **Never change these three identifiers:** `build.appId` (`app.syncedvideoplayer`), `APP_ID` in
  `renderer/app.js`, `helloText` in `renderer/friends.mjs`. Existing installs stop upgrading or stop
  seeing anyone. (`constraints-build.md`)
- **Entry point is `main/index.js`** (calls `start()`); never rely on `require.main === module`.
- **Friends, persistent media (`persistent:<code>`) and presence (`presence:<code>`) share one transport
  `APP_ID`**; separate room ids isolate them. Changing it breaks connection reuse. Run
  `npm run test:connections`. (`constraints-network.md`)
- **Room protocol:** all incoming data goes through `renderer/protocol.mjs`; handlers are scoped to
  their session; admission needs signed identity challenges; subtitle paths never leave the host (opaque
  catalog ids); quality ceilings are automatic, not Settings controls. (`constraints-network.md`)
- **Presence:** observers never join media rooms or count as occupants; heartbeats expire after 30 s;
  presence is not persisted. (`constraints-network.md`)
- **Any wire change:** consider older copies and run `npm run test:compat` (the Trystero patch, the SDP
  guard and track handling are all `[wire]`). (`architecture-network.md`)
- **Production bundles contain no test hooks;** `test:network` adds them temporarily.
  (`constraints-build.md`)
- **Packaging:** ffmpeg/ffprobe stay in `asarUnpack`; the per-platform `files` excludes in
  `package.json` matter (`ffprobe-static` ships every platform). Mac builds are ad-hoc signed.
  (`constraints-build.md`)
- **Loop restarts must not look like pauses:** the host's playing state is `hostPlaying()`, which counts
  `ended` with loop on as playing. (`constraints-video.md`)
- **A looped film's capture tracks leave the stream but their clones stay alive:** `removetrack` only
  parks a track in `capture.detached`; never retire it there. `publishStream` carries over the previous
  live audio clone. (`constraints-video.md`)
- **The film's sound goes out through the Web Audio relay** (`filmAudioClone`, `relayAudio`) so a pause
  doesn't shift the audio timeline; `MAX_AUDIO_PATH_MS` is 300. (`constraints-video.md`)
- **Don't send `captureStream()` video:** `renderer/frames.mjs` forwards presented frames through
  `MediaStreamTrackGenerator`; `captureStream()` supplies only the audio. Frames are re-stamped with
  wall-clock time; polling fallback when minimized. (`constraints-video.md`)
- **Only 8-bit video passes through** (`copyCodecString` forces a transcode otherwise); H.264 is put
  first with `setCodecPreferences`. (`constraints-video.md`)
- **Local encode stays near-lossless** (FLAC when `support.flac`, else AAC; crf 17). Stream-copy seeks
  go to keyframe + 0.2 s and the renderer sets `sourceBuffer.timestampOffset`. Burned-in subtitles need
  `-copyts`, a relative filename with `cwd` set, and the filename escaped twice. A new `video.src` means
  new captured tracks. (`constraints-video.md`)
- **Audio on the wire:** Opus stereo comes from the receiver's own local SDP; both audio requests for a
  share use `SHARE_AUDIO_CONSTRAINTS`, never a bare `audio: true`; the audio-quality ladder never goes
  below 128 kbps and is skipped while "keep audio quality" is on (the default). (`constraints-quality.md`,
  `architecture-screen-share.md`)
- **Send ceiling:** `chooseSendQuality` keeps its deliberate stall memory (85% of the failed rate for
  60 s); don't "fix" it. (`constraints-quality.md`)
- **Telemetry:** freezes only count after 4 s of steady host playback (`nextSteady`); the receiver
  `jitterBufferTarget` runs 250 to 750 ms. Diagnostic log redaction runs in main over every value.
  (`constraints-telemetry.md`, `architecture-diagnostics.md`)
- **Nothing runs a `requestAnimationFrame` loop while idle** (it kept Chromium busy all session).
  (`architecture-screen-share.md`)
- **Windows share picker never calls `desktopCapturer.getSources`** (it froze the main process); share
  receivers have no 250 ms delay floor (`adaptShareBuffer`). (`architecture-screen-share.md`)
- **Mac native helper:** hold the `SCStream` in a variable that outlives its `do` block; size the
  `AudioBufferList` by `bufferListSizeNeededOut`. Test against real audio, not silence.
  (`architecture-screen-share.md`)
- **VS Code terminals set `ELECTRON_RUN_AS_NODE=1`;** run the app through `npm start`.

## Read this file before touching that area

| Area | File |
| --- | --- |
| Every npm script, its flags and caveats | `docs/commands.md` |
| ffmpeg plan, media sessions, MediaSource player, room and sync layer, pictures, pin, UI scale, controls bar, TURN, codecs | `docs/architecture-overview.md` |
| Screen share, share audio (Mac and Windows native helpers), whole-app share, share picker, share priority, idle frame loops | `docs/architecture-screen-share.md` (handoff notes: `docs/handoff-screen-share.md`) |
| Subtitles, default languages, skip intro and Previous/Next, shortcuts panel, whiteboard, playlist and saved rooms, reactions, identity | `docs/architecture-room-features.md` |
| Friends network, Trystero patch, rejoin repairs | `docs/architecture-network.md` (see also `docs/connection-regression.md`, `docs/discovery-recovery.md`, `docs/shared-connection-recovery.md`) |
| Diagnostic log, development telemetry, live view, session context and marks, network probe, reports | `docs/architecture-diagnostics.md` |
| Benchmark (`npm run bench`), A/V sync measurement | `docs/architecture-benchmark.md` |
| Loop, film audio relay, frame forwarding, 8-bit rule, seeks, burned-in subtitles | `docs/constraints-video.md` |
| Presence, connection reuse, room protocol v2 | `docs/constraints-network.md` |
| Connection telemetry and the `viewer-sample`, `host-sample`, `machine-sample`, `link` events | `docs/constraints-telemetry.md` |
| Send ceiling recovery, hardware H.264, audio quality | `docs/constraints-quality.md` (see also `docs/quality-recovery.md`) |
| Renaming, entry point, packaging, integration check | `docs/constraints-build.md` |
| Auto-update (Windows and Mac) | `docs/auto-updates.md` |

## Project docs

| File | What | Who writes |
| --- | --- | --- |
| `docs/TODO.md` | Milestones and item cards | Claude |
| `docs/BUGS.md` | Open and fixed bugs | Claude |
| `docs/DEVLOG.md` | One dated entry per session or run, newest first | Claude |
| `docs/archive/` | Old files kept for history (a stale Codex copy of CLAUDE.md, 2026-09-26) | Nobody |
| `README.md`, `NETWORK_REVIEW.md` | Public readme; network design review (2026-09-14) | Claude |
| `todo.md`, `devnotes.md` (repo root) | Working notes outside `docs/`; leave them alone unless Aya asks | Aya |

There is no `docs/PLAN.md` here. Read the area file and `docs/TODO.md` before changing design or stored
data (identity, friends, saved rooms and settings live in `localStorage` and the profile folder).
