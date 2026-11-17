/**
 * Styles: house styles that are more than colour. A style sets how titles are
 * typeset (face, weight, case, tracking, size), where they sit and how they
 * move in and out; the caption style; the transition grammar on cuts; the
 * look, finishing effects and camera move on footage; and the pacing an edit
 * in that style keeps. Applying one to the timeline or a selection is a single
 * undo step made of ordinary commands, so every value stays editable after.
 *
 * Clips remember the style they were given (`clip.style`), so applying another
 * one swaps that style's effects and camera moves for the new one's — and never
 * touches effects or animation someone added by hand.
 */
import { DEFAULT_TEXT } from './defaults'
import type { CommandInput, CommandName } from './commands'
import type { Easing } from './easing'
import { adjacentBefore } from './ops'
import { EFFECTS, LOOKS, TITLE_PRESETS } from './presets'
import { dispatch, getProject, rollbackTo, savepoint, useEditor, type ActionSource } from './store'
import { captionStyle, keyWord, type CaptionStyle } from './subtitles'
import type { AnimPreset, Clip, EffectKind, FontId, FontRef, Keyframe, Project, ProjectBrand, TextStyle, TransitionAlign, TransitionKind } from './types'

// ─── The model ───────────────────────────────────────────────────────────

/** Where a title sits on the frame. */
export type TitlePlace = 'center' | 'upper' | 'lower' | 'bottom' | 'left' | 'lower-left' | 'top-left'

export interface TitleMotion {
  preset: AnimPreset
  seconds: number
}

/** How one kind of title looks, sits and moves. What's left out stays as the title has it. */
export interface TitleLook {
  font?: FontRef
  weight?: number
  uppercase?: boolean
  italic?: boolean
  /** Letter spacing, em. */
  tracking?: number
  lineHeight?: number
  /** Text size as a fraction of the frame's short side (long lines shrink to fit). */
  size?: number
  color?: string
  /** The box behind the words; null for none. */
  background?: string | null
  shadow?: number
  outline?: { color: string; width: number } | null
  glow?: string | null
  place?: TitlePlace
  align?: 'left' | 'center' | 'right'
  in?: TitleMotion
  out?: TitleMotion
}

export interface StyleCamera {
  /** push: a slow move in · ken-burns: in, drifting sideways · drift: barely there, keeps a shot alive. */
  move: 'push' | 'ken-burns' | 'drift'
  /** What moves: all footage, or only stills (photos, generated images). */
  on: 'all' | 'stills'
  /** 0.1–3: how far it moves. */
  intensity: number
  easing: Easing
}

export interface StyleTransition {
  kind: TransitionKind
  seconds: number
  align: TransitionAlign
  /** Every nth cut gets it (1: every cut); the cuts between are straight. */
  every: number
}

export type HyperFramesFont = 'editorial' | 'serif' | 'display' | 'art' | 'wide' | 'tech' | 'sans' | 'mono'

export interface StyleSpec {
  id: string
  name: string
  /** What it's for, in a line. */
  description: string
  /** Main titles: headlines, title cards, statements. */
  headline: TitleLook
  /** Small titles: lower thirds, name supers, labels, chapter marks. */
  label: TitleLook
  captions?: { style: CaptionStyle; font?: FontRef; uppercase?: boolean; accent?: string }
  /** undefined leaves cuts as they are; null makes them straight cuts. */
  transition?: StyleTransition | null
  /** A colour look (presets.ts LOOKS). */
  look?: string
  /** Finishing effects on footage; [] takes the last style's away. */
  effects?: { kind: EffectKind; amount: number }[]
  /** undefined leaves camera moves as they are; null takes the last style's away. */
  camera?: StyleCamera | null
  /** How an edit in this style is cut — for whoever cuts it, the AI included. */
  pacing: { shotSeconds: [number, number]; cutOnBeat: boolean; notes: string }
  /** What to give render_motion_graphic so generated graphics match. */
  graphics: { lowerThird: 'editorial' | 'block' | 'minimal'; titleCard: 'editorial' | 'poster'; kinetic: 'punch' | 'stack' | 'stretch'; font: HyperFramesFont }
}

// ─── Built-in styles ─────────────────────────────────────────────────────

