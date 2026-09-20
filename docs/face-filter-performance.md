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
