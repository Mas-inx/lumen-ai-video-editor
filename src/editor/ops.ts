/**
 * Pure timeline operations. They work on plain objects or Immer drafts, so the
 * command layer, the UI (for live drag previews) and AI tools share one set of rules.
 */
import { current, isDraft } from 'immer'
import { clamp } from '@/lib/math'
import { uid } from '@/lib/id'
import { ANIMATABLE, propAt } from './keyframes'
import type { Clip, ClipKind, Frame, Project, Track } from './types'

export const clipEnd = (c: Pick<Clip, 'start' | 'duration'>) => c.start + c.duration

export const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number) =>
  aStart < bEnd && bStart < aEnd

export function clipsOnTrack(p: Project, trackId: string, exclude?: ReadonlySet<string>): Clip[] {
  const out: Clip[] = []
  for (const c of Object.values(p.clips)) {
    if (c.trackId === trackId && !exclude?.has(c.id)) out.push(c)
  }
  return out.sort((a, b) => a.start - b.start)
}

export function projectDuration(p: Project): Frame {
  let max = 0
  for (const c of Object.values(p.clips)) max = Math.max(max, clipEnd(c))
  return max
}

export function trackAccepts(track: Pick<Track, 'kind'>, kind: ClipKind) {
  return track.kind === 'audio' ? kind === 'audio' : kind !== 'audio'
}

/** Source length in project frames (Infinity for stills, titles and adjustment layers). */
export function sourceFrames(p: Project, clip: Pick<Clip, 'assetId'>): number {
  if (!clip.assetId) return Infinity
  const asset = p.assets[clip.assetId]
  if (!asset || asset.duration === undefined) return Infinity
  return Math.floor(asset.duration * p.settings.fps)
}

export function cloneClip(c: Clip): Clip {
  return structuredClone(isDraft(c) ? current(c) : c)
}

// ─── Magnetic main track ─────────────────────────────────────────────────
//
// The main track behaves like Final Cut's / CapCut's: clips always sit edge to
// edge from 0. Dragging reorders, trimming ripples, deleting closes the gap.
// Commands just place clips (a -0.5 frame nudge means "insert before a clip
// that starts here"); `normalizeProject` then packs the track after every command.

export const isMagnetic = (track?: Pick<Track, 'role'>) => track?.role === 'main'

export const isMagneticTrack = (p: Project, trackId: string) => isMagnetic(p.tracks.find((t) => t.id === trackId))

export function packTrack(p: Project, trackId: string) {
  let cursor = 0
  for (const c of clipsOnTrack(p, trackId)) {
    if (c.start !== cursor) c.start = cursor
    cursor += c.duration
  }
}

export function normalizeProject(p: Project) {
  for (const t of p.tracks) if (isMagnetic(t)) packTrack(p, t.id)
}

/** Index a clip dropped at `frame` takes among `others`: before the first clip whose middle is past it. */
export function magneticInsertIndex(others: Clip[], frame: number) {
  const i = others.findIndex((o) => o.start + o.duration / 2 > frame)
  return i < 0 ? others.length : i
}

/** Packed starts for a magnetic track after inserting `moving` at `frame`. */
export function magneticLayout(p: Project, trackId: string, moving: { id: string; duration: number }[], frame: number) {
  const exclude = new Set(moving.map((m) => m.id))
  const others = clipsOnTrack(p, trackId, exclude)
  const index = magneticInsertIndex(others, frame)
  const order = [...others.slice(0, index), ...moving, ...others.slice(index)]
  const starts: Record<string, number> = {}
  let cursor = 0
  for (const c of order) {
    starts[c.id] = cursor
    cursor += c.duration
  }
  return { starts, insertAt: index < others.length ? others[index].start : others.length ? clipEnd(others[others.length - 1]) : 0 }
}

// ─── Moving ──────────────────────────────────────────────────────────────

export interface MovingClip {
  id: string
  /** original start */
  start: Frame
  duration: Frame
  /** target track */
  trackId: string
}

/**
 * The delta nearest to `desired` that lands every moving clip without overlapping
 * the clips that stay put. Clips slide into the closest gap that fits instead of
 * overwriting anything — friendlier than classic NLE overwrite semantics.
 */
export function resolveMoveDelta(p: Project, moving: MovingClip[], desired: number): number {
  const exclude = new Set(moving.map((m) => m.id))
  const magnetic = new Set(p.tracks.filter(isMagnetic).map((t) => t.id))
  const cache = new Map<string, Clip[]>()
  // Magnetic tracks never block a move — they re-pack around whatever lands on them.
  const statics = (trackId: string) => {
    if (magnetic.has(trackId)) return []
    let list = cache.get(trackId)
    if (!list) cache.set(trackId, (list = clipsOnTrack(p, trackId, exclude)))
    return list
  }
  const valid = (d: number) =>
    moving.every((m) => {
      const s = m.start + d
      if (s < 0) return false
      return statics(m.trackId).every((o) => !overlaps(s, s + m.duration, o.start, clipEnd(o)))
    })

  if (valid(desired)) return desired

  const minStart = Math.min(...moving.map((m) => m.start))
  const candidates = new Set<number>([-minStart])
  for (const m of moving) {
    for (const o of statics(m.trackId)) {
      candidates.add(clipEnd(o) - m.start)
      candidates.add(o.start - clipEnd(m))
    }
  }
  let best: number | null = null
  let bestDist = Infinity
  for (const d of candidates) {
    const dist = Math.abs(d - desired)
    if (dist < bestDist && valid(d)) {
      best = d
      bestDist = dist
    }
  }
  if (best !== null) return best

  // Nothing nearby fits — park after the last clip on the target tracks.
  let maxEnd = 0
  for (const m of moving) for (const o of statics(m.trackId)) maxEnd = Math.max(maxEnd, clipEnd(o))
  return maxEnd - minStart
}