export const STYLES: StyleSpec[] = [
  {
    id: 'editorial',
    name: 'Editorial',
    description: 'A magazine feature: serif headlines set off-centre, small tracked labels, soft wipes and a quiet filmic finish',
    headline: { font: 'fraunces', weight: 420, uppercase: false, italic: false, tracking: -0.02, lineHeight: 1.05, size: 0.105, color: '#f4f1ea', background: null, shadow: 0.25, outline: null, glow: null, place: 'left', align: 'left', in: { preset: 'rise', seconds: 0.9 }, out: { preset: 'fade', seconds: 0.6 } },
    label: { font: 'sans', weight: 500, uppercase: true, italic: false, tracking: 0.2, lineHeight: 1.2, size: 0.026, color: '#f4f1ea', background: null, shadow: 0.3, outline: null, glow: null, place: 'lower-left', align: 'left', in: { preset: 'fade', seconds: 0.6 }, out: { preset: 'fade', seconds: 0.4 } },
    captions: { style: 'clean', font: 'sans' },
    transition: { kind: 'wipe', seconds: 0.7, align: 'center', every: 1 },
    look: 'faded',
    effects: [{ kind: 'grain', amount: 18 }],
    camera: { move: 'drift', on: 'all', intensity: 1, easing: 'linear' },
    pacing: { shotSeconds: [3, 6], cutOnBeat: false, notes: 'Let lines breathe: cut at the ends of sentences, hold a beat on faces, one idea per shot.' },
    graphics: { lowerThird: 'editorial', titleCard: 'editorial', kinetic: 'stack', font: 'editorial' },
  },
  {
    id: 'commercial',
    name: 'Product commercial',
    description: 'Bright and confident: big centred claims that pop in, solid labels, quick pushes between shots, crisp vivid colour',
    headline: { font: 'display', weight: 800, uppercase: false, italic: false, tracking: -0.035, lineHeight: 1, size: 0.13, color: '#ffffff', background: null, shadow: 0.35, outline: null, glow: null, place: 'center', align: 'center', in: { preset: 'pop', seconds: 0.45 }, out: { preset: 'zoom', seconds: 0.3 } },
    label: { font: 'sans', weight: 700, uppercase: false, italic: false, tracking: -0.01, lineHeight: 1.15, size: 0.036, color: '#111111', background: '#ffffff', shadow: 0, outline: null, glow: null, place: 'lower-left', align: 'left', in: { preset: 'wipe', seconds: 0.35 }, out: { preset: 'fade', seconds: 0.25 } },
    captions: { style: 'bold' },
    transition: { kind: 'push', seconds: 0.35, align: 'center', every: 1 },
    look: 'vivid',
    effects: [
      { kind: 'sharpen', amount: 25 },
      { kind: 'glow', amount: 14 },
    ],
    camera: { move: 'push', on: 'all', intensity: 1, easing: 'quart-out' },
    pacing: { shotSeconds: [1, 2.5], cutOnBeat: true, notes: 'Cut on the beat. One benefit per shot; hero product shots hold 2–3 s; end on the product and the call to action.' },
    graphics: { lowerThird: 'block', titleCard: 'poster', kinetic: 'punch', font: 'display' },
  },
  {
    id: 'kinetic',
    name: 'Kinetic typography',
    description: 'The words are the picture: huge capitals that punch in on the beat, zoom cuts, still black-and-white footage behind',
    headline: { font: 'archivo', weight: 850, uppercase: true, italic: false, tracking: -0.02, lineHeight: 0.95, size: 0.17, color: '#ffffff', background: null, shadow: 0, outline: null, glow: null, place: 'center', align: 'center', in: { preset: 'zoom', seconds: 0.2 }, out: { preset: 'blur', seconds: 0.15 } },
    label: { font: 'archivo', weight: 800, uppercase: true, italic: false, tracking: 0.06, lineHeight: 1, size: 0.05, color: '#ffffff', background: null, shadow: 0, outline: null, glow: null, place: 'upper', align: 'center', in: { preset: 'drop', seconds: 0.25 }, out: { preset: 'fade', seconds: 0.15 } },
    captions: { style: 'word', accent: '#ff4b36' },
    transition: { kind: 'zoom', seconds: 0.25, align: 'center', every: 1 },
    look: 'noir',
    effects: [{ kind: 'rgb', amount: 18 }],
    camera: null,
    pacing: { shotSeconds: [0.4, 1.5], cutOnBeat: true, notes: 'One idea per screen, on the beat: the words change every beat or two, and the footage holds still so the type does the moving.' },
    graphics: { lowerThird: 'minimal', titleCard: 'poster', kinetic: 'punch', font: 'wide' },
  },
  {
    id: 'infographic',
    name: 'Infographic',
    description: 'Clear and informational: boxed labels in the corner that wipe on, typed-out data, sliding steps, true colour',
    headline: { font: 'space-grotesk', weight: 600, uppercase: false, italic: false, tracking: -0.015, lineHeight: 1.1, size: 0.07, color: '#ffffff', background: 'rgba(12,14,20,0.82)', shadow: 0, outline: null, glow: null, place: 'top-left', align: 'left', in: { preset: 'wipe', seconds: 0.5 }, out: { preset: 'fade', seconds: 0.3 } },
    label: { font: 'mono', weight: 500, uppercase: true, italic: false, tracking: 0.12, lineHeight: 1.2, size: 0.028, color: '#ffffff', background: 'rgba(12,14,20,0.82)', shadow: 0, outline: null, glow: null, place: 'lower-left', align: 'left', in: { preset: 'typewriter', seconds: 0.6 }, out: { preset: 'fade', seconds: 0.25 } },
    captions: { style: 'boxed' },
    transition: { kind: 'slide', seconds: 0.45, align: 'center', every: 1 },
    look: 'natural',
    effects: [],
    camera: null,
    pacing: { shotSeconds: [3, 5], cutOnBeat: false, notes: 'Hold each number or step long enough to read twice. Build the information one step at a time, label everything, and keep the motion functional.' },
    graphics: { lowerThird: 'minimal', titleCard: 'editorial', kinetic: 'stack', font: 'tech' },
  },
  {
    id: 'cinematic',
    name: 'Cinematic',
    description: 'Film: widely spaced capitals that blur in, slow dissolves, a graded, grainy picture that slowly pushes in',
    headline: { font: 'sans', weight: 500, uppercase: true, italic: false, tracking: 0.42, lineHeight: 1.1, size: 0.075, color: '#f2efe8', background: null, shadow: 0.45, outline: null, glow: null, place: 'center', align: 'center', in: { preset: 'blur', seconds: 1.1 }, out: { preset: 'fade', seconds: 0.9 } },
    label: { font: 'sans', weight: 400, uppercase: true, italic: false, tracking: 0.32, lineHeight: 1.2, size: 0.022, color: '#f2efe8', background: null, shadow: 0.4, outline: null, glow: null, place: 'bottom', align: 'center', in: { preset: 'fade', seconds: 0.8 }, out: { preset: 'fade', seconds: 0.6 } },
    captions: { style: 'clean' },
    transition: { kind: 'dissolve', seconds: 1, align: 'center', every: 1 },
    look: 'cinematic',
    effects: [{ kind: 'grain', amount: 22 }],
    camera: { move: 'ken-burns', on: 'all', intensity: 0.5, easing: 'sine-in-out' },
    pacing: { shotSeconds: [4, 8], cutOnBeat: false, notes: 'Let shots play: wide to establish, close for emotion. Fewer, longer cuts; let silence and music carry it.' },
    graphics: { lowerThird: 'minimal', titleCard: 'editorial', kinetic: 'stretch', font: 'sans' },
  },
  {
    id: 'documentary',
    name: 'Documentary',
    description: 'Observational: name supers at the lower left, straight cuts, natural colour, slow moves on archive stills',
    headline: { font: 'serif', weight: 400, uppercase: false, italic: false, tracking: 0, lineHeight: 1.1, size: 0.085, color: '#ffffff', background: null, shadow: 0.4, outline: null, glow: null, place: 'center', align: 'center', in: { preset: 'fade', seconds: 0.8 }, out: { preset: 'fade', seconds: 0.8 } },
    label: { font: 'sans', weight: 600, uppercase: false, italic: false, tracking: 0, lineHeight: 1.25, size: 0.034, color: '#ffffff', background: null, shadow: 0.55, outline: null, glow: null, place: 'lower-left', align: 'left', in: { preset: 'fade', seconds: 0.5 }, out: { preset: 'fade', seconds: 0.5 } },
    captions: { style: 'clean' },
    transition: null,
    look: 'natural',
    effects: [],
    camera: { move: 'ken-burns', on: 'stills', intensity: 0.8, easing: 'sine-in-out' },
    pacing: { shotSeconds: [3, 7], cutOnBeat: false, notes: 'Let the interview carry it and cover its cuts with B-roll of what is said. Straight cuts; a dissolve only for time passing. Archive stills get a slow move.' },
    graphics: { lowerThird: 'minimal', titleCard: 'editorial', kinetic: 'stack', font: 'serif' },
  },
]

