/**
 * Subtitles in and out: SRT and WebVTT files become caption clips on the
 * Captions track, and the captions on the timeline become SRT or VTT files.
 */
import { clipEnd, clipsOnTrack } from './ops'
import { TITLE_PRESETS } from './presets'
import { dispatch, getProject, useEditor } from './store'
import type { Project } from './types'

/** A subtitle cue, in seconds. */
export interface Cue {
  start: number
  end: number
  text: string
}

// 00:00:01,000 (SRT) · 00:00:01.000 / 00:01.000 (VTT) · 1:02:03.5 (lenient)
const TIME = /(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})/
const ARROW = /-->/

function seconds(s: string): number | null {
  const m = TIME.exec(s)
  if (!m) return null
  const [, h, mm, ss, ms] = m
  return Number(h ?? 0) * 3600 + Number(mm) * 60 + Number(ss) + Number(ms.padEnd(3, '0')) / 1000
}

/** Removes VTT/SRT markup (<i>, <b>, <c.x>, <v Speaker>, {\an8}, timestamps) and entities. */
function clean(text: string) {
  return text
    .replace(/<\d{1,2}:\d{2}[^>]*>/g, '')
    .replace(/<v(?:\.[^\s>]+)?\s+[^>]*>/gi, '')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n')
}

/** Reads SRT or WebVTT text into cues (sorted, empty ones dropped). */
export function parseSubtitles(text: string): Cue[] {
  const blocks = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/)
  const cues: Cue[] = []
  for (const block of blocks) {
    const lines = block.split('\n')
    const at = lines.findIndex((l) => ARROW.test(l))
    if (at < 0) continue // header, NOTE, STYLE, REGION
    const [a, b] = lines[at].split(ARROW)
    const start = seconds(a)
    const end = seconds(b)
    if (start === null || end === null || end <= start) continue
    const body = clean(lines.slice(at + 1).join('\n'))
    if (body) cues.push({ start, end, text: body })
  }
  return cues.sort((x, y) => x.start - y.start)
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

