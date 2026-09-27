/**
 * The AI's ears and memory: what's under a moment, full clip details, media
 * search (including inside transcripts), timed transcripts, loudness and
 * silence analysis, the undo history and the catalog of valid ids.
 */
import { BLEND_MODES, EASINGS } from '@/editor/commands'
import { FONTS } from '@/editor/defaults'
import { propAt } from '@/editor/keyframes'
import { CANVAS_PRESETS } from '@/editor/new-project'
import { clipEnd, projectDuration } from '@/editor/ops'
import { ANIMATIONS, EFFECTS, LOOKS, TITLE_PRESETS, TRANSITIONS } from '@/editor/presets'
import { timelineTranscript, untranscribed } from '@/editor/smart'
import { getProject, useEditor } from '@/editor/store'
import { consumed, isRamped } from '@/editor/timing'
import type { Asset, Clip, Project } from '@/editor/types'
import { activeRegions, isAudible, loadAudio, prepareAudio, renderMix } from '@/engine/audio-engine'
import { speechScript } from '@/engine/audio'
import { clipSourceTime } from '@/engine/compositor'
import { measureLoudness } from '@/engine/loudness'
import { SFX } from '@/engine/sfx'
import { assetById, bool, clampNum, frameArg, int, list, num, number, obj, oneOf, rangeArg, seconds, str, text, trackName, type AgentTool } from './kit'

const round = (v: number, digits = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** digits) / 10 ** digits : null)

/** One clip, as a tool reports it at a glance. */
function clipLine(p: Project, clip: Clip, frame?: number) {
  const fps = p.settings.fps
  const asset = clip.assetId ? p.assets[clip.assetId] : undefined
  const local = frame !== undefined ? frame - clip.start : undefined
  return {
    clip_id: clip.id,
    name: clip.name,
    kind: clip.kind,
    track_id: clip.trackId,
    track: trackName(clip.trackId),
    start_seconds: seconds(clip.start),
    end_seconds: seconds(clipEnd(clip)),
    ...(local !== undefined ? { local_seconds: seconds(local) } : {}),
    ...(asset ? { asset_id: asset.id, ...(local !== undefined ? { source_seconds: round(clipSourceTime(clip, local, fps), 3) } : {}) } : {}),
    ...(clip.text ? { text: clip.text.content } : {}),
    ...(local !== undefined && clip.kind !== 'audio'
      ? {
          transform: {
            x: round(propAt(clip, 'x', local)),
            y: round(propAt(clip, 'y', local)),
            scale: round(propAt(clip, 'scale', local), 3),
            rotation: round(propAt(clip, 'rotation', local)),
            opacity: round(propAt(clip, 'opacity', local), 3),
          },
        }
      : {}),
    ...(local !== undefined && isAudible(p, clip) ? { volume_db: round(propAt(clip, 'volume', local), 1) } : {}),
    ...(isRamped(clip) ? { speed_ramp: clip.keyframes.speed!.map((k) => ({ at_seconds: seconds(k.frame), speed: k.value })) } : clip.speed !== 1 ? { speed: clip.speed } : {}),
    ...(clip.reverse ? { reverse: true } : {}),
    ...(clip.freeze ? { freeze_frame: true } : {}),
    ...(clip.crop ? { crop: clip.crop } : {}),
    ...(clip.groupId ? { group_id: clip.groupId } : {}),
    ...(clip.audio.detached ? { sound_detached: true } : {}),
    ...(clip.effects.length ? { effects: clip.effects.map((e) => e.kind) } : {}),
    ...(clip.look ? { look: clip.look } : {}),
    ...(asset?.source.missing ? { offline: true } : {}),
  }
}

