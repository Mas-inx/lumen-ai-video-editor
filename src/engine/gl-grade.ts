/**
 * The GPU grade: one WebGL2 fragment shader that keys and colours a clip's
 * layer, per pixel —
 *
 *   sharpen → key (chroma / luma, with spill suppression) → temperature & tint
 *   → exposure, contrast, saturation, mono → curves → lift / gamma / gain
 *   → HSL bands → 3D LUT
 *
 * The basic sliders do exactly what the CSS-filter path does, so a clip looks
 * the same whether or not it needs this pass. Only clips that use curves,
 * wheels, HSL, a LUT, a key or sharpening come through here.
 */
import { curveTable, hasAdvancedGrade, isIdentityCurve, wheelParams } from '@/editor/color-math'
import { base64ToBytes } from './fonts'
import type { Clip, ColorGrade, Effect, Project } from '@/editor/types'

const VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`

const FRAG = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_image;
uniform vec2 u_texel;
uniform float u_sharpen;

uniform int u_keyMode;          // 0 none, 1 chroma, 2 luma
uniform vec3 u_keyColor;
uniform vec4 u_key;             // tolerance, softness, spill, amount (0..1)
uniform vec3 u_luma;            // threshold, softness, invert

uniform vec4 u_temp;            // soft-light wash colour + strength
uniform vec4 u_tint;
uniform vec4 u_basic;           // brightness, contrast, saturation, grayscale (CSS filter numbers)

uniform bool u_hasCurves;
uniform sampler2D u_curves;     // 256 x 1, RGBA = master, red, green, blue

uniform bool u_hasWheels;
uniform vec3 u_lift;
uniform vec3 u_gamma;
uniform vec3 u_gain;

uniform bool u_hasHsl;
uniform vec3 u_hsl[8];          // hue shift (deg), saturation, luminance (-1..1) per band

uniform float u_lutAmount;
uniform float u_lutSize;
uniform sampler3D u_lut;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
const float BANDS[8] = float[8](0.0, 30.0, 60.0, 120.0, 180.0, 240.0, 270.0, 300.0);

float softLight(float b, float s) {
  if (s <= 0.5) return b - (1.0 - 2.0 * s) * b * (1.0 - b);
  float d = b <= 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b);
  return b + (2.0 * s - 1.0) * (d - b);
}

vec3 wash(vec3 c, vec4 w) {
  if (w.a <= 0.0) return c;
  vec3 s = vec3(softLight(c.r, w.r), softLight(c.g, w.g), softLight(c.b, w.b));
  return mix(c, s, w.a);
}

// The CSS saturate() / grayscale() matrix.
vec3 saturateCss(vec3 c, float s) {
  mat3 m = mat3(
    0.2126 + 0.7874 * s, 0.2126 - 0.2126 * s, 0.2126 - 0.2126 * s,
    0.7152 - 0.7152 * s, 0.7152 + 0.2848 * s, 0.7152 - 0.7152 * s,
    0.0722 - 0.0722 * s, 0.0722 - 0.0722 * s, 0.0722 + 0.9278 * s
  );
  return m * c;
}

vec3 rgb2hsl(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float l = (mx + mn) * 0.5;
  float d = mx - mn;
  if (d < 1e-5) return vec3(0.0, 0.0, l);
  float s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn);
  float h;
  if (mx == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
  else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
  else h = (c.r - c.g) / d + 4.0;
  return vec3(h * 60.0, s, l);
}

float hue2rgb(float p, float q, float t) {
  t = fract(t);
  if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
  if (t < 0.5) return q;
  if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
  return p;
}

vec3 hsl2rgb(vec3 h) {
  if (h.y <= 0.0) return vec3(h.z);
  float q = h.z < 0.5 ? h.z * (1.0 + h.y) : h.z + h.y - h.z * h.y;
  float p = 2.0 * h.z - q;
  float t = h.x / 360.0;
  return vec3(hue2rgb(p, q, t + 1.0 / 3.0), hue2rgb(p, q, t), hue2rgb(p, q, t - 1.0 / 3.0));
}

// How much a hue belongs to band i: 1 at its centre, fading to 0 at the neighbouring bands.
float bandWeight(float hue, int i) {
  float c = BANDS[i];
  float prev = BANDS[(i + 7) % 8];
  float next = BANDS[(i + 1) % 8];
  float d = mod(hue - c + 540.0, 360.0) - 180.0;
  float span = d < 0.0 ? mod(c - prev + 360.0, 360.0) : mod(next - c + 360.0, 360.0);
  return clamp(1.0 - abs(d) / span, 0.0, 1.0);
}

void main() {
  vec4 src = texture(u_image, v_uv);
  vec3 c = src.rgb;
  float a = src.a;

  if (u_sharpen > 0.0) {
    vec3 n = texture(u_image, v_uv + vec2(u_texel.x, 0.0)).rgb + texture(u_image, v_uv - vec2(u_texel.x, 0.0)).rgb
           + texture(u_image, v_uv + vec2(0.0, u_texel.y)).rgb + texture(u_image, v_uv - vec2(0.0, u_texel.y)).rgb;
    c = clamp(c + (c - n * 0.25) * u_sharpen * 2.0, 0.0, 1.0);
  }

  if (u_keyMode == 1) {
    // Distance from the key colour in the chroma plane (YCbCr), so light and shade on the screen key alike.
    vec2 cc = vec2(dot(c, vec3(-0.1146, -0.3854, 0.5)), dot(c, vec3(0.5, -0.4542, -0.0458)));
    vec2 kc = vec2(dot(u_keyColor, vec3(-0.1146, -0.3854, 0.5)), dot(u_keyColor, vec3(0.5, -0.4542, -0.0458)));
    float d = distance(cc, kc);
    float tol = u_key.x * 0.35;
    float alpha = smoothstep(tol, tol + u_key.y * 0.25 + 0.001, d);
    a *= mix(1.0, alpha, u_key.w);
    // Spill: pull the screen's colour out of what's left (green toward max(red, blue), and so on).
    if (u_key.z > 0.0) {
      vec3 k = u_keyColor;
      if (k.g >= k.r && k.g >= k.b) c.g = mix(c.g, min(c.g, max(c.r, c.b)), u_key.z);
      else if (k.b >= k.r && k.b >= k.g) c.b = mix(c.b, min(c.b, max(c.r, c.g)), u_key.z);
      else c.r = mix(c.r, min(c.r, max(c.g, c.b)), u_key.z);
    }
  } else if (u_keyMode == 2) {
    float l = dot(c, LUMA);
    float alpha = smoothstep(u_luma.x, u_luma.x + u_luma.y + 0.001, l);
    if (u_luma.z > 0.5) alpha = 1.0 - alpha;
    a *= mix(1.0, alpha, u_key.w);
  }

  c = wash(c, u_temp);
  c = wash(c, u_tint);
  c *= u_basic.x;
  c = (c - 0.5) * u_basic.y + 0.5;
  c = clamp(c, 0.0, 1.0);
  c = saturateCss(c, u_basic.z);
  c = saturateCss(c, 1.0 - u_basic.w);
  c = clamp(c, 0.0, 1.0);

  if (u_hasCurves) {
    // 255/256 + half a texel: sample the table's cells exactly.
    vec3 m = vec3(texture(u_curves, vec2(c.r * 0.99609375 + 0.001953125, 0.5)).r,
                  texture(u_curves, vec2(c.g * 0.99609375 + 0.001953125, 0.5)).r,
                  texture(u_curves, vec2(c.b * 0.99609375 + 0.001953125, 0.5)).r);
    c = vec3(texture(u_curves, vec2(m.r * 0.99609375 + 0.001953125, 0.5)).g,
             texture(u_curves, vec2(m.g * 0.99609375 + 0.001953125, 0.5)).b,
             texture(u_curves, vec2(m.b * 0.99609375 + 0.001953125, 0.5)).a);
  }

  if (u_hasWheels) {
    c = c * u_gain + u_lift * (1.0 - c);
    c = pow(max(c, 0.0), u_gamma);
    c = clamp(c, 0.0, 1.0);
  }

  if (u_hasHsl) {
    vec3 h = rgb2hsl(c);
    float hueShift = 0.0, sat = 0.0, lum = 0.0;
    for (int i = 0; i < 8; i++) {
      float w = bandWeight(h.x, i);
      hueShift += u_hsl[i].x * w;
      sat += u_hsl[i].y * w;
      lum += u_hsl[i].z * w;
    }
    // Greys have no hue to adjust; the effect grows with how colourful a pixel is.
    float colourful = smoothstep(0.02, 0.25, h.y);
    h.x = mod(h.x + hueShift * colourful + 360.0, 360.0);
    h.y = clamp(h.y * (1.0 + sat * colourful), 0.0, 1.0);
    h.z = clamp(h.z + lum * 0.25 * colourful * (1.0 - abs(2.0 * h.z - 1.0)), 0.0, 1.0);
    c = hsl2rgb(h);
  }

  if (u_lutAmount > 0.0) {
    vec3 coord = c * ((u_lutSize - 1.0) / u_lutSize) + 0.5 / u_lutSize;
    c = mix(c, texture(u_lut, coord).rgb, u_lutAmount);
  }

  outColor = vec4(c * a, a);
}`

