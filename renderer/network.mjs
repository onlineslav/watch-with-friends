// One mutable ICE configuration for friends, rooms and Trystero's offer pool.
export const NETWORK_TIMEOUT_MS = 5000
export function deadline(promise, ms = NETWORK_TIMEOUT_MS) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Connection relay did not respond. Retrying in the background.')), ms)
  })]).finally(() => clearTimeout(timer))
}

export function createNetwork({getIceServers, PeerConnection, now = Date.now, record = () => {}}) {
  const peers = new Set()
  let servers = [], expiresAt = 0, pending = null, timer = null, disposed = false
  let nextConnectionId = 0
  const network = new EventTarget()
  network.error = null
  const iceFor = (pcConfig = {}) => [...(pcConfig.iceServers || []).filter((s) => [].concat(s.urls).every((url) => /^stuns?:/i.test(url))), ...servers]
  const configurePeers = () => {
    for (const pc of peers) {
      try {
        pc.setConfiguration({...pc.getConfiguration(), iceServers: iceFor(pc.getConfiguration())})
        pc.restartIce() // refresh pooled offers as well as live TURN allocations
      } catch {}
    }
  }
  network.PeerConnection = class extends PeerConnection {
    constructor(config) {
      if (peers.size >= 256) throw new Error('Too many simultaneous connections')
      super({...config, iceServers: iceFor(config)})
      peers.add(this)
      const connection = ++nextConnectionId
      let previous = ''
      const trace = () => {
        const state = {connection, connectionState: this.connectionState, iceState: this.iceConnectionState,
          gatheringState: this.iceGatheringState, signalingState: this.signalingState,
          remoteDescription: Boolean(this.remoteDescription),
          hasTurn: iceFor(this.getConfiguration()).some(({urls}) => [].concat(urls).some((url) => /^turns?:/i.test(url)))}
        const signature = JSON.stringify(state)
        if (signature === previous) return
        previous = signature
        record('peer-state', state)
      }
      for (const event of ['connectionstatechange', 'iceconnectionstatechange', 'icegatheringstatechange', 'signalingstatechange']) this.addEventListener(event, trace)
      this.addEventListener('icecandidateerror', (event) => record('ice-error', {connection, code: event.errorCode, message: event.errorText}))
      trace()
      this.addEventListener('connectionstatechange', () => {
        if (this.connectionState === 'closed') peers.delete(this)
      })
    }
    close() { peers.delete(this); return super.close() }
  }
  network.config = () => ({rtcPolyfill: network.PeerConnection, turnConfig: servers})
  network.refresh = () => {
    if (disposed) return Promise.resolve()
    if (pending) return pending
    pending = deadline(Promise.resolve().then(getIceServers)).then((result) => {
      if (disposed) return
      const next = Array.isArray(result) ? result : result?.iceServers
      if (!Array.isArray(next)) throw new Error('Invalid connection relay response')
      if (result?.error) throw new Error(result.error)
      const changed = JSON.stringify(next) !== JSON.stringify(servers)
      servers = next
      expiresAt = result?.expiresAt || now() + 60_000
      network.error = null
      if (changed) configurePeers()
    }).catch((error) => {
      if (disposed) return
      network.error = error.message
      if (expiresAt <= now() && servers.length) { servers = []; configurePeers() }
    }).finally(() => {
      pending = null
      if (disposed) return
      network.dispatchEvent(new Event('change'))
      clearTimeout(timer)
      timer = setTimeout(network.refresh, network.error ? 15_000 : servers.length ? Math.max(5000, Math.min(60_000, expiresAt - now() - 60_000)) : 60_000)
      timer.unref?.()
    })
    return pending
  }
  network.reconnect = async () => {
    await network.refresh()
    for (const pc of peers) if (['disconnected', 'failed'].includes(pc.connectionState) || ['disconnected', 'failed'].includes(pc.iceConnectionState)) {
      try { pc.restartIce() } catch {}
    }
  }
  network.stop = () => { disposed = true; clearTimeout(timer) }
  network.ready = network.refresh()
  return network
}
