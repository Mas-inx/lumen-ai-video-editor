/**
 * Subtitles in and out: SRT and WebVTT files become caption clips on the
 * Captions track, and the captions on the timeline become SRT or VTT files.
 */
import { clipEnd, clipsOnTrack } from './ops'
import { TITLE_PRESETS } from './presets'
import { dispatch, getProject, useEditor } from './store'
import type { AnimPreset, Project, TextStyle } from './types'

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
 * How captions look and move. clean: the classic subtitle (a soft box, a fade).
 * bold: big outlined caps, a few words at a time, popping in — the short-form
 * look. word: one big word at a time, key words in the accent colour. boxed:
 * solid boxes that rise in.
 */
export type CaptionStyle = 'clean' | 'bold' | 'word' | 'boxed'

export interface CaptionStyleSpec {
  id: CaptionStyle
  name: string
  description: string
  /** Words per caption. */
  words: number
  /** Text size as a fraction of the frame's short side. */
  size: number
  /** How far below the centre, as a fraction of the frame's height. */
  y: number
  text: Partial<TextStyle>
  animation: { in: { preset: AnimPreset; duration: number }; out: { preset: AnimPreset; duration: number } }
}

export const CAPTION_STYLES: CaptionStyleSpec[] = [
  {
    id: 'clean',
    name: 'Clean',
    description: 'Classic subtitles: a soft box, a gentle fade',
    words: 6,
    size: 0.045,
    y: 0.36,
    text: { font: 'sans', weight: 500, background: 'rgba(0,0,0,0.55)', shadow: 0, uppercase: false, outline: null },
    animation: { in: { preset: 'fade', duration: 3 }, out: { preset: 'fade', duration: 3 } },
  },
  {
    id: 'bold',
    name: 'Bold',
    description: 'Big outlined caps, a few words at a time',
    words: 3,
    size: 0.075,
    y: 0.24,
    text: { font: 'display', weight: 800, background: null, shadow: 0.35, uppercase: true, letterSpacing: -0.01, outline: { color: '#000000', width: 0.09 } },
    animation: { in: { preset: 'pop', duration: 4 }, out: { preset: 'none', duration: 2 } },
  },
  {
    id: 'word',
    name: 'Word by word',
    description: 'One big word at a time, key words in colour',
    words: 1,
    size: 0.095,
    y: 0.2,
    text: { font: 'archivo', weight: 850, background: null, shadow: 0.3, uppercase: true, letterSpacing: -0.02, outline: { color: '#000000', width: 0.08 } },
    animation: { in: { preset: 'pop', duration: 3 }, out: { preset: 'none', duration: 2 } },
  },
  {
    id: 'boxed',
    name: 'Boxed',
    description: 'Solid boxes that rise in',
    words: 5,
    size: 0.05,
    y: 0.33,
    text: { font: 'sans', weight: 650, background: '#0d0d0b', shadow: 0, uppercase: false, outline: null },
    animation: { in: { preset: 'rise', duration: 5 }, out: { preset: 'fade', duration: 3 } },
  },
]

export const captionStyle = (id: CaptionStyle | undefined) => CAPTION_STYLES.find((s) => s.id === id) ?? CAPTION_STYLES[0]

/** Words that carry the line get the accent colour (word-by-word captions): long words, numbers, and the end of a phrase. */
export function keyWord(word: string, last: boolean) {
  const bare = word.replace(/[^\p{L}\p{N}]/gu, '')
  return bare.length >= 7 || /\d/.test(bare) || (last && /[!?]$/.test(word))
}

/**
 * Lays caption clips on a Captions track in the subtitle style (replacing what's
 * there, unless `track` names a fresh track), as one undo step. Returns the ids.
 */
export function layCaptions(
  lines: CaptionLine[],
  opts: { label: string; source: 'user' | 'ai'; size?: number; y?: number; uppercase?: boolean; newTrack?: string; style?: CaptionStyle; accent?: string },
) {
  const project = getProject()
  const fps = project.settings.fps
  const preset = TITLE_PRESETS.find((t) => t.id === 'subtitle') ?? TITLE_PRESETS[0]
  const style = captionStyle(opts.style)
  const size = opts.size ?? Math.round(Math.min(project.settings.width, project.settings.height) * style.size)
  const y = opts.y ?? Math.round(project.settings.height * style.y)
  const accent = opts.accent ?? '#ffd84a'
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
            text: {
              ...preset.text,
              ...style.text,
              content: l.text,
              size,
              uppercase: opts.uppercase ?? style.text.uppercase ?? false,
              ...(style.id === 'word' && keyWord(l.text, i === sorted.length - 1 || /[.!?]$/.test(l.text)) ? { color: accent } : {}),
            },
            transform: { y },
            animation: style.animation,
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
