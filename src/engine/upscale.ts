/**
 * Scaling small pictures up to the viewer. "Sharp" runs contrast-adaptive
 * sharpening (after AMD FidelityFX CAS) on the GPU while it scales, so half-
 * and quarter-resolution previews and renders keep crisp edges instead of
 * looking soft; "smooth" is the browser's high-quality filtering. Without
 * WebGL 2, sharp falls back to smooth.
 */
import type { Upscale } from '@/editor/ui-store'

const VERTEX = `#version 300 es
in vec2 pos;
out vec2 uv;
void main() {
  uv = vec2(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  gl_Position = vec4(pos, 0.0, 1.0);
}`

// Five taps around each output pixel, one source texel apart: the sharpening
// weight shrinks where the neighbourhood is already contrasty or near clipping,
// so edges get crisp without halos and noise isn't boosted.
const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D src;
uniform vec2 texel;
uniform float sharpness;
in vec2 uv;
out vec4 color;
void main() {
  vec3 e = texture(src, uv).rgb;
  vec3 b = texture(src, uv + vec2(0.0, -texel.y)).rgb;
  vec3 d = texture(src, uv + vec2(-texel.x, 0.0)).rgb;
  vec3 f = texture(src, uv + vec2(texel.x, 0.0)).rgb;
  vec3 h = texture(src, uv + vec2(0.0, texel.y)).rgb;
  vec3 mn = min(e, min(min(b, d), min(f, h)));
  vec3 mx = max(e, max(max(b, d), max(f, h)));
  vec3 amp = sqrt(clamp(min(mn, 1.0 - mx) / max(mx, vec3(1e-4)), 0.0, 1.0));
  vec3 w = amp * (-1.0 / mix(8.0, 5.0, sharpness));
  vec3 rgb = (e + (b + d + f + h) * w) / (1.0 + 4.0 * w);
  color = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}`

interface Gpu {
  gl: WebGL2RenderingContext
  canvas: HTMLCanvasElement
  texture: WebGLTexture
  texel: WebGLUniformLocation | null
  sharpness: WebGLUniformLocation | null
}

let gpu: Gpu | null | undefined

function setup(): Gpu | null {
  const canvas = document.createElement('canvas')
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, premultipliedAlpha: false, preserveDrawingBuffer: false })
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
    // One triangle covering the viewport.
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const pos = gl.getAttribLocation(program, 'pos')
    gl.enableVertexAttribArray(pos)
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0)
    const texture = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.uniform1i(gl.getUniformLocation(program, 'src'), 0)
    return { gl, canvas, texture, texel: gl.getUniformLocation(program, 'texel'), sharpness: gl.getUniformLocation(program, 'sharpness') }
  } catch {
    return null
  }
}

type Source = HTMLCanvasElement | OffscreenCanvas | VideoFrame | HTMLVideoElement | ImageBitmap

/**
 * Draws `src` (`sw`×`sh` pixels) over the whole of `ctx`'s canvas, scaled up
 * with `mode`. Returns false if nothing could be drawn.
 */
export function drawUpscaled(ctx: CanvasRenderingContext2D, src: Source, sw: number, sh: number, mode: Upscale): boolean {
  const W = ctx.canvas.width
  const H = ctx.canvas.height
  // Sharpening only helps when there's real enlargement.
  if (mode === 'sharp' && (W > sw * 1.2 || H > sh * 1.2)) {
    // Set up on first use — and again after the graphics driver was reset, which loses the context.
    if (gpu === undefined || gpu?.gl.isContextLost()) gpu = setup()
    if (gpu && !gpu.gl.isContextLost()) {
      const { gl, canvas } = gpu
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W
        canvas.height = H
      }
      gl.viewport(0, 0, W, H)
      gl.bindTexture(gl.TEXTURE_2D, gpu.texture)
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src)
      } catch {
        gpu = null
        return drawUpscaled(ctx, src, sw, sh, 'smooth')
      }
      gl.uniform2f(gpu.texel, 1 / sw, 1 / sh)
      // Lower resolutions lose more detail: sharpen them a little harder.
      gl.uniform1f(gpu.sharpness, Math.min(1, 0.35 + 0.25 * Math.log2(Math.max(W / sw, H / sh))))
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      ctx.drawImage(canvas, 0, 0, W, H)
      return true
    }
  }
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(src, 0, 0, sw, sh, 0, 0, W, H)
  return true
}
