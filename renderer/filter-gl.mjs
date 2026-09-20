// Drawing the warp. One WebGL context, one program, one draw call per face.
//
// The video goes in as a texture and comes out through a grid of triangles that never move. Each
// vertex carries the texture coordinate the deformation says it should sample, so the picture is
// resampled rather than stretched: no cell can overlap its neighbour, and there is no edge where a
// moved patch stops. A mask fades the grid's own border, and because the deformation is already the
// identity out there, the fade is invisible.
//
// The per-frame cost is one texture upload and a few thousand triangles, which is nothing. The
// deformation itself is the expensive part, so it is cached per face and only redone when new
// landmarks arrive — detection runs at 15Hz, the screen at 60.

import {GRID, LM, MASK_FROM, MASK_TO, MAX_FACES, buildMesh, gridBox, gridIndices, gridVertexCount} from './filters.mjs'
import {faceConnections} from './faces.mjs'

const VERTEX = `#version 300 es
in vec2 aPosition;
in vec2 aUv;
in vec2 aLocal;
out vec2 vUv;
out vec2 vLocal;
void main() {
  vUv = aUv;
  vLocal = aLocal;
  // Positions arrive normalized to the video picture, with y downwards as the landmarks have it.
  gl_Position = vec4(aPosition.x * 2.0 - 1.0, 1.0 - aPosition.y * 2.0, 0.0, 1.0);
}`

const FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
in vec2 vLocal;
uniform sampler2D uTexture;
uniform float uOpacity;
uniform vec4 uBox;   // centre x, centre y, radius x, radius y — the grid's own extent
out vec4 outColor;

void main() {
  // Outside the picture there is nothing to sample, and stretching the edge pixel would smear.
  if (vUv.x < 0.0 || vUv.x > 1.0 || vUv.y < 0.0 || vUv.y > 1.0) discard;

  // Only there to keep the grid from showing as a rectangle. The warp is the identity this far out,
  // so what is drawn here equals what is underneath and the fade cannot be seen.
  float q = length((vLocal - uBox.xy) / uBox.zw);
  float mask = 1.0 - smoothstep(${MASK_FROM.toFixed(4)}, ${MASK_TO.toFixed(4)}, q);
  if (mask <= 0.0) discard;

  // Premultiplied, and the context is told so. Blending against a transparent black buffer
  // produces colour*alpha whatever the shader writes, so a canvas declaring premultipliedAlpha
  // false gets multiplied by alpha a second time at composite — colour*alpha*alpha. That is
  // invisible in the middle of the mask and a black halo everywhere it fades.
  float a = mask * uOpacity;
  outColor = vec4(texture(uTexture, vUv).rgb * a, a);
}`

// The debug mesh. Landmarks arrive normalized to the video picture, exactly like the warp's
// positions, so they go straight in as vertices and the viewport does the rest. One program draws
// both the tessellation (as lines) and the landmarks (as round points).
const MESH_VERTEX = `#version 300 es
in vec2 aPoint;
uniform float uSize;
void main() {
  gl_Position = vec4(aPoint.x * 2.0 - 1.0, 1.0 - aPoint.y * 2.0, 0.0, 1.0);
  gl_PointSize = uSize;
}`

const MESH_FRAGMENT = `#version 300 es
precision highp float;
uniform vec4 uColor;
uniform float uRound;
out vec4 outColor;

void main() {
  float a = uColor.a;
  // gl_PointCoord only means anything in a point, so the rounding is switched off for the lines.
  if (uRound > 0.5) a *= 1.0 - smoothstep(0.34, 0.5, length(gl_PointCoord - vec2(0.5)));
  if (a <= 0.0) discard;
  // Premultiplied, for the same reason as the warp's shader.
  outColor = vec4(uColor.rgb * a, a);
}`

// Cyan mesh, warm dots, and the handful of landmarks the pose fit is built from picked out in
// white so a bad roll or scale is visible at a glance rather than inferred from a wrong-looking warp.
const MESH_LINE = [0.22, 0.85, 0.85]
const MESH_DOT = [1.0, 0.72, 0.2]
const MESH_KEY = [1.0, 1.0, 1.0]
const KEY_POINTS = Object.values(LM)
// Dot sizes are given for a 540-tall picture and scaled with it, so the mesh reads the same on a
// small window and a fullscreen one.
const DOT_REFERENCE = 540

function compile(gl, type, source) {
  const shader = gl.createShader(type)
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error(`Could not build the filter shader: ${log}`)
  }
  return shader
}

function link(gl, vertex, fragment) {
  const program = gl.createProgram()
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertex))
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragment))
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Could not build the filter shader: ${gl.getProgramInfoLog(program)}`)
  return program
}