function stamp(s: number, sep: ',' | '.') {
  const ms = Math.max(0, Math.round(s * 1000))
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${sep}${pad(ms % 1000, 3)}`
}

export function formatSrt(cues: Cue[]) {
  return cues.map((c, i) => `${i + 1}\n${stamp(c.start, ',')} --> ${stamp(c.end, ',')}\n${c.text}\n`).join('\n')
}

export function formatVtt(cues: Cue[]) {
  return `WEBVTT\n\n${cues.map((c) => `${stamp(c.start, '.')} --> ${stamp(c.end, '.')}\n${c.text}\n`).join('\n')}`
}

export type SubtitleFormat = 'srt' | 'vtt'

export const formatCues = (cues: Cue[], format: SubtitleFormat) => (format === 'vtt' ? formatVtt(cues) : formatSrt(cues))

/** The captions on the timeline as cues: text clips on caption tracks (or, failing that, every text clip). */
export function timelineCues(project: Project): Cue[] {
  const fps = project.settings.fps
  const tracks = project.tracks.filter((t) => t.role === 'captions').map((t) => t.id)
  const pool = tracks.length ? tracks.flatMap((id) => clipsOnTrack(project, id)) : Object.values(project.clips)
  return pool
    .filter((c) => c.kind === 'text' && c.text?.content.trim())
    .map((c) => ({ start: c.start / fps, end: clipEnd(c) / fps, text: c.text!.content.trim() }))
    .sort((a, b) => a.start - b.start)
}

/** The timeline's captions between two frames, re-timed so `range[0]` is zero (what an export of that range shows). */
export function cuesInRange(project: Project, range?: [number, number]): Cue[] {
  const cues = timelineCues(project)
  if (!range) return cues
  const fps = project.settings.fps
  const [a, b] = [range[0] / fps, range[1] / fps]
  return cues.filter((c) => c.end > a && c.start < b).map((c) => ({ ...c, start: Math.max(0, c.start - a), end: Math.min(b, c.end) - a }))
}

/** The project with its caption tracks hidden — for exports that ship captions as a file instead of burning them in. */
export function withoutCaptions(project: Project): Project {
  if (!project.tracks.some((t) => t.role === 'captions' && !t.hidden)) return project
  return { ...project, tracks: project.tracks.map((t) => (t.role === 'captions' ? { ...t, hidden: true } : t)) }
}

export interface CaptionLine {
  /** Frames */
  start: number
  end: number
  text: string
}

/**
 * Lays caption clips on a Captions track in the subtitle style (replacing what's
 * there, unless `track` names a fresh track), as one undo step. Returns the ids.
 */
export function layCaptions(lines: CaptionLine[], opts: { label: string; source: 'user' | 'ai'; size?: number; y?: number; uppercase?: boolean; newTrack?: string }) {
  const project = getProject()
  const fps = project.settings.fps
  const preset = TITLE_PRESETS.find((t) => t.id === 'subtitle') ?? TITLE_PRESETS[0]
  const size = opts.size ?? Math.round(Math.min(project.settings.width, project.settings.height) * 0.045)
  const y = opts.y ?? Math.round(project.settings.height * 0.36)
  const how = { source: opts.source }
  const ids: string[] = []
  let trackId = opts.newTrack ? null : (project.tracks.find((t) => t.role === 'captions')?.id ?? null)
  useEditor.getState().transaction(opts.label, opts.source, () => {
    if (trackId) {
      const existing = clipsOnTrack(getProject(), trackId).map((c) => c.id)
      if (existing.length) dispatch('clip.delete', { ids: existing }, how)
    } else {
      const res = dispatch('track.add', { kind: 'video', name: opts.newTrack ?? 'Captions', index: 0, role: 'captions' }, how)
      trackId = res.ok ? (res.result as string) : null
    }
    if (!trackId) return
    const sorted = [...lines].sort((a, b) => a.start - b.start)
    for (let i = 0; i < sorted.length; i++) {
      const l = sorted[i]
      const next = sorted[i + 1]
      const end = Math.min(next ? next.start : Infinity, Math.max(l.end, l.start + Math.round(fps * 0.5)))
      const res = dispatch(
        'clip.add',
        {
          trackId,
          kind: 'text',
          start: Math.max(0, l.start),
          duration: Math.max(2, end - l.start),
          name: l.text.split('\n')[0],
          patch: {
            text: { ...preset.text, content: l.text, size, uppercase: opts.uppercase ?? false },
            transform: { y },
            animation: { in: { preset: 'fade', duration: 3 }, out: { preset: 'fade', duration: 3 } },
          },
        },
        how,
      )
      if (res.ok) ids.push(res.result as string)
    }
  })
  return { ids, trackId }
}

/**
 * Brings a subtitle file onto the timeline as caption clips, `offset` seconds in.
 * With `replace`, it takes over the Captions track; otherwise it gets a track of its own.
 */
export function importSubtitles(text: string, opts: { name?: string; offset?: number; replace?: boolean; source?: 'user' | 'ai' } = {}) {
  const cues = parseSubtitles(text)
  if (!cues.length) throw new Error('No subtitles found — is it an .srt or .vtt file?')
  const fps = getProject().settings.fps
  const offset = opts.offset ?? 0
  const hasCaptions = getProject().tracks.some((t) => t.role === 'captions' && clipsOnTrack(getProject(), t.id).length)
  const lines = cues.map((c) => ({ start: Math.round((c.start + offset) * fps), end: Math.round((c.end + offset) * fps), text: c.text }))
  const res = layCaptions(lines, {
    label: `Import subtitles${opts.name ? ` · ${opts.name}` : ''}`,
    source: opts.source ?? 'user',
    newTrack: hasCaptions && !opts.replace ? (opts.name ? `Captions · ${opts.name}` : 'Captions 2') : undefined,
  })
  return { added: res.ids.length, trackId: res.trackId, cues: cues.length }
}
