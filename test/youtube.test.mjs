import test from 'node:test'
import assert from 'node:assert/strict'
import {parseYouTubeUrl, droppedYouTubeUrl} from '../shared/youtube.mjs'
import {YouTubePlayer} from '../renderer/youtube.mjs'
import {createPlaylist, addItem, orderedItems, mergePlaylist, playlistSnapshot} from '../renderer/playlist.mjs'
import {RoomHistory} from '../renderer/room-history.mjs'

const video = 'M7lc1UVf-VE'
const list = 'PLBCF2DAC6FFB574DE'

test('URL drops handle browser link formats without interpreting HTML or importing arbitrary sources', () => {
  const url = `https://youtube.com/watch?v=${video}`
  assert.equal(droppedYouTubeUrl({uriList: `# Dragged link\r\n${url}\r\n`, text: 'Video title'}), url)
  assert.equal(droppedYouTubeUrl({mozUrl: `${url}\nVideo title`}), url)
  assert.equal(droppedYouTubeUrl({text: `  ${url}  `}), url)
  assert.equal(droppedYouTubeUrl({text: `https://youtube.com/playlist?list=${list}`}), `https://youtube.com/playlist?list=${list}`)
  for (const text of ['', '<a href="https://youtube.com">Video</a>', 'https://example.com/video', 'javascript:alert(1)']) {
    assert.throws(() => droppedYouTubeUrl({text}))
  }
})

test('YouTube URLs accept supported hosts and video forms, preferring full playlists', () => {
  for (const url of [`https://youtu.be/${video}?si=share`, `https://www.youtube.com/watch?v=${video}`,
    `https://m.youtube.com/shorts/${video}`, `https://youtube.com/live/${video}`, `https://youtube.com/embed/${video}`]) {
    assert.deepEqual(parseYouTubeUrl(url), {videoId: video, playlistId: null})
  }
  assert.deepEqual(parseYouTubeUrl(`https://youtube.com/watch?v=${video}&list=${list}&index=4`), {videoId: video, playlistId: list})
  assert.deepEqual(parseYouTubeUrl(`https://youtube.com/playlist?list=${list}`), {videoId: null, playlistId: list})
})

test('YouTube URLs reject arbitrary sources, credentials, malformed identifiers and schemes', () => {
  for (const url of ['not a URL', `https://youtube.com.evil.com/watch?v=${video}`, `file:///watch?v=${video}`,
    `https://youtube.com@evil.com/watch?v=${video}`, `https://user@youtube.com/watch?v=${video}`,
    `https://youtube.com:9000/watch?v=${video}`, 'https://youtube.com/watch?v=bad', 'https://youtube.com/playlist?list=<script>']) {
    assert.throws(() => parseYouTubeUrl(url))
  }
})

test('YouTube playlist order and duplicate videos survive room synchronization and local saves', () => {
  const playlist = createPlaylist()
  const videos = [video, 'dQw4w9WgXcQ', video]
  videos.forEach((youtubeId, index) => addItem(playlist, {id: `item:${index}`, title: `Video ${index}`, position: index, youtubeId}, 'owner'))
  const copy = createPlaylist()
  mergePlaylist(copy, playlistSnapshot(playlist), {selfId: 'owner', ownFiles: new Map()})
  assert.deepEqual(orderedItems(copy).map((item) => item.youtubeId), videos)
  const data = new Map()
  const history = new RoomHistory({getItem: (key) => data.get(key), setItem: (key, value) => data.set(key, value)}, 'owner')
  history.save({code: 'ABCDEFGH', playlist: copy, ownFiles: new Map(), claimedAt: 1})
  assert.deepEqual(orderedItems(history.load('ABCDEFGH').playlist).map((item) => item.youtubeId), videos)
  assert.equal(addItem(copy, {id: 'bad', title: 'Invalid', position: 5, youtubeId: 'https://evil.com'}, 'peer'), null)
})

// The embed reports its state on a 250 ms timer with no play or pause events, while the room
// broadcasts host state the moment a command is applied. A player that still says "playing" right
// after a pause tells every viewer to start again, which is what made a viewer's pause look ignored.
globalThis.window ??= {addEventListener() {}, removeEventListener() {}} // the player listens for the frame's messages

const fakeWindow = () => {
  const frame = {contentWindow: {posted: [], postMessage(message) { this.posted.push(message) }}}
  const player = new YouTubePlayer({replaceChildren() {}})
  player.frame = frame
  player.ready = true
  const report = (state) => player.receive({source: frame.contentWindow, origin: 'svp-youtube://player',
    data: {channel: 'svp-youtube', token: player.token, type: 'state', value: {state, time: 12, duration: 300, title: 'Clip'}}})
  return {player, report, posted: frame.contentWindow.posted}
}

test('a requested pause or play is reported before the embed confirms it, then the embed takes over', () => {
  const {player, report, posted} = fakeWindow()
  player.videoId = 'M7lc1UVf-VE'
  report(1)
  assert.equal(player.playing, true)

  player.pause()
  assert.equal(posted.at(-1).command, 'pause')
  assert.equal(player.playing, false, 'a pause is believed before the embed reports it')
  report(1) // the embed is still catching up
  assert.equal(player.playing, false)
  report(2)
  assert.equal(player.playing, false)
  assert.equal(player.intent, null, 'the embed agreed, so its own state is the truth again')

  player.play()
  assert.equal(player.playing, true)
  report(1)
  assert.equal(player.playing, true)
})

test('a play state turnover is announced once, not on every report the embed sends', () => {
  const {player, report} = fakeWindow()
  player.videoId = 'M7lc1UVf-VE'
  let turnovers = 0
  player.addEventListener('playstate', () => turnovers++)
  report(1)
  assert.equal(turnovers, 1)
  report(1)
  report(1)
  assert.equal(turnovers, 1, 'four reports a second must not become four broadcasts a second')
  player.pause()
  assert.equal(turnovers, 2)
  report(2)
  assert.equal(turnovers, 2, 'the embed confirming a pause already announced is not a second turnover')
})

test('a refused play stops being reported as playback instead of sticking', () => {
  const {player, report} = fakeWindow()
  player.videoId = 'M7lc1UVf-VE'
  report(2)
  player.play()
  assert.equal(player.playing, true)
  player.intentAt -= 5000 // the embed never started: blocked autoplay, or a video that will not play
  assert.equal(player.playing, false)
})
