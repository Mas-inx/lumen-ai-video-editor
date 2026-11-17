import type {
  AnimPreset,
  ClipAnimation,
  ColorGrade,
  Effect,
  EffectKind,
  TextStyle,
  TransitionKind,
  Transform,
} from './types'

// ─── Looks (color presets) ───────────────────────────────────────────────

export interface Look {
  id: string
  name: string
  grade: ColorGrade
}

const g = (p: Partial<ColorGrade>): ColorGrade => ({
  exposure: 0,
  contrast: 0,
  saturation: 0,
  temperature: 0,
  tint: 0,
  vignette: 0,
  ...p,
})

export const LOOKS: Look[] = [
  { id: 'natural', name: 'Natural', grade: g({}) },
  { id: 'cinematic', name: 'Cinematic', grade: g({ exposure: -4, contrast: 22, saturation: -6, temperature: 8, tint: -6, vignette: 30 }) },
  { id: 'golden', name: 'Golden Hour', grade: g({ exposure: 6, contrast: 8, saturation: 14, temperature: 42, tint: 6, vignette: 12 }) },
  { id: 'nordic', name: 'Nordic', grade: g({ exposure: 2, contrast: 10, saturation: -24, temperature: -30, tint: -4 }) },
  { id: 'vivid', name: 'Vivid', grade: g({ contrast: 14, saturation: 38 }) },
  { id: 'faded', name: 'Faded Film', grade: g({ exposure: 8, contrast: -26, saturation: -18, temperature: 10, vignette: 18 }) },
  { id: 'moody', name: 'Moody', grade: g({ exposure: -14, contrast: 24, saturation: -22, temperature: -12, vignette: 48 }) },
  { id: 'dream', name: 'Dream', grade: g({ exposure: 12, contrast: -14, saturation: 12, tint: 18, temperature: 6 }) },
  { id: 'noir', name: 'Noir', grade: g({ contrast: 38, saturation: -100, vignette: 44 }) },
  { id: 'teal', name: 'Teal Night', grade: g({ exposure: -6, contrast: 16, saturation: 6, temperature: -40, tint: -14, vignette: 26 }) },
]

// ─── Transitions ─────────────────────────────────────────────────────────

export const TRANSITIONS: { kind: TransitionKind; name: string; description: string; is3d?: boolean; smart?: boolean }[] = [
  { kind: 'dissolve', name: 'Cross Dissolve', description: 'Blend smoothly between shots' },
  { kind: 'dip', name: 'Dip to Black', description: 'Fade out, then in' },
  { kind: 'flash', name: 'Flash', description: 'Bright white pop on the cut' },
  { kind: 'slide', name: 'Slide', description: 'Next shot slides over' },
  { kind: 'push', name: 'Push', description: 'Next shot pushes the last away' },
  { kind: 'zoom', name: 'Zoom', description: 'Punch in to the next shot' },
  { kind: 'wipe', name: 'Wipe', description: 'Soft-edged horizontal wipe' },
  { kind: 'blur', name: 'Blur', description: 'Defocus through the cut' },
  { kind: 'cube', name: 'Cube', description: 'Rotate to the next face', is3d: true },
  { kind: 'flip', name: 'Flip', description: 'Turn the shot over like a card', is3d: true },
  { kind: 'door', name: 'Doorway', description: 'Doors swing open onto the next shot', is3d: true },
  { kind: 'swing', name: 'Swing In', description: 'Next shot drops in on a hinge', is3d: true },
  { kind: 'page', name: 'Page Curl', description: 'Peel the shot away like paper', is3d: true },
  { kind: 'warp', name: 'Warp Zoom', description: 'Fly through into the next shot', is3d: true },
  { kind: 'shatter', name: 'Shatter', description: 'Burst into pieces', is3d: true },
  { kind: 'spin', name: '3D Spin', description: 'Spin away in depth', is3d: true },
  { kind: 'morph', name: 'Morph', description: 'Warp one shot into the next', smart: true },
  { kind: 'through', name: 'Zoom Through', description: 'Into one subject, out of the next', smart: true },
  { kind: 'whip', name: 'Whip Pan', description: 'Carries the camera’s motion on', smart: true },
  { kind: 'luma', name: 'Luma Fade', description: 'The next shot’s light leads in', smart: true },
  { kind: 'match', name: 'Colour Match', description: 'Starts in this shot’s colours', smart: true },
]

