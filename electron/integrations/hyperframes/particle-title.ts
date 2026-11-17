import { particleDirection, particleStyle } from '../../../shared/motion'
import { color, DROP_SHADOW, esc, FONT_STACKS, js, num, page, stack, type Frame } from './page'

// ─── Particle title ──────────────────────────────────────────────────────
// The title's own letterforms, drawn to a canvas and sampled from its alpha,
// become thousands of particles. They stream in, settle into the glyphs and
// hand over to crisp type behind a moving front; at the end the type breaks
// back into particles and they disperse. Everything is worked out from the
// timeline's time with seeded randomness, so any frame renders on its own.
//
// dust (default): fine, soft motes on curving paths, blown away on the way out.
// sparks: bright and fast with short trails; they shower down under gravity.
// embers: warm and flickering; they rise in, keep rising off the type, and burn it away upward.
// digital: square pixels on a grid, moving in steps; the type resolves cell by cell.

/** Weight and tracking that give each face enough body at display size — thin strokes make thin particles. */
const FACES: Record<string, { weight: number; tracking: number }> = {
  display: { weight: 760, tracking: -0.035 },
  art: { weight: 760, tracking: -0.03 },
  wide: { weight: 820, tracking: -0.02 },
  tech: { weight: 680, tracking: -0.035 },
  sans: { weight: 720, tracking: -0.04 },
  editorial: { weight: 620, tracking: -0.02 },
  serif: { weight: 400, tracking: -0.01 },
  mono: { weight: 640, tracking: -0.04 },
}

