/**
 * The project document. Everything the user (or an AI agent) can change lives
 * here, is serializable, and is only ever mutated through commands.
 *
 * Time on the timeline is always an integer frame count at the project frame rate.
 */
export type Frame = number

// ─── Assets ──────────────────────────────────────────────────────────────

export type AssetKind = 'video' | 'image' | 'audio'

export type AssetSource =
  /**
   * A media file on disk: one the user imported, or one Lumen made (renders,
   * generations, recordings). `url` is derived from `path` when a project opens.
   */
  | {
      type: 'file'
      url: string
      /** Absolute path on disk. */
      path?: string
      /** Path relative to the project file, so moved project folders still find their media. */
      relPath?: string
      mime: string
      fileName: string
      size: number
      /** File modification time (ms) — cache key for thumbnails and waveforms. */
      mtime?: number
      poster?: string
      /** The file couldn't be found when the project was opened. */
      missing?: boolean
    }
  /** Numbered frames (PNG with alpha) rendered by Blender, HyperFrames or another generator. */
  | {
      type: 'sequence'
      base: string
      /** Folder on disk holding the frames. */
      dir?: string
      relDir?: string
      pattern: string
      frameCount: number
      fps: number
      poster?: string
      missing?: boolean
    }

export interface SpeechSegment {
  /** seconds, relative to the asset start */
  start: number
  end: number
  text: string
}

export interface Asset {
  id: string
  name: string
  kind: AssetKind
  /** Source length in seconds; undefined for stills (infinitely extendable). */
  duration?: number
  width?: number
  height?: number
  fps?: number
  hasAudio?: boolean
  source: AssetSource
  /** Normalized amplitude peaks (0..1) at PEAKS_PER_SECOND, when known. */
  peaks?: number[]
  /** Has an alpha channel (titles, overlays) */
  alpha?: boolean
  generated?: boolean
  /** Where a generated asset came from, so it can be re-made or tweaked. */
  provenance?: { integration: string; tool: string; prompt?: string; params?: Record<string, unknown> }
  /** Timed speech (voiceovers, transcribed recordings), in seconds from the asset start. */
  transcript?: SpeechSegment[]
  favorite?: boolean
  tags?: string[]
  /** A small copy of a heavy video that the preview plays instead (exports always use the original). */
  proxy?: { path: string; url: string; width: number; height: number }
  addedAt: number
}

// ─── Tracks ──────────────────────────────────────────────────────────────

export type TrackKind = 'video' | 'audio'

/** Channel EQ: a low cut, low and high shelves and one bell in the middle. Gains in dB. */
export interface EqSettings {
  enabled: boolean
  /** High-pass corner in Hz; 0 = off. */
  lowCut: number
  lowFreq: number
  lowGain: number
  midFreq: number
  midGain: number
  midQ: number
  highFreq: number
  highGain: number
}

export interface CompressorSettings {
  enabled: boolean
  /** dB */
  threshold: number
  ratio: number
  /** ms */
  attack: number
  /** ms */
  release: number
  /** Make-up gain, dB */
  makeup: number
}

export interface LimiterSettings {
  enabled: boolean
  /** Highest peak let through, dBFS */
  ceiling: number
}

/** A mixer channel — a track's, or the master bus: level, pan and processing, in that order after the processing. */
export interface BusMix {
  /** Fader, dB (-60..+12) */
  volume: number
  /** -1 left … 1 right */
  pan: number
  eq?: EqSettings
  compressor?: CompressorSettings
  limiter?: LimiterSettings
}

export interface Track {
  id: string
  kind: TrackKind
  name: string
  hidden: boolean
  muted: boolean
  locked: boolean
  /** Only soloed tracks are heard while any track is soloed. */
  solo?: boolean
  /** The track's mixer channel; missing means unity gain, centered, no processing. */
  mix?: BusMix
  /** Lane height in px — a view preference that travels with the project. */
  height: number
  role?: 'main' | 'titles' | 'captions'
}

// ─── Clips ───────────────────────────────────────────────────────────────

export type ClipKind = 'video' | 'image' | 'audio' | 'text' | 'adjustment'

