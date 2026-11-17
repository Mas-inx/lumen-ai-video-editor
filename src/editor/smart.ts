/**
 * Smart edits: multi-step edits that analyse the actual media — speech found
 * from transcripts or measured from the audio itself. Used by one-click
 * suggestions in the UI and exposed as tools to every Copilot brain.
 */
import { activeRegions, activeRegionsStreamed, isAudible, isLongAudio, loadAudio } from '@/engine/audio-engine'
import { speechScript } from '@/engine/audio'
import { clipEnd } from './ops'
import { dispatch, getProject, useEditor, type ActionSource } from './store'
import { reframeOffset, type Focus } from './subject-frame'
import { captionStyle, layCaptions, type CaptionStyle } from './subtitles'
import { consumed, localForSource } from './timing'
import type { Clip, Project, SpeechSegment } from './types'

const ai = { source: 'ai' as const }

// ─── Speech ──────────────────────────────────────────────────────────────

/**
 * Where sound happens in an asset (source seconds). Measured from the audio when
 * it can be decoded — exact to 20 ms — otherwise the transcript's phrase timings.
 */
const activityCache = new Map<string, [number, number][]>()

export async function speechRegions(project: Project, clip: Clip): Promise<{ regions: [number, number][]; from: 'transcript' | 'audio' } | null> {
  const asset = clip.assetId ? project.assets[clip.assetId] : undefined
  if (!asset) return null
  if (isAudible(project, clip)) {
    const key = `${asset.id}|${asset.source.type === 'file' ? asset.source.url : ''}`
    let regions = activityCache.get(key)
    if (!regions) {
      if (isLongAudio(asset)) regions = (await activeRegionsStreamed(asset)) ?? undefined
      else {
        const buffer = await loadAudio(asset)
        if (buffer) regions = activeRegions(buffer)
      }
      if (regions) activityCache.set(key, regions)
    }
    if (regions) return { regions, from: 'audio' }
  }
  const script = speechScript(asset)
  return script.length ? { regions: script.map((s) => [s.start, s.end] as [number, number]), from: 'transcript' } : null
}

/** The part of a clip's source (seconds) that's on the timeline. */
export function sourceRange(project: Project, clip: Clip): [number, number] {
  const fps = project.settings.fps
  return [clip.inPoint / fps, (clip.inPoint + consumed(clip)) / fps]
}

/** The timeline frame where a clip shows a source second (clamped to the clip) — speed ramps included. */
export function toTimeline(project: Project, clip: Clip, sourceSec: number) {
  const src = sourceSec * project.settings.fps
  const local = localForSource(clip, src)
  if (local !== null) return clip.start + local
  const before = src < clip.inPoint
  return clip.start + (before !== clip.reverse ? 0 : clip.duration)
}

const VOICE_TRACK = /voice|vo\b|dialog|narrat|interview|speech/i

/** Where speech is expected first: the main track and voice-ish tracks. */
export const speechTrack = (project: Project, clip: Clip) => {
  const track = project.tracks.find((t) => t.id === clip.trackId)
  return Boolean(track && (track.role === 'main' || VOICE_TRACK.test(track.name)))
}

/**
 * Clips that carry speech: anything with a transcript, or sound on a voice-ish
 * track or the main track. A silent copy — sound detached, a freeze frame, or
 * turned all the way down (B-roll from the interview, a cut-out subject) —
 * isn't speech, transcript or not.
 */
export function voiceClips(project: Project): Clip[] {
  return Object.values(project.clips)
    .filter((c) => {
      if (c.kind !== 'audio' && c.kind !== 'video') return false
      const asset = c.assetId ? project.assets[c.assetId] : undefined
      if (!asset) return false
      if (c.freeze || (c.kind === 'video' && c.audio.detached) || c.audio.volume <= -60) return false
      if (speechScript(asset).length) return true
      return isAudible(project, c) && speechTrack(project, c)
    })
    .sort((a, b) => a.start - b.start)
}

