/**
 * Higher-level placement helpers ("put this on the timeline sensibly") used by
 * the asset browser, drag & drop, the command palette and the AI agent.
 */
import { toast } from 'sonner'
import { LOOKS, TITLE_PRESETS } from './presets'
import { adjacentAfter, adjacentBefore, clipEnd, clipsOnTrack, sourceFrames, trackAccepts } from './ops'
import { dispatch, getProject, useEditor } from './store'
import type { ActionSource } from './store'
import type { Asset, Clip, ClipKind, EffectKind, Project, Track, TransitionAlign, TransitionKind } from './types'

const STILL_SECONDS = 5

export function assetFrames(project: Project, asset: Asset) {
  return Math.max(1, Math.round((asset.duration ?? STILL_SECONDS) * project.settings.fps))
}

function isFreeAt(project: Project, track: Track, start: number, duration: number) {
  return clipsOnTrack(project, track.id).every((c) => clipEnd(c) <= start || c.start >= start + duration)
}

export type AudioRole = 'voice' | 'music' | 'sfx'

const ROLE_TRACK: Record<AudioRole, RegExp> = {
  voice: /voice|\bvo\b|narrat|dialog|interview|speech/i,
  music: /music|score|song|soundtrack|\bbed\b/i,
  sfx: /sfx|sound|effect|foley/i,
}
const ROLE_NAME: Record<AudioRole, string> = { voice: 'Voice', music: 'Music', sfx: 'Sound effects' }

/** What kind of sound an audio asset is — from its tags, where it came from, its transcript or its name. Null when it can't tell. */
export function audioRole(asset: Asset): AudioRole | null {
  const source = `${asset.provenance?.integration ?? ''} ${asset.provenance?.tool ?? ''}`.toLowerCase()
  const name = asset.name.toLowerCase()
  if (asset.tags?.includes('sfx') || /sfx|sound[-_ ]?(effect|generation)/.test(source) || /\b(sfx|whoosh|swoosh|impact|riser|hit|click|pop|ding|foley)\b/.test(name)) return 'sfx'
  if (asset.tags?.includes('music') || /music|song|soundtrack/.test(source) || /\b(music|song|soundtrack|score|beat|bgm|instrumental)\b/.test(name)) return 'music'
  if (asset.transcript?.length || /speech|voice|tts|record/.test(source) || /\b(voice|vo|voiceover|narration|narrator|interview|podcast|recording)\b/.test(name)) return 'voice'
  return null
}

/** Best existing track for a clip kind at a frame, or null if a new track is needed. */
export function pickTrack(project: Project, kind: ClipKind, frame: number, duration: number, preferred?: string, overlay = false, role: AudioRole | null = null): Track | null {
  const candidates = project.tracks.filter((t) => !t.locked && trackAccepts(t, kind))
  const pref = candidates.find((t) => t.id === preferred)
  if (pref) return pref
  // Sounds go on the track made for them: effects on Sound effects, music on Music, speech on Voice.
  if (kind === 'audio' && role) return candidates.find((t) => ROLE_TRACK[role].test(t.name) && isFreeAt(project, t, frame, duration)) ?? null
  if (kind === 'text') return candidates.find((t) => t.role === 'titles') ?? candidates[0] ?? null
  // Transparent renders (3D titles, lower thirds) sit above the footage, never in the main story.
  if (overlay) return candidates.find((t) => t.role !== 'main' && t.role !== 'titles' && isFreeAt(project, t, frame, duration)) ?? null
  if (kind === 'video' || kind === 'image') {
    // Footage goes on the magnetic main track, inserted at the playhead's cut.
    const main = candidates.find((t) => t.role === 'main')
    if (main) return main
    return candidates.find((t) => t.role !== 'titles' && isFreeAt(project, t, frame, duration)) ?? candidates[0] ?? null
  }
  return candidates.find((t) => isFreeAt(project, t, frame, duration)) ?? null
}

function ensureTrack(kind: ClipKind, frame: number, duration: number, preferred?: string, source: ActionSource = 'user', overlay = false, role: AudioRole | null = null) {
  const project = getProject()
  const track = pickTrack(project, kind, frame, duration, preferred, overlay, role)
  if (track) return track.id
  const res = dispatch('track.add', { kind: kind === 'audio' ? 'audio' : 'video', ...(role ? { name: ROLE_NAME[role] } : {}) }, { source })
  return res.ok ? (res.result as string) : null
}

/** Puts a clip playing another timeline (nesting it) at `frame`: picture and sound, or just sound on an audio track. */
export function placeSequence(sequenceId: string, frame: number, opts: { trackId?: string; source?: ActionSource } = {}) {
  const project = getProject()
  const seq = project.sequences?.[sequenceId]
  if (!seq) {
    toast(sequenceId in (project.sequences ?? {}) ? 'Timeline missing' : 'A timeline can’t contain itself')
    return null
  }
  const duration = sourceFrames(project, { sequenceId })
  const wanted = opts.trackId ? project.tracks.find((t) => t.id === opts.trackId) : undefined
  const kind: ClipKind = wanted?.kind === 'audio' ? 'audio' : 'video'
  let clipId: string | null = null
  useEditor.getState().transaction(`Add ${seq.name}`, opts.source ?? 'user', () => {
    const trackId = ensureTrack(kind, frame, duration, opts.trackId, opts.source)
    if (!trackId) return
    const res = dispatch('clip.add', { trackId, kind, start: frame, duration, sequenceId })
    if (res.ok) clipId = res.result as string
    else toast(res.error)
  })
  return clipId
}