export const STYLE_IDS = STYLES.map((s) => s.id)

export const styleById = (id: string | null | undefined) => STYLES.find((s) => s.id === id)

/** The HyperFrames font closest to a typeface (for graphics that match the titles). */
export function hyperFramesFont(font: FontRef | undefined): HyperFramesFont {
  const map: Partial<Record<FontId, HyperFramesFont>> = { fraunces: 'editorial', serif: 'serif', display: 'display', syne: 'art', archivo: 'wide', 'space-grotesk': 'tech', sans: 'sans', mono: 'mono' }
  return (font && map[font as FontId]) || 'sans'
}

// ─── Brand ───────────────────────────────────────────────────────────────

/** How light a colour is, 0–255 (#rgb, #rrggbb, #rrggbbaa or rgb() / rgba()). */
export function lightness(color: string): number {
  let r = 0
  let g = 0
  let b = 0
  const hex = /^#([0-9a-f]{3,8})$/i.exec(color.trim())?.[1]
  if (hex) {
    const full = hex.length < 6 ? [...hex.slice(0, 3)].map((c) => c + c).join('') : hex.slice(0, 6)
    ;[r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16))
  } else {
    const m = /rgba?\(\s*(\d+)\D+(\d+)\D+(\d+)/i.exec(color)
    if (m) [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])]
  }
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** Dark or light text, whichever reads on a background. */
export const textOn = (background: string) => (lightness(background) > 150 ? '#111111' : '#ffffff')