/**
 * Where a clip of `duration` should start near `desired`: the nearest gap that fits,
 * or — on a magnetic track — an insertion just before whatever starts at `desired`.
 */
export function findFreeStart(p: Project, trackId: string, desired: Frame, duration: Frame, ignoreId?: string) {
  if (isMagneticTrack(p, trackId)) return desired - 0.5
  const d = resolveMoveDelta(p, [{ id: ignoreId ?? '__new__', start: desired, duration, trackId }], 0)
  return desired + d
}

// ─── Trimming ────────────────────────────────────────────────────────────

/** Legal range for the frame an edge can be dragged to. */
export function trimBounds(p: Project, clip: Clip, edge: 'start' | 'end'): [number, number] {
  const src = sourceFrames(p, clip)
  // On a magnetic track neighbours ripple out of the way, so only the media limits apply.
  const siblings = isMagneticTrack(p, clip.trackId) ? [] : clipsOnTrack(p, clip.trackId).filter((c) => c.id !== clip.id)
  const end = clipEnd(clip)
  if (edge === 'start') {
    let prevEnd = 0
    for (const s of siblings) if (clipEnd(s) <= clip.start) prevEnd = Math.max(prevEnd, clipEnd(s))
    const mediaMin = src === Infinity ? 0 : clip.start - Math.floor(clip.inPoint / clip.speed)
    return [Math.max(prevEnd, mediaMin, 0), end - 1]
  }
  let nextStart = Infinity
  for (const s of siblings) if (s.start >= end) nextStart = Math.min(nextStart, s.start)
  const mediaMax = src === Infinity ? Infinity : clip.start + Math.floor((src - clip.inPoint) / clip.speed)
  return [clip.start + 1, Math.min(nextStart, mediaMax)]
}

/** Mutates `clip` (a draft) so the given edge lands on `frame`, respecting bounds. */
export function trimClip(p: Project, clip: Clip, edge: 'start' | 'end', frame: Frame) {
  const [min, max] = trimBounds(p, clip, edge)
  const target = clamp(Math.round(frame), min, max)
  if (edge === 'start') {
    const delta = target - clip.start
    if (!delta) return
    clip.inPoint = Math.max(0, clip.inPoint + Math.round(delta * clip.speed))
    clip.start = target
    clip.duration -= delta
    shiftKeyframes(clip, -delta)
  } else {
    clip.duration = target - clip.start
  }
}

function shiftKeyframes(clip: Clip, by: number) {
  for (const prop of ANIMATABLE) {
    const kfs = clip.keyframes[prop]
    if (!kfs) continue
    const shifted = kfs.map((k) => ({ ...k, frame: k.frame + by })).filter((k) => k.frame >= 0 && k.frame <= clip.duration)
    if (shifted.length) clip.keyframes[prop] = shifted
    else delete clip.keyframes[prop]
  }
}

// ─── Splitting ───────────────────────────────────────────────────────────

/** Splits a clip at an absolute frame. Returns the new right-hand clip, if any. */
export function splitClip(p: Project, clip: Clip, frame: Frame): Clip | null {
  if (frame <= clip.start || frame >= clipEnd(clip)) return null
  const leftDuration = frame - clip.start
  const right = cloneClip(clip)
  right.id = uid('clip')
  right.start = frame
  right.duration = clip.duration - leftDuration
  right.inPoint = clip.inPoint + Math.round(leftDuration * clip.speed)
  right.transitionIn = null
  right.animation.in = { ...right.animation.in, preset: 'none' }
  right.audio.fadeIn = 0

  // Keyframes: both halves keep an exact keyframe at the cut so motion is continuous.
  right.keyframes = {}
  for (const prop of ANIMATABLE) {
    const kfs = clip.keyframes[prop]
    if (!kfs?.length) continue
    const atCut = propAt(clip, prop, leftDuration)
    const left = kfs.filter((k) => k.frame < leftDuration)
    const rightKfs = kfs.filter((k) => k.frame > leftDuration).map((k) => ({ ...k, frame: k.frame - leftDuration }))
    const spanning = left[left.length - 1]?.easing ?? 'linear'
    clip.keyframes[prop] = [...left, { frame: leftDuration, value: atCut, easing: 'linear' }]
    right.keyframes[prop] = [{ frame: 0, value: atCut, easing: spanning }, ...rightKfs]
  }

  clip.duration = leftDuration
  clip.animation.out = { ...clip.animation.out, preset: 'none' }
  clip.audio.fadeOut = 0
  p.clips[right.id] = right
  return right
}

