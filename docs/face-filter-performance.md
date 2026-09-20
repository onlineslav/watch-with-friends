# Realtime face filters

The bottleneck was the shared capture/tracking pipeline. Face map uses the same tracker as the
warping filters, but does almost no drawing work, making it a useful diagnostic.

## What was limiting it

- Detection had a 15 Hz timer that waited **another 66.7 ms after inference completed**. With a
  13 ms inference, even an otherwise idle machine could only deliver about 12.5 detections/s.
- `detectForVideo()` ran synchronously on the renderer thread, blocking overlay rendering and UI.
  The GPU delegate does not make that JavaScript call asynchronous. This is documented in the
  [MediaPipe web guide](https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker/web_js).
- YouTube capture polled full-resolution native bitmaps through IPC at 15 Hz, swapped BGRA to
  RGBA in JavaScript, and uploaded the pixels to a canvas. At 1536×864 that is 5.3 MB per frame
  before intermediate copies. Capture and detection had independent timers, adding stale frames.
- Drawing ran on animation frames, but repeatedly drew the same landmarks. There was smoothing
  on new detections, **no interpolation between detections**, despite an old comment saying otherwise.

## Implementation

`renderer/face-worker.mjs` owns MediaPipe, GPU/CPU fallback, downscaling and thumbnail readback.
`FaceTracker` transfers a `VideoFrame` when the presented video timestamp changes. Only one frame
can be in flight; slow inference skips old frames rather than queuing them. Results carry the
capture timestamp and a generation so stopped/replaced sources cannot restore stale faces.