/** A text colour on a background: `color` if it reads there, else black or white. */
const readableOn = (background: string, color: string | null) => (color && Math.abs(lightness(color) - lightness(background)) > 110 ? color : textOn(background))

/**
 * A style with a brand on it. `identity` keeps the style's composition, motion
 * and look and puts in the brand's typefaces and colours — what applying a
 * style to a branded project does. `all` also takes the brand kit's house
 * style: its title weight, case and tracking, caption style, look, transition
 * and title motion — what applying the brand kit does. With no style to build
 * on, everything the brand doesn't set stays as each clip has it.
 */
export function brandStyle(brand: ProjectBrand, base: StyleSpec | undefined, mode: 'identity' | 'all'): StyleSpec {
  const s: StyleSpec = base
    ? structuredClone(base)
    : {
        id: 'brand',
        name: brand.name,
        description: `The ${brand.name} brand`,
        headline: {},
        label: {},
        pacing: { shotSeconds: [2, 5], cutOnBeat: false, notes: 'Follow the brand’s own rules.' },
        graphics: { lowerThird: 'editorial', titleCard: 'editorial', kinetic: 'stack', font: 'sans' },
      }
  const color = brand.titles.color
  const boxed = (look: TitleLook) => typeof look.background === 'string'
  s.headline.font = brand.fonts.heading
  s.label.font = brand.fonts.body
  for (const look of [s.headline, s.label]) {
    if (boxed(look) && brand.titles.background) {
      // The style's box, in the brand's colour, with text that reads on it.
      look.background = brand.titles.background
      look.color = readableOn(brand.titles.background, color)
    } else if (!boxed(look) && color) look.color = color
  }
  s.captions = { ...(s.captions ?? { style: brand.captions.style }), font: brand.fonts.body, ...(brand.captions.accent ? { accent: brand.captions.accent } : {}) }
  s.graphics = { ...s.graphics, font: hyperFramesFont(brand.fonts.heading) }
  if (mode === 'identity') return s

  s.id = 'brand'
  s.name = base ? `${brand.name} · ${base.name}` : brand.name
  for (const look of [s.headline, s.label]) {
    look.weight = brand.titles.weight
    look.uppercase = brand.titles.uppercase
    look.tracking = brand.titles.tracking
    look.in = { preset: brand.motion.titleIn, seconds: brand.motion.seconds }
    look.out = { preset: brand.motion.titleOut, seconds: brand.motion.seconds }
  }
  // The brand's own box (or none) for labels, with text that reads on it.
  s.label.background = brand.titles.background
  if (brand.titles.background) s.label.color = readableOn(brand.titles.background, color)
  else if (color) s.label.color = color
  s.captions = { ...s.captions, style: brand.captions.style, ...(brand.captions.uppercase !== null ? { uppercase: brand.captions.uppercase } : {}) }
  if (brand.look) s.look = brand.look
  if (brand.motion.transition === 'cut') s.transition = null
  else if (brand.motion.transition) s.transition = { kind: brand.motion.transition, seconds: brand.motion.transitionSeconds, align: s.transition?.align ?? 'center', every: s.transition?.every ?? 1 }
  if (s.camera) s.camera = { ...s.camera, easing: brand.motion.easing }
  return s
}

/** A style by id: a built-in one, or "brand" for the project's brand on its own style. */
export function resolveStyle(project: Pick<Project, 'brand'>, id: string | null | undefined): StyleSpec | undefined {
  if (id === 'brand') return project.brand ? brandStyle(project.brand, styleById(project.brand.style), 'all') : undefined
  return styleById(id)
}

/** The style to apply: with the project's brand typefaces and colours kept unless `keepBrand` is false. */
export function styleToApply(project: Pick<Project, 'brand'>, id: string, keepBrand = true): StyleSpec | undefined {
  const spec = resolveStyle(project, id)
  if (!spec || id === 'brand' || !keepBrand || !project.brand) return spec
  return brandStyle(project.brand, spec, 'identity')
}

// ─── Laying titles out ───────────────────────────────────────────────────

