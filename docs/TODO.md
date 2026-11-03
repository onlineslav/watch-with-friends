# TODO

Milestones and item cards for `/build-milestone`. Format: `I:\Software Development\_workflow\process\milestones.md`.
Aya's own notes stay in the root `todo.md`.

## Now: M1 — Measured performance

Goal (Aya, 2026-11-03): make streaming and every other part of watching together as good as possible, driven by
comprehensive, live telemetry instead of guesses. Starting complaint: Lenna (viewer) reported audio out of sync with
the picture, poor audio quality and a generally bad experience watching Aya's stream.

Must work:
- Telemetry never makes playback worse: no new requestAnimationFrame loops, the 2s sample costs under 2ms of the
  page's main thread, and live streaming uses under 5 kbps per person.
- Nothing leaves a machine unless "Send telemetry for development" is on, and the live view can only be read by
  someone with access to the private diagnostics repository.
- On the local benchmark, audio and picture line up within 40ms for a film and for a screen share.
- A viewer on a clean link receives stereo audio at the configured bitrate with under 0.5% concealed samples.
- Copies on 0.7.x and 0.8.0 still join, play and share with the new build (nothing on the wire breaks).

Allowed to be rough:
- The live view is terminal output, not a dashboard.
- Scorecard layout is plain text.
- Free-tier Cloudflare limits: if they're hit, live viewing stops for the day (no charge); the 15-minute archive
  upload keeps working.

### M1.1 Live telemetry stream [must-work] [wire]
Status: verified
Story: While Lenna and I are watching, I run one command and see both our telemetry lines as they happen, about two
seconds behind, so I can change something and see the effect right away.
Done when:
- With the checkbox on, each log line reaches the Worker within ~3s over one WebSocket per app (`/live`), batched,
  no more than one message a second. With it off, no socket is opened.
- `npm run diagnostics -- --live` shows every connected person's lines interleaved by wall clock, labelled by
  username, and can filter by scope (e.g. `--live telemetry`).
- The live view authenticates with the reader's own `gh` token; the Worker accepts it only if that token can read
  `onlineslav/watch-with-friends-diagnostics` (checked once per connection, cached briefly). A request without one
  gets 401.
- Dropped network: the app reconnects with backoff and never buffers more than ~1 minute of lines; the existing
  15-minute GitHub archive upload is unchanged and still sends everything.
- Worker tests cover auth refusal, fan-out to two viewers, and an app reconnect.
- (pre-mortem) Apps send lines only while at least one viewer is connected (the Worker pushes `{watching}`); idle
  sockets answer pings via `setWebSocketAutoResponse` without waking the DO; a test asserts zero frames with zero
  viewers.
- (pre-mortem) Measured kbps per person over 60s with 1 and with 3 peers (`test:network`) is under 5 kbps
  (compress or trim batches); the number is on this card.
- (pre-mortem) Live lines are the redacted lines: a test logs `C:\Users\x\film.mkv` from the renderer and a fake
  `/live` receives `…/film.mkv`, byte-identical to the file line.
- (pre-mortem) The viewer strips C0/C1 control characters; the Worker caps app sockets per DO, frame size and
  frames per second.
- (pre-mortem) Backoff 1s→60s with jitter (≤4 tries/min), 429 backs off; a heartbeat finds a dead socket within 30s
  (fake-clock test); buffer capped by bytes (~256 KB) as well as ~60s, with a "dropped N" marker.
- (pre-mortem) The `gh` token travels in a header, never the URL, is never logged, and is cached by its hash; a
  GitHub 403-rate-limit/5xx answers 503, not 401 or "allowed".
- (pre-mortem) Turning the checkbox off mid-stream closes the socket within 1s.
- (pre-mortem) After the change, a 0.8.0-format `POST /telemetry` and `/credentials` still succeed and the existing
  `test/relay.test.mjs` passes; `wrangler.jsonc` uses `new_sqlite_classes`.
- (pre-mortem) The viewer holds ~1s of lines before printing so two people's batches interleave in wall-clock order.
Likely failures:
- Durable Object WebSocket hibernation not used, so idle sockets cost requests all day.
- Reconnect loop hammering the Worker when it's down (rate limit is 10/min per IP).
- Lines logged before identity is known have no username.
Decided: Cloudflare Durable Objects (free plan, SQLite-backed) hold the live sockets; GitHub stays the archive.
Decided (Aya, 2026-11-02): nobody is on telemetry yet; make it as easy for development as possible. The existing
checkbox covers live streaming too (no new opt-in). App sockets stay unauthenticated like `/telemetry` (caps and
control-character stripping only; labels are the claimed username). The orchestrator deploys the Worker after the
audit passes.
Out of scope: a web dashboard.
Gate: no
Evidence: 3c8609d + 7c26f5e (attempt 2 fixed 2 MEDIUM audit findings: per-person blocks instead of wall-clock
interleave; decoded JSON escapes reaching the terminal; plus the LOW stale-reader drop). Orchestrator reruns: `npm test`
340/340; `npm run test:live` (real local workerd + real GitHub auth) 8 PASS, line delay 0.4–1.5s from main, checkbox
off closes the socket in 62ms, zero frames with zero readers; `test:live-rate` worst 0.87 kbps (1 peer) / 1.38 kbps
(host, 3 peers), raw JSON would be ~5.2/12.6 kbps; `test:logging` live line byte-identical and redacted (`…/film.mkv`);
`test:network` 43 PASS. Deployed 2026-11-03 (version 7a1a52ac): `/live` 401 without a token, 200 with Aya's `gh` token;
0.8.0-format `POST /telemetry` 200 (committed `telemetry/deploycheck-0000-0000/2026-11-03/064731833.log.gz`);
`/credentials` 503 "Relay is not configured" (no TURN, as before); `npm run diagnostics -- --live` connects. Note:
apps stream only from the next release; 0.8.0 copies only archive. LOW (audit): DO hibernation itself only observable
in the Cloudflare dashboard after real use.