export interface TimelineLine {
  /** Timeline seconds. */
  start: number
  end: number
  text: string
  clipId: string
  /** Only part of the line is on the timeline (a cut runs through it). */
  partial?: boolean
}

/** What's said on the timeline and when — every transcribed speech clip, in timeline seconds. */
export function timelineTranscript(project: Project, from = 0, to = Infinity): TimelineLine[] {
  const fps = project.settings.fps
  const out: TimelineLine[] = []
  for (const clip of voiceClips(project)) {
    if (clip.reverse) continue
    const script = speechScript(project.assets[clip.assetId!])
    const [s0, s1] = sourceRange(project, clip)
    for (const seg of script) {
      if (seg.end <= s0 || seg.start >= s1) continue
      const start = toTimeline(project, clip, Math.max(seg.start, s0)) / fps
      const end = toTimeline(project, clip, Math.min(seg.end, s1)) / fps
      if (end <= from || start >= to) continue
      out.push({ start, end, text: seg.text, clipId: clip.id, ...(seg.start < s0 || seg.end > s1 ? { partial: true } : {}) })
    }
  }
  return out.sort((a, b) => a.start - b.start)
}

// ─── Words ───────────────────────────────────────────────────────────────

/** A phrase's words, in source seconds: as the transcriber timed them, or spread over the phrase by their length. */
export function phraseWords(seg: SpeechSegment): { start: number; end: number; text: string; timed: boolean }[] {
  const given = seg.words?.filter((w) => w.text.trim() && Number.isFinite(w.start) && Number.isFinite(w.end))
  if (given?.length) return given.map((w) => ({ start: w.start, end: Math.max(w.start, w.end), text: w.text.trim(), timed: true }))
  const parts = seg.text.split(/\s+/).filter(Boolean)
  const weights = parts.map((p) => p.replace(/[^\p{L}\p{N}]/gu, '').length + 1)
  const total = weights.reduce((s, w) => s + w, 0) || 1
  let t = seg.start
  return parts.map((text, i) => {
    const d = ((seg.end - seg.start) * weights[i]) / total
    const w = { start: t, end: t + d, text, timed: false }
    t += d
    return w
  })
}

export interface TimelineWord {
  /** Timeline seconds. */
  start: number
  end: number
  text: string
  clipId: string
  /** The track it's heard on: the speech on one track is one voice. */
  lane: string
  assetId: string
  /** Seconds into the media where it starts. */
  source: number
  /** The transcriber timed this word itself; otherwise its timing is spread across its phrase. */
  timed: boolean
  /** It starts / ends its phrase — an edge the transcriber timed even when the word isn't. */
  phraseStart?: boolean
  phraseEnd?: boolean
}

const wordKey = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

/**
 * Every word said on the timeline, in timeline seconds, sorted. Speech heard
 * twice — an audible copy of the interview on another track, a camera's own
 * sound under the lav — is listed once, from the main and voice tracks first.
 */
export function timelineWords(project: Project): TimelineWord[] {
  const fps = project.settings.fps
  const clips = voiceClips(project)
    .filter((c) => !c.reverse && speechScript(project.assets[c.assetId!]).length)
    .sort((a, b) => Number(speechTrack(project, b)) - Number(speechTrack(project, a)) || a.start - b.start)
  const heard: { a: number; b: number; keys: Set<string>; clipId: string }[] = []
  const out: TimelineWord[] = []
  for (const clip of clips) {
    const asset = project.assets[clip.assetId!]
    const [s0, s1] = sourceRange(project, clip)
    for (const seg of speechScript(asset)) {
      if (seg.end <= s0 || seg.start >= s1) continue
      const all = phraseWords(seg)
      const words: TimelineWord[] = []
      all.forEach((w, i) => {
        // Only words mostly on the timeline: a cut through a word leaves it to the side that has most of it.
        const mid = (w.start + w.end) / 2
        if (mid < s0 || mid >= s1) return
        const start = toTimeline(project, clip, Math.max(w.start, s0)) / fps
        const end = toTimeline(project, clip, Math.min(w.end, s1)) / fps
        if (end <= start) return
        words.push({ start, end, text: w.text, clipId: clip.id, lane: clip.trackId, assetId: asset.id, source: w.start, timed: w.timed, ...(i === 0 ? { phraseStart: true } : {}), ...(i === all.length - 1 ? { phraseEnd: true } : {}) })
      })
      if (!words.length) continue
      const a = words[0].start
      const b = words[words.length - 1].end
      const keys = new Set(words.map((w) => wordKey(w.text)).filter(Boolean))
      const twice = heard.some((h) => {
        if (h.clipId === clip.id || Math.min(b, h.b) - Math.max(a, h.a) <= (b - a) / 2) return false
        let same = 0
        for (const k of keys) if (h.keys.has(k)) same++
        return same >= keys.size * 0.6
      })
      if (twice) continue
      heard.push({ a, b, keys, clipId: clip.id })
      out.push(...words)
    }
  }
  return out.sort((x, y) => x.start - y.start)
}