const emptyMesh = (n) => ({
  position: new Float32Array(gridVertexCount(n) * 2),
  uv: new Float32Array(gridVertexCount(n) * 2),
  local: new Float32Array(gridVertexCount(n) * 2),
})

export class FilterRenderer {
  constructor(canvas, grid = GRID) {
    this.canvas = canvas
    this.grid = grid
    // No `desynchronized`. It looks like a free latency win, but a desynchronized canvas is
    // composited as fully opaque whatever its alpha says — readPixels still reports the
    // transparency, so the mistake is invisible until the filter paints a black rectangle over
    // the whole video.
    this.gl = canvas.getContext('webgl2', {alpha: true, premultipliedAlpha: true, antialias: true})
    if (!this.gl) throw new Error('This computer cannot run the face filters')
    const gl = this.gl
    const program = link(gl, VERTEX, FRAGMENT)
    this.program = program
    this.uniforms = {
      texture: gl.getUniformLocation(program, 'uTexture'),
      opacity: gl.getUniformLocation(program, 'uOpacity'),
      box: gl.getUniformLocation(program, 'uBox'),
    }

    this.vao = gl.createVertexArray()
    gl.bindVertexArray(this.vao)
    this.buffers = {}
    for (const [name, size] of [['aPosition', 2], ['aUv', 2], ['aLocal', 2]]) {
      const buffer = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
      gl.bufferData(gl.ARRAY_BUFFER, gridVertexCount(grid) * size * 4, gl.DYNAMIC_DRAW)
      const location = gl.getAttribLocation(program, name)
      gl.enableVertexAttribArray(location)
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0)
      this.buffers[name] = buffer
    }
    // The triangulation never changes, so it is uploaded once and reused for every face.
    const indices = gridIndices(grid)
    this.indexCount = indices.length
    const indexBuffer = gl.createBuffer()
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW)
    gl.bindVertexArray(null)

    this.texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    for (const axis of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, axis, gl.CLAMP_TO_EDGE)
    for (const filter of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, filter, gl.LINEAR)

    // One mesh per face, reused between frames. A slot is rebuilt only when it is handed landmarks
    // it has not already solved, so a steady state allocates nothing and solves nothing.
    this.slots = Array.from({length: MAX_FACES}, () => ({landmarks: null, filter: null, mesh: emptyMesh(grid)}))

    // The debug mesh: its own program, one buffer it grows into, and a cache of the line soup per
    // face so a 2500-edge tessellation is rebuilt when detection moves and not sixty times a second.
    this.meshProgram = link(gl, MESH_VERTEX, MESH_FRAGMENT)
    this.meshUniforms = {
      size: gl.getUniformLocation(this.meshProgram, 'uSize'),
      color: gl.getUniformLocation(this.meshProgram, 'uColor'),
      round: gl.getUniformLocation(this.meshProgram, 'uRound'),
    }
    this.meshVao = gl.createVertexArray()
    gl.bindVertexArray(this.meshVao)
    this.meshBuffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, this.meshBuffer)
    const point = gl.getAttribLocation(this.meshProgram, 'aPoint')
    gl.enableVertexAttribArray(point)
    gl.vertexAttribPointer(point, 2, gl.FLOAT, false, 0, 0)
    gl.bindVertexArray(null)
    this.meshCapacity = 0
    this.meshCache = Array.from({length: MAX_FACES}, () => ({landmarks: null, lines: null, dots: null, keys: null}))
  }

  // Grows the one buffer rather than making a new one per draw, and leaves it bound.
  uploadPoints(data) {
    const gl = this.gl
    gl.bindBuffer(gl.ARRAY_BUFFER, this.meshBuffer)
    if (data.length > this.meshCapacity) {
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW)
      this.meshCapacity = data.length
    } else {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data)
    }
    return data.length / 2
  }

  resize(width, height) {
    if (this.canvas.width === width && this.canvas.height === height) return
    Object.assign(this.canvas, {width, height})
  }

  clear() {
    const gl = this.gl
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }

  // The mesh for this face, solved again only if these exact landmarks have not been seen.
  meshFor(face, filter, aspect, index) {
    const slot = this.slots[index] || this.slots[this.slots.length - 1]
    if (slot.landmarks === face.landmarks && slot.filter === filter && slot.mesh.pose) return slot.mesh
    const mesh = buildMesh(filter, face.landmarks, aspect, this.grid, slot.mesh)
    if (!mesh) return null
    slot.landmarks = face.landmarks
    slot.filter = filter
    return mesh
  }

  // The three vertex arrays this face's mesh needs, rebuilt only when detection has moved.
  pointsFor(face, index) {
    const cached = this.meshCache[index] || this.meshCache[this.meshCache.length - 1]
    if (cached.landmarks === face.landmarks) return cached
    const landmarks = face.landmarks
    const edges = faceConnections()
    const lines = new Float32Array(edges.length * 4)
    let at = 0
    for (const edge of edges) {
      const from = landmarks[edge.start]
      const to = landmarks[edge.end]
      if (!from || !to) continue
      lines[at++] = from.x
      lines[at++] = from.y
      lines[at++] = to.x
      lines[at++] = to.y
    }
    const dots = new Float32Array(landmarks.length * 2)
    for (let i = 0; i < landmarks.length; i++) {
      dots[i * 2] = landmarks[i].x
      dots[i * 2 + 1] = landmarks[i].y
    }
    const keys = new Float32Array(KEY_POINTS.length * 2)
    let keyAt = 0
    for (const i of KEY_POINTS) {
      const landmark = landmarks[i]
      if (!landmark) continue
      keys[keyAt++] = landmark.x
      keys[keyAt++] = landmark.y
    }
    Object.assign(cached, {landmarks, lines: lines.subarray(0, at), dots, keys: keys.subarray(0, keyAt)})
    return cached
  }

  // Draws what the detector found instead of a warp: MediaPipe's tessellation as lines, a dot on
  // every landmark, and the pose landmarks picked out. Nothing here samples the video, so it says
  // where detection thinks the face is even when the warp is going wrong.
  drawMesh(faces, rect) {
    const gl = this.gl
    gl.useProgram(this.meshProgram)
    gl.bindVertexArray(this.meshVao)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    const scale = Math.max(0.6, Math.min(rect.width, rect.height) / DOT_REFERENCE)
    for (let i = 0; i < faces.length; i++) {
      const face = faces[i]
      const {lines, dots, keys} = this.pointsFor(face, i)
      gl.uniform1f(this.meshUniforms.round, 0)
      gl.uniform1f(this.meshUniforms.size, 1)
      if (lines.length) {
        gl.uniform4f(this.meshUniforms.color, ...MESH_LINE, 0.55 * face.opacity)
        gl.drawArrays(gl.LINES, 0, this.uploadPoints(lines))
      }
      gl.uniform1f(this.meshUniforms.round, 1)
      gl.uniform1f(this.meshUniforms.size, 3 * scale)
      gl.uniform4f(this.meshUniforms.color, ...MESH_DOT, 0.95 * face.opacity)
      gl.drawArrays(gl.POINTS, 0, this.uploadPoints(dots))
      if (keys.length) {
        gl.uniform1f(this.meshUniforms.size, 7 * scale)
        gl.uniform4f(this.meshUniforms.color, ...MESH_KEY, face.opacity)
        gl.drawArrays(gl.POINTS, 0, this.uploadPoints(keys))
      }
    }
    gl.bindVertexArray(null)
  }

  // `rect` is where the picture sits on the stage, in device pixels from the top left.
  draw(source, faces, filter, rect) {
    const gl = this.gl
    this.clear()
    if (!faces.length || !source?.videoWidth) return
    // WebGL counts from the bottom, the stage counts from the top.
    gl.viewport(rect.x, this.canvas.height - (rect.y + rect.height), rect.width, rect.height)
    if (filter.debug) return this.drawMesh(faces, rect)
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)

    gl.useProgram(this.program)
    gl.bindVertexArray(this.vao)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.uniform1i(this.uniforms.texture, 0)
    const box = gridBox(filter.reach || 1)
    gl.uniform4f(this.uniforms.box, (box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2, (box.x1 - box.x0) / 2, (box.y1 - box.y0) / 2)

    const aspect = source.videoWidth / source.videoHeight
    for (let i = 0; i < faces.length; i++) {
      const face = faces[i]
      const mesh = this.meshFor(face, filter, aspect, i)
      if (!mesh) continue
      for (const [name, data] of [['aPosition', mesh.position], ['aUv', mesh.uv], ['aLocal', mesh.local]]) {
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers[name])
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, data)
      }
      gl.uniform1f(this.uniforms.opacity, face.opacity)
      gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0)
    }
    gl.bindVertexArray(null)
  }

  destroy() {
    const gl = this.gl
    gl.deleteProgram(this.program)
    gl.deleteProgram(this.meshProgram)
    gl.deleteTexture(this.texture)
    gl.deleteVertexArray(this.vao)
    gl.deleteVertexArray(this.meshVao)
    gl.deleteBuffer(this.meshBuffer)
    for (const buffer of Object.values(this.buffers)) gl.deleteBuffer(buffer)
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
}