### M1.2 Comprehensive measurements
Status: verified
Story: When something goes wrong, the log already says whether it was the network, the computer, the encoder or the
audio path, so nobody has to reproduce it to find out.
Done when (each as fields on the existing 2s samples or a once-per-session event, documented in CLAUDE.md):
- Audio receive health per sample: audio packets lost, audio jitter, concealed and silent-concealed samples,
  samples inserted/removed for time-stretching, audio jitter-buffer delay, audio level.
- A/V sync inputs per sample: audio and video playout delay separately, `estimatedPlayoutTimestamp` for both
  tracks, and the viewer's Web Audio `outputLatency`/`baseLatency` (received audio plays through
  `routeRemoteAudio`'s Web Audio graph, not the video element).
- Encoder/decoder cost: implementation names, power-efficient flags, ms per encoded and decoded frame,
  `qualityLimitationDurations` deltas, PLI/NACK/FIR counts, total freeze and pause duration.
- Machine load every sample: CPU and memory per Electron process (`app.getAppMetrics`), renderer long tasks
  (PerformanceObserver), on battery, thermal state; once per session: GPU feature status and display refresh rate.
- Host pipeline: ffmpeg speed against real time, seconds buffered ahead in the MediaSource, spacing of frames
  forwarded by `frames.mjs` (mean and worst interval).
- Network detail: UDP or TCP, local and remote candidate types, negotiated Opus parameters (channels, stereo,
  maxaveragebitrate, useinbandfec) read from the live SDP.
- Each sample carries the relevant Settings (share priority, audio bitrate, audio-first) so a change is traceable.
- Measured on a page profile: the sample still costs under 2ms of main thread; unit tests cover every new delta.
Likely failures:
- New stats missing on older Chromium/macOS: every field must tolerate absence (null, never NaN).
- Line size: samples grow; keep each under the 4000-byte line cap (`shared/log.js`).
Out of scope: changing any behaviour based on these numbers (later cards).
Gate: no
Evidence: 69ca220. Rerun by orchestrator: `npm test` 299/299; `npm run test:logging` ok; `check-network.js` exit 0, 43
PASS, `checkMeasurements` asserts every new field in the real log (no NaN/undefined). Page profile: full
`sampleConnection` 1.39ms host / 0.98ms viewer (HEAD before: 4.24/3.97ms); in-page JS per tick host median 1.9ms, max
2.2ms (cold JIT). Lines: viewer-sample 832 B, host-sample 868 B, machine-sample 324 B, link 317 B, machine/static
1002 B. Real values seen: audio `jb` 248ms, `out`/`base` 30/10ms, ffmpeg 15.8x (nvenc), Opus remote ch2 st1 br510000
fec1. Gap: `estimatedPlayoutTimestamp` is undefined in loopback Chromium, so `aEpt`/`vEpt`/`av` are unit-tested only.
Decided: machine numbers in one `machine-sample` per tick; slow facts in change-only `link` and per-room
`machine/static` events; SDP re-read on stream change and every 30s. LOW: host per-tick max 2.2ms is at the 2ms bar;
re-check at the milestone audit with 3+ viewers.

### M1.3 Session scorecard and release comparison
Status: verified
Story: After a watch session I run one command and get a short scorecard per person, and can see whether a new
version is better or worse than the last one.
Done when:
- `npm run diagnostics -- --report [username] [day]` prints per session and per viewer: typical and worst RTT, loss,
  share of time frozen, audio concealment %, A/V offset estimate, received vs target audio and video bitrate,
  encode/decode ms, CPU peak, and the quality decisions taken.
- Host and viewer logs of the same room are paired automatically (room code + wall clock).
- `--compare` groups the same scorecard by app version.
- Pure summary functions are unit-tested against a fixed sample log (golden output).
Out of scope: charts.
Gate: no
Evidence: 74c20e0. Orchestrator reruns: `node --test test/report.test.js` 17/17 (3 golden outputs: newest day, a 0.8.0
day without M1.2 fields printing "–", and `--compare`); `npm test` 357/357; `--report --dir test/fixtures/report
2026-10-01` pairs host + viewer logs into one room session and fills a viewer without its own log from the host's
reports; `--compare` prints 0.8.0 vs 0.9.0 with better/worse verdicts. Hand-checked: concealment 16800/2688000 = 0.63%,
frozen 600ms/56s = 1.1%. Not yet run on a real session (the archive only holds a test file); that happens in M1.8.
Decided (builder): A/V offset positive = sound behind picture, method labelled `[av]` (`s.av`) or `[delay]` (audio
jb + playout + Web Audio out − video jb); times in UTC; audio target = Settings' `set.ab`; `--no-fetch`/`--dir`.

### M1.4 Automated A/V sync and audio benchmark [must-work]
Status: verified
Story: Every change to the media path is measured the same way before release, so "better" is a number, not a
feeling.
Done when:
- `npm run bench` generates a synthetic clip with a white flash and a 1kHz beep at the same instants (ffmpeg, no
  real media), hosts it in one hidden window and views it in another over real WebRTC (the `check-network.js`
  harness), and measures on the viewer the flash (video frame brightness) against the beep (analyser on the output
  graph, after `routeRemoteAudio`), reporting median and worst offset.
