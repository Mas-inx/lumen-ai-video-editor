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

/** All values -100..100 except vignette (0..100). */
export interface ColorGrade {
  exposure: number
  contrast: number
  saturation: number
  temperature: number
  tint: number
  vignette: number
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

export type Material3D = 'chrome' | 'gold' | 'matte' | 'neon'

export interface TextStyle {
  content: string
  font: FontId
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
  /** Clips sharing a group move and select together (a video and its detached sound, or a user group). */
  groupId?: string
  /** Holds the frame at `inPoint` for the whole clip (a freeze frame). */
  freeze?: boolean
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
  createdAt: number
}