YouTube uses a Chromium tab video stream of the sandboxed guest. Main validates ownership and
returns a short-lived token via
[`webContents.getMediaSourceId(requestWebContents)`](https://www.electronjs.org/docs/latest/api/web-contents#contentsgetmediasourceidrequestwebcontents).
The renderer requests `chromeMediaSource: 'tab'`, receives a normal video element, and uses it
for tracking and warp textures. The embedding window's filter overlay is excluded from capture.
Local files and incoming WebRTC video use the same worker directly.

Capture resolution follows the guest, capped at 1920×1080 with its aspect ratio preserved.
Chromium fixes the tab source's aspect ratio when capture starts: `applyConstraints()` cannot
reliably change it. Resize is debounced, then stops and reacquires the stream. Filter coordinates
cover the entire guest, including YouTube's letterboxing, so it is not applied twice.

Pausing a local video keeps its last face map visible without inferring duplicate frames.
Capture tracks stop when filters are disabled. The idle worker is retained for fast re-enabling;
`FaceTracker.close()` terminates it. Capture startup has deadlines and cleans up late streams.

## Measurements

Measured on this Windows machine with Electron 44.3.0 and the GPU delegate, using the user's
[YouTube test video](https://www.youtube.com/watch?v=DCqEdqxdDRE). Hidden 1280×800 test window,
1280×720 guest, 1536×864 capture at this display scale. Twelve-second samples after initialization
and a seek near the beginning. The original tracker and capture were also rerun from Git HEAD
with the same benchmark procedure. These are representative runs, not hardware-independent
performance guarantees; YouTube delivery and the exact shot timing can vary.

| Measurement | Original Face map | New Face map | New Chad |
| --- | ---: | ---: | ---: |
| Completed detections/s | 11.8 | 29.6 | 29.6 |
| Render callbacks/s | 26.9 | 29.7 | 29.7 |
| Inference median | 12.8 ms | 14.5 ms | 12.7 ms |
| Render interval, 95th percentile | 46.9 ms | 33.5 ms | 33.6 ms |
| Longest observed render interval | 992 ms | 100 ms | 100 ms |
| Draw work, 95th percentile | 0.2 ms | 0.2 ms | 2.5 ms |

Inference itself was already fast enough. Removing timer waits, renderer blocking and bitmap
transport lets the pipeline approach the approximately 30 Hz cadence observed in this harness.
The new worker round trip was about 14.6 ms median for Face map. This excludes native capture
delay and the wait until the next displayed overlay frame; it is not an end-to-end latency claim.

The report distinguishes detections from visible landmark updates. Shots with no detected face
still count as completed inferences. Held/fading faces do not represent new tracking results.
This change does not promise detection of every profile, distant face or brief shot, and does
not establish sustained 60 fps on every machine. Three-face tracking remains enabled.

## Reproduce

```powershell
npm run benchmark:filters
npm run benchmark:filters -- --filter=chad --seconds=12 --at=2
npm run benchmark:filters -- --video=DCqEdqxdDRE --filter=alien
npm test
npm run test:filters
npm run test:youtube
```

The benchmark uses an isolated profile, muted playback, the production modules and the app CSP.
It reports detection throughput, render intervals, inference/worker latency, visible face updates
and drawing cost. It requires internet access. `npm run bundle` builds both the renderer and the
packaged worker under `renderer/vision/`.

Regression checks cover one in-flight frame, duplicate-frame suppression, stale results after
source changes, pause/hold/fade, worker errors, closing during startup, actual worker inference
under the app CSP, filter pixels, guest-only capture, resize aspect ratio, and capture cleanup.

## Follow-up: reduce tracking lag

The next bottleneck was the smoothing response, even at an adequate detection rate. The previous
pose filter estimated velocity from its **filtered** position rather than its previous raw sample.
Its translation lead could overshoot when a person stopped, while size and head roll had slow
smoothing without that compensation. A size change took roughly a quarter second to settle.

The smoother now uses successive raw samples for velocity, adapts its cutoff more strongly to
motion, and measures translation/size motion relative to eye distance. Small faces and close-ups
therefore have comparable responsiveness. It retains damping at rest and removes the old lead
term. Expression smoothing is also faster. Histories reset after a tracking gap over 200 ms.
The tuning follows the speed/jitter tradeoff described by the
[One Euro filter authors](https://gery.casiez.net/1euro/).

Controlled trajectories compared with commit `45365b9`, using 478 landmarks, a 16:9 frame,
eye distance 0.2 in aspect-correct coordinates, at 30 and 60 samples/s:

| Tracking measurement | Before, 30 / 60 Hz | After, 30 / 60 Hz |
| --- | ---: | ---: |
| Mean horizontal error during steady motion, fraction of frame width | 0.00782 / 0.01074 | 0.00209 / 0.00209 |
| Maximum position error from the stop sample onward | 0.03190 / 0.03321 | 0.00209 / 0.00209 |
| Time to reach 90% of a 50% size increase | 267 / 217 ms | 33 / 17 ms |
| Time to reach 90% of a 0.5-radian head turn | 167 / 133 ms | 0 / 17 ms |

Motion advances 0.3 frame widths/s for 45 samples then stops; mean error uses samples 11–44.
The step tests change on sample 10 after a stationary warm-up. Zero milliseconds means the
first changed sample already reaches 90%; these figures measure **smoothing response**, not
camera-to-display latency. Regression tests cover these trajectories, smaller faces, jitter,
stopping without overshoot, and reacquisition.

Scheduling now uses video-frame callbacks, bootstraps the currently available frame (including
paused video), and immediately checks for a newer frame when the worker finishes. The one-frame
in-flight limit remains. Video callbacks follow presented video frames but are still subject to
browser compositing delay; they do not guarantee zero latency, as explained in the
[Chromium video callback guide](https://web.dev/articles/requestvideoframecallback-rvfc).

Face association now minimizes the total assignment cost across all three faces, using position,
aspect ratio and face size. Detection order cannot greedily steal the closest history from
another observation. This improves association; it is not identity recognition and cannot
guarantee identity through complete overlap or occlusion.

Seeking clears the overlay and invalidates pending results. On playing video, old faces fade
during an inference stall. A result over 200 ms old is discarded if the source frame changed;
an unchanged paused frame may still use it. `tracker.stats.discarded` counts these rejections.
This matters in practice: one follow-up live run exposed a 2.6-second inference outlier.

With the same live YouTube benchmark, a fresh pre-change Face map run measured 29.7 detections/s
and 29.7 render callbacks/s. Follow-up runs measured 29.5 / 29.6 for Face map and 29.6 / 29.6 for
Chad. Median landmark age at the first draw stayed around 33 ms; p95 was about 49–51 ms after
versus 33.5 ms in the pre-change run. Inference medians varied from 14.5 ms before to 16–17 ms
after, though the inference algorithm is unchanged. These live-service samples **do not show
an end-to-end latency or throughput improvement**. The established gain is the controlled
tracking response and handling of stale results. Further visual tuning on real motion remains
valuable; synthetic landmarks do not establish detection accuracy on real faces.

For a further performance pass, measure with a visible window and a known 60 fps moving-face
source. Separate source-frame age, inference time and display delay before changing models.
For directly owned camera/local/WebRTC sources, a frame-processing path before video-element
presentation is a candidate for removing a compositing wait. For YouTube, guest capture adds
another stage that this benchmark does not time. Bounded motion prediction is another candidate,
but needs stop/reversal/occlusion tests so it does not reintroduce overshoot. Neither is implemented
or claimed as a measured gain here.
