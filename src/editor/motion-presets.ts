/**
 * One-click motion, baked into ordinary keyframes you can then edit: camera
 * moves over a whole clip (Ken Burns, push-in, pans), entrances and exits, and
 * emphasis hits at a moment (a punch-in on the beat, a shake). Moves are
 * relative to what the clip already does there, so a punch on top of a Ken
 * Burns keeps the Ken Burns going. Each preset uses curves that suit its role:
 * camera moves glide (sine), entrances decelerate, exits accelerate.
 */
import type { Easing } from './easing'
import { propAt } from './keyframes'
import type { AnimatableProp, Clip, Keyframe } from './types'

export type PresetGroup = 'camera' | 'in' | 'out' | 'emphasis'

export interface MotionPreset {
  id: string
  name: string
  group: PresetGroup
  description: string
  /** Default length in seconds (camera moves span the clip). */
  seconds?: number
}

export const MOTION_PRESETS: MotionPreset[] = [
  { id: 'ken-burns', name: 'Ken Burns', group: 'camera', description: 'Slow push in with a gentle drift' },
  { id: 'ken-burns-out', name: 'Ken Burns out', group: 'camera', description: 'Slow pull back with a gentle drift' },
  { id: 'push-in', name: 'Push in', group: 'camera', description: 'Move in to focus — builds tension' },
  { id: 'pull-out', name: 'Pull out', group: 'camera', description: 'Move back to reveal the scene' },
  { id: 'pan-left', name: 'Pan left', group: 'camera', description: 'Glide across to the left' },
  { id: 'pan-right', name: 'Pan right', group: 'camera', description: 'Glide across to the right' },
  { id: 'tilt-up', name: 'Tilt up', group: 'camera', description: 'Glide upward' },
  { id: 'tilt-down', name: 'Tilt down', group: 'camera', description: 'Glide downward' },
  { id: 'drift', name: 'Drift', group: 'camera', description: 'Barely-there movement that keeps a still alive' },
  { id: 'slide-in-left', name: 'Slide in ←', group: 'in', description: 'Arrives from the left', seconds: 0.6 },
  { id: 'slide-in-right', name: 'Slide in →', group: 'in', description: 'Arrives from the right', seconds: 0.6 },
  { id: 'slide-in-up', name: 'Slide in ↑', group: 'in', description: 'Rises into place', seconds: 0.6 },
  { id: 'slide-in-down', name: 'Slide in ↓', group: 'in', description: 'Drops into place', seconds: 0.6 },
  { id: 'pop-in', name: 'Pop in', group: 'in', description: 'Scales up with a little overshoot', seconds: 0.5 },
  { id: 'fade-in', name: 'Fade in', group: 'in', description: 'Fades up', seconds: 0.5 },
  { id: 'zoom-in', name: 'Zoom in', group: 'in', description: 'Settles in from slightly larger', seconds: 0.7 },
  { id: 'drop-in', name: 'Drop in', group: 'in', description: 'Falls in and bounces', seconds: 0.8 },
  { id: 'spin-in', name: 'Spin in', group: 'in', description: 'Turns into place', seconds: 0.7 },
  { id: 'slide-out-left', name: 'Slide out ←', group: 'out', description: 'Leaves to the left', seconds: 0.45 },
  { id: 'slide-out-right', name: 'Slide out →', group: 'out', description: 'Leaves to the right', seconds: 0.45 },
  { id: 'slide-out-up', name: 'Slide out ↑', group: 'out', description: 'Leaves upward', seconds: 0.45 },
  { id: 'slide-out-down', name: 'Slide out ↓', group: 'out', description: 'Leaves downward', seconds: 0.45 },
  { id: 'pop-out', name: 'Pop out', group: 'out', description: 'Shrinks away', seconds: 0.4 },
  { id: 'fade-out', name: 'Fade out', group: 'out', description: 'Fades away', seconds: 0.5 },
  { id: 'zoom-out', name: 'Zoom out', group: 'out', description: 'Grows and fades away', seconds: 0.5 },
  { id: 'punch', name: 'Punch', group: 'emphasis', description: 'A quick punch-in — land it on a beat', seconds: 0.35 },
  { id: 'pulse', name: 'Pulse', group: 'emphasis', description: 'Two soft beats in scale', seconds: 0.6 },
  { id: 'shake', name: 'Shake', group: 'emphasis', description: 'A short camera shake that settles', seconds: 0.45 },
  { id: 'wobble', name: 'Wobble', group: 'emphasis', description: 'A playful rock side to side', seconds: 0.6 },
]