function mediaLine(p: Project, a: Asset) {
  const uses = Object.values(p.clips).filter((c) => c.assetId === a.id).length
  return {
    id: a.id,
    name: a.name,
    kind: a.kind,
    ...(a.duration !== undefined ? { duration_seconds: round(a.duration, 3) } : {}),
    ...(a.width ? { size: `${a.width}x${a.height}` } : {}),
    ...(a.fps ? { fps: round(a.fps, 3) } : {}),
    ...(a.kind === 'video' ? { has_audio: a.hasAudio !== false } : {}),
    ...(a.transcript?.length ? { transcribed: true } : {}),
    ...(a.favorite ? { favorite: true } : {}),
    ...(a.tags?.length ? { tags: a.tags } : {}),
    ...(a.alpha ? { transparent: true } : {}),
    ...(a.generated ? { generated_by: a.provenance?.integration ?? 'ai' } : {}),
    ...(a.source.missing ? { offline: true } : {}),
    ...(a.source.type === 'file' && a.source.path ? { path: a.source.path } : {}),
    on_timeline: uses,
  }
}

/** An AudioBuffer-shaped view of some channels (for the analysis helpers). */
function view(channels: Float32Array[], sampleRate: number) {
  const length = channels[0]?.length ?? 0
  return { sampleRate, length, duration: length / sampleRate, numberOfChannels: channels.length, getChannelData: (c: number) => channels[c] } as unknown as AudioBuffer
}

function audioReport(channels: Float32Array[], sampleRate: number, offset: number) {
  const r = measureLoudness(channels, sampleRate)
  const regions = activeRegions(view(channels, sampleRate)).map(([a, b]) => [round(a + offset, 2)!, round(b + offset, 2)!] as [number, number])
  const end = offset + r.seconds
  const silences: [number, number][] = []
  let cursor = offset
  for (const [a, b] of regions) {
    if (a - cursor >= 1) silences.push([round(cursor, 2)!, a])
    cursor = b
  }
  if (end - cursor >= 1) silences.push([round(cursor, 2)!, round(end, 2)!])
  const advice: string[] = []
  if (r.lufs === null) advice.push('Silent — there is no sound here.')
  else {
    const off = -14 - r.lufs
    if (off > 2) advice.push(`Quieter than online video usually is: ${r.lufs.toFixed(1)} LUFS vs about −14 — raise it by about ${off.toFixed(0)} dB.`)
    else if (off < -2) advice.push(`Loud (${r.lufs.toFixed(1)} LUFS): YouTube and Spotify will turn it down to about −14 — lower it about ${(-off).toFixed(0)} dB for cleaner dynamics.`)
    else advice.push(`Loudness ${r.lufs.toFixed(1)} LUFS — right around the −14 target for online video.`)
    if (r.clipped > 0) advice.push(`${r.clipped} clipped samples — audible distortion; lower the loudest clip or track.`)
    else if (r.peakDb > -1) advice.push(`Peaks reach ${r.peakDb.toFixed(1)} dBFS — keep them below −1 dBFS so encoding doesn’t distort.`)
    if (silences.length) advice.push(`${silences.length} silent stretch${silences.length > 1 ? 'es' : ''} of a second or more.`)
  }
  return {
    seconds: round(r.seconds, 2),
    loudness_lufs: r.lufs === null ? null : round(r.lufs, 1),
    loudest_3s_lufs: r.shortTermMax === null ? null : round(r.shortTermMax, 1),
    peak_dbfs: round(r.peakDb, 1),
    rms_dbfs: round(r.rmsDb, 1),
    clipped_samples: r.clipped,
    sound: regions.slice(0, 80),
    ...(regions.length > 80 ? { sound_more: regions.length - 80 } : {}),
    silences: silences.slice(0, 60),
    advice,
  }
}

function slice(buffer: AudioBuffer, from: number, to: number) {
  const a = Math.max(0, Math.floor(from * buffer.sampleRate))
  const b = Math.min(buffer.length, Math.ceil(to * buffer.sampleRate))
  return Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c).subarray(a, Math.max(a, b)))
}

