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
import { EFFECTS } from './presets'
import {
  clipEnd,
  clipsAt,
  clipsOnTrack,
  cloneClip,
  deleteClips,
  findFreeStart,
  isMagneticTrack,
  removeRange,
  resolveMoveDelta,
  splitClip,
  trackAccepts,
  trimClip,
} from './ops'
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
const animatable = z.enum(['x', 'y', 'scale', 'rotation', 'opacity', 'volume', 'rotateX', 'rotateY', 'z'])
const markerColor = z.enum(['lime', 'violet', 'pink', 'amber', 'emerald', 'sky'])
const pct = z.number().min(-100).max(100)

/** Values the schemas accept, for tools that list what's available. */
export const BLEND_MODES = blend.options
export const EASINGS = easing.options

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
    speed: z.number().min(0.1).max(16),
    reverse: z.boolean(),
    blend,
    look: z.string().nullable(),
    transform: transform.partial(),
    color: grade.partial(),
    audio: audioMix.partial(),
    text: textStyle.partial(),
    animation: z.object({ in: animSpec.partial(), out: animSpec.partial() }).partial(),
  })
  .partial()

export type ClipPatch = z.infer<typeof clipPatch>

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

function applyPatch(p: Project, clip: Clip, patch: ClipPatch) {
  const { transform, color, audio, text, animation, speed, ...flat } = patch
  Object.assign(clip, flat)
  if (transform) Object.assign(clip.transform, transform)
  if (color) Object.assign(clip.color, color)
  if (audio) Object.assign(clip.audio, audio)
  if (text && clip.text) Object.assign(clip.text, text)
  if (animation?.in) Object.assign(clip.animation.in, animation.in)
  if (animation?.out) Object.assign(clip.animation.out, animation.out)
  if (speed !== undefined && speed !== clip.speed) {
    // Speed changes keep the same source range, so the clip gets longer or shorter —
    // but never runs into its right-hand neighbour.
    let duration = Math.max(1, Math.round((clip.duration * clip.speed) / speed))
    const next = clipsOnTrack(p, clip.trackId).find((c) => c.id !== clip.id && c.start >= clipEnd(clip))
    if (next) duration = Math.min(duration, next.start - clip.start)
    clip.speed = speed
    clip.duration = duration
  }
}

function setBase(clip: Clip, prop: AnimatableProp, value: number) {
  if (prop === 'volume') clip.audio.volume = value
  else clip.transform[prop] = value
}

// ─── Commands ────────────────────────────────────────────────────────────

export const commands = {
  // Clips
  'clip.add': command({
    description:
      'Add a clip to a track. Media clips (video/image/audio) reference an asset; text clips take a text style via patch.text; adjustment clips grade everything beneath them. Overlapping positions slide to the nearest free spot. Returns the new clip id.',
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
    }),
    title: (i) => (i.kind === 'text' ? 'Add title' : i.kind === 'adjustment' ? 'Add adjustment layer' : 'Add clip'),
    run(p, i) {
      const track = getTrack(p, i.trackId)
      if (!trackAccepts(track, i.kind)) throw new CommandError(`A ${i.kind} clip can't go on an ${track.kind} track`)
      const source = i.assetId ? p.assets[i.assetId] : undefined
      if (i.assetId && !source) throw new CommandError(`Asset ${i.assetId} not found`)
      const inPoint = i.inPoint ?? 0
      const available = source?.duration !== undefined ? Math.floor(source.duration * p.settings.fps) - inPoint : Infinity
      const duration = Math.max(1, Math.min(i.duration, available))
      const clip = createClip({
        id: i.id ?? uid('clip'),
        kind: i.kind,
        trackId: track.id,
        start: findFreeStart(p, track.id, i.start, duration),
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
      'Move one or more clips to new start frames and optionally other tracks. Moves are applied as a group; if they would overlap other clips the group slides to the nearest place that fits.',
    input: z.object({
      moves: z.array(z.object({ id, start: frame, trackId: id.optional() })).min(1),
    }),
    title: (i, p) =>
      i.moves.every((m) => isMagneticTrack(p, m.trackId ?? p.clips[m.id]?.trackId ?? '')) ? 'Reorder clips' : `Move ${plural(i.moves.length, 'clip')}`,
    run(p, i) {
      const moving = i.moves.map((m) => {
        const clip = getClip(p, m.id)
        assertEditable(p, clip)
        const track = getTrack(p, m.trackId ?? clip.trackId)
        if (!trackAccepts(track, clip.kind)) throw new CommandError(`"${clip.name}" can't go on ${track.name}`)
        if (track.locked) throw new CommandError(`${track.name} is locked`)
        return { id: clip.id, start: m.start, duration: clip.duration, trackId: track.id }
      })
      const delta = resolveMoveDelta(p, moving, 0)
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
      "Trim a clip by moving its start or end edge to an absolute timeline frame. Respects the source media length and neighbouring clips.",
    input: z.object({ id, edge: z.enum(['start', 'end']), frame }),
    title: (i) => (i.edge === 'start' ? 'Trim start' : 'Trim end'),
    run(p, i) {
      const clip = getClip(p, i.id)
      assertEditable(p, clip)
      trimClip(p, clip, i.edge, i.frame)
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
      return targets.map((c) => splitClip(p, c, i.frame)?.id).filter(Boolean)
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
      return i.ids.map((clipId) => {
        const original = getClip(p, clipId)
        const copy = cloneClip(original)
        copy.id = uid('clip')
        copy.start = findFreeStart(p, original.trackId, clipEnd(original), original.duration)
        p.clips[copy.id] = copy
        return copy.id
      })
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
      'Set a keyframe on an animatable property (x, y, scale, rotation, opacity, volume) at a frame relative to the clip start.',
    input: z.object({ clipId: id, prop: animatable, frame, value: z.number(), easing: easing.optional() }),
    title: (i) => `Keyframe ${i.prop}`,
    run(p, i) {
      const clip = getClip(p, i.clipId)
      assertEditable(p, clip)
      const kfs = (clip.keyframes[i.prop] ??= [])
      const existing = kfs.find((k) => k.frame === i.frame)
      if (existing) {
        existing.value = i.value
        if (i.easing) existing.easing = i.easing
      } else {
        kfs.push({ frame: i.frame, value: i.value, easing: i.easing ?? 'ease' })
        kfs.sort((a, b) => a.frame - b.frame)
      }
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
    description: 'Rename a track, or toggle hidden / muted / locked, or change its height.',
    input: z.object({
      id,
      patch: z.object({ name: z.string().min(1), hidden: z.boolean(), muted: z.boolean(), locked: z.boolean(), height: z.number().min(28).max(160) }).partial(),
    }),
    title: (i) => {
      const [key] = Object.keys(i.patch)
      return key === 'hidden' ? (i.patch.hidden ? 'Hide track' : 'Show track') : key === 'locked' ? (i.patch.locked ? 'Lock track' : 'Unlock track') : key === 'muted' ? (i.patch.muted ? 'Mute track' : 'Unmute track') : 'Edit track'
    },
    run(p, i) {
      Object.assign(getTrack(p, i.id), i.patch)
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
