/**
 * Motion data read at render time: how far a tracked point has moved (what a
 * clip or mask following it adds to its position), and the correction a
 * stabilized clip applies to its footage.
 */
import type { Stabilization, TrackPath } from './types'

const lerp = (a: number, b: number, t: number) => a + (b - a) * t

/** The point on a path at a clip frame (fractional frames interpolate); held at the ends. */
export function pathPoint(path: TrackPath, local: number): [number, number] | null {
  const n = Math.floor(path.points.length / 2)
  if (!n) return null
  const f = Math.min(n - 1, Math.max(0, local - path.start))
  const i = Math.floor(f)
  const j = Math.min(n - 1, i + 1)
  const k = f - i
  return [lerp(path.points[2 * i], path.points[2 * j], k), lerp(path.points[2 * i + 1], path.points[2 * j + 1], k)]
}

/** How far the tracked point has moved from where tracking began, at a clip frame. */
export function followOffset(path: TrackPath, local: number): [number, number] {
  const p = pathPoint(path, local)
  if (!p) return [0, 0]
  const r = Math.min(Math.floor(path.points.length / 2) - 1, Math.max(0, path.ref))
  return [p[0] - path.points[2 * r], p[1] - path.points[2 * r + 1]]
}

// ─── Stabilization ───────────────────────────────────────────────────────

export interface Correction {
  /** Shift of the picture, as fractions of its width and height. */
  dx: number
  dy: number
  /** Radians */
  angle: number
  zoom: number
}

/** Gaussian smoothing of one channel of an interleaved path (edges held). */
export function smoothChannel(path: number[], stride: number, channel: number, radius: number): Float64Array {
  const n = Math.floor(path.length / stride)
  const out = new Float64Array(n)
  const r = Math.max(0, Math.round(radius))
  if (!r) {
    for (let i = 0; i < n; i++) out[i] = path[i * stride + channel]
    return out
  }
  const sigma = r / 2.5
  const weights = Array.from({ length: 2 * r + 1 }, (_, k) => Math.exp(-((k - r) ** 2) / (2 * sigma * sigma)))
  for (let i = 0; i < n; i++) {
    let sum = 0
    let wsum = 0
    for (let k = -r; k <= r; k++) {
      const j = Math.min(n - 1, Math.max(0, i + k))
      const w = weights[k + r]
      sum += path[j * stride + channel] * w
      wsum += w
    }
    out[i] = sum / wsum
  }
  return out
}

const corrections = new WeakMap<Stabilization, { smooth: number; rotation: boolean; dx: Float64Array; dy: Float64Array; da: Float64Array }>()

/** Per measured frame: smoothed path minus the real one — what brings each frame back onto the smooth path. */
export function correctionTable(s: Stabilization) {
  const hit = corrections.get(s)
  if (hit && hit.smooth === s.smooth && hit.rotation === s.rotation) return hit
  const radius = s.smooth * s.rate
  const n = Math.floor(s.path.length / 3)
  const sx = smoothChannel(s.path, 3, 0, radius)
  const sy = smoothChannel(s.path, 3, 1, radius)
  const sa = smoothChannel(s.path, 3, 2, radius)
  const dx = new Float64Array(n)
  const dy = new Float64Array(n)
  const da = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    dx[i] = sx[i] - s.path[i * 3]
    dy[i] = sy[i] - s.path[i * 3 + 1]
    da[i] = s.rotation ? sa[i] - s.path[i * 3 + 2] : 0
  }
  const table = { smooth: s.smooth, rotation: s.rotation, dx, dy, da }
  corrections.set(s, table)
  return table
}

/** The correction for the footage at source second `t`. */
export function stabilizeAt(s: Stabilization, t: number): Correction {
  const table = correctionTable(s)
  const n = table.dx.length
  if (!n) return { dx: 0, dy: 0, angle: 0, zoom: s.zoom }
  const f = Math.min(n - 1, Math.max(0, (t - s.start) * s.rate))
  const i = Math.floor(f)
  const j = Math.min(n - 1, i + 1)
  const k = f - i
  return { dx: lerp(table.dx[i], table.dx[j], k), dy: lerp(table.dy[i], table.dy[j], k), angle: lerp(table.da[i], table.da[j], k), zoom: s.zoom }
}

/**
 * The zoom that keeps the corrected picture covering the frame: enough for the
 * largest shift and turn (ignoring the rare worst 2% of frames), at most 1.6×.
 */
export function autoZoom(s: Pick<Stabilization, 'path' | 'rate' | 'smooth' | 'rotation'> & { start?: number }, aspect = 16 / 9) {
  const table = correctionTable({ start: 0, zoom: 1, ...s } as Stabilization)
  const need: number[] = []
  for (let i = 0; i < table.dx.length; i++) {
    const a = Math.abs(table.da[i])
    // A turned frame needs cos + sin·(long/short) to cover the frame; shifts need 1 + 2·shift.
    const turn = Math.cos(a) + Math.sin(a) * Math.max(aspect, 1 / aspect)
    need.push(turn * (1 + 2 * Math.max(Math.abs(table.dx[i]), Math.abs(table.dy[i]))))
  }
  if (!need.length) return 1
  need.sort((x, y) => x - y)
  const z = need[Math.min(need.length - 1, Math.floor(need.length * 0.98))]
  return Math.round(Math.min(1.6, Math.max(1, z)) * 1000) / 1000
}
