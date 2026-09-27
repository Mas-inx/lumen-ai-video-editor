/**
 * Motion tracking and stabilization, both from template matching on small
 * grayscale frames (normalized cross-correlation, searched coarse-to-fine on a
 * two-level pyramid, refined to a fraction of a pixel).
 *
 * Tracking follows one patch from frame to frame. Stabilization matches a grid
 * of patches between consecutive frames and fits the camera's shift and turn,
 * rejecting patches that move on their own (people, cars).
 */
import type { Asset } from '@/editor/types'
import { AnalysisCancelled, scanFrames, toGray } from './analysis'

// ─── Images ──────────────────────────────────────────────────────────────

export interface Gray {
  data: Float32Array
  width: number
  height: number
}

/** A half-size copy (2×2 averages). */
export function halve(g: Gray): Gray {
  const width = Math.max(1, g.width >> 1)
  const height = Math.max(1, g.height >> 1)
  const data = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    const r0 = 2 * y * g.width
    const r1 = Math.min(g.height - 1, 2 * y + 1) * g.width
    for (let x = 0; x < width; x++) {
      const x0 = 2 * x
      const x1 = Math.min(g.width - 1, x0 + 1)
      data[y * width + x] = (g.data[r0 + x0] + g.data[r0 + x1] + g.data[r1 + x0] + g.data[r1 + x1]) * 0.25
    }
  }
  return { data, width, height }
}

/** Sums of values and squares over any rectangle in constant time. */
export class Integral {
  readonly sum: Float64Array
  readonly sq: Float64Array
  private readonly w: number
  constructor(g: Gray) {
    this.w = g.width + 1
    this.sum = new Float64Array(this.w * (g.height + 1))
    this.sq = new Float64Array(this.w * (g.height + 1))
    for (let y = 0; y < g.height; y++) {
      let rs = 0
      let rq = 0
      for (let x = 0; x < g.width; x++) {
        const v = g.data[y * g.width + x]
        rs += v
        rq += v * v
        const i = (y + 1) * this.w + x + 1
        this.sum[i] = this.sum[i - this.w] + rs
        this.sq[i] = this.sq[i - this.w] + rq
      }
    }
  }
  rect(x: number, y: number, w: number, h: number): [number, number] {
    const a = y * this.w + x
    const b = a + w
    const c = (y + h) * this.w + x
    const d = c + w
    return [this.sum[d] - this.sum[b] - this.sum[c] + this.sum[a], this.sq[d] - this.sq[b] - this.sq[c] + this.sq[a]]
  }
}

/** A patch ready for matching: zero-mean values and their norm. */
export interface Template {
  data: Float32Array
  width: number
  height: number
  norm: number
}

/** The patch of `g` with top-left (x, y); null where it's flat (nothing to match). */
export function makeTemplate(g: Gray, x: number, y: number, w: number, h: number): Template | null {
  x = Math.round(x)
  y = Math.round(y)
  if (x < 0 || y < 0 || x + w > g.width || y + h > g.height || w < 3 || h < 3) return null
  const data = new Float32Array(w * h)
  let mean = 0
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) mean += data[r * w + c] = g.data[(y + r) * g.width + x + c]
  mean /= w * h
  let norm = 0
  for (let i = 0; i < data.length; i++) {
    data[i] -= mean
    norm += data[i] * data[i]
  }
  norm = Math.sqrt(norm)
  // Too little texture to follow reliably.
  if (norm / Math.sqrt(w * h) < 2) return null
  return { data, width: w, height: h, norm }
}

/** Normalized cross-correlation (−1..1) of a template with `g` at top-left (x, y). */
export function ncc(g: Gray, integral: Integral, t: Template, x: number, y: number): number {
  const { width: tw, height: th } = t
  let dot = 0
  for (let r = 0; r < th; r++) {
    const gi = (y + r) * g.width + x
    const ti = r * tw
    for (let c = 0; c < tw; c++) dot += g.data[gi + c] * t.data[ti + c]
  }
  const n = tw * th
  const [s, sq] = integral.rect(x, y, tw, th)
  const variance = sq - (s * s) / n
  if (variance <= 1e-6) return 0
  return dot / (Math.sqrt(variance) * t.norm)
}

/** Parabola through three scores: the offset (−0.5..0.5) of the true peak from the middle one. */
const subPixel = (a: number, b: number, c: number) => {
  const d = a - 2 * b + c
  return d < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / d)) : 0
}

