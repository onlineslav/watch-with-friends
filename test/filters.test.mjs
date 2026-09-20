import test from 'node:test'
import assert from 'node:assert/strict'
import {
  FILTERS,
  GRID,
  LM,
  anchorBox,
  buildMesh,
  cleanFilterId,
  createSmoother,
  facePose,
  frameDifference,
  grayscale,
  gridIndices,
  gridVertexCount,
  holdOpacity,
  isCut,
  smoothFace,
  gridBox,
  sourceAt,
  toLocal,
  toWorld,
  unwarpLandmarks,
  warpPairs,
} from '../renderer/filters.mjs'

const ASPECT = 16 / 9

// A synthetic face laid out in face units and mapped into image space through a known pose, so a
// test can assert in the same units a filter is authored in. Only the landmarks the filters read
// need to be in place; the rest sit at the origin.
const LAYOUT = new Map([
  [33, [-0.5, 0]], [263, [0.5, 0]], [1, [0, 0.5]], [152, [0, 1.8]], [10, [0, -1.3]],
  [234, [-1.05, 0.4]], [454, [1.05, 0.4]], [93, [-1, 0.75]], [323, [1, 0.75]],
  [172, [-0.9, 1]], [136, [-0.82, 1.25]], [150, [-0.68, 1.45]], [149, [-0.5, 1.62]],
  [176, [-0.3, 1.74]], [148, [-0.15, 1.79]], [377, [0.15, 1.79]], [400, [0.3, 1.74]],
  [378, [0.5, 1.62]], [379, [0.68, 1.45]], [365, [0.82, 1.25]], [397, [0.9, 1]],
  [132, [-1, 0.85]], [58, [-0.95, 1.1]], [288, [0.95, 1.1]], [361, [1, 0.85]],
  [70, [-0.66, -0.36]], [63, [-0.56, -0.42]], [105, [-0.44, -0.45]], [66, [-0.32, -0.42]], [107, [-0.2, -0.38]],
  [336, [0.2, -0.38]], [296, [0.32, -0.42]], [334, [0.44, -0.45]], [293, [0.56, -0.42]], [300, [0.66, -0.36]],
  [133, [-0.24, 0]], [159, [-0.37, -0.1]], [145, [-0.37, 0.1]],
  [362, [0.24, 0]], [386, [0.37, -0.1]], [374, [0.37, 0.1]],
  [103, [-0.8, -0.95]], [67, [-0.5, -1.12]], [109, [-0.2, -1.2]],
  [338, [0.2, -1.2]], [297, [0.5, -1.12]], [332, [0.8, -0.95]],
])

function makeFace({x = 0.5, y = 0.42, scale = 0.14, roll = 0} = {}) {
  const pose = {x: x * ASPECT, y, scale, cos: Math.cos(roll), sin: Math.sin(roll)}
  const landmarks = new Array(478)
  for (let i = 0; i < landmarks.length; i++) landmarks[i] = {x: x, y: y}
  for (const [index, [lx, ly]] of LAYOUT) {
    const [wx, wy] = toWorld(pose, lx, ly, ASPECT)
    landmarks[index] = {x: wx, y: wy}
  }
  return {landmarks, pose}
}

const close = (a, b, tolerance = 1e-6) => Math.abs(a - b) <= tolerance

// The deformation is solved backwards, so tests that want to ask "where does this pixel end up"
// rather than "where did it come from" swap the two sides and solve it the other way round.
const forward = (pairs) => ({p: pairs.q, q: pairs.p, n: pairs.n, weights: new Float64Array(pairs.n)})

test('the pose recovers the scale and roll the face was built with', () => {
  for (const roll of [0, 0.3, -0.55]) {
    const {landmarks, pose} = makeFace({roll, scale: 0.11})
    const found = facePose(landmarks, ASPECT)
    assert.ok(close(found.scale, pose.scale, 1e-9), `scale at roll ${roll}`)
    assert.ok(close(found.cos, pose.cos, 1e-9), `cos at roll ${roll}`)
    assert.ok(close(found.sin, pose.sin, 1e-9), `sin at roll ${roll}`)
  }
})

