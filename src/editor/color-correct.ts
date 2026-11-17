/**
 * Colour correction: the first stage of a grade, on the footage as it came in —
 * white balance (gains in linear light), levels, and shot matching (per-channel
 * curves that line one clip's tones and colours up with another's). Pure maths
 * shared by the GPU grade, the inspector and the AI tools, unit-tested.
 *
 * The three compose into one curve per channel, so the GPU applies the whole
 * correction with a single table lookup.
 */
import { evalCurve, isIdentityCurve } from './color-math'
import type { ColorGrade, CurvePoints, Levels, ShotMatch, WhiteBalance } from './types'

export const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
export const toSrgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const round = (v: number, places = 4) => Math.round(v * 10 ** places) / 10 ** places

export const NEUTRAL_BALANCE: WhiteBalance = { r: 1, g: 1, b: 1 }
export const NEUTRAL_LEVELS: Levels = { black: 0, white: 1, gamma: 1 }

export const isNeutralBalance = (b?: WhiteBalance) => !b || (Math.abs(b.r - 1) < 1e-4 && Math.abs(b.g - 1) < 1e-4 && Math.abs(b.b - 1) < 1e-4)
export const isNeutralLevels = (l?: Levels) => !l || (l.black <= 1e-4 && l.white >= 1 - 1e-4 && Math.abs(l.gamma - 1) < 1e-4)
export const isNeutralMatch = (m?: ShotMatch) => !m || (isIdentityCurve(m.red) && isIdentityCurve(m.green) && isIdentityCurve(m.blue))

/** Whether a grade has a correction stage to run. */
export const hasCorrection = (g: Pick<ColorGrade, 'balance' | 'levels' | 'match'>) => !isNeutralBalance(g.balance) || !isNeutralLevels(g.levels) || !isNeutralMatch(g.match)

const MIN_GAIN = 0.25
const MAX_GAIN = 4

/**
 * Gains that make `rgb` — an sRGB colour (0..1) picked off something that should
 * be neutral: a white shirt, a grey wall — neutral, keeping its brightness. In
 * linear light each channel is scaled to the colour's luminance.
 */
export function balanceFor(rgb: readonly [number, number, number]): WhiteBalance {
  const lin = rgb.map((v) => Math.max(1e-4, toLinear(clamp01(v))))
  const y = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
  const gain = (c: number) => round(Math.min(MAX_GAIN, Math.max(MIN_GAIN, y / c)))
  return { r: gain(lin[0]), g: gain(lin[1]), b: gain(lin[2]) }
}

/** One channel through levels: black and white points, then the midtone gamma (above 1 brightens). */
export function applyLevels(v: number, l: Levels) {
  const span = Math.max(1e-3, l.white - l.black)
  return Math.pow(clamp01((v - l.black) / span), 1 / Math.max(0.1, l.gamma))
}

/** One channel's value through the balance (in linear light). */
const balanced = (v: number, gain: number) => clamp01(toSrgb(clamp01(toLinear(v) * gain)))

/**
 * The whole correction as a table per channel: `size` entries each, red, green
 * and blue interleaved (RGB, RGB…). Null when the grade has no correction.
 */
export function correctionTable(g: Pick<ColorGrade, 'balance' | 'levels' | 'match'>, size = 256): Float32Array | null {
  if (!hasCorrection(g)) return null
  const gains = isNeutralBalance(g.balance) ? null : [g.balance!.r, g.balance!.g, g.balance!.b]
  const levels = isNeutralLevels(g.levels) ? null : g.levels!
  const curves = isNeutralMatch(g.match) ? null : [g.match!.red, g.match!.green, g.match!.blue]
  const out = new Float32Array(size * 3)
  for (let i = 0; i < size; i++) {
    const x = i / (size - 1)
    for (let c = 0; c < 3; c++) {
      let v = x
      if (gains) v = balanced(v, gains[c])
      if (levels) v = applyLevels(v, levels)
      if (curves) v = clamp01(evalCurve(curves[c], v))
      out[i * 3 + c] = v
    }
  }
  return out
}

