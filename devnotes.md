# Dev notes

Working scratchpad: what's broken, what's next, what's already shipped.
Face filter measurements live in `docs/face-filter-performance.md`; the
in-flight handoff is `devtools/face-filters/HANDOFF.md`.

## Do next

1. **B1** — playlist collapse shrinks the paused video. Reproducible, visual, likely a small layout fix.
2. **B2** — pausing a friend's YouTube video doesn't pause theirs. Breaks the core promise of the app.
3. **B3** — "connection unavailable, retrying" while both people are online.

---

## Bugs

Each one is a task: symptom, then what to check first.

### B1 — Collapsing the playlist shrinks the paused video

Self-hosted files. Collapse the drawer while paused and the picture goes tiny;
unpause and it snaps back to normal size.

- [ ] Reproduce with a local file, paused, drawer open then collapsed
- [ ] Check whether the stage relayout is driven by a frame callback rather than a resize —
      a paused `<video>` presents no frames, so nothing recomputes until playback resumes
- [ ] Look at `syncBoardLayout` / `pictureRect` and the `has-playlist` class on `#stage`
      (`renderer/app.js`, `renderer/playlist.mjs`, `renderer/styles.css`)
- [ ] Check whether **B6** (random shrinking mid-stream) is the same bug or a separate one

### B2 — Pausing a friend's YouTube video doesn't pause it for them

When the other person is hosting YouTube, a pause from the viewer side doesn't reach them.

- [ ] Confirm direction: does host-to-viewer pause work, and only viewer-to-host fail?
- [ ] Trace the `command` action through to the YouTube host path (`renderer/youtube.mjs`, `hostYouTube`)
- [ ] Compare with the file-hosting path, where viewer commands do apply
- [ ] Add it to `npm run test:network` if the gap is in command handling rather than the embed

### B3 — "Connection unavailable, retrying" while both people are online

Shown to both sides at once, so it's probably the warning's condition, not the connection.

- [ ] Capture the exact `connection.problem` / `network.error` values when it appears
- [ ] Check the banner condition at `renderer/app.js:2602` — `stale`, `health.level`, `network.error`
- [ ] Decide whether it's a false positive or a real transport stall the peers recover from

### B4 — Stuck on "Joining your friend's room, waiting for connection"

Joining through a friend invite never completes, or reports joining long after it has.

- [ ] Determine whether the room actually joins and only the label is stale
      (`role === 'idle' && session.connection.joining && !peerCount`)
- [ ] Check the friend-invite path specifically, against typing the code by hand
- [ ] Add a timeout that surfaces something actionable instead of waiting forever

### B5 — Stream randomly drops to ~240p for the viewer

Watching a friend's stream, quality collapses for a while and then recovers.

- [ ] Log `qualityLimitationReason` from the host and the viewer's receive stats around a drop
- [ ] Check the per-viewer bitrate/resolution ceilings in `renderer/sync.mjs` — are they
      ratcheting down on a transient and not coming back up?
- [ ] Check `tuneSenders` caps and whether the downscale above 1080p is over-triggering
- [ ] Related to the open question on who decides quality (below)

### B6 — The video randomly gets smaller mid-stream

Reported while watching a friend's stream. May be **B1** by another route, may be a
resolution change being treated as a layout change.

- [ ] First establish whether it's the *element* shrinking or the *stream* dropping resolution (**B5**)

---

## To do

### Player

- [ ] Don't show the resume prompt when the saved position is 0:00
- [ ] Verify the resume wording is "resume from `<timestamp>`", not "Resume `<filename>`"
- [ ] Split subs and dubs: one person watches subtitled, another dubbed.
      Subtitles are already per person; **audio is not** — one WebRTC stream serves
      everyone, so this needs a design, not a toggle
- [ ] Client-side buffering: let viewers cache ahead of the host so a bad connection
      doesn't cause hitches. See the open question — it may not be compatible with sync

### Chat

Every interaction with the video or playlist posts a line in a room chat.

- [ ] Chat panel and a `chat` room action (nothing exists today — `grep -ri chat renderer/` is empty)
- [ ] System lines: "Aya joined the room", "Aya left the room"
- [ ] System lines: "Aya paused the video", "Aya skipped to `<timestamp>`"
- [ ] Rate-limit and validate like `react`, per sender on both ends

### Debug

- [ ] Settings button that files debug info to the GitHub issues page, so a broken
      install can be reported in one click. Decide what's safe to include —
      no file paths, no room codes, no usernames

### Friends and profiles

- [ ] Set or upload a profile photo

### Reactions

- [ ] "bruh"
- [ ] "uwu"

### README

- [ ] Tagline candidates: *"It's like Nitro but free"*, *"subs for me, dubs for thee"*

---

## Face filters — reaching Snapchat-tier tracking

Ranked by payoff per hour. 1-4 need no new model, so they cannot cost realtime.
Measurements and the accuracy curve: `docs/face-filter-performance.md`.

### 1. Stop starving the model of pixels

`DETECT_SIZE` 768 shipped and doubled eye pixels on every shot. Remaining:

- [ ] Re-run the curve on a 1080p source with a genuine wide shot, to confirm the
      low-eye-pixel end on real footage rather than by downscaling