export const is3dTransition = (kind: TransitionKind) => TRANSITIONS.some((t) => t.kind === kind && t.is3d)

/** Transitions that read the two shots at their cut (drawn on the GPU from a TransitionMatch). */
export const isSmartTransition = (kind: TransitionKind) => TRANSITIONS.some((t) => t.kind === kind && t.smart)

// ─── Effects ─────────────────────────────────────────────────────────────

/**
 * A setting an effect takes, as the inspector shows it. `default` is the value
 * when the effect has no such param — for effects that predate the setting,
 * that keeps old projects looking as they did; new effects start from the
 * preset's `params`.
 */
export type EffectControl =
  | { key: string; label: string; type: 'slider'; min: number; max: number; default: number; unit?: string; hint?: string }
  | { key: string; label: string; type: 'color'; default: string; hint?: string }
  | { key: string; label: string; type: 'select'; default: string; options: { value: string; label: string }[]; hint?: string }
  | { key: string; label: string; type: 'switch'; default: number; hint?: string }
  /** A position on the frame: `key` is x and `keyY` is y, as fractions (beyond 0..1 is off the frame). */
  | { key: string; keyY: string; label: string; type: 'point'; default: [number, number]; min: number; max: number; hint?: string }

export interface EffectPreset {
  kind: EffectKind
  name: string
  description: string
  amount: number
  is3d?: boolean
  /** Light and lens effects get their own section in the library. */
  light?: boolean
  /** What a new effect of this kind starts with. */
  params?: Record<string, number | string>
  controls?: EffectControl[]
}

const slider = (key: string, label: string, def: number, hint?: string, min = 0, max = 100, unit?: string): EffectControl => ({ key, label, type: 'slider', min, max, default: def, ...(unit ? { unit } : {}), ...(hint ? { hint } : {}) })
const lightAt = (x: number, y: number, label = 'Light'): EffectControl => ({ key: 'x', keyY: 'y', label, type: 'point', default: [x, y], min: -0.5, max: 1.5, hint: 'Drag the light — it can sit off the frame too' })
const follow: EffectControl = { key: 'follow', label: 'Follow', type: 'switch', default: 0, hint: 'Moves with the brightest light in the shot' }

