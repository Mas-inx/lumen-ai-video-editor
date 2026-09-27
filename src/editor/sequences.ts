/**
 * Timelines (sequences). A project has one or more; the open one lives in the
 * project's top-level fields so every command, tool and panel edits it as
 * before, and the others wait in `project.sequences`. A clip can play another
 * timeline — nesting — and a multicam timeline holds one camera angle per
 * video track.
 */
import { current, isDraft, produce } from 'immer'
import { uid } from '@/lib/id'
import { createClip, createTrack } from './defaults'
import { defaultTracks } from './new-project'
import { adjacentBefore, clipEnd, clipsOnTrack, cloneClip, isMagneticTrack, overlaps, setClipEnd, setClipStart, withGroups } from './ops'
import { isRamped } from './timing'
import type { Clip, Frame, Project, ProjectSettings, Sequence, Track } from './types'

export const MAIN_SEQUENCE_ID = 'seq_main'

export class TimelineError extends Error {}

export const openSequenceId = (p: Pick<Project, 'sequence'>) => p.sequence?.id ?? MAIN_SEQUENCE_ID
export const openSequenceName = (p: Pick<Project, 'sequence'>) => p.sequence?.name ?? 'Main timeline'

/** Frames a set of clips runs for (the end of the last one). */
export function clipsLength(clips: Record<string, Clip>): Frame {
  let max = 0
  for (const c of Object.values(clips)) max = Math.max(max, clipEnd(c))
  return max
}

/** The open timeline, packaged like a stored one. */
export function openSequence(p: Project): Sequence {
  return {
    id: openSequenceId(p),
    name: openSequenceName(p),
    settings: p.settings,
    tracks: p.tracks,
    clips: p.clips,
    markers: p.markers,
    ...(p.range ? { range: p.range } : {}),
    ...(p.master ? { master: p.master } : {}),
    ...(p.sequence?.multicam ? { multicam: true } : {}),
    createdAt: p.sequence?.createdAt ?? p.createdAt,
  }
}

/** Every timeline, the open one included, oldest first. */
export function allSequences(p: Project): Sequence[] {
  return [openSequence(p), ...Object.values(p.sequences ?? {})].sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name))
}

export function getSequence(p: Project, id: string): Sequence | null {
  if (id === openSequenceId(p)) return openSequence(p)
  return p.sequences?.[id] ?? null
}

export function sequenceSeconds(seq: Pick<Sequence, 'clips' | 'settings'>) {
  return clipsLength(seq.clips) / seq.settings.fps
}