/** Runs one sRGB colour through the correction (what the GPU does with the table). */
export function correctColor(rgb: readonly [number, number, number], g: Pick<ColorGrade, 'balance' | 'levels' | 'match'>): [number, number, number] {
  const gains = g.balance ?? NEUTRAL_BALANCE
  const curves = g.match ? [g.match.red, g.match.green, g.match.blue] : null
  return rgb.map((v, c) => {
    let x = isNeutralBalance(g.balance) ? clamp01(v) : balanced(v, [gains.r, gains.g, gains.b][c])
    if (!isNeutralLevels(g.levels)) x = applyLevels(x, g.levels!)
    if (curves && !isNeutralMatch(g.match)) x = clamp01(evalCurve(curves[c], x))
    return x
  }) as [number, number, number]
}

// ─── Measuring footage ───────────────────────────────────────────────────

/** Pixels to measure: RGB triples (0..1) from RGBA data, every `step`-th pixel, skipping see-through ones. */
export function samplePixels(rgba: ArrayLike<number>, step = 1): Float32Array {
  const n = Math.floor(rgba.length / 4)
  const out: number[] = []
  for (let i = 0; i < n; i += Math.max(1, step)) {
    if (rgba[i * 4 + 3] < 128) continue
    out.push(rgba[i * 4] / 255, rgba[i * 4 + 1] / 255, rgba[i * 4 + 2] / 255)
  }
  return Float32Array.from(out)
}

/** Runs measured pixels through a correction (to measure a clip as it looks after its own correction). */
export function correctPixels(px: Float32Array, g: Pick<ColorGrade, 'balance' | 'levels' | 'match'>): Float32Array {
  const table = correctionTable(g, 1024)
  if (!table) return px
  const out = new Float32Array(px.length)
  for (let i = 0; i < px.length; i++) {
    const c = i % 3
    const x = clamp01(px[i]) * 1023
    const j = Math.floor(x)
    const f = x - j
    const a = table[j * 3 + c]
    const b = table[Math.min(1023, j + 1) * 3 + c]
    out[i] = a + (b - a) * f
  }
  return out
}

/**
 * Automatic white balance: the colour of the light, estimated from the picture
 * and turned into gains. Grey world in linear light — the average of a scene
 * is close to the colour of its light — leaving out what fools it: strongly
 * coloured things (a red car, a lawn), near-black noise and blown-out areas.
 * Pixels are left out by brightness, never by one channel clipping: that
 * would hide the very cast being measured. Held back a little, so a scene
 * that's meant to be warm (a sunset) doesn't come out grey.
 */
export function autoBalance(px: Float32Array): WhiteBalance {
  const e = [0, 0, 0]
  let n = 0
  for (let i = 0; i + 2 < px.length; i += 3) {
    const r = px[i]
    const g = px[i + 1]
    const b = px[i + 2]
    // By the plain average, which favours no channel (luma would favour green).
    const m = (r + g + b) / 3
    if (m < 0.04 || m > 0.92) continue
    const hi = Math.max(r, g, b)
    if ((hi - Math.min(r, g, b)) / hi > 0.6) continue
    e[0] += toLinear(r)
    e[1] += toLinear(g)
    e[2] += toLinear(b)
    n++
  }
  if (n < 16) return { ...NEUTRAL_BALANCE }
  for (let c = 0; c < 3; c++) e[c] /= n
  const y = 0.2126 * e[0] + 0.7152 * e[1] + 0.0722 * e[2]
  // Nearly all the way, at most 2× either way: confident about casts, careful about mood.
  const gain = (c: number) => round(Math.min(2, Math.max(0.5, Math.pow(y / Math.max(1e-6, c), 0.9))))
  return { r: gain(e[0]), g: gain(e[1]), b: gain(e[2]) }
}

/** A quantile (0..1) of one channel of measured pixels (channel 3 = luma). */
export function quantiles(px: Float32Array, channel: 0 | 1 | 2 | 3, qs: number[]): number[] {
  const bins = new Uint32Array(1024)
  let n = 0
  for (let i = 0; i + 2 < px.length; i += 3) {
    const v = channel === 3 ? 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2] : px[i + channel]
    bins[Math.min(1023, Math.max(0, Math.round(v * 1023)))]++
    n++
  }
  if (!n) return qs.map((q) => q)
  return qs.map((q) => {
    const target = q * n
    let acc = 0
    for (let b = 0; b < 1024; b++) {
      acc += bins[b]
      if (acc >= target) return b / 1023
    }
    return 1
  })
}