/** The best match of `t` within ±r of top-left (x0, y0), to a fraction of a pixel. */
export function search(g: Gray, integral: Integral, t: Template, x0: number, y0: number, r: number): { x: number; y: number; score: number } {
  const cx = Math.round(x0)
  const cy = Math.round(y0)
  const size = 2 * r + 1
  const grid = new Float32Array(size * size).fill(-2)
  let best = -2
  let bx = cx
  let by = cy
  for (let dy = -r; dy <= r; dy++) {
    const y = cy + dy
    if (y < 0 || y + t.height > g.height) continue
    for (let dx = -r; dx <= r; dx++) {
      const x = cx + dx
      if (x < 0 || x + t.width > g.width) continue
      const s = ncc(g, integral, t, x, y)
      grid[(dy + r) * size + dx + r] = s
      if (s > best) {
        best = s
        bx = x
        by = y
      }
    }
  }
  const gx = bx - cx + r
  const gy = by - cy + r
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < size && y < size ? grid[y * size + x] : -2)
  const sx = at(gx - 1, gy) > -2 && at(gx + 1, gy) > -2 ? subPixel(at(gx - 1, gy), best, at(gx + 1, gy)) : 0
  const sy = at(gx, gy - 1) > -2 && at(gx, gy + 1) > -2 ? subPixel(at(gx, gy - 1), best, at(gx, gy + 1)) : 0
  return { x: bx + sx, y: by + sy, score: best }
}

/**
 * Coarse-to-fine match: the half-size images find it within ±r, the full-size
 * ones refine it within ±2 pixels. Positions are top-left, full-size pixels.
 */
function pyramidSearch(full: Gray, fullI: Integral, half: Gray, halfI: Integral, t: Template, th: Template | null, x0: number, y0: number, r: number) {
  let x = x0
  let y = y0
  if (th) {
    const coarse = search(half, halfI, th, x0 / 2, y0 / 2, Math.max(2, Math.ceil(r / 2)))
    x = coarse.x * 2
    y = coarse.y * 2
  }
  return search(full, fullI, t, x, y, th ? 2 : r)
}

const blend = (a: Template, b: Template, k: number): Template => {
  const data = new Float32Array(a.data.length)
  let norm = 0
  for (let i = 0; i < data.length; i++) {
    data[i] = a.data[i] * (1 - k) + b.data[i] * k
    norm += data[i] * data[i]
  }
  return { ...a, data, norm: Math.sqrt(norm) || a.norm }
}

// ─── Tracking ────────────────────────────────────────────────────────────

/** A patch's centre in one frame, as fractions of the picture, and how well it matched (−1..1). */
export interface TrackSample {
  t: number
  x: number
  y: number
  score: number
}

/** A box to follow: centre and size as fractions of the picture. */
export interface TrackBox {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Follows one patch from frame to frame (fed in playing order). The template
 * slowly takes on the patch's current look while matches are good; the
 * follower gives up once the patch has been lost for a few frames.
 */
export class PatchFollower {
  readonly samples: TrackSample[] = []
  private tpl: Template | null = null
  private tplHalf: Template | null = null
  private x = 0
  private y = 0
  private vx = 0
  private vy = 0
  private tw = 0
  private th = 0
  private lost = 0
  /** Source second of the last frame fed. */
  lastT = NaN

  constructor(private readonly box: TrackBox) {}

