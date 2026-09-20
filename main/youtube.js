const {protocol, session, webContents} = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')

// Separate origin: YouTube's API scripts must never run alongside the renderer's IPC bridge.
function prepareYouTube() {
  protocol.registerSchemesAsPrivileged([{scheme: 'svp-youtube', privileges: {standard: true, secure: true, supportFetchAPI: true}}])
}

function registerYouTube(target = session.defaultSession) {
  target.protocol.handle('svp-youtube', async (request) => {
    const url = new URL(request.url)
    const files = {'/index.html': 'text/html', '/bridge.js': 'text/javascript'}
    if (url.hostname !== 'player' || !Object.hasOwn(files, url.pathname)) return new Response('', {status: 404})
    return new Response(await fs.readFile(path.join(__dirname, '../renderer/youtube', url.pathname.slice(1))), {
      headers: {'Content-Type': files[url.pathname]},
    })
  })
  // Desktop embeds have no HTTP referrer by default. Identify this app as required by YouTube.
  target.webRequest.onBeforeSendHeaders({urls: ['https://www.youtube.com/*']}, (details, callback) => {
    callback({requestHeaders: {...details.requestHeaders, Referer: 'https://app.watchwithfriends/'}})
  })
}

// The player runs in a <webview> so its pixels can be captured without this app's own overlay.
// A webview can otherwise be given a preload or node access by an attribute, so every attachment
// is stripped back to a plain sandboxed guest and only the player's own page may attach at all.
function guardWebviews(contents) {
  contents.on('will-attach-webview', (event, preferences, params) => {
    delete preferences.preload
    Object.assign(preferences, {nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true})
    if (!String(params.src || '').startsWith('svp-youtube://player/')) event.preventDefault()
  })
  // Remembering which guest belongs to which window is what lets captureGuest below refuse to
  // photograph anything but the caller's own player.
  contents.on('did-attach-webview', (_event, guest) => {
    guests.set(guest.id, contents)
    guest.once('destroyed', () => guests.delete(guest.id))
  })
}

const guests = new Map()

// The face filters read the YouTube picture back out of the player. Capturing the guest rather
// than the window is the point: the guest has never had this app's filter canvas drawn over it, so
// the detector measures the real face instead of one this app already warped.
//
// How the frame is taken matters as much as which surface it comes from. `capturePage()` asks the
// compositor to produce a frame on demand, and asking fifteen times a second makes the visible
// window blink — this is measured, not inferred: with the app alone the picture is steady, and a
// capturePage loop on either the window or the guest makes it flicker whether the video is playing
// or paused. That is the whole of the "the screen keeps flashing" report, and it only ever
// happened with a filter on, because nothing else reads the picture.
//
// A frame subscription takes the frames the compositor has already made instead, so nothing is
// forced and nothing flashes. `devtools/face-filters/app-flash-check.js --watch` is the harness
// that separated the two.
const feeds = new Map()

// A filter being switched off just stops the requests; nothing announces it. The subscription ends
// itself once nobody has asked for a frame in a while.
const FEED_IDLE_MS = 3000

function feedFor(guest) {
  const existing = feeds.get(guest.id)
  if (existing) return existing
  const feed = {image: null, at: Date.now(), timer: null}
  const stop = () => {
    clearInterval(feed.timer)
    if (feeds.get(guest.id) === feed) feeds.delete(guest.id)
    if (!guest.isDestroyed()) {
      try { guest.endFrameSubscription() } catch {}
    }
  }
  feeds.set(guest.id, feed)
  guest.beginFrameSubscription(false, (image) => (feed.image = image))
  guest.once('destroyed', stop)
  feed.timer = setInterval(() => {
    if (Date.now() - feed.at > FEED_IDLE_MS) stop()
  }, 1000)
  return feed
}

async function captureGuest(event, guestId) {
  if (!Number.isInteger(guestId) || guests.get(guestId) !== event.sender) return null
  const guest = webContents.fromId(guestId)
  if (!guest || guest.isDestroyed() || !guest.getURL().startsWith('svp-youtube://player/')) return null
  const feed = feedFor(guest)
  feed.at = Date.now()
  // Only when there is nothing at all to hand back. A surface that is not being composited —
  // paused, covered, minimized — produces no frames, and one forced capture seeds the feed; a
  // paused picture is then held, which is correct, because the held frame still is the picture.
  // Forcing one here cannot bring the flicker back: what flickered was doing it repeatedly, and
  // after the first frame this stops happening.
  if (!feed.image) {
    const forced = await guest.capturePage().catch(() => null)
    if (forced && !feed.image) feed.image = forced
  }
  const image = feed.image
  if (!image) return null
  const {width, height} = image.getSize()
  // toBitmap, not getBitmap: the buffer is serialized for IPC after this tick, and getBitmap's is
  // only valid within it.
  return width && height ? {width, height, bitmap: image.toBitmap()} : null
}

module.exports = {prepareYouTube, registerYouTube, guardWebviews, captureGuest}

// oEmbed supplies public titles without an API key. Keep requests bounded and URL construction local.
async function youTubeTitles(ids) {
  if (!Array.isArray(ids) || ids.length > 500 || !ids.every((id) => typeof id === 'string' && /^[\w-]{11}$/.test(id))) throw new Error('Invalid YouTube videos')
  const titles = new Array(ids.length)
  const deadline = AbortSignal.timeout(20000)
  let cursor = 0
  await Promise.all(Array.from({length: Math.min(6, ids.length)}, async () => {
    while (cursor < ids.length) {
      const index = cursor++
      if (deadline.aborted) break
      try {
        const response = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${ids[index]}`)}&format=json`, {signal: AbortSignal.any([deadline, AbortSignal.timeout(5000)])})
        if (!response.ok) continue
        const data = await response.json()
        if (typeof data.title === 'string') titles[index] = data.title.slice(0, 200)
      } catch {}
    }
  }))
  return ids.map((id, index) => titles[index] || `YouTube video (${id})`)
}
module.exports.youTubeTitles = youTubeTitles
