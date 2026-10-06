/**
 * The command layer — the single way the project changes.
 *
 * Every command has a Zod schema and a description. The UI dispatches them,
 * undo/redo records them, and the MCP server (phase 2) exposes the exact same
 * definitions as AI tools, so an agent can do anything a user can.
 */
import { current, isDraft } from 'immer'
import { z } from 'zod'
import { uid } from '@/lib/id'
import { createClip, createTrack, DEFAULT_BUS, DEFAULT_COMPRESSOR, DEFAULT_EQ, DEFAULT_LIMITER, IDENTITY_CURVES, NEUTRAL_WHEELS, TRACK_HEIGHTS } from './defaults'
import { EASING_NAMES, type Easing } from './easing'
import { ANIMATABLE, evalKeyframes } from './keyframes'
import { MOTION_PRESETS, mergeKeyframes, presetKeyframes, PRESET_IDS } from './motion-presets'
import { EFFECTS } from './presets'
import {
  clipEnd,
  clipsAt,
  clipsOnTrack,
  cloneClip,
  deleteClips,
  detachAudio,
  dropLoneGroups,
  findFreeStart,
  freezeFrame,
  groupClips,
  insertGap,
  isMagneticTrack,
  liftRange,
  moveTrack,
  overwriteRange,
  removeRange,
  reattachAudio,
  resolveMoveDelta,
  rippleTrimClip,
  rollEdit,
  slideClip,
  slipClip,
  framesIn,
  sourceFrames,
  splitClips,
  trackAccepts,
  trimClip,
  ungroupClips,
  maxTransition,
} from './ops'
import {
  angleTracks,
  blankSequence,
  copySequence,
  freshName,
  getSequence,
  nestClips,
  openSequence,
  openSequenceId,
  swapIn,
  TimelineError,
  unnestClip,
  usesOf,
  wouldLoop,
} from './sequences'
import { averageSpeed, consumed, localForConsumed, MAX_SPEED, MIN_SPEED } from './timing'
import type { AnimatableProp, BusMix, Clip, Project, Sequence, Track } from './types'

export class CommandError extends Error {}

// ─── Schemas ─────────────────────────────────────────────────────────────

const id = z.string().min(1)
const frame = z.number().int().min(0)
const length = z.number().int().min(1)

const clipKind = z.enum(['video', 'image', 'audio', 'text', 'adjustment'])
const blend = z.enum(['normal', 'screen', 'multiply', 'overlay', 'soft-light', 'lighten', 'darken', 'color-dodge', 'difference'])
const animPreset = z.enum(['none', 'fade', 'rise', 'drop', 'pop', 'zoom', 'blur', 'wipe', 'typewriter', 'spin3d', 'flip3d'])
const transitionKind = z.enum(['dissolve', 'dip', 'flash', 'slide', 'push', 'zoom', 'wipe', 'blur', 'cube', 'flip', 'door', 'swing', 'page', 'warp', 'shatter', 'spin'])
const effectKind = z.enum(['blur', 'glow', 'vignette', 'grain', 'mono', 'shake', 'pulse', 'leak', 'rgb', 'sharpen', 'chromaKey', 'lumaKey', 'tilt3d', 'curve3d', 'wave3d', 'cube3d', 'mirror3d'])
const fontId = z.enum(['sans', 'display', 'serif', 'mono', 'hand', 'fraunces', 'archivo', 'syne', 'space-grotesk'])
/** A built-in font, or `custom:<id>` for one imported into the project (ids in get_project → fonts). */
const fontRef = z.union([fontId, z.templateLiteral(['custom:', z.string().min(1)])])
const effectParams = z.record(z.string(), z.union([z.number(), z.string()]))
const easing = z
  .union([z.enum(EASING_NAMES), z.string().regex(/^cubic-bezier\(\s*-?[\d.]+\s*,\s*-?[\d.]+\s*,\s*-?[\d.]+\s*,\s*-?[\d.]+\s*\)$/)])
  .describe(
    'Curve to the next keyframe: linear, ease, ease-in, ease-out, hold, or sine/quad/cubic/quart/expo/circ/back -in, -out or -in-out, elastic-out, bounce-out, or "cubic-bezier(x1, y1, x2, y2)". Entrances read best with an -out curve, exits with -in, camera moves with sine-in-out.',
  ) as unknown as z.ZodType<Easing>
const animatable = z.enum(['x', 'y', 'scale', 'rotation', 'opacity', 'volume', 'rotateX', 'rotateY', 'z', 'speed'])
const markerColor = z.enum(['lime', 'violet', 'pink', 'amber', 'emerald', 'sky'])
const pct = z.number().min(-100).max(100)
/** How clips land where others already are: slide to the nearest gap, cover them, or push them later. */
const editMode = z.enum(['free', 'overwrite', 'insert'])
const attribute = z.enum(['transform', 'crop', 'color', 'effects', 'audio', 'speed', 'animation', 'text', 'blend'])

/** Values the schemas accept, for tools that list what's available. */
export const BLEND_MODES = blend.options
export const EASINGS: readonly string[] = EASING_NAMES
export const ATTRIBUTES = attribute.options
export type EditMode = z.infer<typeof editMode>
export type Attribute = z.infer<typeof attribute>

const transform = z.object({
  x: z.number(),
  y: z.number(),
  scale: z.number().min(0).max(20),
  rotation: z.number(),
  opacity: z.number().min(0).max(1),
  rotateX: z.number().min(-360).max(360),
  rotateY: z.number().min(-360).max(360),
  z: z.number().min(-20000).max(5000),
})

const unit = z.number().min(0).max(1)
const curvePoints = z.array(z.tuple([unit, unit])).min(2).max(16)
const curves = z.object({ master: curvePoints, red: curvePoints, green: curvePoints, blue: curvePoints })
const wheel = z.object({ x: z.number().min(-1).max(1), y: z.number().min(-1).max(1), luma: z.number().min(-1).max(1) })
const wheels = z.object({ lift: wheel, gamma: wheel, gain: wheel })
const hslBand = z.enum(['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'])
const hsl = z.partialRecord(hslBand, z.object({ hue: z.number().min(-60).max(60), saturation: pct, luminance: pct }))
const lutRef = z.object({ id, amount: unit })

const grade = z.object({
  exposure: pct,
  contrast: pct,
  saturation: pct,
  temperature: pct,
  tint: pct,
  vignette: z.number().min(0).max(100),
  curves: curves.optional(),
  wheels: wheels.optional(),
  hsl: hsl.optional(),
  lut: lutRef.optional(),
})

/** A colour change: basic sliders, plus curves, wheels, HSL and a LUT (null removes one). */
const gradePatch = grade
  .extend({ curves: curves.partial().nullable(), wheels: wheels.partial().nullable(), hsl: hsl.nullable(), lut: lutRef.partial().nullable() })
  .partial()

/** A tracked point's path (what a clip or mask follows). */
const trackPath = z.object({ start: z.number().int(), ref: z.number().int().min(0), points: z.array(z.number()).max(400_000) })

const stabilization = z.object({
  start: z.number().min(0),
  rate: z.number().positive(),
  path: z.array(z.number()).max(600_000),
  smooth: z.number().min(0.1).max(8),
  zoom: z.number().min(1).max(3),
  rotation: z.boolean(),
})

const mask = z.object({
  id,
  shape: z.enum(['rectangle', 'ellipse']),
  x: z.number().min(-1).max(2),
  y: z.number().min(-1).max(2),
  width: z.number().min(0.001).max(3),
  height: z.number().min(0.001).max(3),
  rotation: z.number().min(-360).max(360),
  feather: z.number().min(0).max(0.5),
  roundness: unit,
  invert: z.boolean(),
  opacity: unit,
  follow: trackPath.optional(),
})

/** A change to a mask; `follow: null` stops it following a tracked point. */
const maskPatch = mask.omit({ id: true }).extend({ follow: trackPath.nullable() }).partial()

const audioMix = z.object({
  volume: z.number().min(-60).max(12),
  fadeIn: frame,
  fadeOut: frame,
  enhance: z.boolean(),
  denoise: z.boolean(),
  detached: z.boolean().optional(),
})

const crop = z.object({
  left: z.number().min(0).max(0.95),
  right: z.number().min(0).max(0.95),
  top: z.number().min(0).max(0.95),
  bottom: z.number().min(0).max(0.95),
  radius: z.number().min(0).max(1),
})

const eq = z.object({
  enabled: z.boolean(),
  lowCut: z.number().min(0).max(1000),
  lowFreq: z.number().min(20).max(1000),
  lowGain: z.number().min(-24).max(24),
  midFreq: z.number().min(100).max(10000),
  midGain: z.number().min(-24).max(24),
  midQ: z.number().min(0.1).max(12),
  highFreq: z.number().min(1000).max(20000),
  highGain: z.number().min(-24).max(24),
})

const compressor = z.object({
  enabled: z.boolean(),
  threshold: z.number().min(-60).max(0),
  ratio: z.number().min(1).max(20),
  attack: z.number().min(0.1).max(1000),
  release: z.number().min(10).max(3000),
  makeup: z.number().min(0).max(24),
})

const limiter = z.object({ enabled: z.boolean(), ceiling: z.number().min(-24).max(0) })

/** A change to a mixer channel; null removes a processor. */
const busPatch = z
  .object({
    volume: z.number().min(-60).max(12),
    pan: z.number().min(-1).max(1),
    eq: eq.partial().nullable(),
    compressor: compressor.partial().nullable(),
    limiter: limiter.partial().nullable(),
  })
  .partial()

