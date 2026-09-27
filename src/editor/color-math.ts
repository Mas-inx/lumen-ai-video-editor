/**
 * Colour-grading maths shared by the GPU grade and the editor UI: tone curves
 * (monotone cubic through their points, so they never overshoot), colour wheels
 * (lift / gamma / gain) and the HSL bands. Pure functions, unit-tested.
 */
import type { ColorGrade, CurvePoints, HslAdjust, HslBand, Wheel, Wheels } from './types'

// ─── Curves ──────────────────────────────────────────────────────────────

export const isIdentityCurve = (pts: CurvePoints) => pts.length === 2 && pts[0][0] === 0 && pts[0][1] === 0 && pts[1][0] === 1 && pts[1][1] === 1

/** Sorted, de-duplicated points, always spanning 0..1. */
export function normalizePoints(pts: CurvePoints): CurvePoints {
  const sorted = [...pts].sort((a, b) => a[0] - b[0]).filter((p, i, all) => i === 0 || p[0] - all[i - 1][0] > 1e-4)
  if (!sorted.length) return [[0, 0], [1, 1]]
  if (sorted[0][0] > 0) sorted.unshift([0, sorted[0][1]])
  if (sorted[sorted.length - 1][0] < 1) sorted.push([1, sorted[sorted.length - 1][1]])
  return sorted
}

/** Evaluates a curve at x with Fritsch–Carlson monotone cubic interpolation. */
export function evalCurve(points: CurvePoints, x: number): number {
  const pts = normalizePoints(points)
  const n = pts.length
  if (n === 1) return pts[0][1]
  if (x <= pts[0][0]) return pts[0][1]
  if (x >= pts[n - 1][0]) return pts[n - 1][1]
  const dx: number[] = []
  const m: number[] = []
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1][0] - pts[i][0])
    m.push((pts[i + 1][1] - pts[i][1]) / dx[i])
  }
  const t: number[] = [m[0]]
  for (let i = 1; i < n - 1; i++) t.push(m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2)
  t.push(m[n - 2])
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) {
      t[i] = 0
      t[i + 1] = 0
      continue
    }
    const a = t[i] / m[i]
    const b = t[i + 1] / m[i]
    const h = a * a + b * b
    if (h > 9) {
      const k = 3 / Math.sqrt(h)
      t[i] = k * a * m[i]
      t[i + 1] = k * b * m[i]
    }
  }
  let i = 0
  while (i < n - 2 && x > pts[i + 1][0]) i++
  const h = dx[i]
  const s = (x - pts[i][0]) / h
  const s2 = s * s
  const s3 = s2 * s
  return (2 * s3 - 3 * s2 + 1) * pts[i][1] + (s3 - 2 * s2 + s) * h * t[i] + (-2 * s3 + 3 * s2) * pts[i + 1][1] + (s3 - s2) * h * t[i + 1]
}

/** A curve sampled at `size` evenly spaced inputs, clamped to 0..1. */
export function curveTable(points: CurvePoints, size = 256): Float32Array {
  const out = new Float32Array(size)
  for (let i = 0; i < size; i++) out[i] = Math.min(1, Math.max(0, evalCurve(points, i / (size - 1))))
  return out
}

// ─── Wheels ──────────────────────────────────────────────────────────────

export const isNeutralWheel = (w?: Wheel) => !w || (!w.x && !w.y && !w.luma)

/** A wheel's colour push as an RGB offset that sums to zero (so it tints without brightening). */
export function wheelColor(w: Wheel): [number, number, number] {
  const mag = Math.min(1, Math.hypot(w.x, w.y))
  if (mag < 1e-6) return [0, 0, 0]
  const hue = Math.atan2(w.y, w.x)
  // Hue 0 = red at the wheel's right, going counter-clockwise like a vectorscope.
  const rgb = [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3].map((o) => Math.cos(hue - o)) as [number, number, number]
  const mean = (rgb[0] + rgb[1] + rgb[2]) / 3
  return rgb.map((v) => (v - mean) * mag) as [number, number, number]
}

/** Lift, gamma and gain as per-channel numbers for c' = (c * gain + lift * (1 - c)) ^ gamma. */
export function wheelParams(w: Wheels): { lift: number[]; gamma: number[]; gain: number[] } {
  const lc = wheelColor(w.lift)
  const gc = wheelColor(w.gamma)
  const hc = wheelColor(w.gain)
  return {
    lift: lc.map((v) => v * 0.25 + w.lift.luma * 0.25),
    gamma: gc.map((v) => Math.pow(2, -(v * 0.6 + w.gamma.luma * 0.6))),
    gain: hc.map((v) => 1 + v * 0.45 + w.gain.luma * 0.6),
  }
}

// ─── HSL ─────────────────────────────────────────────────────────────────

export const HSL_BANDS: { band: HslBand; hue: number; label: string; swatch: string }[] = [
  { band: 'red', hue: 0, label: 'Red', swatch: '#ff4a4a' },
  { band: 'orange', hue: 30, label: 'Orange', swatch: '#ff9a3c' },
  { band: 'yellow', hue: 60, label: 'Yellow', swatch: '#ffe14a' },
  { band: 'green', hue: 120, label: 'Green', swatch: '#4ade6a' },
  { band: 'aqua', hue: 180, label: 'Aqua', swatch: '#3ee6e0' },
  { band: 'blue', hue: 240, label: 'Blue', swatch: '#4a7dff' },
  { band: 'purple', hue: 270, label: 'Purple', swatch: '#9b5cff' },
  { band: 'magenta', hue: 300, label: 'Magenta', swatch: '#ff4ad2' },
]

export const isNeutralHsl = (h?: HslAdjust) => !h || Object.values(h).every((b) => !b || (!b.hue && !b.saturation && !b.luminance))

/** Whether a grade needs the GPU pass (curves, wheels, HSL or a LUT). */
export function hasAdvancedGrade(g: ColorGrade) {
  const c = g.curves
  const curves = c && !(isIdentityCurve(c.master) && isIdentityCurve(c.red) && isIdentityCurve(c.green) && isIdentityCurve(c.blue))
  const wheels = g.wheels && !(isNeutralWheel(g.wheels.lift) && isNeutralWheel(g.wheels.gamma) && isNeutralWheel(g.wheels.gain))
  return Boolean(curves || wheels || !isNeutralHsl(g.hsl) || (g.lut && g.lut.amount > 0))
}