export function particleTitle(p: Record<string, unknown>, f: Frame) {
  const fg = color(p.color, '#ffffff')
  const accent = color(p.accent, '#d6ee00')
  const style = particleStyle(p.style)
  const fontKey = typeof p.font === 'string' && p.font in FACES ? p.font : 'display'
  const title = String(p.title ?? '').trim() || 'Your Title'
  // Line breaks the writer chose ("|" or a newline) are kept; otherwise lines are balanced to fit.
  const lines = title
    .split(/\s*\|\s*|\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  const subtitle = String(p.subtitle ?? '').trim()
  const config = {
    width: f.width,
    height: f.height,
    title: lines.join(' ').slice(0, 120),
    lines: lines.length > 1 ? lines.slice(0, 4) : null,
    family: stack(fontKey, 'display'),
    ...FACES[fontKey],
    style,
    direction: particleDirection(p.direction, style),
    seed: Math.abs(Math.round(num(p.seed, 1))) % 2147483647 || 1,
    color: fg,
    accent,
    subtitle: Boolean(subtitle),
  }
  const css = `
    #pt { position: absolute; inset: 0; width: 100%; height: 100%; }
    .after { position: absolute; left: 0; right: 0; top: 0; display: flex; flex-direction: column; align-items: center; text-align: center; padding: 0 10%; color: ${fg}; }
    .rule { width: calc(56px * var(--s)); height: calc(1.5px * var(--s)); background: ${accent}; transform: scaleX(0); }
    .after .mask > * { will-change: auto; }
    .sub { margin-top: calc(22px * var(--s)); font-family: ${FONT_STACKS.sans}; font-size: calc(26px * var(--s)); font-weight: 420; letter-spacing: 0.005em; line-height: 1.3; opacity: 0.82; text-wrap: balance; ${DROP_SHADOW} }`
  const body = `
    <canvas id="pt"></canvas>
    ${subtitle ? `<div class="after"><div class="rule"></div><p class="sub"><span class="mask"><span>${esc(subtitle)}</span></span></p></div>` : ''}`
  return page(f, css, body, `const C = ${js(config)};\n${RUNTIME}`, p)
}

/**
 * The page's side: lays the title out, samples it, and draws every frame from
 * the timeline's time alone. Registered with the runtime's buildReady so no
 * frame is captured before the font has loaded and the particles exist.
 */
const RUNTIME = String.raw`
// Flat transforms only: a 3D one gets a layer of its own, whose cached raster can differ with the frames drawn before.
gsap.config({ force3D: false });
const s = Math.min(C.width, C.height) / 1080;
const dpr = window.devicePixelRatio || 1;
const cv = document.getElementById('pt');
cv.width = Math.round(C.width * dpr);
cv.height = Math.round(C.height * dpr);
const ctx = cv.getContext('2d');
const layer = (read) => {
  const c = document.createElement('canvas');
  c.width = cv.width;
  c.height = cv.height;
  return [c, c.getContext('2d', read ? { willReadFrequently: true } : undefined)];
};
// The crisp title is painted once, in software: GPU text rasterising can differ by a level or two from one load to the next.
const [typeCv, tctx] = layer(true);
const [scratch, sctx] = layer(false);

// Seeded randomness: the same seed scatters the same way on every render.
let seed = C.seed >>> 0;
const rand = () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
// Noise keyed by particle and step (flicker, glitches): nothing depends on the frame drawn before.
const hash = (a, b) => {
  let h = Math.imul(a + 0x7f4a7c15, 0x9e3779b1) ^ Math.imul(b + 0x165667b1, 0x85ebca77);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
};
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, k) => a + (b - a) * k;
const rgb = (hex) => {
  let h = hex.slice(1);
  if (h.length <= 4) h = h.split('').map((c) => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
};

// How each style moves: how many particles, their travel and exit times, how long the wave takes to cross the title (in and out).
const STYLES = {
  dust: { count: 4200, travel: [0.85, 1.3], wave: 0.5, jitter: 0.22, size: [0.5, 0.95], exit: [0.6, 0.95], xwave: 0.26 },
  sparks: { count: 1700, travel: [0.55, 0.95], wave: 0.6, jitter: 0.3, size: [0.45, 0.6], exit: [0.5, 0.8], xwave: 0.36 },
  embers: { count: 3000, travel: [1.0, 1.45], wave: 0.55, jitter: 0.25, size: [0.55, 1.05], exit: [0.7, 1.0], xwave: 0.26 },
  digital: { count: 1100, travel: [0.55, 0.9], wave: 0.5, jitter: 0.2, size: [0.84, 0.84], exit: [0.4, 0.7], xwave: 0.26 },
};
const S = STYLES[C.style];
const DIGITAL = C.style === 'digital';
const STEPS = 15; // digital motion steps per second
// A short clip plays the same moves faster.
const k = Math.min(1, Math.max(0.3, D / 5.5));
const IN0 = 0.1 * k;
const T0 = S.travel[0] * k;
const T1 = S.travel[1] * k;
const WAVE = S.wave * k;
const JIT = S.jitter * k;
// The type resolves behind the arrivals: where the wave began first, each point over BAND seconds.
const R0 = IN0 + JIT + T1 * 0.85;
const BAND = 0.32 * k;
const RESOLVED = DIGITAL ? IN0 + WAVE + JIT + T1 + 2 / STEPS : R0 + WAVE + BAND;
// The exit: the type breaks up along a front (quick, accelerating) and the particles disperse.
const XLEN = Math.min(1.2, D * 0.24);
const X0 = D - XLEN;
const XWAVE = XLEN * S.xwave;
const XBAND = XLEN * 0.12;
const XJIT = XLEN * 0.06;
const XK = Math.min(1, (XLEN - XWAVE - XBAND * 0.5 - XJIT - 0.05) / S.exit[1]);
const IN_AXIS = C.direction === 'everywhere' ? 'radial' : C.direction;
const OUT_AXIS = C.style === 'embers' ? 'below' : IN_AXIS;

let N = 0;
let ready = false;
let TX, TY, SX, SY, DEL, TRV, FIN, FOUT, XS, XD, VX, VY, SZ, AL, CI, PH, BEND, RV;
let box, cx, cy, radius, cell = 0, spacing = 1;
let AMB = 0;
let AO, AP, AR, AS;
let sprites = [];
let colors = [];

const FONT = (px) => C.weight + ' ' + px + 'px ' + C.family;

function setType(c, px) {
  c.font = FONT(px);
  c.letterSpacing = (C.tracking * px).toFixed(2) + 'px';
  c.textAlign = 'left';
  c.textBaseline = 'alphabetic';
}

// The largest size that fits in the title-safe width, in as few balanced lines as that size allows.
function fit(c) {
  const maxW = C.width * 0.84;
  const words = C.title.split(/\s+/).filter(Boolean);
  for (let px = Math.round(172 * s); ; px = Math.floor(px * 0.96)) {
    setType(c, px);
    const width = (line) => c.measureText(line).width;
    const greedy = (w) => {
      const out = [];
      let line = '';
      for (const word of words) {
        const next = line ? line + ' ' + word : word;
        if (line && width(next) > w) {
          out.push(line);
          line = word;
        } else line = next;
      }
      if (line) out.push(line);
      return out;
    };
    let lines = C.lines;
    if (!lines) {
      lines = greedy(maxW);
      if (lines.length > 1) {
        // Balanced: the narrowest measure that needs no more lines (no orphan on the last one).
        let lo = 0;
        let hi = maxW;
        for (let i = 0; i < 14; i++) {
          const mid = (lo + hi) / 2;
          if (greedy(mid).length <= lines.length) hi = mid;
          else lo = mid;
        }
        lines = greedy(hi);
      }
    }
    const allowed = C.lines ? Infinity : px >= 150 * s ? 1 : px >= 104 * s ? 2 : 3;
    if (px <= 48 * s || (lines.length <= allowed && lines.every((l) => width(l) <= maxW))) return { px, lines };
  }
}

function paint(c, px, lines, top, shadow) {
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  setType(c, px);
  c.fillStyle = C.color;
  // Centre the ink, not the advance (tracking adds space after the last letter).
  const x = (line) => {
    const m = c.measureText(line);
    return C.width / 2 - (m.actualBoundingBoxRight - m.actualBoundingBoxLeft) / 2;
  };
  if (shadow) {
    // The same soft, close shadow as the other templates' type: drawn from copies pushed out of frame, so the type itself is drawn once.
    const away = C.width + C.height;
    for (const [shade, blur, y] of [
      ['rgba(0,0,0,0.35)', 24 * s, 4 * s],
      ['rgba(0,0,0,0.25)', 2 * s, 1 * s],
    ]) {
      c.shadowColor = shade;
      c.shadowBlur = blur * dpr;
      c.shadowOffsetX = away * dpr;
      c.shadowOffsetY = y * dpr;
      lines.forEach((line, i) => c.fillText(line, x(line) - away, top[i]));
    }
    c.shadowColor = 'transparent';
  }
  lines.forEach((line, i) => c.fillText(line, x(line), top[i]));
}

function sprite(r, g, b, soft) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  const grad = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  const col = (a) => 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  grad.addColorStop(0, col(1));
  if (soft) {
    // Dust carries a faint dark rim, as type carries its shadow: it reads over a bright sky, and is nothing over dark.
    grad.addColorStop(0.22, col(1));
    grad.addColorStop(0.46, col(0.38));
    grad.addColorStop(0.66, 'rgba(0,0,0,0.14)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
  } else {
    grad.addColorStop(0.4, col(1));
    grad.addColorStop(0.62, col(0.5));
    grad.addColorStop(1, col(0));
  }
  x.fillStyle = grad;
  x.fillRect(0, 0, 64, 64);
  return c;
}

// Embers glow by heat: deep red when cool, through orange, to near white when hottest.
const HEAT = [
  [0, [104, 22, 6]],
  [0.35, [206, 58, 16]],
  [0.6, [255, 122, 34]],
  [0.8, [255, 190, 88]],
  [1, [255, 242, 212]],
];
function heatRgb(h) {
  for (let i = 1; i < HEAT.length; i++) {
    if (h <= HEAT[i][0]) {
      const [a, ca] = HEAT[i - 1];
      const [b, cb] = HEAT[i];
      const k2 = (h - a) / (b - a);
      return [0, 1, 2].map((j) => Math.round(lerp(ca[j], cb[j], k2)));
    }
  }
  return HEAT[HEAT.length - 1][1];
}

function build() {
  // The title is measured and sampled on a canvas of its own, without the shadow the visible one carries.
  const [, actx] = layer(true);
  actx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const { px, lines } = fit(actx);
  setType(actx, px);
  const cap = actx.measureText('H').actualBoundingBoxAscent;
  const lineH = px * 1.02;
  const blockH = cap + (lines.length - 1) * lineH;
  const centre = C.height / 2 - (C.subtitle ? 46 * s : 0);
  const top = lines.map((_, i) => centre - blockH / 2 + cap + i * lineH);
  paint(actx, px, lines, top, false);
  paint(tctx, px, lines, top, true);

  // The ink's box.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  lines.forEach((line, i) => {
    const m = actx.measureText(line);
    const w = m.actualBoundingBoxRight + m.actualBoundingBoxLeft;
    x0 = Math.min(x0, C.width / 2 - w / 2);
    x1 = Math.max(x1, C.width / 2 + w / 2);
    y0 = Math.min(y0, top[i] - m.actualBoundingBoxAscent);
    y1 = Math.max(y1, top[i] + m.actualBoundingBoxDescent);
  });
  box = { x0: x0 - 2, y0: y0 - 2, x1: x1 + 2, y1: y1 + 2 };
  cx = (box.x0 + box.x1) / 2;
  cy = (box.y0 + box.y1) / 2;
  const after = document.querySelector('.after');
  if (after) after.style.top = box.y1 + 30 * s + 'px';

  // Sample the ink: jittered points for soft styles, whole grid cells for digital.
  const X = Math.max(0, Math.floor(box.x0 * dpr));
  const Y = Math.max(0, Math.floor(box.y0 * dpr));
  const BW = Math.min(cv.width, Math.ceil(box.x1 * dpr)) - X;
  const BH = Math.min(cv.height, Math.ceil(box.y1 * dpr)) - Y;
  const pts = [];
  if (BW > 0 && BH > 0) {
    const img = actx.getImageData(X, Y, BW, BH).data;
    const alpha = (x, y) => img[(y * BW + x) * 4 + 3];
    let ink = 0;
    for (let y = 0; y < BH; y += 2) for (let x = 0; x < BW; x += 2) if (alpha(x, y) > 127) ink += 4;
    const step = Math.max(2 * dpr, Math.sqrt(ink / S.count));
    spacing = step / dpr;
    if (DIGITAL) {
      cell = Math.max(3, Math.round(step));
      for (let gy = 0; gy * cell < BH; gy++) {
        for (let gx = 0; gx * cell < BW; gx++) {
          let on = 0;
          for (let sy = 0; sy < 3; sy++) {
            for (let sx = 0; sx < 3; sx++) {
              const x = Math.min(BW - 1, Math.floor((gx + (sx + 0.5) / 3) * cell));
              const y = Math.min(BH - 1, Math.floor((gy + (sy + 0.5) / 3) * cell));
              if (alpha(x, y) > 110) on++;
            }
          }
          if (on >= 3) pts.push((X + (gx + 0.5) * cell) / dpr, (Y + (gy + 0.5) * cell) / dpr);
        }
      }
    } else {
      for (let gy = 0; gy * step < BH; gy++) {
        for (let gx = 0; gx * step < BW; gx++) {
          const x = (gx + rand()) * step;
          const y = (gy + rand()) * step;
          if (x < BW && y < BH && alpha(Math.floor(x), Math.floor(y)) > 127) pts.push((X + x) / dpr, (Y + y) / dpr);
        }
      }
    }
  }

  N = pts.length / 2;
  const F = () => new Float32Array(N);
  TX = F(); TY = F(); SX = F(); SY = F(); DEL = F(); TRV = F(); FIN = F(); FOUT = F(); XS = F(); XD = F();
  VX = F(); VY = F(); SZ = F(); AL = F(); PH = F(); BEND = F(); RV = F();
  CI = new Uint8Array(N);
  radius = 1;
  for (let i = 0; i < N; i++) radius = Math.max(radius, Math.hypot(pts[i * 2] - cx, pts[i * 2 + 1] - cy));
  const bw = Math.max(1, box.x1 - box.x0);
  const bh = Math.max(1, box.y1 - box.y0);
  const along = (axis, x, y) => clamp01(axis === 'left' ? (x - box.x0) / bw : axis === 'right' ? (box.x1 - x) / bw : axis === 'below' ? (box.y1 - y) / bh : Math.hypot(x - cx, y - cy) / radius);
  const W = C.width;
  const H = C.height;
  const grid = cell / dpr;
  const snap = (v) => (grid ? Math.round(v / grid) * grid : v);
  for (let i = 0; i < N; i++) {
    const tx = pts[i * 2];
    const ty = pts[i * 2 + 1];
    TX[i] = tx;
    TY[i] = ty;
    FIN[i] = along(IN_AXIS, tx, ty);
    FOUT[i] = along(OUT_AXIS, tx, ty);
    const r1 = rand(), r2 = rand(), r3 = rand(), r4 = rand(), r5 = rand(), r6 = rand(), r7 = rand(), r8 = rand();
    // Where it starts: a stream from one side, rising from below, or scattered over the whole frame.
    // Sparks fan out wider and come from further off, so they arrive as a spray, not a stream.
    const spread = (r2 + r3 - 1) * (C.style === 'sparks' ? 0.42 : 0.3) * H;
    const depth = C.style === 'sparks' ? 0.55 : 0.34;
    if (C.direction === 'left') {
      SX[i] = -0.04 * W - r1 * depth * W;
      SY[i] = ty + spread;
    } else if (C.direction === 'right') {
      SX[i] = W * 1.04 + r1 * depth * W;
      SY[i] = ty + spread;
    } else if (C.direction === 'below') {
      SX[i] = tx + (r2 + r3 - 1) * 0.28 * W;
      SY[i] = H * 1.04 + r1 * 0.32 * H;
    } else {
      SX[i] = -0.06 * W + r1 * 1.12 * W;
      SY[i] = -0.06 * H + r2 * 1.12 * H;
    }
    if (DIGITAL) {
      SX[i] = snap(SX[i]);
      SY[i] = snap(SY[i]);
    }
    DEL[i] = IN0 + FIN[i] * WAVE + r4 * JIT;
    TRV[i] = lerp(T0, T1, r5);
    // Arcs bow either way for dust and embers; sparks all bow down, like thrown sparks.
    BEND[i] = C.style === 'sparks' ? 0.03 + 0.09 * r6 : (r6 - 0.5) * 0.36;
    PH[i] = r7 * Math.PI * 2;
    SZ[i] = lerp(S.size[0], S.size[1], r8);
    AL[i] = C.style === 'dust' ? 0.55 + 0.45 * r3 : C.style === 'embers' ? 0.5 + 0.5 * r1 : C.style === 'sparks' ? 0.62 + 0.2 * r1 : 1;
    // A share of the particles in the accent (embers keep to their own heat colours).
    CI[i] = C.style === 'embers' ? Math.min(7, Math.floor(r2 * 4 + 4 * r8)) : r6 < (C.style === 'sparks' ? 0.32 : C.style === 'digital' ? 0.15 : 0.18) ? 1 : C.style === 'sparks' && r6 > 0.7 ? 2 : 0;
    RV[i] = DIGITAL ? Math.ceil((DEL[i] + TRV[i]) * STEPS) / STEPS + 2 / STEPS : 0;
    XS[i] = X0 + FOUT[i] * XWAVE + XBAND * 0.5 + rand() * XJIT;
    XD[i] = lerp(S.exit[0], S.exit[1], rand()) * XK;
    // How it leaves: carried on in the direction of the front, out from the centre, or up.
    const a = rand();
    const b = rand();
    let dx = 1, dy = 0;
    if (OUT_AXIS === 'right') dx = -1;
    else if (OUT_AXIS === 'below') { dx = 0; dy = -1; }
    else if (OUT_AXIS === 'radial') {
      const d = Math.hypot(tx - cx, ty - cy) || 1;
      dx = (tx - cx) / d;
      dy = ((ty - cy) / d) * 0.6 - 0.2;
    }
    if (C.style === 'sparks') {
      const ang = Math.atan2(dy, dx) + (a - 0.5) * 1.6;
      const v = (700 + 900 * b) * s;
      VX[i] = Math.cos(ang) * v;
      VY[i] = Math.sin(ang) * v - 300 * s;
    } else if (C.style === 'embers') {
      VX[i] = (a - 0.5) * 60 * s;
      VY[i] = -(90 + 190 * b) * s;
    } else {
      const dist = (DIGITAL ? 0.12 + 0.3 * b : 0.18 + 0.32 * b) * W;
      VX[i] = dx * dist + (a - 0.5) * 0.08 * W * Math.abs(dy);
      VY[i] = dy * dist + (a - 0.5) * 0.12 * H * Math.abs(dx) - 0.03 * H;
    }
  }

  // Life during the hold: dust motes drifting round the title, embers rising off it.
  AMB = C.style === 'dust' ? 70 : C.style === 'embers' ? 120 : 0;
  AO = new Float32Array(AMB * 2);
  AP = new Float32Array(AMB);
  AR = new Float32Array(AMB);
  AS = new Float32Array(AMB);
  for (let j = 0; j < AMB; j++) {
    AO[j * 2] = rand();
    AO[j * 2 + 1] = rand();
    AP[j] = 1.4 + rand() * 1.4;
    AR[j] = rand() * 10;
    AS[j] = rand();
  }

  const fg = rgb(C.color);
  const ac = rgb(C.accent);
  if (C.style === 'embers') sprites = Array.from({ length: 8 }, (_, h) => sprite(...heatRgb(0.3 + h * 0.1), true));
  else sprites = [sprite(...fg, C.style === 'dust'), sprite(...ac, C.style === 'dust'), sprite(255, 246, 226, false)];
  colors = [fg, ac, [255, 246, 226]].map((c) => 'rgb(' + c.join(',') + ')');
  ready = true;
  draw(clock.now);
}

// How much of the crisp type shows at a point of the title, from where it sits along the in and out fronts.
const typeIn = (f, t) => clamp01((t - R0 - f * WAVE) / BAND);
const typeOut = (f, t) => 1 - clamp01((t - X0 - f * XWAVE) / XBAND);

function front(axis) {
  if (axis === 'radial') return sctx.createRadialGradient(cx * dpr, cy * dpr, 0, cx * dpr, cy * dpr, radius * dpr);
  if (axis === 'left') return sctx.createLinearGradient(box.x0 * dpr, 0, box.x1 * dpr, 0);
  if (axis === 'right') return sctx.createLinearGradient(box.x1 * dpr, 0, box.x0 * dpr, 0);
  return sctx.createLinearGradient(0, box.y1 * dpr, 0, box.y0 * dpr);
}

// A gradient whose alpha is exactly the ramp a(f): stops at both ends and at the ramp's two corners.
function ramp(axis, a, from, wave, band, t) {
  const g = front(axis);
  const stops = [0, 1, (t - from - band) / wave, (t - from) / wave].filter((v) => v >= 0 && v <= 1).sort((p, q) => p - q);
  for (const f of stops) g.addColorStop(f, 'rgba(0,0,0,' + a(f, t).toFixed(4) + ')');
  return g;
}

function drawType(t) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (DIGITAL) {
    // With no ink sampled there are no cells: the type simply shows for the hold.
    if (!N) return t >= RESOLVED && t < X0 ? ctx.drawImage(typeCv, 0, 0) : undefined;
    // Cell by cell: each pixel's square of crisp type shows once it has landed, until it leaves.
    let all = true;
    let any = false;
    for (let i = 0; i < N; i++) {
      const on = t >= RV[i] && t < XS[i];
      all = all && on;
      any = any || on;
    }
    if (!any) return;
    if (all) return ctx.drawImage(typeCv, 0, 0);
    sctx.globalCompositeOperation = 'copy';
    sctx.drawImage(typeCv, 0, 0);
    sctx.globalCompositeOperation = 'destination-in';
    sctx.beginPath();
    const half = cell / 2;
    for (let i = 0; i < N; i++) if (t >= RV[i] && t < XS[i]) sctx.rect(Math.round(TX[i] * dpr - half), Math.round(TY[i] * dpr - half), cell, cell);
    sctx.fillStyle = '#000';
    sctx.fill();
    ctx.drawImage(scratch, 0, 0);
    return;
  }
  const inLow = typeIn(1, t);
  const outLow = typeOut(0, t);
  if (typeIn(0, t) <= 0 || typeOut(1, t) <= 0) return;
  if (inLow >= 1 && outLow >= 1) return ctx.drawImage(typeCv, 0, 0);
  sctx.globalCompositeOperation = 'copy';
  sctx.drawImage(typeCv, 0, 0);
  sctx.globalCompositeOperation = 'destination-in';
  if (inLow < 1) {
    sctx.fillStyle = ramp(IN_AXIS, typeIn, R0, WAVE, BAND, t);
    sctx.fillRect(0, 0, cv.width, cv.height);
  }
  if (outLow < 1) {
    sctx.fillStyle = ramp(OUT_AXIS, typeOut, X0, XWAVE, XBAND, t);
    sctx.fillRect(0, 0, cv.width, cv.height);
  }
  ctx.drawImage(scratch, 0, 0);
}

// Where particle i is at time t and how visible: x, y, a (0: not drawn), heat (embers), px, py (sparks: where it was a moment ago).
const o = { x: 0, y: 0, a: 0, heat: 0, px: 0, py: 0 };
const was = { x: 0, y: 0 };
const TRAIL = 0.022;
function inPath(i, u, out) {
  const sx = SX[i], sy = SY[i], dx = TX[i] - sx, dy = TY[i] - sy;
  if (u >= 1) {
    out.x = TX[i];
    out.y = TY[i];
    return;
  }
  if (DIGITAL) {
    // Stepped, along the grid: one axis, then the other.
    const steps = Math.max(2, Math.round(TRV[i] * STEPS));
    const q = Math.floor(u * steps) / steps;
    const e = q < 0.5 ? 2 * q * q : 1 - Math.pow(2 - 2 * q, 2) / 2;
    const first = clamp01(e * 2), second = clamp01(e * 2 - 1);
    const grid = cell / dpr;
    out.x = Math.round((sx + dx * (BEND[i] > 0 ? first : second)) / grid) * grid;
    out.y = Math.round((sy + dy * (BEND[i] > 0 ? second : first)) / grid) * grid;
    return;
  }
  if (C.style === 'embers') {
    const ex = 1 - Math.pow(1 - u, 3.2);
    const ey = 1 - Math.pow(1 - u, 2.2);
    out.x = sx + dx * ex + Math.sin(u * 7 + PH[i]) * (1 - u) * 24 * s;
    out.y = sy + dy * ey;
    return;
  }
  const e = C.style === 'sparks' ? (1 - Math.pow(2, -9 * u)) / (1 - Math.pow(2, -9)) : 1 - Math.pow(1 - u, 4);
  const len = Math.hypot(dx, dy) || 1;
  let nx = -dy / len, ny = dx / len;
  if (C.style === 'sparks' && ny < 0) { nx = -nx; ny = -ny; }
  const bow = Math.sin(Math.PI * e) * BEND[i] * len + (C.style === 'dust' ? Math.sin(u * 9.4 + PH[i]) * (1 - e) * 9 * s : 0);
  out.x = sx + dx * e + nx * bow;
  out.y = sy + dy * e + ny * bow;
}

function outPath(i, tau, out) {
  const v = clamp01(tau / XD[i]);
  if (C.style === 'sparks') {
    out.x = TX[i] + VX[i] * tau;
    out.y = TY[i] + VY[i] * tau + 1300 * s * tau * tau;
  } else if (C.style === 'embers') {
    const e = Math.pow(v, 1.6);
    out.x = TX[i] + VX[i] * e + Math.sin(v * 5 + PH[i]) * v * 26 * s;
    out.y = TY[i] + VY[i] * e;
  } else if (DIGITAL) {
    const q = Math.floor(tau * STEPS) / STEPS / XD[i];
    const grid = cell / dpr;
    out.x = Math.round((TX[i] + VX[i] * q * q) / grid) * grid;
    out.y = Math.round((TY[i] + VY[i] * q * q) / grid) * grid;
  } else {
    const e = v * v;
    out.x = TX[i] + VX[i] * e + Math.sin(v * 6 + PH[i]) * v * 16 * s;
    out.y = TY[i] + VY[i] * e + Math.cos(v * 5 + PH[i]) * v * 12 * s;
  }
}

function place(i, t, out) {
  out.a = 0;
  out.heat = 0;
  if (t < XS[i]) {
    const u = (t - DEL[i]) / TRV[i];
    if (u <= 0) return;
    inPath(i, Math.min(1, u), out);
    let a = AL[i] * clamp01(u / 0.12);
    if (DIGITAL) {
      if (t >= RV[i]) return;
    } else a *= 1 - typeIn(FIN[i], t) * typeOut(FOUT[i], t);
    out.a = a;
    out.heat = u < 1 ? 1 - u * 0.4 : Math.max(0.35, 0.6 - (t - DEL[i] - TRV[i]) * 0.5);
    if (C.style === 'sparks') {
      inPath(i, clamp01((t - TRAIL - DEL[i]) / TRV[i]), was);
      out.px = was.x;
      out.py = was.y;
      // A landing flashes for an instant.
      const since = t - DEL[i] - TRV[i];
      if (since >= 0 && since < 0.2) out.a = Math.min(1, out.a * (1.8 - since * 4));
    }
    return;
  }
  const tau = t - XS[i];
  if (tau >= XD[i]) return;
  outPath(i, tau, out);
  const v = tau / XD[i];
  // Sparks thin out fast as they fall: added together, a shower turns to a white smear.
  out.a = AL[i] * Math.pow(1 - v, C.style === 'sparks' ? 1.8 : 1.3) * (C.style === 'sparks' ? 0.7 : 1) * (DIGITAL ? 1 : 1 - typeOut(FOUT[i], t));
  out.heat = Math.max(0, 1 - v * 1.2);
  if (C.style === 'sparks') {
    outPath(i, Math.max(0, tau - TRAIL), was);
    out.px = was.x;
    out.py = was.y;
  }
  if (DIGITAL && hash(i, Math.floor(t * STEPS)) < 0.25) out.a *= 0.35;
}

function drawParticles(t) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // A particle's size follows the spacing it was sampled at, so the dots fill the letters at any title length.
  const unit = DIGITAL ? cell / dpr : Math.max(1.1 * s, Math.min(4.5 * s, spacing));
  if (C.style === 'sparks') {
    // Bright: additive, and drawn in a few batches by colour and brightness.
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    const LEVELS = 6;
    const paths = [];
    for (let i = 0; i < N; i++) {
      place(i, t, o);
      if (o.a <= 0.01) continue;
      const key = CI[i] * LEVELS + Math.min(LEVELS - 1, Math.floor(o.a * LEVELS));
      const path = paths[key] || (paths[key] = new Path2D());
      // A slight trail: never longer than a short streak, however fast the spark.
      const dx = o.px - o.x, dy = o.py - o.y, len = Math.hypot(dx, dy), most = 46 * s;
      path.moveTo(len > most ? o.x + (dx * most) / len : o.px, len > most ? o.y + (dy * most) / len : o.py);
      path.lineTo(o.x + 0.01, o.y);
    }
    ctx.lineWidth = unit * 0.8;
    paths.forEach((path, key) => {
      if (!path) return;
      ctx.globalAlpha = ((key % LEVELS) + 1) / LEVELS;
      ctx.strokeStyle = colors[Math.floor(key / LEVELS)];
      ctx.stroke(path);
    });
  } else if (DIGITAL) {
    const size = unit * S.size[0];
    for (let i = 0; i < N; i++) {
      place(i, t, o);
      if (o.a <= 0.01) continue;
      ctx.globalAlpha = o.a;
      ctx.fillStyle = colors[CI[i]];
      ctx.fillRect(o.x - size / 2, o.y - size / 2, size, size);
    }
  } else {
    if (C.style === 'embers') ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < N; i++) {
      place(i, t, o);
      if (o.a <= 0.01) continue;
      const r = unit * SZ[i] * 1.6;
      let img = sprites[CI[i]];
      if (C.style === 'embers') {
        // Each ember flickers on its own rhythm, and cools as it settles.
        const flicker = 0.78 + 0.22 * Math.sin(t * (9 + PH[i] * 1.7) + PH[i] * 3);
        img = sprites[Math.max(0, Math.min(7, Math.round(CI[i] * o.heat * flicker)))];
        ctx.globalAlpha = o.a * flicker;
      } else ctx.globalAlpha = o.a;
      ctx.drawImage(img, o.x - r, o.y - r, r * 2, r * 2);
    }
    // The hold breathes: motes drift round the title, embers lift off it.
    const life = clamp01((t - RESOLVED + 0.3 * k) / (0.6 * k)) * clamp01((Math.min(X0 + 0.25 * k, D - 0.05) - t) / (0.5 * k));
    if (life > 0 && N) {
      for (let j = 0; j < AMB; j++) {
        const cycle = (t + AR[j]) / AP[j];
        const n = Math.floor(cycle);
        const age = cycle - n;
        if (C.style === 'embers') {
          const src = Math.floor(hash(j, n) * N);
          if (TY[src] > cy + (box.y1 - box.y0) * 0.1) continue;
          const x = TX[src] + Math.sin(age * 5 + AS[j] * 6) * 14 * s * age;
          const y = TY[src] - age * (60 + 110 * AS[j]) * s;
          ctx.globalAlpha = life * Math.sin(Math.PI * age) * 0.85;
          const r = unit * (0.7 + 0.5 * AS[j]) * 1.6;
          ctx.drawImage(sprites[Math.max(0, Math.round(7 * (1 - age)))], x - r, y - r, r * 2, r * 2);
        } else {
          const bx = box.x0 - 60 * s + AO[j * 2] * (box.x1 - box.x0 + 120 * s);
          const by = box.y0 - 50 * s + AO[j * 2 + 1] * (box.y1 - box.y0 + 100 * s);
          const x = bx + Math.sin(t * 0.6 + AR[j]) * 18 * s;
          const y = by + Math.cos(t * 0.45 + AR[j] * 1.3) * 12 * s - t * 6 * s;
          ctx.globalAlpha = life * (0.18 + 0.3 * AS[j]) * (0.6 + 0.4 * Math.sin(t * 1.3 + AR[j]));
          const r = unit * (0.5 + 0.4 * AS[j]) * 1.6;
          ctx.drawImage(sprites[0], x - r, y - r, r * 2, r * 2);
        }
      }
    }
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

function draw(t) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  if (!ready) return;
  drawType(t);
  drawParticles(t);
}

// One linear clock over the whole piece: setting its time draws that moment (on any seek, callbacks or not).
const clock = {
  now: 0,
  get t() {
    return this.now;
  },
  set t(v) {
    this.now = v;
    draw(v);
  },
};
tl.to(clock, { t: D, duration: D, ease: 'none' }, 0);
if (C.subtitle) {
  // Hidden until it comes in, and once it's out: its soft shadow would otherwise show at the mask's edge.
  gsap.set('.sub .mask > span', { yPercent: 110, visibility: 'hidden' });
  // Read for a while once it's in, and gone before the end however short the clip.
  const leave = Math.min(D - 0.55 * k, Math.max(RESOLVED + 0.6 * k, X0 - 0.42 * k));
  tl.to('.rule', { scaleX: 1, duration: 0.7 * k, ease: 'power3.inOut' }, RESOLVED - 0.3 * k)
    .set('.sub .mask > span', { visibility: 'visible' }, RESOLVED - 0.08 * k)
    .to('.sub .mask > span', { yPercent: 0, duration: 0.75 * k, ease: 'power2.out' }, RESOLVED - 0.08 * k)
    .to('.sub .mask > span', { yPercent: -110, duration: 0.34 * k, ease: 'power2.in' }, leave)
    .to('.rule', { scaleX: 0, duration: 0.3 * k, ease: 'power2.in' }, leave + 0.1 * k)
    .set('.sub .mask > span', { visibility: 'hidden' }, leave + 0.34 * k);
}

// No frame is captured before the font has loaded and the particles exist.
const built = document.fonts.load(FONT(100), C.title).then(build, build);
window.__hf = window.__hf || {};
window.__hf.buildReady = window.__hf.buildReady || {};
window.__hf.buildReady.particleTitle = built;
`