export const PRESET_IDS = MOTION_PRESETS.map((p) => p.id) as [string, ...string[]]

export interface AnimateOptions {
  /** Clip-relative frame where the move starts (emphasis: where it hits). Defaults: camera and entrances 0, exits the end, emphasis 0. */
  at?: number
  /** Length in frames (camera: the whole clip from `at`). */
  duration?: number
  /** 0.1–3: how far it moves (default 1). */
  intensity?: number
  /** Overrides the preset's main curve. */
  easing?: Easing
}

interface Frame {
  width: number
  height: number
  fps: number
}

type Keys = Partial<Record<AnimatableProp, Keyframe[]>>

/** The frames a preset covers on a clip: [from, to]. */
export function presetRange(clip: Clip, preset: MotionPreset, fps: number, opts: AnimateOptions = {}): [number, number] {
  const len = Math.max(1, Math.round(opts.duration ?? (preset.seconds ? preset.seconds * fps : clip.duration)))
  const end = clip.duration - 1
  if (preset.group === 'camera') {
    const from = Math.min(end, Math.max(0, opts.at ?? 0))
    return [from, Math.min(end, from + (opts.duration ?? clip.duration))]
  }
  if (preset.group === 'out') {
    const to = Math.min(end, Math.max(0, opts.at !== undefined ? opts.at + len : end))
    return [Math.max(0, to - len), to]
  }
  const from = Math.min(end, Math.max(0, opts.at ?? 0))
  return [from, Math.min(end, from + len)]
}

/**
 * The keyframes a preset adds to a clip (per property), and the range they
 * replace. Values are relative to what the clip shows at each frame now.
 */