  /** Feeds the next frame; false once the patch is lost for good. */
  push(t: number, gray: Gray): boolean {
    this.lastT = t
    const half = halve(gray)
    const sample = (score: number) => this.samples.push({ t, x: (this.x + this.tw / 2) / gray.width, y: (this.y + this.th / 2) / gray.height, score })
    if (!this.tpl) {
      this.tw = Math.max(8, Math.round(this.box.w * gray.width))
      this.th = Math.max(8, Math.round(this.box.h * gray.height))
      this.x = this.box.x * gray.width - this.tw / 2
      this.y = this.box.y * gray.height - this.th / 2
      this.tpl = makeTemplate(gray, this.x, this.y, this.tw, this.th)
      if (!this.tpl) throw new Error('There isn’t enough detail in that box to follow — put it over something with texture or edges.')
      this.tplHalf = makeTemplate(half, this.x / 2, this.y / 2, Math.floor(this.tw / 2), Math.floor(this.th / 2))
      sample(1)
      return true
    }
    const r = Math.max(10, Math.round(Math.max(this.tw, this.th)))
    // Look where it's heading.
    const m = pyramidSearch(gray, new Integral(gray), half, new Integral(half), this.tpl, this.tplHalf, this.x + this.vx, this.y + this.vy, r)
    if (m.score < 0.45) {
      // Coast on its speed while it's hidden or blurred.
      this.x += this.vx
      this.y += this.vy
      sample(m.score)
      return ++this.lost < 6
    }
    this.lost = 0
    this.vx = 0.6 * (m.x - this.x) + 0.4 * this.vx
    this.vy = 0.6 * (m.y - this.y) + 0.4 * this.vy
    this.x = m.x
    this.y = m.y
    sample(m.score)
    if (m.score > 0.8) {
      const fresh = makeTemplate(gray, this.x, this.y, this.tw, this.th)
      if (fresh) this.tpl = blend(this.tpl, fresh, 0.15)
      if (this.tplHalf) {
        const freshHalf = makeTemplate(half, this.x / 2, this.y / 2, this.tplHalf.width, this.tplHalf.height)
        if (freshHalf) this.tplHalf = blend(this.tplHalf, freshHalf, 0.15)
      }
    }
    return true
  }

  /** The path, without the coasting tail after the patch was lost for good. */
  result(): TrackSample[] {
    const out = [...this.samples]
    while (out.length > 1 && out[out.length - 1].score < 0.45) out.pop()
    return out
  }
}

/** Follows a patch through frames given in playing order. */
export function followPatch(frames: Iterable<{ t: number; gray: Gray }>, box: TrackBox): TrackSample[] {
  const f = new PatchFollower(box)
  for (const frame of frames) if (!f.push(frame.t, frame.gray)) break
  return f.result()
}

/** How wide to analyse so the box is a comfortable ~44 pixels across (enough detail for sub-pixel matches, still quick). */
const trackingWidth = (box: TrackBox) => Math.round(Math.min(1280, Math.max(240, 44 / Math.max(0.01, box.w))))

/**
 * Tracks a box through source seconds of a video, forwards from `from` to `to`
 * (or backwards when `to` < `from`). Positions are fractions of the picture.
 */
export async function trackBox(asset: Asset, box: TrackBox, from: number, to: number, onProgress?: (p: number) => void, signal?: AbortSignal): Promise<TrackSample[]> {
  if (asset.kind !== 'video' || asset.source.type !== 'file') throw new Error(`“${asset.name}” isn’t a video file.`)
  if (asset.source.missing) throw new Error(`“${asset.name}” is offline — its file can’t be found.`)
  const url = asset.source.url
  const width = trackingWidth(box)
  const span = Math.abs(to - from) || 1e-3
  const follower = new PatchFollower(box)
  const gray = (rgba: Uint8ClampedArray, w: number, h: number): Gray => ({ data: toGray(rgba), width: w, height: h })
  if (to >= from) {
    // Forwards, streaming: stop decoding as soon as the patch is lost.
    const stop = new AbortController()
    const cancel = () => stop.abort()
    signal?.addEventListener('abort', cancel)
    try {
      await scanFrames(
        url,
        from,
        to,
        width,
        ({ t, rgba, width: w, height: h }) => {
          if (!follower.push(t, gray(rgba, w, h))) stop.abort()
          onProgress?.(Math.min(1, (t - from) / span))
        },
        stop.signal,
      )
    } catch (err) {
      if (!(err instanceof AnalysisCancelled) || signal?.aborted) throw err
    } finally {
      signal?.removeEventListener('abort', cancel)
    }
    return follower.result()
  }
  // Backwards: decode a couple of seconds at a time and walk them in reverse.
  let end = from
  while (end > to + 1e-3) {
    const start = Math.max(to, end - 2)
    const chunk: { t: number; g: Gray }[] = []
    await scanFrames(url, start, end + 1e-3, width, ({ t, rgba, width: w, height: h }) => void chunk.push({ t, g: gray(rgba, w, h) }), signal)
    for (const f of chunk.reverse()) {
      if (!Number.isNaN(follower.lastT) && f.t >= follower.lastT - 1e-6) continue
      if (!follower.push(f.t, f.g)) return follower.result()
    }
    onProgress?.(Math.min(1, (from - start) / span))
    end = start
  }
  return follower.result()
}

// ─── Stabilization ───────────────────────────────────────────────────────

/** The camera's move between two frames: shift in pixels, turn in radians, from matched blocks. */
export function frameMotion(prev: Gray, cur: Gray): { dx: number; dy: number; angle: number; used: number } {
  const prevHalf = halve(prev)
  const curHalf = halve(cur)
  const curI = new Integral(cur)
  const curHalfI = new Integral(curHalf)
  const cols = 8
  const rows = 5
  const size = Math.max(12, Math.round(prev.width / 20))
  const r = Math.max(8, Math.round(prev.width / 20))
  const cx = prev.width / 2
  const cy = prev.height / 2
  const pts: { x: number; y: number; dx: number; dy: number }[] = []
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const bx = Math.round(prev.width * (0.08 + (0.84 * (i + 0.5)) / cols) - size / 2)
      const by = Math.round(prev.height * (0.08 + (0.84 * (j + 0.5)) / rows) - size / 2)
      const t = makeTemplate(prev, bx, by, size, size)
      if (!t) continue
      const th = makeTemplate(prevHalf, bx / 2, by / 2, size >> 1, size >> 1)
      const m = pyramidSearch(cur, curI, curHalf, curHalfI, t, th, bx, by, r)
      if (m.score < 0.6) continue
      pts.push({ x: bx + size / 2 - cx, y: by + size / 2 - cy, dx: m.x - bx, dy: m.y - by })
    }
  }
  if (pts.length < 5) return { dx: 0, dy: 0, angle: 0, used: pts.length }
  const median = (v: number[]) => {
    const s = [...v].sort((a, b) => a - b)
    return s[s.length >> 1]
  }
  const fit = (set: typeof pts, tx: number, ty: number) => {
    // Small-angle rotation about the centre: d ≈ t + θ·(−y, x).
    let num = 0
    let den = 0
    for (const p of set) {
      num += p.x * (p.dy - ty) - p.y * (p.dx - tx)
      den += p.x * p.x + p.y * p.y
    }
    return den > 0 ? num / den : 0
  }
  let tx = median(pts.map((p) => p.dx))
  let ty = median(pts.map((p) => p.dy))
  let angle = fit(pts, tx, ty)
  // Keep the blocks that agree with the camera (not things moving on their own), then refit.
  const tol = Math.max(1, prev.width / 250)
  let inliers = pts.filter((p) => Math.hypot(p.dx - (tx - angle * p.y), p.dy - (ty + angle * p.x)) < tol * 1.5)
  if (inliers.length < 4) inliers = pts
  tx = inliers.reduce((s, p) => s + p.dx + angle * p.y, 0) / inliers.length
  ty = inliers.reduce((s, p) => s + p.dy - angle * p.x, 0) / inliers.length
  angle = fit(inliers, tx, ty)
  return { dx: tx, dy: ty, angle, used: inliers.length }
}

