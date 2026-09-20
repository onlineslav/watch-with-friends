// Real WebRTC and application code; discovery normally uses local IPC.
// --public-discovery checks Nostr with different room startup orders instead.
// Hidden windows use disposable identities and loopback media connections.
const {app, BrowserWindow, ipcMain} = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {pathToFileURL} = require('node:url')
const {execFileSync} = require('node:child_process')
const esbuild = require('esbuild')
const {prepareYouTube, registerYouTube} = require('../main/youtube')
prepareYouTube()
const checkYouTube = process.argv.includes('--youtube')

const root = path.resolve(__dirname, '..')
const publicDiscovery = process.argv.includes('--public-discovery')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'synced-network-test-'))
app.setPath('userData', path.join(temporary, 'profile'))
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const run = (win, source) => win.webContents.executeJavaScript(source).catch((error) => { throw new Error(`${error.message}\nExecuting: ${source}`) })
async function until(win, condition, timeoutMs = publicDiscovery ? 90000 : 15000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await run(win, condition)) return
    await pause(100)
  }
    console.error(await run(win, `JSON.stringify({friends:__test.friendNetwork.list(), role:__test.session.role, peers:[...__test.session.peers], remote:__test.session.remote, connection:__test.session.connection, video:{ready:document.getElementById('remote-video').readyState, frames:document.getElementById('remote-video').getVideoPlaybackQuality().totalVideoFrames}, streams:[...__test.session.peerStreams].map(([id, entry]) => ({id, claimedAt:entry.claimedAt, tracks:entry.stream.getTracks().map(t => ({kind:t.kind, muted:t.muted, state:t.readyState}))})), errors:__test.errors})`))
  assert.fail(`Timed out: ${condition}`)
}

async function fixtures() {
  const subscriptions = new Map()
  ipcMain.on('test:subscribe', (event, topic, active) => {
    const topics = subscriptions.get(event.sender) || new Set()
    if (active) topics.add(topic)
    else topics.delete(topic)
    subscriptions.set(event.sender, topics)
  })
  ipcMain.on('test:publish', (event, topic, message) => {
    for (const [contents, topics] of subscriptions) {
      if (contents !== event.sender && !contents.isDestroyed() && topics.has(topic)) contents.send('test:signal', topic, message)
    }
  })
  fs.writeFileSync(path.join(temporary, 'preload.js'), fs.readFileSync(path.join(root, 'main/preload.js'), 'utf8') + `
    const subscriptions = new Map();
    ipcRenderer.on('test:signal', (_event, topic, message) => {
      for (const handler of subscriptions.get(topic) || []) handler(topic, message);
    });
    contextBridge.exposeInMainWorld('__signal', {
      subscribe(topic, handler) {
        if (!subscriptions.has(topic)) subscriptions.set(topic, new Set());
        subscriptions.get(topic).add(handler);
        ipcRenderer.send('test:subscribe', topic, true);
        return () => {
          subscriptions.get(topic)?.delete(handler);
          if (!subscriptions.get(topic)?.size) ipcRenderer.send('test:subscribe', topic, false);
        };
      },
      publish: (topic, message) => ipcRenderer.send('test:publish', topic, message),
    });
  `)
  const source = fs.readFileSync(path.join(root, 'renderer/app.js'), 'utf8') + `
    window.__test = {
      get session() { return session }, get identity() { return identity },
      friendNetwork, enterRoom, leaveRoom, hostFile, control, receiveImage, shownImage, selectSubtitle,
      primeDiscovery: (kind) => joinRoom({...network.config(), appId: APP_ID}, kind + ':startup-probe'),
      addToPlaylist, playItem, playNext, playable, orderedItems, moveInPlaylist, removeFromPlaylist, refreshAvailability, setPlaylistOpen,
      get history() { return roomHistory },
      audioState: () => ({running: audio?.state === 'running', connected: Boolean(remoteAudio)}),
      audioLevel: () => {
        if (!output || !audio) return 0;
        if (!__test.analyser) {
          __test.analyser = audio.createAnalyser();
          output.connect(__test.analyser);
        }
        const samples = new Float32Array(__test.analyser.fftSize);
        __test.analyser.getFloatTimeDomainData(samples);
        return Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
      },
      replaceCapturedAudio: (event) => {
        const captured = session.captured;
        const old = captured.getAudioTracks()[0];
        const replacement = old.clone();
        // Model capture replacing its track during a media pipeline reset. Scripted
        // mutations need explicit events; browser-driven changes fire these themselves.
        old.stop();
        captured.removeTrack(old);
        if (event === 'ended') old.dispatchEvent(new Event('ended'));
        else captured.dispatchEvent(new MediaStreamTrackEvent('removetrack', {track: old}));
        captured.addTrack(replacement);
        captured.dispatchEvent(new MediaStreamTrackEvent('addtrack', {track: replacement}));
      },
      getState: hostState, youtube, selfId, errors: [],
    };
    window.addEventListener('error', (e) => __test.errors.push(e.message));
    window.addEventListener('unhandledrejection', (e) => __test.errors.push(String(e.reason)));
  `
  await esbuild.build({stdin: {contents: source, resolveDir: path.join(root, 'renderer')}, bundle: true, format: 'iife', target: 'chrome130', outfile: path.join(temporary, 'bundle.js'), plugins: [{
    name: 'local-discovery', setup(build) {
      build.onResolve({filter: /^trystero$/}, () => ({path: 'trystero', namespace: 'local'}))
      build.onLoad({filter: /.*/, namespace: 'local'}, () => ({resolveDir: root, contents: publicDiscovery ? `
        import {joinRoom as join, selfId} from './node_modules/@trystero-p2p/nostr/dist/index.mjs';
        export {selfId};
        export const joinRoom = (config, code, callbacks) => join({...config,
          _test_only_mdnsHostFallbackToLoopback: true,
        }, code, callbacks);
      ` : `
        import {createTopicStrategy, selfId} from './node_modules/@trystero-p2p/core/dist/index.mjs';
        const join = createTopicStrategy({
          init: () => [{}], steadyAnnounceIntervalMs: 1000,
          subscribeTopic: (_relay, topic, handler) => window.__signal.subscribe(topic, handler),
          publishTopic: (_relay, topic, message) => window.__signal.publish(topic, message),
        });
        export {selfId};
        export const joinRoom = (config, code, callbacks) => join({...config,
          rtcConfig: {iceServers: []}, turnConfig: [], _test_only_mdnsHostFallbackToLoopback: true,
        }, code, callbacks);
      `}))
    },
  }]})
  const html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8')
    .replace('href="styles.css"', `href="${pathToFileURL(path.join(root, 'renderer/styles.css'))}"`)
  fs.writeFileSync(path.join(temporary, 'index.html'), html)
  if (publicDiscovery) return {}
  const video = path.join(temporary, 'sample.mp4')
  execFileSync(require('ffmpeg-static'), ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440', '-f', 'lavfi', '-i', 'sine=frequency=880', '-map', '0:v', '-map', '1:a', '-map', '2:a', '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=jpn', '-t', '30', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', video], {windowsHide: true, timeout: 15000})
  fs.writeFileSync(path.join(temporary, 'sample.srt'), '1\n00:00:00,000 --> 00:00:20,000\nShared test caption\n')
  const sound = path.join(temporary, 'sound.m4a')
  execFileSync(require('ffmpeg-static'), ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '30', '-c:a', 'aac', sound], {windowsHide: true, timeout: 15000})
  const picture = path.join(temporary, 'picture.png')
  execFileSync(require('ffmpeg-static'), ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:size=64x64', '-frames:v', '1', picture], {windowsHide: true, timeout: 15000})
  return {video, picture, sound}
}