// ─── Deleting ────────────────────────────────────────────────────────────

/** Deletes clips; with `ripple`, later clips on the same track close the gap. */
export function deleteClips(p: Project, ids: string[], ripple: boolean) {
  const removed = ids.map((id) => p.clips[id]).filter(Boolean)
  for (const c of removed) delete p.clips[c.id]
  if (!ripple) return
  const byTrack = new Map<string, { start: number; duration: number }[]>()
  for (const c of removed) {
    const list = byTrack.get(c.trackId) ?? []
    list.push({ start: c.start, duration: c.duration })
    byTrack.set(c.trackId, list)
  }
  for (const [trackId, gaps] of byTrack) {
    for (const c of clipsOnTrack(p, trackId)) {
      const shift = gaps.filter((g) => g.start + g.duration <= c.start).reduce((sum, g) => sum + g.duration, 0)
      if (shift) c.start -= shift
    }
  }
}

/**
 * Takes the frames [a, b) out of the timeline, as if they were never there:
 * clips inside go, clips across it lose that stretch (with a frame of audio fade
 * either side of the join) and everything later moves left — on every unlocked
 * track, so captions, B-roll, effects and markers stay in sync with the edit.
 *
 * Clips in `keepWhole` (music beds, ambience) are never cut: one across the whole
 * stretch plays on unbroken and ends earlier, its keyframes following the edit;
 * one that starts inside it begins at the join instead. Where that runs into the
 * next clip on the track, it's trimmed back.
 */
export function removeRange(p: Project, a: Frame, b: Frame, keepWhole: ReadonlySet<string> = new Set()) {
  const len = b - a
  if (len <= 0) return
  for (const track of p.tracks) {
    if (track.locked) continue
    const placed: Clip[] = []
    for (const c of clipsOnTrack(p, track.id)) {
      const end = clipEnd(c)
      if (end <= a) placed.push(c)
      else if (c.start >= b) {
        c.start -= len
        placed.push(c)
      } else if (keepWhole.has(c.id)) {
        if (c.start < a && end > b) closeStretch(c, a - c.start, len)
        else if (c.start > a) c.start = a
        placed.push(c)
      } else {
        const right = end > b ? splitClip(p, c, b) : null
        if (c.start < a) {
          const mid = splitClip(p, c, a)
          if (mid) delete p.clips[mid.id]
          c.audio.fadeOut = Math.max(c.audio.fadeOut, 1)
          placed.push(c)
        } else delete p.clips[c.id]
        if (right) {
          right.start -= len
          right.audio.fadeIn = Math.max(right.audio.fadeIn, 1)
          placed.push(right)
        }
      }
    }
    placed.sort((x, y) => x.start - y.start)
    for (let i = 0; i < placed.length - 1; i++) {
      const c = placed[i]
      const next = placed[i + 1]
      if (clipEnd(c) <= next.start) continue
      if (next.start - c.start >= 1) c.duration = next.start - c.start
      else delete p.clips[c.id]
    }
  }
  for (const m of p.markers) {
    if (m.frame >= b) m.frame -= len
    else if (m.frame > a) m.frame = a
  }
  normalizeProject(p)
}

/** Shortens a clip by `len` frames at clip-relative `at` without touching its media: keyframes past the stretch move left. */
function closeStretch(clip: Clip, at: Frame, len: Frame) {
  for (const prop of ANIMATABLE) {
    const kfs = clip.keyframes[prop]
    if (!kfs?.length) continue
    const resume = propAt(clip, prop, at + len)
    const easing = kfs.findLast((k) => k.frame <= at + len)?.easing ?? 'linear'
    const before = kfs.filter((k) => k.frame < at)
    const after = kfs.filter((k) => k.frame > at + len).map((k) => ({ ...k, frame: k.frame - len }))
    clip.keyframes[prop] = [...before, { frame: at, value: resume, easing }, ...after]
  }
  clip.duration -= len
}

/** Clips whose span covers `frame` (on unlocked tracks). */
export function clipsAt(p: Project, frame: Frame, onlyIds?: string[]): Clip[] {
  const locked = new Set(p.tracks.filter((t) => t.locked).map((t) => t.id))
  const pool = onlyIds?.length ? onlyIds.map((id) => p.clips[id]).filter(Boolean) : Object.values(p.clips)
  return pool.filter((c) => !locked.has(c.trackId) && frame > c.start && frame < clipEnd(c))
}

/** The clip immediately before `clip` on its track, if they touch. */
export function adjacentBefore(p: Project, clip: Clip): Clip | undefined {
  for (const c of Object.values(p.clips)) {
    if (c.trackId === clip.trackId && c.id !== clip.id && clipEnd(c) === clip.start) return c
  }
  return undefined
}

/** All edit points (clip starts/ends) across the project, sorted. */
export function editPoints(p: Project): number[] {
  const set = new Set<number>([0])
  for (const c of Object.values(p.clips)) {
    set.add(c.start)
    set.add(clipEnd(c))
  }
  return [...set].sort((a, b) => a - b)
}
