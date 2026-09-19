// Face filters: what a filter *is*, and all the maths that places one on a face. Pure and
// unit-tested, like whiteboard.mjs — nothing here touches the DOM, WebGL or MediaPipe.
//
// A filter is data, not code. It names groups of face landmarks and how far to push them, so adding
// one means editing the table below rather than writing a renderer. The warp itself is a grid of
// vertices laid over the face: each vertex keeps the texture coordinate it started at and moves to
// where the filter wants it, so the video stretches between them. Displacement falls to zero well
// inside the grid's edge, which is why the warp has no visible seam.
//
// Everything is measured in "face units": one unit is the distance between the outer eye corners,
// the origin sits between the eyes, and the axes follow the head's roll. A filter authored this way
// lands identically on a close-up and a wide shot, at any window size.

// Canonical MediaPipe face-mesh indices. Only the ones the filters and the pose fit actually use.
export const LM = {rightEye: 33, leftEye: 263, noseTip: 1, chin: 152, foreheadTop: 10, rightCheek: 234, leftCheek: 454}

// The lower face oval, jaw corner round to jaw corner.
const JAW = [172, 136, 150, 149, 176, 148, 152, 377, 400, 378, 379, 365, 397]
const JAW_CORNERS = [132, 58, 288, 361]
const CHIN = [148, 176, 152, 377, 400]
const BROW = [70, 63, 105, 66, 107, 336, 296, 334, 293, 300]
const CHEEKS = [234, 454, 93, 323]
const EYES = [33, 133, 159, 145, 263, 362, 386, 374]
const TEMPLES = [103, 67, 109, 338, 297, 332]

// `out` pushes a point away from the face's centre line (a pure widening); `move` shifts it in face
// units, y downwards. `radius` is how far the push reaches. Overlapping groups blend rather than
// stack, so these numbers mean what they say.
export const FILTERS = {
  chad: {
    name: 'Chad',
    controls: [
      {points: JAW, out: 0.2, radius: 0.42},
      {points: JAW_CORNERS, out: 0.26, radius: 0.4},
      {points: CHIN, move: [0, 0.1], radius: 0.34},
      {points: BROW, move: [0, 0.05], radius: 0.28},
      {points: CHEEKS, out: 0.09, radius: 0.34},
    ],
    // Applied inside the mask only, and faded out with it, so there is no line around the face.
    grade: {saturation: 0.82, contrast: 1.14, brightness: 1},
  },
  alien: {
    name: 'Alien',
    controls: [
      {points: TEMPLES, out: 0.3, move: [0, -0.22], radius: 0.55},
      {points: EYES, out: 0.1, radius: 0.3},
      {points: JAW, out: -0.22, radius: 0.45},
      {points: CHIN, move: [0, -0.12], radius: 0.35},
    ],
    grade: {saturation: 1.25, contrast: 1.05, brightness: 1.02},
  },
  chipmunk: {
    name: 'Chipmunk',
    controls: [
      {points: CHEEKS, out: 0.22, move: [0, 0.1], radius: 0.45},
      {points: EYES, out: 0.08, radius: 0.26},
      {points: CHIN, move: [0, -0.06], radius: 0.3},
    ],
    grade: null,
  },
}

export const FILTER_IDS = Object.keys(FILTERS)
export const MAX_FACES = 3
export const cleanFilterId = (value) => (typeof value === 'string' && Object.hasOwn(FILTERS, value) ? value : null)

// ---------- Face pose ----------
// Landmarks arrive normalized to the video frame, which is not square, so every distance and angle
// here is computed with x scaled by the aspect ratio. Otherwise a face would appear to roll when
// the window shape changed.

export function facePose(landmarks, aspect) {
  const right = landmarks[LM.rightEye]
  const left = landmarks[LM.leftEye]
  if (!right || !left) return null
  const dx = (left.x - right.x) * aspect
  const dy = left.y - right.y
  const scale = Math.hypot(dx, dy)
  if (!(scale > 1e-6)) return null
  // The eye line gives roll directly; the unit vector doubles as the rotation.
  return {x: ((right.x + left.x) / 2) * aspect, y: (right.y + left.y) / 2, scale, cos: dx / scale, sin: dy / scale}
}