export function placeAsset(assetId: string, frame: number, opts: { trackId?: string; source?: ActionSource } = {}) {
  const project = getProject()
  const asset = project.assets[assetId]
  if (!asset) return null
  const duration = assetFrames(project, asset)
  let clipId: string | null = null
  useEditor.getState().transaction(`Add ${asset.name}`, opts.source ?? 'user', () => {
    const trackId = ensureTrack(asset.kind, frame, duration, opts.trackId, opts.source, Boolean(asset.alpha), asset.kind === 'audio' ? audioRole(asset) : null)
    if (!trackId) return
    const res = dispatch('clip.add', { trackId, kind: asset.kind, start: frame, duration, assetId, name: asset.name })
    if (res.ok) clipId = res.result as string
  })
  return clipId
}

export function placeTitle(presetId: string, frame: number, opts: { trackId?: string; content?: string; source?: ActionSource } = {}) {
  const preset = TITLE_PRESETS.find((p) => p.id === presetId) ?? TITLE_PRESETS[0]
  const project = getProject()
  const duration = Math.round(preset.duration * project.settings.fps)
  let clipId: string | null = null
  useEditor.getState().transaction(`Add ${preset.name} title`, opts.source ?? 'user', () => {
    const trackId = ensureTrack('text', frame, duration, opts.trackId, opts.source)
    if (!trackId) return
    const content = opts.content ?? preset.sample
    const res = dispatch('clip.add', {
      trackId,
      kind: 'text',
      start: frame,
      duration,
      name: content.split('\n')[0],
      patch: { text: { ...preset.text, content }, transform: preset.transform, animation: preset.animation },
    })
    if (res.ok) clipId = res.result as string
  })
  return clipId
}

const visualKinds = new Set<ClipKind>(['video', 'image', 'text', 'adjustment'])

export function applyEffect(kind: EffectKind, clipIds: string[], source: ActionSource = 'user') {
  const project = getProject()
  const ids = clipIds.filter((id) => project.clips[id] && visualKinds.has(project.clips[id].kind))
  if (!ids.length) {
    toast('Select a video, image or title clip first')
    return false
  }
  return dispatch('effect.add', { ids, kind }, { source }).ok
}

export function applyLook(lookId: string, clipIds: string[], source: ActionSource = 'user') {
  const look = LOOKS.find((l) => l.id === lookId)
  const project = getProject()
  const ids = clipIds.filter((id) => project.clips[id] && project.clips[id].kind !== 'audio' && project.clips[id].kind !== 'text')
  if (!look || !ids.length) {
    toast('Select a video or image clip to apply a look')
    return false
  }
  return dispatch('clip.update', { ids, patch: { color: look.grade, look: look.id } }, { source, label: `Apply ${look.name} look` }).ok
}

export interface TransitionSpot {
  /** The clip after the cut: the one that carries the transition. */
  clipId: string
  align: TransitionAlign
}

/**
 * Where a transition aimed at a clip goes. A clip has a cut at each end that
 * touches another clip: `frame` (the timeline frame pointed at) picks the
 * nearer one. Right on a cut (within `near` frames) the transition is centred
 * on it; further into the clip it stays on that clip — at the end of the first
 * clip, or the start of the second. Null when the clip touches no other.
 */
export function transitionSpot(project: Project, clip: Clip, frame?: number, near = 0): TransitionSpot | null {
  if (clip.kind === 'audio') return null
  const prev = adjacentBefore(project, clip)
  const next = adjacentAfter(project, clip)
  if (!prev && !next) return null
  const at = frame ?? clip.start
  if (prev && (!next || at < clip.start + clip.duration / 2)) return { clipId: clip.id, align: frame !== undefined && at - clip.start <= near ? 'center' : 'after' }
  return { clipId: next!.id, align: frame !== undefined && clipEnd(clip) - at <= near ? 'center' : 'before' }
}

/** Puts a transition on the cut before `clipId` (see {@link transitionSpot} for choosing it). */
export function applyTransition(kind: TransitionKind, clipId: string, source: ActionSource = 'user', align?: TransitionAlign) {
  const project = getProject()
  const clip = project.clips[clipId]
  if (!clip || clip.kind === 'audio') return false
  if (!adjacentBefore(project, clip)) {
    toast('Transitions go on a cut', { description: 'Drop it where two clips touch on a track: on the end of the first, on the cut, or on the start of the second.' })
    return false
  }
  // Keeps the length of a transition that is only being swapped or moved.
  const duration = clip.transitionIn?.duration ?? Math.round(project.settings.fps * 0.6)
  return dispatch('clip.setTransition', { id: clipId, transition: { kind, duration, ...(align ? { align } : {}) } }, { source }).ok
}
