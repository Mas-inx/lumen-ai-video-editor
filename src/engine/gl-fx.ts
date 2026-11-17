/**
 * Light and lens effects on the GPU (WebGL2), drawn on a clip's layer after its
 * grade, in this order:
 *
 *   relight → god rays → bloom & halation → lens flare → particles → light leak → vignette
 *
 * - Relight shades the picture with a new point light: surface directions come
 *   from the clip's AI depth map (or, without one, gently from its brightness).
 * - Bloom and halation share one bright pass and a dual-filter blur pyramid
 *   (half size down to 1/64); each mixes the levels its own radius asks for.
 *   Halation keeps to the outside of bright edges, as on film.
 * - God rays are a radial blur toward the light (Mitchell, GPU Gems 3 ch. 13).
 * - Flares, leaks and vignettes are drawn analytically.
 *
 * Everything is measured in fractions of the frame, so an effect looks the same
 * at every render size, in the preview and in the export. Pure helpers (the
 * pyramid's weights, finding the light) are exported for tests.
 */
import { fxNumber, fxString } from '@/editor/presets'
import type { Clip, Effect, EffectKind } from '@/editor/types'

/** Effects this pass draws. */
export const FX_KINDS: readonly EffectKind[] = ['relight', 'rays', 'glow', 'halation', 'flare', 'particles', 'leak', 'vignette']

const isFx = (e: Effect) => e.enabled && (FX_KINDS as readonly string[]).includes(e.kind)

/** Whether a clip's layer goes through this pass (a light effect, or the grade's vignette). */
export function needsFx(clip: Pick<Clip, 'effects' | 'color'>) {
  return Boolean(clip.color.vignette) || clip.effects.some(isFx)
}

export interface FxInput {
  effects: Effect[]
  /** The grade's vignette slider (-100..100; below 0 lightens). */
  vignette: number
  /** Seconds into the clip: leaks move with it. */
  t: number
  /** The clip's depth map drawn like its picture (white = near), for Relight. */
  depth?: CanvasImageSource | null
}

// ─── Pure helpers ────────────────────────────────────────────────────────

/** Blur levels: half size, then halved five more times. */
export const LEVELS = 6

/**
 * How much each pyramid level contributes for a radius (0..1): a bell around
 * the level that blurs about that far, summing to 1 — so a wider glow spreads
 * the same light further instead of getting brighter.
 */
export function pyramidWeights(radius: number, deepest = LEVELS - 1): number[] {
  const mu = Math.min(1, Math.max(0, radius)) * deepest
  const w = Array.from({ length: LEVELS }, (_, k) => Math.exp(-((k - mu) ** 2) / (2 * 1.1 ** 2)))
  const sum = w.reduce((a, b) => a + b, 0)
  return w.map((v) => v / sum)
}

/**
 * The brightest light in a small RGBA picture: the centre of the pixels within
 * a hair of the brightest, weighted by how bright they are. x, y as fractions
 * of the picture, v its brightness (0..1).
 */
export function brightestIn(rgba: ArrayLike<number>, width: number, height: number): { x: number; y: number; v: number } {
  let max = 0
  const lum = new Float32Array(width * height)
  for (let i = 0; i < lum.length; i++) {
    const a = rgba[i * 4 + 3] / 255
    const l = ((0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2]) / 255) * a
    lum[i] = l
    if (l > max) max = l
  }
  if (max <= 0.02) return { x: 0.5, y: 0.5, v: 0 }
  const floor = max - Math.max(0.03, max * 0.06)
  let sx = 0
  let sy = 0
  let sw = 0
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const w = lum[y * width + x] - floor
      if (w <= 0) continue
      sx += (x + 0.5) * w
      sy += (y + 0.5) * w
      sw += w
    }
  return { x: sx / sw / width, y: sy / sw / height, v: max }
}

/** "#rrggbb" → 0..1 RGB (white when it can't be read). */
export function rgbOf(hex: string): [number, number, number] {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})/i.exec(hex)
  return m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : [1, 1, 1]
}

const LEAK_STYLES = ['drift', 'burst', 'streak', 'edge', 'prism']
const FLARE_STYLES = ['classic', 'anamorphic', 'star']
const PARTICLE_STYLES = ['dust', 'snow', 'rain', 'embers', 'bokeh', 'sparkles', 'confetti']

// ─── Shaders ─────────────────────────────────────────────────────────────

// v_uv is always the picture's own coordinates (y down): passes into textures
// draw unflipped (u_flip -1), the last pass onto the canvas flips (u_flip 1).
const VERT = `#version 300 es
in vec2 a_pos;
uniform float u_flip;
out vec2 v_uv;
void main() {
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5 * u_flip);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`

const HEAD = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
float luma(vec3 c) { return dot(c, LUMA); }
`

const RELIGHT = `${HEAD}
uniform sampler2D u_image;
uniform sampler2D u_depth;
uniform bool u_hasDepth;
uniform float u_aspect;
uniform vec3 u_light;       // x, y (fractions of the frame), height 0..1
uniform vec3 u_color;
uniform float u_amount;     // 0..1
uniform float u_reach;      // 0..1
uniform float u_ambient;    // existing light kept, 0..1
uniform float u_soft;       // 0..1
uniform float u_shine;      // 0..1

float height(vec2 uv) {
  if (u_hasDepth) return texture(u_depth, uv).r;
  // No depth map: a soft relief from the picture's own brightness.
  vec3 c = texture(u_image, uv).rgb;
  return luma(c) * 0.25;
}