// Image space -> face units.
export function toLocal(pose, x, y, aspect) {
  const px = (x * aspect - pose.x) / pose.scale
  const py = (y - pose.y) / pose.scale
  return [px * pose.cos + py * pose.sin, -px * pose.sin + py * pose.cos]
}

// Face units -> image space (normalized to the frame, ready for texture coordinates).
export function toWorld(pose, lx, ly, aspect) {
  const px = lx * pose.cos - ly * pose.sin
  const py = lx * pose.sin + ly * pose.cos
  return [(pose.x + px * pose.scale) / aspect, pose.y + py * pose.scale]
}

// ---------- Displacement field ----------
// A compact quartic bump: full strength at the control point, exactly zero at `radius`. Compact
// support is what keeps the warp local and the grid edges still.
const weightAt = (distanceSquared, radiusSquared) => {
  if (distanceSquared >= radiusSquared) return 0
  const t = 1 - distanceSquared / radiusSquared
  return t * t
}

// Flattens a filter's control groups into individual points placed in face units.
export function controlPoints(filter, landmarks, pose, aspect) {
  const points = []
  for (const group of filter.controls) {
    const [mx, my] = group.move || [0, 0]
    for (const index of group.points) {
      const landmark = landmarks[index]
      if (!landmark) continue
      const [lx, ly] = toLocal(pose, landmark.x, landmark.y, aspect)
      // `out` is horizontal: widening a jaw means moving it away from the centre line, not away
      // from the eyes. A point already on the centre line is left to `move` alone.
      const sideways = group.out ? Math.sign(lx) * group.out : 0
      if (!sideways && !mx && !my) continue
      points.push({x: lx, y: ly, dx: sideways + mx, dy: my, radiusSquared: group.radius * group.radius})
    }
  }
  return points
}

// Normalized blending: where several controls overlap the result is their weighted average rather
// than their sum, so thirteen jaw points at 0.20 still widen the jaw by 0.20 and not by 2.6.
export function displacementAt(points, lx, ly) {
  let dx = 0
  let dy = 0
  let total = 0
  for (const point of points) {
    const ex = lx - point.x
    const ey = ly - point.y
    const weight = weightAt(ex * ex + ey * ey, point.radiusSquared)
    if (!weight) continue
    dx += weight * point.dx
    dy += weight * point.dy
    total += weight
  }
  if (!total) return [0, 0]
  const divisor = Math.max(1, total)
  return [dx / divisor, dy / divisor]
}

// ---------- Mesh ----------
// The grid covers the head in face units and reaches past the mask, so the fade to transparent
// happens on geometry that is itself no longer moving.
export const GRID = 32
export const GRID_BOX = {x0: -2, x1: 2, y0: -2.2, y1: 2.8}

// Two triangles per cell, in the same order every time: built once and reused for every face.
export function gridIndices(n = GRID) {
  const indices = new Uint16Array(n * n * 6)
  let at = 0
  for (let row = 0; row < n; row++) {
    for (let column = 0; column < n; column++) {
      const topLeft = row * (n + 1) + column
      const bottomLeft = topLeft + n + 1
      indices[at++] = topLeft
      indices[at++] = bottomLeft
      indices[at++] = topLeft + 1
      indices[at++] = topLeft + 1
      indices[at++] = bottomLeft
      indices[at++] = bottomLeft + 1
    }
  }
  return indices
}

export const gridVertexCount = (n = GRID) => (n + 1) * (n + 1)