test('the pose is unchanged by the frame shape', () => {
  // Same face, described against a 16:9 and a 4:3 frame: the eye distance in face units is 1 either
  // way, so a filter authored once lands the same on both.
  const {landmarks} = makeFace()
  const wide = facePose(landmarks, ASPECT)
  const narrow = facePose(landmarks.map((p) => ({x: (p.x * ASPECT) / (4 / 3), y: p.y})), 4 / 3)
  assert.ok(close(wide.scale, narrow.scale, 1e-9))
  assert.ok(close(wide.cos, narrow.cos, 1e-9))
})

test('face units round-trip through image space', () => {
  const {pose} = makeFace({roll: 0.4})
  for (const [lx, ly] of [[0, 0], [1.3, -0.7], [-2, 2.8]]) {
    const [wx, wy] = toWorld(pose, lx, ly, ASPECT)
    const [bx, by] = toLocal(pose, wx, wy, ASPECT)
    assert.ok(close(bx, lx), `x ${lx}`)
    assert.ok(close(by, ly), `y ${ly}`)
  }
})

test('facePose refuses a face with no measurable eye distance', () => {
  const landmarks = new Array(478).fill({x: 0.5, y: 0.5})
  assert.equal(facePose(landmarks, ASPECT), null)
})

test('overlapping controls agree instead of stacking', () => {
  // Thirteen jaw points each asking for 0.3 must widen the jaw by about 0.3, not by four. This is
  // the property that lets the numbers in FILTERS be read as what they do, and it is the one that
  // composing local translation warps does not have.
  const {landmarks, pose} = makeFace()
  const pairs = warpPairs(FILTERS.chad, landmarks, pose, ASPECT)
  const target = 0.82 + 0.3 // where the right jaw at (0.82, 1.25) is asked to end up
  const [sx] = sourceAt(pairs, target, 1.25)
  const shift = target - sx
  assert.ok(shift > 0.15, `jaw should widen, got ${shift}`)
  assert.ok(shift < 0.5, `jaw widening should not stack, got ${shift}`)
})

test('the anchors hold the deformation still where they are', () => {
  // MLS tends to a global similarity far from its controls rather than to the identity. The anchor
  // ring is what stops the whole frame drifting, so it has to actually hold.
  const {landmarks, pose} = makeFace()
  const filter = FILTERS.chad
  const box = anchorBox(filter.reach)
  const pairs = warpPairs(filter, landmarks, pose, ASPECT)
  const cx = (box.x0 + box.x1) / 2
  const cy = (box.y0 + box.y1) / 2
  let worst = 0
  for (let i = 0; i < 16; i++) {
    const angle = (i / 16) * Math.PI * 2
    const x = cx + (Math.cos(angle) * (box.x1 - box.x0)) / 2
    const y = cy + (Math.sin(angle) * (box.y1 - box.y0)) / 2
    const [sx, sy] = sourceAt(pairs, x, y)
    worst = Math.max(worst, Math.hypot(sx - x, sy - y))
  }
  assert.ok(worst < 1e-9, `anchors should not move, worst ${worst}`)
})

test('every filter leaves the grid border still, so the warp has no seam', () => {
  // The mask fades the grid's border. Anything still moving there turns that fade into a visible
  // edge, which is the defect the old forward warp had. Positions and texture coordinates are both
  // normalized to the frame, so the tolerance below is a fraction of the picture: 2e-4 of a 1920
  // wide frame is under half a pixel.
  const {landmarks} = makeFace()
  for (const [id, filter] of Object.entries(FILTERS)) {
    const mesh = buildMesh(filter, landmarks, ASPECT)
    const n = GRID
    let worst = 0
    for (let column = 0; column <= n; column++) {
      for (const row of [0, n]) {
        const at = (row * (n + 1) + column) * 2
        worst = Math.max(worst, Math.hypot(mesh.position[at] - mesh.uv[at], mesh.position[at + 1] - mesh.uv[at + 1]))
      }
    }
    assert.ok(worst < 2e-4, `${id} border moves by ${worst.toExponential(2)}`)
  }
})