void main() {
  vec4 src = texture(u_image, v_uv);
  vec3 c = src.rgb;
  vec2 e = vec2(0.0035 / u_aspect, 0.0035);
  float scale = u_hasDepth ? 0.35 : 0.12;
  float hl = height(v_uv - vec2(e.x, 0.0));
  float hr = height(v_uv + vec2(e.x, 0.0));
  float hu = height(v_uv - vec2(0.0, e.y));
  float hd = height(v_uv + vec2(0.0, e.y));
  float z = (hl + hr + hu + hd) * 0.25 * scale;
  // Slopes in frame heights; capped so depth edges read as rims, not black lines.
  vec2 g = vec2((hr - hl) * scale / (2.0 * e.x * u_aspect), (hd - hu) * scale / (2.0 * e.y));
  float gm = length(g);
  if (gm > 3.0) g *= 3.0 / gm;
  vec3 n = normalize(vec3(-g, 1.0));
  vec3 p = vec3(v_uv.x * u_aspect, v_uv.y, z);
  vec3 lp = vec3(u_light.x * u_aspect, u_light.y, mix(0.04, 1.6, u_light.z));
  vec3 lv = lp - p;
  float dist = length(lv);
  vec3 l = lv / max(dist, 1e-4);
  float wrap = u_soft * 0.7;
  float diffuse = max((dot(n, l) + wrap) / (1.0 + wrap), 0.0);
  float reach = mix(0.25, 2.6, u_reach);
  float atten = 1.0 / (1.0 + (dist * dist) / (reach * reach) * 3.0);
  vec3 h = normalize(l + vec3(0.0, 0.0, 1.0));
  float spec = pow(max(dot(n, h), 0.0), mix(64.0, 10.0, u_soft)) * u_shine;
  vec3 light = u_color * u_amount * atten;
  vec3 lit = c * (u_ambient + diffuse * light * 1.6) + spec * light * 0.8;
  outColor = vec4(clamp(lit, 0.0, 1.0), src.a);
}`

const BRIGHT = `${HEAD}
uniform sampler2D u_image;
uniform float u_bloomThr;   // 0..1, below 0 = no bloom
uniform float u_haloThr;    // 0..1, below 0 = no halation

void main() {
  vec4 src = texture(u_image, v_uv);
  vec3 c = src.rgb * src.a;
  vec3 bloom = vec3(0.0);
  if (u_bloomThr >= 0.0) {
    // A soft knee: light starts to glow a little before the threshold, not all at once.
    float b = max(c.r, max(c.g, c.b));
    float knee = 0.1;
    float soft = clamp(b - u_bloomThr + knee, 0.0, 2.0 * knee);
    soft = soft * soft / (4.0 * knee + 1e-5);
    bloom = c * (max(soft, b - u_bloomThr) / max(b, 1e-4));
  }
  float halo = u_haloThr >= 0.0 ? smoothstep(u_haloThr - 0.04, u_haloThr + 0.1, luma(c)) : 0.0;
  outColor = vec4(bloom, halo);
}`

const DOWN = `${HEAD}
uniform sampler2D u_image;
uniform vec2 u_half;        // half a texel of the source
void main() {
  vec4 s = texture(u_image, v_uv) * 4.0;
  s += texture(u_image, v_uv - u_half);
  s += texture(u_image, v_uv + u_half);
  s += texture(u_image, v_uv + vec2(u_half.x, -u_half.y));
  s += texture(u_image, v_uv - vec2(u_half.x, -u_half.y));
  outColor = s / 8.0;
}`

const UP = `${HEAD}
uniform sampler2D u_low;    // the level below, accumulated so far
uniform sampler2D u_level;  // this level of the pyramid
uniform vec2 u_half;        // half a texel of the level below
uniform vec4 u_lowScale;    // what the level below is multiplied by (its own weight when it starts the chain)
uniform vec4 u_weight;      // this level's weight: rgb for bloom, a for halation
void main() {
  vec4 s = texture(u_low, v_uv + vec2(-u_half.x * 2.0, 0.0));
  s += texture(u_low, v_uv + vec2(-u_half.x, u_half.y)) * 2.0;
  s += texture(u_low, v_uv + vec2(0.0, u_half.y * 2.0));
  s += texture(u_low, v_uv + vec2(u_half.x, u_half.y)) * 2.0;
  s += texture(u_low, v_uv + vec2(u_half.x * 2.0, 0.0));
  s += texture(u_low, v_uv + vec2(u_half.x, -u_half.y)) * 2.0;
  s += texture(u_low, v_uv + vec2(0.0, -u_half.y * 2.0));
  s += texture(u_low, v_uv + vec2(-u_half.x, -u_half.y)) * 2.0;
  outColor = (s / 12.0) * u_lowScale + texture(u_level, v_uv) * u_weight;
}`

const RAYS = `${HEAD}
uniform sampler2D u_image;
uniform vec2 u_light;       // fractions of the frame
uniform float u_thr;
uniform float u_len;        // 0..1
const int N = 48;
void main() {
  float span = mix(0.2, 0.92, u_len);
  vec2 delta = (v_uv - u_light) * (span / float(N));
  float decay = mix(0.93, 0.985, u_len);
  float illum = 1.0;
  float sum = 0.0;
  vec2 p = v_uv;
  for (int i = 0; i < N; i++) {
    p -= delta;
    vec4 s = texture(u_image, p);
    float inside = step(0.0, p.x) * step(p.x, 1.0) * step(0.0, p.y) * step(p.y, 1.0);
    sum += smoothstep(u_thr, u_thr + 0.14, luma(s.rgb)) * s.a * inside * illum;
    illum *= decay;
  }
  // A path that's bright all the way comes out at 1.
  float norm = (1.0 - decay) / (1.0 - pow(decay, float(N)));
  outColor = vec4(sum * norm, 0.0, 0.0, 1.0);
}`

const COMPOSITE = `${HEAD}
uniform sampler2D u_base;
uniform sampler2D u_glow;   // rgb: bloom, a: halation (blurred)
uniform sampler2D u_rays;   // r: rays
uniform vec2 u_size;        // render size in pixels
uniform float u_aspect;
uniform float u_time;

uniform vec4 u_bloom;       // tint, strength
uniform vec4 u_halo;        // tint, strength
uniform float u_haloThr;
uniform vec4 u_ray;         // tint, strength
uniform vec3 u_rayLight;    // x, y, haze