export interface Transform {
  /** Offset from frame center, in project pixels. */
  x: number
  y: number
  /** 1 = 100% */
  scale: number
  /** degrees, in the screen plane */
  rotation: number
  /** 0..1 */
  opacity: number
  /** 3D: tilt around the horizontal axis, degrees (positive = top leans back) */
  rotateX: number
  /** 3D: turn around the vertical axis, degrees */
  rotateY: number
  /** 3D: distance toward the camera, in project pixels */
  z: number
}

/** A tone curve: points (x in, y out, both 0..1) joined by a smooth spline, sorted by x. */
export type CurvePoints = [number, number][]

/** Tone curves: master (all channels), then red, green and blue. */
export interface Curves {
  master: CurvePoints
  red: CurvePoints
  green: CurvePoints
  blue: CurvePoints
}

/** A colour wheel: the colour it pushes toward (x, y on the wheel, -1..1) and a brightness offset (-1..1). */
export interface Wheel {
  x: number
  y: number
  luma: number
}

/** Lift (shadows), gamma (midtones) and gain (highlights). */
export interface Wheels {
  lift: Wheel
  gamma: Wheel
  gain: Wheel
}

export type HslBand = 'red' | 'orange' | 'yellow' | 'green' | 'aqua' | 'blue' | 'purple' | 'magenta'

/** Per colour range: hue shift (degrees, -60..60), saturation and luminance (-100..100). */
export type HslAdjust = Partial<Record<HslBand, { hue: number; saturation: number; luminance: number }>>

/** All values -100..100 except vignette (0..100). */
export interface ColorGrade {
  exposure: number
  contrast: number
  saturation: number
  temperature: number
  tint: number
  vignette: number
  curves?: Curves
  wheels?: Wheels
  hsl?: HslAdjust
  /** A 3D LUT from the project's LUTs, mixed in by `amount` (0..1). */
  lut?: { id: string; amount: number }
}

export interface AudioMix {
  /** dB, -60..+12 */
  volume: number
  fadeIn: Frame
  fadeOut: Frame
  enhance: boolean
  denoise: boolean
  /** A video clip whose sound was split onto its own audio clip — the video itself stays silent. */
  detached?: boolean
}

/**
 * Crop, as fractions of the picture cut from each edge (0..0.95), plus
 * rounded corners as a fraction of half the shorter visible side (0..1).
 */
export interface Crop {
  left: number
  right: number
  top: number
  bottom: number
  radius: number
}

export type FontId = 'sans' | 'display' | 'serif' | 'mono' | 'hand'

/** A built-in font id, or `custom:<id>` for a font in the project. */
export type FontRef = FontId | `custom:${string}`

export type Material3D = 'chrome' | 'gold' | 'matte' | 'neon'

export interface TextStyle {
  content: string
  font: FontRef
  /** px at project resolution */
  size: number
  weight: number
  color: string
  align: 'left' | 'center' | 'right'
  /** em */
  letterSpacing: number
  lineHeight: number
  uppercase: boolean
  italic: boolean
  /** Box behind the text, null for none. */
  background: string | null
  /** Drop shadow strength 0..1 */
  shadow: number
  /** Neon-style glow color, null for none. */
  glow: string | null
  /** Outline around the letters; width as a fraction of the font size (0..0.3). */
  outline?: { color: string; width: number } | null
  /** Extrusion depth relative to font size — 0 keeps the title flat, >0 makes it real 3D. */
  extrude: number
  material: Material3D
  bevel: boolean
}

export type AnimPreset = 'none' | 'fade' | 'rise' | 'drop' | 'pop' | 'zoom' | 'blur' | 'wipe' | 'typewriter' | 'spin3d' | 'flip3d'

export interface AnimSpec {
  preset: AnimPreset
  duration: Frame
}

export interface ClipAnimation {
  in: AnimSpec
  out: AnimSpec
}

export type TransitionKind =
  | 'dissolve'
  | 'dip'
  | 'flash'
  | 'slide'
  | 'push'
  | 'zoom'
  | 'wipe'
  | 'blur'
  // 3D — rendered with the WebGL stage
  | 'cube'
  | 'flip'
  | 'door'
  | 'swing'
  | 'page'
  | 'warp'
  | 'shatter'
  | 'spin'

export interface Transition {
  kind: TransitionKind
  duration: Frame
}