test('chad widens the jaw and lengthens the chin', () => {
  // Read backwards: a pixel now sitting outside where the jaw was must have come from inside it,
  // which is what widening looks like from the output's point of view.
  const {landmarks, pose} = makeFace()
  const pairs = warpPairs(FILTERS.chad, landmarks, pose, ASPECT)
  const [rightSource] = sourceAt(pairs, 1.05, 1.2)
  assert.ok(rightSource < 1.0, `right jaw should widen, came from ${rightSource}`)
  const [leftSource] = sourceAt(pairs, -1.05, 1.2)
  assert.ok(leftSource > -1.0, `left jaw should widen, came from ${leftSource}`)
  const [, chinSource] = sourceAt(pairs, 0, 1.95)
  assert.ok(chinSource < 1.95, `chin should lengthen, came from ${chinSource}`)
})

test('a filter lands in the same place on a face twice the size', () => {
  const small = makeFace({scale: 0.08})
  const large = makeFace({scale: 0.16})
  const meshes = [small, large].map(({landmarks}) => buildMesh(FILTERS.chad, landmarks, ASPECT))
  const index = (GRID / 2) * (GRID + 1) * 2
  // The texture coordinate is the part the deformation moves, so that is the part worth comparing.
  const localise = (mesh, face) => toLocal(face.pose, mesh.uv[index], mesh.uv[index + 1], ASPECT)
  const [ax, ay] = localise(meshes[0], small)
  const [bx, by] = localise(meshes[1], large)
  assert.ok(close(ax, bx, 1e-6), `${ax} vs ${bx}`)
  assert.ok(close(ay, by, 1e-6), `${ay} vs ${by}`)
})

test('the grid indices cover every cell and stay in range', () => {
  const indices = gridIndices(4)
  assert.equal(indices.length, 4 * 4 * 6)
  const count = gridVertexCount(4)
  assert.equal(count, 25)
  assert.ok(indices.every((i) => i >= 0 && i < count))
  // Two triangles per cell means every vertex but the outer row and column starts a pair.
  assert.equal(new Set(indices).size, count)
})

test('smoothing damps jitter without drifting off the face', () => {
  const smoother = createSmoother()
  const base = makeFace()
  let last = null
  let worst = 0
  for (let i = 0; i < 40; i++) {
    // The same face every time, with a pixel of noise on the eye corners.
    const shaken = base.landmarks.map((p, index) => (index === LM.rightEye || index === LM.leftEye ? {x: p.x + (i % 2 ? 0.002 : -0.002), y: p.y} : p))
    last = smoothFace(smoother, shaken, ASPECT, i * 66)
    if (i > 20) worst = Math.max(worst, Math.abs(last[LM.noseTip].x - base.landmarks[LM.noseTip].x))
  }
  assert.ok(worst < 0.002, `smoothed nose should sit still, moved ${worst}`)
  assert.ok(Math.abs(last[LM.chin].y - base.landmarks[LM.chin].y) < 0.01, 'smoothing should not drift')
})

test('smoothing follows a face that actually moves', () => {
  const smoother = createSmoother()
  let last = null
  for (let i = 0; i < 40; i++) {
    const {landmarks} = makeFace({x: 0.3 + i * 0.01})
    last = smoothFace(smoother, landmarks, ASPECT, i * 66)
  }
  const {landmarks: target} = makeFace({x: 0.3 + 39 * 0.01})
  assert.ok(Math.abs(last[LM.noseTip].x - target[LM.noseTip].x) < 0.01, 'should keep up with a moving face')
})

