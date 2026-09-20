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

// The player runs in a <webview> so tab capture can stream it without this app's own overlay.
// A webview can otherwise be given a preload or node access by an attribute, so every attachment
// is stripped back to a plain sandboxed guest and only the player's own page may attach at all.
function guardWebviews(contents) {
  contents.on('will-attach-webview', (event, preferences, params) => {
    delete preferences.preload
    Object.assign(preferences, {nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true})
    if (!String(params.src || '').startsWith('svp-youtube://player/')) event.preventDefault()
  })
  // Remembering which guest belongs to which window is what lets captureGuest below refuse to
  // capture anything but the caller's own player.
  contents.on('did-attach-webview', (_event, guest) => {
    guests.set(guest.id, contents)
    guest.once('destroyed', () => guests.delete(guest.id))
  })
}

const guests = new Map()

// Register a short-lived tab-capture token for the caller's own player. Chromium transports
// video frames directly to its <video>; full-resolution bitmaps no longer cross IPC each tick.
// Capturing the guest alone also excludes the face-filter overlay in the embedding window.
async function captureGuest(event, guestId) {
  if (!Number.isInteger(guestId) || guests.get(guestId) !== event.sender) return null
  const guest = webContents.fromId(guestId)
  if (!guest || guest.isDestroyed() || !guest.getURL().startsWith('svp-youtube://player/')) return null
  return guest.getMediaSourceId(event.sender)
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
