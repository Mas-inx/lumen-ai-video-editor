/**
 * Easing curves for keyframes: how a value travels from one keyframe to the
 * next. The classic families (sine to expo), overshoot (back), springs
 * (elastic, bounce), and any cubic-bezier — the same vocabulary as CSS and
 * GSAP, so a curve means the same thing everywhere. Each keyframe's easing
 * shapes the stretch from it to the next keyframe.
 */

export const EASING_NAMES = [
  'linear',
  'ease',
  'ease-in',
  'ease-out',
  'hold',
  'sine-in',
  'sine-out',
  'sine-in-out',
  'quad-in',
  'quad-out',
  'quad-in-out',
  'cubic-in',
  'cubic-out',
  'cubic-in-out',
  'quart-in',
  'quart-out',
  'quart-in-out',
  'expo-in',
  'expo-out',
  'expo-in-out',
  'circ-in',
  'circ-out',
  'circ-in-out',
  'back-in',
  'back-out',
  'back-in-out',
  'elastic-out',
  'bounce-out',
] as const

export type EasingName = (typeof EASING_NAMES)[number]
/** A named curve, or a custom one: "cubic-bezier(x1, y1, x2, y2)". */
export type Easing = EasingName | `cubic-bezier(${string})`

const BEZIER = /^cubic-bezier\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)$/

export const isEasing = (v: unknown): v is Easing => typeof v === 'string' && ((EASING_NAMES as readonly string[]).includes(v) || BEZIER.test(v))

// ─── Curves ──────────────────────────────────────────────────────────────

const C1 = 1.70158
const C2 = C1 * 1.525
const C3 = C1 + 1

const inOut = (f: (t: number) => number) => (t: number) => (t < 0.5 ? f(2 * t) / 2 : 1 - f(2 - 2 * t) / 2)
const out = (f: (t: number) => number) => (t: number) => 1 - f(1 - t)

const sineIn = (t: number) => 1 - Math.cos((t * Math.PI) / 2)
const quadIn = (t: number) => t * t
const cubicIn = (t: number) => t * t * t
const quartIn = (t: number) => t * t * t * t
const expoIn = (t: number) => (t === 0 ? 0 : Math.pow(2, 10 * t - 10))
const circIn = (t: number) => 1 - Math.sqrt(1 - Math.min(1, t * t))
const backIn = (t: number) => C3 * t * t * t - C1 * t * t

function bounceOut(t: number) {
  const n = 7.5625
  const d = 2.75
  if (t < 1 / d) return n * t * t
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375
  return n * (t -= 2.625 / d) * t + 0.984375
}

function elasticOut(t: number) {
  if (t === 0 || t === 1) return t
  return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1
}

const CURVES: Record<EasingName, (t: number) => number> = {
  linear: (t) => t,
  ease: inOut(cubicIn),
  'ease-in': cubicIn,
  'ease-out': out(cubicIn),
  hold: () => 0,
  'sine-in': sineIn,
  'sine-out': out(sineIn),
  'sine-in-out': inOut(sineIn),
  'quad-in': quadIn,
  'quad-out': out(quadIn),
  'quad-in-out': inOut(quadIn),
  'cubic-in': cubicIn,
  'cubic-out': out(cubicIn),
  'cubic-in-out': inOut(cubicIn),
  'quart-in': quartIn,
  'quart-out': out(quartIn),
  'quart-in-out': inOut(quartIn),
  'expo-in': expoIn,
  'expo-out': out(expoIn),
  'expo-in-out': inOut(expoIn),
  'circ-in': circIn,
  'circ-out': out(circIn),
  'circ-in-out': inOut(circIn),
  'back-in': backIn,
  'back-out': out(backIn),
  'back-in-out': (t) => (t < 0.5 ? (Math.pow(2 * t, 2) * ((C2 + 1) * 2 * t - C2)) / 2 : (Math.pow(2 * t - 2, 2) * ((C2 + 1) * (t * 2 - 2) + C2) + 2) / 2),
  'elastic-out': elasticOut,
  'bounce-out': bounceOut,
}

// ─── cubic-bezier ────────────────────────────────────────────────────────

