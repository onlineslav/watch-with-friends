// A whole-app share: every window the app has open (the latest cleaned win-app-windows layout) is
// captured on its own, and app-share-worker.mjs draws them together the way they sit on screen
// into a MediaStreamTrackGenerator. A window capture shows the window's own content even where
// something covers it, so another app's window on top neither hides part of the share nor leaks
// into it; only the gaps between the app's windows are black.
//
// This side only starts and stops captures (getDisplayMedia exists only here) and hands each
// capture's frame stream, the output's writable and every layout to the worker, so no frame ever
// touches the page's main thread. `captureWindow(hwnd)` resolves with a capture track for one
// window; `anchor` is the shared window's hwnd and `initial` its capture if already started (not
// while it's minimized: Windows can't capture a minimized window, so it starts once it's
// restored, and the worker shows a card until then); `subscribe(fn)` calls `fn` with each new layout. Untested here for the same reason frames.mjs is: the frame APIs only
// exist in a real renderer.
import {captureChanges} from './app-share.mjs'

// A window that couldn't be captured isn't tried again for this long.
const RETRY_MS = 5000
// A window whose capture ended on its own (it closed, almost always) gets this long first.
const ENDED_RETRY_MS = 1000
// How often captures of windows gone for good are let go, between layout changes.
const SWEEP_MS = 1000

export function appShareTrack({getLayout, subscribe, captureWindow, anchor, initial, limits, workerUrl = 'app-share-worker.js', onCaptureError, onStats, onCrop, onShowing}) {
  if (typeof MediaStreamTrackProcessor !== 'function' || typeof MediaStreamTrackGenerator !== 'function' || typeof Worker !== 'function') return null
  const generator = new MediaStreamTrackGenerator({kind: 'video'})
  const worker = new Worker(workerUrl)
  const captures = new Map() // hwnd → {track, seen}
  const pending = new Set() // hwnds whose capture is starting
  const failed = new Map() // hwnd → when its capture last failed
  let queue = Promise.resolve()
  let stopped = false

  worker.onmessage = ({data}) => {
    if (data.type === 'ended') {
      captures.get(data.hwnd)?.track.stop()
      captures.delete(data.hwnd)
      // A capture usually ends because its window closed, a moment before the layout says so:
      // wait for the layout to catch up rather than recapture a window that's gone.
      failed.set(data.hwnd, performance.now() - RETRY_MS + ENDED_RETRY_MS)
    } else if (data.type === 'size') {
      // getSettings() on a generated track has no size; tuneSenders reads this instead.
      generator.frameSize = {width: data.width, height: data.height}
    } else if (data.type === 'stats') {
      onStats?.(data)
    } else if (data.type === 'crop') {
      onCrop?.(data)
    } else if (data.type === 'showing') {
      onShowing?.(data.kind)
    }
  }
  worker.onerror = (event) => onCaptureError?.(null, new Error(event.message || 'The share\'s worker failed'))

  const watch = (hwnd, track) => {
    captures.set(hwnd, {track, seen: performance.now()})
    const {readable} = new MediaStreamTrackProcessor({track})
    worker.postMessage({type: 'window', hwnd, readable}, [readable])
  }

  const drop = (hwnd) => {
    const entry = captures.get(hwnd)
    if (!entry) return
    captures.delete(hwnd)
    worker.postMessage({type: 'drop', hwnd})
    entry.track.stop()
  }

  // One at a time: main grants each getDisplayMedia call exactly one window, in order.
  const start = (hwnd) => {
    pending.add(hwnd)
    queue = queue.then(async () => {
      try {
        if (stopped) return
        const track = await captureWindow(hwnd)
        if (stopped) return track.stop()
        failed.delete(hwnd)
        watch(hwnd, track)
      } catch (error) {
        failed.set(hwnd, performance.now())
        onCaptureError?.(hwnd, error)
      } finally {
        pending.delete(hwnd)
      }
    })
  }

  function reconcile(layout) {
    if (stopped) return
    const now = performance.now()
    for (const win of layout.windows) {
      const entry = captures.get(win.hwnd)
      if (entry) entry.seen = now
    }
    const known = new Map([...captures].map(([hwnd, entry]) => [hwnd, entry.seen]))
    for (const hwnd of pending) known.set(hwnd, now)
    const {start: wanted, stop: gone} = captureChanges(known, layout, now)
    for (const hwnd of wanted) if (!(now - (failed.get(hwnd) ?? -Infinity) < RETRY_MS)) start(hwnd)
    for (const hwnd of gone) drop(hwnd)
  }

  const onLayout = (layout) => {
    if (stopped) return
    worker.postMessage({type: 'layout', layout})
    reconcile(layout)
  }
  const unsubscribe = subscribe(onLayout)
  const sweep = setInterval(() => reconcile(getLayout()), SWEEP_MS)

  function stop() {
    if (stopped) return
    stopped = true
    clearInterval(sweep)
    unsubscribe?.()
    for (const hwnd of [...captures.keys()]) drop(hwnd)
    worker.postMessage({type: 'stop'})
    // The worker closes the writable; if it's already gone, nothing else holds the generator open.
    setTimeout(() => worker.terminate(), 1000)
  }

  // Settings' resolution and frame rate, applied live: the output size, and how often it's drawn.
  function setLimits(next) {
    worker.postMessage({type: 'limits', limits: {...next}})
    for (const {track} of captures.values()) track.applyConstraints({frameRate: {ideal: next.frameRate, max: next.frameRate}}).catch(() => {})
  }

  const {writable} = generator
  worker.postMessage({type: 'start', writable, anchor, limits: {...limits}, layout: getLayout()}, [writable])
  if (initial) watch(initial.hwnd, initial.track)
  reconcile(getLayout())
  // A share of a minimized window starts with the card straight away rather than nothing.
  worker.postMessage({type: 'layout', layout: getLayout()})
  return {track: generator, stop, setLimits}
}