app.whenReady().then(async () => {
  const windows = []
  const watchdog = setTimeout(() => { console.error('Network integration check timed out'); app.exit(1) }, publicDiscovery || checkYouTube ? 240000 : 120000)
  try {
    const {video, picture, sound} = await fixtures()
    require('../main/main').registerIpc()
    ipcMain.removeHandler('net:ice-servers')
    ipcMain.handle('net:ice-servers', () => [])
    for (const name of ['alpha', 'bravo', 'charlie']) {
      const win = new BrowserWindow({show: false, webPreferences: {partition: `network-${name}`, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required', preload: path.join(temporary, 'preload.js')}})
      // Muted at the output only. The Web Audio graph is untouched, so audioLevel() still
      // measures what is being played; it just does not come out of the speakers.
      win.webContents.setAudioMuted(true)
      windows.push(win)
      if (checkYouTube) registerYouTube(win.webContents.session)
      win.webContents.on('console-message', (details) => {
        if (details.level === 'error' || publicDiscovery && details.level === 'warning') console.error(`${name}: ${details.message}`)
      })
      await win.loadFile(path.join(temporary, 'index.html'))
      await until(win, 'window.__test && !document.getElementById("welcome").hidden')
      if (publicDiscovery && name !== 'bravo') await run(win, `__test.primed = __test.primeDiscovery(${JSON.stringify(name === 'alpha' ? 'presence' : 'persistent')}); true`)
      await run(win, `document.getElementById('handle').value=${JSON.stringify(name)}; document.getElementById('welcome-name').value=${JSON.stringify(name)}; document.getElementById('welcome-form').dispatchEvent(new Event('submit', {cancelable:true}));`)
      await until(win, '__test.friendNetwork.identity && !document.getElementById("home").hidden')
    }
    const [a, b, c] = windows
    const names = await Promise.all(windows.map((win) => run(win, '__test.identity.username')))
    await run(a, `__test.friendNetwork.add(${JSON.stringify(names[1])})`)
    await until(b, '__test.friendNetwork.requests.size === 1')
    await run(b, `__test.friendNetwork.add(${JSON.stringify(names[0])})`)
    await Promise.all([a, b].map((win) => until(win, '__test.friendNetwork.online.size === 1')))
    console.log(`PASS: Signed friend request, acceptance and presence via ${publicDiscovery ? 'public Nostr relays' : 'local discovery'} and real WebRTC`)

    const joinAll = () => Promise.all(windows.map((win) => run(win, '__test.enterRoom("ABCDEFGH")')))
    const connected = () => Promise.all(windows.map((win) => until(win, '__test.session.peers.size === 2')))
    await run(a, '__test.enterRoom("ABCDEFGH", {joining:false})')
    assert.equal(await run(a, 'document.getElementById("room-name").value'), "alpha's Room")
    await run(a, `
      if (document.getElementById('room').classList.contains('people-open')) document.getElementById('people-toggle').click();
      document.getElementById('people-toggle').click();
    `)
    assert.equal(await run(a, 'document.getElementById("room-name").checkVisibility()'), true)
    assert.equal(await run(a, '__test.session.peers.size'), 0)
    await run(a, `document.getElementById('room-name').value='  Movie   Night  '; document.getElementById('room-name-form').requestSubmit();`)
    assert.equal(await run(a, 'document.getElementById("room-name").value'), 'Movie Night')
    await run(a, `document.getElementById('room-name').value='   '; document.getElementById('room-name-form').requestSubmit();`)
    assert.equal(await run(a, 'document.getElementById("room-name").value'), 'Movie Night')
    console.log('PASS: Couch shows the default room name before anyone joins; edits save and blank names preserve it')
    await Promise.all([b, c].map((win) => run(win, '__test.enterRoom("ABCDEFGH")')))
    await connected()
    await Promise.all([b, c].map((win) => until(win, 'document.getElementById("room-name").value === "Movie Night"')))
    await run(b, `document.getElementById('room-name').value='Film Club'; document.getElementById('room-name-form').requestSubmit();`)
    await Promise.all([a, c].map((win) => until(win, 'document.getElementById("room-name").value === "Film Club"')))
    console.log('PASS: New arrivals receive the saved room name and subsequent edits synchronize')
    console.log('PASS: Three authenticated room participants connect while friends remain online')
    if (publicDiscovery) {
      await run(b, '__test.leaveRoom()')
      await until(a, '__test.session.peers.size === 1')
      await run(b, '__test.enterRoom("ABCDEFGH")')
      await connected()
      for (const win of windows) assert.deepEqual(await run(win, '__test.errors'), [])
      console.log('PASS: Public discovery connects across presence-first, friends-first and media-first startup, including rejoining')
      return
    }
    await run(a, `__test.hostFile(${JSON.stringify(video)})`)
    await Promise.all([b, c].map((win) => until(win, '__test.session.role === "viewer" && document.getElementById("remote-video").getVideoPlaybackQuality().totalVideoFrames > 12')))
    await until(b, '__test.session.clock !== null')
    await Promise.all([b, c].map((win) => until(win, '__test.audioState().running && __test.audioState().connected')))
    await Promise.all([b, c].map((win) => until(win, '__test.audioLevel() > 0.01')))
    console.log('PASS: Both viewers receive moving video and clock synchronization')
    await until(b, '__test.session.remote.subtitles.length === 1')
    assert.equal(await run(b, 'JSON.stringify(__test.session.remote.subtitles).includes("external:")'), false)
    await run(b, '__test.selectSubtitle(__test.session.remote.subtitles[0].value)')
    await until(b, '__test.session.captions.cues.some(cue => cue.text.includes("Shared test caption"))')
    console.log('PASS: Sidecar subtitle cues transfer through opaque track IDs')
    await run(b, '__test.control("pause")')
    await until(a, 'document.getElementById("local-video").paused')
    await until(c, '__test.session.remote.playing === false')
    await run(b, '__test.control("seek", 10)')
    await until(c, 'Math.abs(__test.session.remote.time - 10) < 1')
    await run(b, '__test.control("play")')
    await until(a, '!document.getElementById("local-video").paused')
    console.log('PASS: Viewer pause, seek and resume reach the host and other viewer')
    for (const track of [1, 0, 1, 0]) {
      await run(b, '__test.control("pause")')
      await until(a, 'document.getElementById("local-video").paused')
      await Promise.all([b, c].map((win) => until(win, '__test.audioLevel() < 0.001')))
      await run(b, `__test.control('audio', __test.session.remote.audio[${track}].value)`)
      await until(a, `__test.getState().audioSelected === __test.getState().audio[${track}].value && document.getElementById('local-video').readyState >= 3`)
      await run(b, '__test.control("play")')
      await Promise.all([b, c].map((win) => until(win, '__test.audioLevel() > 0.01')))
    }
    console.log('PASS: Both viewers receive audible samples after repeated paused English/Japanese switches')
    for (const event of ['removetrack', 'ended']) {
      await run(b, '__test.control("pause")')
      await until(a, 'document.getElementById("local-video").paused')
      await Promise.all([b, c].map((win) => until(win, '__test.audioLevel() < 0.001')))
      await run(a, `__test.replaceCapturedAudio(${JSON.stringify(event)})`)
      assert.equal(await run(a, '__test.session.stream.getAudioTracks().length'), 1)
      await run(b, '__test.control("play")')
      await Promise.all([b, c].map((win) => until(win, '__test.audioLevel() > 0.01 && document.getElementById("remote-video").srcObject.getAudioTracks().length === 1')))
    }
    console.log('PASS: Replaced capture audio removes the old sender and remains audible for both viewers')
    await run(c, `__test.hostFile(${JSON.stringify(video)})`)
    await until(a, '__test.session.role === "viewer" && document.getElementById("remote-video").readyState >= 2')
    await until(b, '__test.session.peerStreams.get(__test.session.hostId)?.claimedAt === __test.session.remote.claimedAt')
    console.log('PASS: Host takeover attaches the stream for the new media revision')
    await run(c, `__test.hostFile(${JSON.stringify(path.join(temporary, 'missing.mp4'))})`)
    await Promise.all([a, b].map((win) => until(win, 'Boolean(__test.session.remote?.error) && document.getElementById("spinner").hidden')))
    console.log('PASS: A failed host file reaches both viewers as a terminal error')
    await run(c, `__test.hostFile(${JSON.stringify(picture)})`)
    await Promise.all([a, b].map((win) => until(win, 'Boolean(__test.shownImage())')))
    await run(b, `const current=__test.session.images.get(__test.session.hostId); __test.receiveImage(new Uint8Array([0]),__test.session.hostId,{id:String(current.claimedAt-1),claimedAt:current.claimedAt-1,mime:'image/png'}); if (__test.shownImage() !== current) throw Error('Stale image replaced current image');`)
    console.log('PASS: Full image transfer and stale-image rejection')
    await run(c, `__test.hostFile(${JSON.stringify(sound)})`)
    await Promise.all([a, b].map((win) => until(win, '__test.session.remote?.audioOnly && __test.session.lastInbound?.packetsReceived > 0 && __test.audioState().connected')))
    console.log('PASS: Audio-only playback and packet telemetry after video/image switches')
    for (let i = 0; i < 2; i++) {
      await Promise.all(windows.map((win) => run(win, '__test.leaveRoom()')))
      await joinAll()
      await connected()
    }
    await Promise.all([a, b].map((win) => until(win, '__test.friendNetwork.online.size === 1')))
    await Promise.all(windows.map((win) => run(win, '__test.leaveRoom()')))
    await run(a, '__test.enterRoom("RESTORE1", {joining:false})')
    ipcMain.removeHandler('dialog:media-files')
    ipcMain.handle('dialog:media-files', () => [video])
    for (const selector of ['#empty [data-open-media]', '#playlist-add']) {
      await run(a, `document.querySelector(${JSON.stringify(selector)}).click()`)
      await until(a, 'document.getElementById("local-video").readyState >= 2 && !__test.session.openingMedia')
      assert.equal(await run(a, 'document.getElementById("local-video").paused'), true)
      assert.ok(await run(a, 'document.getElementById("local-video").currentTime < 0.1'))
      assert.equal(await run(a, 'getComputedStyle(document.getElementById("empty")).display'), 'none')
      if (selector.includes('empty')) {
        await run(a, '__test.removeFromPlaylist(__test.session.playing.id)')
        await Promise.all(windows.map((win) => until(win, '__test.session.role === "idle"')))
      }
    }
    console.log('PASS: Local files added from the player or empty sidebar load paused at zero and dismiss the empty player')
    await run(a, '__test.control("play")')
    await until(a, 'document.getElementById("local-video").readyState >= 3')
    await run(a, '__test.control("pause"); __test.control("seek", 7.25)')
    await until(a, 'Math.abs(document.getElementById("local-video").currentTime - 7.25) < 0.1')
    const savedVideo = await run(a, '__test.session.playing.id')
    await run(a, `__test.playItem(__test.addToPlaylist([${JSON.stringify(video)}])[0].id)`)
    await until(a, 'document.getElementById("local-video").readyState >= 3 && !__test.session.openingMedia')
    await run(a, '__test.removeFromPlaylist(__test.session.playing.id)')
    await until(a, `__test.session.playing?.id === ${JSON.stringify(savedVideo)} && !__test.session.openingMedia && Math.abs(document.getElementById("local-video").currentTime - 7.25) < 0.1`)
    assert.equal(await run(a, 'document.getElementById("local-video").paused'), true)
    assert.equal(await run(a, 'getComputedStyle(document.querySelector("#empty [data-open-media]")).display'), 'none')
    console.log('PASS: Removing a playing video loads the previous video paused at its remembered timestamp')
    await run(a, '__test.leaveRoom()')
    assert.ok(Math.abs(await run(a, '__test.history.load("RESTORE1").observed.time') - 7.25) < 0.1)
    await run(a, '__test.enterRoom("RESTORE1")')
    await until(a, '__test.session.preview && document.getElementById("local-video").readyState >= 2')
    assert.equal(await run(a, 'document.getElementById("local-video").paused && !__test.session.stream'), true)
    assert.ok(Math.abs(await run(a, 'document.getElementById("local-video").currentTime') - 7.25) < 0.1)
    await run(b, '__test.enterRoom("RESTORE1")')
    await until(a, '__test.session.peers.size === 1')
    await pause(1200)
    assert.equal(await run(b, '__test.session.role'), 'idle', 'a preview must not publish itself to the room')
    await run(a, '__test.control("play")')
    await until(b, 'document.getElementById("remote-video").readyState >= 3')
    assert.equal(await run(a, '__test.session.preview'), false)
    await run(a, '__test.control("pause"); __test.control("seek", 9)')
    await until(a, 'Math.abs(document.getElementById("local-video").currentTime - 9) < 0.1')
    await run(a, '__test.leaveRoom()')
    await run(b, `__test.hostFile(${JSON.stringify(video)})`)
    await until(b, 'document.getElementById("local-video").readyState >= 3')
    const liveClaim = await run(b, '__test.session.claimedAt')
    await run(a, '__test.enterRoom("RESTORE1")')
    await until(a, '__test.session.role === "viewer" && !__test.session.preview && document.getElementById("remote-video").readyState >= 3')
    assert.equal(await run(b, '__test.session.claimedAt'), liveClaim, 'returning previews cannot take over a live host')
    console.log('PASS: Reopening restores the last video paused at its saved timestamp; Play shares it and existing hosts take precedence')
    for (const win of windows) assert.deepEqual(await run(win, '__test.errors'), [])
    console.log('PASS: Two leave/rejoin cycles retain friends and produce no renderer exceptions')

    await Promise.all(windows.map((win) => run(win, '__test.leaveRoom()')))
    await run(a, '__test.enterRoom("PERSIST1", {joining:false})')
    await Promise.all([b, c].map((win) => run(win, '__test.enterRoom("PERSIST1")')))
    await connected()
    await run(a, `document.getElementById('room-name').value='Weekly movies'; document.getElementById('room-name-form').requestSubmit()`)
    const playlistIds = []
    for (const win of windows) {
      playlistIds.push(await run(win, `__test.addToPlaylist([${JSON.stringify(video)}])[0].id`))
      await Promise.all(windows.map((peer) => until(peer, `__test.session.playlist.items.size === ${playlistIds.length}`)))
    }
    await Promise.all(windows.map((win) => until(win, '[...__test.session.playlist.items.values()].every(__test.playable)')))
    for (const [win, id, seconds] of [[a, playlistIds[0], 8], [b, playlistIds[1], 12]]) {
      await run(win, `__test.playItem(${JSON.stringify(id)})`)
      await until(win, 'document.getElementById("local-video").readyState >= 3')
      await run(win, `__test.control('pause'); __test.control('seek', ${seconds})`)
      await Promise.all(windows.map((peer) => until(peer, `Math.abs((__test.session.playlist.progress.get(${JSON.stringify(id)})?.time ?? -100) - ${seconds}) < 0.5`)))
    }
    await run(a, `__test.moveInPlaylist(${JSON.stringify(playlistIds[2])}, 0)`)
    await Promise.all(windows.map((win) => until(win, `__test.orderedItems(__test.session.playlist)[0].id === ${JSON.stringify(playlistIds[2])}`)))
    const oldPeerIds = await Promise.all(windows.map((win) => run(win, '__test.selfId')))
    const staleRoom = await run(a, '__test.history.load("PERSIST1") && localStorage.getItem(__test.history.prefix + "PERSIST1")')
    await Promise.all(windows.map((win) => run(win, '__test.leaveRoom()')))
    await Promise.all(windows.map((win) => until(win, `Boolean(document.querySelector('.saved-room-open[data-code="PERSIST1"]'))`)))
    // Reload every renderer: transport IDs change, local identity and saved room
    // data must survive. No live peer remains to supply a forgotten playlist.
    await Promise.all(windows.map((win) => win.loadFile(path.join(temporary, 'index.html'))))
    await Promise.all(windows.map((win) => until(win, 'window.__test && __test.friendNetwork.identity && !document.getElementById("home").hidden')))
    for (let i = 0; i < windows.length; i++) {
      assert.notEqual(await run(windows[i], '__test.selfId'), oldPeerIds[i])
      assert.equal(await run(windows[i], '__test.identity.username'), names[i])
      assert.equal(await run(windows[i], '__test.history.load("PERSIST1").details.name'), 'Weekly movies')
      assert.equal(await run(windows[i], '__test.history.load("PERSIST1").ownFiles.size'), 1)
    }
    await run(a, `document.querySelector('.saved-room-open[data-code="PERSIST1"]').click()`)
    await until(a, '__test.session.code === "PERSIST1" && __test.session.availableFiles.size === 1')
    assert.deepEqual(await run(a, '__test.orderedItems(__test.session.playlist).map(item => item.id)'), [playlistIds[2], playlistIds[0], playlistIds[1]])
    assert.equal(await run(a, 'document.querySelectorAll(".playlist-item.missing").length'), 2)
    assert.equal(await run(a, 'document.querySelectorAll(".playlist-item.missing .playlist-play:disabled").length'), 2)
    assert.ok(await run(a, 'document.getElementById("playlist-items").textContent.includes("Unavailable")'))
    await run(a, '__test.setPlaylistOpen(true); if (document.getElementById("room").classList.contains("people-open")) document.getElementById("people-toggle").click()')
    await run(a, 'document.getAnimations().forEach(animation => animation.finish())')
    assert.ok(await run(a, 'document.getElementById("playlist").getBoundingClientRect().width >= 220'))
    assert.ok(Math.abs(await run(a, `__test.session.playlist.progress.get(${JSON.stringify(playlistIds[1])}).time`) - 12) < 0.5)
    await run(a, '__test.control("play")')
    await until(a, '__test.session.role === "host" && document.getElementById("local-video").currentTime >= 7.5 && document.getElementById("local-video").readyState >= 3')
    await run(a, '__test.control("pause")')
    console.log('PASS: All three copies retain room name, playlist order and per-item progress after everyone leaves and restarts; Resume skips offline owners')
    await Promise.all([b, c].map((win) => run(win, `document.querySelector('.saved-room-open[data-code="PERSIST1"]').click()`)))
    await connected()
    await Promise.all(windows.map((win) => until(win, '[...__test.session.playlist.items.values()].every(__test.playable)')))
    await run(a, `__test.moveInPlaylist(${JSON.stringify(playlistIds[2])}, 2)`)
    await Promise.all(windows.map((win) => until(win, `__test.orderedItems(__test.session.playlist)[2].id === ${JSON.stringify(playlistIds[2])}`)))
    await run(b, '__test.leaveRoom()')
    await until(a, '__test.session.peers.size === 1 && document.querySelectorAll(".playlist-item.missing").length === 1')
    await until(b, `document.querySelector('.saved-room-open[data-code="PERSIST1"] .saved-room-members')?.textContent === 'In room: alpha, charlie'`)
    assert.equal(await run(b, '__test.session.room'), null, 'watching presence must not join the media room')
    assert.equal(await run(b, 'document.getElementById("saved-room-items").textContent.includes("PERS-IST1")'), false)
    assert.equal(await run(b, 'document.getElementById("saved-rooms").textContent.includes("Return to a room")'), false)
    console.log('PASS: Saved room cards hide codes and show live occupants, including non-friends, without joining the room')
    await run(a, '__test.control("seek", 29); __test.control("play")')
    await until(c, `__test.session.role === 'host' && __test.session.playing?.id === ${JSON.stringify(playlistIds[2])} && document.getElementById('local-video').readyState >= 3`)
    console.log('PASS: Ending playback skips an offline owner’s item and starts the next available owner’s media')
    await run(a, `__test.playItem(${JSON.stringify(playlistIds[0])})`)
    await until(a, '__test.session.role === "host" && !document.getElementById("local-video").paused')
    await until(c, '__test.session.role === "viewer" && __test.session.remote.playing')
    await run(a, '__test.leaveRoom()')
    await until(b, `document.querySelector('.saved-room-open[data-code="PERSIST1"] .saved-room-members')?.textContent === 'In room: charlie'`)
    await until(c, `__test.session.role === 'host' && __test.session.playing?.id === ${JSON.stringify(playlistIds[2])} && !__test.session.openingMedia && document.getElementById('local-video').readyState >= 3`)
    console.log('PASS: When the active host leaves, remaining viewers skip unavailable items and continue with an available owner')
    await run(c, '__test.control("pause"); __test.control("seek", 6)')
    await until(c, 'Math.abs(document.getElementById("local-video").currentTime - 6) < 0.5')
    await run(c, '__test.leaveRoom()')
    await until(b, `document.querySelector('.saved-room-open[data-code="PERSIST1"] .saved-room-members')?.textContent === 'No one connected'`)
    // Reopen an older copy, start playback, then reunite it with a newer saved
    // history. Subsequent playback must still issue winning progress updates.
    await run(a, `localStorage.setItem(__test.history.prefix + 'PERSIST1', ${JSON.stringify(staleRoom)}); __test.enterRoom('PERSIST1')`)
    await until(a, '__test.session.availableFiles.size === 1')
    await run(a, `__test.playItem(${JSON.stringify(playlistIds[0])})`)
    await until(a, '__test.session.role === "host" && document.getElementById("local-video").readyState >= 3')
    await run(a, '__test.control("pause")')
    await run(c, '__test.enterRoom("PERSIST1")')
    await until(a, '__test.session.peers.size === 1')
    await until(a, `__test.session.playlist.progress.get(${JSON.stringify(playlistIds[2])})?.time >= 5.5`)
    await run(a, '__test.control("seek", 4)')
    await Promise.all([a, c].map((win) => until(win, `Math.abs((__test.session.playlist.progress.get(${JSON.stringify(playlistIds[0])})?.time ?? 100) - 4) < 0.5`)))
    console.log('PASS: A stale saved copy merges newer offline history and continues saving fresh playback progress')
    const vanished = path.join(temporary, 'vanished.mp4')
    fs.copyFileSync(video, vanished)
    const vanishedId = await run(a, `__test.addToPlaylist([${JSON.stringify(vanished)}])[0].id`)
    await until(c, `__test.session.playlist.items.has(${JSON.stringify(vanishedId)}) && __test.playable(__test.session.playlist.items.get(${JSON.stringify(vanishedId)}))`)
    fs.unlinkSync(vanished)
    await run(a, '__test.refreshAvailability()')
    await until(c, `!__test.playable(__test.session.playlist.items.get(${JSON.stringify(vanishedId)}))`)
    await run(c, `__test.removeFromPlaylist(${JSON.stringify(playlistIds[1])})`)
    await until(a, `!__test.session.playlist.items.has(${JSON.stringify(playlistIds[1])})`)
    await run(b, '__test.enterRoom("PERSIST1")')
    await connected()
    await until(b, `!__test.session.playlist.items.has(${JSON.stringify(playlistIds[1])}) && __test.session.ownFiles.size === 0`)
    console.log('PASS: Missing files become unavailable; a returning owner’s stale snapshot cannot resurrect a removed item')
    if (checkYouTube) {
      await run(a, '[...__test.session.playlist.items.keys()].forEach(id => __test.removeFromPlaylist(id))')
      await Promise.all(windows.map((win) => until(win, '__test.session.role === "idle" && __test.session.playlist.items.size === 0')))
      await run(a, `document.getElementById('playlist-add-url').click(); document.querySelector('#playlist-url-form input').value = 'https://www.youtube.com/watch?v=M7lc1UVf-VE'; document.getElementById('playlist-url-form').requestSubmit()`)
      await Promise.all(windows.map((win) => until(win, '__test.youtube.loaded && __test.youtube.duration > 0', 45000)))
      for (const win of windows) {
        assert.equal(await run(win, '__test.youtube.playing'), false)
        assert.ok(await run(win, '__test.youtube.time < 0.1'))
        assert.equal(await run(win, 'getComputedStyle(document.getElementById("empty")).display'), 'none')
      }
      console.log('PASS: A YouTube link added to an empty sidebar loads paused at zero for everyone and dismisses the empty player')
      await run(a, '__test.removeFromPlaylist(__test.session.playing.id)')
      await Promise.all(windows.map((win) => until(win, '__test.session.role === "idle"')))
      await run(a, `document.getElementById('media-url').value = 'https://www.youtube.com/watch?v=M7lc1UVf-VE'; document.getElementById('media-url-form').requestSubmit()`)
      await until(a, '__test.youtube.loaded && __test.youtube.duration > 0', 45000)
      assert.equal(await run(a, '__test.youtube.playing'), false)
      assert.ok(await run(a, '__test.youtube.time < 0.1'))
      await run(a, '__test.control("play")')
      await Promise.all(windows.map((win) => until(win, '__test.youtube.playing && __test.youtube.time > 1', 45000)))
      assert.equal(await run(c, '[...__test.session.playlist.items.values()].filter(item => item.youtubeId).length'), 1)
      await run(b, '__test.control("pause")')
      await Promise.all(windows.map((win) => until(win, '__test.youtube.state === 2')))
      await run(c, '__test.control("seek", 15)')
      await Promise.all(windows.map((win) => until(win, 'Math.abs(__test.youtube.time - 15) < 1.5')))
      await run(b, '__test.control("play")')
      await Promise.all(windows.map((win) => until(win, '__test.youtube.playing && __test.youtube.time > 16')))
      console.log('PASS: Three participants play YouTube directly; viewer pause, seek and resume synchronize')
      const ytId = await run(a, '__test.session.playing.id')
      await run(c, `__test.playItem(${JSON.stringify(ytId)})`)
      await until(c, '__test.session.role === "host" && __test.youtube.playing')
      await Promise.all([a, b].map((win) => until(win, '__test.session.role === "viewer" && __test.youtube.playing')))
      await run(c, `__test.hostFile(${JSON.stringify(video)})`)
      await until(c, 'document.getElementById("local-video").readyState >= 3 && !__test.youtube.frame')
      await Promise.all([a, b].map((win) => until(win, 'document.getElementById("remote-video").readyState >= 3 && !__test.youtube.frame')))
      console.log('PASS: YouTube host takeover and switching back to local WebRTC playback clean up embeds')
      const claimBeforeImport = await run(c, '__test.session.claimedAt')
      await run(a, `const transfer = new DataTransfer(); transfer.setData('text/uri-list', '# YouTube link\\r\\nhttps://www.youtube.com/watch?v=M7lc1UVf-VE'); document.getElementById('playlist').dispatchEvent(new DragEvent('drop', {bubbles:true, cancelable:true, dataTransfer:transfer}))`)
      await Promise.all(windows.map((win) => until(win, '[...__test.session.playlist.items.values()].filter(item => item.youtubeId).length === 2', 15000)))
      assert.equal(await run(c, '__test.session.claimedAt'), claimBeforeImport)
      console.log('PASS: Dragging a YouTube link into the sidebar adds it for everyone without changing playback')
      await run(a, `document.getElementById('playlist-add-url').click(); document.querySelector('#playlist-url-form input').value = 'https://www.youtube.com/playlist?list=PLBCF2DAC6FFB574DE'; document.getElementById('playlist-url-form').requestSubmit()`)
      await Promise.all(windows.map((win) => until(win, '[...__test.session.playlist.items.values()].filter(item => item.youtubeId).length === 12', 45000)))
      const imported = await run(a, '__test.orderedItems(__test.session.playlist).filter(item => item.youtubeId).map(item => item.youtubeId)')
      for (const win of [b, c]) assert.deepEqual(await run(win, '__test.orderedItems(__test.session.playlist).filter(item => item.youtubeId).map(item => item.youtubeId)'), imported)
      assert.equal(await run(c, '__test.session.claimedAt'), claimBeforeImport)
      assert.equal(await run(c, '__test.session.role === "host" && !__test.youtube.videoId && !document.getElementById("local-video").paused'), true)
      console.log('PASS: Sidebar URL imports append to the queue without taking over or interrupting playback')
      await run(a, '__test.leaveRoom()')
      await until(c, '__test.session.peers.size === 1')
      assert.equal(await run(c, '[...__test.session.playlist.items.values()].filter(item => item.youtubeId).every(__test.playable)'), true)
      await run(c, `__test.playItem(${JSON.stringify(ytId)})`)
      await Promise.all([b, c].map((win) => until(win, '__test.youtube.videoId === "M7lc1UVf-VE" && __test.youtube.playing')))
      console.log('PASS: Entire YouTube playlist imports in matching order on all peers and stays playable after its contributor leaves')
      await run(c, '__test.control("loop", true); __test.control("seek", __test.youtube.duration - 0.5); __test.control("play")')
      await until(c, '__test.youtube.playing && __test.youtube.time < 3')
      await until(b, '__test.session.loop && __test.youtube.playing && __test.youtube.time < 5')
      await run(c, '__test.control("loop", false)')
      for (let cycle = 0; cycle < 3; cycle++) {
        await run(c, `__test.hostFile(${JSON.stringify(video)})`)
        await until(c, 'document.getElementById("local-video").readyState >= 3 && !__test.youtube.frame')
        await until(b, 'document.getElementById("remote-video").readyState >= 3 && !__test.youtube.frame')
        await run(b, `__test.playItem(${JSON.stringify(ytId)})`)
        await Promise.all([b, c].map((win) => until(win, '__test.youtube.playing')))
      }
      console.log('PASS: Shared YouTube loop and three repeated local/YouTube host switches')
      await run(b, '__test.control("pause"); __test.control("seek", 12)')
      await Promise.all([b, c].map((win) => until(win, '__test.youtube.state === 2 && Math.abs(__test.youtube.time - 12) < 0.5')))
      await Promise.all([b, c].map((win) => run(win, '__test.leaveRoom()')))
      await run(b, '__test.enterRoom("PERSIST1")')
      await until(b, '__test.session.preview && __test.youtube.loaded && __test.youtube.duration > 0')
      assert.equal(await run(b, '__test.youtube.playing'), false)
      assert.ok(Math.abs(await run(b, '__test.youtube.time') - 12) < 0.5)
      await run(b, '__test.control("play")')
      await until(b, '!__test.session.preview && __test.youtube.playing && __test.youtube.time >= 12')
      console.log('PASS: Reopening YouTube restores the observed timestamp paused and resumes on Play')
    }
    for (const win of windows) assert.deepEqual(await run(win, '__test.errors'), [])
  } finally {
    clearTimeout(watchdog)
    for (const win of windows) if (!win.isDestroyed()) win.destroy()
    require('../main/media').stopAll()
  }
}).then(() => app.exit(0), (error) => { console.error(error); app.exit(1) })
