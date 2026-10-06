/**
 * Cutting a layer down to a subject matte on the GPU: the layer's colour and
 * alpha times the matte's brightness (white keeps, black removes), or the
 * opposite when inverted. Canvas 2D can't turn brightness into transparency;
 * one small WebGL pass can.
 */

const VERTEX = `#version 300 es
in vec2 pos;
out vec2 uv;
void main() {
  uv = vec2(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  gl_Position = vec4(pos, 0.0, 1.0);
}`

// Both textures arrive premultiplied, so colour and alpha scale together.
const FRAGMENT = `#version 300 es
precision mediump float;
uniform sampler2D layer;
uniform sampler2D matte;
uniform float invert;
in vec2 uv;
out vec4 color;
void main() {
  float m = texture(matte, uv).r;
  m = mix(m, 1.0 - m, invert);
  color = texture(layer, uv) * m;
}`

interface Gpu {
  gl: WebGL2RenderingContext
  canvas: HTMLCanvasElement
  layer: WebGLTexture
  matte: WebGLTexture
  invert: WebGLUniformLocation | null
}

let gpu: Gpu | null | undefined

function setup(): Gpu | null {
  const canvas = document.createElement('canvas')
  const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, preserveDrawingBuffer: false })
  if (!gl) return null
  const shader = (type: number, src: string) => {
    const s = gl.createShader(type)!
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader')
    return s
  }
  try {
    const program = gl.createProgram()!
    gl.attachShader(program, shader(gl.VERTEX_SHADER, VERTEX))
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAGMENT))
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null
    gl.useProgram(program)
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const pos = gl.getAttribLocation(program, 'pos')
    gl.enableVertexAttribArray(pos)
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0)
    const texture = (unit: number, name: string) => {
      const t = gl.createTexture()!
      gl.activeTexture(gl.TEXTURE0 + unit)
      gl.bindTexture(gl.TEXTURE_2D, t)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.uniform1i(gl.getUniformLocation(program, name), unit)
      return t
    }
    const layer = texture(0, 'layer')
    const matte = texture(1, 'matte')
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
    return { gl, canvas, layer, matte, invert: gl.getUniformLocation(program, 'invert') }
  } catch {
    return null
  }
}

/**
 * Cuts `layer` (a canvas, changed in place) down to `matte` — a canvas the same
 * size with the subject in white. Returns false when WebGL isn't available.
 */
export function applyMatte(layer: HTMLCanvasElement, matte: HTMLCanvasElement, invert = false): boolean {
  // Set up on first use — and again after the graphics driver was reset, which loses the context.
  if (gpu === undefined || gpu?.gl.isContextLost()) gpu = setup()
  if (!gpu || gpu.gl.isContextLost()) return false
  const { gl, canvas } = gpu
  const W = layer.width
  const H = layer.height
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W
    canvas.height = H
  }
  gl.viewport(0, 0, W, H)
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, gpu.layer)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, layer)
  gl.activeTexture(gl.TEXTURE1)
  gl.bindTexture(gl.TEXTURE_2D, gpu.matte)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, matte)
  gl.uniform1f(gpu.invert, invert ? 1 : 0)
  gl.clearColor(0, 0, 0, 0)
  gl.clear(gl.COLOR_BUFFER_BIT)
  gl.drawArrays(gl.TRIANGLES, 0, 3)
  const ctx = layer.getContext('2d')!
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalCompositeOperation = 'copy'
  ctx.globalAlpha = 1
  ctx.filter = 'none'
  ctx.drawImage(canvas, 0, 0)
  ctx.restore()
  return true
}