interface Gl {
  canvas: HTMLCanvasElement
  gl: WebGL2RenderingContext
  program: WebGLProgram
  image: WebGLTexture
  curves: WebGLTexture
  emptyLut: WebGLTexture
  loc: Record<string, WebGLUniformLocation | null>
}

let state: Gl | null = null
const lutTextures = new Map<string, { data: string; texture: WebGLTexture }>()
let curvesKey = ''

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`Grade shader: ${gl.getShaderInfoLog(s)}`)
  return s
}

function texture2d(gl: WebGL2RenderingContext) {
  const t = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, t)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return t
}

function texture3d(gl: WebGL2RenderingContext, size: number, data: Uint8Array) {
  const t = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_3D, t)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  for (const w of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, w, gl.CLAMP_TO_EDGE)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB8, size, size, size, 0, gl.RGB, gl.UNSIGNED_BYTE, data)
  return t
}

function init(): Gl | null {
  if (state && !state.gl.isContextLost()) return state
  lutTextures.clear()
  curvesKey = ''
  const canvas = document.createElement('canvas')
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false })
  if (!gl) return null
  const program = gl.createProgram()!
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT))
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG))
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Grade shader: ${gl.getProgramInfoLog(program)}`)
  gl.useProgram(program)
  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
  const pos = gl.getAttribLocation(program, 'a_pos')
  gl.enableVertexAttribArray(pos)
  gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0)
  const names = ['u_image', 'u_texel', 'u_sharpen', 'u_keyMode', 'u_keyColor', 'u_key', 'u_luma', 'u_temp', 'u_tint', 'u_basic', 'u_hasCurves', 'u_curves', 'u_hasWheels', 'u_lift', 'u_gamma', 'u_gain', 'u_hasHsl', 'u_hsl', 'u_lutAmount', 'u_lutSize', 'u_lut']
  const loc = Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(program, n)]))
  const image = texture2d(gl)
  const curves = texture2d(gl)
  const emptyLut = texture3d(gl, 2, new Uint8Array([0, 0, 0, 255, 0, 0, 0, 255, 0, 255, 255, 0, 0, 0, 255, 255, 0, 255, 0, 255, 255, 255, 255, 255]))
  gl.uniform1i(loc.u_image, 0)
  gl.uniform1i(loc.u_curves, 1)
  gl.uniform1i(loc.u_lut, 2)
  state = { canvas, gl, program, image, curves, emptyLut, loc }
  return state
}

const hex = (h: string): [number, number, number] => {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})/i.exec(h)
  return m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : [0, 1, 0]
}

const num = (fx: Effect | undefined, key: string, fallback: number) => {
  const v = fx?.params?.[key]
  return typeof v === 'number' ? v : fallback
}

const enabled = (clip: Pick<Clip, 'effects'>, kind: Effect['kind']) => clip.effects.find((e) => e.kind === kind && e.enabled)

/** Whether a clip's picture needs the GPU grade. */
export function needsGpuGrade(clip: Pick<Clip, 'color' | 'effects'>) {
  return hasAdvancedGrade(clip.color) || Boolean(enabled(clip, 'chromaKey') || enabled(clip, 'lumaKey') || enabled(clip, 'sharpen'))
}

export interface GradeInput {
  color: ColorGrade
  effects: Effect[]
  /** Monochrome amount 0..100 (the Monochrome effect). */
  mono: number
  /** Whether temperature and tint still need applying (they're baked in on the 2D path). */
  washes: boolean
}

/**
 * Grades `source` (a W×H canvas) on the GPU and returns a canvas with the result,
 * premultiplied and ready to draw. Returns null if WebGL2 isn't available.
 */
export function gpuGrade(source: HTMLCanvasElement, input: GradeInput, project: Pick<Project, 'luts'>): HTMLCanvasElement | null {
  let s: Gl | null
  try {
    s = init()
  } catch (err) {
    console.warn('The GPU grade is unavailable', err)
    return null
  }
  if (!s) return null
  const { gl, loc } = s
  const W = source.width
  const H = source.height
  if (s.canvas.width !== W || s.canvas.height !== H) {
    s.canvas.width = W
    s.canvas.height = H
  }
  gl.viewport(0, 0, W, H)

  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, s.image)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
  gl.uniform2f(loc.u_texel, 1 / W, 1 / H)

  const { color: g, effects } = input
  const sharpen = enabled({ effects }, 'sharpen')
  gl.uniform1f(loc.u_sharpen, sharpen ? sharpen.amount / 100 : 0)

  const chroma = enabled({ effects }, 'chromaKey')
  const luma = enabled({ effects }, 'lumaKey')
  gl.uniform1i(loc.u_keyMode, chroma ? 1 : luma ? 2 : 0)
  const keyFx = chroma ?? luma
  gl.uniform3fv(loc.u_keyColor, hex(String(chroma?.params?.color ?? '#00d84a')))
  gl.uniform4f(loc.u_key, num(chroma, 'tolerance', 32) / 100, num(chroma, 'softness', 18) / 100, num(chroma, 'spill', 60) / 100, (keyFx?.amount ?? 100) / 100)
  gl.uniform3f(loc.u_luma, num(luma, 'threshold', 18) / 100, num(luma, 'softness', 12) / 100, num(luma, 'invert', 0))

  // The same washes and filter numbers the 2D path uses (color.ts).
  const temp = input.washes && g.temperature ? hex(g.temperature > 0 ? '#ff963a' : '#3a8cff') : [0, 0, 0]
  const tint = input.washes && g.tint ? hex(g.tint > 0 ? '#ff4fd2' : '#44ff88') : [0, 0, 0]
  gl.uniform4f(loc.u_temp, temp[0], temp[1], temp[2], input.washes ? (Math.abs(g.temperature) / 100) * 0.55 : 0)
  gl.uniform4f(loc.u_tint, tint[0], tint[1], tint[2], input.washes ? (Math.abs(g.tint) / 100) * 0.4 : 0)
  gl.uniform4f(loc.u_basic, 1 + (g.exposure / 100) * 0.7, 1 + (g.contrast / 100) * 0.65, g.saturation <= -100 ? 0 : 1 + g.saturation / 100, Math.min(100, input.mono) / 100)

  const c = g.curves
  const curvesOn = Boolean(c && !(isIdentityCurve(c.master) && isIdentityCurve(c.red) && isIdentityCurve(c.green) && isIdentityCurve(c.blue)))
  gl.uniform1i(loc.u_hasCurves, curvesOn ? 1 : 0)
  gl.activeTexture(gl.TEXTURE1)
  gl.bindTexture(gl.TEXTURE_2D, s.curves)
  if (c && curvesOn) {
    const key = JSON.stringify(c)
    if (key !== curvesKey) {
      const tables = [c.master, c.red, c.green, c.blue].map((pts) => curveTable(pts, 256))
      const data = new Uint8Array(256 * 4)
      for (let i = 0; i < 256; i++) for (let ch = 0; ch < 4; ch++) data[i * 4 + ch] = Math.round(tables[ch][i] * 255)
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data)
      curvesKey = key
    }
  }

  const w = g.wheels
  const wheelsOn = Boolean(w && (w.lift.x || w.lift.y || w.lift.luma || w.gamma.x || w.gamma.y || w.gamma.luma || w.gain.x || w.gain.y || w.gain.luma))
  gl.uniform1i(loc.u_hasWheels, wheelsOn ? 1 : 0)
  if (w && wheelsOn) {
    const p = wheelParams(w)
    gl.uniform3fv(loc.u_lift, p.lift)
    gl.uniform3fv(loc.u_gamma, p.gamma)
    gl.uniform3fv(loc.u_gain, p.gain)
  }

  const bands = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'] as const
  const hsl = g.hsl
  const hslValues = new Float32Array(24)
  let hslOn = false
  bands.forEach((b, i) => {
    const v = hsl?.[b]
    if (!v) return
    hslValues.set([v.hue, v.saturation / 100, v.luminance / 100], i * 3)
    if (v.hue || v.saturation || v.luminance) hslOn = true
  })
  gl.uniform1i(loc.u_hasHsl, hslOn ? 1 : 0)
  gl.uniform3fv(loc.u_hsl, hslValues)

  gl.activeTexture(gl.TEXTURE2)
  const lut = g.lut && project.luts?.[g.lut.id]
  if (lut && g.lut!.amount > 0) {
    let entry = lutTextures.get(lut.id)
    if (!entry || entry.data !== lut.data) {
      if (entry) gl.deleteTexture(entry.texture)
      entry = { data: lut.data, texture: texture3d(gl, lut.size, base64ToBytes(lut.data)) }
      lutTextures.set(lut.id, entry)
    }
    gl.bindTexture(gl.TEXTURE_3D, entry.texture)
    gl.uniform1f(loc.u_lutAmount, g.lut!.amount)
    gl.uniform1f(loc.u_lutSize, lut.size)
  } else {
    gl.bindTexture(gl.TEXTURE_3D, s.emptyLut)
    gl.uniform1f(loc.u_lutAmount, 0)
    gl.uniform1f(loc.u_lutSize, 2)
  }

  gl.clearColor(0, 0, 0, 0)
  gl.clear(gl.COLOR_BUFFER_BIT)
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  return s.canvas
}