- The same run measures received audio channels, bitrate and concealment, and video fps and frame-interval jitter.
- A screen-share variant measures the same for a share of a window playing the clip.
- It never plays sound through the speakers (output muted or routed to a silent sink: Aya's no-audible-tests rule).
- Results are printed and written to `work/bench/<version>-<date>.json` so runs can be compared.
- (pre-mortem) The clip is moving `testsrc2` with a flash patch of at least 3 frames (rising edge detected) and a quiet
  bed tone under the beeps; flashes at irregular intervals of at least 2s; N≥20 events per run.
- (pre-mortem) Video time is the viewer's rVFC `expectedDisplayTime`; audio time is the onset sample from an
  AudioWorklet tap after `routeRemoteAudio`'s output gain, converted with `getOutputTimestamp`. The bench asserts the
  viewer's rVFC rate is ≥0.9× the clip fps. All of it lives in test hooks; idle home still shows 0 rAF calls.
- (pre-mortem) The JSON records `outputLatency`, `baseLatency`, the `getOutputTimestamp` lag and a
  `deviceLatencyIncluded` flag; if muting makes them ~0 the report says so and names the correction it applies.
- (pre-mortem) The gated number is the viewer's absolute offset against the clip's true simultaneity; host offset and
  transport skew (`s.av`) are reported beside it, never subtracted. Median, p95, worst, and spread across 3 runs.
- (pre-mortem) Concealment is reported as `conc − sil` over a window that skips the first 10s of ramp-up.
- (pre-mortem) The share variant asserts the received beep's RMS is above a threshold, so silence never passes.
Likely failures:
- Measuring at the wrong point: the offset must include the Web Audio output path, or it hides the suspected bug.
- A flaky harness: report spread across 3 runs.
Decided (orchestrator, 2026-11-03, under Aya's "easy for development" rule; overrule if wrong):
- Share-variant audio: no real WASAPI/ScreenCaptureKit capture (it would play sound). The clip's PCM goes through the
  real `'app'` audio path from the helper's stdout onward (a fake helper process feeding `main/app-audio.js` →
  `renderer/app-audio.mjs` → the share stream), so only the OS capture call itself is skipped. No virtual audio
  cable needed.
- "≤40ms" is measured up to the Web Audio output, including the latency the OS reports (`outputLatency`). Extra
  latency a device doesn't report (Bluetooth) is out of scope, and so is the host's own local playback (the
  `<video>` element syncs itself).
Decided (orchestrator, 2026-11-03): the share variant's stand-in source (canvas frames through a
`MediaStreamTrackGenerator` + PCM through the real `'app'` audio path via `SVP_APP_AUDIO_FAKE`) is accepted; real
window capture is confirmed by the real session in M1.8 instead. No loss-injection option yet: M1.6/M1.7 add it.
Gate: no
Evidence: 72b4e3f. Builder: `npm run bench` 3 runs/variant, 25/25 events each; film medians 47.4/48.0/41.3ms
(sound late), p95 ~57ms, rVFC 0.99–1.0× clip fps, frame-interval sd 1.8–4.4ms, audio 2ch 256kbps, concealment 0%;
share medians −627/−673/−709ms. Orchestrator rerun: `npm test` 365/365, `renderer/bundle.js` 0 `__bench` matches, one
film run median 48.2ms p95 56.7ms worst 57.8ms, `deviceLatencyIncluded=true` (outputLatency 30, lag 41ms). Audit
(workflow-auditor): film number holds up (mapping and flash/beep timing checked, components add up); harness inert in
production, nothing reaches the speakers. The share's −650ms is a **timestamp-base artifact in size** over a real bug:
`renderer/app-audio.mjs:43` stamps AudioData from 0, so lip-sync delays video by an amount set by when the audio track
started (silent probe: 90ms to 2600ms+ rising, or lip-sync gives up after ~12s uptime); fix in M1.5. The viewer
decoding mono is a real bug (only the remote description gets `stereo=1`; Trystero calls `setLocalDescription()` with
no args); fix in M1.6. LOW: `deviceLatencyIncluded` can't tell a muted sink from a real device, so the film number may
omit real device latency. Decided: no unmuted device probe (no-audible-tests); the flag is read as "reported by this
muted context".

### M1.9 Session context and "something's wrong" marks [wire]
Status: verified
Added: Aya, 2026-11-03 ("I want everything that would be useful"). Built right after M1.4, before the next release,
so Lenna's first live session has it.
Story: When Lenna or I notice something bad, one key press marks the moment in both our logs, and the log already
says what was going on around it: our audio devices, what we were doing, whether anything crashed.
Done when:
- A mark: a hotkey and a small control in the room (Settings shows the key) logs `mark/note` with an optional short
  note, locally and on every peer in the room (a new room action, validated in `protocol.mjs`, rate-limited). Older
  copies ignore it without errors. `--report` lists each mark with the numbers from the 10s around it, and
  `--live` highlights it.
- Audio output device per person, once per session and on change: kind (built-in, wired, Bluetooth, HDMI, virtual,
  unknown; from the device label and `enumerateDevices`), label, sample rate, `outputLatency`/`baseLatency`.
- Crashes: `render-process-gone`, `child-process-gone` (GPU, utility), unresponsive/responsive windows, and WebRTC
  connection-state changes and ICE restarts, each with its reason.
- Actions and window state: play, pause, seek, volume, mute, fullscreen, minimized/hidden/focused, sleep/wake
  (`powerMonitor`), and Settings changes, each as a small event (no per-frame or per-sample cost).
- Source facts once per file opened: container, codecs, resolution, fps, HDR, passthrough or transcode and why,
  the encoder chosen (nvenc/qsv/amf/videotoolbox/libx264).
