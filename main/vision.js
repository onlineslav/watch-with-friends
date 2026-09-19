const {protocol, session} = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')

// The face filters need MediaPipe's WebAssembly runtime and its landmark model. Both are ordinary
// files, but a page loaded with loadFile() sits on file://, where Chromium refuses to fetch
// siblings — so they are served over their own scheme instead, the same way the YouTube player is.
//
// Nothing here is user-supplied: the file list is fixed, so a renderer cannot ask for anything else.

const ASSETS = {
  'vision_wasm_internal.js': 'text/javascript',
  'vision_wasm_internal.wasm': 'application/wasm',
  'face_landmarker.task': 'application/octet-stream',
}

const directory = () => path.join(__dirname, '..', 'renderer', 'vision')

// corsEnabled matters more than it looks: the window is loaded with loadFile(), so the page sits on
// file://, and Chromium refuses a cross-origin fetch to any scheme it does not consider CORS
// capable — without it every request here fails as a bare "Failed to fetch". The YouTube scheme
// needs none of this because a frame is navigated to it rather than fetched from script.
function prepareVision() {
  protocol.registerSchemesAsPrivileged([{scheme: 'svp-vision', privileges: {standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: false}}])
}

function registerVision(target = session.defaultSession) {
  target.protocol.handle('svp-vision', async (request) => {
    const url = new URL(request.url)
    const name = url.pathname.slice(1)
    if (url.hostname !== 'assets' || !Object.hasOwn(ASSETS, name)) return new Response('', {status: 404})
    try {
      return new Response(await fs.readFile(path.join(directory(), name)), {headers: {'Content-Type': ASSETS[name], 'Access-Control-Allow-Origin': '*'}})
    } catch {
      // The model is fetched after install rather than committed, so a missing file is a normal
      // state: the renderer turns the filters off and says why.
      return new Response('', {status: 404})
    }
  })

  // Face filters read the picture back out of the window to find faces in it. Only the app's own
  // top-level page may do that, and only of itself — never another window or the screen.
  target.setDisplayMediaRequestHandler((request, callback) => {
    if (request.frame && request.frame === request.frame.top) callback({video: request.frame})
    else callback()
  })
}

// Whether the assets are actually on disk, so the renderer can disable the filters up front instead
// of failing when someone picks one.
async function visionReady() {
  try {
    await Promise.all(Object.keys(ASSETS).map((name) => fs.access(path.join(directory(), name))))
    return true
  } catch {
    return false
  }
}

module.exports = {prepareVision, registerVision, visionReady}
