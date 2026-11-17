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
  /** Each word's timing, when the transcriber gave them (same seconds). */
  words?: SpeechWord[]
}

/** One word of a transcript phrase. */
export interface SpeechWord {
  start: number
  end: number
  text: string
}

/** Something that happens in a clip with no sound of its own (a line said, a cut, footsteps), told by the app that made it. */
export interface AssetCue {
  /** Seconds from the start of the media. */
  at: number
  /** speech, line, sfx, walk, cut, marker… whatever the sender calls it. */
  kind: string
  /** What it is, in words: the line, the sound, the shot's name. */
  label: string
  /** How long it lasts, when the sender knows. */
  seconds?: number
  /** Who says or does it. */
  who?: string
  /** Everything else the sender said about it. */
  data?: Record<string, string | number | boolean>
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
  /** What it shows, in words (written by the user or the AI after looking) — B-roll is found by it. */
  description?: string
  /** A small copy of a heavy video that the preview plays instead (exports always use the original). */
  proxy?: { path: string; url: string; width: number; height: number }
  /** What happens in it and when, from the app that made it (see editor/cues.ts). */
  cues?: AssetCue[]
  /** A screen recording's pointer: where it was and when it clicked (see shared/capture.ts). */
  cursor?: CursorTrack
  /** The music's beat grid, once detected (source seconds). */
  beats?: { bpm: number; times: number[]; downbeats: number[]; confidence: number }
  /** A subject matte made from another media item (kept with the project, not listed in the Media panel). */
  matteOf?: {
    assetId: string
    subject: 'person' | 'any'
    from: number
    to: number
    /** Where the subject usually is (0..1 of the frame; the median over the stretch). */
    box?: { x: number; y: number; w: number; h: number }
  }
  /** A depth map made from another media item, for relighting (kept with the project, not listed in the Media panel). */
  depthOf?: { assetId: string; from: number; to: number }
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

/** White balance: gains per channel in linear light (1, 1, 1 is neutral). */
export interface WhiteBalance {
  r: number
  g: number
  b: number
}

/** Levels: where black and white sit in the footage (0..1) and a midtone gamma (1 is neutral). */
export interface Levels {
  black: number
  white: number
  gamma: number
}

/** A shot match: per-channel curves that bring a clip's footage in line with a reference clip's. */
export interface ShotMatch {
  red: CurvePoints
  green: CurvePoints
  blue: CurvePoints
  /** The clip it was matched to (informational). */
  ref?: string
}

/**
 * All values -100..100 (a vignette below 0 lightens the edges). The correction
 * — balance, levels, match — runs first, on the footage as it came in; the
 * creative grade follows.
 */
export interface ColorGrade {
  exposure: number
  contrast: number
  saturation: number
  temperature: number
  tint: number
  vignette: number
  balance?: WhiteBalance
  levels?: Levels
  match?: ShotMatch
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

export type FontId = 'sans' | 'display' | 'serif' | 'mono' | 'hand' | 'fraunces' | 'archivo' | 'syne' | 'space-grotesk'

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
  // Smart — they read the two shots at the cut (see TransitionMatch), drawn on the GPU
  | 'morph'
  | 'through'
  | 'whip'
  | 'luma'
  | 'match'

/**
 * Where a transition sits on its cut: ending at it (over the end of the first
 * clip), centred on it, or starting at it (over the start of the second).
 */
export type TransitionAlign = 'before' | 'center' | 'after'

export interface Transition {
  kind: TransitionKind
  duration: Frame
  /** Default 'after'. */
  align?: TransitionAlign
  /** What a smart transition measured of the two shots at its cut (project/transition-actions.ts). */
  match?: TransitionMatch
}

/**
 * The two shots at a cut, measured: what smart transitions carry across it.
 * Without a measurement they fall back to neutral settings.
 */
export interface TransitionMatch {
  /** Where the outgoing and incoming shots' subjects are (fractions of the frame): Zoom Through goes into one and out of the other. */
  from?: { x: number; y: number }
  to?: { x: number; y: number }
  /** The camera's motion around the cut, in frame heights a second (x right, y down): Whip Pan carries it on. */
  motion?: { x: number; y: number }
  /** Where the outgoing frame's content lands in the incoming one: w × h cells of offsets (fractions of the frame), x then y, as base64 float32. Morph warps along it. */
  flow?: { w: number; h: number; data: string }
  /** Curves that give the incoming shot the outgoing one's colours; Colour Match eases them off. */
  color?: { red: CurvePoints; green: CurvePoints; blue: CurvePoints }
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
  // Light — rendered on the GPU
  | 'halation'
  | 'rays'
  | 'flare'
  | 'relight'
  | 'particles'
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
  /** Moves with a point tracked in the footage (positions as fractions of the frame). */
  follow?: TrackPath
}

/**
 * A tracked point: one position per frame from `start` (clip frames). What
 * follows it moves by how far the point has travelled since frame `ref` —
 * before the path it holds the first offset, after it the last.
 */
export interface TrackPath {
  /** Clip frame of the first point. */
  start: Frame
  /** Index of the point tracking began from (where the follower sits as placed). */
  ref: number
  /** x, y pairs — project pixels from the centre for a clip, fractions of the frame for a mask. */
  points: number[]
}

/**
 * Stabilization: the camera's path measured in the footage, smoothed; the
 * difference is taken out of every frame, zoomed in just enough to hide the edges.
 */
export interface Stabilization {
  /** Source second of the first measured frame. */
  start: number
  /** Measured frames per second. */
  rate: number
  /** The camera path: x, y (fractions of the picture) and angle (radians) per measured frame. */
  path: number[]
  /** Seconds of smoothing — more is steadier (0.2..4). */
  smooth: number
  /** Scale that hides the moving edges (1..2). */
  zoom: number
  /** Also hold the horizon steady. */
  rotation: boolean
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

/** The curve from a keyframe to the next: a named curve or "cubic-bezier(x1, y1, x2, y2)" (see easing.ts). */
export type { Easing } from './easing'
import type { Easing } from './easing'
import type { CursorTrack } from '@shared/capture'

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
  /** The style last applied (see editor/styles.ts) — which effects and camera moves are the style's. */
  style?: string
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
  /** A nested timeline this clip plays instead of media: video clips show its picture and sound, audio clips its sound. */
  sequenceId?: string
  /** Multicam: the camera angle shown — a video track of the multicam timeline. */
  angle?: string
  /** Moves with a point tracked in the footage. */
  follow?: TrackPath
  /** Camera shake measured in the footage and smoothed away. */
  stabilize?: Stabilization
  /** Cut down to the subject (or, inverted, to everything but it) by an AI matte. */
  matte?: SubjectMatte
  /** How near each point of the picture is (an AI depth map): what Relight shapes its light around. */
  depth?: DepthMap
}

/** An AI depth map for a clip: a video of the picture's depth (white = near). */
export interface DepthMap {
  /** The depth media. */
  assetId: string
  /** Source seconds the depth map starts at (it covers the stretch it was made for). */
  from: number
}

/** An AI matte applied to a clip: a video of the subject's shape (white = subject). */
export interface SubjectMatte {
  /** The matte media. */
  assetId: string
  /** Source seconds the matte starts at (it covers the stretch it was made for). */
  from: number
  /** Keep everything except the subject. */
  invert?: boolean
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

// ─── Storyboard ──────────────────────────────────────────────────────────

/** How a scene is made: shot footage, B-roll, kinetic type, an infographic, generated media, 3D, a motion graphic… */
export type SceneTreatment =
  | 'footage'
  | 'broll'
  | 'kinetic-type'
  | 'infographic'
  | 'generated-image'
  | 'generated-video'
  | '3d'
  | 'motion-graphic'
  | 'other'

export type SceneStatus = 'planned' | 'in-progress' | 'done'

/** Where a scene was made: a stretch of a timeline, and the clips that make it (the stretch follows them as the edit changes). */
export interface SceneProduced {
  timelineId: string
  from: Frame
  to: Frame
  clipIds?: string[]
}

export interface StoryboardScene {
  id: string
  title: string
  /** What's said over it: narration, dialogue or the words on screen. */
  script: string
  treatment: SceneTreatment
  /** Target length in seconds — a plan, so it doesn't depend on any timeline's frame rate. */
  seconds: number
  /** How it comes in from the scene before; null is a straight cut. */
  transition: { kind: TransitionKind; seconds: number } | null
  /** What it still needs: shots to find or film, media to generate. */
  needs: string[]
  /** Media in the project it uses (or will use). */
  assetIds: string[]
  status: SceneStatus
  notes: string
  produced?: SceneProduced
}

/** A plan for the video, made before (and kept while) producing it: ordered scenes. */
export interface Storyboard {
  title?: string
  /** What the video is for, who it's for, the tone. */
  brief?: string
  /** The style every scene keeps (an editor/styles.ts id, or "brand"). */
  style?: string | null
  scenes: StoryboardScene[]
}

// ─── Brand ───────────────────────────────────────────────────────────────

export interface BrandTitles {
  /** Text colour (hex), or null to keep each style's. */
  color: string | null
  /** The box behind lower thirds and labels (hex), or null for none. */
  background: string | null
  weight: number
  uppercase: boolean
  /** Letter spacing, em. */
  tracking: number
}

export interface BrandCaptions {
  style: 'clean' | 'bold' | 'word' | 'boxed'
  /** Key words in word-by-word captions (hex). */
  accent: string | null
  /** null keeps the caption style's own case. */
  uppercase: boolean | null
}

export interface BrandMotion {
  titleIn: AnimPreset
  titleOut: AnimPreset
  /** How long title animations take. */
  seconds: number
  /** The curve for camera moves and keyframes. */
  easing: Easing
  /** On cuts: a transition, 'cut' for straight cuts, or null to leave cuts alone. */
  transition: TransitionKind | 'cut' | null
  transitionSeconds: number
}

/**
 * The brand a project was given, from a brand kit: its identity (colours,
 * typefaces, logos) and house style, kept with the project so it travels.
 */
export interface ProjectBrand {
  /** The brand kit it came from. */
  kitId?: string
  name: string
  colors: { name: string; hex: string }[]
  /** Built-in fonts, or `custom:<id>` fonts embedded in the project. */
  fonts: { heading: FontRef; body: FontRef }
  /** The logos, as media in the project. */
  logoAssetIds: string[]
  titles: BrandTitles
  captions: BrandCaptions
  /** A colour look id (presets.ts), or null to leave footage as it is. */
  look: string | null
  motion: BrandMotion
  /** The style (editor/styles.ts) the brand builds on, or null. */
  style: string | null
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

/** A timeline that isn't open: everything a timeline holds, kept while another one is edited. */
export interface Sequence {
  id: string
  name: string
  settings: ProjectSettings
  tracks: Track[]
  clips: Record<string, Clip>
  markers: Marker[]
  range?: TimelineRange | null
  master?: BusMix
  /** A multicam source: each video track is one camera angle, its audio tracks the sound. */
  multicam?: boolean
  createdAt: number
}

/** Which timeline is open. */
export interface SequenceRef {
  id: string
  name: string
  multicam?: boolean
  createdAt?: number
}

/**
 * A project holds one or more timelines. The open one lives in `settings`,
 * `tracks`, `clips`, `markers`, `range` and `master` (so everything edits it
 * directly); the others wait in `sequences`. Clips can play another timeline
 * (`Clip.sequenceId`) — nesting.
 */
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
  /** The open timeline (missing in projects from before timelines: the main timeline). */
  sequence?: SequenceRef
  /** The project's other timelines, by id. */
  sequences?: Record<string, Sequence>
  /** The plan the video is produced from (see editor/storyboard.ts). */
  storyboard?: Storyboard
  /** The brand applied from a brand kit. */
  brand?: ProjectBrand
  createdAt: number
}