const textStyle = z.object({
  content: z.string(),
  font: fontRef,
  size: z.number().min(4).max(800),
  weight: z.number().min(100).max(900),
  color: z.string(),
  align: z.enum(['left', 'center', 'right']),
  letterSpacing: z.number().min(-0.5).max(2),
  lineHeight: z.number().min(0.5).max(3),
  uppercase: z.boolean(),
  italic: z.boolean(),
  background: z.string().nullable(),
  shadow: z.number().min(0).max(1),
  glow: z.string().nullable(),
  outline: z.object({ color: z.string(), width: z.number().min(0).max(0.3) }).nullable().optional(),
  extrude: z.number().min(0).max(2),
  material: z.enum(['chrome', 'gold', 'matte', 'neon']),
  bevel: z.boolean(),
})

const animSpec = z.object({ preset: animPreset, duration: z.number().int().min(1).max(600) })
const subjectMatte = z.object({ assetId: z.string().min(1), from: z.number().min(0), invert: z.boolean().optional() })
const transition = z.object({ kind: transitionKind, duration: z.number().int().min(2).max(300), align: z.enum(['before', 'center', 'after']).optional() })

export const clipPatch = z
  .object({
    name: z.string().min(1),
    speed: z.number().min(MIN_SPEED).max(MAX_SPEED),
    reverse: z.boolean(),
    blend,
    look: z.string().nullable(),
    transform: transform.partial(),
    color: gradePatch,
    audio: audioMix.partial(),
    text: textStyle.partial(),
    animation: z.object({ in: animSpec.partial(), out: animSpec.partial() }).partial(),
    crop: crop.partial().nullable(),
    masks: z.array(mask).nullable(),
    /** Multicam clips: the angle to show (a video track id of the multicam timeline). */
    angle: id,
    follow: trackPath.nullable(),
    stabilize: stabilization.partial().nullable(),
    /** A subject matte (make one with cut_out_subject); null removes it. */
    matte: subjectMatte.nullable(),
  })
  .partial()

export type ClipPatch = z.infer<typeof clipPatch>

const keyframe = z.object({ frame, value: z.number(), easing })

/** A whole clip as get_clip or a copy holds it — what paste and paste-attributes take. */
export const clipSnapshot = z.object({
  id,
  kind: clipKind,
  trackId: id,
  name: z.string(),
  start: z.number().min(0),
  duration: length,
  assetId: id.optional(),
  inPoint: z.number().min(0),
  speed: z.number().min(MIN_SPEED).max(MAX_SPEED),
  reverse: z.boolean(),
  transform,
  color: grade.loose(),
  look: z.string().nullable(),
  audio: audioMix,
  text: textStyle.optional(),
  blend,
  animation: z.object({ in: animSpec, out: animSpec }),
  transitionIn: transition.nullable(),
  effects: z.array(z.object({ id, kind: effectKind, enabled: z.boolean(), amount: z.number().min(0).max(100) }).loose()),
  keyframes: z.partialRecord(animatable, z.array(keyframe)),
  crop: crop.optional(),
  masks: z.array(mask).optional(),
  groupId: z.string().optional(),
  freeze: z.boolean().optional(),
  sequenceId: id.optional(),
  angle: id.optional(),
  follow: trackPath.optional(),
  stabilize: stabilization.optional(),
  matte: subjectMatte.optional(),
})

export type ClipSnapshot = z.infer<typeof clipSnapshot>

const assetSource = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('file'),
    url: z.string(),
    path: z.string().optional(),
    relPath: z.string().optional(),
    mime: z.string(),
    fileName: z.string(),
    size: z.number(),
    mtime: z.number().optional(),
    poster: z.string().optional(),
    missing: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('sequence'),
    base: z.string(),
    dir: z.string().optional(),
    relDir: z.string().optional(),
    pattern: z.string(),
    frameCount: z.number().int().min(1),
    fps: z.number().positive(),
    poster: z.string().optional(),
    missing: z.boolean().optional(),
  }),
])

const assetCue = z.object({
  at: z.number().min(0),
  kind: z.string().min(1),
  label: z.string(),
  seconds: z.number().positive().optional(),
  who: z.string().optional(),
  data: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
})

const asset = z.object({
  id,
  name: z.string().min(1),
  kind: z.enum(['video', 'image', 'audio']),
  duration: z.number().positive().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  fps: z.number().optional(),
  hasAudio: z.boolean().optional(),
  source: assetSource,
  peaks: z.array(z.number()).optional(),
  alpha: z.boolean().optional(),
  generated: z.boolean().optional(),
  provenance: z.object({ integration: z.string(), tool: z.string(), prompt: z.string().optional(), params: z.record(z.string(), z.unknown()).optional() }).optional(),
  transcript: z.array(z.object({ start: z.number(), end: z.number(), text: z.string() })).optional(),
  favorite: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
  proxy: z.object({ path: z.string(), url: z.string(), width: z.number(), height: z.number() }).optional(),
  cues: z.array(assetCue).optional(),
  matteOf: z
    .object({ assetId: z.string(), subject: z.enum(['person', 'any']), from: z.number(), to: z.number(), box: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional() })
    .optional(),
  addedAt: z.number(),
})

// ─── Helpers ─────────────────────────────────────────────────────────────

interface Command<S extends z.ZodType> {
  description: string
  input: S
  title: (input: z.output<S>, project: Project) => string
  run: (draft: Project, input: z.output<S>) => unknown
}

const command = <S extends z.ZodType>(c: Command<S>) => c

const plural = (n: number, word: string) => (n === 1 ? word : `${n} ${word}s`)

function getClip(p: Project, clipId: string): Clip {
  const c = p.clips[clipId]
  if (!c) throw new CommandError(`Clip ${clipId} not found`)
  return c
}

function getTrack(p: Project, trackId: string) {
  const t = p.tracks.find((t) => t.id === trackId)
  if (!t) throw new CommandError(`Track ${trackId} not found`)
  return t
}

function assertEditable(p: Project, clip: Clip) {
  if (getTrack(p, clip.trackId).locked) throw new CommandError(`"${clip.name}" is on a locked track`)
}

const NO_CROP = { left: 0, right: 0, top: 0, bottom: 0, radius: 0 }

/** Timeline operations report problems as TimelineErrors; commands turn them into CommandErrors. */
function timeline<T>(fn: () => T): T {
  try {
    return fn()
  } catch (err) {
    if (err instanceof TimelineError) throw new CommandError(err.message)
    throw err
  }
}

const settingsInput = z.object({ width: z.number().int().min(16).max(8192), height: z.number().int().min(16).max(8192), fps: z.number().int().min(1).max(240), background: z.string() })

/** A stored timeline, or the open one — as plain data (never a draft). */
function plainSequence(p: Project, id: string): Sequence {
  if (id === openSequenceId(p)) return openSequence(isDraft(p) ? current(p) : p)
  const seq = p.sequences?.[id]
  if (!seq) throw new CommandError(`Timeline ${id} not found`)
  return isDraft(seq) ? current(seq) : seq
}

function applyPatch(p: Project, clip: Clip, patch: ClipPatch) {
  const { transform, color, audio, text, animation, speed, crop, masks, angle, follow, stabilize, matte, ...flat } = patch
  Object.assign(clip, flat)
  if (matte === null) delete clip.matte
  else if (matte) {
    const m = p.assets[matte.assetId]
    if (!m?.matteOf) throw new CommandError('That isn’t a subject matte — make one with cut_out_subject')
    clip.matte = matte
  }
  if (angle !== undefined) {
    const seq = clip.sequenceId ? p.sequences?.[clip.sequenceId] : undefined
    if (!seq?.multicam) throw new CommandError(`“${clip.name}” isn’t a multicam clip`)
    if (!angleTracks(seq).some((t) => t.id === angle)) throw new CommandError(`Angle ${angle} isn’t a camera of “${seq.name}”`)
    clip.angle = angle
  }
  if (follow === null) delete clip.follow
  else if (follow) clip.follow = follow
  if (stabilize === null) delete clip.stabilize
  else if (stabilize) {
    const next = { ...clip.stabilize, ...stabilize }
    if (!next.path?.length || next.rate === undefined || next.start === undefined) throw new CommandError('Stabilize the clip first (it needs the measured camera path)')
    clip.stabilize = { smooth: 1, zoom: 1, rotation: true, ...next } as Clip['stabilize']
  }
  if (transform) Object.assign(clip.transform, transform)
  if (color) {
    const { curves: cv, wheels: wh, hsl: hs, lut, ...basic } = color
    Object.assign(clip.color, basic)
    if (cv === null) delete clip.color.curves
    else if (cv) clip.color.curves = { ...IDENTITY_CURVES, ...clip.color.curves, ...cv }
    if (wh === null) delete clip.color.wheels
    else if (wh) clip.color.wheels = { ...NEUTRAL_WHEELS, ...clip.color.wheels, ...wh }
    if (hs === null) delete clip.color.hsl
    else if (hs) clip.color.hsl = { ...clip.color.hsl, ...hs }
    if (lut === null) delete clip.color.lut
    else if (lut) {
      const next = { amount: 1, ...clip.color.lut, ...lut }
      if (!next.id || !p.luts?.[next.id]) throw new CommandError(`LUT ${next.id ?? ''} isn't in this project — import it first`)
      clip.color.lut = { id: next.id, amount: next.amount }
    }
  }
  if (masks === null) delete clip.masks
  else if (masks) clip.masks = masks
  if (audio) Object.assign(clip.audio, audio)
  if (text && clip.text) Object.assign(clip.text, text)
  if (animation?.in) Object.assign(clip.animation.in, animation.in)
  if (animation?.out) Object.assign(clip.animation.out, animation.out)
  if (crop === null) delete clip.crop
  else if (crop) {
    clip.crop = { ...NO_CROP, ...clip.crop, ...crop }
    if (Object.values(clip.crop).every((v) => !v)) delete clip.crop
  }
  if (speed !== undefined && (speed !== clip.speed || clip.keyframes.speed)) {
    // A constant speed replaces any ramp. The clip keeps the same footage, so it gets
    // longer or shorter — but never runs into its right-hand neighbour.
    const used = consumed(clip)
    delete clip.keyframes.speed
    let duration = Math.max(1, Math.round(used / speed))
    const next = clipsOnTrack(p, clip.trackId).find((c) => c.id !== clip.id && c.start >= clipEnd(clip))
    if (next && !isMagneticTrack(p, clip.trackId)) duration = Math.min(duration, next.start - clip.start)
    clip.speed = speed
    clip.duration = duration
  }
}