uniform vec4 u_flare;       // tint, strength
uniform vec4 u_flareP;      // x, y, size, reflections
uniform int u_flareStyle;   // 0 classic, 1 anamorphic, 2 starburst

uniform vec4 u_part;        // strength, size, speed, wind (-1..1)
uniform vec4 u_part2;       // depth, catch light, variation, kind
uniform vec3 u_partColor;

uniform vec4 u_leak;        // strength, speed, direction (radians), variation
uniform vec3 u_leakA;
uniform vec3 u_leakB;
uniform int u_leakStyle;    // 0 drift, 1 burst, 2 streak, 3 edge, 4 prism

uniform vec2 u_vigClassic;  // darken, lighten (0..1): the classic round vignette
uniform vec4 u_vig;         // strength, size, feather, roundness
uniform vec2 u_vigCentre;
uniform vec3 u_vigColor;

vec3 screen(vec3 a, vec3 b) { return 1.0 - (1.0 - a) * (1.0 - clamp(b, 0.0, 1.0)); }

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = p * 2.03 + 17.1;
    a *= 0.5;
  }
  return v;
}
vec3 spectrum(float h) {
  return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
}

// ─── Lens flare ───
const float GT[7] = float[7](-0.35, 0.42, 0.62, 0.86, 1.1, 1.32, 1.7);
const float GR[7] = float[7](0.045, 0.03, 0.11, 0.05, 0.16, 0.022, 0.075);
const float GO[7] = float[7](0.22, 0.4, 0.14, 0.3, 0.1, 0.55, 0.18);
const float GH[7] = float[7](0.58, 0.08, 0.5, 0.92, 0.33, 0.15, 0.72);

vec3 flare(vec2 uv) {
  vec2 asp = vec2(u_aspect, 1.0);
  vec2 L = u_flareP.xy;
  float s = mix(0.45, 1.8, u_flareP.z);
  vec2 d = (uv - L) * asp;
  float dist = length(d);
  vec3 col = u_flare.rgb * (exp(-dist * 22.0 / s) * 1.3 + exp(-dist * 5.0 / s) * 0.22);
  if (u_flareStyle == 1) {
    float streak = exp(-abs(d.y) * 150.0 / s) * exp(-abs(d.x) * 1.1 / s);
    col += vec3(0.42, 0.62, 1.0) * streak * 1.5;
    col += vec3(0.42, 0.62, 1.0) * exp(-abs(d.y) * 40.0 / s) * exp(-abs(d.x) * 3.5 / s) * 0.25;
  } else {
    float n = u_flareStyle == 2 ? 12.0 : 6.0;
    float ang = atan(d.y, d.x);
    float spikes = pow(abs(cos(ang * n * 0.5 + 0.35)), u_flareStyle == 2 ? 48.0 : 160.0);
    col += u_flare.rgb * spikes * exp(-dist * (u_flareStyle == 2 ? 2.6 : 4.5) / s) * (u_flareStyle == 2 ? 1.2 : 0.7);
  }
  // Reflections: discs and rings on the line from the light through the centre, fringed with colour.
  vec2 axis = vec2(0.5) - L;
  float edgeFade = 1.0 - smoothstep(0.55, 1.15, length((L - vec2(0.5)) * asp));
  for (int i = 0; i < 7; i++) {
    vec2 g = L + axis * GT[i] * 2.0;
    float k = length((uv - g) * asp);
    float r = GR[i] * s * (u_flareStyle == 1 ? 1.25 : 1.0);
    vec3 shape;
    if (i == 2 || i == 4) {
      float w = r * 0.07;
      shape = vec3(smoothstep(w, 0.0, abs(k - r)), smoothstep(w, 0.0, abs(k - r * 1.03)), smoothstep(w, 0.0, abs(k - r * 1.06)));
    } else {
      shape = vec3(smoothstep(r, r * 0.72, k), smoothstep(r * 1.03, r * 0.75, k), smoothstep(r * 1.06, r * 0.78, k));
    }
    vec3 tint = mix(spectrum(GH[i]), u_flare.rgb, 0.35);
    if (u_flareStyle == 1) tint = mix(tint, vec3(0.45, 0.65, 1.0), 0.6);
    col += tint * shape * GO[i] * u_flareP.w * edgeFade;
  }
  // The halo: a wide, faint rainbow ring around the centre, brightest on the light's side.
  vec2 hc = (uv - vec2(0.5)) * asp;
  float hr = length(hc);
  float ringR = 0.48 * s;
  float ring = smoothstep(0.035 * s, 0.0, abs(hr - ringR));
  float facing = max(dot(normalize(hc + 1e-5), normalize((L - vec2(0.5)) * asp + 1e-5)), 0.0);
  col += spectrum(fract(hr * 1.6 + 0.1)) * ring * facing * 0.12 * u_flareP.w;
  return col;
}

// ─── Particles ───
// One particle per cell of a grid that scrolls with the particles' velocity, a layer per depth: thousands of
// them for the price of a few lookups, the same at every frame of an export.
float ph1(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 45758.5453); }
vec2 ph2(vec2 p) { return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453); }
const vec3 CONFETTI[5] = vec3[5](vec3(1.0, 0.33, 0.38), vec3(1.0, 0.8, 0.25), vec3(0.3, 0.8, 1.0), vec3(0.45, 0.95, 0.5), vec3(0.75, 0.5, 1.0));

