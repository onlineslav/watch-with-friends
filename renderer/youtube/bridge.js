// This page has its own origin and no IPC access. Only bounded player commands are accepted.
let player
let token = null
// In an <iframe> the embedder is `parent`. This page is loaded in a <webview>, so it is a
// top-level document: `parent` is this window itself and the embedder is only reachable as the
// source of the message it sends on attach.
let host = parent === window ? null : parent
const queued = []
const send = (type, value) => {
  const message = {channel: 'svp-youtube', token, type, value}
  // Before the embedder has spoken, keep the one-shot events and drop the periodic reports:
  // another one follows in 250ms.
  if (!host) { if (type !== 'state' && queued.length < 8) queued.push(message); return }
  host.postMessage(message, '*')
}
const videoId = (value) => typeof value === 'string' && /^[\w-]{11}$/.test(value)
const seconds = (value) => Number.isFinite(value) && value >= 0 && value <= 1e9
let importing = false

function report() {
  if (!player?.getPlayerState || token === null) return
  send('state', {state: player.getPlayerState(), time: player.getCurrentTime() || 0,
    duration: player.getDuration() || 0, title: player.getVideoData()?.title || ''})
  if (importing) {
    const ids = player.getPlaylist()
    if (ids?.length) {
      importing = false
      send('playlist', ids)
    }
  }
}

window.onYouTubeIframeAPIReady = () => {
  player = new YT.Player('player', {width: '100%', height: '100%',
    playerVars: {playsinline: 1, rel: 0},
    events: {
      onReady: () => send('ready'),
      onStateChange: report,
      onError: ({data}) => send('error', data),
      onAutoplayBlocked: () => send('blocked'),
    },
  })
}

window.addEventListener('message', ({source, data}) => {
  if (data?.channel !== 'svp-youtube' || (host ? source !== host : source === window)) return
  if (!host) { host = source; for (const message of queued.splice(0)) host.postMessage(message, '*') }
  if (!player?.cueVideoById) return
  const {command, value} = data
  if (command === 'load' && videoId(value?.videoId) && seconds(value?.time)) {
    token = data.token
    importing = false
    player[value.playing ? 'loadVideoById' : 'cueVideoById']({videoId: value.videoId, startSeconds: value.time})
  } else if (command === 'playlist' && typeof value === 'string' && /^[\w-]{10,100}$/.test(value)) {
    token = data.token
    importing = true
    player.cuePlaylist({list: value, listType: 'playlist', index: 0})
  } else if (command === 'volume' && Number.isFinite(value) && value >= 0 && value <= 100) player.setVolume(value)
  else if (data.token !== token) return
  else if (command === 'play') player.playVideo()
  else if (command === 'pause') player.pauseVideo()
  else if (command === 'seek' && seconds(value)) player.seekTo(value, true)
})
setInterval(report, 250)
const script = document.createElement('script')
script.src = 'https://www.youtube.com/iframe_api'
script.onerror = () => send('error', 'network')
document.head.append(script)