export const EFFECTS: EffectPreset[] = [
  { kind: 'blur', name: 'Gaussian Blur', description: 'Soften the whole frame', amount: 30 },
  {
    kind: 'glow',
    name: 'Glow & Bloom',
    description: 'Highlights bleed into the shadows',
    amount: 45,
    light: true,
    params: { threshold: 55, radius: 50, tint: '#ffffff' },
    controls: [
      slider('threshold', 'Threshold', 0, 'How bright a part must be to glow — 0 glows the whole picture'),
      slider('radius', 'Radius', 47, 'How far the light spreads'),
      { key: 'tint', label: 'Colour', type: 'color', default: '#ffffff' },
    ],
  },
  {
    kind: 'halation',
    name: 'Halation',
    description: 'Film’s red glow around bright edges',
    amount: 50,
    light: true,
    params: { threshold: 68, radius: 32, tint: '#ff3d14' },
    controls: [
      slider('threshold', 'Threshold', 68, 'How bright an edge must be to halate'),
      slider('radius', 'Radius', 32, 'How far the glow reaches past the edge'),
      { key: 'tint', label: 'Colour', type: 'color', default: '#ff3d14' },
    ],
  },
  {
    kind: 'rays',
    name: 'God Rays',
    description: 'Shafts of light through haze',
    amount: 60,
    light: true,
    params: { x: 0.5, y: 0.1, follow: 0, threshold: 62, length: 60, haze: 25, tint: '#fff1d6' },
    controls: [
      lightAt(0.5, 0.1),
      follow,
      slider('threshold', 'Threshold', 62, 'Which bright parts cast rays'),
      slider('length', 'Length', 60),
      slider('haze', 'Haze', 25, 'Atmosphere around the light'),
      { key: 'tint', label: 'Colour', type: 'color', default: '#fff1d6' },
    ],
  },
  {
    kind: 'flare',
    name: 'Lens Flare',
    description: 'A bright light catching the lens',
    amount: 60,
    light: true,
    params: { x: 0.28, y: 0.26, follow: 0, style: 'classic', size: 50, ghosts: 60, tint: '#ffd9a8' },
    controls: [
      lightAt(0.28, 0.26),
      follow,
      {
        key: 'style',
        label: 'Lens',
        type: 'select',
        default: 'classic',
        options: [
          { value: 'classic', label: 'Classic' },
          { value: 'anamorphic', label: 'Anamorphic' },
          { value: 'star', label: 'Starburst' },
        ],
      },
      slider('size', 'Size', 50),
      slider('ghosts', 'Reflections', 60, 'The rings and discs the lens throws across the frame'),
      { key: 'tint', label: 'Colour', type: 'color', default: '#ffd9a8' },
    ],
  },
  {
    kind: 'leak',
    name: 'Light Leak',
    description: 'Light spilling onto the film',
    amount: 55,
    light: true,
    params: { style: 'burst', color: '#ff8a3d', color2: '#ff3d7f', speed: 40, angle: 30, seed: 1 },
    controls: [
      {
        key: 'style',
        label: 'Style',
        type: 'select',
        default: 'drift',
        options: [
          { value: 'drift', label: 'Drifting glow' },
          { value: 'burst', label: 'Burst' },
          { value: 'streak', label: 'Streaks' },
          { value: 'edge', label: 'Edge burn' },
          { value: 'prism', label: 'Prism' },
        ],
      },
      { key: 'color', label: 'Colour', type: 'color', default: '#ff9646' },
      { key: 'color2', label: 'Second colour', type: 'color', default: '#ff4678' },
      slider('speed', 'Speed', 40),
      slider('angle', 'Direction', 30, 'Where the light comes from', 0, 360, '°'),
      slider('seed', 'Variation', 1, 'A different leak with the same settings'),
    ],
  },
  {
    kind: 'relight',
    name: 'Relight',
    description: 'Add a light, change where it falls',
    amount: 60,
    light: true,
    params: { x: 0.25, y: 0.3, height: 45, reach: 55, ambient: 75, soft: 40, shine: 20, color: '#fff0dc' },
    controls: [
      lightAt(0.25, 0.3),
      slider('height', 'Height', 45, 'Low rakes across the surface; high lights it from the front'),
      slider('reach', 'Reach', 55, 'How far the light carries'),
      slider('ambient', 'Existing light', 75, 'Lower it to let the new light take over'),
      slider('soft', 'Softness', 40, 'Wraps the light around shapes'),
      slider('shine', 'Shine', 20, 'Highlights where the light catches'),
      { key: 'color', label: 'Colour', type: 'color', default: '#fff0dc' },
    ],
  },
  {
    kind: 'particles',
    name: 'Particles',
    description: 'Dust, snow, rain, embers, bokeh…',
    amount: 60,
    light: true,
    params: { style: 'dust', size: 40, speed: 35, wind: 15, depth: 60, light: 0, color: '#ffffff', seed: 1 },
    controls: [
      {
        key: 'style',
        label: 'Kind',
        type: 'select',
        default: 'dust',
        options: [
          { value: 'dust', label: 'Dust in the air' },
          { value: 'snow', label: 'Snow' },
          { value: 'rain', label: 'Rain' },
          { value: 'embers', label: 'Embers' },
          { value: 'bokeh', label: 'Bokeh' },
          { value: 'sparkles', label: 'Sparkles' },
          { value: 'confetti', label: 'Confetti' },
        ],
      },
      slider('size', 'Size', 40),
      slider('speed', 'Speed', 35),
      slider('wind', 'Wind', 15, 'Sideways drift — below 0 blows left', -100, 100),
      slider('depth', 'Depth', 60, 'Layers near and far, moving at their own speeds'),
      { key: 'light', label: 'Catch light', type: 'switch', default: 0, hint: 'Shows only where the shot is lit, like dust in a sunbeam' },
      { key: 'color', label: 'Colour', type: 'color', default: '#ffffff', hint: 'Tints them (confetti keeps its colours)' },
      slider('seed', 'Variation', 1, 'A different scatter with the same settings'),
    ],
  },
  {
    kind: 'vignette',
    name: 'Vignette',
    description: 'Darken or lighten the edges',
    amount: 50,
    light: true,
    params: { size: 55, feather: 55, roundness: 60, x: 0.5, y: 0.5, color: '#000000' },
    controls: [
      slider('size', 'Size', 55, 'How much of the middle stays clear'),
      slider('feather', 'Feather', 55),
      slider('roundness', 'Roundness', 60, '0 follows the frame’s corners, 100 is a circle'),
      { key: 'x', keyY: 'y', label: 'Centre', type: 'point', default: [0.5, 0.5], min: 0, max: 1, hint: 'Drag to move the clear middle' },
      { key: 'color', label: 'Colour', type: 'color', default: '#000000', hint: 'Black darkens the edges, white lightens them' },
    ],
  },
  { kind: 'grain', name: 'Film Grain', description: 'Organic 16mm texture', amount: 40 },
  { kind: 'mono', name: 'Monochrome', description: 'Rich black & white', amount: 100 },
  { kind: 'shake', name: 'Camera Shake', description: 'Handheld energy', amount: 35 },
  { kind: 'pulse', name: 'Zoom Pulse', description: 'Beat-synced punch-in', amount: 40 },
  { kind: 'rgb', name: 'RGB Split', description: 'Chromatic glitch offset', amount: 30 },
  { kind: 'sharpen', name: 'Sharpen', description: 'Crisp up soft footage', amount: 40 },
  { kind: 'chromaKey', name: 'Chroma Key', description: 'Remove a green or blue screen', amount: 100, params: { color: '#00d84a', tolerance: 32, softness: 18, spill: 60 } },
  { kind: 'lumaKey', name: 'Luma Key', description: 'Drop out the black (or white)', amount: 100, params: { threshold: 18, softness: 12, invert: 0 } },
  { kind: 'tilt3d', name: '3D Tilt', description: 'Floating card with depth', amount: 60, is3d: true },
  { kind: 'curve3d', name: 'Curved Screen', description: 'Wrap the shot like a cinema screen', amount: 55, is3d: true },
  { kind: 'wave3d', name: 'Flag Wave', description: 'Ripples like fabric in the wind', amount: 45, is3d: true },
  { kind: 'cube3d', name: 'Photo Cube', description: 'Your shot on a spinning cube', amount: 60, is3d: true },
  { kind: 'mirror3d', name: 'Reflection', description: 'Stand on a glossy floor', amount: 60, is3d: true },
]