/** The light particles add (light) and, for confetti, the paper laid over the picture (paper, cover). */
void particles(vec2 uv, vec3 base, out vec3 light, out vec3 paper, out float cover) {
  light = vec3(0.0);
  paper = vec3(0.0);
  cover = 0.0;
  int kind = int(u_part2.w + 0.5);
  float size = mix(0.45, 1.9, u_part.y);
  float speed = mix(0.15, 2.4, u_part.z);
  float wind = u_part.w;
  float layers = 1.0 + floor(u_part2.x * 3.0 + 0.5);
  float density = mix(0.25, 1.0, u_part.x);
  float seed = u_part2.z * 13.17;
  vec2 q = vec2(uv.x * u_aspect, uv.y);
  float lit = u_part2.y > 0.5 ? smoothstep(0.3, 0.85, luma(base)) : 1.0;
  for (int L = 0; L < 4; L++) {
    float fl = float(L);
    if (fl >= layers) break;
    float near = layers > 1.0 ? fl / (layers - 1.0) : 1.0;
    // Near layers are bigger and faster: parallax.
    float scale = mix(0.55, 1.45, near) * size;
    float cell;
    vec2 vel;
    float occupancy;
    if (kind == 0) { cell = 0.075; vel = vec2(wind * 0.03, -0.012); occupancy = 0.5; }
    else if (kind == 1) { cell = 0.09; vel = vec2(wind * 0.09, 0.11); occupancy = 0.65; }
    else if (kind == 2) { cell = 0.055; vel = vec2(wind * 0.3, 1.5); occupancy = 0.55; }
    else if (kind == 3) { cell = 0.085; vel = vec2(wind * 0.06, -0.13); occupancy = 0.35; }
    else if (kind == 4) { cell = 0.26; vel = vec2(wind * 0.02, -0.008); occupancy = 0.45; }
    else if (kind == 5) { cell = 0.09; vel = vec2(wind * 0.02, 0.01); occupancy = 0.5; }
    else { cell = 0.085; vel = vec2(wind * 0.07, 0.19); occupancy = 0.6; }
    cell *= scale;
    vel *= speed * mix(0.55, 1.45, near);
    vec2 p = (q - vel * u_time) / cell + vec2(fl * 17.31 + seed, fl * 9.17 - seed);
    vec2 id = floor(p);
    vec2 f = fract(p);
    if (ph1(id + seed) > occupancy * density) continue;
    vec2 rnd = ph2(id + seed * 0.37 + fl);
    float phase = ph1(id + 7.7) * 6.2831;
    vec2 c = mix(vec2(0.3), vec2(0.7), rnd);
    // Snow and embers sway as they go.
    if (kind == 1 || kind == 3) c.x += sin(u_time * (0.8 + rnd.y) + phase) * 0.12;
    // Offset from the particle's centre, in cells (sizes below are fractions of a cell, so nothing crosses into the next).
    vec2 d = f - c;
    float fade = mix(0.45, 1.0, near);
    if (kind == 0) {
      float r = 0.03;
      float tw = 0.55 + 0.45 * sin(u_time * (1.1 + rnd.x * 2.0) + phase);
      light += vec3(1.0, 0.96, 0.88) * exp(-dot(d, d) / (r * r)) * tw * fade * 0.85 * lit;
    } else if (kind == 1) {
      float r = 0.05;
      float soft = mix(0.35, 0.9, 1.0 - near);
      light += vec3(1.0) * smoothstep(r, r * soft, length(d)) * fade * 0.8 * lit;
    } else if (kind == 2) {
      vec2 dir = normalize(vel + vec2(0.0001));
      float along = dot(d, dir);
      float across = dot(d, vec2(-dir.y, dir.x));
      float k = smoothstep(0.014, 0.0, abs(across)) * smoothstep(0.26, 0.0, abs(along));
      light += vec3(0.82, 0.88, 1.0) * k * fade * 0.4 * lit;
    } else if (kind == 3) {
      float r = 0.03;
      float flick = 0.6 + 0.4 * sin(u_time * (5.0 + rnd.x * 6.0) + phase);
      float k = exp(-dot(d, d) / (r * r)) + 0.25 * exp(-dot(d, d) / (r * r * 9.0));
      light += mix(vec3(1.0, 0.36, 0.08), vec3(1.0, 0.72, 0.3), rnd.y) * k * flick * fade;
    } else if (kind == 4) {
      float r = 0.19;
      float dist = length(d);
      float disc = smoothstep(r, r * 0.88, dist);
      float rim = smoothstep(r * 0.82, r * 0.96, dist) * disc;
      vec3 tint = mix(vec3(1.0, 0.78, 0.5), vec3(0.6, 0.75, 1.0), rnd.y);
      light += tint * (disc * 0.16 + rim * 0.12) * fade * lit;
    } else if (kind == 5) {
      float r = 0.065;
      float tw = pow(max(0.0, sin(u_time * (1.6 + rnd.x * 2.5) + phase)), 6.0);
      vec2 a = abs(d) / r;
      float star = exp(-a.x * 6.0) * exp(-a.y * 0.9) + exp(-a.y * 6.0) * exp(-a.x * 0.9) + exp(-dot(a, a) * 2.0);
      light += vec3(1.0, 0.97, 0.9) * min(star, 2.0) * tw * fade * lit;
    } else {
      float ang = phase + u_time * (1.5 + rnd.x * 3.0);
      vec2 rd = vec2(cos(ang) * d.x + sin(ang) * d.y, -sin(ang) * d.x + cos(ang) * d.y);
      float flip = abs(sin(u_time * (3.0 + rnd.y * 4.0) + phase));
      vec2 halfSize = vec2(0.075 * flip + 0.01, 0.045);
      vec2 e = abs(rd) - halfSize;
      float inside = 1.0 - smoothstep(0.0, 0.012, max(e.x, e.y));
      vec3 col = CONFETTI[int(ph1(id + 3.3) * 4.999)] * mix(0.75, 1.0, flip);
      paper = mix(paper, col, inside);
      cover = max(cover, inside * mix(0.8, 1.0, near));
    }
  }
  light *= u_partColor;
}

