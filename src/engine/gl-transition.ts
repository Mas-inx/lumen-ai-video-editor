/**
 * Smart transitions on the GPU (WebGL2): each shot is composited on its own,
 * then one shader carries the first into the second using what was measured
 * at the cut (editor/types.ts TransitionMatch):
 *
 * - Morph: both frames warp along the flow field between them while they
 *   cross — the outgoing content slides to where the incoming has it.
 * - Zoom Through: into the outgoing shot's subject, out of the incoming one's,
 *   with a zoom blur while it's fast.
 * - Whip Pan: the shots move as one strip in the camera's own direction,
 *   motion-blurred along it.
 * - Luma Fade: the incoming shot appears through its brightest parts first.
 * - Colour Match: the incoming shot starts in the outgoing one's colours and
 *   eases into its own.
 *
 * Without a measurement each falls back to neutral settings. Works in
 * premultiplied alpha, so see-through parts stay see-through.
 */
import { curveTable } from '@/editor/color-math'
import type { TransitionKind, TransitionMatch } from '@/editor/types'
import { decodeFlow, whipDirection } from './cut-match'

const KINDS: Partial<Record<TransitionKind, number>> = { morph: 0, through: 1, whip: 2, luma: 3, match: 4 }

const VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`

const FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_a;
uniform sampler2D u_b;
uniform sampler2D u_flow;   // offsets (fractions of the frame) from the outgoing frame to the incoming one
uniform sampler2D u_curve;  // 256 x 1: curves that give the incoming shot the outgoing one's colours
uniform int u_kind;
uniform float u_p;
uniform bool u_hasFlow;
uniform bool u_hasCurve;
uniform vec2 u_from;
uniform vec2 u_to;
uniform vec2 u_dir;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

float ease(float t) { return t * t * (3.0 - 2.0 * t); }
// A different offset per pixel for the blur samples: smooth blur instead of stepped copies.
float jitter(vec2 uv) { return fract(sin(dot(uv, vec2(12.9898, 78.233))) * 43758.5453); }
vec3 unpremultiply(vec4 c) { return c.rgb / max(c.a, 1e-4); }

void main() {
  vec2 uv = v_uv;
  float p = clamp(u_p, 0.0, 1.0);
  vec4 col;
  if (u_kind == 0) {
    vec2 f = u_hasFlow ? texture(u_flow, uv).xy : vec2(0.0);
    float e = ease(p);
    // The outgoing content travels to where the incoming frame has it; the incoming one starts where the outgoing had it.
    vec4 a = texture(u_a, uv - f * e);
    vec4 b = texture(u_b, uv + f * (1.0 - e));
    col = mix(a, b, smoothstep(0.25, 0.75, p));
  } else if (u_kind == 1) {
    float tin = clamp(p * 2.0, 0.0, 1.0);
    float tout = clamp(p * 2.0 - 1.0, 0.0, 1.0);
    float sa = mix(1.0, 5.0, tin * tin * tin);
    float sb = mix(5.0, 1.0, 1.0 - pow(1.0 - tout, 3.0));
    float blurA = 0.09 * sin(3.14159 * tin);
    float blurB = 0.09 * sin(3.14159 * tout);
    vec4 a = vec4(0.0);
    vec4 b = vec4(0.0);
    float j = jitter(uv);
    for (int i = 0; i < 16; i++) {
      float k = (float(i) + j) / 16.0;
      a += texture(u_a, u_from + (uv - u_from) / (sa * (1.0 + blurA * k)));
      b += texture(u_b, u_to + (uv - u_to) / (sb * (1.0 + blurB * k)));
    }
    col = mix(a / 16.0, b / 16.0, smoothstep(0.44, 0.56, p));
  } else if (u_kind == 2) {
    float e = ease(p);
    float speed = 6.0 * p * (1.0 - p);
    float j = jitter(uv);
    vec4 sum = vec4(0.0);
    for (int i = 0; i < 32; i++) {
      float k = ((float(i) + j) / 32.0 - 0.5) * 0.3 * speed;
      // One strip: the outgoing frame, and the incoming one a frame further along the camera's way.
      vec2 s = uv + u_dir * (e + k);
      bool inA = s.x >= 0.0 && s.x <= 1.0 && s.y >= 0.0 && s.y <= 1.0;
      sum += inA ? texture(u_a, s) : texture(u_b, s - u_dir);
    }
    col = sum / 32.0;
  } else if (u_kind == 3) {
    vec4 a = texture(u_a, uv);
    vec4 b = texture(u_b, uv);
    float lb = dot(unpremultiply(b), LUMA);
    float edge = 1.15 - p * 1.5;
    col = mix(a, b, smoothstep(edge - 0.18, edge + 0.18, lb));
  } else {
    vec4 a = texture(u_a, uv);
    vec4 b = texture(u_b, uv);
    if (u_hasCurve) {
      vec3 bu = clamp(unpremultiply(b), 0.0, 1.0);
      vec3 m = vec3(texture(u_curve, vec2(bu.r * 0.99609375 + 0.001953125, 0.5)).r,
                    texture(u_curve, vec2(bu.g * 0.99609375 + 0.001953125, 0.5)).g,
                    texture(u_curve, vec2(bu.b * 0.99609375 + 0.001953125, 0.5)).b);
      bu = mix(bu, m, 1.0 - smoothstep(0.3, 1.0, p));
      b = vec4(bu * b.a, b.a);
    }
    col = mix(a, b, ease(p));
  }
  outColor = col;
}`

