/**
 * Scene detection: where the shot changes in a piece of footage. Each frame is
 * compared with the one before in hue, saturation and brightness; a cut is a
 * jump well above what the neighbouring frames do (so fast motion isn't
 * mistaken for a cut), and cuts are kept a minimum distance apart.
 */
import type { Asset } from '@/editor/types'
import { scanFrames } from './analysis'

/** HSV per pixel (hue 0..180, saturation and value 0..255), like OpenCV's. */
export function toHsv(rgba: Uint8ClampedArray, out: Float32Array = new Float32Array((rgba.length / 4) * 3)): Float32Array {
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    const r = rgba[i]
    const g = rgba[i + 1]
    const b = rgba[i + 2]
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const d = max - min
    let h = 0
    if (d > 0) {
      if (max === r) h = ((g - b) / d) % 6
      else if (max === g) h = (b - r) / d + 2
      else h = (r - g) / d + 4
      h *= 30
      if (h < 0) h += 180
    }
    out[j] = h
    out[j + 1] = max ? (d / max) * 255 : 0
    out[j + 2] = max
  }
  return out
}

/** How different two frames look: the mean change in hue (around the wheel), saturation and brightness. */
export function contentDelta(a: ArrayLike<number>, b: ArrayLike<number>) {
  let dh = 0
  let ds = 0
  let dv = 0
  for (let i = 0; i < a.length; i += 3) {
    let h = Math.abs(a[i] - b[i])
    if (h > 90) h = 180 - h
    dh += h
    ds += Math.abs(a[i + 1] - b[i + 1])
    dv += Math.abs(a[i + 2] - b[i + 2])
  }
  const n = a.length / 3
  return (dh + ds + dv) / (3 * n)
}

export interface SceneOptions {
  /** 0..100: higher finds subtler cuts (default 50). */
  sensitivity?: number
  /** Shortest shot, in seconds (default 0.6). */
  minShot?: number
}

/** Thresholds for a sensitivity: how far above its neighbours a frame must jump, and by how much at least. */
export function sceneThresholds(sensitivity = 50) {
  const s = Math.min(100, Math.max(0, sensitivity)) / 100
  return { ratio: 5 - 3.2 * s, minContent: 26 - 18 * s }
}

/**
 * Cut indices from per-frame scores (score[i] compares frame i with frame i-1):
 * frame i starts a new shot when its score is `ratio` times its neighbours'
 * average and at least `minContent`, and the last cut is `minGap` frames back.
 */
export function cutsFromScores(scores: ArrayLike<number>, opts: { ratio: number; minContent: number; minGap: number; window?: number }): number[] {
  const w = opts.window ?? 2
  const cuts: number[] = []
  let last = 0
  for (let i = 1; i < scores.length; i++) {
    const s = scores[i]
    if (s < opts.minContent || i - last < opts.minGap) continue
    let sum = 0
    let n = 0
    for (let k = i - w; k <= i + w; k++) {
      if (k === i || k < 1 || k >= scores.length) continue
      sum += scores[k]
      n++
    }
    const avg = n ? sum / n : 0
    if (s / Math.max(avg, 1) >= opts.ratio) {
      cuts.push(i)
      last = i
    }
  }
  return cuts
}

export interface SceneReport {
  /** Source seconds where new shots begin. */
  cuts: number[]
  frames: number
}

/**
 * Shot changes in source seconds [from, to) of a video. `onProgress` gets 0..1.
 */
export async function detectScenes(asset: Asset, from: number, to: number, opts: SceneOptions = {}, onProgress?: (p: number) => void, signal?: AbortSignal): Promise<SceneReport> {
  if (asset.kind !== 'video' || asset.source.type !== 'file') throw new Error(`“${asset.name}” isn’t a video file.`)
  if (asset.source.missing) throw new Error(`“${asset.name}” is offline — its file can’t be found.`)
  const fps = asset.fps ?? 30
  const times: number[] = []
  const scores: number[] = []
  let prev: Float32Array | null = null
  let spare: Float32Array | undefined
  await scanFrames(
    asset.source.url,
    from,
    to,
    96,
    ({ t, rgba }) => {
      const hsv = toHsv(rgba, spare)
      scores.push(prev ? contentDelta(prev, hsv) : 0)
      times.push(t)
      spare = prev ?? undefined
      prev = hsv
      onProgress?.(Math.min(1, (t - from) / Math.max(1e-3, to - from)))
    },
    signal,
  )
  const { ratio, minContent } = sceneThresholds(opts.sensitivity)
  const minGap = Math.max(2, Math.round((opts.minShot ?? 0.6) * fps))
  return { cuts: cutsFromScores(scores, { ratio, minContent, minGap }).map((i) => times[i]), frames: times.length }
}