export const is3dEffect = (kind: EffectKind) => EFFECTS.some((e) => e.kind === kind && e.is3d)

/** What an effect does when it has no `key` param (see EffectControl). */
function controlDefault(kind: EffectKind, key: string): number | string | undefined {
  for (const c of EFFECTS.find((e) => e.kind === kind)?.controls ?? []) {
    if (c.key === key) return c.type === 'point' ? c.default[0] : c.default
    if (c.type === 'point' && c.keyY === key) return c.default[1]
  }
  return undefined
}

/** An effect's setting as a number: its param, else what the effect does without one. */
export function fxNumber(fx: Pick<Effect, 'kind' | 'params'>, key: string, fallback = 0): number {
  const v = fx.params?.[key]
  if (typeof v === 'number' && Number.isFinite(v)) return v
  const d = controlDefault(fx.kind, key)
  return typeof d === 'number' ? d : fallback
}

/** An effect's setting as text (a colour, a style): its param, else what the effect does without one. */
export function fxString(fx: Pick<Effect, 'kind' | 'params'>, key: string, fallback = ''): string {
  const v = fx.params?.[key]
  if (typeof v === 'string' && v) return v
  const d = controlDefault(fx.kind, key)
  return typeof d === 'string' ? d : fallback
}

function describeControl(c: EffectControl) {
  switch (c.type) {
    case 'slider':
      return `${c.key} ${c.min}–${c.max}`
    case 'color':
      return `${c.key} "#rrggbb"`
    case 'select':
      return `${c.key}: ${c.options.map((o) => o.value).join(' | ')}`
    case 'switch':
      return `${c.key} 0 | 1`
    case 'point':
      return `${c.key}, ${c.keyY} (fractions of the frame, ${c.min}–${c.max})`
  }
}