/** "1:02.5" */
const clock = (sec: number) => {
  const m = Math.floor(sec / 60)
  return `${m}:${(sec - m * 60).toFixed(1).padStart(4, '0')}`
}

/**
 * Keeps the words the transcriber timed out of pause cuts, with a breath either
 * side: the sound can miss a quiet word, the transcript doesn't. A piece of a
 * pause too short to matter is left alone.
 */
function spareWords(project: Project, cuts: [number, number][], pad: number, minLen: number, notes?: string[]): [number, number][] {
  const fps = project.settings.fps
  const words = timelineWords(project).filter((w) => w.timed)
  if (!words.length) return cuts
  const out: [number, number][] = []
  for (const cut of cuts) {
    const a = cut[0] / fps
    const b = cut[1] / fps
    const inside = words.filter((w) => Math.min(b, w.end) - Math.max(a, w.start) > 0.04)
    if (!inside.length) {
      out.push(cut)
      continue
    }
    const kept = subtractSpans([cut], inside.map((w) => [Math.floor((w.start - pad) * fps), Math.ceil((w.end + pad) * fps)]))
    out.push(...kept.filter(([x, y]) => y - x >= minLen))
    notes?.push(`Kept “${inside.map((w) => w.text).join(' ')}” at ${clock(inside[0].start)}: the transcript has ${inside.length > 1 ? 'those words' : 'that word'} inside the pause.`)
  }
  return out
}

/** Music beds: audible audio clips on music-ish tracks, or long audio without speech elsewhere. */
export function musicClips(project: Project): Clip[] {
  const voices = new Set(voiceClips(project).map((c) => c.id))
  return Object.values(project.clips).filter((c) => {
    if (c.kind !== 'audio' || voices.has(c.id) || !isAudible(project, c)) return false
    const track = project.tracks.find((t) => t.id === c.trackId)
    if (track && /music|score|song|soundtrack|bed/i.test(track.name)) return true
    const asset = project.assets[c.assetId!]
    return (asset?.duration ?? 0) >= 20 && !/sfx|effect|sound/i.test(track?.name ?? '')
  })
}

// ─── Pauses ──────────────────────────────────────────────────────────────

export interface PauseReport {
  clip: Clip
  /** Timeline frames [start, end) to remove. */
  cuts: [number, number][]
  seconds: number
  from: 'transcript' | 'audio'
}

