/**
 * The command layer — the single way the project changes.
 *
 * Every command has a Zod schema and a description. The UI dispatches them,
 * undo/redo records them, and the MCP server (phase 2) exposes the exact same
 * definitions as AI tools, so an agent can do anything a user can.
 */
import { z } from 'zod'
import { uid } from '@/lib/id'
import { createClip, createTrack, TRACK_HEIGHTS } from './defaults'
import { ANIMATABLE, evalKeyframes } from './keyframes'
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
  sourceFrames,
  splitClips,
  trackAccepts,
  trimClip,
  ungroupClips,
} from './ops'
import { averageSpeed, consumed, localForConsumed, MAX_SPEED, MIN_SPEED } from './timing'
import type { AnimatableProp, Clip, Project } from './types'

export class CommandError extends Error {}

// ─── Schemas ─────────────────────────────────────────────────────────────

const id = z.string().min(1)
const frame = z.number().int().min(0)
const length = z.number().int().min(1)

const clipKind = z.enum(['video', 'image', 'audio', 'text', 'adjustment'])
const blend = z.enum(['normal', 'screen', 'multiply', 'overlay', 'soft-light', 'lighten', 'darken', 'color-dodge', 'difference'])
const animPreset = z.enum(['none', 'fade', 'rise', 'drop', 'pop', 'zoom', 'blur', 'wipe', 'typewriter', 'spin3d', 'flip3d'])
const transitionKind = z.enum(['dissolve', 'dip', 'flash', 'slide', 'push', 'zoom', 'wipe', 'blur', 'cube', 'flip', 'door', 'swing', 'page', 'warp', 'shatter', 'spin'])
const effectKind = z.enum(['blur', 'glow', 'vignette', 'grain', 'mono', 'shake', 'pulse', 'leak', 'rgb', 'sharpen', 'tilt3d', 'curve3d', 'wave3d', 'cube3d', 'mirror3d'])
const fontId = z.enum(['sans', 'display', 'serif', 'mono', 'hand'])
const easing = z.enum(['linear', 'ease', 'ease-in', 'ease-out', 'hold'])
const animatable = z.enum(['x', 'y', 'scale', 'rotation', 'opacity', 'volume', 'rotateX', 'rotateY', 'z', 'speed'])
const markerColor = z.enum(['lime', 'violet', 'pink', 'amber', 'emerald', 'sky'])
const pct = z.number().min(-100).max(100)
/** How clips land where others already are: slide to the nearest gap, cover them, or push them later. */
const editMode = z.enum(['free', 'overwrite', 'insert'])
const attribute = z.enum(['transform', 'crop', 'color', 'effects', 'audio', 'speed', 'animation', 'text', 'blend'])

/** Values the schemas accept, for tools that list what's available. */
export const BLEND_MODES = blend.options
export const EASINGS = easing.options
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

const grade = z.object({
  exposure: pct,
  contrast: pct,
  saturation: pct,
  temperature: pct,
  tint: pct,
  vignette: z.number().min(0).max(100),
})

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

const textStyle = z.object({
  content: z.string(),
  font: fontId,
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
  extrude: z.number().min(0).max(2),
  material: z.enum(['chrome', 'gold', 'matte', 'neon']),
  bevel: z.boolean(),
})

const animSpec = z.object({ preset: animPreset, duration: z.number().int().min(1).max(600) })
const transition = z.object({ kind: transitionKind, duration: z.number().int().min(2).max(300) })