// ─── Light leak ───
vec3 leak(vec2 uv, out float alpha) {
  vec2 asp = vec2(u_aspect, 1.0);
  float t = u_time * (u_leak.y / 40.0);
  float seed = u_leak.w;
  vec2 dir = vec2(cos(u_leak.z), -sin(u_leak.z));
  alpha = 1.0;
  if (u_leakStyle == 0) {
    // The original drifting glow, exactly.
    vec2 c = vec2(0.2 + 0.6 * (0.5 + 0.5 * sin(t * 0.7)), 0.3 + 0.2 * sin(t * 0.43 + 1.0)) * u_size;
    float r = length(uv * u_size - c) / (0.55 * u_size.x);
    vec3 col = r < 0.45 ? mix(u_leakA, u_leakB, r / 0.45) : u_leakB;
    alpha = r < 0.45 ? mix(0.55, 0.25, r / 0.45) : mix(0.25, 0.0, clamp((r - 0.45) / 0.55, 0.0, 1.0));
    return col;
  }
  float n = fbm(uv * vec2(u_aspect, 1.0) * 2.2 + vec2(t * 0.11, -t * 0.07) + seed * 7.13);
  if (u_leakStyle == 1 || u_leakStyle == 4) {
    // Burst: light flaring in from one side, breathing and flickering.
    vec2 src = vec2(0.5) + dir * 0.58 + vec2(sin(t * 0.37 + seed), cos(t * 0.29 + seed * 1.7)) * 0.12;
    float d = length((uv - src) * asp);
    float flicker = 0.65 + 0.35 * noise(vec2(t * 0.9, seed * 3.1));
    float k = exp(-d * 1.35) * (0.5 + 0.8 * n) * flicker;
    vec3 col = u_leakStyle == 4 ? spectrum(fract(d * 0.9 + n * 0.35 + t * 0.03 + seed * 0.1)) * 1.1 : mix(u_leakA, u_leakB, clamp(d * 0.75 + (n - 0.5) * 0.7, 0.0, 1.0));
    return col * k * 1.9;
  }
  if (u_leakStyle == 2) {
    // Streaks: soft bands sweeping across, brighter toward the light's side.
    vec2 perp = vec2(-dir.y, dir.x);
    float x = dot((uv - 0.5) * asp, perp);
    float bands = pow(0.5 + 0.5 * sin(x * 7.0 + t * 0.6 + n * 3.4 + seed * 5.0), 5.0);
    float side = smoothstep(-0.65, 0.6, dot((uv - 0.5) * asp, dir));
    vec3 col = mix(u_leakA, u_leakB, clamp(0.5 + x * 0.6 + (n - 0.5) * 0.5, 0.0, 1.0));
    return col * bands * side * (0.5 + 0.6 * n) * 1.2;
  }
  // Edge burn: an organic glow creeping in from the frame's edge.
  float e = dot(uv - 0.5, dir) + 0.5;
  float k = pow(smoothstep(0.38, 1.05, e + (n - 0.5) * 0.55 + 0.06 * sin(t * 0.8 + seed)), 1.6);
  vec3 col = mix(u_leakB, mix(u_leakA, vec3(1.0, 0.95, 0.85), 0.35), smoothstep(0.55, 1.0, k));
  return col * k * 1.4;
}