// `position` is where a vertex ends up, `uv` is the pixel it carries there, and `local` lets the
// shader fade the edges. All three are normalized to the video frame.
export function buildMesh(filter, landmarks, aspect, n = GRID, out = null) {
  const pose = facePose(landmarks, aspect)
  if (!pose) return null
  const points = controlPoints(filter, landmarks, pose, aspect)
  const count = gridVertexCount(n)
  const mesh = out || {position: new Float32Array(count * 2), uv: new Float32Array(count * 2), local: new Float32Array(count * 2)}
  let at = 0
  for (let row = 0; row <= n; row++) {
    const ly = GRID_BOX.y0 + ((GRID_BOX.y1 - GRID_BOX.y0) * row) / n
    for (let column = 0; column <= n; column++) {
      const lx = GRID_BOX.x0 + ((GRID_BOX.x1 - GRID_BOX.x0) * column) / n
      const [dx, dy] = displacementAt(points, lx, ly)
      const [ux, uy] = toWorld(pose, lx, ly, aspect)
      const [px, py] = toWorld(pose, lx + dx, ly + dy, aspect)
      mesh.uv[at] = ux
      mesh.uv[at + 1] = uy
      mesh.position[at] = px
      mesh.position[at + 1] = py
      mesh.local[at] = lx
      mesh.local[at + 1] = ly
      at += 2
    }
  }
  mesh.pose = pose
  return mesh
}

// ---------- Undoing this app's own warp ----------
// The YouTube picture is read back out of the app's own window, and that window already has the
// filter drawn on it. So a detection made from it measures a face this app has itself widened, and
// building the next warp on that measurement compounds it — a jaw that grows every frame until it
// leaves the screen.
//
// Subtracting the displacement that was applied at the measured position turns the reading back
// into the real face. Evaluating the field at the warped point rather than the true one leaves a
// second-order error, which is small for a smooth displacement and settles rather than accumulates.

// Solves l = measured - displacement(l) by repeated substitution. One pass is not enough: the
// field is steep enough near the jaw that the leftover error feeds the next frame and the warp
// still creeps outward, just slowly. A handful of passes converges and then stays put.
const UNWARP_STEPS = 8
const UNWARP_SETTLED = 1e-4

export function unwarpLandmarks(landmarks, points, pose, aspect) {
  if (!pose || !points.length) return landmarks
  return landmarks.map((point) => {
    const [mx, my] = toLocal(pose, point.x, point.y, aspect)
    let lx = mx
    let ly = my
    for (let step = 0; step < UNWARP_STEPS; step++) {
      const [dx, dy] = displacementAt(points, lx, ly)
      const nx = mx - dx
      const ny = my - dy
      const moved = Math.hypot(nx - lx, ny - ly)
      lx = nx
      ly = ny
      if (moved < UNWARP_SETTLED) break
    }
    if (lx === mx && ly === my) return point
    const [wx, wy] = toWorld(pose, lx, ly, aspect)
    return {x: wx, y: wy}
  })
}

// ---------- Smoothing ----------
// Raw landmarks jitter, and detection runs far slower than the screen refreshes. Smoothing the
// rigid pose slowly and the expression on top of it quickly is what makes a filter look locked to
// the face instead of swimming over it: the head's position is the part that must not wobble, and
// it is also the part that genuinely moves slowly.

const alphaFor = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt))

// One Euro filter: the more something is moving, the less it is smoothed, so a still face is rock
// steady and a fast one does not lag behind.
function oneEuro(state, value, dt, minCutoff, beta) {
  if (!state) return {value, speed: 0, alpha: 1}
  const speed = state.speed + alphaFor(1, dt) * ((value - state.value) / dt - state.speed)
  const alpha = alphaFor(minCutoff + beta * Math.abs(speed), dt)
  return {value: state.value + alpha * (value - state.value), speed, alpha}
}

// Smoothing a moving target always trails it, by exactly speed * dt * (1 - alpha) / alpha. Detection
// also runs a frame or two behind the picture. Adding that much back puts the filter where the face
// is now rather than where it was: a still face is unaffected because its speed is zero, and the
// clamp keeps a bad detection from flinging the warp across the screen.
const LEAD = 0.9
const MAX_LEAD_FACES = 0.3

function withLead(state, dt) {
  if (!dt || !state.alpha) return state.value
  return state.value + LEAD * state.speed * dt * ((1 - state.alpha) / state.alpha)
}

const POSE_CUTOFF = 1.2
const POSE_BETA = 0.35
const LOCAL_CUTOFF = 4
const LOCAL_BETA = 1.5

export const createSmoother = () => ({pose: null, local: null, at: 0})