/** A CSS cubic-bezier timing function: solve x(s) = t for s, then return y(s). */
export function bezier(x1: number, y1: number, x2: number, y2: number) {
  const cx = 3 * x1
  const bx = 3 * (x2 - x1) - cx
  const ax = 1 - cx - bx
  const cy = 3 * y1
  const by = 3 * (y2 - y1) - cy
  const ay = 1 - cy - by
  const sampleX = (s: number) => ((ax * s + bx) * s + cx) * s
  const sampleY = (s: number) => ((ay * s + by) * s + cy) * s
  const slopeX = (s: number) => (3 * ax * s + 2 * bx) * s + cx
  return (t: number) => {
    if (t <= 0) return 0
    if (t >= 1) return 1
    // Newton's method first, bisection when the slope is too flat.
    let s = t
    for (let i = 0; i < 8; i++) {
      const err = sampleX(s) - t
      if (Math.abs(err) < 1e-6) return sampleY(s)
      const d = slopeX(s)
      if (Math.abs(d) < 1e-6) break
      s -= err / d
    }
    let lo = 0
    let hi = 1
    s = t
    for (let i = 0; i < 40; i++) {
      const x = sampleX(s)
      if (Math.abs(x - t) < 1e-6) break
      if (x < t) lo = s
      else hi = s
      s = (lo + hi) / 2
    }
    return sampleY(s)
  }
}

const parsed = new Map<string, (t: number) => number>()

/** The curve for an easing (unknown ones fall back to the default "ease"). */
export function easingFn(e: Easing | string | undefined): (t: number) => number {
  if (!e) return CURVES.ease
  const named = CURVES[e as EasingName]
  if (named) return named
  let fn = parsed.get(e)
  if (!fn) {
    const m = BEZIER.exec(e)
    // x values must stay within 0..1 for the curve to be a function of time.
    fn = m ? bezier(Math.min(1, Math.max(0, Number(m[1]))), Number(m[2]), Math.min(1, Math.max(0, Number(m[3]))), Number(m[4])) : CURVES.ease
    parsed.set(e, fn)
  }
  return fn
}

/** Eased progress (0..1, beyond it for overshooting curves) at linear progress t. */
export const easeAt = (e: Easing | string | undefined, t: number) => easingFn(e)(Math.min(1, Math.max(0, t)))

/** Curves grouped for pickers, with a word on when each suits. */
export const EASING_GROUPS: { label: string; hint: string; items: { value: Easing; label: string }[] }[] = [
  {
    label: 'Smooth',
    hint: 'Most moves: starts and ends gently',
    items: [
      { value: 'ease', label: 'Ease' },
      { value: 'sine-in-out', label: 'Sine' },
      { value: 'quart-in-out', label: 'Quart' },
      { value: 'expo-in-out', label: 'Expo' },
    ],
  },
  {
    label: 'Arrive',
    hint: 'Entrances: fast, then settles',
    items: [
      { value: 'ease-out', label: 'Cubic' },
      { value: 'quart-out', label: 'Quart' },
      { value: 'expo-out', label: 'Expo' },
      { value: 'circ-out', label: 'Circ' },
    ],
  },
  {
    label: 'Leave',
    hint: 'Exits: gentle, then accelerates',
    items: [
      { value: 'ease-in', label: 'Cubic' },
      { value: 'quart-in', label: 'Quart' },
      { value: 'expo-in', label: 'Expo' },
      { value: 'circ-in', label: 'Circ' },
    ],
  },
  {
    label: 'Character',
    hint: 'Overshoot and springs — use sparingly',
    items: [
      { value: 'back-out', label: 'Overshoot' },
      { value: 'back-in-out', label: 'Anticipate' },
      { value: 'elastic-out', label: 'Elastic' },
      { value: 'bounce-out', label: 'Bounce' },
    ],
  },
  {
    label: 'Other',
    hint: 'Constant speed, or jump at the next key',
    items: [
      { value: 'linear', label: 'Linear' },
      { value: 'hold', label: 'Hold' },
    ],
  },
]

export function easingLabel(e: Easing | string | undefined) {
  if (!e) return 'Ease'
  for (const g of EASING_GROUPS) {
    const item = g.items.find((i) => i.value === e)
    if (item) return g.label === 'Other' || g.label === 'Smooth' ? item.label : `${item.label} ${g.label.toLowerCase()}`
  }
  return e.startsWith('cubic-bezier') ? 'Custom curve' : e
}
