/**
 * Pure timeline operations. They work on plain objects or Immer drafts, so the
 * command layer, the UI (for live drag previews) and AI tools share one set of rules.
 */
import { current, isDraft } from 'immer'
import { clamp } from '@/lib/math'
import { uid } from '@/lib/id'
import { createClip, createTrack, TRACK_HEIGHTS } from './defaults'
import { ANIMATABLE, propAt } from './keyframes'
import { consumed, consumedAt, sourceFrameAt, speedAt, splitInPoints } from './timing'
import type { AnimatableProp, Clip, ClipKind, Frame, Project, Track } from './types'

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
export function sourceFrames(p: Project, clip: Pick<Clip, 'assetId' | 'sequenceId'>): number {
  if (clip.sequenceId) {
    // A nested timeline runs as long as its last clip (in this timeline's frames).
    const seq = p.sequences?.[clip.sequenceId]
    if (!seq) return Infinity
    let end = 0
    for (const c of Object.values(seq.clips)) end = Math.max(end, clipEnd(c))
    return Math.max(1, Math.floor((end / seq.settings.fps) * p.settings.fps))
  }
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

/** Packs magnetic tracks; with the state before the edit, grouped clips elsewhere follow their magnetic partners. */
export function normalizeProject(p: Project, before?: Project) {
  for (const t of p.tracks) if (isMagnetic(t)) packTrack(p, t.id)
  if (before) syncGroups(p, before)
}

/**
 * Clips grouped with a clip on the magnetic track (its detached sound, say) keep
 * their offset from it when it moves — by an edit or by the track re-packing —
 * so linked sound never drifts out of sync.
 */
export function syncGroups(p: Project, before: Project) {
  const magnetic = new Set(p.tracks.filter(isMagnetic).map((t) => t.id))
  if (!magnetic.size) return
  for (const m of Object.values(p.clips)) {
    if (!m.groupId || !magnetic.has(m.trackId)) continue
    const was = before.clips[m.id]
    if (!was || !magnetic.has(was.trackId) || was.start === m.start) continue
    for (const x of Object.values(p.clips)) {
      if (x.id === m.id || x.groupId !== m.groupId || magnetic.has(x.trackId)) continue
      const xWas = before.clips[x.id]
      if (!xWas || xWas.groupId !== m.groupId) continue
      x.start = Math.max(0, m.start + (xWas.start - was.start))
    }
  }
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

/**
 * How far each edge can move by the media alone: [earliest start, latest end].
 * Stills, titles, adjustment layers and freeze frames extend without limit.
 */
export function mediaEdgeLimits(p: Project, clip: Clip): [number, number] {
  const src = sourceFrames(p, clip)
  if (src === Infinity || clip.freeze) return [-Infinity, Infinity]
  const below = clip.inPoint
  const above = Math.max(0, src - clip.inPoint - consumed(clip))
  // Forward clips find earlier footage before their head and later footage after their tail; reversed, the other way round.
  const [head, tail] = clip.reverse ? [above, below] : [below, above]
  return [clip.start - Math.floor(head / speedAt(clip, 0) + 1e-6), clipEnd(clip) + Math.floor(tail / speedAt(clip, clip.duration) + 1e-6)]
}

/** Legal range for the frame an edge can be dragged to. */
export function trimBounds(p: Project, clip: Clip, edge: 'start' | 'end', ignoreNeighbours = false): [number, number] {
  // On a magnetic track neighbours ripple out of the way, so only the media limits apply.
  const siblings = ignoreNeighbours || isMagneticTrack(p, clip.trackId) ? [] : clipsOnTrack(p, clip.trackId).filter((c) => c.id !== clip.id)
  const end = clipEnd(clip)
  const [mediaMin, mediaMax] = mediaEdgeLimits(p, clip)
  if (edge === 'start') {
    let prevEnd = 0
    for (const s of siblings) if (clipEnd(s) <= clip.start) prevEnd = Math.max(prevEnd, clipEnd(s))
    return [Math.max(prevEnd, mediaMin, 0), end - 1]
  }
  let nextStart = Infinity
  for (const s of siblings) if (s.start >= end) nextStart = Math.min(nextStart, s.start)
  return [clip.start + 1, Math.min(nextStart, mediaMax)]
}

/** Moves a clip's start edge to `frame` (no bounds checks), keeping the footage that stays in place. */
export function setClipStart(clip: Clip, frame: Frame) {
  const delta = Math.round(frame) - clip.start
  if (!delta) return
  if (!clip.freeze && !clip.reverse) {
    // Forward clips: the head's footage comes off (or back on) the bottom of the source range.
    clip.inPoint = Math.max(0, clip.inPoint + (delta > 0 ? Math.round(consumedAt(clip, delta)) : -Math.round(-delta * speedAt(clip, 0))))
  }
  clip.start += delta
  clip.duration -= delta
  shiftKeyframes(clip, -delta)
  shiftFollow(clip, -delta)
}

/** Moves a clip's end edge to `frame` (no bounds checks). */
export function setClipEnd(clip: Clip, frame: Frame) {
  const duration = Math.max(1, Math.round(frame) - clip.start)
  if (duration === clip.duration) return
  if (!clip.freeze && clip.reverse) {
    // Reversed clips end on the bottom of their source range.
    const change = duration < clip.duration ? consumed(clip) - consumedAt(clip, duration) : -(duration - clip.duration) * speedAt(clip, clip.duration)
    clip.inPoint = Math.max(0, clip.inPoint + Math.round(change))
  }
  clip.duration = duration
}

/** Mutates `clip` (a draft) so the given edge lands on `frame`, respecting bounds. */
export function trimClip(p: Project, clip: Clip, edge: 'start' | 'end', frame: Frame) {
  const [min, max] = trimBounds(p, clip, edge)
  const target = clamp(Math.round(frame), min, max)
  if (edge === 'start') setClipStart(clip, target)
  else setClipEnd(clip, target)
}

/**
 * Ripple trim: the edge moves and everything after the clip on its track moves
 * with it, so no gap opens and nothing is covered. Trimming the start keeps the
 * clip where it is and takes the frames off its head.
 */
export function rippleTrimClip(p: Project, clip: Clip, edge: 'start' | 'end', frame: Frame) {
  const [mediaMin, mediaMax] = mediaEdgeLimits(p, clip)
  const later = clipsOnTrack(p, clip.trackId).filter((c) => c.id !== clip.id && c.start >= clipEnd(clip))
  let change: number
  if (edge === 'end') {
    const target = clamp(Math.round(frame), clip.start + 1, mediaMax)
    change = target - clipEnd(clip)
    setClipEnd(clip, target)
  } else {
    const target = clamp(Math.round(frame), Math.max(0, mediaMin), clipEnd(clip) - 1)
    const start = clip.start
    change = -(target - start)
    setClipStart(clip, target)
    clip.start = start
  }
  if (change) for (const c of later) c.start = Math.max(0, c.start + change)
}

/** Tracked paths are in clip frames: they move with the clip's head. */
function shiftFollow(clip: Clip, by: number) {
  if (clip.follow) clip.follow.start += by
  for (const m of clip.masks ?? []) if (m.follow) m.follow.start += by
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
  const inPoints = splitInPoints(clip, leftDuration)
  const right = cloneClip(clip)
  right.id = uid('clip')
  right.start = frame
  right.duration = clip.duration - leftDuration
  right.inPoint = inPoints.right
  clip.inPoint = inPoints.left
  right.transitionIn = null
  right.animation.in = { ...right.animation.in, preset: 'none' }
  right.audio.fadeIn = 0
  shiftFollow(right, -leftDuration)

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

/**
 * Splits clips at one frame. Like razoring linked clips, the right halves of a
 * group form a group of their own, so each piece of picture stays linked to its
 * piece of sound. Returns the right halves.
 */
export function splitClips(p: Project, clips: Clip[], frame: Frame): Clip[] {
  const groups = new Map<string, string>()
  const rights: Clip[] = []
  for (const c of clips) {
    const right = splitClip(p, c, frame)
    if (!right) continue
    if (right.groupId) {
      if (!groups.has(right.groupId)) groups.set(right.groupId, uid('grp'))
      right.groupId = groups.get(right.groupId)
    }
    rights.push(right)
  }
  dropLoneGroups(p, [...groups.keys(), ...groups.values()])
  return rights
}

/** A group left with a single clip isn't a group any more. */
export function dropLoneGroups(p: Project, groupIds: Iterable<string>) {
  const wanted = new Set(groupIds)
  if (!wanted.size) return
  const members = new Map<string, Clip[]>()
  for (const c of Object.values(p.clips)) if (c.groupId && wanted.has(c.groupId)) members.set(c.groupId, [...(members.get(c.groupId) ?? []), c])
  for (const list of members.values()) if (list.length === 1) delete list[0].groupId
}

// ─── Deleting ────────────────────────────────────────────────────────────

/** Deletes clips; with `ripple`, later clips on the same track close the gap. */
export function deleteClips(p: Project, ids: string[], ripple: boolean) {
  const removed = ids.map((id) => p.clips[id]).filter(Boolean)
  for (const c of removed) delete p.clips[c.id]
  dropLoneGroups(p, removed.map((c) => c.groupId).filter((g): g is string => Boolean(g)))
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
  // The pieces after the stretch, across every track, stay linked to each other.
  const tailGroups = new Map<string, string>()
  const groupsBefore = new Set(Object.values(p.clips).map((c) => c.groupId).filter((g): g is string => Boolean(g)))
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
        if (right?.groupId && c.start < a) {
          if (!tailGroups.has(right.groupId)) tailGroups.set(right.groupId, uid('grp'))
          right.groupId = tailGroups.get(right.groupId)
        }
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
  if (p.range) p.range = shiftRange(p.range, (f) => (f >= b ? f - len : f > a ? a : f))
  dropLoneGroups(p, [...groupsBefore, ...tailGroups.values()])
  normalizeProject(p)
}

/** Maps in/out points through an edit; a range that collapses is cleared. */
function shiftRange(range: { in: Frame; out: Frame }, map: (f: Frame) => Frame) {
  const next = { in: map(range.in), out: map(range.out) }
  return next.out > next.in ? next : null
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

/** The clip immediately after `clip` on its track, if they touch. */
export function adjacentAfter(p: Project, clip: Clip): Clip | undefined {
  const end = clipEnd(clip)
  for (const c of Object.values(p.clips)) {
    if (c.trackId === clip.trackId && c.id !== clip.id && c.start === end) return c
  }
  return undefined
}

// ─── Overwrite & insert ──────────────────────────────────────────────────

/**
 * Clears [a, b) on a track, like an overwrite edit: clips inside go, clips across
 * an edge are trimmed back to it, a clip spanning the whole stretch is cut in two.
 */
export function overwriteRange(p: Project, trackId: string, a: Frame, b: Frame, exclude: ReadonlySet<string> = new Set()) {
  if (b <= a) return
  for (const c of clipsOnTrack(p, trackId, exclude)) {
    const end = clipEnd(c)
    if (end <= a || c.start >= b) continue
    if (c.start >= a && end <= b) {
      delete p.clips[c.id]
      continue
    }
    if (c.start < a && end > b) {
      const right = splitClip(p, c, b)
      if (right) right.transitionIn = null
      setClipEnd(c, a)
      continue
    }
    if (c.start < a) setClipEnd(c, a)
    else {
      setClipStart(c, b)
      c.transitionIn = null
    }
  }
}

/** Opens a gap of `len` frames at `at` on a track (insert edit): a clip across `at` is cut, everything from `at` on moves right. */
export function insertGap(p: Project, trackId: string, at: Frame, len: Frame, exclude: ReadonlySet<string> = new Set()) {
  if (len <= 0) return
  for (const c of clipsOnTrack(p, trackId, exclude)) if (c.start < at && clipEnd(c) > at) splitClip(p, c, at)
  for (const c of clipsOnTrack(p, trackId, exclude)) if (c.start >= at) c.start += len
}

// ─── Trim tools ──────────────────────────────────────────────────────────

/**
 * Roll edit: moves the cut between `right` and the clip that touches it on the
 * left — one gets longer, the other shorter, nothing else moves. Returns the
 * frame the cut landed on.
 */
export function rollEdit(p: Project, right: Clip, frame: Frame): Frame {
  const left = adjacentBefore(p, right)
  if (!left) throw new Error(`“${right.name}” has no clip right before it to roll against`)
  const [lo, hi] = rollBounds(p, left, right)
  const target = clamp(Math.round(frame), lo, hi)
  if (target === right.start) return right.start
  setClipEnd(left, target)
  setClipStart(right, target)
  return target
}

/** Where the cut between two touching clips can roll to: both keep at least a frame, and footage. */
export function rollBounds(p: Project, left: Clip, right: Clip): [number, number] {
  const [, leftMax] = mediaEdgeLimits(p, left)
  const [rightMin] = mediaEdgeLimits(p, right)
  return [Math.max(left.start + 1, rightMin), Math.min(clipEnd(right) - 1, leftMax)]
}

/** Slip: shows a different part of the footage in the same place and length. Returns the frames actually slipped. */
export function slipClip(p: Project, clip: Clip, delta: Frame): Frame {
  const src = sourceFrames(p, clip)
  if (src === Infinity || clip.freeze) return 0
  const max = Math.max(0, Math.floor(src - consumed(clip)))
  const next = clamp(clip.inPoint + Math.round(delta), 0, max)
  const moved = next - clip.inPoint
  clip.inPoint = next
  return moved
}

/**
 * Slide: moves a clip along its track while the clips either side of it give and
 * take frames, so no gap opens. Returns the frames actually slid.
 */
export function slideClip(p: Project, clip: Clip, delta: Frame): Frame {
  const prev = adjacentBefore(p, clip)
  const next = adjacentAfter(p, clip)
  const [lo, hi] = slideBounds(p, clip)
  const d = clamp(Math.round(delta), lo, hi)
  if (!d) return 0
  if (prev) setClipEnd(prev, prev.start + prev.duration + d)
  if (next) setClipStart(next, next.start + d)
  clip.start += d
  return d
}

/** How far a clip can slide: [most frames earlier (negative), most frames later]. */
export function slideBounds(p: Project, clip: Clip): [number, number] {
  const prev = adjacentBefore(p, clip)
  const next = adjacentAfter(p, clip)
  const others = clipsOnTrack(p, clip.trackId).filter((c) => c.id !== clip.id && c !== prev && c !== next)
  let lo = -clip.start
  let hi = Infinity
  if (prev) {
    const [, prevMax] = mediaEdgeLimits(p, prev)
    lo = Math.max(lo, prev.start + 1 - clip.start)
    hi = Math.min(hi, prevMax - clip.start)
  } else for (const o of others) if (clipEnd(o) <= clip.start) lo = Math.max(lo, clipEnd(o) - clip.start)
  if (next) {
    const [nextMin] = mediaEdgeLimits(p, next)
    hi = Math.min(hi, clipEnd(next) - 1 - clipEnd(clip))
    lo = Math.max(lo, nextMin - clipEnd(clip))
  } else for (const o of others) if (o.start >= clipEnd(clip)) hi = Math.min(hi, o.start - clipEnd(clip))
  return [lo, hi]
}

/** Slip limits in source frames: [most frames earlier (negative), most frames later]. */
export function slipBounds(p: Project, clip: Clip): [number, number] {
  const src = sourceFrames(p, clip)
  if (src === Infinity || clip.freeze) return [0, 0]
  return [-clip.inPoint, Math.max(0, Math.floor(src - consumed(clip))) - clip.inPoint]
}

// ─── Freeze frames ───────────────────────────────────────────────────────

/**
 * Holds the frame `clip` shows at timeline `frame` for `duration` frames: the clip is
 * cut there and a freeze frame goes in between, pushing the rest of the track later.
 * Returns the freeze clip.
 */
export function freezeFrame(p: Project, clip: Clip, frame: Frame, duration: Frame): Clip {
  const at = clamp(Math.round(frame), clip.start, clipEnd(clip) - 1)
  const local = at - clip.start
  const hold = cloneClip(clip)
  hold.id = uid('clip')
  hold.name = `${clip.name} (freeze)`
  hold.freeze = true
  hold.inPoint = Math.round(sourceFrameAt(clip, local))
  hold.start = at
  hold.duration = Math.max(1, Math.round(duration))
  hold.speed = 1
  hold.reverse = false
  hold.transitionIn = null
  delete hold.groupId
  hold.animation = { in: { ...clip.animation.in, preset: 'none' }, out: { ...clip.animation.out, preset: 'none' } }
  hold.audio = { ...clip.audio, fadeIn: 0, fadeOut: 0 }
  // The hold keeps whatever the clip looked like at that moment, un-animated.
  hold.keyframes = {}
  for (const prop of ANIMATABLE) {
    if (prop === 'speed' || !clip.keyframes[prop]?.length) continue
    setBase(hold, prop, propAt(clip, prop, local))
  }
  const partners = clip.groupId ? Object.values(p.clips).filter((c) => c.groupId === clip.groupId && c.trackId !== clip.trackId && !isMagneticTrack(p, c.trackId)) : []
  const right = splitClip(p, clip, at)
  if (isMagneticTrack(p, clip.trackId)) {
    // The main track packs itself: slot the hold in before the right half.
    hold.start = at - 0.5
  } else insertGap(p, clip.trackId, at, hold.duration)
  // Linked sound is cut at the same point; the rest of it waits out the hold with the picture.
  if (clip.groupId) {
    const tail = uid('grp')
    const old = clip.groupId
    ;(right ?? clip).groupId = tail
    for (const c of partners) {
      const piece = c.start < at && clipEnd(c) > at ? splitClip(p, c, at) : c.start >= at ? c : null
      if (!piece) continue
      piece.start += hold.duration
      piece.groupId = tail
    }
    dropLoneGroups(p, [old, tail])
  }
  p.clips[hold.id] = hold
  return hold
}

function setBase(clip: Clip, prop: AnimatableProp, value: number) {
  if (prop === 'volume') clip.audio.volume = value
  else if (prop === 'speed') clip.speed = value
  else clip.transform[prop] = value
}

// ─── Groups & linked sound ───────────────────────────────────────────────

/** Every clip in the same groups as `ids` (clips without a group stand alone). */
export function withGroups(p: Project, ids: readonly string[]): string[] {
  const groups = new Set(ids.map((id) => p.clips[id]?.groupId).filter(Boolean))
  if (!groups.size) return [...ids]
  const out = new Set(ids)
  for (const c of Object.values(p.clips)) if (c.groupId && groups.has(c.groupId)) out.add(c.id)
  return [...out]
}

export function groupClips(p: Project, ids: readonly string[]): string {
  const groupId = uid('grp')
  for (const id of withGroups(p, ids)) if (p.clips[id]) p.clips[id].groupId = groupId
  return groupId
}

export function ungroupClips(p: Project, ids: readonly string[]) {
  for (const id of withGroups(p, ids)) if (p.clips[id]) delete p.clips[id].groupId
}

/** Clip ids that share a group with at least one other clip, for drawing link badges. */
export function groupedIds(p: Project): Set<string> {
  const count = new Map<string, number>()
  for (const c of Object.values(p.clips)) if (c.groupId) count.set(c.groupId, (count.get(c.groupId) ?? 0) + 1)
  const out = new Set<string>()
  for (const c of Object.values(p.clips)) if (c.groupId && (count.get(c.groupId) ?? 0) > 1) out.add(c.id)
  return out
}

/** An audio track free over [a, b) — preferring one named for voices — or a new one at the bottom. */
function audioTrackFor(p: Project, a: Frame, b: Frame): Track {
  const free = p.tracks.filter((t) => t.kind === 'audio' && !t.locked && clipsOnTrack(p, t.id).every((c) => clipEnd(c) <= a || c.start >= b))
  const pick = free.find((t) => /voice|dialog|narrat|audio/i.test(t.name)) ?? free[0]
  if (pick) return pick
  const count = p.tracks.filter((t) => t.kind === 'audio').length
  const track = createTrack('audio', { id: uid('track'), name: `Audio ${count + 1}`, height: TRACK_HEIGHTS.audio })
  p.tracks.push(track)
  return track
}

/**
 * Splits a video clip's sound onto its own audio clip, linked to the picture so
 * they still move together — trim either on its own for J- and L-cuts. Returns
 * the new audio clip.
 */
export function detachAudio(p: Project, clip: Clip): Clip {
  if (clip.kind !== 'video') throw new Error(`“${clip.name}” isn’t a video clip`)
  if (clip.audio.detached) throw new Error(`“${clip.name}” already has its sound on its own clip`)
  const asset = clip.assetId ? p.assets[clip.assetId] : undefined
  if (!asset || asset.hasAudio === false) throw new Error(`“${clip.name}” has no sound to detach`)
  const track = audioTrackFor(p, clip.start, clipEnd(clip))
  const sound = createClip({
    id: uid('clip'),
    kind: 'audio',
    trackId: track.id,
    start: clip.start,
    duration: clip.duration,
    assetId: clip.assetId,
    inPoint: clip.inPoint,
    name: clip.name,
    speed: clip.speed,
    reverse: clip.reverse,
    audio: { ...clip.audio, detached: undefined },
  })
  for (const prop of ['volume', 'speed'] as const) {
    const kfs = clip.keyframes[prop]
    if (kfs?.length) sound.keyframes[prop] = kfs.map((k) => ({ ...k }))
  }
  clip.groupId ??= uid('grp')
  sound.groupId = clip.groupId
  clip.audio.detached = true
  p.clips[sound.id] = sound
  return sound
}

/** Undoes detachAudio: the linked sound clip goes and the video plays its own sound again, with the sound clip's mix. */
export function reattachAudio(p: Project, clip: Clip) {
  if (!clip.audio.detached) return
  const linked = clip.groupId ? Object.values(p.clips).filter((c) => c.groupId === clip.groupId && c.kind === 'audio' && c.assetId === clip.assetId) : []
  const sound = linked[0]
  if (sound) {
    const { volume, enhance, denoise, fadeIn, fadeOut } = sound.audio
    Object.assign(clip.audio, { volume, enhance, denoise, fadeIn, fadeOut })
    const offset = sound.start - clip.start
    const kfs = sound.keyframes.volume?.map((k) => ({ ...k, frame: k.frame + offset })).filter((k) => k.frame >= 0 && k.frame <= clip.duration)
    if (kfs?.length) clip.keyframes.volume = kfs
    else delete clip.keyframes.volume
  }
  for (const c of linked) delete p.clips[c.id]
  delete clip.audio.detached
  if (clip.groupId) dropLoneGroups(p, [clip.groupId])
}

// ─── Range & tracks ──────────────────────────────────────────────────────

/** Lift: clears [a, b) on every unlocked track and leaves the gap. */
export function liftRange(p: Project, a: Frame, b: Frame) {
  for (const t of p.tracks) if (!t.locked) overwriteRange(p, t.id, a, b)
}

export function moveTrack(p: Project, id: string, index: number) {
  const from = p.tracks.findIndex((t) => t.id === id)
  if (from < 0) return
  const [track] = p.tracks.splice(from, 1)
  p.tracks.splice(clamp(Math.round(index), 0, p.tracks.length), 0, track)
}