/** Silences longer than `minGap` seconds inside speech clips (keeping `pad` seconds of breath either side). */
export async function findPauses(project: Project, opts: { clipIds?: string[]; minGap?: number; pad?: number } = {}): Promise<PauseReport[]> {
  const minGap = opts.minGap ?? 0.6
  const pad = opts.pad ?? 0.12
  const fps = project.settings.fps
  const clips = opts.clipIds?.length ? opts.clipIds.map((id) => project.clips[id]).filter((c): c is Clip => Boolean(c)) : voiceClips(project)
  const out: PauseReport[] = []
  for (const clip of clips) {
    if (clip.reverse) continue
    const speech = await speechRegions(project, clip)
    if (!speech) continue
    const [s0, s1] = sourceRange(project, clip)
    const segs = speech.regions.filter(([a, b]) => b > s0 && a < s1).sort((x, y) => x[0] - y[0])
    const cuts: [number, number][] = []
    let seconds = 0
    for (let i = 0; i < segs.length - 1; i++) {
      const a = Math.max(s0, segs[i][1])
      const b = Math.min(s1, segs[i + 1][0])
      if (b - a < minGap) continue
      const ta = Math.round(toTimeline(project, clip, a + pad))
      const tb = Math.round(toTimeline(project, clip, b - pad))
      if (tb - ta >= 2) {
        cuts.push([ta, tb])
        seconds += (tb - ta) / fps
      }
    }
    if (cuts.length) out.push({ clip, cuts, seconds, from: speech.from })
  }
  return out
}

/** Where a speech clip has speech, in timeline frames (padded). Unknown speech counts as all of it. */
async function speechSpans(project: Project, clip: Clip, pad: number): Promise<[number, number][]> {
  const speech = clip.reverse ? null : await speechRegions(project, clip)
  if (!speech) return [[clip.start, clipEnd(clip)]]
  const [s0, s1] = sourceRange(project, clip)
  return speech.regions
    .filter(([a, b]) => b > s0 && a < s1)
    .map(([a, b]) => [Math.floor(toTimeline(project, clip, Math.max(s0, a - pad))), Math.ceil(toTimeline(project, clip, Math.min(s1, b + pad)))])
}

function subtractSpans(pieces: [number, number][], spans: [number, number][]) {
  let out = pieces
  for (const [s, e] of spans) {
    out = out.flatMap(([a, b]): [number, number][] => {
      if (e <= a || s >= b) return [[a, b]]
      const keep: [number, number][] = []
      if (s > a) keep.push([a, s])
      if (e < b) keep.push([e, b])
      return keep
    })
  }
  return out
}

/**
 * The timeline stretches the pauses in `reports` can remove: only where every
 * speech clip is quiet — one speaker's pause may be another's line — and never
 * through a word the transcript has there. Sorted, merged. `notes` collects the
 * words kept out of a cut.
 */
export async function silentCuts(project: Project, reports: PauseReport[], opts: { minGap?: number; pad?: number; notes?: string[] } = {}) {
  const pad = opts.pad ?? 0.12
  const minLen = Math.max(2, Math.round(((opts.minGap ?? 0.6) - 2 * pad) * project.settings.fps))
  const voices = voiceClips(project)
  const spanCache = new Map<string, [number, number][]>()
  const cuts: [number, number][] = []
  for (const r of reports) {
    for (const cut of r.cuts) {
      let pieces: [number, number][] = [cut]
      for (const other of voices) {
        if (other.id === r.clip.id || other.start >= cut[1] || clipEnd(other) <= cut[0]) continue
        let spans = spanCache.get(other.id)
        if (!spans) spanCache.set(other.id, (spans = await speechSpans(project, other, pad)))
        pieces = subtractSpans(pieces, spans)
      }
      const untouched = pieces.length === 1 && pieces[0][0] === cut[0] && pieces[0][1] === cut[1]
      cuts.push(...(untouched ? pieces : pieces.filter(([a, b]) => b - a >= minLen)))
    }
  }
  cuts.sort((x, y) => x[0] - y[0])
  const merged: [number, number][] = []
  for (const [a, b] of cuts) {
    const last = merged[merged.length - 1]
    if (last && a <= last[1]) last[1] = Math.max(last[1], b)
    else merged.push([a, b])
  }
  return spareWords(project, merged, pad, minLen, opts.notes)
}

export interface RippleResult {
  /** The stretches taken out (frames, as they were before the edit), in order. */
  removed: [number, number][]
  /** Where each join landed once the stretches before it closed up too (frames). */
  joins: number[]
  seconds: number
}

