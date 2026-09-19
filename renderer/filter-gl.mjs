// Drawing the warp. One WebGL context, one program, one draw call per face.
//
// The video goes in as a texture and comes out through a grid of triangles whose corners have been
// moved by filters.mjs. Each vertex carries the texture coordinate it started at, so the picture
// stretches between them. A mask fades the edges to transparent, and because the displacement has
// already fallen to zero out there, the filtered face blends into the untouched video underneath
// with no seam to see.
//
// The per-frame cost is one texture upload and a few thousand triangles, which is nothing. The work
// worth avoiding is reading pixels back to the CPU, and nothing here does.

import {GRID, buildMesh, gridIndices, gridVertexCount} from './filters.mjs'

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
uniform vec3 uGrade;   // saturation, contrast, brightness
uniform float uGraded;
out vec4 outColor;

void main() {
  // Outside the picture there is nothing to sample, and stretching the edge pixel would smear.
  if (vUv.x < 0.0 || vUv.x > 1.0 || vUv.y < 0.0 || vUv.y > 1.0) discard;

  // An ellipse around the head, a little taller than it is wide and sitting slightly low, because
  // that is where a face is relative to the eyes. It fades rather than stopping, which is what
  // makes the filtered region invisible against the video behind it.
  float q = length(vec2(vLocal.x / 1.75, (vLocal.y - 0.45) / 2.15));
  float mask = 1.0 - smoothstep(0.72, 1.0, q);
  if (mask <= 0.0) discard;

  vec3 color = texture(uTexture, vUv).rgb;
  if (uGraded > 0.5) {
    float grey = dot(color, vec3(0.2126, 0.7152, 0.0722));
    vec3 graded = mix(vec3(grey), color, uGrade.x);
    graded = (graded - 0.5) * uGrade.y + 0.5;
    graded *= uGrade.z;
    // Fade the grade out with the mask too, so there is never a visible edge to the colour change.
    color = mix(color, clamp(graded, 0.0, 1.0), mask);
  }
  outColor = vec4(color, mask * uOpacity);
}`

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

export class FilterRenderer {
  constructor(canvas) {
    this.canvas = canvas
    // No `desynchronized`. It looks like a free latency win, but a desynchronized canvas is
    // composited as fully opaque whatever its alpha says — readPixels still reports the
    // transparency, so the mistake is invisible until the filter paints a black rectangle over
    // the whole video.
    this.gl = canvas.getContext('webgl2', {alpha: true, premultipliedAlpha: false, antialias: true})
    if (!this.gl) throw new Error('This computer cannot run the face filters')
    const gl = this.gl
    const program = gl.createProgram()
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX))
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT))
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Could not build the filter shader: ${gl.getProgramInfoLog(program)}`)
    this.program = program
    this.uniforms = {
      texture: gl.getUniformLocation(program, 'uTexture'),
      opacity: gl.getUniformLocation(program, 'uOpacity'),
      grade: gl.getUniformLocation(program, 'uGrade'),
      graded: gl.getUniformLocation(program, 'uGraded'),
    }

    this.vao = gl.createVertexArray()
    gl.bindVertexArray(this.vao)
    this.buffers = {}
    for (const [name, size] of [['aPosition', 2], ['aUv', 2], ['aLocal', 2]]) {
      const buffer = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
      gl.bufferData(gl.ARRAY_BUFFER, gridVertexCount() * size * 4, gl.DYNAMIC_DRAW)
      const location = gl.getAttribLocation(program, name)
      gl.enableVertexAttribArray(location)
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0)
      this.buffers[name] = buffer
    }
    // The triangulation never changes, so it is uploaded once and reused for every face.
    const indices = gridIndices()
    this.indexCount = indices.length
    const indexBuffer = gl.createBuffer()
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW)
    gl.bindVertexArray(null)

    this.texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    for (const axis of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, axis, gl.CLAMP_TO_EDGE)
    for (const filter of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, filter, gl.LINEAR)

    // Reused between faces and frames so a steady state allocates nothing.
    const count = gridVertexCount()
    this.mesh = {position: new Float32Array(count * 2), uv: new Float32Array(count * 2), local: new Float32Array(count * 2)}
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

  // `rect` is where the picture sits on the stage, in device pixels from the top left.
  draw(source, faces, filter, rect) {
    const gl = this.gl
    this.clear()
    if (!faces.length || !source?.videoWidth) return
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)

    // WebGL counts from the bottom, the stage counts from the top.
    gl.viewport(rect.x, this.canvas.height - (rect.y + rect.height), rect.width, rect.height)
    gl.useProgram(this.program)
    gl.bindVertexArray(this.vao)
    gl.enable(gl.BLEND)
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.uniform1i(this.uniforms.texture, 0)
    const grade = filter.grade
    gl.uniform1f(this.uniforms.graded, grade ? 1 : 0)
    gl.uniform3f(this.uniforms.grade, grade?.saturation ?? 1, grade?.contrast ?? 1, grade?.brightness ?? 1)

    const aspect = source.videoWidth / source.videoHeight
    for (const face of faces) {
      const mesh = buildMesh(filter, face.landmarks, aspect, GRID, this.mesh)
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
    gl.deleteTexture(this.texture)
    gl.deleteVertexArray(this.vao)
    for (const buffer of Object.values(this.buffers)) gl.deleteBuffer(buffer)
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
}