function setBase(clip: Clip, prop: AnimatableProp, value: number) {
  if (prop === 'volume') clip.audio.volume = value
  else if (prop === 'speed') clip.speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, value))
  else clip.transform[prop] = value
}

/** A speed ramp can eat footage faster: shorten the clip so it never runs past the end of its media. */
function fitToMedia(p: Project, clip: Clip) {
  const src = sourceFrames(p, clip)
  if (src === Infinity || clip.freeze) return
  const available = Math.max(1, src - clip.inPoint)
  if (consumed(clip) <= available + 0.5) return
  clip.duration = Math.max(1, Math.floor(localForConsumed(clip, available)))
  for (const prop of ANIMATABLE) {
    const kfs = clip.keyframes[prop]
    if (kfs) clip.keyframes[prop] = kfs.filter((k) => k.frame <= clip.duration)
  }
}

/** Copies attribute groups from one clip onto another, where they make sense for its kind. */
function copyAttributes(p: Project, from: Pick<Clip, 'kind'> & Partial<Clip>, to: Clip, include: readonly Attribute[]) {
  const visual = (c: Pick<Clip, 'kind'>) => c.kind !== 'audio'
  const media = (c: Pick<Clip, 'kind'>) => c.kind === 'video' || c.kind === 'audio'
  const keys = (props: AnimatableProp[]) => {
    for (const prop of props) {
      const kfs = from.keyframes?.[prop]
      if (kfs?.length) to.keyframes[prop] = kfs.filter((k) => k.frame <= to.duration).map((k) => ({ ...k }))
      else delete to.keyframes[prop]
    }
  }
  for (const attr of include) {
    switch (attr) {
      case 'transform':
        if (!visual(to) || !visual(from) || !from.transform) break
        Object.assign(to.transform, from.transform)
        keys(['x', 'y', 'scale', 'rotation', 'opacity', 'rotateX', 'rotateY', 'z'])
        break
      case 'crop':
        if (!visual(to) || to.kind === 'text' || to.kind === 'adjustment') break
        if (from.crop) to.crop = { ...from.crop }
        else delete to.crop
        break
      case 'color':
        if (!visual(to) || to.kind === 'text' || !from.color) break
        to.color = structuredClone(from.color)
        to.look = from.look ?? null
        break
      case 'effects':
        if (!visual(to) || !from.effects) break
        to.effects = from.effects.map((e) => ({ ...e, id: uid('fx') }))
        break
      case 'audio':
        if (!media(to) || !media(from) || !from.audio) break
        Object.assign(to.audio, { ...from.audio, detached: to.audio.detached })
        keys(['volume'])
        break
      case 'speed':
        if (!media(to) || !media(from) || from.speed === undefined) break
        to.speed = from.speed
        to.reverse = Boolean(from.reverse)
        keys(['speed'])
        fitToMedia(p, to)
        break
      case 'animation':
        if (!visual(to) || !from.animation) break
        to.animation = structuredClone(from.animation)
        break
      case 'text':
        if (to.kind !== 'text' || !to.text || !from.text) break
        to.text = { ...from.text, content: to.text.content }
        break
      case 'blend':
        if (visual(to) && from.blend) to.blend = from.blend
        break
    }
  }
}

// ─── Commands ────────────────────────────────────────────────────────────