interface Gl {
  canvas: HTMLCanvasElement
  gl: WebGL2RenderingContext
  loc: Record<string, WebGLUniformLocation | null>
  a: WebGLTexture
  b: WebGLTexture
  flow: WebGLTexture
  curve: WebGLTexture
}

let state: Gl | null = null
let failed = false
let flowKey = ''
let curveKey = ''

function texture(gl: WebGL2RenderingContext) {
  const t = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, t)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return t
}

function init(): Gl | null {
  if (state && !state.gl.isContextLost()) return state
  if (failed) return null
  flowKey = ''
  curveKey = ''
  const canvas = document.createElement('canvas')
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false })
  if (!gl) return null
  const shader = (type: number, src: string) => {
    const s = gl.createShader(type)!
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`Transition shader: ${gl.getShaderInfoLog(s)}`)
    return s
  }
  const program = gl.createProgram()!
  gl.attachShader(program, shader(gl.VERTEX_SHADER, VERT))
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAG))
  gl.bindAttribLocation(program, 0, 'a_pos')
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Transition shader: ${gl.getProgramInfoLog(program)}`)
  gl.useProgram(program)
  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
  const names = ['u_a', 'u_b', 'u_flow', 'u_curve', 'u_kind', 'u_p', 'u_hasFlow', 'u_hasCurve', 'u_from', 'u_to', 'u_dir']
  const loc = Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(program, n)]))
  const flow = texture(gl)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16F, 1, 1, 0, gl.RG, gl.FLOAT, new Float32Array([0, 0]))
  const curve = texture(gl)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 2, 1, 0, gl.RGBA, gl.FLOAT, new Float32Array([0, 0, 0, 1, 1, 1, 1, 1]))
  state = { canvas, gl, loc, a: texture(gl), b: texture(gl), flow, curve }
  gl.uniform1i(loc.u_a, 0)
  gl.uniform1i(loc.u_b, 1)
  gl.uniform1i(loc.u_flow, 2)
  gl.uniform1i(loc.u_curve, 3)
  return state
}

const smart = (kind: TransitionKind) => KINDS[kind] !== undefined

/**
 * Draws smart transition `kind` at progress `p` (0..1) from shot `a` to shot
 * `b` (two canvases the same size) and returns a canvas with the result,
 * premultiplied and ready to draw; null without WebGL2 or for other kinds.
 */
export function gpuTransition(kind: TransitionKind, p: number, a: HTMLCanvasElement, b: HTMLCanvasElement, match?: TransitionMatch): HTMLCanvasElement | null {
  if (!smart(kind)) return null
  let s: Gl | null
  try {
    s = init()
  } catch (err) {
    failed = true
    console.warn('Smart transitions are unavailable on this graphics card', err)
    return null
  }
  if (!s) return null
  const { gl, loc } = s
  const W = a.width
  const H = a.height
  if (s.canvas.width !== W || s.canvas.height !== H) {
    s.canvas.width = W
    s.canvas.height = H
  }
  gl.viewport(0, 0, W, H)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, s.a)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, a)
  gl.activeTexture(gl.TEXTURE1)
  gl.bindTexture(gl.TEXTURE_2D, s.b)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, b)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)

  const flow = match?.flow
  gl.activeTexture(gl.TEXTURE2)
  gl.bindTexture(gl.TEXTURE_2D, s.flow)
  if (flow && flow.data !== flowKey) {
    const data = decodeFlow(flow.data)
    if (data.length >= flow.w * flow.h * 2) {
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16F, flow.w, flow.h, 0, gl.RG, gl.FLOAT, data.subarray(0, flow.w * flow.h * 2))
      flowKey = flow.data
    }
  }
  gl.uniform1i(loc.u_hasFlow, flow && flowKey === flow.data ? 1 : 0)

  const color = match?.color
  gl.activeTexture(gl.TEXTURE3)
  gl.bindTexture(gl.TEXTURE_2D, s.curve)
  const key = color ? JSON.stringify(color) : ''
  if (color && key !== curveKey) {
    const tables = [color.red, color.green, color.blue].map((pts) => curveTable(pts, 256))
    const data = new Float32Array(256 * 4)
    for (let i = 0; i < 256; i++) data.set([tables[0][i], tables[1][i], tables[2][i], 1], i * 4)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 256, 1, 0, gl.RGBA, gl.FLOAT, data)
    curveKey = key
  }
  gl.uniform1i(loc.u_hasCurve, color ? 1 : 0)

  gl.uniform1i(loc.u_kind, KINDS[kind]!)
  gl.uniform1f(loc.u_p, p)
  gl.uniform2f(loc.u_from, match?.from?.x ?? 0.5, match?.from?.y ?? 0.45)
  gl.uniform2f(loc.u_to, match?.to?.x ?? 0.5, match?.to?.y ?? 0.45)
  const [dx, dy] = whipDirection(match?.motion)
  gl.uniform2f(loc.u_dir, dx, dy)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  gl.clearColor(0, 0, 0, 0)
  gl.clear(gl.COLOR_BUFFER_BIT)
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  return s.canvas
}