// Returns landmarks in the same shape they arrived in, smoothed. `now` is in milliseconds.
export function smoothFace(smoother, landmarks, aspect, now) {
  const pose = facePose(landmarks, aspect)
  if (!pose) return null
  const dt = smoother.at ? Math.min(0.5, Math.max(1e-3, (now - smoother.at) / 1000)) : 0
  smoother.at = now
  // Roll is smoothed as its unit vector, which has no wrap-around to get wrong.
  const fields = ['x', 'y', 'scale', 'cos', 'sin']
  const nextPose = {}
  for (const field of fields) {
    const state = dt ? oneEuro(smoother.pose?.[field], pose[field], dt, POSE_CUTOFF, POSE_BETA) : {value: pose[field], speed: 0}
    nextPose[field] = state
  }
  const length = Math.hypot(nextPose.cos.value, nextPose.sin.value) || 1
  const scale = nextPose.scale.value
  // Only the head's travel is led forward. Expression that ran ahead of itself would look wrong,
  // and a face's position is what the eye notices trailing.
  const limit = MAX_LEAD_FACES * scale
  const lead = (field) => Math.min(limit, Math.max(-limit, withLead(nextPose[field], dt) - nextPose[field].value))
  const fitted = {
    x: nextPose.x.value + lead('x'),
    y: nextPose.y.value + lead('y'),
    scale,
    cos: nextPose.cos.value / length,
    sin: nextPose.sin.value / length,
  }
  smoother.pose = nextPose

  // Whatever the rigid pose does not explain is expression, and expression is allowed to be quick.
  const count = landmarks.length
  if (!smoother.local || smoother.local.length !== count * 2) {
    smoother.local = new Array(count * 2).fill(null)
  }
  const result = new Array(count)
  for (let i = 0; i < count; i++) {
    const [lx, ly] = toLocal(pose, landmarks[i].x, landmarks[i].y, aspect)
    const sx = dt ? oneEuro(smoother.local[i * 2], lx, dt, LOCAL_CUTOFF, LOCAL_BETA) : {value: lx, speed: 0}
    const sy = dt ? oneEuro(smoother.local[i * 2 + 1], ly, dt, LOCAL_CUTOFF, LOCAL_BETA) : {value: ly, speed: 0}
    smoother.local[i * 2] = sx
    smoother.local[i * 2 + 1] = sy
    const [wx, wy] = toWorld(fitted, sx.value, sy.value, aspect)
    result[i] = {x: wx, y: wy}
  }
  return result
}

export function resetSmoother(smoother) {
  smoother.pose = null
  smoother.local = null
  smoother.at = 0
}

// ---------- Shot changes ----------
// Filtering a film, not a webcam. Holding the last known face for a moment is what carries a filter
// through a blink or a fast turn, but holding it across a cut paints one actor's jaw onto another
// shot. Comparing successive thumbnails costs nothing and tells the two cases apart.

export const CUT_THRESHOLD = 0.17

// Mean absolute difference of two grayscale thumbnails, 0 (identical) to 1.
export function frameDifference(a, b) {
  if (!a || !b || a.length !== b.length || !a.length) return 1
  let total = 0
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i])
  return total / (a.length * 255)
}

export const isCut = (a, b, threshold = CUT_THRESHOLD) => frameDifference(a, b) > threshold

// RGBA pixels to a grayscale thumbnail, in place-free form so it can be compared frame to frame.
export function grayscale(rgba) {
  const out = new Uint8Array(Math.floor(rgba.length / 4))
  for (let i = 0; i < out.length; i++) {
    out[i] = (0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2]) | 0
  }
  return out
}

// ---------- Holding a face between detections ----------
// Detection runs at a fraction of the frame rate and drops out over profiles, dark scenes and fast
// motion. A face is kept for HOLD_MS and fades rather than vanishing, which reads as the filter
// losing grip instead of flickering. A cut drops it immediately.

export const HOLD_MS = 320
export const FADE_MS = 140

export function holdOpacity(age, hold = HOLD_MS, fade = FADE_MS) {
  if (!(age >= 0) || age >= hold) return 0
  return age <= hold - fade ? 1 : (hold - age) / fade
}
