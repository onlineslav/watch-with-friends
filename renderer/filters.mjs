// Face filters: what a filter *is*, and all the maths that places one on a face. Pure and
// unit-tested, like whiteboard.mjs — nothing here touches the DOM, WebGL or MediaPipe.
//
// A filter is data, not code. It names groups of face landmarks and where to put them, so adding
// one means editing the table below rather than writing a renderer.
//
// Everything is measured in "face units": one unit is the distance between the outer eye corners,
// the origin sits between the eyes, and the axes follow the head's roll. A filter authored this way
// lands identically on a close-up and a wide shot, at any window size.

// Canonical MediaPipe face-mesh indices. Only the ones the filters and the pose fit actually use.
export const LM = {rightEye: 33, leftEye: 263, noseTip: 1, chin: 152, foreheadTop: 10, rightCheek: 234, leftCheek: 454}

// The lower face oval, jaw corner round to jaw corner.
const JAW = [172, 136, 150, 149, 176, 148, 152, 377, 400, 378, 379, 365, 397]
// The gonial angle — the corner of the mandible, and the single feature a heavy jaw reads from.
const JAW_CORNERS = [58, 288, 172, 397, 132, 361]
const CHIN = [148, 176, 152, 377, 400, 175, 199, 200]
const BROW = [70, 63, 105, 66, 107, 336, 296, 334, 293, 300]
const CHEEKBONES = [234, 454, 93, 323, 116, 345]
// Under the cheekbone, where a hollow goes. Not to be confused with the mid-cheek points beside
// the nose, which is where these were wrongly placed at first.
const CHEEK_HOLLOW = [205, 425, 216, 436, 207, 427]
const EYES = [33, 133, 159, 145, 263, 362, 386, 374]
const TEMPLES = [103, 67, 109, 338, 297, 332]

// `out` pushes a point away from the face's centre line (a pure widening); `move` shifts it in face
// units, y downwards. There is no radius: the deformation decides for itself how far each control
// reaches, from how close the other controls are.
//
// `reach` is how far out the anchors sit, in multiples of the grid box. It is the strength knob
// nobody expects: anchors close in argue the deformation back down to almost nothing, so a filter
// with reach 1 looks like it is barely doing anything however large its numbers are.
export const FILTERS = {
  chad: {
    name: 'Chad',
    reach: 4,
    controls: [
      {points: JAW, out: 0.3},
      {points: JAW_CORNERS, out: 0.45, move: [0, 0.08]},
      {points: CHIN, out: 0.18, move: [0, 0.2]},
      {points: CHEEKBONES, out: 0.2, move: [0, -0.06]},
      {points: CHEEK_HOLLOW, out: -0.14},
      {points: BROW, move: [0, 0.1]},
    ],
  },
  alien: {
    name: 'Alien',
    reach: 4,
    controls: [
      {points: TEMPLES, out: 0.3, move: [0, -0.22]},
      {points: EYES, out: 0.1},
      {points: JAW, out: -0.22},
      {points: CHIN, move: [0, -0.12]},
    ],
  },
  chipmunk: {
    name: 'Chipmunk',
    reach: 4,
    controls: [
      {points: CHEEKBONES, out: 0.22, move: [0, 0.1]},
      {points: EYES, out: 0.08},
      {points: CHIN, move: [0, -0.06]},
    ],
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

// ---------- Mesh ----------
// The grid the warp is drawn through. Its vertices never move — only the texture coordinates they
// carry do — so the picture is resampled rather than stretched, and no two triangles can overlap.

export const GRID = 48
export const GRID_BOX = {x0: -2, x1: 2, y0: -2.2, y1: 2.8}

// The anchors move with `reach`; the grid does not. They want opposite things, and only the anchors
// benefit from distance:
//   - anchors far out stop arguing the deformation back down to nothing, which is what makes a
//     filter's numbers mean what they say.
//   - the grid is also the region that gets drawn, so growing it paints over — and resamples —
//     picture the warp never touches. At reach 4 that was most of the canvas, which the integration
//     check catches as a slab of opaque pixels over the video.
export const GRID_REACH = 1

// Where the grid's own edge is faded out, as a fraction of the box. The deformation is tapered to
// exactly nothing by MASK_FROM, so the fade happens entirely over picture the warp has not touched
// — otherwise a border still moving by a fraction of a percent blends warped over unwarped and the
// seam comes straight back. The unit test measures this, and it is how the taper got here.
//
// The taper starts outside the face: a jaw sits at about 0.62 of the box, so beginning at 0.68
// leaves the warp itself at full strength and only flattens what is already nearly still.
export const TAPER_FROM = 0.68
export const MASK_FROM = 0.86
export const MASK_TO = 1

const scaleBox = (box, k) => ({x0: box.x0 * k, x1: box.x1 * k, y0: box.y0 * k, y1: box.y1 * k})

const smoothstep = (edge0, edge1, x) => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

// How far a point sits towards the edge of the box, 0 at the middle and 1 on the border.
export function boxCoord(box, lx, ly) {
  const cx = (box.x0 + box.x1) / 2
  const cy = (box.y0 + box.y1) / 2
  return Math.hypot((lx - cx) / ((box.x1 - box.x0) / 2), (ly - cy) / ((box.y1 - box.y0) / 2))
}
export const anchorBox = (reach = 1) => scaleBox(GRID_BOX, reach)
export const gridBox = (reach = 1) => scaleBox(GRID_BOX, Math.min(reach, GRID_REACH))

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

// ---------- Deformation ----------
// A filter says where landmarks should end up. That is a scattered-data deformation problem and it
// has a standard answer: Moving Least Squares (Schaefer, McPhail & Warren, SIGGRAPH 2006). Each
// point is moved by the single similarity transform that best explains the controls near it, so
// overlapping controls agree rather than stacking — thirteen jaw points asking for 0.3 widen the
// jaw by 0.3, not by four.
//
// It is solved *backwards*: the controls go in as (where it ends up -> where it came from), so
// asking the field about an output pixel answers "which pixel should I sample". A forward warp —
// moving the vertices and leaving the texture put — tears wherever neighbouring cells move
// differently and leaves a hard edge where the moved patch stops. This cannot: every output pixel
// is written exactly once.

const EPS = 1e-8
const ANCHOR_RING = 16

// The filter table read as pairs, plus a ring of anchors told to stay exactly put. Without them MLS
// tends to a global similarity far from its controls rather than to the identity, and the whole
// frame would drift.
export function warpPairs(filter, landmarks, pose, aspect, reach = filter.reach || 1) {
  const from = []
  const to = []
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
      from.push(lx, ly)
      to.push(lx + sideways + mx, ly + my)
    }
  }
  const {x0, x1, y0, y1} = anchorBox(reach)
  for (let i = 0; i < ANCHOR_RING; i++) {
    const angle = (i / ANCHOR_RING) * Math.PI * 2
    const ax = (x0 + x1) / 2 + (Math.cos(angle) * (x1 - x0)) / 2
    const ay = (y0 + y1) / 2 + (Math.sin(angle) * (y1 - y0)) / 2
    from.push(ax, ay)
    to.push(ax, ay)
  }
  const count = to.length / 2
  // Backwards: the deformed positions are the domain, the originals are the range.
  return {p: Float64Array.from(to), q: Float64Array.from(from), n: count, weights: new Float64Array(count)}
}

