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

### M1.1 Live telemetry stream [must-work]
Status: in progress
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
Likely failures:
- Durable Object WebSocket hibernation not used, so idle sockets cost requests all day.
- Reconnect loop hammering the Worker when it's down (rate limit is 10/min per IP).
- Lines logged before identity is known have no username.
Decided: Cloudflare Durable Objects (free plan, SQLite-backed) hold the live sockets; GitHub stays the archive.
Out of scope: a web dashboard.
Gate: no
Evidence:

### M1.2 Comprehensive measurements
Status: in progress
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
Evidence:

### M1.3 Session scorecard and release comparison
Status: todo
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
Evidence:

### M1.4 Automated A/V sync and audio benchmark [must-work]
Status: todo
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
Likely failures:
- Measuring at the wrong point: the offset must include the Web Audio output path, or it hides the suspected bug.
- A flaky harness: report spread across 3 runs.
Gate: no
Evidence:

### M1.5 Audio in sync with the picture [feel]
Status: todo
Story: When I host, my friends hear the sound exactly when they see it, for films and screen shares.
Done when:
- `npm run bench` shows |offset| ≤ 40ms (median) for a film and a share, and the before/after numbers are on the card.
- The fix accounts for the viewer's Web Audio output latency (delay video by it, or play audio on a path WebRTC's
  lip-sync knows about), keeps volume control and reaction sounds working, and keeps captions aligned (their delay
  math uses the video delay).
- Live telemetry from a real session shows the offset field stays near zero.
- Aya check: watch a film with Lenna; dialogue matches lips.
Likely failures:
- Delaying video by the output latency while `jitterBufferTarget` also moves: the two must not double-count.
Gate: no
Evidence:

### M1.6 Audio quality end to end [wire] [feel]
Status: todo
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
Likely failures:
- Munging the remote description on one side only.
Gate: no
Evidence:

### M1.7 Smooth, sharp video under real conditions [feel]
Status: todo
Story: The picture stays smooth and as sharp as the connection allows, and recovers quickly after a hiccup.
Done when:
- Bench numbers for fps and frame-interval jitter at 24, 30 and 60fps films and a 60fps share, before and after.
- Hardware encoding confirmed in telemetry on Windows and Mac hosts; if the software encoder is in use, the reason
  is logged and fixed where possible.
- `chooseSendQuality`'s ladder reviewed against M1.2 data: recovery after a loss burst back to full quality within
  10s on a clean link (bench with injected loss).
- Keyframe requests after loss produce no freeze longer than 500ms on the bench.
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
Gate: no
Evidence:

## Later (filed from Aya's notes, not cards yet)

- Screen-share annotations drawn over the sharer's real screen (an overlay window), not only in the app.
- Download subtitles automatically from online sources, like Plex.
- Hide the controls when the mouse isn't over them, not only when the window loses focus.
- Text chat in the room.
- The sharer sees how much delay each viewer has.
- A Y2K-inspired theme with modern usability.