- (Aya, 2026-11-03) Whose network is the bottleneck:
  - Each app pings the Worker over its existing `/live` socket every 2s (answered by `setWebSocketAutoResponse`,
    so the DO stays asleep; the socket is open whenever the checkbox is on, watched or not) and logs the RTT to the
    Cloudflare edge on the 2s sample. A rising RTT while streaming means that person's own link is saturated.
  - One-way delay per direction (host→viewer and viewer→host) from the clock offset `sync.mjs` already measures,
    logged on the samples.
  - `--report` prints a "Likely bottleneck" line per viewer (your upload / their network / their computer / your
    computer / unclear) with the numbers behind it.
- All events go through the existing redaction (no paths, no IPs), stay under the 4000-byte line cap, and add no
  rAF loop or per-sample IPC; documented in CLAUDE.md; unit tests for the new pure parts (device-kind
  classification, mark validation, report mark windows).
Likely failures:
- Device labels are empty until media permission is granted: fall back to `unknown`, never fail.
- A mark sent during a host change or to a peer on 0.8.0 must not break the room.
Out of scope: on-demand speed test and Wi-Fi vs cable (Aya: first two methods only), Wi-Fi signal strength,
join-timing breakdown, Chromium audio underrun counts (later, if needed).
Gate: no
Audit (56e0306): wire claims verified (old peers drop `mark` before any handler; old hosts accept `at`). To fix
(queued after M1.5 to avoid two builders in `renderer/app.js`): MEDIUM `scripts/bottleneck.js:117-131` sums long-task
ms over a session and checks host-computer before viewer-network, so long sessions blame the wrong computer (compare
a rate; never pick host-computer while the other link is full); MEDIUM `renderer/app.js:4805` Shift+X types "X" into
the note box (needs `preventDefault`); LOW device labels can carry first names ("Lenna's AirPods") — Decided: strip
the possessive prefix before logging; LOW fallback text says "neither link filled" when the viewer's edge RTT is
missing. LOW (not fixing now): the "marked in everyone's log" toast shows even when a 0.8.0 peer drops it.
Evidence: 56e0306 + cf6aa73 (attempt 2 fixed both MEDIUM and both fixed LOWs). Orchestrator reruns: `npm test` 430/430;
`npm run test:network` exit 0, 48 PASS (`checkContext`: X / button / note box, mark in all 3 logs under one id, flood
capped at 6 per 10s, bad payloads dropped, Shift+X default-prevented with an empty note box, actions and Settings
diffs logged); `npm run test:live` pass (mark highlighted through the real local Worker; edge pings with nobody
watching, 0 extra frames); `test:logging` ok; `--report` on the fixture prints `Marks (2)` and `Likely bottleneck
host-one's upload`. Builder: `test:live-rate` 3 viewers worst 1.07 kbps, host ≤1.46 kbps; sample 1.21–1.45ms host;
`chrome://crash` → `crash/render-process-gone {"reason":"crashed"}`. Wire: 0.7.0/0.7.1/0.8.0 drop `mark` before any
handler (`if (!action) return`, verified at the tags by builder and auditor; `test/mark-wire.test.mjs`); old hosts
accept the optional `telemetry.at`. Decided (builder): mark key `X`, Shift+X focuses the note; edge pings 2s in a room,
15s otherwise; `window/fullscreen`/`visibility` lines only smoke-tested.

### M1.10 Release 0.8.1 with live telemetry
Status: needs Aya
Added: Aya, 2026-11-03 (approved "build them right after M1.4, before the release").
Done when: M1.1–M1.4 and M1.9 are verified; a 0.8.1 release is cut the usual way (CI builds both platforms,
auto-update picks it up); after install, `npm run diagnostics -- --live` shows Aya's own lines.
Gate: no
Evidence: released 2026-11-03, https://github.com/onlineslav/watch-with-friends/releases/tag/v0.8.1 (9 assets: Windows
setup + blockmap + latest.yml, Mac arm64/x64 dmg + zip + appcasts). Tag `v0.8.1` → 20b3a54 = 51e5ba4 + three CI-only
commits: the 2s sample-cost assertion in `check-network.js` is report-only on CI runners (`SAMPLE_COST_LIMIT_MS=report`;
they read 2.16ms Windows, 4.3–7.6ms Intel Mac on code that costs 1.4ms locally) and stays a 2ms gate locally.
Not yet merged into `share-whole-app` (waits for M1.6's commit). Waiting on: Aya's check 4 (her own live lines).

### M1.5 Audio in sync with the picture [feel]
Status: needs Aya
Story: When I host, my friends hear the sound exactly when they see it, for films and screen shares.
Done when:
- `npm run bench` shows |offset| ≤ 40ms (median) for a film and a share, and the before/after numbers are on the card.
- The fix accounts for the viewer's Web Audio output latency (delay video by it, or play audio on a path WebRTC's
  lip-sync knows about), keeps volume control and reaction sounds working, and keeps captions aligned (their delay
  math uses the video delay).
