import { uid } from '@/lib/id'
import type {
  AudioMix,
  Clip,
  ClipAnimation,
  ClipKind,
  ColorGrade,
  FontId,
  TextStyle,
  Track,
  TrackKind,
  Transform,
} from './types'

export const PEAKS_PER_SECOND = 50

export const DEFAULT_TRANSFORM: Transform = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, rotateX: 0, rotateY: 0, z: 0 }

export const DEFAULT_COLOR: ColorGrade = {
  exposure: 0,
  contrast: 0,
  saturation: 0,
  temperature: 0,
  tint: 0,
  vignette: 0,
}

export const DEFAULT_AUDIO: AudioMix = { volume: 0, fadeIn: 0, fadeOut: 0, enhance: false, denoise: false }

export const DEFAULT_ANIMATION: ClipAnimation = {
  in: { preset: 'none', duration: 15 },
  out: { preset: 'none', duration: 15 },
}

export const DEFAULT_TEXT: TextStyle = {
  content: 'Your title',
  font: 'sans',
  size: 96,
  weight: 600,
  color: '#ffffff',
  align: 'center',
  letterSpacing: 0,
  lineHeight: 1.1,
  uppercase: false,
  italic: false,
  background: null,
  shadow: 0.35,
  glow: null,
  extrude: 0,
  material: 'chrome',
  bevel: true,
}

export const FONTS: Record<FontId, { label: string; css: string }> = {
  sans: { label: 'Geist', css: '"Geist Variable", system-ui, sans-serif' },
  display: { label: 'Bricolage Grotesque', css: '"Bricolage Grotesque Variable", system-ui, sans-serif' },
  serif: { label: 'Instrument Serif', css: '"Instrument Serif", Georgia, serif' },
  mono: { label: 'Geist Mono', css: '"Geist Mono Variable", ui-monospace, monospace' },
  hand: { label: 'Caveat', css: '"Caveat Variable", cursive' },
}

export const TRACK_HEIGHTS = { titles: 44, video: 56, main: 72, audio: 52, sfx: 44 } as const

const CLIP_NAMES: Record<ClipKind, string> = {
  video: 'Video',
  image: 'Image',
  audio: 'Audio',
  text: 'Title',
  adjustment: 'Adjustment layer',
}

type ClipInit = Partial<Omit<Clip, 'transform' | 'color' | 'audio' | 'animation' | 'text'>> &
  Pick<Clip, 'kind' | 'trackId' | 'start' | 'duration'> & {
    transform?: Partial<Transform>
    color?: Partial<ColorGrade>
    audio?: Partial<AudioMix>
    animation?: Partial<ClipAnimation>
    text?: Partial<TextStyle>
  }

/** Drops keys whose value is undefined so they don't clobber defaults when spread. */
function defined<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T
}

export function createClip(init: ClipInit): Clip {
  const { transform, color, audio, animation, text, ...rest } = init
  return {
    id: uid('clip'),
    name: CLIP_NAMES[init.kind],
    inPoint: 0,
    speed: 1,
    reverse: false,
    look: null,
    blend: 'normal',
    transitionIn: null,
    effects: [],
    keyframes: {},
    ...defined(rest),
    transform: { ...DEFAULT_TRANSFORM, ...defined(transform ?? {}) },
    color: { ...DEFAULT_COLOR, ...defined(color ?? {}) },
    audio: { ...DEFAULT_AUDIO, ...defined(audio ?? {}) },
    animation: {
      in: { ...DEFAULT_ANIMATION.in, ...defined(animation?.in ?? {}) },
      out: { ...DEFAULT_ANIMATION.out, ...defined(animation?.out ?? {}) },
    },
    text: init.kind === 'text' ? { ...DEFAULT_TEXT, ...defined(text ?? {}) } : undefined,
  }
}

export function createTrack(kind: TrackKind, init: Partial<Track> = {}): Track {
  return {
    id: uid('track'),
    kind,
    name: kind === 'video' ? 'Video' : 'Audio',
    hidden: false,
    muted: false,
    locked: false,
    height: kind === 'video' ? TRACK_HEIGHTS.video : TRACK_HEIGHTS.audio,
    ...init,
  }
}
