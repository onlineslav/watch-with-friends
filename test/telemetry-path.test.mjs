import test from 'node:test'
import assert from 'node:assert/strict'
import {readDetail, detailDelta, remoteAddress, peerTrouble, linkFacts} from '../renderer/telemetry.mjs'

const report = (pair) => [
  {type: 'transport', id: 'T', selectedCandidatePairId: 'P'},
  {type: 'candidate-pair', id: 'P', localCandidateId: 'L', remoteCandidateId: 'R', ...pair},
  {type: 'local-candidate', id: 'L', address: '192.168.1.20', candidateType: 'host', protocol: 'udp'},
  {type: 'remote-candidate', id: 'R', address: '203.0.113.5', candidateType: 'srflx'},
]

test('the route counters become per-direction deltas, kbps and quiet time', () => {
  const first = readDetail(report({timestamp: 10_000, requestsSent: 10, responsesReceived: 10, requestsReceived: 8, responsesSent: 8, bytesReceived: 1_000_000, bytesSent: 50_000, currentRoundTripTime: 0.03, lastPacketReceivedTimestamp: 9990}))
  const second = readDetail(report({timestamp: 12_000, requestsSent: 12, responsesReceived: 10, requestsReceived: 9, responsesSent: 9, packetsDiscardedOnSend: 0, bytesReceived: 1_500_000, bytesSent: 60_000, currentRoundTripTime: 0.9, lastPacketReceivedTimestamp: 10_500}))
  assert.deepEqual(detailDelta(first, second).cp, {rq: 2, rs: 0, rr: 1, ss: 1, in: 2000, out: 40, rtt: 900, quiet: 1500})
  assert.deepEqual(detailDelta(null, first).cp, {rtt: 30, quiet: 10}, 'first reading: no deltas, never 0')
  const moved = readDetail(report({timestamp: 14_000, requestsSent: 1}).map((s) => (s.id === 'P' ? {...s, id: 'Q'} : s.id === 'T' ? {...s, selectedCandidatePairId: 'Q'} : s)))
  assert.equal(detailDelta(second, moved)?.cp?.rq, undefined, 'a new route is not compared with the old one')
})

test('the remote address is read for main but never reaches the logged detail', () => {
  const entries = report({timestamp: 1})
  assert.equal(remoteAddress(entries), '203.0.113.5')
  const detail = readDetail(entries)
  assert.equal(JSON.stringify(detail).includes('203.0.113'), false)
  assert.equal(JSON.stringify(detailDelta(null, detail)).includes('203.0.113'), false)
  assert.equal(JSON.stringify(linkFacts(detail)).includes('203.0.113'), false)
  assert.equal(remoteAddress([]), null)
})

test('trouble names the first reason that applies, or null', () => {
  assert.equal(peerTrouble({}), null)
  assert.equal(peerTrouble({lossPct: 4, rttMs: 40, quietMs: 50, feedbackAgeMs: 1000, ice: 'connected'}), null)
  assert.equal(peerTrouble({ice: 'disconnected', lossPct: 50}), 'disconnected')
  assert.equal(peerTrouble({lossPct: 11}), 'loss')
  assert.equal(peerTrouble({rttMs: 1200}), 'rtt')
  assert.equal(peerTrouble({quietMs: 2500}), 'quiet')
  assert.equal(peerTrouble({feedbackAgeMs: 5000}), 'feedback')
})