/**
 * Takes stretches (frames, not overlapping) out of the whole timeline as one
 * undo step. Everything after each one closes up, so captions, B-roll, effects,
 * markers and keyframes stay in sync — while music and other sound beds play on
 * through the joins instead of being chopped up.
 */
export function rippleRemove(cuts: [number, number][], label: string, source: ActionSource = 'ai'): RippleResult {
  const project = getProject()
  const speech = new Set(voiceClips(project).map((c) => c.id))
  const keepWhole = Object.values(project.clips)
    .filter((c) => c.kind === 'audio' && !speech.has(c.id))
    .map((c) => c.id)
  const removed: [number, number][] = []
  useEditor.getState().transaction(label, source, () => {
    // Last stretch first, so earlier positions stay valid as later ones close up.
    for (const [a, b] of [...cuts].sort((x, y) => y[0] - x[0])) {
      if (dispatch('timeline.removeRange', { start: a, end: b, keepWhole }, { source }).ok) removed.unshift([a, b])
    }
  })
  let shift = 0
  const joins = removed.map(([a, b]) => {
    const at = a - shift
    shift += b - a
    return at
  })
  return { removed, joins, seconds: shift / project.settings.fps }
}

/**
 * Cuts the pauses out of the speech. The whole timeline closes up around each
 * one, so captions, B-roll, effects and markers stay in sync — while music and
 * other sound beds play on through the joins instead of being chopped up. A word
 * the transcript has inside a pause stays (`notes` says which).
 */
export async function removePauses(opts: { clipIds?: string[]; minGap?: number } = {}) {
  const project = getProject()
  const notes: string[] = []
  const cuts = await silentCuts(project, await findPauses(project, opts), { ...opts, notes })
  const r = rippleRemove(cuts, 'Remove pauses')
  const after = getProject()
  const touched = voiceClips(after)
    .filter((c) => r.joins.some((f) => c.start === f || clipEnd(c) === f))
    .map((c) => c.id)
  return { removed: r.removed.length, seconds: r.seconds, clips: touched, notes }
}

// ─── Captions ────────────────────────────────────────────────────────────

function captionChunks(text: string, maxWords: number) {
  const words = text.split(/\s+/).filter(Boolean)
  const n = Math.max(1, Math.ceil(words.length / maxWords))
  const size = Math.ceil(words.length / n)
  const chunks: string[] = []
  for (let i = 0; i < words.length; i += size) chunks.push(words.slice(i, i + size).join(' '))
  return chunks
}

/** Speech clips whose media has no transcript yet (captions need one). */
export function untranscribed(project: Project) {
  const ids = new Set<string>()
  for (const c of voiceClips(project)) {
    const asset = project.assets[c.assetId!]
    if (!speechScript(asset).length) ids.add(asset.id)
  }
  return [...ids]
}

/** Lays captions from every transcribed speech clip on a Captions track (replacing previous captions). */
export function addCaptions(opts: { maxWords?: number; size?: number; y?: number; uppercase?: boolean; style?: CaptionStyle; accent?: string; source?: 'user' | 'ai' } = {}) {
  const project = getProject()
  const maxWords = opts.maxWords ?? captionStyle(opts.style).words
  const lines: { start: number; end: number; text: string }[] = []
  // Two clips talking at once (the same interview on two tracks) would garble
  // each other's captions: the main and voice tracks speak first, and a phrase
  // mostly covered by one already captioned is left out.
  const clips = voiceClips(project).sort((a, b) => Number(speechTrack(project, b)) - Number(speechTrack(project, a)) || a.start - b.start)
  const spoken: [number, number][] = []
  const covered = (a: number, b: number) => spoken.reduce((sum, [x, y]) => sum + Math.max(0, Math.min(b, y) - Math.max(a, x)), 0) > (b - a) / 2
  for (const clip of clips) {
    const script = speechScript(project.assets[clip.assetId!])
    if (!script.length) continue
    const [s0, s1] = sourceRange(project, clip)
    for (const seg of script) {
      if (seg.end <= s0 || seg.start >= s1) continue
      const a = toTimeline(project, clip, Math.max(seg.start, s0))
      const b = toTimeline(project, clip, Math.min(seg.end, s1))
      if (b <= a || covered(a, b)) continue
      spoken.push([a, b])
      const chunks = captionChunks(seg.text, maxWords)
      const weights = chunks.map((c) => c.length + 2)
      const total = weights.reduce((x, y) => x + y, 0)
      let t = a
      chunks.forEach((c, i) => {
        const d = ((b - a) * weights[i]) / total
        lines.push({ start: Math.round(t), end: Math.round(t + d), text: c })
        t += d
      })
    }
  }
  if (!lines.length) return { added: 0, trackId: null as string | null }
  const { ids, trackId } = layCaptions(lines, { label: 'Add captions', source: opts.source ?? 'ai', size: opts.size, y: opts.y, uppercase: opts.uppercase, style: opts.style, accent: opts.accent })
  return { added: ids.length, trackId }
}