/** The settings each effect takes, in words: the AI's reference (in effect_add's description). */
export function effectParamsDoc() {
  return EFFECTS.filter((e) => e.controls?.length)
    .map((e) => `${e.kind} { ${e.controls!.map(describeControl).join(', ')} }`)
    .join('; ')
}

// ─── Animations ──────────────────────────────────────────────────────────

export const ANIMATIONS: { preset: AnimPreset; name: string; textOnly?: boolean }[] = [
  { preset: 'none', name: 'None' },
  { preset: 'fade', name: 'Fade' },
  { preset: 'rise', name: 'Rise' },
  { preset: 'drop', name: 'Drop' },
  { preset: 'pop', name: 'Pop' },
  { preset: 'zoom', name: 'Zoom' },
  { preset: 'blur', name: 'Blur' },
  { preset: 'wipe', name: 'Wipe' },
  { preset: 'typewriter', name: 'Typewriter', textOnly: true },
  { preset: 'spin3d', name: '3D Spin' },
  { preset: 'flip3d', name: '3D Flip' },
]

// ─── Speed ramps ─────────────────────────────────────────────────────────

/** Speed-ramp shapes: the speed at positions 0 (clip start) to 1 (clip end). */
export const SPEED_RAMPS: { id: string; name: string; description: string; points: { at: number; speed: number }[] }[] = [
  { id: 'montage', name: 'Montage', description: 'Bursts of speed around a slow beat', points: [{ at: 0, speed: 1 }, { at: 0.22, speed: 3 }, { at: 0.5, speed: 0.5 }, { at: 0.78, speed: 3 }, { at: 1, speed: 1 }] },
  { id: 'hero', name: 'Hero', description: 'Fast in, slow-motion moment, fast out', points: [{ at: 0, speed: 2 }, { at: 0.38, speed: 2 }, { at: 0.5, speed: 0.3 }, { at: 0.62, speed: 2 }, { at: 1, speed: 2 }] },
  { id: 'bullet', name: 'Bullet', description: 'Racing, then time nearly stops, then racing', points: [{ at: 0, speed: 4 }, { at: 0.4, speed: 0.2 }, { at: 0.6, speed: 0.2 }, { at: 1, speed: 4 }] },
  { id: 'flash-in', name: 'Flash in', description: 'Starts fast and settles to real time', points: [{ at: 0, speed: 5 }, { at: 0.35, speed: 1 }, { at: 1, speed: 1 }] },
  { id: 'flash-out', name: 'Flash out', description: 'Real time, then whips away fast', points: [{ at: 0, speed: 1 }, { at: 0.65, speed: 1 }, { at: 1, speed: 5 }] },
  { id: 'ramp-up', name: 'Speed up', description: 'Slow motion building to fast', points: [{ at: 0, speed: 0.5 }, { at: 1, speed: 3 }] },
  { id: 'ramp-down', name: 'Slow down', description: 'Fast easing into slow motion', points: [{ at: 0, speed: 3 }, { at: 1, speed: 0.4 }] },
]

// ─── Title presets ───────────────────────────────────────────────────────

export interface TitlePreset {
  id: string
  name: string
  sample: string
  text: Partial<TextStyle>
  transform?: Partial<Transform>
  animation?: Partial<ClipAnimation>
  /** seconds */
  duration: number
  is3d?: boolean
}

