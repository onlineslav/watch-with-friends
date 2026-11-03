'use strict'

// Machine load for the diagnostic log: CPU and memory per Electron process, battery and thermal
// state, and once per session the GPU feature status and display refresh rates. The main process is
// the only place these exist. While a window is in a room, a sampler here reads them every 2 seconds
// and pushes the result to that window (one-way, no round trip), where it joins the telemetry
// sample. Pure summarising is separate from the timers so it can be unit-tested.

const SAMPLE_MS = 2000

const round = (value, places = 0) => (Number.isFinite(value) ? Math.round(value * 10 ** places) / 10 ** places : null)

const GROUPS = {Browser: 'm', Tab: 'r', GPU: 'g'}

// getAppMetrics() -> {m: [cpu%, MB], r: [...], g: [...], o: [cpu%, MB, count]}: main, renderer(s),
// GPU, and everything else (utility/network processes) together. CPU is percent of one core.
function summarizeMetrics(metrics) {
  const groups = {}
  for (const proc of Array.isArray(metrics) ? metrics : []) {
    const key = GROUPS[proc?.type] || 'o'
    const g = (groups[key] ||= {cpu: 0, kb: 0, n: 0})
    g.cpu += Number(proc?.cpu?.percentCPUUsage) || 0
    g.kb += Number(proc?.memory?.workingSetSize) || 0
    g.n++
  }
  const out = {}
  for (const [key, g] of Object.entries(groups)) {
    out[key] = key === 'o' ? [round(g.cpu, 1), Math.round(g.kb / 1024), g.n] : [round(g.cpu, 1), Math.round(g.kb / 1024)]
  }
  return out
}

// One reading. Anything the platform can't tell is left out, never guessed: thermal state is macOS
// only, and the CPU speed limit arrives as an event on macOS and Windows.
function readMachine({getMetrics, systemMemory, power, edgeRtt, netProbe}) {
  const reading = {p: summarizeMetrics(getMetrics())}
  try {
    const free = Number(systemMemory?.().free)
    if (Number.isFinite(free)) reading.free = Math.round(free / 1024)
  } catch {}
  try {
    const battery = power?.isOnBatteryPower?.()
    if (typeof battery === 'boolean') reading.bat = battery ? 1 : 0
  } catch {}
  try {
    const thermal = power?.getCurrentThermalState?.()
    if (thermal && thermal !== 'unknown') reading.th = String(thermal)
  } catch {}
  const limit = power?.speedLimit?.()
  if (Number.isFinite(limit)) reading.lim = limit
  // Round trip to the Cloudflare edge over the live telemetry socket (main/live.js, M1.9), when it is
  // open and has just been answered; absent otherwise, never 0. A value that climbs while video
  // flows is this person's own link filling up.
  try {
    const edge = edgeRtt?.()
    if (Number.isFinite(edge) && edge >= 0) reading.er = edge
  } catch {}
  // Pings to this computer's router and to the internet since the last reading (main/net-probe.js):
  // {gw: {n, lost?, avg?, max?}, net: {...}}; absent when nothing was probed.
  try {
    const probes = netProbe?.()
    if (probes) reading.np = probes
  } catch {}
  return reading
}

// One sampler per window that is in a room. `send(reading)` is the only side effect.
function createSampler({deps, send, setTimer = setInterval, clearTimer = clearInterval, intervalMs = SAMPLE_MS}) {
  let timer = null
  const tick = () => {
    try { send(readMachine(deps)) } catch {}
  }
  return {
    get running() { return timer != null },
    start() {
      if (timer) return
      tick() // CPU usage is measured since the previous call, so the first reading only primes it
      timer = setTimer(tick, intervalMs)
      timer.unref?.()
    },
    stop() {
      if (timer) clearTimer(timer)
      timer = null
    },
  }
}

// Compact form of the GPU feature table and device list, and of the displays, for the once-per-session event.
function describeGpu(features, info) {
  const devices = (Array.isArray(info?.gpuDevice) ? info.gpuDevice : []).slice(0, 4).map((d) => ({
    act: d?.active ? 1 : 0,
    ven: d?.vendorId ?? null,
    dev: d?.deviceId ?? null,
    name: d?.deviceString ? String(d.deviceString).slice(0, 80) : null,
    drv: d?.driverVersion ? String(d.driverVersion).slice(0, 40) : null,
  }))
  return {features: features && typeof features === 'object' ? features : null, devices}
}

function describeDisplays(displays, primaryId) {
  return (Array.isArray(displays) ? displays : []).slice(0, 8).map((d) => ({
    hz: Number.isFinite(d?.displayFrequency) ? d.displayFrequency : null,
    w: d?.size?.width ?? null,
    h: d?.size?.height ?? null,
    sf: d?.scaleFactor ?? null,
    primary: d?.id === primaryId ? 1 : 0,
  }))
}

module.exports = {SAMPLE_MS, createSampler, describeDisplays, describeGpu, readMachine, summarizeMetrics}