// ─── Ducking ─────────────────────────────────────────────────────────────

/** Lowers music under speech with volume keyframes (merging close phrases so it doesn't pump). */
export async function duckMusic(opts: { depth?: number; musicClipIds?: string[]; voiceClipIds?: string[] } = {}) {
  const project = getProject()
  const fps = project.settings.fps
  const depth = opts.depth ?? 10
  const music = opts.musicClipIds?.length ? opts.musicClipIds.map((id) => project.clips[id]).filter(Boolean) : musicClips(project)
  const voices = opts.voiceClipIds?.length ? opts.voiceClipIds.map((id) => project.clips[id]).filter(Boolean) : voiceClips(project)
  if (!music.length || !voices.length) return { ducked: 0, regions: 0 }
  // Speech on the timeline, in frames.
  let regions: [number, number][] = []
  for (const v of voices) {
    const speech = await speechRegions(project, v)
    const [s0, s1] = sourceRange(project, v)
    const spans = speech ? speech.regions.filter(([a, b]) => b > s0 && a < s1) : [[s0, s1] as [number, number]]
    for (const [a, b] of spans) {
      const x = toTimeline(project, v, Math.max(a, s0))
      const y = toTimeline(project, v, Math.min(b, s1))
      regions.push([Math.min(x, y), Math.max(x, y)])
    }
  }
  regions.sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const r of regions) {
    const last = merged[merged.length - 1]
    if (last && r[0] - last[1] < fps * 0.8) last[1] = Math.max(last[1], r[1])
    else merged.push([r[0], r[1]])
  }
  regions = merged
  const ramp = Math.round(fps * 0.25)
  let ducked = 0
  useEditor.getState().transaction('Duck music under speech', 'ai', () => {
    for (const m of music) {
      const base = m.audio.volume
      const kfs: { frame: number; value: number }[] = []
      for (const [a0, b0] of regions) {
        const a = Math.round(a0) - m.start
        const b = Math.round(b0) - m.start
        if (b <= 0 || a >= m.duration) continue
        kfs.push({ frame: Math.max(0, a - ramp), value: base }, { frame: Math.max(0, a), value: base - depth }, { frame: Math.min(m.duration, b), value: base - depth }, { frame: Math.min(m.duration, b + ramp), value: base })
      }
      if (!kfs.length) continue
      dispatch('keyframe.clear', { clipId: m.id, prop: 'volume' }, ai)
      const seen = new Set<number>()
      for (const k of kfs) {
        if (seen.has(k.frame)) continue
        seen.add(k.frame)
        dispatch('keyframe.set', { clipId: m.id, prop: 'volume', frame: k.frame, value: k.value, easing: 'ease' }, ai)
      }
      ducked++
    }
  })
  return { ducked, regions: regions.length }
}

// ─── Canvas ──────────────────────────────────────────────────────────────

/**
 * Changes the canvas size and reframes: media that filled the old frame is
 * scaled to fill the new one (centered crop), titles move and resize proportionally.
 */