/**
 * Measures the camera's path through source seconds [from, to): x, y (fractions
 * of the picture) and angle (radians) per frame, starting at zero.
 */
export async function measureShake(asset: Asset, from: number, to: number, onProgress?: (p: number) => void, signal?: AbortSignal): Promise<{ start: number; rate: number; path: number[] }> {
  if (asset.kind !== 'video' || asset.source.type !== 'file') throw new Error(`“${asset.name}” isn’t a video file.`)
  if (asset.source.missing) throw new Error(`“${asset.name}” is offline — its file can’t be found.`)
  const path: number[] = []
  const times: number[] = []
  let prev: Gray | null = null
  let x = 0
  let y = 0
  let a = 0
  const round = (v: number) => Math.round(v * 1e5) / 1e5
  await scanFrames(
    asset.source.url,
    from,
    to,
    320,
    ({ t, rgba, width, height }) => {
      const gray = { data: toGray(rgba), width, height }
      if (prev) {
        const m = frameMotion(prev, gray)
        x += m.dx / width
        y += m.dy / height
        a += m.angle
      }
      path.push(round(x), round(y), round(a))
      times.push(t)
      prev = gray
      onProgress?.(Math.min(1, (t - from) / Math.max(1e-3, to - from)))
    },
    signal,
  )
  if (times.length < 2) throw new Error('Too little footage to stabilize.')
  const rate = (times.length - 1) / Math.max(1e-3, times[times.length - 1] - times[0])
  return { start: times[0], rate: Math.round(rate * 1000) / 1000, path }
}