export const TITLE_PRESETS: TitlePreset[] = [
  {
    id: 'cinematic',
    name: 'Cinematic',
    sample: 'YOUR TITLE',
    text: { font: 'sans', size: 104, weight: 500, uppercase: true, letterSpacing: 0.42, shadow: 0.45 },
    animation: { in: { preset: 'blur', duration: 24 }, out: { preset: 'fade', duration: 18 } },
    duration: 4,
  },
  {
    id: 'elegant',
    name: 'Elegant Serif',
    sample: 'Your story',
    text: { font: 'serif', size: 128, weight: 400, italic: true, letterSpacing: -0.01, shadow: 0.4 },
    animation: { in: { preset: 'rise', duration: 24 }, out: { preset: 'fade', duration: 18 } },
    duration: 4,
  },
  {
    id: 'headline',
    name: 'Bold Headline',
    sample: 'Big news',
    text: { font: 'display', size: 150, weight: 800, letterSpacing: -0.03, shadow: 0.3 },
    animation: { in: { preset: 'pop', duration: 14 }, out: { preset: 'zoom', duration: 12 } },
    duration: 3,
  },
  {
    id: 'lower-third',
    name: 'Lower Third',
    sample: 'Your Name',
    text: { font: 'sans', size: 44, weight: 600, align: 'left', background: 'rgba(12,12,16,0.72)', shadow: 0 },
    transform: { x: -520, y: 360 },
    animation: { in: { preset: 'wipe', duration: 16 }, out: { preset: 'fade', duration: 12 } },
    duration: 4,
  },
  {
    id: 'subtitle',
    name: 'Subtitle',
    sample: 'Your caption here.',
    text: { font: 'sans', size: 46, weight: 500, background: 'rgba(0,0,0,0.55)', shadow: 0 },
    transform: { y: 400 },
    animation: { in: { preset: 'fade', duration: 6 }, out: { preset: 'fade', duration: 6 } },
    duration: 2.5,
  },
  {
    id: 'neon',
    name: 'Neon Glow',
    sample: 'After dark',
    text: { font: 'display', size: 120, weight: 700, color: '#f6ecff', glow: '#b28cff', shadow: 0 },
    animation: { in: { preset: 'zoom', duration: 18 }, out: { preset: 'fade', duration: 14 } },
    duration: 3,
  },
  {
    id: 'handwritten',
    name: 'Handwritten',
    sample: 'see you soon',
    text: { font: 'hand', size: 140, weight: 500, color: '#fff3e0', shadow: 0.35 },
    animation: { in: { preset: 'typewriter', duration: 36 }, out: { preset: 'fade', duration: 18 } },
    duration: 4,
  },
  {
    id: '3d-chrome',
    name: '3D Chrome',
    sample: 'TITLE',
    text: { font: 'sans', size: 150, weight: 800, uppercase: true, letterSpacing: 0.04, extrude: 0.32, material: 'chrome', bevel: true, shadow: 0 },
    animation: { in: { preset: 'spin3d', duration: 30 }, out: { preset: 'fade', duration: 14 } },
    duration: 4,
    is3d: true,
  },
  {
    id: '3d-gold',
    name: '3D Gold',
    sample: 'Premiere',
    text: { font: 'serif', size: 170, weight: 400, italic: true, extrude: 0.22, material: 'gold', bevel: true, shadow: 0 },
    animation: { in: { preset: 'flip3d', duration: 30 }, out: { preset: 'fade', duration: 14 } },
    duration: 4,
    is3d: true,
  },
  {
    id: '3d-block',
    name: '3D Block',
    sample: 'BOLD',
    text: { font: 'display', size: 190, weight: 800, uppercase: true, extrude: 0.5, material: 'matte', color: '#d6ee00', bevel: true, shadow: 0 },
    animation: { in: { preset: 'pop', duration: 16 }, out: { preset: 'zoom', duration: 12 } },
    duration: 3,
    is3d: true,
  },
  {
    id: 'chapter',
    name: 'Chapter',
    sample: 'CHAPTER 01',
    text: { font: 'mono', size: 34, weight: 500, uppercase: true, letterSpacing: 0.28, color: '#ffffffd9', align: 'left', shadow: 0.4 },
    transform: { x: -560, y: 400 },
    animation: { in: { preset: 'typewriter', duration: 28 }, out: { preset: 'fade', duration: 12 } },
    duration: 3.5,
  },
]