void main() {
  vec4 base = texture(u_base, v_uv);
  vec3 c = base.rgb;
  float a = base.a;
  // Glows also land where the picture is see-through — around a keyed subject, past a
  // picture-in-picture's edge — the way light spills off a lit sign. Rays and flares belong to
  // the shot's own air and lens, so they stay inside it (an adjustment layer puts them over everything).
  vec3 spill = vec3(0.0);

  if (u_ray.a > 0.0) {
    vec3 add = texture(u_rays, v_uv).r * u_ray.rgb * u_ray.a * 1.25;
    vec2 d = (v_uv - u_rayLight.xy) * vec2(u_aspect, 1.0);
    add += u_ray.rgb * u_rayLight.z * exp(-dot(d, d) * 5.0) * 0.55 * u_ray.a;
    c = screen(c, add);
  }
  if (u_bloom.a > 0.0) {
    vec3 g = texture(u_glow, v_uv).rgb * u_bloom.rgb * u_bloom.a;
    c = screen(c, g);
    spill += g;
  }
  if (u_halo.a > 0.0) {
    float blurred = texture(u_glow, v_uv).a;
    float core = smoothstep(u_haloThr - 0.04, u_haloThr + 0.1, luma(base.rgb));
    vec3 h = (max(blurred - core * 0.85, 0.0) + blurred * 0.08) * u_halo.rgb * u_halo.a * 1.5;
    c = screen(c, h);
    spill += h;
  }
  if (u_flare.a > 0.0) {
    c = screen(c, flare(v_uv) * u_flare.a);
  }
  if (u_part.x > 0.0) {
    vec3 light;
    vec3 paper;
    float cover;
    particles(v_uv, base.rgb, light, paper, cover);
    c = screen(c, light * (0.5 + u_part.x));
    c = mix(c, paper, cover * min(1.0, 0.4 + u_part.x));
  }
  if (u_leak.x > 0.0) {
    float k;
    vec3 l = leak(v_uv, k);
    c = mix(c, screen(c, l), clamp(k * u_leak.x, 0.0, 1.0));
  }
  if (u_vigClassic.x > 0.0 || u_vigClassic.y > 0.0) {
    // The original vignette's shape: round, from 0.3 of the height to 0.72 of the width.
    float r0 = 0.3 * u_size.y;
    float r1 = 0.72 * u_size.x;
    float t = clamp((length(v_uv * u_size - u_size * 0.5) - r0) / (r1 - r0), 0.0, 1.0) * 0.85;
    c *= 1.0 - t * u_vigClassic.x;
    c = mix(c, vec3(1.0), t * u_vigClassic.y);
  }
  if (u_vig.x > 0.0) {
    float round01 = u_vig.w;
    vec2 q = (v_uv - u_vigCentre) / 0.5;
    q.x *= mix(1.0, u_aspect, clamp(round01 * 2.0 - 1.0, 0.0, 1.0));
    float n = mix(5.0, 2.0, clamp(round01 * 2.0, 0.0, 1.0));
    float dist = pow(pow(abs(q.x), n) + pow(abs(q.y), n), 1.0 / n);
    float inner = mix(0.15, 1.35, u_vig.y);
    float m = smoothstep(inner, inner + mix(0.04, 1.4, u_vig.z), dist);
    c = mix(c, u_vigColor, m * u_vig.x * 0.95);
  }
  // Premultiplied: the picture where it's opaque, its glow where it isn't (no change on a full-frame
  // shot), fading out before the layer's own edge so it never ends in a line.
  float border = min(min(v_uv.x, 1.0 - v_uv.x) * u_aspect, min(v_uv.y, 1.0 - v_uv.y));
  spill = clamp(spill, 0.0, 1.0) * (1.0 - a) * smoothstep(0.0, 0.08, border);
  outColor = vec4(clamp(c, 0.0, 1.0) * a + spill, a + max(spill.r, max(spill.g, spill.b)));
}`

// ─── GL plumbing ─────────────────────────────────────────────────────────

interface Target {
  tex: WebGLTexture
  fbo: WebGLFramebuffer
  w: number
  h: number
}

interface Program {
  program: WebGLProgram
  loc: Record<string, WebGLUniformLocation | null>
}

interface Gl {
  canvas: HTMLCanvasElement
  gl: WebGL2RenderingContext
  float: boolean
  vao: WebGLVertexArrayObject
  source: WebGLTexture
  depth: WebGLTexture
  black: WebGLTexture
  p: Record<'relight' | 'bright' | 'down' | 'up' | 'rays' | 'composite', Program>
  targets: Map<string, Target>
}

let state: Gl | null = null
let failed = false

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`Light effects shader: ${gl.getShaderInfoLog(s)}`)
  return s
}

function program(gl: WebGL2RenderingContext, frag: string, names: string[]): Program {
  const p = gl.createProgram()!
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT))
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, frag))
  gl.bindAttribLocation(p, 0, 'a_pos')
  gl.linkProgram(p)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Light effects shader: ${gl.getProgramInfoLog(p)}`)
  return { program: p, loc: Object.fromEntries(['u_flip', ...names].map((n) => [n, gl.getUniformLocation(p, n)])) }
}

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
  const canvas = document.createElement('canvas')
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false, alpha: true })
  if (!gl) return null
  // Glows are summed across levels: half floats keep their faint tails from banding.
  const float = Boolean(gl.getExtension('EXT_color_buffer_float'))
  const vao = gl.createVertexArray()!
  gl.bindVertexArray(vao)
  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
  const p = {
    relight: program(gl, RELIGHT, ['u_image', 'u_depth', 'u_hasDepth', 'u_aspect', 'u_light', 'u_color', 'u_amount', 'u_reach', 'u_ambient', 'u_soft', 'u_shine']),
    bright: program(gl, BRIGHT, ['u_image', 'u_bloomThr', 'u_haloThr']),
    down: program(gl, DOWN, ['u_image', 'u_half']),
    up: program(gl, UP, ['u_low', 'u_level', 'u_half', 'u_lowScale', 'u_weight']),
    rays: program(gl, RAYS, ['u_image', 'u_light', 'u_thr', 'u_len']),
    composite: program(gl, COMPOSITE, [
      'u_base', 'u_glow', 'u_rays', 'u_size', 'u_aspect', 'u_time',
      'u_bloom', 'u_halo', 'u_haloThr', 'u_ray', 'u_rayLight',
      'u_flare', 'u_flareP', 'u_flareStyle',
      'u_leak', 'u_leakA', 'u_leakB', 'u_leakStyle',
      'u_vigClassic', 'u_vig', 'u_vigCentre', 'u_vigColor',
      'u_part', 'u_part2', 'u_partColor',
    ]),
  }
  const black = texture(gl)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]))
  state = { canvas, gl, float, vao, source: texture(gl), depth: texture(gl), black, p, targets: new Map() }
  return state
}

/** A texture to draw into, kept between frames and resized as needed. */
function target(s: Gl, name: string, w: number, h: number): Target {
  const { gl } = s
  let t = s.targets.get(name)
  if (t && t.w === w && t.h === h) return t
  if (t) {
    gl.deleteTexture(t.tex)
    gl.deleteFramebuffer(t.fbo)
  }
  // Made on a unit no pass samples from: binding it where a pass's input sits would loop it into its own output.
  gl.activeTexture(gl.TEXTURE7)
  const tex = texture(gl)
  if (s.float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null)
  else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
  const fbo = gl.createFramebuffer()!
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
  t = { tex, fbo, w, h }
  s.targets.set(name, t)
  return t
}

function bind(gl: WebGL2RenderingContext, unit: number, tex: WebGLTexture) {
  gl.activeTexture(gl.TEXTURE0 + unit)
  gl.bindTexture(gl.TEXTURE_2D, tex)
}

function draw(s: Gl, prog: Program, into: Target | null, w: number, h: number) {
  const { gl } = s
  gl.uniform1f(prog.loc.u_flip, into ? -1 : 1)
  gl.bindFramebuffer(gl.FRAMEBUFFER, into ? into.fbo : null)
  gl.viewport(0, 0, w, h)
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
}

// ─── Finding the light ───────────────────────────────────────────────────

let probe: HTMLCanvasElement | null = null

/** Where the brightest light in a picture is (fractions of the frame) and how bright it is. */
function findLight(source: HTMLCanvasElement) {
  const w = 48
  const h = Math.max(1, Math.round((w * source.height) / Math.max(1, source.width)))
  probe ??= document.createElement('canvas')
  if (probe.width !== w || probe.height !== h) {
    probe.width = w
    probe.height = h
  }
  const ctx = probe.getContext('2d', { willReadFrequently: true })!
  ctx.clearRect(0, 0, w, h)
  ctx.imageSmoothingQuality = 'medium'
  ctx.drawImage(source, 0, 0, w, h)
  return brightestIn(ctx.getImageData(0, 0, w, h).data, w, h)
}

