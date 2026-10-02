import { clamp, lerp } from '@/lib/math'
import { easeAt } from './easing'
import type { AnimatableProp, Clip, Keyframe } from './types'

export const ANIMATABLE: AnimatableProp[] = ['x', 'y', 'scale', 'rotation', 'opacity', 'volume', 'rotateX', 'rotateY', 'z', 'speed']

/** The static (un-animated) value of a property. */
export function baseValue(clip: Clip, prop: AnimatableProp): number {
  if (prop === 'volume') return clip.audio.volume
  if (prop === 'speed') return clip.speed
  return clip.transform[prop] ?? 0
}

export function evalKeyframes(kfs: Keyframe[], frame: number): number {
  if (frame <= kfs[0].frame) return kfs[0].value
  const last = kfs[kfs.length - 1]
  if (frame >= last.frame) return last.value
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i]
    const b = kfs[i + 1]
    if (frame >= a.frame && frame < b.frame) {
      const t = clamp((frame - a.frame) / (b.frame - a.frame), 0, 1)
      return lerp(a.value, b.value, easeAt(a.easing, t))
    }
  }
  return last.value
}

/** Value of a property at a frame relative to the clip start. */
export function propAt(clip: Clip, prop: AnimatableProp, localFrame: number): number {
  const kfs = clip.keyframes[prop]
  return kfs && kfs.length ? evalKeyframes(kfs, localFrame) : baseValue(clip, prop)
}

export function isAnimated(clip: Clip, prop: AnimatableProp) {
  return Boolean(clip.keyframes[prop]?.length)
}

export function keyframeAt(clip: Clip, prop: AnimatableProp, localFrame: number) {
  return clip.keyframes[prop]?.find((k) => k.frame === localFrame)
}

/** Sorted, de-duplicated keyframe frames across all properties (for timeline diamonds). */
export function allKeyframeFrames(clip: Clip): number[] {
  const set = new Set<number>()
  for (const prop of ANIMATABLE) clip.keyframes[prop]?.forEach((k) => set.add(k.frame))
  return [...set].sort((a, b) => a - b)
}
