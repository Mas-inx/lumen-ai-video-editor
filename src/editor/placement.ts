/**
 * Higher-level placement helpers ("put this on the timeline sensibly") used by
 * the asset browser, drag & drop, the command palette and the AI agent.
 */
import { toast } from 'sonner'
import { LOOKS, TITLE_PRESETS } from './presets'
import { adjacentBefore, clipEnd, clipsOnTrack, trackAccepts } from './ops'
import { dispatch, getProject, useEditor } from './store'
import type { ActionSource } from './store'
import type { Asset, ClipKind, EffectKind, Project, Track, TransitionKind } from './types'

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

export function applyTransition(kind: TransitionKind, clipId: string, source: ActionSource = 'user') {
  const project = getProject()
  const clip = project.clips[clipId]
  if (!clip || clip.kind === 'audio') return false
  if (!adjacentBefore(project, clip)) {
    toast('Transitions go on a cut — drop it on a clip that follows another')
    return false
  }
  const duration = Math.min(Math.round(project.settings.fps * 0.6), clip.duration)
  return dispatch('clip.setTransition', { id: clipId, transition: { kind, duration } }, { source }).ok
}