test('a cut is told apart from a moving camera', () => {
  const still = grayscale(new Uint8ClampedArray(32 * 18 * 4).fill(90))
  const nudged = grayscale(new Uint8ClampedArray(32 * 18 * 4).fill(96))
  const different = grayscale(new Uint8ClampedArray(32 * 18 * 4).fill(230))
  assert.ok(!isCut(still, nudged), 'a small change is not a cut')
  assert.ok(isCut(still, different), 'a big change is a cut')
  assert.equal(frameDifference(still, still), 0)
  assert.equal(frameDifference(still, null), 1)
  assert.equal(frameDifference(still, new Uint8Array(4)), 1)
})

test('a held face fades out rather than vanishing', () => {
  assert.equal(holdOpacity(0), 1)
  assert.equal(holdOpacity(100), 1)
  assert.ok(holdOpacity(250) > 0 && holdOpacity(250) < 1)
  assert.equal(holdOpacity(320), 0)
  assert.equal(holdOpacity(10000), 0)
  assert.equal(holdOpacity(-1), 0)
})

test('only known filter ids cross the room boundary', () => {
  assert.equal(cleanFilterId('chad'), 'chad')
  assert.equal(cleanFilterId('nope'), null)
  assert.equal(cleanFilterId('toString'), null)
  assert.equal(cleanFilterId('__proto__'), null)
  assert.equal(cleanFilterId(''), null)
  assert.equal(cleanFilterId(null), null)
  assert.equal(cleanFilterId({}), null)
})

test('unwarping recovers a face this app had already warped', () => {
  // What the YouTube path faces: the picture read back has the filter on it, so the same landmarks
  // that built the warp must come back out of a reading taken through it.
  const {landmarks, pose} = makeFace()
  const pairs = warpPairs(FILTERS.chad, landmarks, pose, ASPECT)
  const ahead = forward(pairs)
  const warped = landmarks.map((p) => {
    const [lx, ly] = toLocal(pose, p.x, p.y, ASPECT)
    const [wx, wy] = sourceAt(ahead, lx, ly)
    const [ix, iy] = toWorld(pose, wx, wy, ASPECT)
    return {x: ix, y: iy}
  })
  const recovered = unwarpLandmarks(warped, pairs, pose, ASPECT)
  let worst = 0
  for (const index of [172, 136, 152, 234, 33, 263]) {
    const [tx, ty] = toLocal(pose, landmarks[index].x, landmarks[index].y, ASPECT)
    const [rx, ry] = toLocal(pose, recovered[index].x, recovered[index].y, ASPECT)
    worst = Math.max(worst, Math.hypot(rx - tx, ry - ty))
  }
  // Forwards and backwards are two separate fits rather than exact inverses, so a little is left
  // over. What matters is that it is far smaller than the displacement, so repeated frames settle
  // instead of running away.
  assert.ok(worst < 0.05, `unwarp should land back near the real face, off by ${worst.toFixed(4)}`)
})

test('unwarping repeatedly settles instead of running away', () => {
  // The real loop: every frame warps the already-warped picture and unwarps the reading. If the
  // correction were missing this would diverge, which is a jaw that grows until it leaves frame.
  const {landmarks, pose} = makeFace()
  let current = landmarks
  for (let frame = 0; frame < 30; frame++) {
    const pairs = warpPairs(FILTERS.chad, current, pose, ASPECT)
    const ahead = forward(pairs)
    const warped = current.map((p) => {
      const [lx, ly] = toLocal(pose, p.x, p.y, ASPECT)
      const [wx, wy] = sourceAt(ahead, lx, ly)
      const [ix, iy] = toWorld(pose, wx, wy, ASPECT)
      return {x: ix, y: iy}
    })
    current = unwarpLandmarks(warped, pairs, pose, ASPECT)
  }
  const [jawX] = toLocal(pose, current[172].x, current[172].y, ASPECT)
  assert.ok(Math.abs(jawX - -0.9) < 0.05, `the jaw should stay put over 30 frames, ended at ${jawX.toFixed(3)}`)
})