/** A name no other timeline has: `base`, else “base 2”, “base 3”… */
export function freshName(p: Project, base: string) {
  const taken = new Set(allSequences(p).map((s) => s.name.toLowerCase()))
  if (!taken.has(base.toLowerCase())) return base
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`
}

/** Opens timeline `id` in a draft: the open one is stored away, `id` takes its place. */
export function swapIn(p: Project, id: string) {
  if (id === openSequenceId(p)) return
  const next = p.sequences?.[id]
  if (!next) throw new TimelineError(`Timeline ${id} not found`)
  const stored = openSequence(p)
  p.sequences ??= {}
  p.sequences[stored.id] = stored
  delete p.sequences[id]
  p.sequence = { id: next.id, name: next.name, ...(next.multicam ? { multicam: true } : {}), createdAt: next.createdAt }
  p.settings = next.settings
  p.tracks = next.tracks
  p.clips = next.clips
  p.markers = next.markers
  if (next.range) p.range = next.range
  else delete p.range
  if (next.master) p.master = next.master
  else delete p.master
}

/** The project with timeline `id` open — for exporting a timeline that isn't the one on screen. */
export function withSequenceOpen(p: Project, id: string): Project {
  if (id === openSequenceId(p)) return p
  if (!p.sequences?.[id]) throw new TimelineError(`Timeline ${id} not found`)
  return produce(p, (d) => swapIn(d, id))
}

// ─── Views for nested playback ───────────────────────────────────────────

const views = new WeakMap<Sequence, { base: Project; view: Project }>()

/**
 * A stored timeline seen as a project of its own — what rendering and mixing a
 * nested timeline read. Shares the project's media, LUTs and fonts.
 */
export function sequenceView(p: Project, id: string): Project | null {
  if (id === openSequenceId(p)) return p
  const seq = p.sequences?.[id]
  if (!seq) return null
  const hit = views.get(seq)
  if (hit && hit.base.assets === p.assets && hit.base.sequences === p.sequences && hit.base.luts === p.luts && hit.base.fonts === p.fonts) return hit.view
  const view: Project = {
    ...p,
    settings: seq.settings,
    tracks: seq.tracks,
    clips: seq.clips,
    markers: seq.markers,
    range: seq.range ?? null,
    master: seq.master,
    sequence: { id: seq.id, name: seq.name, ...(seq.multicam ? { multicam: true } : {}), createdAt: seq.createdAt },
  }
  views.set(seq, { base: p, view })
  return view
}

/** The video tracks of a multicam timeline — its angles, in order. */
export const angleTracks = (seq: Pick<Sequence, 'tracks'>): Track[] => seq.tracks.filter((t) => t.kind === 'video')

/** The track a multicam clip shows (its angle, else the first). */
export function angleTrackOf(view: Project, clip: Pick<Clip, 'angle'>): string | undefined {
  const angles = angleTracks(view)
  return (clip.angle && angles.find((t) => t.id === clip.angle)?.id) ?? angles[0]?.id
}

// ─── Relationships ───────────────────────────────────────────────────────

/** Every timeline `id` plays, directly or through others. */
export function nestedIn(p: Project, id: string, seen = new Set<string>()): Set<string> {
  const seq = getSequence(p, id)
  if (!seq) return seen
  for (const c of Object.values(seq.clips)) {
    if (!c.sequenceId || seen.has(c.sequenceId)) continue
    seen.add(c.sequenceId)
    nestedIn(p, c.sequenceId, seen)
  }
  return seen
}

/** Whether putting timeline `id` inside timeline `into` would make it contain itself. */
export const wouldLoop = (p: Project, into: string, id: string) => id === into || nestedIn(p, id).has(into)

/** Where a timeline is used: the timelines (and clips in them) that play it. */
export function usesOf(p: Project, id: string): { sequenceId: string; name: string; clipIds: string[] }[] {
  const out: { sequenceId: string; name: string; clipIds: string[] }[] = []
  for (const seq of allSequences(p)) {
    const clipIds = Object.values(seq.clips)
      .filter((c) => c.sequenceId === id)
      .map((c) => c.id)
    if (clipIds.length) out.push({ sequenceId: seq.id, name: seq.name, clipIds })
  }
  return out
}

// ─── Making timelines ────────────────────────────────────────────────────

/** An empty timeline with the standard tracks. */
export function blankSequence(name: string, settings: ProjectSettings, id = uid('seq')): Sequence {
  return { id, name, settings: { ...settings }, tracks: defaultTracks(), clips: {}, markers: [], createdAt: Date.now() }
}

const plain = <T extends object>(v: T): T => structuredClone(isDraft(v) ? (current(v as never) as T) : v)

/** A full copy of a timeline (not a draft) with new ids for its tracks, clips, groups and markers. */
export function copySequence(seq: Sequence, name: string): Sequence {
  const src = structuredClone(seq)
  const trackIds = new Map(src.tracks.map((t) => [t.id, uid('track')]))
  const groupIds = new Map<string, string>()
  const clips: Record<string, Clip> = {}
  for (const c of Object.values(src.clips)) {
    const id = uid('clip')
    const groupId = c.groupId ? (groupIds.get(c.groupId) ?? groupIds.set(c.groupId, uid('grp')).get(c.groupId)) : undefined
    clips[id] = { ...c, id, trackId: trackIds.get(c.trackId) ?? c.trackId, ...(groupId ? { groupId } : {}) }
  }
  return {
    ...src,
    id: uid('seq'),
    name,
    tracks: src.tracks.map((t) => ({ ...t, id: trackIds.get(t.id)! })),
    clips,
    markers: src.markers.map((m) => ({ ...m, id: uid('mk') })),
    createdAt: Date.now(),
  }
}

// ─── Nesting ─────────────────────────────────────────────────────────────

/** A track of `kind` with nothing on it over [a, b): one of `prefer` first, else a new one next to `near`. */
function freeTrack(p: Project, kind: Track['kind'], a: Frame, b: Frame, prefer: string[], near?: string): string {
  const free = (t: Track) => t.kind === kind && !t.locked && !isMagneticTrack(p, t.id) && !clipsOnTrack(p, t.id).some((c) => overlaps(c.start, clipEnd(c), a, b))
  for (const id of prefer) {
    const t = p.tracks.find((x) => x.id === id)
    if (t && free(t)) return t.id
  }
  const nearIndex = near ? p.tracks.findIndex((t) => t.id === near) : -1
  const track = createTrack(kind, { name: kind === 'video' ? 'Video' : 'Audio' })
  if (kind === 'video') p.tracks.splice(Math.max(0, nearIndex), 0, track)
  else p.tracks.push(track)
  return track.id
}

/**
 * Moves clips into a new timeline and puts one clip playing it where they were.
 * Linked clips come along. On the magnetic main track the nest covers exactly
 * what the main-track clips did, so nothing after it moves.
 */
export function nestClips(p: Project, ids: string[], name?: string): { clipId: string; sequenceId: string } {
  const clips = withGroups(p, ids)
    .map((id) => p.clips[id])
    .filter((c): c is Clip => Boolean(c))
  if (!clips.length) throw new TimelineError('Select the clips to nest first')
  for (const c of clips) if (p.tracks.find((t) => t.id === c.trackId)?.locked) throw new TimelineError(`“${c.name}” is on a locked track`)
  const from = Math.min(...clips.map((c) => c.start))
  const to = Math.max(...clips.map(clipEnd))
  const used = p.tracks.filter((t) => clips.some((c) => c.trackId === t.id))
  const trackMap = new Map(used.map((t) => [t.id, createTrack(t.kind, { name: t.name, height: t.height, ...(t.role === 'titles' || t.role === 'captions' ? { role: t.role } : {}) })]))
  const seq: Sequence = {
    id: uid('seq'),
    name: name?.trim() || freshName(p, 'Nested'),
    settings: { ...plain(p.settings) },
    tracks: [...trackMap.values()],
    clips: {},
    markers: p.markers.filter((m) => m.frame >= from && m.frame < to).map((m) => ({ ...plain(m), id: uid('mk'), frame: m.frame - from })),
    createdAt: Date.now(),
  }
  const main = clips.filter((c) => isMagneticTrack(p, c.trackId))
  for (const c of clips) {
    const moved = cloneClip(c)
    moved.trackId = trackMap.get(c.trackId)!.id
    moved.start = c.start - from
    seq.clips[moved.id] = moved
    delete p.clips[c.id]
  }
  // A transition from a clip that stayed behind has nothing to come from any more.
  const view = { ...p, clips: seq.clips, tracks: seq.tracks } as Project
  for (const c of Object.values(seq.clips)) if (c.transitionIn && !adjacentBefore(view, c)) c.transitionIn = null
  p.sequences ??= {}
  p.sequences[seq.id] = seq

  const visual = clips.some((c) => c.kind !== 'audio')
  let trackId: string
  let start = from
  let duration = to - from
  let inPoint = 0
  if (main.length) {
    trackId = main[0].trackId
    const a = Math.min(...main.map((c) => c.start))
    const b = Math.max(...main.map(clipEnd))
    start = a
    duration = b - a
    inPoint = a - from
  } else {
    const kind = visual ? 'video' : 'audio'
    const top = used.find((t) => t.kind === kind)
    trackId = freeTrack(p, kind, from, to, used.filter((t) => t.kind === kind).map((t) => t.id), top?.id)
  }
  const nest = createClip({ kind: visual ? 'video' : 'audio', trackId, start, duration, inPoint, name: seq.name, sequenceId: seq.id })
  p.clips[nest.id] = nest
  return { clipId: nest.id, sequenceId: seq.id }
}

/**
 * Breaks a nested clip apart: the part of its timeline it shows comes back
 * onto this timeline in its place, on free tracks. The nested timeline itself
 * stays in the project.
 */
export function unnestClip(p: Project, id: string): string[] {
  const nest = p.clips[id]
  if (!nest?.sequenceId) throw new TimelineError('That clip isn’t a nested timeline')
  const seq = p.sequences?.[nest.sequenceId]
  if (!seq) throw new TimelineError('Its timeline is missing')
  if (seq.settings.fps !== p.settings.fps) throw new TimelineError(`The nested timeline runs at ${seq.settings.fps} fps and this one at ${p.settings.fps} — it can’t be broken apart`)
  if (nest.speed !== 1 || nest.reverse || nest.freeze || isRamped(nest)) throw new TimelineError('Only a nested clip playing at normal speed can be broken apart')
  if (p.tracks.find((t) => t.id === nest.trackId)?.locked) throw new TimelineError(`“${nest.name}” is on a locked track`)
  const offset = nest.start - nest.inPoint
  const w0 = nest.inPoint
  const w1 = nest.inPoint + nest.duration
  const a = nest.start
  const b = clipEnd(nest)
  const inner = Object.values(seq.clips).filter((c) => overlaps(c.start, clipEnd(c), w0, w1))
  const onMain = isMagneticTrack(p, nest.trackId)
  delete p.clips[nest.id]

  // Which timeline track each inner track lands on.
  const map = new Map<string, string>()
  if (onMain) {
    // The main track can't have gaps: it takes the inner video track that covers the whole stretch.
    const covering = seq.tracks.find((t) => {
      if (t.kind !== 'video') return false
      let cursor = w0
      for (const c of inner.filter((x) => x.trackId === t.id).sort((x, y) => x.start - y.start)) {
        if (c.start > cursor) return false
        cursor = Math.max(cursor, clipEnd(c))
      }
      return cursor >= w1
    })
    if (!covering) throw new TimelineError('On the main track, a nested timeline can only be broken apart when one of its video tracks fills the whole clip')
    map.set(covering.id, nest.trackId)
  }
  // The rest go to free tracks, nearest the nested clip's own track first.
  const home = p.tracks.findIndex((t) => t.id === nest.trackId)
  for (const t of seq.tracks.filter((x) => inner.some((c) => c.trackId === x.id) && !map.has(x.id))) {
    const taken = new Set(map.values())
    const candidates = p.tracks
      .map((x, i) => ({ id: x.id, kind: x.kind, d: Math.abs(i - home) }))
      .filter((x) => x.kind === t.kind && !taken.has(x.id))
      .sort((x, y) => x.d - y.d)
      .map((x) => x.id)
    map.set(t.id, freeTrack(p, t.kind, a, b, candidates, nest.trackId))
  }

  const groups = new Map<string, string>()
  const added: string[] = []
  for (const c of inner) {
    const trackId = map.get(c.trackId)
    if (!trackId) continue
    const copy = cloneClip(c)
    copy.id = uid('clip')
    copy.trackId = trackId
    if (copy.groupId) copy.groupId = groups.get(copy.groupId) ?? groups.set(copy.groupId, uid('grp')).get(copy.groupId)
    copy.start = c.start + offset
    if (copy.start < a) setClipStart(copy, a)
    if (clipEnd(copy) > b) setClipEnd(copy, b)
    if (copy.transitionIn && c.start < w0) copy.transitionIn = null
    p.clips[copy.id] = copy
    added.push(copy.id)
  }
  return added
}