/**
 * Changes the canvas size and reframes: footage that filled the old frame is
 * scaled to fill the new one — placed by `focus` (where its subject is, see
 * project/reframe-actions.ts) or else kept where it was — and titles move and
 * resize to match. One undo step.
 */
export function reframe(width: number, height: number, source: 'user' | 'ai' = 'ai', focus?: (clip: Clip) => Pick<Focus, 'x' | 'y'> | undefined) {
  const how = { source }
  const project = getProject()
  const { width: W0, height: H0 } = project.settings
  if (W0 === width && H0 === height) return { changed: false }
  const sx = width / W0
  const sy = height / H0
  const textScale = Math.sqrt(Math.min(sx, sy) * Math.max(Math.min(sx, sy), 0.5))
  useEditor.getState().transaction(`Canvas ${width}×${height}`, source, () => {
    dispatch('project.update', { settings: { width, height } }, how)
    for (const c of Object.values(getProject().clips)) {
      if (c.kind === 'text') {
        dispatch('clip.update', { ids: [c.id], patch: { transform: { x: Math.round(c.transform.x * sx), y: Math.round(c.transform.y * sy) }, text: { size: Math.round((c.text?.size ?? 96) * textScale) } } }, how)
      } else if ((c.kind === 'video' || c.kind === 'image') && c.assetId) {
        const asset = getProject().assets[c.assetId]
        if (!asset?.width || !asset.height || Math.abs(c.transform.scale - 1) > 0.001 || asset.alpha) continue
        const containOld = Math.min(W0 / asset.width, H0 / asset.height)
        const coverOld = Math.max(W0 / asset.width, H0 / asset.height)
        // Only reframe media that filled the old canvas.
        if (Math.abs(containOld - coverOld) / coverOld > 0.02) continue
        const containNew = Math.min(width / asset.width, height / asset.height)
        const coverNew = Math.max(width / asset.width, height / asset.height)
        const f = focus?.(c)
        const at = f ? reframeOffset({ mediaW: asset.width, mediaH: asset.height, canvasW: width, canvasH: height, focus: f }) : { x: Math.round(c.transform.x * sx), y: Math.round(c.transform.y * sy) }
        dispatch('clip.update', { ids: [c.id], patch: { transform: { scale: Math.round((coverNew / containNew) * 1000) / 1000, x: at.x, y: at.y } } }, how)
      }
    }
  })
  return { changed: true }
}

// ─── Suggestions ─────────────────────────────────────────────────────────

export interface Suggestion {
  id: string
  text: string
  action: string
  run: () => Promise<string>
}

/** One proactive suggestion for the timeline toolbar, from real analysis of the edit. */
export async function suggestFor(project: Project): Promise<Suggestion | null> {
  const voices = voiceClips(project)
  if (!voices.length) return null
  // Exactly what Tighten will cut — only where every speaker is quiet.
  const cuts = await silentCuts(project, await findPauses(project))
  const count = cuts.length
  if (count >= 2) {
    const secs = cuts.reduce((s, [a, b]) => s + b - a, 0) / project.settings.fps
    return {
      id: `pauses-${count}-${Math.round(secs * 10)}`,
      text: `${count} long pauses (${secs.toFixed(1)}s) in your speech`,
      action: 'Tighten',
      run: async () => {
        const r = await removePauses()
        return `Removed ${r.removed} pauses (${r.seconds.toFixed(1)}s)`
      },
    }
  }
  const music = musicClips(project)
  if (music.length && !music.some((m) => m.keyframes.volume?.length)) {
    return {
      id: 'duck',
      text: 'Music plays at full level under speech',
      action: 'Duck it',
      run: async () => {
        const r = await duckMusic()
        return r.ducked ? `Ducked ${r.ducked} music clip${r.ducked > 1 ? 's' : ''} under ${r.regions} stretches of speech` : 'Nothing to duck'
      },
    }
  }
  return null
}