// MLS similarity deformation at one point, in face units. Returns where to sample from.
export function sourceAt(pairs, vx, vy) {
  const {p, q, n, weights} = pairs
  let sw = 0
  let pwx = 0
  let pwy = 0
  let qwx = 0
  let qwy = 0
  for (let i = 0; i < n; i++) {
    const dx = p[i * 2] - vx
    const dy = p[i * 2 + 1] - vy
    const d2 = dx * dx + dy * dy
    // Landing exactly on a control means the answer is that control, by definition.
    if (d2 < EPS) return [q[i * 2], q[i * 2 + 1]]
    const w = 1 / d2
    weights[i] = w
    sw += w
    pwx += w * p[i * 2]
    pwy += w * p[i * 2 + 1]
    qwx += w * q[i * 2]
    qwy += w * q[i * 2 + 1]
  }
  if (!(sw > 0)) return [vx, vy]
  const psx = pwx / sw
  const psy = pwy / sw
  const qsx = qwx / sw
  const qsy = qwy / sw
  const rx = vx - psx
  const ry = vy - psy

  let mu = 0
  let ax = 0
  let ay = 0
  for (let i = 0; i < n; i++) {
    const phx = p[i * 2] - psx
    const phy = p[i * 2 + 1] - psy
    const w = weights[i]
    mu += w * (phx * phx + phy * phy)
    // The per-control block is a scaled rotation: `s` along the control, `t` across it.
    const s = phx * rx + phy * ry
    const t = phx * ry - phy * rx
    const qhx = q[i * 2] - qsx
    const qhy = q[i * 2 + 1] - qsy
    ax += w * (qhx * s - qhy * t)
    ay += w * (qhx * t + qhy * s)
  }
  if (!(Math.abs(mu) > EPS)) return [vx, vy]
  return [ax / mu + qsx, ay / mu + qsy]
}

// `position` is where a vertex sits (and stays), `uv` is the pixel it should carry there, and
// `local` lets the shader fade the edges. All three are normalized to the video frame.
export function buildMesh(filter, landmarks, aspect, n = GRID, out = null) {
  const pose = facePose(landmarks, aspect)
  if (!pose) return null
  const reach = filter.reach || 1
  const box = gridBox(reach)
  const pairs = warpPairs(filter, landmarks, pose, aspect, reach)
  const count = gridVertexCount(n)
  const mesh = out || {position: new Float32Array(count * 2), uv: new Float32Array(count * 2), local: new Float32Array(count * 2)}
  let at = 0
  for (let row = 0; row <= n; row++) {
    const ly = box.y0 + ((box.y1 - box.y0) * row) / n
    for (let column = 0; column <= n; column++) {
      const lx = box.x0 + ((box.x1 - box.x0) * column) / n
      const [rawX, rawY] = sourceAt(pairs, lx, ly)
      // Distant anchors leave a little movement this far out. Taper it away so the border is exactly
      // still, which is what lets the mask fade without showing.
      const taper = 1 - smoothstep(TAPER_FROM, MASK_FROM, boxCoord(box, lx, ly))
      const sx = lx + (rawX - lx) * taper
      const sy = ly + (rawY - ly) * taper
      const [px, py] = toWorld(pose, lx, ly, aspect)
      const [ux, uy] = toWorld(pose, sx, sy, aspect)
      mesh.position[at] = px
      mesh.position[at + 1] = py
      mesh.uv[at] = ux
      mesh.uv[at + 1] = uy
      mesh.local[at] = lx
      mesh.local[at + 1] = ly
      at += 2
    }
  }
  mesh.pose = pose
  mesh.box = box
  return mesh
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