export const INSPECT_TOOLS: AgentTool[] = [
  {
    name: 'get_clips_at',
    description:
      'Everything under one moment of the timeline, on every track (top layer first): each clip’s times, the source time it shows, and its transform and volume at that exact frame with keyframes applied. Pairs with get_frame. Defaults to the playhead.',
    inputSchema: obj({ time_seconds: num('Timeline time in seconds (default: the playhead)', { minimum: 0 }), frame: int('Timeline frame, instead of time_seconds', { minimum: 0 }) }),
    run: async (a) => {
      const p = getProject()
      const frame = frameArg(a)
      const clips: ReturnType<typeof clipLine>[] = []
      for (const t of p.tracks) {
        const clip = Object.values(p.clips).find((c) => c.trackId === t.id && frame >= c.start && frame < clipEnd(c))
        if (clip) clips.push({ ...clipLine(p, clip, frame), ...(t.hidden ? { track_hidden: true } : {}), ...(t.muted ? { track_muted: true } : {}) })
      }
      return { frame, time_seconds: seconds(frame), clips }
    },
  },
  {
    name: 'get_clip',
    description:
      'Full details of one or more clips — every property (transform, color grade, audio mix, keyframes, effects, animation, transition, text style, speed, look, blend), with times in seconds and the media each uses. Read a clip before a precise edit so you only change what you mean to.',
    inputSchema: obj({ clip_ids: list('Clip ids', { type: 'string' }, { minItems: 1, maxItems: 50 }) }, ['clip_ids']),
    run: async (a) => {
      const p = getProject()
      const fps = p.settings.fps
      const ids = Array.isArray(a.clip_ids) ? a.clip_ids.map(String) : []
      const missing = ids.filter((id) => !p.clips[id])
      const clips = ids
        .filter((id) => p.clips[id])
        .map((id) => {
          const c = p.clips[id]
          const asset = c.assetId ? p.assets[c.assetId] : undefined
          return {
            ...c,
            track: trackName(c.trackId),
            start_seconds: seconds(c.start),
            end_seconds: seconds(clipEnd(c)),
            duration_seconds: seconds(c.duration),
            ...(asset
              ? {
                  source_in_seconds: round(c.inPoint / fps, 3),
                  source_out_seconds: round((c.inPoint + consumed(c)) / fps, 3),
                  asset: { id: asset.id, name: asset.name, kind: asset.kind, duration_seconds: asset.duration ?? null },
                }
              : {}),
          }
        })
      if (!clips.length) throw new Error(`None of those clips exist (${missing.join(', ')}). Call get_project for current ids.`)
      return { clips, ...(missing.length ? { missing } : {}) }
    },
  },
  {
    name: 'find_media',
    description:
      'Search the media library by name, tag or kind — and, for transcribed media, by what is said in it (returns the matching lines with their source times, ready for place_asset or clip_trim). Lists length, size, frame rate, audio, transcript, tags and how often each item is used on the timeline.',
    inputSchema: obj({
      query: str('Words to look for in names, tags, file paths and transcripts'),
      kind: oneOf('Only this kind', ['video', 'audio', 'image']),
      tag: str('Only media with this tag'),
      unused: bool('Only media not on the timeline yet'),
      limit: int('Most results to return (default 50)', { minimum: 1, maximum: 200 }),
    }),
    run: async (a) => {
      const p = getProject()
      const words = (text(a, 'query') ?? '').toLowerCase().split(/\s+/).filter(Boolean)
      const tag = text(a, 'tag')?.toLowerCase()
      const kind = text(a, 'kind')
      const limit = Math.round(clampNum(number(a, 'limit') ?? 50, 1, 200))
      const results = []
      for (const asset of Object.values(p.assets).sort((x, y) => y.addedAt - x.addedAt)) {
        if (kind && asset.kind !== kind) continue
        if (tag && !asset.tags?.some((t) => t.toLowerCase() === tag)) continue
        const line = mediaLine(p, asset)
        if (a.unused === true && line.on_timeline > 0) continue
        let said: { start: number; end: number; text: string }[] = []
        if (words.length) {
          const hay = `${asset.name} ${asset.tags?.join(' ') ?? ''} ${asset.source.type === 'file' ? (asset.source.path ?? '') : ''}`.toLowerCase()
          said = speechScript(asset)
            .filter((s) => words.every((w) => s.text.toLowerCase().includes(w)))
            .slice(0, 5)
            .map((s) => ({ start: round(s.start, 2)!, end: round(s.end, 2)!, text: s.text }))
          if (!words.every((w) => hay.includes(w)) && !said.length) continue
        }
        results.push({ ...line, ...(said.length ? { said } : {}) })
        if (results.length >= limit) break
      }
      return { total_in_library: Object.keys(p.assets).length, found: results.length, media: results }
    },
  },
  {
    name: 'get_transcript',
    description:
      'What is said, and when. With asset_id: that media file’s transcript in source seconds. Without: everything said on the timeline in timeline seconds, after every cut (lines a cut runs through are marked partial). If something isn’t transcribed yet, call transcribe_media first.',
    inputSchema: obj({
      asset_id: str('A media id — omit for the timeline'),
      from_seconds: num('Only from this time', { minimum: 0 }),
      to_seconds: num('Only up to this time', { minimum: 0 }),
    }),
    run: async (a) => {
      const p = getProject()
      const from = number(a, 'from_seconds') ?? 0
      const to = number(a, 'to_seconds') ?? Infinity
      if (text(a, 'asset_id')) {
        const asset = assetById(String(a.asset_id))
        const lines = speechScript(asset)
        if (!lines.length) throw new Error(`“${asset.name}” has no transcript yet — call transcribe_media with asset_id ${asset.id}.`)
        return {
          asset_id: asset.id,
          name: asset.name,
          lines: lines.filter((l) => l.end > from && l.start < to).map((l) => ({ start: round(l.start, 2), end: round(l.end, 2), text: l.text })),
        }
      }
      const lines = timelineTranscript(p, from, to)
      const missing = untranscribed(p).map((id) => ({ asset_id: id, name: p.assets[id]?.name }))
      if (!lines.length && missing.length) throw new Error(`Nothing on the timeline is transcribed yet — call transcribe_media for: ${missing.map((m) => `${m.asset_id} (${m.name})`).join(', ')}.`)
      return {
        lines: lines.map((l) => ({ start: round(l.start, 2), end: round(l.end, 2), text: l.text, clip_id: l.clipId, ...(l.partial ? { partial: true } : {}) })),
        ...(missing.length ? { untranscribed: missing } : {}),
      }
    },
  },
  {
    name: 'analyze_audio',
    description:
      'Hear the sound. Loudness in LUFS (as YouTube and Spotify measure it), the loudest 3 seconds, peak level, clipping, where there is sound and where there is silence, plus plain-language advice — for one media file (asset_id) or for the timeline mix (optionally a stretch, optionally per track to compare voice and music).',
    inputSchema: obj({
      asset_id: str('A media id — omit to analyze the timeline mix'),
      from_seconds: num('Start of the stretch', { minimum: 0 }),
      to_seconds: num('End of the stretch', { minimum: 0 }),
      per_track: bool('Timeline only: also measure each track on its own'),
    }),
    run: async (a) => {
      const p = getProject()
      if (text(a, 'asset_id')) {
        const asset = assetById(String(a.asset_id))
        if (asset.kind === 'image') throw new Error(`“${asset.name}” is an image — it has no sound.`)
        const buffer = await loadAudio(asset)
        if (!buffer) throw new Error(`“${asset.name}” has no sound Lumen can decode.`)
        const from = clampNum(number(a, 'from_seconds') ?? 0, 0, buffer.duration)
        const to = clampNum(number(a, 'to_seconds') ?? buffer.duration, from, buffer.duration)
        return { asset_id: asset.id, name: asset.name, from_seconds: round(from, 2), ...audioReport(slice(buffer, from, to), buffer.sampleRate, from) }
      }
      const [f0, f1] = rangeArg(a)
      if (f1 <= f0) throw new Error(projectDuration(p) ? 'That stretch is empty.' : 'The timeline is empty.')
      const from = f0 / p.settings.fps
      const to = f1 / p.settings.fps
      await prepareAudio(p)
      const mix = await renderMix(p, from, to)
      const channels = Array.from({ length: mix.numberOfChannels }, (_, c) => mix.getChannelData(c))
      const report = { scope: 'timeline mix', from_seconds: round(from, 2), ...audioReport(channels, mix.sampleRate, from) }
      if (a.per_track !== true) return report
      const tracks = []
      for (const t of p.tracks) {
        if (t.muted || !Object.values(p.clips).some((c) => c.trackId === t.id && isAudible(p, c))) continue
        // Solo this track: every other one muted.
        const solo: Project = { ...p, tracks: p.tracks.map((x) => ({ ...x, muted: x.id !== t.id })) }
        const buf = await renderMix(solo, from, to)
        const m = measureLoudness(
          Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c)),
          buf.sampleRate,
        )
        tracks.push({ track_id: t.id, track: t.name, loudness_lufs: m.lufs === null ? null : round(m.lufs, 1), peak_dbfs: round(m.peakDb, 1), clipped_samples: m.clipped })
      }
      return { ...report, tracks }
    },
  },
  {
    name: 'get_history',
    description: 'Recent undo steps, newest first: what each did, who made it (user or ai) and how long ago. Check it before undo, or to see what changed since you last looked.',
    inputSchema: obj({ limit: int('How many steps (default 20)', { minimum: 1, maximum: 100 }) }),
    run: async (a) => {
      const { past, future } = useEditor.getState()
      const limit = Math.round(clampNum(number(a, 'limit') ?? 20, 1, 100))
      const now = performance.now()
      return {
        undo: past
          .slice(-limit)
          .reverse()
          .map((e) => ({ id: e.id, label: e.label, by: e.source, seconds_ago: Math.round((now - e.at) / 1000) })),
        more_undo: Math.max(0, past.length - limit),
        redo_available: future.length,
      }
    },
  },
  {
    name: 'list_catalog',
    description:
      'The exact ids Lumen’s editing commands accept, with names and descriptions: effects, transitions, looks (color presets), title presets, text animations, fonts, blend modes, easings, built-in sound effects and canvas presets. Use it instead of guessing ids.',
    inputSchema: obj({
      section: oneOf('Just one section (default: everything)', ['effects', 'transitions', 'looks', 'titles', 'animations', 'fonts', 'blend_modes', 'easings', 'sound_effects', 'canvas_presets']),
    }),
    run: async (a) => {
      const all = {
        effects: EFFECTS.map((e) => ({ kind: e.kind, name: e.name, description: e.description, default_amount: e.amount, ...(e.is3d ? { is3d: true } : {}) })),
        transitions: TRANSITIONS.map((t) => ({ kind: t.kind, name: t.name, description: t.description, ...(t.is3d ? { is3d: true } : {}) })),
        looks: LOOKS.map((l) => ({ id: l.id, name: l.name })),
        titles: TITLE_PRESETS.map((t) => ({ id: t.id, name: t.name, duration_seconds: t.duration, ...(t.is3d ? { is3d: true } : {}) })),
        animations: ANIMATIONS.map((x) => ({ preset: x.preset, name: x.name, ...(x.textOnly ? { text_only: true } : {}) })),
        fonts: Object.entries(FONTS).map(([id, f]) => ({ id, name: f.label })),
        blend_modes: [...BLEND_MODES],
        easings: [...EASINGS],
        sound_effects: SFX.map((s) => ({ id: s.id, name: s.name, category: s.category, description: s.description, duration_seconds: s.duration })),
        canvas_presets: CANVAS_PRESETS.map((c) => ({ id: c.id, name: c.label, size: `${c.width}x${c.height}`, use: c.hint })),
      }
      const section = text(a, 'section') as keyof typeof all | undefined
      return section ? { [section]: all[section] } : all
    },
  },
]