/**
 * Automatic levels: black and white points from the darkest and brightest
 * fraction of a percent of the picture, and a gentle midtone gamma toward a
 * natural middle grey. Conservative: footage that's meant to be dark or
 * faded is lifted only part of the way.
 */
export function autoLevels(px: Float32Array): Levels {
  const [lo, med, hi] = quantiles(px, 3, [0.002, 0.5, 0.998])
  if (hi - lo < 0.05) return { ...NEUTRAL_LEVELS }
  const black = round(Math.min(0.25, Math.max(0, lo * 0.85)), 3)
  const white = round(Math.max(0.6, Math.min(1, hi + (1 - hi) * 0.15)), 3)
  const mid = clamp01((med - black) / (white - black))
  let gamma = 1
  if (mid > 0.02 && mid < 0.98) {
    const full = Math.log(mid) / Math.log(0.45)
    gamma = 1 + (Math.min(1.6, Math.max(0.65, full)) - 1) * 0.5
  }
  return { black, white, gamma: round(gamma, 3) }
}

/** The quantiles a shot match lines up. */
const MATCH_QS = [0.01, 0.05, 0.15, 0.3, 0.5, 0.7, 0.85, 0.95, 0.99]

/** Steepest a match curve may get: a small or busy sample shouldn't stretch the footage wildly. */
const MAX_SLOPE = 3.5
const MIN_SLOPE = 1 / MAX_SLOPE

/**
 * Curves that bring `src` (the footage to correct, as it came in) in line with
 * `ref` (the reference clip, as it looks after its own correction): each
 * channel's distribution is mapped onto the reference's, quantile by quantile,
 * so shadows, midtones and highlights land where the reference has them —
 * colour casts and contrast included.
 */
export function matchCurves(src: Float32Array, ref: Float32Array): Omit<ShotMatch, 'ref'> {
  const curve = (c: 0 | 1 | 2): CurvePoints => {
    const xs = quantiles(src, c, MATCH_QS)
    const ys = quantiles(ref, c, MATCH_QS)
    const pts: [number, number][] = []
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i]
      if (pts.length && x - pts[pts.length - 1][0] < 0.02) continue
      pts.push([x, ys[i]])
    }
    if (pts.length < 2) return [[0, 0], [1, 1]]
    // Rising, and never steeper or flatter than the limits.
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i][0] - pts[i - 1][0]
      const slope = (pts[i][1] - pts[i - 1][1]) / dx
      pts[i][1] = pts[i - 1][1] + dx * Math.min(MAX_SLOPE, Math.max(MIN_SLOPE, slope))
    }
    // Out to the ends along the outer segments' slopes.
    const s0 = Math.min(MAX_SLOPE, Math.max(MIN_SLOPE, (pts[1][1] - pts[0][1]) / (pts[1][0] - pts[0][0])))
    const n = pts.length
    const s1 = Math.min(MAX_SLOPE, Math.max(MIN_SLOPE, (pts[n - 1][1] - pts[n - 2][1]) / (pts[n - 1][0] - pts[n - 2][0])))
    const start: [number, number] = [0, clamp01(pts[0][1] - pts[0][0] * s0)]
    const end: [number, number] = [1, clamp01(pts[n - 1][1] + (1 - pts[n - 1][0]) * s1)]
    const all = [start, ...pts.filter((p) => p[0] > 0.005 && p[0] < 0.995), end].map(([x, y]) => [round(clamp01(x), 3), round(clamp01(y), 3)] as [number, number])
    // Keep it rising after the clamps.
    for (let i = 1; i < all.length; i++) if (all[i][1] < all[i - 1][1]) all[i][1] = all[i - 1][1]
    return all.slice(0, 16)
  }
  return { red: curve(0), green: curve(1), blue: curve(2) }
}

/** A rough reading of how far two measured pictures are apart in colour and tone (0 = the same), for reports. */
export function colorDistance(a: Float32Array, b: Float32Array) {
  let d = 0
  for (const c of [0, 1, 2] as const) {
    const qa = quantiles(a, c, MATCH_QS)
    const qb = quantiles(b, c, MATCH_QS)
    for (let i = 0; i < qa.length; i++) d += Math.abs(qa[i] - qb[i])
  }
  return round(d / (MATCH_QS.length * 3), 4)
}
