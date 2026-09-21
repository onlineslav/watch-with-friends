
Video Screen - Open Media or Enter Link

sometimes the video randomly gets smaller (was watching friend's stream)

- was watching a stream my friend put on - sometimes it would go down to like 240p for me... how come? 

add loop button (synced)
change word 'video' to 'media' and allow all media types.

# TODO

- the middle open media button can add multiple files instead of just one (they go into the playlist)
don't say "Resume <filename> just say resume from timestamp. When paused, show the name of the file on top of the screen (like in Plex or VLC) - make it translucent, more opaque as you hover over it.
- don't do the resume prompt if it's at 0:00

bug: says connection unavailable retrying for both me and my friend (we're both online)

Says Joining your friend's room waiting for connection

- split subs and dubs i.e: one person can watch subs and another dubs

Names
watch3gether
syncplayer
mediasync
syncplay
watch3gether
witchparty

Watch With Friends

- bruh, uwu, air horn

watch3gether

syncplay

Coplayer - Watch Media Together

- right arrow jumps forward 30s, left arrow jumps back 10s

- q: is there a way for the client to like... buffer/cache videos that the host uploads/plays so that if one client has shit internet, they don't get hickups, and the playback between host and client remain really well synced with no dropouts or delays or latency or whatever

- it remembers where you closed it on the last file 

- you can start or end rooms/lobbies sort of like a group on discord. when you open that lobby or room the playlist/playback of whatever media, etc. is all persistent and it remembers everyone's settings/subtitles, everything so you can close the session and restart it another day with literally zero work.

- clicking on the volume button should mute the audio. clicking it again should restore the audio to the previous volume.

## Player

- [x] Hide the top menu and sidebar while playing
- [x] Per-viewer subtitles: each watcher picks their own subtitle track (or none)

## Room

- [x] Show ping and connection telemetry beside each person's name
- [x] Reactions
  - [x] Air horn
  - [x] Golf clap
  - [x] Quack
  - [x] Confetti overlay across the screen
- [x] Communal whiteboard
  - [x] Shared board everyone in the room draws on
  - [x] Toggle to show or hide it for yourself
  - [x] Pen tool
  - [x] Simple colour picker
  - [x] Brush size (4 settings)
  - [x] Clear board button
  - [x] Eraser

## Friends and profiles

- [x] Unique username (hashed ID) for adding friends
  - Changing it means friends have to re-add you
- [x] Changeable display name, separate from the username
- [x] Add friends by username
- [ ] Set or upload a profile photo
- [x] See which friends are online and hosting rooms
- [x] Ask to join a friend's room

## Face filters — reaching Snapchat-tier tracking

Ranked by payoff per hour. 1–4 need no new model, so they cannot cost realtime.
Background and measurements: `docs/face-filter-performance.md`.

### 1. Stop starving the model of pixels

MediaPipe is two-stage by design: find the face, then run landmarks *on a tight
crop*. We downscale the whole frame to `DETECT_SIZE` (384) first, so the landmark
stage gets a thumbnail of the face.

**Measured** with `npm run curve` on CNN anchor footage, 640x360, 150 frames.
Error is deviation from the native-resolution detection, in face units (1 unit =
eye-corner distance), so it is directly comparable to filter displacements, which
are ~0.3:

| Detected at | Eye distance | Median error | p95 |
| --- | ---: | ---: | ---: |
| 640x360 (native) | 56.4 px | reference | reference |
| 512x288 | 45.1 px | 0.0024 | 0.0054 |
| **384x216 (what we ship)** | **33.8 px** | **0.0038** | **0.0080** |
| 288x162 | 25.4 px | 0.0108 | 0.0210 |
| 192x108 | 16.9 px | 0.0151 | 0.0300 |
| 128x72 | 11.3 px | 0.0295 | 0.0561 |

Read the curve by **eye distance in pixels, not by scale factor**. The whole-frame
downscale normalizes to `DETECT_SIZE`, so eye pixels depend only on how big the
face is in the frame - a 1080p source and a 360p source with the same framing give
the landmark stage exactly the same pixels. Source resolution is irrelevant.

- The knee is at ~25-34 px of eye distance. Above it, error is sub-pixel and the
  crop pass would buy nothing. Below it, error triples and then triples again.
- This anchor is a close-up: eyes are 8.8% of frame width, giving 33.8 px at 384.
  We are sitting just above the knee on the *easiest* possible shot.
- A normal medium or wide shot has a face a third that size -> ~11-17 px of eye
  distance -> 0.015-0.030 error, i.e. 5-10% of a filter's own displacement,
  varying frame to frame. That is the swim.

So item 1 is worth building, but the cheap fix covers most of it:

- [x] Curve script: `scripts/landmark-curve.js`, deterministic, any local file
- [x] Measured cost of `DETECT_SIZE` 384 -> 768: +2.8 ms inference median
      (16.2 -> 19.0), p95 and throughput unchanged
- [x] Ship `DETECT_SIZE` 768. It doubles eye pixels for every shot and the curve
      says that is worth roughly one knee-step of accuracy. Cheapest win available.
- [ ] Re-run the curve on a 1080p source with a genuine wide shot to confirm the
      low-eye-pixel end of the curve on real footage rather than by downscaling
- [ ] Only then: two-stage crop pass, which is what rescues wide shots that 768
      still leaves under ~20 px. Second `FaceLandmarker` instance (VIDEO mode keeps
      per-stream state and needs monotonic timestamps, so do not share one).
- [ ] If ~26-34 ms does not fit the 33 ms budget: crop-pass the largest face only,
      or alternate faces between frames

### 2. Real 3D pose instead of an eye line

`facePose` gives roll, scale and position only, so a head at 30° yaw still gets a
frontal warp and the deformation slides across the face as they turn.

- [ ] Turn on `outputFacialTransformationMatrixes` (currently `false`) and derive
      yaw/pitch/roll plus translation from the 4x4
- [ ] Extend `facePose`/`toLocal`/`toWorld` to carry out-of-plane rotation, keeping
      the existing face-units contract so filter tables don't change
- [ ] Attenuate `out` controls toward the silhouette in profile — a jaw widening of
      0.3 should shrink as the head turns, not stay 0.3
- [ ] Unit-test that a synthetic yawed head warps along the face, not across it

### 3. Constrain landmarks to a face-shaped subspace (the "locked on" feel)

We smooth 478 points independently, so noise the filter doesn't catch reads as
surface wobble. Every published stabilization result constrains to a model instead.

- [ ] Weak-perspective Procrustes fit of the landmarks to MediaPipe's canonical mesh
- [ ] Split: rigid fit is pose, residual is expression; smooth residuals in model
      space rather than per-point in image space
- [ ] Reject residuals the model can't explain instead of low-passing them
- [ ] Pure maths — fully unit-testable, no video needed

### 4. Bounded motion prediction

Landmarks are ~33ms old at draw (p95 ~50ms) and the lead term was removed, so the
filter is correct but late — which looks identical to bad tracking.

- [ ] Constant-velocity prediction on the *pose* only, landmarks following it
- [ ] Tests for stop, reversal and occlusion so the old overshoot cannot return
- [ ] Prediction horizon derived from measured landmark age, not a constant

### 5. Later — only after 1–4 land

- [ ] Lucas-Kanade flow on ~20 landmarks between inferences: full-frame-rate updates
      at near-zero model cost (how classic trackers hit 60Hz without 60Hz inference)
- [ ] Evaluate 3DDFA-V2 via its LiteRT build — same TFLite runtime the worker already
      uses; 7.2ms CPU / 2.1ms GPU reported, dense 3D, NME 3.51
- [ ] Remove the YouTube capture stage from the latency path
- [ ] Re-benchmark with a visible window and a known 60fps moving-face source,
      separating source-frame age, inference time and display delay