/** How wide each built-in face sets, roughly, against an average sans. */
const FACE_WIDTH: Partial<Record<FontId, number>> = { sans: 0.95, display: 1, serif: 0.84, mono: 1.12, hand: 0.8, fraunces: 0.96, archivo: 1.02, syne: 1.14, 'space-grotesk': 1 }

const charWidth = (ch: string) => (/[A-Z]/.test(ch) ? 0.66 : /[a-z]/.test(ch) ? 0.52 : /\d/.test(ch) ? 0.56 : ch === ' ' ? 0.27 : /[.,:;'’!|]/.test(ch) ? 0.28 : 0.6)

/** About how wide a title's longest line sets, in project pixels — enough to place it and keep it on the frame. */
export function textWidth(text: Pick<TextStyle, 'content' | 'font' | 'weight' | 'uppercase' | 'letterSpacing'>, size: number) {
  const face = (FACE_WIDTH[text.font as FontId] ?? 1) * (1 + (text.weight - 400) / 2500)
  const lines = (text.uppercase ? text.content.toUpperCase() : text.content).split('\n')
  return Math.max(0, ...lines.map((line) => [...line].reduce((w, ch) => w + charWidth(ch), 0) * size * face + [...line].length * text.letterSpacing * size))
}

/** Where a title of this size goes for `place`, as the transform's x / y (the centre of the text block). */
export function titlePosition(place: TitlePlace, settings: { width: number; height: number }, block: { w: number; h: number }) {
  const { width: W, height: H } = settings
  const mx = Math.min(W, H) * 0.07
  const my = H * 0.08
  const left = Math.min(0, -W / 2 + mx + block.w / 2)
  const at = { center: [0, 0], upper: [0, -H * 0.26], lower: [0, H * 0.26], bottom: [0, H / 2 - my - block.h / 2], left: [left, 0], 'lower-left': [left, H * 0.29], 'top-left': [left, -H / 2 + my + block.h / 2] }[place]
  return { x: Math.round(at[0]), y: Math.round(at[1]) }
}

/** A text size that keeps the longest line inside `room` pixels — nothing wraps, so a long line shrinks to fit. */
export function fitSize(text: Pick<TextStyle, 'content' | 'font' | 'weight' | 'uppercase' | 'letterSpacing' | 'background'>, size: number, room: number) {
  const w = textWidth(text, size) + (text.background ? size : 0)
  return Math.max(8, w > room ? Math.floor((size * room) / w) : Math.round(size))
}

export type TitleRole = 'headline' | 'label'

/** A main title, or a small one (lower thirds, supers, labels): by its size, its box and where it sits. */
export function titleRole(project: Pick<Project, 'settings'>, clip: Clip): TitleRole {
  const t = clip.text
  if (!t) return 'headline'
  const short = Math.min(project.settings.width, project.settings.height)
  if (t.size <= short * 0.05) return 'label'
  if (t.background && t.size <= short * 0.07) return 'label'
  if (t.align === 'left' && clip.transform.y > project.settings.height * 0.15) return 'label'
  return 'headline'
}

const frames = (seconds: number, fps: number, max: number) => Math.max(1, Math.min(600, max, Math.round(seconds * fps)))

/** The clip_update patch that gives a title a style's look, place and motion. */
export function titlePatch(project: Pick<Project, 'settings'>, clip: Clip, look: TitleLook) {
  const t = { ...DEFAULT_TEXT, ...clip.text }
  const { width: W, height: H, fps } = project.settings
  const text: Partial<TextStyle> = {}
  if (look.font !== undefined) text.font = look.font
  if (look.weight !== undefined) text.weight = look.weight
  if (look.uppercase !== undefined) text.uppercase = look.uppercase
  if (look.italic !== undefined) text.italic = look.italic
  if (look.tracking !== undefined) text.letterSpacing = look.tracking
  // An extruded 3D title keeps its size, colour, place and its own 3D move: it takes the type only.
  if (t.extrude > 0) return { text }
  if (look.lineHeight !== undefined) text.lineHeight = look.lineHeight
  if (look.color !== undefined) text.color = look.color
  if (look.background !== undefined) text.background = look.background
  if (look.shadow !== undefined) text.shadow = look.shadow
  if (look.outline !== undefined) text.outline = look.outline
  if (look.glow !== undefined) text.glow = look.glow
  if (look.align !== undefined) text.align = look.align
  const next = { ...t, ...text }
  if (look.size !== undefined) {
    const room = W * (look.place === 'left' || look.place === 'lower-left' || look.place === 'top-left' ? 0.84 : 0.88)
    text.size = fitSize(next, Math.min(W, H) * look.size, room)
    next.size = text.size
  }
  const patch: { text: Partial<TextStyle>; transform?: { x: number; y: number }; animation?: { in?: { preset: AnimPreset; duration: number }; out?: { preset: AnimPreset; duration: number } } } = { text }
  if (look.place) {
    const lines = next.content.split('\n').length
    const pad = next.background ? next.size : 0
    patch.transform = titlePosition(look.place, { width: W, height: H }, { w: textWidth(next, next.size) + pad, h: lines * next.size * next.lineHeight + pad * 0.64 })
  }
  // In and out each get at most 45% of the title, so it is fully on screen in between.
  const most = Math.max(1, Math.floor(clip.duration * 0.45))
  if (look.in || look.out) {
    patch.animation = {
      ...(look.in ? { in: { preset: look.in.preset, duration: frames(look.in.seconds, fps, most) } } : {}),
      ...(look.out ? { out: { preset: look.out.preset, duration: frames(look.out.seconds, fps, most) } } : {}),
    }
  }
  return patch
}

/**
 * The clip_update patch that restyles a caption — the recipe captions are laid
 * in, with the words each one already has (add_captions lays them again with
 * the style's own number of words). Key words only stand out one word at a time.
 */
export function captionPatch(project: Pick<Project, 'settings'>, clip: Clip, captions: NonNullable<StyleSpec['captions']>, last: boolean) {
  const spec = captionStyle(captions.style)
  const { width: W, height: H } = project.settings
  const base = TITLE_PRESETS.find((t) => t.id === 'subtitle')?.text ?? {}
  const content = clip.text?.content ?? ''
  const single = content.trim().split(/\s+/).length === 1
  const key = spec.id === 'word' && single && keyWord(content, last || /[.!?]$/.test(content))
  const text = {
    ...DEFAULT_TEXT,
    ...base,
    ...spec.text,
    ...(captions.font ? { font: captions.font } : {}),
    content,
    uppercase: captions.uppercase ?? spec.text.uppercase ?? false,
    color: key ? (captions.accent ?? '#ffd84a') : (spec.text.color ?? '#ffffff'),
  }
  const { content: _content, ...style } = text
  return {
    text: { ...style, size: fitSize(text, Math.min(W, H) * spec.size, W * 0.9) },
    transform: { y: Math.round(H * spec.y) },
    animation: spec.animation,
  }
}

// ─── Camera moves ────────────────────────────────────────────────────────

const CAMERA_PROPS = ['scale', 'x'] as const
type CameraKeys = Partial<Record<(typeof CAMERA_PROPS)[number], Keyframe[]>>

/** Which way a clip drifts — the same every time for the same clip, and not the same for every clip. */
function side(id: string) {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0
  return h & 1 ? 1 : -1
}

const r3 = (v: number) => Math.round(v * 1000) / 1000

/**
 * A style's camera move on a clip, from the clip's own (un-animated) transform.
 * Each move starts at that transform, so taking it off again (keyframe_clear
 * keeps the first value) leaves the clip exactly as it was.
 */
export function cameraKeys(clip: Clip, camera: StyleCamera, settings: { width: number }): CameraKeys {
  const end = Math.max(1, clip.duration - 1)
  const k = Math.min(3, Math.max(0.1, camera.intensity))
  const s0 = clip.transform.scale
  const x0 = clip.transform.x
  const dx = side(clip.id) * settings.width * k
  const move = (from: number, to: number): Keyframe[] => [
    { frame: 0, value: r3(from), easing: camera.easing },
    { frame: end, value: r3(to), easing: 'linear' },
  ]
  switch (camera.move) {
    case 'push':
      return { scale: move(s0, s0 * (1 + 0.08 * k)) }
    case 'ken-burns':
      return { scale: move(s0, s0 * (1 + 0.12 * k)), x: move(x0, x0 + dx * 0.025) }
    case 'drift':
      return { scale: move(s0, s0 * (1 + 0.035 * k)), x: move(x0, x0 + dx * 0.008) }
  }
}

const sameKeys = (a: Keyframe[] | undefined, b: Keyframe[] | undefined) =>
  (a?.length ?? 0) === (b?.length ?? 0) && (a ?? []).every((k, i) => k.frame === b![i].frame && Math.abs(k.value - b![i].value) < 1e-6 && k.easing === b![i].easing)

// ─── Planning ────────────────────────────────────────────────────────────

export type StylePart = 'titles' | 'captions' | 'transitions' | 'footage'
export const STYLE_PARTS: StylePart[] = ['titles', 'captions', 'transitions', 'footage']

export type StyleStep = { [N in CommandName]: { name: N; input: CommandInput<N> } }[CommandName]

const step = <N extends CommandName>(name: N, input: CommandInput<N>) => ({ name, input }) as StyleStep

export interface StylePlan {
  /** The commands that apply it, in order. */
  steps: StyleStep[]
  counts: { titles: number; captions: number; cuts: number; footage: number }
  /** What was left alone, and why. */
  skipped: string[]
}

export interface StyleOptions {
  /** Only these clips (default: everything on the open timeline). */
  clipIds?: string[]
  /** Which parts (default: all). */
  parts?: StylePart[]
}

/**
 * The commands that apply a style — to the open timeline, or just to some
 * clips: titles get the typography, place and motion; captions the caption
 * style; cuts into the footage the transitions; footage the look, effects and
 * camera move. Pure: nothing changes until the steps are dispatched.
 */
export function planStyle(project: Project, spec: StyleSpec, opts: StyleOptions = {}): StylePlan {
  const parts = new Set(opts.parts?.length ? opts.parts : STYLE_PARTS)
  const fps = project.settings.fps
  const steps: StyleStep[] = []
  const skipped: string[] = []
  const counts = { titles: 0, captions: 0, cuts: 0, footage: 0 }
  const tracks = new Map(project.tracks.map((t) => [t.id, t]))
  const locked = new Set<string>()
  const scope = (opts.clipIds ? opts.clipIds.map((id) => project.clips[id]).filter((c): c is Clip => Boolean(c)) : Object.values(project.clips))
    .filter((c) => {
      const track = tracks.get(c.trackId)
      if (!track?.locked) return true
      locked.add(track.name)
      return false
    })
    .sort((a, b) => a.start - b.start)
  for (const name of locked) skipped.push(`${name} is locked`)

  const isCaption = (c: Clip) => c.kind === 'text' && tracks.get(c.trackId)?.role === 'captions'
  const isFootage = (c: Clip) => {
    if (c.kind !== 'video' && c.kind !== 'image') return false
    const role = tracks.get(c.trackId)?.role
    // Transparent overlays (rendered titles, lower thirds) and the brand's logos aren't footage to grade.
    return role !== 'titles' && role !== 'captions' && !(c.assetId && (project.assets[c.assetId]?.alpha || project.brand?.logoAssetIds.includes(c.assetId)))
  }

  // Titles: type, place and motion.
  if (parts.has('titles')) {
    for (const c of scope) {
      if (c.kind !== 'text' || isCaption(c) || !c.text) continue
      const patch = titlePatch(project, c, spec[titleRole(project, c)])
      steps.push(step('clip.update', { ids: [c.id], patch: { ...patch, style: spec.id } }))
      counts.titles++
    }
  }

  // Captions: the caption style, key words in its accent.
  if (parts.has('captions') && spec.captions) {
    const captions = scope.filter(isCaption)
    captions.forEach((c, i) => {
      steps.push(step('clip.update', { ids: [c.id], patch: { ...captionPatch(project, c, spec.captions!, i === captions.length - 1), style: spec.id } }))
      counts.captions++
    })
  }

  const footage = scope.filter(isFootage)

  // Cuts: the transition on every nth cut between two shots, straight cuts between.
  if (parts.has('transitions') && spec.transition !== undefined) {
    let n = 0
    for (const c of footage) {
      const before = adjacentBefore(project, c)
      if (!before || (before.kind !== 'video' && before.kind !== 'image')) continue
      const t = spec.transition
      if (t && (n++ + 1) % Math.max(1, t.every) === 0) {
        steps.push(step('clip.setTransition', { id: c.id, transition: { kind: t.kind, duration: Math.max(2, Math.round(t.seconds * fps)), align: t.align } }))
        counts.cuts++
      } else if (c.transitionIn) {
        steps.push(step('clip.setTransition', { id: c.id, transition: null }))
        counts.cuts++
      }
    }
  }

  // Footage: the look, the finishing effects and the camera move.
  if (parts.has('footage')) {
    const look = spec.look ? LOOKS.find((l) => l.id === spec.look) : undefined
    const effects = (spec.effects ?? []).filter((e) => EFFECTS.some((x) => x.kind === e.kind))
    // A shot is marked with the style whose effects and camera move it wears — not with one that left them as they were.
    const owns = spec.effects !== undefined && spec.camera !== undefined
    let animatedByHand = 0
    for (const c of footage) {
      const prev = c.style ? resolveStyle(project, c.style) : undefined
      const before = steps.length
      if (look || owns) steps.push(step('clip.update', { ids: [c.id], patch: { ...(look ? { color: look.grade, look: look.id } : {}), ...(owns ? { style: spec.id } : {}) } }))
      if (spec.effects !== undefined) {
        // The last style's effects go, unless this one has them too; anyone else's stay.
        const keep = new Set(effects.map((e) => e.kind))
        for (const fx of c.effects) if (prev?.effects?.some((e) => e.kind === fx.kind) && !keep.has(fx.kind)) steps.push(step('effect.remove', { clipId: c.id, effectId: fx.id }))
        for (const e of effects) steps.push(step('effect.add', { ids: [c.id], kind: e.kind, amount: e.amount }))
      }
      if (spec.camera !== undefined) {
        const wanted = spec.camera && (spec.camera.on === 'all' || c.kind === 'image') && c.duration >= fps * 0.5 ? cameraKeys(c, spec.camera, project.settings) : null
        const theirs = prev?.camera && (prev.camera.on === 'all' || c.kind === 'image') ? cameraKeys(c, prev.camera, project.settings) : null
        const styleMade = theirs !== null && CAMERA_PROPS.every((prop) => sameKeys(c.keyframes[prop], theirs[prop])) && !c.keyframes.y?.length
        const animated = CAMERA_PROPS.some((prop) => c.keyframes[prop]?.length) || Boolean(c.keyframes.y?.length)
        if (animated && !styleMade) {
          if (wanted) animatedByHand++
        } else if (!(styleMade && wanted && CAMERA_PROPS.every((prop) => sameKeys(theirs![prop], wanted[prop])))) {
          // Take the last style's move off (back to the clip's own transform), then put this one's on.
          if (styleMade) for (const prop of CAMERA_PROPS) if (c.keyframes[prop]?.length) steps.push(step('keyframe.clear', { clipId: c.id, prop }))
          if (wanted) for (const prop of CAMERA_PROPS) for (const k of wanted[prop] ?? []) steps.push(step('keyframe.set', { clipId: c.id, prop, frame: k.frame, value: k.value, easing: k.easing }))
        }
      }
      if (steps.length > before) counts.footage++
    }
    if (animatedByHand) skipped.push(`${animatedByHand === 1 ? 'A shot keeps the' : `${animatedByHand} shots keep the`} motion they were animated with by hand`)
  }
  return { steps, counts, skipped }
}

/** Applies a style as one undo step (all of it, or — if a step fails — none of it). */
export function applyStyle(spec: StyleSpec, opts: StyleOptions & { source?: ActionSource; label?: string } = {}): StylePlan {
  const source = opts.source ?? 'user'
  const plan = planStyle(getProject(), spec, opts)
  if (!plan.steps.length) return plan
  let failure: string | null = null
  useEditor.getState().transaction(opts.label ?? `Apply ${spec.name} style`, source, () => {
    const mark = savepoint()
    for (const s of plan.steps) {
      const res = dispatch(s.name, s.input as never, { source })
      if (!res.ok) {
        failure = `${s.name}: ${res.error}`
        break
      }
    }
    if (failure && mark) rollbackTo(mark)
  })
  if (failure) throw new Error(`Couldn’t apply ${spec.name} (${failure}) — nothing was changed.`)
  return plan
}

/** A style as the AI reads it: every rule, times in seconds. */
export function describeStyle(spec: StyleSpec) {
  const title = (look: TitleLook) => ({
    ...(look.font ? { font: look.font } : {}),
    ...(look.weight ? { weight: look.weight } : {}),
    ...(look.uppercase !== undefined ? { case: look.uppercase ? 'upper' : 'as written' } : {}),
    ...(look.tracking !== undefined ? { tracking_em: look.tracking } : {}),
    ...(look.size !== undefined ? { size_of_short_side: look.size } : {}),
    ...(look.color ? { color: look.color } : {}),
    ...(look.background ? { box: look.background } : {}),
    ...(look.place ? { place: look.place, align: look.align } : {}),
    ...(look.in ? { in: `${look.in.preset} ${look.in.seconds}s` } : {}),
    ...(look.out ? { out: `${look.out.preset} ${look.out.seconds}s` } : {}),
  })
  return {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    headline: title(spec.headline),
    label: title(spec.label),
    ...(spec.captions ? { captions: spec.captions } : {}),
    transition: spec.transition === undefined ? 'unchanged' : spec.transition ? { kind: spec.transition.kind, seconds: spec.transition.seconds, align: spec.transition.align, every_nth_cut: spec.transition.every } : 'straight cuts',
    ...(spec.look ? { look: spec.look } : {}),
    ...(spec.effects ? { effects: spec.effects } : {}),
    camera: spec.camera === undefined ? 'unchanged' : spec.camera ? { move: spec.camera.move, on: spec.camera.on, intensity: spec.camera.intensity, easing: spec.camera.easing } : 'none',
    pacing: { shot_seconds: spec.pacing.shotSeconds, cut_on_beat: spec.pacing.cutOnBeat, notes: spec.pacing.notes },
    motion_graphics: { 'lower-third': { style: spec.graphics.lowerThird }, 'title-card': { style: spec.graphics.titleCard }, kinetic: { style: spec.graphics.kinetic }, font: spec.graphics.font },
  }
}
