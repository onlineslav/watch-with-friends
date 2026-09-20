# Face filters — where this got to

Written for: the next Claude Code session picking this up. Everything below is uncommitted work in
the tree. Delete this folder when the work lands.

## State

| | |
|---|---|
| Local / shared video | Works. No seam, no halo, holds through detection misses. |
| YouTube filters | **Re-enabled.** The player is a `<webview>` and the filter reads its guest. |
| YouTube playback | `npm run test:youtube` 4/4 on the webview, under the real renderer CSP. |
| Tests | 170/170 unit (the two unwarp tests are gone), 4/4 `test:youtube`, 6/6 `test:filters`. |

## What changed in the tree

- `renderer/filters.mjs` — deformation is **Moving Least Squares**, solved **backwards**.
  `reach` replaces per-control `radius`. `grade` removed. `unwarpLandmarks` **deleted**.
- `renderer/filter-gl.mjs` — backward mesh, premultiplied alpha, mesh cached per face.
- `renderer/faces.mjs` — unmatched faces are held and faded. `captureElement` (getDisplayMedia +
  `cropTo`) replaced by `captureGuest`, which pulls frames from the player's webview over IPC.
- `renderer/youtube.mjs`, `renderer/youtube/bridge.js` — iframe → `<webview>`, plus the attach
  handshake below.
- `main/youtube.js` — `guardWebviews` (strips preload/node from any guest, allows only
  `svp-youtube://player/`) and `captureGuest` (`capturePage()` on a guest the caller owns).
- `main/vision.js` — the `setDisplayMediaRequestHandler` is gone; nothing captures the window now.
- `scripts/check-filters.js` — captures a synthetic guest instead of the window. No longer needs a
  visible window or the `--capture` flag, because `capturePage()` on a guest works either way.
- `scripts/check-*.js` — `setAudioMuted(true)` so test runs are silent. **Keep this.**

## The blocker, solved

It was never the protocol handler, the CSP or the hidden window. `spike-guest.js` loads the real
player page in a webview and reports all three: the handler is reached for `/index.html` and
`/bridge.js`, the page loads, `YT` is defined, and the embedder still hears nothing.

The cause is one line. `bridge.js` sent everything with `parent.postMessage`. In a `<webview>` the
guest is a **top-level document**, so `parent === window` and `ready` was posted to itself.

The fix is an attach handshake, because a top-level guest has no reference to its embedder until
one speaks first:

- `youtube.mjs` posts `{command: 'attach'}` to `frame.contentWindow` on `dom-ready`.
- `bridge.js` pins `event.source` as `host` on the first message and flushes what it queued.
  One-shot events (`ready`, `error`, `blocked`) queue; periodic `state` reports are dropped, since
  another follows in 250ms.
- `receive()` in `youtube.mjs` now authenticates on **origin alone**. A webview's `contentWindow` is
  a proxy that never compares equal to `event.source`, and `svp-youtube://player` can only be served
  by our own handler.

## Scheme registration order matters

`prepareYouTube()` must be called **before** `prepareVision()`, exactly as `main/main.js` does it.
Registering them the other way round makes every `svp-vision://` fetch fail with a bare
"Failed to fetch" and the landmarker never loads. Two separate `registerSchemesAsPrivileged` calls
do both keep their `standard`/`secure` privileges (measured), so it is `corsEnabled` specifically
that does not survive being registered second. `scripts/check-filters.js` now matches main's order.

## The CSP was refusing the webview's own stylesheet

Reported as "the screen just keeps flashing", with no filter running and the video blinking under
YouTube's own UI. Electron's `<webview>` injects a stylesheet into the embedding page to lay its
guest out, and `style-src 'self'` refused it, so the guest was placed by a rule that never applied.
`renderer/index.html` now carries that stylesheet's sha256.

It did not reproduce here, on three harnesses — a bare page, a page with the whiteboard canvas over
the player, and `app-flash-check.js`, which is the real renderer in a visible window playing a real
video. All three were steady. What they did all report was the refusal, in the console, which is
what a blocked policy looks like: the page keeps working and only looks wrong.

`scripts/check-youtube.js` now fails on any policy violation, because the hash is per Electron
version and an upgrade that changes it should be a failing test rather than a flickering picture.

## `style-src 'self'` drops inline style attributes

This cost a debugging round and will again. The app's policy has no `'unsafe-inline'`, so a
`style="width:640px"` attribute is discarded **silently**: no console error, the element simply has
no size. A `<webview>` has no intrinsic size either, so it falls back to something the player never
had — 873x150 for what should have been 640x360 — and since `aspect = videoWidth / videoHeight` is
what every landmark is measured against, the whole warp lands in the wrong place while every other
check still passes.

The app was never affected: `.youtube-player webview` is styled from `styles.css`, which `'self'`
allows. It was `scripts/check-filters.js` that built its page from style attributes, and the old
self-capture checks were opt-in behind `--capture`, so nothing had ever run them under the real
policy. The check now serves its own stylesheet and asserts both the element's size and the guest's
own view, so losing either fails loudly instead of quietly moving the filter.

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

- `spike-guest.js` — loads the real player page in a webview and reports where the chain breaks.
- `flash-check.js` — a real video in a real webview on a bare page. `--board` adds the whiteboard
  canvas over it, `--iframe` is the before-and-after.
- `app-flash-check.js` — the real renderer, real styles and real room logic in one visible window,
  playing a real video. Samples the window and the guest side by side.
- `loop-check.js` — reproduced the feedback loop the old window capture had. Kept as the proof of
  what capturing the guest avoids; it no longer describes how the app works.
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
