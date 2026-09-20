# Face filters — where this got to

Written for: the next Claude Code session picking this up. Everything below is uncommitted work in
the tree. Delete this folder when the work lands.

## State

| | |
|---|---|
| Local / shared video | Works. No seam, no halo, holds through detection misses. |
| YouTube filters | **Disabled** behind `canFilter()` in `renderer/app.js`, with a tooltip. |
| YouTube playback | Untouched. `npm run test:youtube` 4/4. |
| Tests | 172/172 unit, 3/3 `test:filters`, 4/4 `test:youtube`. |

## What changed in the tree

- `renderer/filters.mjs` — deformation rewritten as **Moving Least Squares**, solved **backwards**.
  `reach` replaces per-control `radius`. `grade` removed.
- `renderer/filter-gl.mjs` — backward mesh, premultiplied alpha, mesh cached per face.
- `renderer/faces.mjs` — unmatched faces are now **held and faded** instead of discarded.
- `test/filters.test.mjs` — rewritten for the new semantics.
- `scripts/check-*.js` — `setAudioMuted(true)` so test runs are silent. **Keep this.**
- `CLAUDE.md` — architecture notes updated.

## The YouTube bug, precisely

The renderer's texture *is* the captured window:

```js
filters.renderer.draw(source, ...)   // source = the capture, which already has our warp on it
```

So frame N shows the picture warped N times. `unwarpLandmarks` fixes the **landmark** half of the
loop — measured jaw width converges to 1.239 and stays — and does nothing about the pixels.

`loop-check.js` reproduces this deterministically in 20 rounds. The face becomes a featureless blob.
This was always broken; raising `reach` to 4 turned a slow smear into instant destruction.

**Composition does not fix it.** Sampling at `prevForward(newSource(v))` is the identity in steady
state, which means the canvas redraws its own previous contents forever and the face region freezes,
cut off from the live video. The capture *must* exclude our own drawing.

## Spikes already run — do not repeat these

1. `spike-webview.js` — `capturePage()` on a `<webview>` guest **excludes the embedder's overlay**.
   Guest green, covered in red, capture came back green. Also works while the window is minimized,
   which fixes the covered/minimized failures the `getDisplayMedia` route has.
2. `spike-msg.js` — `postMessage` works **both ways** through a webview, so the play/pause/seek sync
   channel does not need rewriting.
3. `spike-cost.js` — full-frame capture is **16.3ms** against a 66ms budget at 15Hz. Resizing or
   JPEG-encoding in main is *slower* than the capture; let the renderer downscale.

## The blocker

Swapping the iframe for `<webview>` in `YouTubePlayer.ensureFrame()` makes the player never signal
ready. `npm run test:youtube` fails all four. Adding `webviewTag: true` to the test windows did not
help, so it is the swap itself.

The swap that failed: `document.createElement('webview')`, `allowpopups=false`, explicit
`style.width/height` (a webview has no intrinsic size), `dom-ready` listener capturing
`getWebContentsId()`, and relaxing `receive()` from checking `source === frame.contentWindow` to
origin + token only (a webview's `contentWindow` is a proxy that does not compare equal; `token` is
what actually authenticates).

Candidate causes, cheapest first:

1. **The guest session has no `svp-youtube:` handler.** `registerYouTube()` registers on
   `session.defaultSession`; a webview may not share it. Test: load the URL in a webview and log
   whether the protocol handler is reached at all. This is the prime suspect.
2. **Embedder CSP** — `frame-src svp-youtube:` may not cover a webview guest.
3. **Hidden window** — webviews may not attach when the window is `show: false`, which is how
   `check-youtube.js` runs.

## Once the player is a webview

- Add an IPC capture: guest id + rect → `capturePage()` → raw bitmap. Validate the id belongs to
  this window's webview.
- `renderer/faces.mjs`: replace `captureElement` (getDisplayMedia/`cropTo`) with a canvas fed by
  those frames.
- **Delete the unwarp entirely** — `unwarpLandmarks`, `tracker.unwarp`, and their two tests. Clean
  frames mean there is nothing to undo.
- Re-enable YouTube in `canFilter()` and drop the tooltip.
- `main/vision.js`: the `setDisplayMediaRequestHandler` becomes dead.

## Still not built

The **contour layer**. The warp alone does not read as the intended look — that is settled by
experiment, not opinion. Lens Studio's equivalent is Face Mask: a texture painted once in the face
mesh's UV layout and sampled through the mesh, so it follows expression and head turn for free.
Hand-placed 2D lamps were tried and are a dead end (they are smudges that happen to be dark).

Also open: the warp is yaw/pitch blind. `outputFacialTransformationMatrixes` is currently off.

## Running the harnesses

They live here rather than `scripts/` because they are diagnostics, not tests. Each has a hardcoded
`ROOT` and expects `clip.mp4` beside it — fix both paths before running.

```sh
# the benchmark clip: first 12s of the video used throughout
yt-dlp --js-runtimes node --download-sections "*0-12" --force-keyframes-at-cuts \
  -f "bestvideo[height<=1080][ext=mp4]" -o clip.%(ext)s <url>

node scripts/electron.js devtools/face-filters/loop-check.js --at=8 --rounds=20
node scripts/electron.js devtools/face-filters/play-check.js --seconds=9
node scripts/electron.js devtools/face-filters/clip-check.js --times=2,8
node scripts/electron.js devtools/face-filters/clip-check.js --times=8 --label=205,425,187,411
```

- `loop-check.js` — reproduces the YouTube feedback loop offline. Jaw width per round + final frame.
- `play-check.js` — flashing. Reports blank frames, fade frames, cut detections, detection latency.
- `clip-check.js` — renders frames through the real renderer. `--label=` draws numbered landmark
  indices on a face crop, which is how the cheek-lamp indices got fixed (205/425 are beside the
  nose, not under the cheekbone — the hollow belongs at 187/411).

## Lessons that cost time

- Measure before theorising. Cut detection, detection latency and "MLS is too smooth" were all
  confidently wrong. The instrumentation found the real causes each time.
- The unit test that measures the grid border caught a 32px seam; the integration test's canvas
  coverage bound caught the mask painting over 59% of the screen. Both were regressions introduced
  during the port and neither was visible by eye.