export const clipPatch = z
  .object({
    name: z.string().min(1),
    speed: z.number().min(MIN_SPEED).max(MAX_SPEED),
    reverse: z.boolean(),
    blend,
    look: z.string().nullable(),
    transform: transform.partial(),
    color: grade.partial(),
    audio: audioMix.partial(),
    text: textStyle.partial(),
    animation: z.object({ in: animSpec.partial(), out: animSpec.partial() }).partial(),
    crop: crop.partial().nullable(),
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
  groupId: z.string().optional(),
  freeze: z.boolean().optional(),
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

function applyPatch(p: Project, clip: Clip, patch: ClipPatch) {
  const { transform, color, audio, text, animation, speed, crop, ...flat } = patch
  Object.assign(clip, flat)
  if (transform) Object.assign(clip.transform, transform)
  if (color) Object.assign(clip.color, color)
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
      inPoint: frame.optional(),
      name: z.string().optional(),
      patch: clipPatch.optional(),
      mode: editMode.default('free'),
    }),
    title: (i) => (i.kind === 'text' ? 'Add title' : i.kind === 'adjustment' ? 'Add adjustment layer' : i.mode === 'insert' ? 'Insert clip' : i.mode === 'overwrite' ? 'Overwrite clip' : 'Add clip'),
    run(p, i) {
      const track = getTrack(p, i.trackId)
      if (!trackAccepts(track, i.kind)) throw new CommandError(`A ${i.kind} clip can't go on an ${track.kind} track`)
      const source = i.assetId ? p.assets[i.assetId] : undefined
      if (i.assetId && !source) throw new CommandError(`Asset ${i.assetId} not found`)
      const inPoint = i.inPoint ?? 0
      const available = source?.duration !== undefined ? Math.floor(source.duration * p.settings.fps) - inPoint : Infinity
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
        name: i.name ?? source?.name,
      })
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
    description: 'Set or clear the transition that plays from the previous clip into this one. Durations are in frames.',
    input: z.object({ id, transition: transition.nullable() }),
    title: (i) => (i.transition ? 'Add transition' : 'Remove transition'),
    run(p, i) {
      const clip = getClip(p, i.id)
      assertEditable(p, clip)
      clip.transitionIn = i.transition ? { ...i.transition, duration: Math.min(i.transition.duration, clip.duration) } : null
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
    description: 'Add an effect to clips (or update its amount if already present). Amount is 0–100.',
    input: z.object({ ids: z.array(id).min(1), kind: effectKind, amount: z.number().min(0).max(100).optional() }),
    title: (i) => `Add ${EFFECTS.find((e) => e.kind === i.kind)?.name ?? 'effect'}`,
    run(p, i) {
      const preset = EFFECTS.find((e) => e.kind === i.kind)!
      for (const clipId of i.ids) {
        const clip = getClip(p, clipId)
        assertEditable(p, clip)
        const existing = clip.effects.find((e) => e.kind === i.kind)
        if (existing) existing.amount = i.amount ?? existing.amount
        else clip.effects.push({ id: uid('fx'), kind: i.kind, enabled: true, amount: i.amount ?? preset.amount })
      }
    },
  }),

  'effect.update': command({
    description: 'Turn an effect on or off, or change its amount (0–100). Effect ids are in get_clip → effects.',
    input: z.object({
      clipId: id,
      effectId: id,
      patch: z.object({ enabled: z.boolean(), amount: z.number().min(0).max(100) }).partial(),
    }),
    title: () => 'Edit effect',
    run(p, i) {
      const clip = getClip(p, i.clipId)
      const fx = clip.effects.find((e) => e.id === i.effectId)
      if (!fx) throw new CommandError('Effect not found')
      Object.assign(fx, i.patch)
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
      'Rename or favorite an asset, attach its transcript (timed phrases in seconds), or point it at a new file (relink: source, duration, size, audio).',
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
        })
        .partial(),
    }),
    title: (i) => (i.patch.source ? 'Relink media' : 'Edit media'),
    run(p, i) {
      const a = p.assets[i.id]
      if (!a) throw new CommandError('Asset not found')
      Object.assign(a, i.patch)
    },
  }),

  'asset.remove': command({
    description: 'Remove assets from the library, along with every clip that uses them.',
    input: z.object({ ids: z.array(id).min(1) }),
    title: (i) => `Remove ${plural(i.ids.length, 'media item')}`,
    run(p, i) {
      const ids = new Set(i.ids)
      for (const c of Object.values(p.clips)) if (c.assetId && ids.has(c.assetId)) delete p.clips[c.id]
      for (const assetId of ids) delete p.assets[assetId]
    },
  }),

  // Project
  'project.update': command({
    description:
      'Rename the project or change its settings (width, height, fps, background color). Changing fps re-times every clip so nothing drifts.',
    input: z.object({
      name: z.string().min(1).optional(),
      settings: z
        .object({ width: z.number().int().min(16).max(8192), height: z.number().int().min(16).max(8192), fps: z.number().int().min(1).max(240), background: z.string() })
        .partial()
        .optional(),
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