// ─── The pass ────────────────────────────────────────────────────────────

/**
 * Draws a clip's light effects over `source` (a W×H canvas, the graded layer)
 * and returns a canvas with the result, premultiplied and ready to draw. Null
 * when WebGL2 isn't available (the compositor falls back to its 2D effects).
 */
export function gpuFx(source: HTMLCanvasElement, input: FxInput): HTMLCanvasElement | null {
  let s: Gl | null
  try {
    s = init()
  } catch (err) {
    failed = true
    console.warn('Light effects are unavailable on this graphics card', err)
    return null
  }
  if (!s) return null
  const { gl, p } = s
  const W = source.width
  const H = source.height
  if (W < 2 || H < 2) return null
  if (s.canvas.width !== W || s.canvas.height !== H) {
    s.canvas.width = W
    s.canvas.height = H
  }
  gl.bindVertexArray(s.vao)
  gl.disable(gl.BLEND)

  const on = (kind: EffectKind) => input.effects.find((e) => e.kind === kind && e.enabled)
  const relight = on('relight')
  const rays = on('rays')
  const glow = on('glow')
  const halation = on('halation')
  const flare = on('flare')
  const leak = on('leak')
  const particles = on('particles')
  const vignette = on('vignette')

  bind(gl, 0, s.source)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
  let base: WebGLTexture = s.source

  // Relight first: everything after it glows from the new light.
  if (relight) {
    const hasDepth = Boolean(input.depth)
    if (input.depth) {
      bind(gl, 1, s.depth)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, input.depth as TexImageSource)
    } else bind(gl, 1, s.black)
    const out = target(s, 'relit', W, H)
    const { program: prog, loc } = p.relight
    gl.useProgram(prog)
    bind(gl, 0, base)
    gl.uniform1i(loc.u_image, 0)
    gl.uniform1i(loc.u_depth, 1)
    gl.uniform1i(loc.u_hasDepth, hasDepth ? 1 : 0)
    gl.uniform1f(loc.u_aspect, W / H)
    gl.uniform3f(loc.u_light, fxNumber(relight, 'x', 0.25), fxNumber(relight, 'y', 0.3), fxNumber(relight, 'height', 45) / 100)
    gl.uniform3fv(loc.u_color, rgbOf(fxString(relight, 'color', '#fff0dc')))
    gl.uniform1f(loc.u_amount, relight.amount / 100)
    gl.uniform1f(loc.u_reach, fxNumber(relight, 'reach', 55) / 100)
    gl.uniform1f(loc.u_ambient, fxNumber(relight, 'ambient', 75) / 100)
    gl.uniform1f(loc.u_soft, fxNumber(relight, 'soft', 40) / 100)
    gl.uniform1f(loc.u_shine, fxNumber(relight, 'shine', 20) / 100)
    draw(s, p.relight, out, W, H)
    base = out.tex
  }

  // Lights that follow the brightest part of the shot.
  let found: ReturnType<typeof findLight> | null = null
  const lightOf = (fx: Effect) => {
    if (fxNumber(fx, 'follow', 0) > 0) {
      found ??= findLight(source)
      // A light that goes out (covered, turned away) takes its flare with it.
      return { x: found.x, y: found.y, k: Math.min(1, Math.max(0, (found.v - 0.55) / 0.35)) }
    }
    return { x: fxNumber(fx, 'x', 0.5), y: fxNumber(fx, 'y', 0.2), k: 1 }
  }

  const hw = Math.max(1, Math.ceil(W / 2))
  const hh = Math.max(1, Math.ceil(H / 2))

  // God rays.
  let raysTex: WebGLTexture = s.black
  const rayLight = rays ? lightOf(rays) : null
  if (rays && rayLight) {
    const out = target(s, 'rays', hw, hh)
    const { program: prog, loc } = p.rays
    gl.useProgram(prog)
    bind(gl, 0, base)
    gl.uniform1i(loc.u_image, 0)
    gl.uniform2f(loc.u_light, rayLight.x, rayLight.y)
    gl.uniform1f(loc.u_thr, (fxNumber(rays, 'threshold', 62) / 100) * 0.95)
    gl.uniform1f(loc.u_len, fxNumber(rays, 'length', 60) / 100)
    draw(s, p.rays, out, hw, hh)
    raysTex = out.tex
  }

  // Bloom and halation: one bright pass, one pyramid, two sets of weights.
  let glowTex: WebGLTexture = s.black
  if (glow || halation) {
    const levels: Target[] = []
    let w = hw
    let h = hh
    for (let k = 0; k < LEVELS; k++) {
      levels.push(target(s, `down${k}`, w, h))
      w = Math.max(1, Math.ceil(w / 2))
      h = Math.max(1, Math.ceil(h / 2))
    }
    const bright = p.bright
    gl.useProgram(bright.program)
    bind(gl, 0, base)
    gl.uniform1i(bright.loc.u_image, 0)
    gl.uniform1f(bright.loc.u_bloomThr, glow ? (fxNumber(glow, 'threshold', 0) / 100) * 0.95 : -1)
    gl.uniform1f(bright.loc.u_haloThr, halation ? (fxNumber(halation, 'threshold', 68) / 100) * 0.95 : -1)
    draw(s, bright, levels[0], levels[0].w, levels[0].h)
    gl.useProgram(p.down.program)
    gl.uniform1i(p.down.loc.u_image, 0)
    for (let k = 1; k < LEVELS; k++) {
      bind(gl, 0, levels[k - 1].tex)
      gl.uniform2f(p.down.loc.u_half, 0.5 / levels[k - 1].w, 0.5 / levels[k - 1].h)
      draw(s, p.down, levels[k], levels[k].w, levels[k].h)
    }
    const wb = pyramidWeights(glow ? fxNumber(glow, 'radius', 47) / 100 : 0)
    const wh = pyramidWeights(halation ? fxNumber(halation, 'radius', 32) / 100 : 0, 4)
    const weight = (k: number) => [wb[k], wb[k], wb[k], wh[k]] as const
    gl.useProgram(p.up.program)
    gl.uniform1i(p.up.loc.u_low, 0)
    gl.uniform1i(p.up.loc.u_level, 1)
    let low = levels[LEVELS - 1]
    for (let k = LEVELS - 2; k >= 0; k--) {
      const out = target(s, `up${k}`, levels[k].w, levels[k].h)
      bind(gl, 0, low.tex)
      bind(gl, 1, levels[k].tex)
      gl.uniform2f(p.up.loc.u_half, 0.5 / low.w, 0.5 / low.h)
      gl.uniform4fv(p.up.loc.u_lowScale, k === LEVELS - 2 ? weight(LEVELS - 1) : [1, 1, 1, 1])
      gl.uniform4fv(p.up.loc.u_weight, weight(k))
      draw(s, p.up, out, out.w, out.h)
      low = out
    }
    glowTex = low.tex
  }

  // Everything together, onto the canvas.
  const { program: prog, loc } = p.composite
  gl.useProgram(prog)
  bind(gl, 0, base)
  bind(gl, 1, glowTex)
  bind(gl, 2, raysTex)
  gl.uniform1i(loc.u_base, 0)
  gl.uniform1i(loc.u_glow, 1)
  gl.uniform1i(loc.u_rays, 2)
  gl.uniform2f(loc.u_size, W, H)
  gl.uniform1f(loc.u_aspect, W / H)
  gl.uniform1f(loc.u_time, input.t)

  const tint = (fx: Effect, key: string, def: string, strength: number) => [...rgbOf(fxString(fx, key, def)), strength] as [number, number, number, number]
  // A higher threshold lets less light through, so it's lifted to match: the glow stays visible, highlights only.
  const bloomGain = glow ? (glow.amount / 100) * (1 + 2.4 * (fxNumber(glow, 'threshold', 0) / 100)) : 0
  gl.uniform4fv(loc.u_bloom, glow ? tint(glow, 'tint', '#ffffff', bloomGain) : [0, 0, 0, 0])
  gl.uniform4fv(loc.u_halo, halation ? tint(halation, 'tint', '#ff3d14', halation.amount / 100) : [0, 0, 0, 0])
  gl.uniform1f(loc.u_haloThr, halation ? (fxNumber(halation, 'threshold', 68) / 100) * 0.95 : 1)
  gl.uniform4fv(loc.u_ray, rays && rayLight ? tint(rays, 'tint', '#fff1d6', (rays.amount / 100) * rayLight.k) : [0, 0, 0, 0])
  gl.uniform3f(loc.u_rayLight, rayLight?.x ?? 0.5, rayLight?.y ?? 0.2, rays ? fxNumber(rays, 'haze', 25) / 100 : 0)

  const flareLight = flare ? lightOf(flare) : null
  gl.uniform4fv(loc.u_flare, flare && flareLight ? tint(flare, 'tint', '#ffd9a8', (flare.amount / 100) * flareLight.k) : [0, 0, 0, 0])
  gl.uniform4f(loc.u_flareP, flareLight?.x ?? 0.3, flareLight?.y ?? 0.3, flare ? fxNumber(flare, 'size', 50) / 100 : 0.5, flare ? fxNumber(flare, 'ghosts', 60) / 100 : 0)
  gl.uniform1i(loc.u_flareStyle, flare ? Math.max(0, FLARE_STYLES.indexOf(fxString(flare, 'style', 'classic'))) : 0)

  if (particles) {
    gl.uniform4f(loc.u_part, particles.amount / 100, fxNumber(particles, 'size', 40) / 100, fxNumber(particles, 'speed', 35) / 100, fxNumber(particles, 'wind', 15) / 100)
    gl.uniform4f(loc.u_part2, fxNumber(particles, 'depth', 60) / 100, fxNumber(particles, 'light', 0), fxNumber(particles, 'seed', 1), Math.max(0, PARTICLE_STYLES.indexOf(fxString(particles, 'style', 'dust'))))
    gl.uniform3fv(loc.u_partColor, rgbOf(fxString(particles, 'color', '#ffffff')))
  } else gl.uniform4f(loc.u_part, 0, 0, 0, 0)

  if (leak) {
    gl.uniform4f(loc.u_leak, leak.amount / 100, fxNumber(leak, 'speed', 40), (fxNumber(leak, 'angle', 30) * Math.PI) / 180, fxNumber(leak, 'seed', 1))
    gl.uniform3fv(loc.u_leakA, rgbOf(fxString(leak, 'color', '#ff9646')))
    gl.uniform3fv(loc.u_leakB, rgbOf(fxString(leak, 'color2', '#ff4678')))
    gl.uniform1i(loc.u_leakStyle, Math.max(0, LEAK_STYLES.indexOf(fxString(leak, 'style', 'drift'))))
  } else gl.uniform4f(loc.u_leak, 0, 0, 0, 0)

  // Vignettes: the grade's slider and a vignette with no settings keep the original round shape.
  const classic = vignette && !vignette.params ? vignette.amount / 100 : 0
  const slider = input.vignette / 100
  gl.uniform2f(loc.u_vigClassic, Math.min(1, Math.max(0, slider) + classic), Math.max(0, -slider))
  if (vignette && vignette.params) {
    gl.uniform4f(loc.u_vig, vignette.amount / 100, fxNumber(vignette, 'size', 55) / 100, fxNumber(vignette, 'feather', 55) / 100, fxNumber(vignette, 'roundness', 60) / 100)
    gl.uniform2f(loc.u_vigCentre, fxNumber(vignette, 'x', 0.5), fxNumber(vignette, 'y', 0.5))
    gl.uniform3fv(loc.u_vigColor, rgbOf(fxString(vignette, 'color', '#000000')))
  } else gl.uniform4f(loc.u_vig, 0, 0, 0, 0)

  draw(s, p.composite, null, W, H)
  return s.canvas
}