- Live telemetry from a real session shows the offset field stays near zero.
- Aya check: watch a film with Lenna; dialogue matches lips.
- (M1.4 bench, before) Film median +41–48ms (sound late), p95 ~57ms; share −627 to −709ms (sound ~650ms EARLY:
  the picture arrives ~730–816ms late with audio, 53ms late without it — suspect WebRTC lip-sync holding video for
  an audio track whose capture timestamps are on a different clock, e.g. `renderer/app-audio.mjs` AudioData vs the
  video generator's `performance.now()` stamps). Telemetry `s.av` (11–22ms) does not see the share gap: fix or
  replace it so live telemetry shows the real offset.
- (M1.4 audit) Share fix: `renderer/app-audio.mjs` bases AudioData timestamps on `performance.now()` at the first chunk
  plus frames written, re-anchored after delivery gaps (the Mac helper may deliver nothing in silence). The bench's
  share variant starts the share only after ≥15s of app uptime (as in real use) and reports the offset after fixing.
Likely failures:
- Delaying video by the output latency while `jitterBufferTarget` also moves: the two must not double-count.
Gate: no
Evidence: 3877b63 (+ cf6aa73 on top). Builder bench (3 runs each, before → after): film run medians 42.0/31.8/47.2 →
16.5/−4.9/21.3ms; share at 15s uptime 51.8/51.0/53.6 → 19.5/17.7/35.5ms (before, lip-sync had given up; −650ms was the
fresh-page case). Orchestrator rerun, `npm run bench` (work/bench/0.8.0-2026-11-03-0928.json): film median −2.7ms
(runs 57.4/−2.7/−6.4), p95 47.1, worst 70.4; share median 20.4ms (runs 11.9/20.4/49.3), p95 42.7, worst 74; 25/25
events every run; `s.off` read 28–29ms on the share. `npm test` 430/430; `test:network` 48 PASS;
`check-app-share.js` passed (whole-app worker now on the page clock). Captions: `test/telemetry.test.mjs` "captions
stay aligned with the picture when the video waits for the audio path". LOW: single-run medians spread widely (63.8ms
film, 37.4ms share); the film run at 57ms had the host's own playback at 39.7ms, so host-side load (another project's
Electron tests were running) is the likely cause; compare medians over 3 runs. Decided (builder): the video wait
(output + base latency, ≤200ms, added once to the video receiver's `jitterBufferTarget`) applies to shares too; `s.av`
kept but documented as unreliable, `s.off` is the sync number. Waiting on: Aya's check with Lenna (below).

### M1.6 Audio quality end to end [wire] [feel]
Status: needs Aya
Story: Music and voices from a film or a share sound like the source, not like a phone call.
Done when:
- Benchmark and telemetry confirm stereo Opus at the configured bitrate for films (`AUDIO_MAX_BITRATE`) and shares
  (Settings' audio bitrate), with concealment under 0.5% on a clean link.
- Opus parameters chosen on purpose and documented: in-band FEC on, DTX off, `maxplaybackrate=48000`, stereo; the
  audio sender has high network priority when "keep audio quality" is on.
- Any SDP change still negotiates with a 0.8.0 copy (checked with `npm run test:network` against the old renderer or
  a recorded 0.8.0 offer).
- Under simulated loss (bench option), audio degrades by bitrate before it drops out.
- Aya check: listen to a music-heavy scene with Lenna.
- (M1.4 bench) The viewer hears MONO: L/R separation 0 at the viewer's tap (0.5 at the host's) in all runs; the
  host's send fmtp has `stereo=1`, the viewer's receive fmtp is only `minptime=10;useinbandfec=1`. Mechanism (audit): `preferStereoOpus` runs only in the
  `setRemoteDescription` patch (`renderer/app.js:117-123`); Trystero calls `setLocalDescription()` with no arguments,
  so the decoder follows the viewer's own SDP. Patch `setLocalDescription` to create the offer/answer explicitly and
  add `stereo=1` before setting it. Fix so the bench shows separation at the viewer, and still negotiates with 0.8.0.
- Add a loss-injection option to `npm run bench` (e.g. a local UDP relay/TURN in the harness, or forcing relay
  candidates through a lossy proxy) — needed here and in M1.7.
- (pre-mortem) Munging lives in `scripts/patch-trystero.js`, not an `app.js` wrapper: both argument-less calls
  (offer and answer, `peer.mjs` ~156/~270) become create → munge → set; rollback is left alone, the ICE-restart offer
  is munged too, and `signal()` waits for an in-flight offer before rolling back. `test/transport.test.mjs`: both
  peers add streams at once (glare) and an ICE restart; both reach `stable` in <1s, no `watchOffer` resend, no
  `failed to` errors.
- (pre-mortem) `preferStereoOpus` (`renderer/lib.mjs:44`) munges every Opus section (global replace), and
  `parseOpusFmtp` reports the active audio section, not the first: unit test with a 3-audio-section SDP; the bench
  shows viewer L/R separation ≥0.4 for a film, a share, and a film after two republishes.
- (pre-mortem) Loss injection via libwebrtc's fake network (`--force-fieldtrials=WebRTC-FakeNetworkSendConfig/
  loss_percent:N/`, `link_capacity_kbps`), not a proxy: `npm run bench -- --loss 5` records the mode in the JSON and
  asserts `packetsLost > 0`.
- (pre-mortem) Degrade by bitrate: `tuneSenders` steps each viewer's audio cap 256 → 128 → 64 kbps at >2% / >5% loss
  that viewer reports, back up after 30s calm (no RED). At 5% loss the sent audio bitrate drops a step within 10s and
  concealment is lower than at a fixed 256k. SDP stays `stereo=1; sprop-stereo=1; useinbandfec=1; usedtx=0;
  maxplaybackrate=48000; maxaveragebitrate` (no `cbr`, no `ptime`).
- (pre-mortem) "Keep audio quality": a bench run with `link_capacity_kbps:1500` keeps audio ≥90% of its cap with it on
  and lower with it off; the audio `setParameters` call fires once per change, not every second (`app.js` ~1420).
- (pre-mortem) Compatibility: `test:network` loads one window from a bundle built at the `v0.8.0` tag: old host → new
  viewer gives stereo, new host → old viewer gives audio RMS above threshold, a republish and a glare case complete.
Likely failures:
- Munging the remote description on one side only.
Gate: no
Audit (9a0d3aa): transport patch sound (perfect negotiation, rollback, ICE restart, refused munge falls back,
idempotent markers); 0.7.x/0.8 peers unaffected; remote munge still needed. Decided (orchestrator, 2026-11-03, Aya: no
questions): the loss ladder keeps a 128 kbps floor (no 64k step), triggers only on congestion
(`qualityLimitationReason === 'bandwidth'` or `availableOutgoingBitrate` under ~1.5 Mbps), and is skipped when
"keep audio quality" is on; the "concealment lower than fixed 256k" and "≥90% of cap at 1500 kbps" lines are dropped
(CELT-mode Opus has no in-band FEC, and Chromium doesn't share bandwidth between audio and video without a field
trial); "keep audio quality" stays as a setting, documented as DSCP marking + encoder priority + no ladder cut.
`npm test` runs only `test/*.test.{js,mjs}` (it was also running old copies under `work/compat/`).
Evidence: 9a0d3aa + d60c6b4 (attempt 2 applied the audit decisions). Orchestrator reruns: `npm test` 448/448 (now only
`test/*.test.{js,mjs}`); `test:network` 49 PASS; `npm run test:compat` 8/8 against a v0.8.0 bundle (old host → new
viewer stereo 0.501 incl. 2 republishes, glare settles 336–569ms; new host → old viewer gets sound, mono as before).
Builder bench (3-run medians): viewer L/R separation 0 → 0.499 film and share, 0.50 after 2 republishes; audio
256 kbps, concealment 0% clean; `--loss 5` with keep-audio on stays 256 kbps, concealment 4.7–5.1%, 0 ladder steps;
`--link-kbps 500` keep-audio off steps once to the 128 kbps floor at ~26s; audio `setParameters` once per change.
Transport: `test/transport.test.mjs` glare at 9 timings + ICE restart over an unanswered offer, stable in <1s, no
resend. Decided (builder): loss injection by UDP relays in the bench (`scripts/bench-net.js`; the field trial did
nothing in Electron 44); ladder ignores the first 30s of a connection and a bandwidth limit only counts under a 3 Mbps
estimate. LOW: with keep-audio off, random loss can still look like congestion to libwebrtc and step to 128 kbps.
Waiting on: Aya's check (music-heavy film with Lenna).

### M1.7 Smooth, sharp video under real conditions [feel] [wire]
Status: in progress
Story: The picture stays smooth and as sharp as the connection allows, and recovers quickly after a hiccup.
Done when:
- Bench numbers for fps and frame-interval jitter at 24, 30 and 60fps films and a 60fps share, before and after.
- Hardware encoding confirmed in telemetry on Windows and Mac hosts; if the software encoder is in use, the reason
  is logged and fixed where possible.
- `chooseSendQuality`'s ladder reviewed against M1.2 data: recovery after a loss burst back to full quality within
  10s on a clean link (bench with injected loss).
- Keyframe requests after loss produce no freeze longer than 500ms on the bench.
- (Aya's other session, 2026-11-03) Rejoin black screen: on the v0.8.0 tag's Windows CI, `npm run test:network` once had
  a viewer in a persistent room (`connectedBefore: true`, reused connection) receive the host's audio but never video
  after leave/rejoin (`remote-video.readyState >= 3` timed out); the host logged `send-parameters-failed` ("Attempted
  to set RtpParameters with modified RTCP parameters") just before. Intermittent, Windows only, not new. Suspect
  `tuneSenders`/`setParameters` on parameters read before a renegotiation, rejected and never retried. Done when: a
  rejoin over a reused connection always gets video (repeat the rejoin step ≥20 times in a loop), and a rejected
  `setParameters` is retried with a fresh `getParameters()`.
- (orchestrator, 0.8.1 CI on macos-latest, 2026-11-03) Intermittent: `test:network` timed out waiting for every share
  tile to have a source and `__test.audioLevel() > 0.05`; the same commit passed on that runner an hour earlier. Find
  whether a tile's audio sometimes never starts (M1.5 changed share audio stamping), fix or make the check honest.
- (M1.11 builder) `test:network` and the bench leave `synced-network-test-*` / `synced-bench-*` folders (~300 MB each)
  in `%TEMP%` when a run fails; ~319 of them filled the disk (ENOSPC). Clean up on failure and on start.
- (M1.6 builder) Intermittent `test:network` player error: "Failed to set 'timestampOffset' on 'SourceBuffer': still
  processing appendBuffer or remove" (`renderer/player.mjs` seek race) at "playlist progress ≈ 8 s".
- (orchestrator) Intermittent `test:network` failures at "Timed out: __test.session.link?.receiver?.height === 360"
  (quality ladder, seen on old code too) and the playlist item menu `:popover-open` (`renderPlaylist` re-renders and
  closes the menu). Make both honest or fixed.
Gate: no
Progress (attempt 1, Sonnet; continued by a fresh builder): done — rejoin black screen (cadf4d8: stale peer stream
rebuilt from the receivers, `renderer/peer-stream.mjs`; `setParameters` re-read and retried, `sender-parameters.mjs`;
`--rejoin-loop` before: fails at 1, after: 75/76 then 0 failures), temp folders cleaned on pass/fail and stale ones on
start (da7c8f7), deterministic bench-net loss test (8469cdb), 0.8.2 Mac CI rejoin handshake timeout (88de987: after
`@_leave` only a presence frame may re-attach a peer for 5s; `--churn-loop` under load before 5 failures/~500, after
0/720), SourceBuffer `timestampOffset` race (b411068, `renderer/source-buffer.mjs` `whenIdle`) and honest waits for the
quality, ceiling and download-sound steps. Orchestrator reruns on b411068: `npm test` 479/479, `test:network` 51 PASS,
`test:compat` 10/10. Left: video smoothness (bench fps/jitter at 24/30/60 and a 60fps share, `venc` hardware check,
loss-burst recovery ≤10s, no freeze >500ms on keyframe requests); share-tile audio and playlist-popover flakes not
reproduced.
Evidence:

### M1.11 Second file silent for viewers [must-work] [wire]
Status: verified
Added: orchestrator, 2026-11-03, from the M1.6 builder's bench finding; confirmed real by the M1.6 audit. Built right
after M1.6's fixes by the same builder.
Story: When I open a second film in the same session, my friends hear it, not just see it.
Done when:
- Reproduced or ruled out: in the bench harness, `hostFile()` a second time gave the viewer no audio (the host's own
  tap heard it, its `captureStream` audio track had no signal), on v0.8.0, v0.8.1 and the M1.6 build. A plain
  `captureStream` probe re-captures fine, so it looks specific to the MediaSource pipeline (`renderer/player.mjs`,
  `publishStream`, the `loadedmetadata` republish).
- If real: fixed, and `test:network` (or the bench) opens a second and third file and asserts the viewer's received
  audio level is above threshold each time; also covers a playlist advance and a host change.
- If a harness artifact: the reason is written here and the bench handles it.
- (M1.6 audit, HIGH, real) Mechanism: `renderer/app.js:1320-1345` `publishStream` calls `video.captureStream()` again on
  every `loadedmetadata` (`app.js:4775`); capture #1's own `loadedmetadata` listener survives `unpublishStream`, runs
  after the page's, replaces capture #2's audio copy callback and fires `addtrack` on the old stream, which the page
  stops (`session.stream !== stream`), so the published audio track goes silent. Fix: one `captureStream()` per
  element, kept; publish `track.clone()`s and stop only the clones; existing `addtrack`/`removetrack` handling follows
  source changes. Bench: second `hostFile()` gives viewer beep RMS ≥ 0.1.
- (M1.11 audit, HIGH, pre-existing and worsened) Every publish adds m-sections that never go away (`pc.removeTrack`
  leaves the transceiver; a later `addTrack` never reuses it): measured in Electron 44, the renegotiation offer passes
  the 64 KiB receive budget for `@_signal` at file 7 (8 before this fix), which closes the connection to every viewer;
  with connection reuse it carries across rooms. Fix: `transceiver.stop()` in `drop` and in the patched
  `peer.removeStream`/`removeTrack` (measured: 5 m-sections, 19.8 KB at file 25), and `sender.replaceTrack(newClone)`
  for a source change instead of remove + add. Done when: `test:network` opens 10 files, asserts a bounded
  transceiver count, one live audio sender per peer and audio heard each time; `test:compat` passes (a 0.8.0 viewer
  sees an ended receiver track instead of a muted one).
- (audit, LOW) `unpublishStream` also calls `session.room.removeTrack(t)` for each published clone; with `sink` null
  the capture's `addtrack` listener stops new video tracks itself.
- (re-audit of 485a105, MEDIUM, confirmed in an Electron probe) Stopping a transceiver that was only in an unanswered
  offer, then a polite-side rollback on glare, leaves it stopped with no `mid`: endless `negotiationneeded`, and
  `addSender`'s idle search picks it (`direction = 'sendrecv'` throws), so every later film/share to that peer fails
  silently and connection reuse carries it across rooms. Fix: stop only once negotiated (`currentDirection != null &&
  !== 'sendrecv'`), else detach and stop on the next return to `stable`; `addSender` skips stopped transceivers; same
  rules in `stopSendersOf`; `test/transport.test.mjs` covers add → offer out → stop → colliding remote offer → rollback.
- (re-audit, LOW) Correct the `signal()` guard comments (rejecting offers keep their codec lines in Electron 44) and
  the `release`/`unpublishStream` comments (the room's `removeTrack` does find `addStream` senders); when `replaceTrack`
  fails for only some peers, fall back to `addTrack` for those peers only. Known LOW, not fixing: against 0.8.x
  sharers, detached `sendrecv` sections still build up slowly until both ends run this build.
Gate: no
Evidence: 05fa480 (attempt 1, Sonnet: one capture per element, clones), 485a105 (attempt 2, Sonnet: stop transceivers,
`replaceTrack` on a source change), eb574cf + 8412df7 (attempt 3, workflow-builder-strong: stop only negotiated
transceivers so a glare rollback can't leave a stuck one; never stop a detached one later, which had regressed the
0.8.0 glare). Orchestrator reruns on 8412df7: `npm test` 458/458; `npm run test:network` 49 PASS (one other run failed
at the pre-existing "height === 360" quality step, filed on M1.7), "after 11 files on one connection: 2 transceivers,
3 m-sections, offer 8.0–8.6 KB" (before: +~10 KB per file, over the 64 KiB `@_signal` budget at file 7);
`npm run test:compat` 10/10; new host → v0.8.0 viewer glare 5/5 (`check-compat.js --host=new --runs=5`, 343–348ms);
glare probe settles in 7 offers (v2: 280). Builder bench `--variant=reopen --publishes=10`: viewer beep RMS 0.354 and
stereo 0.50 after every file (before the fix: silence from file 2). Audits: 3 (HIGH SDP growth, MEDIUM glare
rollback, all fixed). Known, not fixed: the Chromium "RTP extension ID reassignment" glare when both ends add
different media kinds at the same mid in one round trip (CLAUDE.md); against 0.8.x sharers detached sections can
still build up slowly until both ends run this build.

### M1.12 Looped film goes silent for viewers [must-work]
Status: todo
Added: orchestrator, 2026-11-03, from the M1.7 builder (suspected, not proven).
Story: When I loop a film, my friends keep hearing it on every repeat.
Done when:
- Reproduced or ruled out: with Loop on, the host's captured stream ended up empty (`captured: []`, only the published
  video) after a couple of repeats; the `ended` handler (`renderer/app.js` ~4917) seeks back and plays without
  republishing, and M1.11 now keeps one `captureStream()` per element whose tracks may end on `ended`.
- If real: fixed, and `test:network` or the bench loops a short film ≥5 times asserting the viewer's audio level each
  repeat (and the "loop restarts must not look like pauses" rule in CLAUDE.md still holds).
- (milestone audit, MEDIUM) After a loop the capture's track list is empty, and `publishStream` builds only from it
  (`app.js:1453`) after unpublishing the clones that still carried sound, so a republish without a new file (a claim
  bump in `broadcastState`, `activatePreview`) sends no audio until the next file. Fix: carry the previous publish's
  live clone over when the capture has no live track of that kind; `test:network` loops twice, forces a republish and
  checks audio.
Gate: no
Evidence:

### M1.8 Real session review with Lenna [feel]
Status: todo
Story: Lenna and I watch something together with live telemetry on, and the worst three things we notice get fixed.
Done when:
- Lenna is on the new build with the checkbox on; a 30+ minute session (a film and a share) is captured.
- The scorecard and live view are reviewed; the top three problems are written up with evidence and fixed or filed
  as cards.
- Aya and Lenna confirm the difference.
Note (Aya's other session, 2026-11-03): Lenna was watching a hosted MOVIE FILE, not a screen share, so M1.5's share
timestamp fix isn't her cause. Start the review from the film path: the viewer's Web Audio output latency (M1.5's
video wait, +42 → +16.5ms on the bench) and film audio quality (captureStream audio → Opus, mono at the viewer: M1.6).
Gate: no
Evidence:

### Milestone audit (2026-11-03, code read while M1.7 ran)
- HIGH M1.12 had code (3b70980) but no card evidence or audit → attempt 2 (loop + republish) then item audit.
- HIGH 0.7.x never compat-tested against the M1 wire changes, nor 0.8.1/0.8.2 → orchestrator runs `test:compat` against
  v0.7.1 and v0.8.2 after M1.7.
- MEDIUM `scripts/session-report.js:172` uses `s.av` first (CLAUDE.md: unreliable) → use `s.off`, label `[off]`.
- MEDIUM CLAUDE.md lacks M1.7's ghost-attach patch, `peer-stream.mjs`, `sender-parameters.mjs`, `source-buffer.mjs`
  `whenIdle`, the new log events, and `s.off` in the field list → M1.7 builder.
- MEDIUM share A/V margin thin on the newest bench (run medians 68.6/16.7/32.4ms) → final `npm run bench` on final HEAD.
- LOW 2ms sample cost proven only on the dev machine → read `machine-sample.cost` from Lenna's log in M1.8.
- LOW a peer's mark note lands in the receiver's log and is uploaded if the receiver's box is on. Decided
  (orchestrator, Aya's "easy for development"): allowed; host logs already carry viewers' reports.
- M1.7 gets `[wire]` (ghost-attach changes which signals from other copies are honoured).

### Full sweep (2026-11-03, on b3d8abe/1096b69)
- `npm test` pass; `test:compat --tag=v0.8.0` 10/10 (glare 346ms); `npm run bench` (3 runs): film median +22ms (runs
  22/24.9/18.2, p95 70.3, worst 105), share +34.8ms (34.8/21.4/52.2, p95 42.2) — both within ±40ms on the median;
  `--variant=loop`: 7 repeats all heard (2/2 beeps, RMS 0.354), then a different film heard.
- `test:network` failed only at the 2ms host-sample cost gate (3.24ms) while another project's vitest/tsc runs loaded
  the machine; re-measure when quiet.
- `test:compat --tag=v0.7.1` and `--tag=v0.8.2` hung in the harness (old-tree prepare), not in the app → fixing.

## Aya's checks

1. **M1.5 film sync (with Lenna, after 0.8.1 installs):** both tick Settings → Having problems? → "Send telemetry for
   development". Host a film, watch 5 minutes, check dialogue matches lips. Optional: run
   `npm run diagnostics -- --live telemetry` and look at `s.off` in Lenna's `viewer-sample` lines (within about ±40).
2. **M1.5 share sync:** share a window that plays sound (open for over a minute first); check sound matches picture.
   If lips are off only on Bluetooth headphones, that's device latency the app can't see.
3. **M1.9 mark key:** in a room press X (a toast shows on both ends); press Shift+X, type a note, Enter. Afterwards
   `npm run diagnostics -- --report` lists both marks.
4. **M1.10 live view:** after your app updates to 0.8.1 (it relaunches on its own when you're not in a room), tick
   "Send telemetry for development", open a room, then run `npm run diagnostics -- --live` here: your own lines appear
   within about 3s.
5. **M1.6 stereo + M1.11 second film (after the next release):** host a music-heavy film with Lenna; ask whether it
   sounds wide (left and right differ) and clean. Then open a second film, and a third, in the same session: she
   should hear each one, not just see it.

## Later (filed from Aya's notes, not cards yet)

- Screen-share annotations drawn over the sharer's real screen (an overlay window), not only in the app.
- Download subtitles automatically from online sources, like Plex.
- Hide the controls when the mouse isn't over them, not only when the window loses focus.
- Text chat in the room.
- The sharer sees how much delay each viewer has.
- A Y2K-inspired theme with modern usability.