export const commands = {
  // Clips
  'clip.add': command({
    description:
      'Add a clip to a track. Media clips (video/image/audio) reference an asset; text clips take a text style via patch.text; adjustment clips grade everything beneath them. By default an overlapping position slides to the nearest free spot; mode "overwrite" covers what is there, "insert" pushes it later. Returns the new clip id.',
    input: z.object({
      id: id.optional(),
      trackId: id,
      kind: clipKind,
      start: frame,
      duration: length,
      assetId: id.optional(),
      /** Play another timeline (nesting) instead of media — video clips show its picture and sound, audio clips its sound. */
      sequenceId: id.optional(),
      inPoint: frame.optional(),
      name: z.string().optional(),
      patch: clipPatch.optional(),
      mode: editMode.default('free'),
    }),
    title: (i) =>
      i.sequenceId ? 'Add nested timeline' : i.kind === 'text' ? 'Add title' : i.kind === 'adjustment' ? 'Add adjustment layer' : i.mode === 'insert' ? 'Insert clip' : i.mode === 'overwrite' ? 'Overwrite clip' : 'Add clip',
    run(p, i) {
      const track = getTrack(p, i.trackId)
      if (!trackAccepts(track, i.kind)) throw new CommandError(`A ${i.kind} clip can't go on an ${track.kind} track`)
      const source = i.assetId ? p.assets[i.assetId] : undefined
      if (i.assetId && !source) throw new CommandError(`Asset ${i.assetId} not found`)
      let nestedName: string | undefined
      if (i.sequenceId) {
        if (i.kind !== 'video' && i.kind !== 'audio') throw new CommandError('A nested timeline plays as a video or audio clip')
        const seq = p.sequences?.[i.sequenceId]
        if (!seq) throw new CommandError(i.sequenceId === openSequenceId(p) ? 'A timeline can’t contain itself' : `Timeline ${i.sequenceId} not found`)
        if (wouldLoop(p, openSequenceId(p), i.sequenceId)) throw new CommandError(`“${seq.name}” already contains this timeline — nesting it here would make a loop`)
        nestedName = seq.name
      }
      const inPoint = i.inPoint ?? 0
      const available = i.sequenceId ? sourceFrames(p, { sequenceId: i.sequenceId }) - inPoint : source?.duration !== undefined ? framesIn(source.duration, p.settings.fps) - inPoint : Infinity
      const duration = Math.max(1, Math.min(i.duration, available))
      let start: number
      if (i.mode === 'free' || isMagneticTrack(p, track.id)) start = findFreeStart(p, track.id, i.start, duration)
      else {
        if (i.mode === 'overwrite') overwriteRange(p, track.id, i.start, i.start + duration)
        else insertGap(p, track.id, i.start, duration)
        start = i.start
      }
      const clip = createClip({
        id: i.id ?? uid('clip'),
        kind: i.kind,
        trackId: track.id,
        start,
        duration,
        assetId: i.assetId,
        inPoint,
        name: i.name ?? source?.name ?? nestedName,
        ...(i.sequenceId ? { sequenceId: i.sequenceId } : {}),
      })
      if (i.sequenceId && p.sequences?.[i.sequenceId]?.multicam) clip.angle = angleTracks(p.sequences[i.sequenceId])[0]?.id
      if (i.patch) applyPatch(p, clip, i.patch)
      p.clips[clip.id] = clip
      return clip.id
    },
  }),

  'clip.move': command({
    description:
      'Move one or more clips to new start frames and optionally other tracks. Moves are applied as a group. By default, if they would overlap other clips the group slides to the nearest place that fits; mode "overwrite" lands them exactly and covers what is there, "insert" lands them exactly and pushes what is there later.',
    input: z.object({
      moves: z.array(z.object({ id, start: frame, trackId: id.optional() })).min(1),
      mode: editMode.default('free'),
    }),
    title: (i, p) =>
      i.mode === 'insert'
        ? `Insert ${plural(i.moves.length, 'clip')}`
        : i.mode === 'overwrite'
          ? `Overwrite with ${plural(i.moves.length, 'clip')}`
          : i.moves.every((m) => isMagneticTrack(p, m.trackId ?? p.clips[m.id]?.trackId ?? ''))
            ? 'Reorder clips'
            : `Move ${plural(i.moves.length, 'clip')}`,
    run(p, i) {
      const moving = i.moves.map((m) => {
        const clip = getClip(p, m.id)
        assertEditable(p, clip)
        const track = getTrack(p, m.trackId ?? clip.trackId)
        if (!trackAccepts(track, clip.kind)) throw new CommandError(`"${clip.name}" can't go on ${track.name}`)
        if (track.locked) throw new CommandError(`${track.name} is locked`)
        return { id: clip.id, start: m.start, duration: clip.duration, trackId: track.id }
      })
      let delta = 0
      if (i.mode === 'free') delta = resolveMoveDelta(p, moving, 0)
      else {
        // Land exactly: make room on each (non-magnetic) target track first.
        const exclude = new Set(moving.map((m) => m.id))
        const byTrack = new Map<string, typeof moving>()
        for (const m of moving) byTrack.set(m.trackId, [...(byTrack.get(m.trackId) ?? []), m])
        for (const [trackId, ms] of byTrack) {
          if (isMagneticTrack(p, trackId)) continue
          if (i.mode === 'overwrite') for (const m of ms) overwriteRange(p, trackId, m.start, m.start + m.duration, exclude)
          else {
            const a = Math.min(...ms.map((m) => m.start))
            insertGap(p, trackId, a, Math.max(...ms.map((m) => m.start + m.duration)) - a, exclude)
          }
        }
      }
      for (const m of moving) {
        const clip = p.clips[m.id]
        // On magnetic tracks a start means "insert here" — nudge so it sorts before a clip starting on the same frame.
        clip.start = m.start + delta - (isMagneticTrack(p, m.trackId) ? 0.5 : 0)
        clip.trackId = m.trackId
      }
    },
  }),

  'clip.trim': command({
    description:
      'Trim a clip by moving its start or end edge to an absolute timeline frame. Respects the source media length and neighbouring clips. With ripple, the clips after it on its track move by the same amount, so no gap opens (trimming the start with ripple keeps the clip in place and takes frames off its head).',
    input: z.object({ id, edge: z.enum(['start', 'end']), frame, ripple: z.boolean().default(false) }),
    title: (i) => `${i.ripple ? 'Ripple trim' : 'Trim'} ${i.edge}`,
    run(p, i) {
      const clip = getClip(p, i.id)
      assertEditable(p, clip)
      if (i.ripple && !isMagneticTrack(p, clip.trackId)) rippleTrimClip(p, clip, i.edge, i.frame)
      else trimClip(p, clip, i.edge, i.frame)
    },
  }),

  'clip.roll': command({
    description: 'Roll edit: move the cut between a clip and the clip touching it on the left to a new frame — one gets longer, the other shorter, nothing else moves. Pass the right-hand clip. Returns the frame the cut landed on.',
    input: z.object({ id, frame }),
    title: () => 'Roll edit',
    run(p, i) {
      const clip = getClip(p, i.id)
      assertEditable(p, clip)
      try {
        return rollEdit(p, clip, i.frame)
      } catch (err) {
        throw new CommandError((err as Error).message)
      }
    },
  }),

  'clip.slip': command({
    description: 'Slip a clip: show an earlier (negative) or later (positive) part of its footage, by `frames` source frames, without moving or resizing it. Returns the frames actually slipped.',
    input: z.object({ id, frames: z.number().int() }),
    title: () => 'Slip',
    run(p, i) {
      const clip = getClip(p, i.id)
      assertEditable(p, clip)
      return slipClip(p, clip, i.frames)
    },
  }),

  'clip.slide': command({
    description: 'Slide a clip along its track by `frames` (negative = earlier): the clips touching it either side give and take frames so no gap opens. Returns the frames actually slid.',
    input: z.object({ id, frames: z.number().int() }),
    title: () => 'Slide',
    run(p, i) {
      const clip = getClip(p, i.id)
      assertEditable(p, clip)
      return slideClip(p, clip, i.frames)
    },
  }),

  'clip.split': command({
    description:
      'Split clips at a timeline frame. With ids, splits only those clips; otherwise splits every clip under the frame on unlocked tracks. Returns the ids of the new right-hand clips.',
    input: z.object({ frame, ids: z.array(id).optional() }),
    title: () => 'Split',
    run(p, i) {
      const targets = clipsAt(p, i.frame, i.ids)
      if (!targets.length) throw new CommandError('Nothing to split at the playhead')
      return splitClips(p, targets, i.frame).map((c) => c.id)
    },
  }),

  'clip.delete': command({
    description: 'Delete clips. With ripple, later clips on the same track shift left to close the gap.',
    input: z.object({ ids: z.array(id).min(1), ripple: z.boolean().default(false) }),
    title: (i) => `${i.ripple ? 'Ripple delete' : 'Delete'} ${plural(i.ids.length, 'clip')}`,
    run(p, i) {
      i.ids.forEach((clipId) => assertEditable(p, getClip(p, clipId)))
      deleteClips(p, i.ids, i.ripple)
    },
  }),

  'timeline.removeRange': command({
    description:
      'Take a stretch of time out of the whole timeline (like Extract): clips inside it are removed, clips across it lose that stretch, and everything later — on every unlocked track, plus markers — moves left to close up. Clips listed in keepWhole (music beds, ambience) are not cut: they keep playing through the join and end earlier.',
    input: z.object({ start: frame, end: frame, keepWhole: z.array(id).default([]) }).refine((i) => i.end > i.start, 'end must be after start'),
    title: () => 'Remove range',
    run(p, i) {
      removeRange(p, i.start, i.end, new Set(i.keepWhole))
    },
  }),

  'clip.update': command({
    description:
      'Update clip properties: name, speed, reverse, blend mode, transform (x, y, scale, rotation, opacity), color grade, audio mix, text style, in/out animations or look. Applies the same patch to every id.',
    input: z.object({ ids: z.array(id).min(1), patch: clipPatch }),
    title: (i) => {
      const keys = Object.keys(i.patch)
      const what = keys.length === 1 ? keys[0] : 'properties'
      return i.ids.length > 1 ? `Edit ${what} on ${i.ids.length} clips` : `Edit ${what}`
    },
    run(p, i) {
      for (const clipId of i.ids) {
        const clip = getClip(p, clipId)
        assertEditable(p, clip)
        applyPatch(p, clip, i.patch)
      }
    },
  }),

  'clip.duplicate': command({
    description: 'Duplicate clips; each copy is placed right after its original on the same track. Returns the new ids.',
    input: z.object({ ids: z.array(id).min(1) }),
    title: (i) => `Duplicate ${plural(i.ids.length, 'clip')}`,
    run(p, i) {
      // Copies of grouped clips are grouped with each other, not with the originals.
      const groups = new Map<string, string>()
      const ids = i.ids.map((clipId) => {
        const original = getClip(p, clipId)
        const copy = cloneClip(original)
        copy.id = uid('clip')
        copy.start = findFreeStart(p, original.trackId, clipEnd(original), original.duration)
        if (copy.groupId) {
          if (!groups.has(copy.groupId)) groups.set(copy.groupId, uid('grp'))
          copy.groupId = groups.get(copy.groupId)
        }
        p.clips[copy.id] = copy
        return copy.id
      })
      dropLoneGroups(p, groups.values())
      return ids
    },
  }),

  'clip.setTransition': command({
    description:
      'Set or clear the transition on the cut before this clip (from the previous clip into this one). align says where it sits on the cut: "after" (default) starts at the cut, over the start of this clip; "center" straddles the cut; "before" ends at the cut, over the end of the previous clip. Durations are in frames.',
    input: z.object({ id, transition: transition.nullable() }),
    title: (i) => (i.transition ? 'Add transition' : 'Remove transition'),
    run(p, i) {
      const clip = getClip(p, i.id)
      assertEditable(p, clip)
      if (!i.transition) return void (clip.transitionIn = null)
      const { align, ...rest } = i.transition
      const duration = Math.max(1, Math.min(rest.duration, maxTransition(p, clip, align)))
      clip.transitionIn = { ...rest, duration, ...(align && align !== 'after' ? { align } : {}) }
    },
  }),

  'clip.paste': command({
    description:
      'Paste clips (whole clips as get_clip returns them, or copies) so the earliest lands at frame `at`; their spacing and tracks are kept (or all go on `trackId` when it fits). By default they slide to the nearest free spot; mode "overwrite" covers what is there, "insert" pushes it later. Returns the new ids.',
    input: z.object({ clips: z.array(clipSnapshot).min(1), at: frame, trackId: id.optional(), mode: editMode.default('free') }),
    title: (i) => `Paste ${plural(i.clips.length, 'clip')}`,
    run(p, i) {
      const first = Math.min(...i.clips.map((c) => c.start))
      const usable = (trackId: string | undefined, kind: Clip['kind']) => {
        const t = p.tracks.find((x) => x.id === trackId)
        return t && !t.locked && trackAccepts(t, kind) ? t : undefined
      }
      const placed = i.clips.map((c) => {
        const track = usable(i.trackId, c.kind) ?? usable(c.trackId, c.kind) ?? p.tracks.find((t) => !t.locked && trackAccepts(t, c.kind))
        if (!track) throw new CommandError(`There's no unlocked ${c.kind === 'audio' ? 'audio' : 'video'} track to paste “${c.name}” on`)
        return { snap: c, id: uid('clip'), trackId: track.id, start: i.at + (c.start - first), duration: c.duration }
      })
      let delta = 0
      if (i.mode === 'free') delta = resolveMoveDelta(p, placed, 0)
      else
        for (const m of placed) {
          if (isMagneticTrack(p, m.trackId)) continue
          if (i.mode === 'overwrite') overwriteRange(p, m.trackId, m.start, m.start + m.duration)
          else insertGap(p, m.trackId, m.start, m.duration)
        }
      // Pasted groups stay grouped with each other — not with the originals.
      const groups = new Map<string, string>()
      const ids = placed.map((m) => {
        const clip = structuredClone(m.snap) as Clip
        clip.id = m.id
        clip.trackId = m.trackId
        clip.start = m.start + delta - (isMagneticTrack(p, m.trackId) ? 0.5 : 0)
        clip.effects = clip.effects.map((e) => ({ ...e, id: uid('fx') }))
        if (clip.assetId && !p.assets[clip.assetId]) throw new CommandError(`The media of “${clip.name}” isn't in this project`)
        if (clip.sequenceId) {
          if (!p.sequences?.[clip.sequenceId]) throw new CommandError(clip.sequenceId === openSequenceId(p) ? `“${clip.name}” plays this timeline — it can't go inside itself` : `The timeline “${clip.name}” plays isn't in this project`)
          if (wouldLoop(p, openSequenceId(p), clip.sequenceId)) throw new CommandError(`“${clip.name}” already contains this timeline — pasting it here would make a loop`)
        }
        if (clip.groupId) {
          if (!groups.has(clip.groupId)) groups.set(clip.groupId, uid('grp'))
          clip.groupId = groups.get(clip.groupId)
        }
        p.clips[clip.id] = clip
        return clip.id
      })
      dropLoneGroups(p, groups.values())
      return ids
    },
  }),

  'clip.copyAttributes': command({
    description:
      'Paste attributes: copy chosen properties from one clip (fromId, or a whole clip in `from`) onto others — transform (with its keyframes), crop, color, effects, audio mix, speed, animation, text style or blend mode. Properties that don’t fit a clip’s kind are skipped.',
    input: z
      .object({ fromId: id.optional(), from: clipSnapshot.optional(), ids: z.array(id).min(1), include: z.array(attribute).min(1) })
      .refine((i) => i.fromId || i.from, 'Give fromId or from'),
    title: (i) => `Paste ${i.include.length === 1 ? i.include[0] : 'attributes'}`,
    run(p, i) {
      // A copy, so pasting onto the source clip's own group can't feed back into it.
      const source = cloneClip(i.fromId ? getClip(p, i.fromId) : (i.from as Clip))
      for (const clipId of i.ids) {
        if (clipId === i.fromId) continue
        const clip = getClip(p, clipId)
        assertEditable(p, clip)
        copyAttributes(p, source, clip, i.include)
      }
    },
  }),

  'clip.detachAudio': command({
    description: 'Split the sound of video clips onto their own audio clips (on a free audio track), linked to the picture: they move together, and each can be trimmed on its own for J- and L-cuts. Returns the new audio clip ids.',
    input: z.object({ ids: z.array(id).min(1) }),
    title: (i) => (i.ids.length > 1 ? 'Detach audio from clips' : 'Detach audio'),
    run(p, i) {
      return i.ids.map((clipId) => {
        const clip = getClip(p, clipId)
        assertEditable(p, clip)
        try {
          return detachAudio(p, clip).id
        } catch (err) {
          throw new CommandError((err as Error).message)
        }
      })
    },
  }),

  'clip.reattachAudio': command({
    description: 'Put detached sound back into its video clips: the linked audio clips are removed and each video plays its own sound again, keeping the audio clip’s volume and fades.',
    input: z.object({ ids: z.array(id).min(1) }),
    title: () => 'Reattach audio',
    run(p, i) {
      for (const clipId of i.ids) {
        const clip = getClip(p, clipId)
        assertEditable(p, clip)
        if (!clip.audio.detached) throw new CommandError(`“${clip.name}” still has its own sound`)
        reattachAudio(p, clip)
      }
    },
  }),

  'clip.group': command({
    description: 'Group clips so they select and move together (grouping a clip that is already grouped merges the groups). Returns the group id.',
    input: z.object({ ids: z.array(id).min(2) }),
    title: () => 'Group clips',
    run(p, i) {
      i.ids.forEach((clipId) => getClip(p, clipId))
      return groupClips(p, i.ids)
    },
  }),

  'clip.ungroup': command({
    description: 'Ungroup clips (and unlink detached sound from its picture): every clip in their groups becomes independent.',
    input: z.object({ ids: z.array(id).min(1) }),
    title: () => 'Ungroup clips',
    run(p, i) {
      i.ids.forEach((clipId) => getClip(p, clipId))
      ungroupClips(p, i.ids)
    },
  }),

  'clip.freeze': command({
    description: 'Freeze frame: hold the picture a clip shows at timeline `frame` for `duration` frames. The clip is cut there and the still goes in between, pushing the rest of the track later. Returns the freeze clip id.',
    input: z.object({ id, frame, duration: length }),
    title: () => 'Freeze frame',
    run(p, i) {
      const clip = getClip(p, i.id)
      assertEditable(p, clip)
      if (clip.kind !== 'video') throw new CommandError('Freeze frames are made from video clips')
      if (i.frame < clip.start || i.frame >= clipEnd(clip)) throw new CommandError(`Frame ${i.frame} isn't inside “${clip.name}”`)
      return freezeFrame(p, clip, i.frame, i.duration).id
    },
  }),

  'clip.setSpeedRamp': command({
    description:
      'Speed ramp: make a video or audio clip change speed smoothly over its length. `points` give the speed (0.1–16×) at positions `at` from 0 (start) to 1 (end); null removes the ramp (the clip plays at its average speed). The clip keeps the same footage, so it gets longer or shorter — but never runs into the clip after it.',
    input: z.object({
      id,
      points: z
        .array(z.object({ at: z.number().min(0).max(1), speed: z.number().min(MIN_SPEED).max(MAX_SPEED), easing: easing.optional() }))
        .min(2)
        .nullable(),
    }),
    title: (i) => (i.points ? 'Speed ramp' : 'Remove speed ramp'),
    run(p, i) {
      const clip = getClip(p, i.id)
      assertEditable(p, clip)
      if (clip.kind !== 'video' && clip.kind !== 'audio') throw new CommandError('Only video and audio clips have a speed')
      if (clip.freeze) throw new CommandError('A freeze frame has no speed to ramp')
      if (!i.points) {
        if (!clip.keyframes.speed) return
        applyPatch(p, clip, { speed: Math.round(averageSpeed(clip) * 100) / 100 })
        return
      }
      const used = consumed(clip)
      const points = [...i.points].sort((a, b) => a.at - b.at)
      // The ramp's average speed decides the length that plays the same footage.
      const shape = points.map((pt) => ({ frame: pt.at * 1000, value: pt.speed, easing: pt.easing ?? ('ease' as const) }))
      let sum = 0
      for (let k = 0; k <= 1000; k++) sum += Math.min(MAX_SPEED, Math.max(MIN_SPEED, evalKeyframes(shape, k)))
      let duration = Math.max(2, Math.round(used / (sum / 1001)))
      const next = clipsOnTrack(p, clip.trackId).find((c) => c.id !== clip.id && c.start >= clipEnd(clip))
      if (next && !isMagneticTrack(p, clip.trackId)) duration = Math.max(2, Math.min(duration, next.start - clip.start))
      clip.duration = duration
      clip.keyframes.speed = points
        .map((pt) => ({ frame: Math.round(pt.at * duration), value: pt.speed, easing: pt.easing ?? ('ease' as const) }))
        .filter((k, n, all) => n === 0 || k.frame !== all[n - 1].frame)
      clip.speed = points[0].speed
      fitToMedia(p, clip)
    },
  }),

  // Effects
  'effect.add': command({
    description:
      'Add an effect to clips (or update it if already present). Amount is 0–100. Keys make part of the picture transparent: chromaKey takes params { color: "#00ff00" (the screen colour), tolerance, softness, spill } and lumaKey takes { threshold, softness, invert: 0 keys out the dark, 1 the bright }, all 0–100.',
    input: z.object({ ids: z.array(id).min(1), kind: effectKind, amount: z.number().min(0).max(100).optional(), params: effectParams.optional() }),
    title: (i) => `Add ${EFFECTS.find((e) => e.kind === i.kind)?.name ?? 'effect'}`,
    run(p, i) {
      const preset = EFFECTS.find((e) => e.kind === i.kind)!
      for (const clipId of i.ids) {
        const clip = getClip(p, clipId)
        assertEditable(p, clip)
        const existing = clip.effects.find((e) => e.kind === i.kind)
        if (existing) {
          existing.amount = i.amount ?? existing.amount
          if (i.params) existing.params = { ...existing.params, ...i.params }
        } else {
          const params = preset.params || i.params ? { ...preset.params, ...i.params } : undefined
          clip.effects.push({ id: uid('fx'), kind: i.kind, enabled: true, amount: i.amount ?? preset.amount, ...(params ? { params } : {}) })
        }
      }
    },
  }),

  'effect.update': command({
    description: 'Turn an effect on or off, change its amount (0–100) or its params (merged). Effect ids are in get_clip → effects.',
    input: z.object({
      clipId: id,
      effectId: id,
      patch: z.object({ enabled: z.boolean(), amount: z.number().min(0).max(100), params: effectParams }).partial(),
    }),
    title: () => 'Edit effect',
    run(p, i) {
      const clip = getClip(p, i.clipId)
      const fx = clip.effects.find((e) => e.id === i.effectId)
      if (!fx) throw new CommandError('Effect not found')
      const { params, ...rest } = i.patch
      Object.assign(fx, rest)
      if (params) fx.params = { ...fx.params, ...params }
    },
  }),

  'effect.remove': command({
    description: 'Remove an effect from a clip. Effect ids are in get_clip → effects.',
    input: z.object({ clipId: id, effectId: id }),
    title: () => 'Remove effect',
    run(p, i) {
      const clip = getClip(p, i.clipId)
      if (!clip.effects.some((e) => e.id === i.effectId)) throw new CommandError(`"${clip.name}" has no effect ${i.effectId}`)
      clip.effects = clip.effects.filter((e) => e.id !== i.effectId)
    },
  }),

  // Masks
  'mask.add': command({
    description:
      'Add a shape mask to a clip: only the part inside the shape shows (invert: only the part outside). On an adjustment layer, the grade applies only there. Position and size are fractions of the frame (x, y = center); feather is a fraction of the frame. Returns the mask id.',
    input: z.object({ clipId: id, mask: mask.omit({ id: true }).partial() }),
    title: () => 'Add mask',
    run(p, i) {
      const clip = getClip(p, i.clipId)
      assertEditable(p, clip)
      if (clip.kind === 'audio') throw new CommandError('Audio clips have no picture to mask')
      const m = { id: uid('mask'), shape: 'ellipse' as const, x: 0.5, y: 0.5, width: 0.5, height: 0.5, rotation: 0, feather: 0.04, roundness: 0, invert: false, opacity: 1, ...i.mask }
      clip.masks = [...(clip.masks ?? []), m]
      return m.id
    },
  }),

  'mask.update': command({
    description: 'Change a mask: move, resize, rotate, feather, round, invert or fade it (mask ids are in get_clip → masks).',
    input: z.object({ clipId: id, maskId: id, patch: maskPatch }),
    title: () => 'Edit mask',
    run(p, i) {
      const clip = getClip(p, i.clipId)
      assertEditable(p, clip)
      const m = clip.masks?.find((x) => x.id === i.maskId)
      if (!m) throw new CommandError(`“${clip.name}” has no mask ${i.maskId}`)
      const { follow, ...rest } = i.patch
      Object.assign(m, rest)
      if (follow === null) delete m.follow
      else if (follow) m.follow = follow
    },
  }),

  'mask.remove': command({
    description: 'Remove a mask from a clip.',
    input: z.object({ clipId: id, maskId: id }),
    title: () => 'Remove mask',
    run(p, i) {
      const clip = getClip(p, i.clipId)
      if (!clip.masks?.some((m) => m.id === i.maskId)) throw new CommandError(`“${clip.name}” has no mask ${i.maskId}`)
      clip.masks = clip.masks.filter((m) => m.id !== i.maskId)
      if (!clip.masks.length) delete clip.masks
    },
  }),

  // Keyframes
  'keyframe.set': command({
    description:
      'Set a keyframe on an animatable property (x, y, scale, rotation, opacity, volume, rotateX, rotateY, z — or speed, for a speed ramp) at a frame relative to the clip start.',
    input: z.object({ clipId: id, prop: animatable, frame, value: z.number(), easing: easing.optional() }),
    title: (i) => `Keyframe ${i.prop}`,
    run(p, i) {
      const clip = getClip(p, i.clipId)
      assertEditable(p, clip)
      const speed = i.prop === 'speed'
      if (speed && clip.kind !== 'video' && clip.kind !== 'audio') throw new CommandError('Only video and audio clips have a speed')
      const value = speed ? Math.min(MAX_SPEED, Math.max(MIN_SPEED, i.value)) : i.value
      const kfs = (clip.keyframes[i.prop] ??= [])
      const existing = kfs.find((k) => k.frame === i.frame)
      if (existing) {
        existing.value = value
        if (i.easing) existing.easing = i.easing
      } else {
        kfs.push({ frame: i.frame, value, easing: i.easing ?? 'ease' })
        kfs.sort((a, b) => a.frame - b.frame)
      }
      if (speed) fitToMedia(p, clip)
    },
  }),

  'keyframe.remove': command({
    description: 'Remove the keyframe at a clip-relative frame.',
    input: z.object({ clipId: id, prop: animatable, frame }),
    title: (i) => `Remove ${i.prop} keyframe`,
    run(p, i) {
      const clip = getClip(p, i.clipId)
      const kfs = clip.keyframes[i.prop]
      if (!kfs) return
      const removed = kfs.find((k) => k.frame === i.frame)
      const rest = kfs.filter((k) => k.frame !== i.frame)
      if (rest.length) clip.keyframes[i.prop] = rest
      else {
        delete clip.keyframes[i.prop]
        if (removed) setBase(clip, i.prop, removed.value)
      }
      if (i.prop === 'speed') fitToMedia(p, clip)
    },
  }),

  'keyframe.clear': command({
    description: 'Remove all keyframes from a property, keeping its first value.',
    input: z.object({ clipId: id, prop: animatable }),
    title: (i) => `Clear ${i.prop} animation`,
    run(p, i) {
      const clip = getClip(p, i.clipId)
      const first = clip.keyframes[i.prop]?.[0]
      if (first) setBase(clip, i.prop, first.value)
      delete clip.keyframes[i.prop]
      if (i.prop === 'speed') fitToMedia(p, clip)
    },
  }),

  'keyframe.move': command({
    description: 'Move the keyframes at one clip-relative frame to another — of every animated property, or just `prop`. A keyframe already at the target is replaced.',
    input: z.object({ clipId: id, from: frame, to: frame, prop: animatable.optional() }),
    title: () => 'Move keyframe',
    run(p, i) {
      const clip = getClip(p, i.clipId)
      assertEditable(p, clip)
      if (i.to >= clip.duration) throw new CommandError('That’s past the end of the clip')
      if (i.from === i.to) return
      let moved = false
      for (const prop of i.prop ? [i.prop] : ANIMATABLE) {
        const kfs = clip.keyframes[prop]
        const k = kfs?.find((x) => x.frame === i.from)
        if (!kfs || !k) continue
        clip.keyframes[prop] = [...kfs.filter((x) => x !== k && x.frame !== i.to), { ...k, frame: i.to }].sort((a, b) => a.frame - b.frame)
        moved = true
        if (prop === 'speed') fitToMedia(p, clip)
      }
      if (!moved) throw new CommandError(`There’s no keyframe at frame ${i.from}`)
    },
  }),

  'clip.animate': command({
    description:
      'Animate a clip with a motion preset, baked into keyframes you can then edit. Camera moves over the clip (from `at`, for `duration` frames, default the whole clip): ken-burns, ken-burns-out, push-in, pull-out, pan-left, pan-right, tilt-up, tilt-down, drift. Entrances at the start: slide-in-left/right/up/down, pop-in, fade-in, zoom-in, drop-in, spin-in. Exits at the end: slide-out-left/right/up/down, pop-out, fade-out, zoom-out. Emphasis hitting at frame `at`: punch (a quick punch-in — land it on a beat), pulse, shake, wobble. Frames are clip-relative. intensity 0.1–3 scales the move (default 1); easing overrides the preset’s curve.',
    input: z.object({
      clipId: id,
      preset: z.enum(PRESET_IDS),
      at: frame.optional(),
      duration: z.number().int().min(1).optional(),
      intensity: z.number().min(0.1).max(3).optional(),
      easing: easing.optional(),
    }),
    title: (i) => `Animate: ${MOTION_PRESETS.find((p) => p.id === i.preset)?.name ?? i.preset}`,
    run(p, i) {
      const clip = getClip(p, i.clipId)
      assertEditable(p, clip)
      if (clip.kind === 'audio') throw new CommandError('Audio clips have no picture to animate')
      const snapshot = isDraft(clip) ? current(clip) : clip
      const { keys, range } = presetKeyframes(snapshot, i.preset, p.settings, { at: i.at, duration: i.duration, intensity: i.intensity, easing: i.easing })
      for (const [prop, list] of Object.entries(keys) as [AnimatableProp, NonNullable<(typeof keys)[AnimatableProp]>][]) {
        clip.keyframes[prop] = mergeKeyframes(clip.keyframes[prop], list, range)
      }
    },
  }),

  // Tracks
  'track.add': command({
    description: 'Add a video or audio track. Video tracks go on top by default, audio tracks at the bottom. Returns the id.',
    input: z.object({
      id: id.optional(),
      kind: z.enum(['video', 'audio']),
      name: z.string().optional(),
      index: z.number().int().min(0).optional(),
      role: z.enum(['main', 'titles', 'captions']).optional(),
    }),
    title: (i) => `Add ${i.kind} track`,
    run(p, i) {
      const count = p.tracks.filter((t) => t.kind === i.kind).length
      const track = createTrack(i.kind, {
        id: i.id ?? uid('track'),
        name: i.name ?? `${i.kind === 'video' ? 'Video' : 'Audio'} ${count + 1}`,
        height: i.role === 'captions' || i.role === 'titles' ? TRACK_HEIGHTS.titles : i.kind === 'video' ? TRACK_HEIGHTS.video : TRACK_HEIGHTS.audio,
        role: i.role,
      })
      const index = i.index ?? (i.kind === 'video' ? 0 : p.tracks.length)
      p.tracks.splice(Math.min(index, p.tracks.length), 0, track)
      return track.id
    },
  }),

  'track.update': command({
    description: 'Rename a track, toggle hidden / muted / locked / solo (while any track is soloed only soloed tracks are heard), or change its height.',
    input: z.object({
      id,
      patch: z
        .object({ name: z.string().min(1), hidden: z.boolean(), muted: z.boolean(), locked: z.boolean(), solo: z.boolean(), height: z.number().min(28).max(160) })
        .partial(),
    }),
    title: (i) => {
      const [key] = Object.keys(i.patch)
      const toggles: Record<string, [string, string]> = {
        hidden: ['Hide track', 'Show track'],
        locked: ['Lock track', 'Unlock track'],
        muted: ['Mute track', 'Unmute track'],
        solo: ['Solo track', 'Unsolo track'],
      }
      const pair = toggles[key]
      return pair ? pair[i.patch[key as keyof typeof i.patch] ? 0 : 1] : 'Edit track'
    },
    run(p, i) {
      const track = getTrack(p, i.id)
      Object.assign(track, i.patch)
      if (i.patch.solo === false) delete track.solo
    },
  }),

  'track.move': command({
    description: 'Move a track up or down the stack (index 0 is the top). Video tracks higher up draw over the ones below.',
    input: z.object({ id, index: z.number().int().min(0) }),
    title: () => 'Reorder tracks',
    run(p, i) {
      getTrack(p, i.id)
      moveTrack(p, i.id, i.index)
    },
  }),

  'track.remove': command({
    description: 'Remove a track and every clip on it (track ids are in get_project → tracks).',
    input: z.object({ id }),
    title: () => 'Remove track',
    run(p, i) {
      getTrack(p, i.id)
      for (const c of Object.values(p.clips)) if (c.trackId === i.id) delete p.clips[c.id]
      p.tracks = p.tracks.filter((t) => t.id !== i.id)
    },
  }),

  // Mixer
  'mix.update': command({
    description:
      'Mix a track (its id) or the master bus ("master"): fader volume in dB (-60 to +12), pan (-1 left to 1 right), and processing in this order — EQ (low cut Hz, low / mid / high shelves and bell in dB with their frequencies), compressor (threshold dB, ratio, attack and release ms, make-up dB) and limiter (ceiling dBFS). Pass null for a processor to remove it; fields you leave out keep their values.',
    input: z.object({ target: z.union([z.literal('master'), id]), patch: busPatch }),
    title: (i, p) => {
      const name = i.target === 'master' ? 'master' : (p.tracks.find((t) => t.id === i.target)?.name ?? 'track')
      const [key] = Object.keys(i.patch)
      const what = key === 'volume' ? 'volume' : key === 'pan' ? 'pan' : key === 'eq' ? 'EQ' : key === 'compressor' ? 'compressor' : key === 'limiter' ? 'limiter' : 'mix'
      return `${what === 'volume' || what === 'pan' ? `${what[0].toUpperCase()}${what.slice(1)}` : what === 'mix' ? 'Mix' : `Edit ${what}`} · ${name}`
    },
    run(p, i) {
      let bus: BusMix
      if (i.target === 'master') bus = p.master ??= { ...DEFAULT_BUS }
      else {
        const track = getTrack(p, i.target)
        bus = track.mix ??= { ...DEFAULT_BUS }
      }
      const { eq: e, compressor: c, limiter: l, ...levels } = i.patch
      Object.assign(bus, levels)
      if (e === null) delete bus.eq
      else if (e) bus.eq = { ...DEFAULT_EQ, ...bus.eq, ...e }
      if (c === null) delete bus.compressor
      else if (c) bus.compressor = { ...DEFAULT_COMPRESSOR, ...bus.compressor, ...c }
      if (l === null) delete bus.limiter
      else if (l) bus.limiter = { ...DEFAULT_LIMITER, ...bus.limiter, ...l }
    },
  }),

  // In and out points
  'timeline.setRange': command({
    description:
      'Set the in and out points (frames, out exclusive) that mark a stretch of the timeline — it can loop in playback, export on its own, or be lifted or extracted. null clears them.',
    input: z.object({ range: z.object({ in: frame, out: frame }).refine((r) => r.out > r.in, 'out must be after in').nullable() }),
    title: (i) => (i.range ? 'Mark in and out' : 'Clear in and out'),
    run(p, i) {
      p.range = i.range
    },
  }),

  'timeline.liftRange': command({
    description: 'Lift a stretch of time: clear everything between two frames on every unlocked track and leave the gap (timeline_removeRange closes it up instead).',
    input: z.object({ start: frame, end: frame }).refine((i) => i.end > i.start, 'end must be after start'),
    title: () => 'Lift',
    run(p, i) {
      liftRange(p, i.start, i.end)
    },
  }),

  // Markers
  'marker.add': command({
    description: 'Drop a marker on the timeline ruler. Returns the id.',
    input: z.object({ id: id.optional(), frame, label: z.string().optional(), color: markerColor.optional() }),
    title: () => 'Add marker',
    run(p, i) {
      const marker = { id: i.id ?? uid('mk'), frame: i.frame, label: i.label ?? `Marker ${p.markers.length + 1}`, color: i.color ?? 'lime' }
      p.markers.push(marker)
      p.markers.sort((a, b) => a.frame - b.frame)
      return marker.id
    },
  }),

  'marker.update': command({
    description: 'Move, rename or recolor a marker (marker ids are in get_project → markers).',
    input: z.object({ id, patch: z.object({ frame, label: z.string(), color: markerColor }).partial() }),
    title: () => 'Edit marker',
    run(p, i) {
      const m = p.markers.find((m) => m.id === i.id)
      if (!m) throw new CommandError('Marker not found')
      Object.assign(m, i.patch)
      p.markers.sort((a, b) => a.frame - b.frame)
    },
  }),

  'marker.remove': command({
    description: 'Remove a marker (marker ids are in get_project → markers).',
    input: z.object({ id }),
    title: () => 'Remove marker',
    run(p, i) {
      if (!p.markers.some((m) => m.id === i.id)) throw new CommandError('Marker not found')
      p.markers = p.markers.filter((m) => m.id !== i.id)
    },
  }),

  // LUTs & fonts
  'lut.add': command({
    description:
      'Add a 3D LUT to the project (from a .cube file: `size` points per side and size³ RGB triples, red fastest, as 8-bit values in base64). Apply it with clip_update → color.lut. Returns the id.',
    input: z.object({ lut: z.object({ id: id.optional(), name: z.string().min(1), size: z.number().int().min(2).max(65), data: z.string().min(1) }) }),
    title: (i) => `Import LUT ${i.lut.name}`,
    run(p, i) {
      const lutId = i.lut.id ?? uid('lut')
      if (atob(i.lut.data).length !== i.lut.size ** 3 * 3) throw new CommandError(`A ${i.lut.size}-point LUT needs ${i.lut.size ** 3 * 3} bytes`)
      p.luts = { ...p.luts, [lutId]: { ...i.lut, id: lutId } }
      return lutId
    },
  }),

  'lut.remove': command({
    description: 'Remove a LUT from the project; clips using it lose it.',
    input: z.object({ id }),
    title: () => 'Remove LUT',
    run(p, i) {
      if (!p.luts?.[i.id]) throw new CommandError(`LUT ${i.id} not found`)
      delete p.luts[i.id]
      for (const c of Object.values(p.clips)) if (c.color.lut?.id === i.id) delete c.color.lut
    },
  }),

  'font.add': command({
    description: 'Embed a font file (base64) in the project so titles can use it as `custom:<id>`. Returns the id.',
    input: z.object({ font: z.object({ id: id.optional(), name: z.string().min(1), family: z.string().min(1), fileName: z.string(), data: z.string().min(1) }) }),
    title: (i) => `Add font ${i.font.name}`,
    run(p, i) {
      const fontId = i.font.id ?? uid('font')
      p.fonts = { ...p.fonts, [fontId]: { ...i.font, id: fontId } }
      return fontId
    },
  }),

  'font.remove': command({
    description: 'Remove a font from the project; titles using it go back to the default typeface.',
    input: z.object({ id }),
    title: () => 'Remove font',
    run(p, i) {
      if (!p.fonts?.[i.id]) throw new CommandError(`Font ${i.id} not found`)
      delete p.fonts[i.id]
      for (const c of Object.values(p.clips)) if (c.text?.font === `custom:${i.id}`) c.text.font = 'sans'
    },
  }),

  // Assets
  'asset.add': command({
    description: 'Register a media asset in the project library.',
    input: z.object({ asset }),
    title: (i) => `Import ${i.asset.name}`,
    run(p, i) {
      p.assets[i.asset.id] = i.asset
      return i.asset.id
    },
  }),

  'asset.update': command({
    description:
      'Rename or favorite an asset, attach its transcript (timed phrases in seconds) or its cues (what happens in it and when: { at, kind, label }), or point it at a new file (relink: source, duration, size, audio).',
    input: z.object({
      id,
      patch: z
        .object({
          name: z.string().min(1),
          favorite: z.boolean(),
          tags: z.array(z.string()),
          transcript: z.array(z.object({ start: z.number(), end: z.number(), text: z.string() })),
          peaks: z.array(z.number()),
          hasAudio: z.boolean(),
          duration: z.number().positive(),
          width: z.number(),
          height: z.number(),
          fps: z.number(),
          source: assetSource,
          proxy: z.object({ path: z.string(), url: z.string(), width: z.number(), height: z.number() }).nullable(),
          beats: z.object({ bpm: z.number(), times: z.array(z.number()), downbeats: z.array(z.number()), confidence: z.number() }),
          cues: z.array(assetCue),
        })
        .partial(),
    }),
    title: (i) => (i.patch.source ? 'Relink media' : i.patch.proxy === null ? 'Remove proxy' : 'Edit media'),
    run(p, i) {
      const a = p.assets[i.id]
      if (!a) throw new CommandError('Asset not found')
      const { proxy, ...rest } = i.patch
      Object.assign(a, rest)
      if (proxy === null) delete a.proxy
      else if (proxy) a.proxy = proxy
    },
  }),

  'asset.remove': command({
    description: 'Remove assets from the library, along with every clip that uses them.',
    input: z.object({ ids: z.array(id).min(1) }),
    title: (i) => `Remove ${plural(i.ids.length, 'media item')}`,
    run(p, i) {
      const ids = new Set(i.ids)
      // A media item's subject mattes go with it.
      for (const a of Object.values(p.assets)) if (a.matteOf && ids.has(a.matteOf.assetId)) ids.add(a.id)
      for (const c of Object.values(p.clips)) if (c.assetId && ids.has(c.assetId)) delete p.clips[c.id]
      // …and from the timelines that aren't open.
      for (const seq of Object.values(p.sequences ?? {})) for (const c of Object.values(seq.clips)) if (c.assetId && ids.has(c.assetId)) delete seq.clips[c.id]
      // Clips cut out with a removed matte show whole again.
      for (const c of Object.values(p.clips)) if (c.matte && ids.has(c.matte.assetId)) delete c.matte
      for (const seq of Object.values(p.sequences ?? {})) for (const c of Object.values(seq.clips)) if (c.matte && ids.has(c.matte.assetId)) delete c.matte
      for (const assetId of ids) delete p.assets[assetId]
    },
  }),

  // Timelines
  'sequence.create': command({
    description:
      'Make a new, empty timeline (sequence) — another cut, or another format of the same media such as a 9:16 version. Settings default to the open timeline’s. It opens unless open is false (sequence_open switches). Returns its id.',
    input: z.object({ id: id.optional(), name: z.string().min(1).optional(), settings: settingsInput.partial().optional(), open: z.boolean().default(true) }),
    title: (i) => `New timeline${i.name ? ` “${i.name}”` : ''}`,
    run(p, i) {
      if (i.id && getSequence(p, i.id)) throw new CommandError(`A timeline with id ${i.id} already exists`)
      const seq = blankSequence(i.name ?? freshName(p, 'Timeline'), { ...p.settings, ...i.settings }, i.id)
      p.sequences ??= {}
      p.sequences[seq.id] = seq
      if (i.open) swapIn(p, seq.id)
      return seq.id
    },
  }),

  'sequence.open': command({
    description: 'Switch the editor to another timeline (sequence ids are in get_project → timelines). Every other command then works on that timeline. Undo switches back.',
    input: z.object({ id }),
    title: (i, p) => `Open ${getSequence(p, i.id)?.name ?? 'timeline'}`,
    run(p, i) {
      if (i.id === openSequenceId(p)) return
      if (!p.sequences?.[i.id]) throw new CommandError(`Timeline ${i.id} not found`)
      swapIn(p, i.id)
    },
  }),

  'sequence.rename': command({
    description: 'Rename a timeline (sequence). Clips that play it keep their own names.',
    input: z.object({ id, name: z.string().min(1) }),
    title: () => 'Rename timeline',
    run(p, i) {
      if (i.id === openSequenceId(p)) p.sequence = { ...p.sequence, id: openSequenceId(p), name: i.name }
      else {
        const seq = p.sequences?.[i.id]
        if (!seq) throw new CommandError(`Timeline ${i.id} not found`)
        seq.name = i.name
      }
    },
  }),

  'sequence.duplicate': command({
    description: 'Copy a timeline (sequence) with everything on it — to try another cut without touching the first. Returns the copy’s id; it opens if open is true.',
    input: z.object({ id, name: z.string().min(1).optional(), open: z.boolean().default(false) }),
    title: () => 'Duplicate timeline',
    run(p, i) {
      const src = plainSequence(p, i.id)
      const copy = copySequence(src, i.name ?? freshName(p, `${src.name} copy`))
      p.sequences ??= {}
      p.sequences[copy.id] = copy
      if (i.open) swapIn(p, copy.id)
      return copy.id
    },
  }),

  'sequence.delete': command({
    description: 'Delete a timeline (sequence). Not the open one, and not one another timeline still plays (nested) — remove those clips first.',
    input: z.object({ id }),
    title: (i, p) => `Delete ${getSequence(p, i.id)?.name ?? 'timeline'}`,
    run(p, i) {
      if (i.id === openSequenceId(p)) throw new CommandError('That timeline is open — open another one first')
      const seq = p.sequences?.[i.id]
      if (!seq) throw new CommandError(`Timeline ${i.id} not found`)
      const uses = usesOf(p, i.id)
      if (uses.length) throw new CommandError(`“${seq.name}” is nested in ${uses.map((u) => `“${u.name}”`).join(', ')} — remove it there first`)
      delete p.sequences![i.id]
    },
  }),

  'clip.nest': command({
    description:
      'Nest clips: move them (and anything linked to them) into a new timeline, and put one clip playing that timeline where they were — then grade, transform, speed up or cut them as one piece. sequence_open the new timeline to edit inside it. Returns { clipId, sequenceId }.',
    input: z.object({ ids: z.array(id).min(1), name: z.string().min(1).optional() }),
    title: (i) => `Nest ${plural(i.ids.length, 'clip')}`,
    run(p, i) {
      return timeline(() => nestClips(p, i.ids, i.name))
    },
  }),

  'clip.unnest': command({
    description:
      'Break a nested clip apart: the part of its timeline it shows comes back onto this timeline in its place, on free tracks. The nested clip’s own transform, grade and effects are dropped; its timeline stays in the project. Returns the new clip ids.',
    input: z.object({ id }),
    title: () => 'Break apart nested clip',
    run(p, i) {
      const clip = getClip(p, i.id)
      assertEditable(p, clip)
      return timeline(() => unnestClip(p, i.id))
    },
  }),

  'multicam.create': command({
    description:
      'Make a multicam timeline from recordings of the same moment: one camera angle per video track, lined up by offsets in seconds (the sync_multicam tool measures them from the audio), with the sound of angle `audio` (the other angles’ sound is there, muted). Places a multicam clip on this timeline unless place is false; switch angles with multicam_switch. Returns { sequenceId, clipId }.',
    input: z.object({
      name: z.string().min(1).optional(),
      angles: z.array(z.object({ assetId: id, offset: z.number().min(-86400).max(86400), name: z.string().min(1).optional() })).min(2).max(16),
      audio: z.number().int().min(0).max(15).default(0),
      place: z.boolean().default(true),
      start: frame.optional(),
      trackId: id.optional(),
    }),
    title: () => 'Create multicam clip',
    run(p, i) {
      const fps = p.settings.fps
      const first = Math.min(...i.angles.map((a) => a.offset))
      const tracks: Track[] = []
      const clips: Record<string, Clip> = {}
      const soundTracks: Track[] = []
      i.angles.forEach((a, n) => {
        const asset = p.assets[a.assetId]
        if (!asset) throw new CommandError(`Asset ${a.assetId} not found`)
        if (asset.kind !== 'video') throw new CommandError(`“${asset.name}” isn’t video — every angle needs pictures`)
        const name = a.name ?? asset.name
        const start = Math.round((a.offset - first) * fps)
        const duration = Math.max(1, framesIn(asset.duration ?? 1, fps))
        const video = createTrack('video', { name: `Cam ${n + 1} · ${name}`, height: TRACK_HEIGHTS.video })
        tracks.push(video)
        const pic = createClip({ kind: 'video', trackId: video.id, start, duration, assetId: asset.id, name, audio: { detached: true } })
        clips[pic.id] = pic
        if (asset.hasAudio !== false) {
          const sound = createTrack('audio', { name: `Sound ${n + 1} · ${name}`, height: TRACK_HEIGHTS.audio, muted: n !== i.audio })
          soundTracks.push(sound)
          const clip = createClip({ kind: 'audio', trackId: sound.id, start, duration, assetId: asset.id, name })
          clips[clip.id] = clip
        }
      })
      const seq: Sequence = { id: uid('seq'), name: i.name ?? freshName(p, 'Multicam'), settings: { ...p.settings }, tracks: [...tracks, ...soundTracks], clips, markers: [], multicam: true, createdAt: Date.now() }
      p.sequences ??= {}
      p.sequences[seq.id] = seq
      if (!i.place) return { sequenceId: seq.id, clipId: null }
      const trackId = i.trackId ?? p.tracks.find((t) => t.role === 'main' && !t.locked)?.id ?? p.tracks.find((t) => t.kind === 'video' && !t.locked)?.id
      if (!trackId) throw new CommandError('No video track to put the multicam clip on')
      const track = getTrack(p, trackId)
      if (track.kind !== 'video') throw new CommandError('A multicam clip goes on a video track')
      const duration = Math.max(1, Math.max(...Object.values(clips).map(clipEnd)))
      const clip = createClip({ kind: 'video', trackId, start: findFreeStart(p, trackId, i.start ?? 0, duration), duration, name: seq.name, sequenceId: seq.id })
      clip.angle = tracks[0].id
      p.clips[clip.id] = clip
      return { sequenceId: seq.id, clipId: clip.id }
    },
  }),

  'multicam.switch': command({
    description:
      'Cut to another camera angle of a multicam clip at a frame: the clip is split there and the part after it shows angle `angle` (1 = the first camera). At the clip’s first frame the whole clip switches. clipId defaults to the multicam clip under the frame. Returns the id of the clip now showing that angle.',
    input: z.object({ frame, angle: z.number().int().min(1).max(16), clipId: id.optional() }),
    title: (i) => `Cut to angle ${i.angle}`,
    run(p, i) {
      const clip = i.clipId ? getClip(p, i.clipId) : multicamAt(p, i.frame)
      if (!clip) throw new CommandError('No multicam clip at that frame')
      const seq = clip.sequenceId ? p.sequences?.[clip.sequenceId] : undefined
      if (!seq?.multicam) throw new CommandError(`“${clip.name}” isn’t a multicam clip`)
      assertEditable(p, clip)
      const angle = angleTracks(seq)[i.angle - 1]
      if (!angle) throw new CommandError(`“${seq.name}” has ${angleTracks(seq).length} angles`)
      if (i.frame < clip.start || i.frame >= clipEnd(clip)) throw new CommandError('That frame isn’t inside the clip')
      const target = i.frame > clip.start ? (splitClips(p, [clip], i.frame)[0] ?? clip) : clip
      target.angle = angle.id
      return target.id
    },
  }),

  // Project
  'project.update': command({
    description:
      'Rename the project or change the open timeline’s settings (width, height, fps, background color). Changing fps re-times every clip so nothing drifts.',
    input: z.object({
      name: z.string().min(1).optional(),
      settings: settingsInput.partial().optional(),
    }),
    title: (i) => (i.name ? 'Rename project' : 'Project settings'),
    run(p, i) {
      if (i.name) p.name = i.name
      if (!i.settings) return
      const { fps, ...rest } = i.settings
      Object.assign(p.settings, rest)
      if (fps && fps !== p.settings.fps) {
        const r = fps / p.settings.fps
        const sc = (f: number) => Math.round(f * r)
        for (const c of Object.values(p.clips)) {
          c.start = sc(c.start)
          c.duration = Math.max(1, sc(c.duration))
          c.inPoint = sc(c.inPoint)
          c.audio.fadeIn = sc(c.audio.fadeIn)
          c.audio.fadeOut = sc(c.audio.fadeOut)
          c.animation.in.duration = Math.max(1, sc(c.animation.in.duration))
          c.animation.out.duration = Math.max(1, sc(c.animation.out.duration))
          if (c.transitionIn) c.transitionIn.duration = Math.max(2, sc(c.transitionIn.duration))
          for (const kfs of Object.values(c.keyframes)) kfs?.forEach((k) => (k.frame = sc(k.frame)))
        }
        for (const m of p.markers) m.frame = sc(m.frame)
        if (p.range) p.range = { in: sc(p.range.in), out: Math.max(sc(p.range.in) + 1, sc(p.range.out)) }
        p.settings.fps = fps
      }
    },
  }),
}

export type CommandName = keyof typeof commands

/** A clip at `frame` showing a multicam timeline (the topmost one). */
function multicamAt(p: Project, frame: number) {
  const order = new Map(p.tracks.map((t, i) => [t.id, i]))
  return clipsAt(p, frame)
    .filter((c) => c.sequenceId && p.sequences?.[c.sequenceId]?.multicam)
    .sort((a, b) => (order.get(a.trackId) ?? 0) - (order.get(b.trackId) ?? 0))[0]
}

export type CommandInput<N extends CommandName> = z.input<(typeof commands)[N]['input']>

export type AnyCommand = Command<z.ZodType>

/** MCP-ready tool definitions generated from the command registry. */
export function toolDefinitions() {
  return (Object.entries(commands) as [CommandName, AnyCommand][]).map(([name, c]) => ({
    name: name.replace('.', '_'),
    description: c.description,
    inputSchema: z.toJSONSchema(c.input),
  }))
}