- [ ] Only then: two-stage crop pass, which is what rescues wide shots that 768
      still leaves under ~20 px. Second `FaceLandmarker` instance (VIDEO mode keeps
      per-stream state and needs monotonic timestamps, so do not share one)
- [ ] If ~26-34 ms doesn't fit the 33 ms budget: crop-pass the largest face only,
      or alternate faces between frames

### 2. Real 3D pose instead of an eye line

`facePose` gives roll, scale and position only, so a head at 30 degrees yaw still gets
a frontal warp and the deformation slides across the face as they turn.

- [ ] Turn on `outputFacialTransformationMatrixes` (currently `false`) and derive
      yaw/pitch/roll plus translation from the 4x4
- [ ] Extend `facePose`/`toLocal`/`toWorld` to carry out-of-plane rotation, keeping
      the existing face-units contract so filter tables don't change
- [ ] Attenuate `out` controls toward the silhouette in profile — a jaw widening of
      0.3 should shrink as the head turns, not stay 0.3
- [ ] Unit-test that a synthetic yawed head warps along the face, not across it

### 3. Constrain landmarks to a face-shaped subspace (the "locked on" feel)

478 points smoothed independently means noise the filter doesn't catch reads as
surface wobble. Every published stabilization result constrains to a model instead.

- [ ] Weak-perspective Procrustes fit of the landmarks to MediaPipe's canonical mesh
- [ ] Split: rigid fit is pose, residual is expression; smooth residuals in model
      space rather than per-point in image space
- [ ] Reject residuals the model can't explain instead of low-passing them
- [ ] Pure maths — fully unit-testable, no video needed

### 4. Bounded motion prediction

Landmarks are ~33 ms old at draw (p95 ~50 ms) and the lead term was removed, so the
filter is correct but late — which looks identical to bad tracking.

- [ ] Constant-velocity prediction on the *pose* only, landmarks following it
- [ ] Tests for stop, reversal and occlusion so the old overshoot cannot return
- [ ] Prediction horizon derived from measured landmark age, not a constant

### 5. Later — only after 1-4 land

- [ ] Lucas-Kanade flow on ~20 landmarks between inferences: full-frame-rate updates
      at near-zero model cost (how classic trackers hit 60 Hz without 60 Hz inference)
- [ ] Evaluate 3DDFA-V2 via its LiteRT build — same TFLite runtime the worker already
      uses; 7.2 ms CPU / 2.1 ms GPU reported, dense 3D, NME 3.51
- [ ] Remove the YouTube capture stage from the latency path
- [ ] Re-benchmark with a visible window and a known 60 fps moving-face source,
      separating source-frame age, inference time and display delay

---

## Open questions

- **Who decides stream quality, the host or the viewer?** Currently both: the host sets
  send caps (`tuneSenders`) and per-viewer ceilings (`sync.mjs`), while the viewer grows
  its own jitter buffer (`telemetry.mjs`). Worth writing down which one wins, because
  **B5** is probably an argument between them.
- **Can viewers buffer ahead of the host at all?** A viewer that caches future media is no
  longer watching a live WebRTC stream. It would need a different transport for the media
  with the sync layer on top. Big change — decide whether it's worth it before starting.
- **Splitting subs and dubs** needs per-viewer *audio*, which the single captured stream
  can't provide. Multiple audio senders? Host-side per-viewer transcode? Neither is cheap.

---

## Done

Confirmed in the code, kept here so the list doesn't get re-litigated.

### Player

- [x] Hide the top menu and sidebar while playing
- [x] Per-viewer subtitles — each watcher picks their own track, or none
- [x] Synced loop button (`#loop`, **L**)
- [x] "Video" renamed to "media" throughout; all media types supported
- [x] Open media takes several files at once, straight into the playlist (`multiSelections`)
- [x] Translucent file name over the picture while paused (`#paused-title`)
- [x] Remembers where you left the last file (`RoomHistory` per-item progress)
- [x] Volume button mutes and restores the previous volume (`unmutedVolume`, **M**)
- [x] Left arrow jumps back 10 s, right arrow forward 30 s (`renderer/app.js:3484`)

### Room

- [x] Persistent rooms that remember playlist, progress, cursor and settings across days
- [x] Ping and connection telemetry beside each person's name
- [x] Reactions: air horn, golf clap, quack, confetti overlay
- [x] Communal whiteboard: shared board, per-person show/hide, pen, colours, 4 brush sizes,
      clear, eraser

### Friends and profiles

- [x] Unique username (hashed ID) for adding friends — changing it means friends re-add you
- [x] Changeable display name, separate from the username
- [x] Add friends by username
- [x] See which friends are online and hosting rooms
- [x] Ask to join a friend's room

### Face filters

- [x] Curve script `scripts/landmark-curve.js` — deterministic, any local file
- [x] Measured the cost of `DETECT_SIZE` 384 to 768: +2.8 ms inference median
      (16.2 to 19.0), p95 and throughput unchanged
- [x] Shipped `DETECT_SIZE` 768

### Naming

- [x] **Watch With Friends** — chosen over watch3gether, syncplayer, mediasync,
      syncplay, witchparty, Coplayer