export type EffectKind =
  | 'blur'
  | 'glow'
  | 'vignette'
  | 'grain'
  | 'mono'
  | 'shake'
  | 'pulse'
  | 'leak'
  | 'rgb'
  | 'sharpen'
  // Keys — make part of the picture transparent
  | 'chromaKey'
  | 'lumaKey'
  // 3D — rendered with the WebGL stage
  | 'tilt3d'
  | 'curve3d'
  | 'wave3d'
  | 'cube3d'
  | 'mirror3d'

export interface Effect {
  id: string
  kind: EffectKind
  enabled: boolean
  /** 0..100 */
  amount: number
  /** Extra settings some effects take (a key's colour, a threshold…). */
  params?: Record<string, number | string>
}

/** A shape that shows (or, inverted, hides) part of a clip — or limits where an adjustment layer applies. */
export interface Mask {
  id: string
  shape: 'rectangle' | 'ellipse'
  /** Center, as fractions of the frame (0..1). */
  x: number
  y: number
  /** Size, as fractions of the frame. */
  width: number
  height: number
  /** degrees */
  rotation: number
  /** Soft edge, as a fraction of the frame's shorter side (0..0.5). */
  feather: number
  /** Rounded corners for rectangles, 0..1. */
  roundness: number
  /** Show what's outside the shape instead. */
  invert: boolean
  /** 0..1 */
  opacity: number
}

export type BlendMode =
  | 'normal'
  | 'screen'
  | 'multiply'
  | 'overlay'
  | 'soft-light'
  | 'lighten'
  | 'darken'
  | 'color-dodge'
  | 'difference'

/** `speed` keyframes make a speed ramp: the clip's footage plays at a changing rate. */
export type AnimatableProp = 'x' | 'y' | 'scale' | 'rotation' | 'opacity' | 'volume' | 'rotateX' | 'rotateY' | 'z' | 'speed'

export type Easing = 'linear' | 'ease' | 'ease-in' | 'ease-out' | 'hold'

export interface Keyframe {
  /** Relative to the clip start. */
  frame: Frame
  value: number
  easing: Easing
}

export interface Clip {
  id: string
  kind: ClipKind
  trackId: string
  name: string
  start: Frame
  duration: Frame
  assetId?: string
  /** Offset into the source media, in project frames at 1× speed. */
  inPoint: Frame
  speed: number
  reverse: boolean
  transform: Transform
  color: ColorGrade
  /** Named look preset last applied (informational). */
  look: string | null
  audio: AudioMix
  text?: TextStyle
  blend: BlendMode
  animation: ClipAnimation
  /** Transition that plays over the first frames of this clip, from the clip before it. */
  transitionIn: Transition | null
  effects: Effect[]
  keyframes: Partial<Record<AnimatableProp, Keyframe[]>>
  crop?: Crop
  masks?: Mask[]
  /** Clips sharing a group move and select together (a video and its detached sound, or a user group). */
  groupId?: string
  /** Holds the frame at `inPoint` for the whole clip (a freeze frame). */
  freeze?: boolean
}

export interface ProjectLut {
  id: string
  name: string
  /** Points per side (e.g. 33). */
  size: number
  /** size³ RGB triples, red fastest, as 8-bit values in base64. */
  data: string
}

export interface ProjectFont {
  id: string
  /** Display name, e.g. “Inter Tight Bold”. */
  name: string
  /** CSS family it's registered under. */
  family: string
  fileName: string
  /** The font file, base64. */
  data: string
}

// ─── Project ─────────────────────────────────────────────────────────────

export type MarkerColor = 'lime' | 'violet' | 'pink' | 'amber' | 'emerald' | 'sky'

export interface Marker {
  id: string
  frame: Frame
  label: string
  color: MarkerColor
}

export interface ProjectSettings {
  width: number
  height: number
  fps: number
  background: string
}

/** In and out points on the timeline: what plays in a loop, exports as a range, or gets lifted / extracted. */
export interface TimelineRange {
  in: Frame
  out: Frame
}

export interface Project {
  id: string
  name: string
  settings: ProjectSettings
  assets: Record<string, Asset>
  tracks: Track[]
  clips: Record<string, Clip>
  markers: Marker[]
  range?: TimelineRange | null
  /** The master bus every track feeds. */
  master?: BusMix
  /** Imported 3D LUTs (.cube), by id. */
  luts?: Record<string, ProjectLut>
  /** Imported fonts (from files or the system), embedded so the project travels. */
  fonts?: Record<string, ProjectFont>
  createdAt: number
}
