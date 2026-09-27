/**
 * How a clip's timeline frames map onto its source media: constant speed,
 * speed ramps (`speed` keyframes, integrated so the footage never jumps),
 * reverse and freeze frames. Everything that reads or trims source media goes
 * through here, so the picture, the sound and the edits always agree.
 *
 * A clip always uses the source range [inPoint, inPoint + consumed(clip)).
 * Forward clips play it bottom to top, reversed clips top to bottom.
 */
import { clamp } from '@/lib/math'
import { evalKeyframes } from './keyframes'
import type { Clip, Keyframe } from './types'

export const MIN_SPEED = 0.1
export const MAX_SPEED = 16

const clampSpeed = (s: number) => clamp(s, MIN_SPEED, MAX_SPEED)

export type Timed = Pick<Clip, 'speed' | 'duration' | 'inPoint' | 'reverse' | 'freeze' | 'keyframes'>

export const isRamped = (clip: Pick<Clip, 'keyframes'>) => Boolean(clip.keyframes.speed?.length)

/** Speed at a clip-relative frame. */
export function speedAt(clip: Pick<Clip, 'speed' | 'keyframes'>, local: number) {
  const kfs = clip.keyframes.speed
  return clampSpeed(kfs?.length ? evalKeyframes(kfs, local) : clip.speed)
}

// Cumulative source frames per whole local frame, cached per keyframe list (Immer
// gives a new list whenever it changes) and length.
const cumulative = new WeakMap<Keyframe[], { length: number; sums: Float64Array }>()

function sums(kfs: Keyframe[], length: number) {
  const hit = cumulative.get(kfs)
  if (hit && hit.length >= length) return hit.sums
  const n = Math.max(1, Math.ceil(length))
  const out = new Float64Array(n + 1)
  let prev = clampSpeed(evalKeyframes(kfs, 0))
  for (let i = 1; i <= n; i++) {
    const next = clampSpeed(evalKeyframes(kfs, i))
    out[i] = out[i - 1] + (prev + next) / 2
    prev = next
  }
  cumulative.set(kfs, { length: n, sums: out })
  return out
}

/** Source frames used by the first `local` frames of the clip (0 for freeze frames). */
export function consumedAt(clip: Timed, local: number) {
  if (clip.freeze) return 0
  const t = Math.max(0, local)
  const kfs = clip.keyframes.speed
  if (!kfs?.length) return t * clampSpeed(clip.speed)
  const s = sums(kfs, Math.max(t, clip.duration))
  const i = Math.floor(t)
  if (i >= s.length - 1) return s[s.length - 1] + (t - (s.length - 1)) * speedAt(clip, t)
  return s[i] + (s[i + 1] - s[i]) * (t - i)
}

/** Source frames the whole clip uses. */
export const consumed = (clip: Timed) => consumedAt(clip, clip.duration)

/** The source frame (project fps) shown at a clip-relative frame. */
export function sourceFrameAt(clip: Timed, local: number) {
  if (clip.freeze) return clip.inPoint
  const c = consumedAt(clip, local)
  return clip.reverse ? clip.inPoint + consumed(clip) - c : clip.inPoint + c
}

/** Clip-relative frames it takes to use up `frames` of source from the clip's start (inverse of consumedAt). */
export function localForConsumed(clip: Timed, frames: number) {
  if (clip.freeze) return Infinity
  if (!isRamped(clip)) return frames / clampSpeed(clip.speed)
  // Binary search over the monotonic cumulative curve.
  let lo = 0
  let hi = Math.max(1, clip.duration)
  while (consumedAt(clip, hi) < frames && hi < 1e7) hi *= 2
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2
    if (consumedAt(clip, mid) < frames) lo = mid
    else hi = mid
  }
  return hi
}

/** The clip-relative frame where a source frame is shown, or null if the clip doesn't show it. */
export function localForSource(clip: Timed, sourceFrame: number): number | null {
  if (clip.freeze) return null
  const total = consumed(clip)
  const offset = sourceFrame - clip.inPoint
  if (offset < 0 || offset > total) return null
  return localForConsumed(clip, clip.reverse ? total - offset : offset)
}

/** Average speed over the clip (for thumbnails and waveforms, which only need an overview). */
export const averageSpeed = (clip: Timed) => (clip.freeze ? 0 : consumed(clip) / Math.max(1, clip.duration))

/**
 * The source ranges of the two halves when a clip is cut `at` frames in: forward
 * clips keep their bottom for the left half, reversed clips their top.
 */
export function splitInPoints(clip: Timed, at: number): { left: number; right: number } {
  if (clip.freeze) return { left: clip.inPoint, right: clip.inPoint }
  const total = consumed(clip)
  const c = Math.round(consumedAt(clip, at))
  return clip.reverse ? { left: clip.inPoint + (Math.round(total) - c), right: clip.inPoint } : { left: clip.inPoint, right: clip.inPoint + c }
}