export function presetKeyframes(clip: Clip, presetId: string, frame: Frame, opts: AnimateOptions = {}): { keys: Keys; range: [number, number] } {
  const preset = MOTION_PRESETS.find((p) => p.id === presetId)
  if (!preset) throw new Error(`Unknown motion preset “${presetId}”`)
  const [a, b] = presetRange(clip, preset, frame.fps, opts)
  const k = Math.max(0.1, Math.min(3, opts.intensity ?? 1))
  const ez = (fallback: Easing) => opts.easing ?? fallback
  const W = frame.width
  const H = frame.height
  const v = (prop: AnimatableProp, at: number) => propAt(clip, prop, at)
  const at = (t: number) => Math.round(a + (b - a) * t)
  const keys: Keys = {}
  const add = (prop: AnimatableProp, ...list: [number, number, Easing][]) => {
    keys[prop] = list.map(([f, value, easing]) => ({ frame: f, value: Math.round(value * 1000) / 1000, easing }))
  }

  switch (preset.id) {
    // ── Camera: over the whole stretch, gliding ─────────────────────────
    case 'ken-burns':
    case 'ken-burns-out': {
      const s0 = v('scale', a)
      const big = s0 * (1 + 0.12 * k)
      const dx = W * 0.015 * k
      const [from, to] = preset.id === 'ken-burns' ? [s0, big] : [big, s0]
      add('scale', [a, from, ez('sine-in-out')], [b, to, 'sine-in-out'])
      add('x', [a, v('x', a) - dx / 2, ez('sine-in-out')], [b, v('x', a) + dx / 2, 'sine-in-out'])
      break
    }
    case 'push-in':
    case 'pull-out': {
      const s0 = v('scale', a)
      const big = s0 * (1 + 0.25 * k)
      const [from, to] = preset.id === 'push-in' ? [s0, big] : [big, s0]
      add('scale', [a, from, ez('cubic-in-out')], [b, to, 'cubic-in-out'])
      break
    }
    case 'pan-left':
    case 'pan-right':
    case 'tilt-up':
    case 'tilt-down': {
      // Zoomed in just enough that the frame edge never shows.
      const travel = (preset.id.startsWith('pan') ? W : H) * 0.05 * k
      const s0 = v('scale', a)
      const s = Math.max(s0, 1 + 0.12 * k)
      const sign = preset.id === 'pan-left' || preset.id === 'tilt-up' ? 1 : -1
      const prop: AnimatableProp = preset.id.startsWith('pan') ? 'x' : 'y'
      const base = v(prop, a)
      add('scale', [a, s, 'linear'], [b, s, 'linear'])
      add(prop, [a, base + sign * travel, ez('sine-in-out')], [b, base - sign * travel, 'sine-in-out'])
      break
    }
    case 'drift': {
      const s0 = v('scale', a)
      add('scale', [a, s0 * (1 + 0.02 * k), ez('linear')], [b, s0 * (1 + 0.05 * k), 'linear'])
      add('x', [a, v('x', a) + W * 0.004 * k, ez('linear')], [b, v('x', a) - W * 0.004 * k, 'linear'])
      break
    }

    // ── Entrances: decelerate into place ─────────────────────────────────
    case 'slide-in-left':
    case 'slide-in-right':
    case 'slide-in-up':
    case 'slide-in-down': {
      const horizontal = preset.id.endsWith('left') || preset.id.endsWith('right')
      const prop: AnimatableProp = horizontal ? 'x' : 'y'
      // Where it starts: left of its place, right of it, below it (rising up) or above it (dropping down).
      const side = preset.id.endsWith('left') || preset.id.endsWith('down') ? -1 : 1
      const offset = (horizontal ? W * 0.5 : H * 0.35) * k * side
      add(prop, [a, v(prop, b) + offset, ez('expo-out')], [b, v(prop, b), 'linear'])
      add('opacity', [a, 0, 'quad-out'], [at(0.35), v('opacity', b), 'linear'])
      break
    }
    case 'pop-in':
      add('scale', [a, v('scale', b) * Math.max(0.05, 1 - 0.45 * k), ez('back-out')], [b, v('scale', b), 'linear'])
      add('opacity', [a, 0, 'quad-out'], [at(0.4), v('opacity', b), 'linear'])
      break
    case 'fade-in':
      add('opacity', [a, 0, ez('quad-out')], [b, v('opacity', b), 'linear'])
      break
    case 'zoom-in':
      add('scale', [a, v('scale', b) * (1 + 0.35 * k), ez('expo-out')], [b, v('scale', b), 'linear'])
      add('opacity', [a, 0, 'quad-out'], [at(0.45), v('opacity', b), 'linear'])
      break
    case 'drop-in':
      add('y', [a, v('y', b) - H * 0.3 * k, ez('bounce-out')], [b, v('y', b), 'linear'])
      add('opacity', [a, 0, 'quad-out'], [at(0.2), v('opacity', b), 'linear'])
      break
    case 'spin-in':
      add('rotation', [a, v('rotation', b) - 25 * k, ez('back-out')], [b, v('rotation', b), 'linear'])
      add('scale', [a, v('scale', b) * 0.8, 'expo-out'], [b, v('scale', b), 'linear'])
      add('opacity', [a, 0, 'quad-out'], [at(0.4), v('opacity', b), 'linear'])
      break

    // ── Exits: accelerate away ───────────────────────────────────────────
    case 'slide-out-left':
    case 'slide-out-right':
    case 'slide-out-up':
    case 'slide-out-down': {
      const horizontal = preset.id.endsWith('left') || preset.id.endsWith('right')
      const prop: AnimatableProp = horizontal ? 'x' : 'y'
      const dir = preset.id.endsWith('left') || preset.id.endsWith('up') ? -1 : 1
      const offset = (horizontal ? W * 0.5 : H * 0.35) * k * dir
      add(prop, [a, v(prop, a), ez('expo-in')], [b, v(prop, a) + offset, 'linear'])
      add('opacity', [at(0.65), v('opacity', a), 'quad-in'], [b, 0, 'linear'])
      break
    }
    case 'pop-out':
      add('scale', [a, v('scale', a), ez('back-in')], [b, v('scale', a) * Math.max(0.05, 1 - 0.45 * k), 'linear'])
      add('opacity', [at(0.6), v('opacity', a), 'quad-in'], [b, 0, 'linear'])
      break
    case 'fade-out':
      add('opacity', [a, v('opacity', a), ez('quad-in')], [b, 0, 'linear'])
      break
    case 'zoom-out':
      add('scale', [a, v('scale', a), ez('expo-in')], [b, v('scale', a) * (1 + 0.3 * k), 'linear'])
      add('opacity', [a, v('opacity', a), 'quad-in'], [b, 0, 'linear'])
      break

    // ── Emphasis: a hit at `at`, then back to what was there ─────────────
    case 'punch': {
      const peak = Math.min(b, a + Math.max(1, Math.round(frame.fps * 0.06)))
      add('scale', [a, v('scale', a), ez('expo-out')], [peak, v('scale', peak) * (1 + 0.12 * k), 'quad-in-out'], [b, v('scale', b), 'linear'])
      break
    }
    case 'pulse': {
      const s = (f: number) => v('scale', f)
      add('scale', [a, s(a), 'sine-out'], [at(0.25), s(at(0.25)) * (1 + 0.06 * k), 'sine-in-out'], [at(0.5), s(at(0.5)), 'sine-out'], [at(0.75), s(at(0.75)) * (1 + 0.04 * k), 'sine-in-out'], [b, s(b), 'linear'])
      break
    }
    case 'shake': {
      const n = 6
      const xs: [number, number, Easing][] = []
      const rs: [number, number, Easing][] = []
      for (let i = 0; i <= n; i++) {
        const f = at(i / n)
        const decay = 1 - i / n
        const side = i === 0 || i === n ? 0 : i % 2 ? 1 : -1
        xs.push([f, v('x', f) + side * W * 0.012 * k * decay, 'sine-in-out'])
        rs.push([f, v('rotation', f) + side * 1.2 * k * decay * (i % 3 ? 1 : -1), 'sine-in-out'])
      }
      add('x', ...xs)
      add('rotation', ...rs)
      break
    }
    case 'wobble': {
      const n = 4
      const rs: [number, number, Easing][] = []
      for (let i = 0; i <= n; i++) {
        const f = at(i / n)
        const side = i === 0 || i === n ? 0 : i % 2 ? 1 : -1
        rs.push([f, v('rotation', f) + side * 5 * k * (1 - i / (n + 1)), 'sine-in-out'])
      }
      add('rotation', ...rs)
      break
    }
  }
  return { keys, range: [a, b] }
}

/** A clip's keyframes with a preset's merged in: inside its range the preset's replace what was there. */
export function mergeKeyframes(existing: Keyframe[] | undefined, added: Keyframe[], range: [number, number]): Keyframe[] {
  const kept = (existing ?? []).filter((k) => k.frame < range[0] || k.frame > range[1])
  const byFrame = new Map<number, Keyframe>()
  for (const k of [...kept, ...added]) byFrame.set(k.frame, k)
  return [...byFrame.values()].sort((x, y) => x.frame - y.frame)
}
