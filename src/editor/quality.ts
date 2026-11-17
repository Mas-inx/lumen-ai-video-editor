/**
 * Checking an edit before it's called done: problems on the timeline and in the
 * rendered picture and sound, each with where it is, how bad it is and what to
 * do about it — and a one-click fix (plain commands, one undo step) where that's
 * safe. Critical issues mean the edit isn't finished.
 *
 * The rules here are pure. The rendered picture and sound arrive measured
 * (engine/edit-check.ts), so every rule is tested on synthetic projects.
 */
import { isAudible } from '@/engine/audio-engine'
import type { CommandName } from './commands'
import { clipEnd, clipsOnTrack, isMagneticTrack, mediaEdgeLimits, projectDuration, sourceFrames } from './ops'
import { align, wordTokens } from './retakes'
import { timelineWords, voiceClips, type TimelineWord } from './smart'
import { consumed, localForConsumed } from './timing'
import type { Clip, Project } from './types'

export type Severity = 'critical' | 'warning' | 'info'

export type CheckKind =
  | 'empty'
  | 'gap'
  | 'offline'
  | 'past-media'
  | 'hidden-track'
  | 'muted-track'
  | 'solo'
  | 'caption-overlap'
  | 'caption-short'
  | 'caption-late'
  | 'caption-orphan'
  | 'text-offscreen'
  | 'text-unsafe'
  | 'text-covers'
  | 'upscaled'
  | 'letterbox'
  | 'aspect'
  | 'black'
  | 'frozen'
  | 'clipping'
  | 'loudness'
  | 'abrupt'
  | 'speech-silent'

export interface QualityFix {
  /** What the button says. */
  label: string
  /** Commands that fix it, run in order as one undo step (what batch_edit takes). */
  commands: { command: CommandName; input: Record<string, unknown> }[]
}

export interface QualityIssue {
  /** Stable while the problem stays where it is. */
  id: string
  check: CheckKind
  severity: Severity
  /** Timeline frames: where it is, and where it ends when it lasts. */
  frame: number
  end?: number
  message: string
  suggestion: string
  clipIds?: string[]
  fix?: QualityFix
}

/** The mix, measured: levels every 20 ms from `from` (timeline seconds), its loudness, and where it clips. */
export interface SoundMeasure {
  from: number
  /** Short-term level (dBFS) every 20 ms. */
  levels: ArrayLike<number>
  lufs: number | null
  peakDb: number
  /** Half-second stretches with clipped samples: [start, timeline seconds; samples at full scale]. */
  clipped: [number, number][]
}

/** A rendered frame, measured. */
export interface FrameSample {
  frame: number
  /** Mean luma, 0..255. */
  luma: number
  /** 98th-percentile luma: how bright the brightest part is. */
  peak: number
  /** Luma averaged over a 16 × 9 grid, to tell whether the picture changes. */
  grid: number[]
}

/** A text clip's box as the compositor drew it (project pixels, centre-based). */
export interface TextBox {
  cx: number
  cy: number
  w: number
  h: number
  rotation: number
}

export interface QualityMeasures {
  sound?: SoundMeasure
  frames?: FrameSample[]
  boxes?: Record<string, TextBox>
  /** The loudness to aim for, LUFS (default −14, online video). */
  target?: number
}

/** "1:02.5" */
const clock = (sec: number) => {
  const s = Math.max(0, sec)
  const m = Math.floor(s / 60)
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`
}
const quote = (s: string, max = 48) => `“${s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s}”`
const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`
const footage = (c: Clip) => (c.kind === 'video' || c.kind === 'image') && Boolean(c.assetId || c.sequenceId)
const visibleTrack = (p: Project, c: Clip) => {
  const t = p.tracks.find((x) => x.id === c.trackId)
  return Boolean(t && t.kind === 'video' && !t.hidden)
}
const shows = (c: Clip) => c.transform.opacity > 0.01 || Boolean(c.keyframes.opacity?.some((k) => k.value > 0.01))

/** Stretches of [0, end) none of `spans` cover. */
function uncovered(spans: [number, number][], end: number): [number, number][] {
  const out: [number, number][] = []
  let cursor = 0
  for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0])) {
    if (a > cursor) out.push([cursor, Math.min(a, end)])
    cursor = Math.max(cursor, b)
  }
  if (cursor < end) out.push([cursor, end])
  return out.filter(([a, b]) => b > a)
}

/** Clips that aren't speech but sound: what a ripple lets play on through its joins (music beds, ambience). */
function beds(p: Project) {
  const speech = new Set(voiceClips(p).map((c) => c.id))
  return Object.values(p.clips)
    .filter((c) => c.kind === 'audio' && !speech.has(c.id))
    .map((c) => c.id)
}

// ─── The timeline ────────────────────────────────────────────────────────

function mediaIssues(p: Project): QualityIssue[] {
  const fps = p.settings.fps
  const out: QualityIssue[] = []
  const offline = new Map<string, Clip[]>()
  for (const c of Object.values(p.clips)) {
    if (c.assetId) {
      const asset = p.assets[c.assetId]
      if (!asset || asset.source.missing) offline.set(c.assetId, [...(offline.get(c.assetId) ?? []), c])
    } else if (c.sequenceId && !p.sequences?.[c.sequenceId]) offline.set(`seq:${c.sequenceId}`, [...(offline.get(`seq:${c.sequenceId}`) ?? []), c])
  }
  for (const [key, clips] of offline) {
    clips.sort((a, b) => a.start - b.start)
    const asset = p.assets[key]
    const silent = clips.every((c) => c.kind === 'audio')
    const shown = `${plural(clips.length, 'clip')} ${silent ? (clips.length === 1 ? 'plays' : 'play') + ' silence' : (clips.length === 1 ? 'shows' : 'show') + ' a slate instead of the picture'}`
    const message = asset
      ? `${quote(asset.source.type === 'file' ? asset.source.fileName : asset.name)} is offline: ${shown}.`
      : key.startsWith('seq:')
        ? `${quote(clips[0].name)} plays a timeline that’s gone: ${shown}.`
        : `${quote(clips[0].name)} uses media that’s no longer in the project: ${shown}.`
    out.push({
      id: `offline:${key}`,
      check: 'offline',
      severity: 'critical',
      frame: clips[0].start,
      end: clipEnd(clips[0]),
      message,
      suggestion: asset ? 'Relink it to the file (Media › Relink), or replace those clips.' : 'Replace those clips: what they played is gone.',
      clipIds: clips.map((c) => c.id),
    })
  }
  // Clips that run past the end of their media.
  const music = beds(p)
  for (const c of Object.values(p.clips)) {
    if ((c.kind !== 'video' && c.kind !== 'audio') || c.freeze || !c.assetId || !p.assets[c.assetId] || p.assets[c.assetId].source.missing) continue
    const src = sourceFrames(p, c)
    if (src === Infinity) continue
    const over = c.inPoint + consumed(c) - src
    if (over <= 1) continue
    const has = Math.max(0, Math.floor(localForConsumed(c, Math.max(0, src - c.inPoint)) + 1e-6))
    // Forward clips run out at their end; reversed ones play the missing part first.
    const [a, b] = c.reverse ? [c.start, c.start + Math.max(1, c.duration - has)] : [c.start + has, clipEnd(c)]
    const seconds = (b - a) / fps
    const magnetic = isMagneticTrack(p, c.trackId)
    const fix: QualityFix = magnetic
      ? { label: 'Cut the part with no media', commands: [{ command: 'timeline.removeRange', input: { start: a, end: b, keepWhole: music } }] }
      : { label: 'Trim to the end of the media', commands: [{ command: 'clip.trim', input: { id: c.id, edge: c.reverse ? 'start' : 'end', frame: c.reverse ? b : a } }] }
    out.push({
      id: `past-media:${c.id}`,
      check: 'past-media',
      severity: seconds >= 0.5 ? 'critical' : 'warning',
      frame: a,
      end: b,
      message: `${quote(c.name)} runs ${seconds.toFixed(1)} s past the end of its media — ${c.kind === 'video' ? 'the picture holds still' : 'the sound stops'} there.`,
      suggestion: magnetic ? 'Cut that stretch (everything after moves up with it), or trim the clip.' : 'Trim the clip back to where its media ends.',
      clipIds: [c.id],
      fix,
    })
  }
  return out
}

function gapIssues(p: Project): QualityIssue[] {
  const fps = p.settings.fps
  const end = projectDuration(p)
  const all = Object.values(p.clips)
  // Captions go over a picture; they aren't one.
  const captions = new Set(p.tracks.filter((t) => t.role === 'captions').map((t) => t.id))
  const picture = all.filter((c) => visibleTrack(p, c) && !captions.has(c.trackId) && (footage(c) || c.kind === 'text') && shows(c)).map((c) => [c.start, clipEnd(c)] as [number, number])
  // Sound alone (a podcast, a voiceover, captioned or not) has no picture to miss — only holes where nothing plays.
  const soundOnly = !picture.length
  const holes: QualityIssue[] = []
  const blank: QualityIssue[] = []
  for (const [a, b] of uncovered(soundOnly ? all.map((c) => [c.start, clipEnd(c)] as [number, number]) : picture, end)) {
    const during = all.filter((c) => c.start < b && clipEnd(c) > a)
    const heard = during.some((c) => isAudible(p, c))
    const range = `${clock(a / fps)} to ${clock(b / fps)}`
    if (!during.length) {
      holes.push({
        id: `gap:${a}`,
        check: 'gap',
        severity: 'critical',
        frame: a,
        end: b,
        message: b - a <= 2 ? `A ${plural(b - a, 'frame')} hole at ${clock(a / fps)}: a flash of black and silence.` : `Nothing plays from ${range}: black and silence.`,
        suggestion: 'Close the gap, or fill it.',
        fix: { label: 'Close the gap', commands: [{ command: 'timeline.removeRange', input: { start: a, end: b, keepWhole: [] } }] },
      })
      continue
    }
    if (!heard && during.every((c) => c.kind === 'adjustment')) continue
    // The shot before, if its media can run on to cover it without moving anything else.
    const before = all
      .filter((c) => visibleTrack(p, c) && footage(c) && clipEnd(c) === a)
      .find((c) => mediaEdgeLimits(p, c)[1] >= b && (!isMagneticTrack(p, c.trackId) || clipsOnTrack(p, c.trackId).every((o) => o.start < a)))
    blank.push({
      id: `gap:${a}`,
      check: 'gap',
      severity: 'warning',
      frame: a,
      end: b,
      message: b - a <= 2 ? `A ${plural(b - a, 'frame')} flash of black at ${clock(a / fps)}.` : `No picture from ${range}${heard ? ' — black under the sound' : ''}.`,
      suggestion: before ? `Let “${before.name}” run on to cover it, or put a shot there.` : 'Put a shot, a still or a title there.',
      ...(before ? { clipIds: [before.id], fix: { label: 'Extend the shot before', commands: [{ command: 'clip.trim', input: { id: before.id, edge: 'end', frame: b } }] } } : {}),
    })
  }
  const closing = gather(holes, 'gap', (n, first) => `Nothing plays in ${n} places (the first at ${clock(first.frame / fps)}): black and silence.`, 'Close the gaps')
  // Closing a hole moves what follows it: the last goes first, so the others stay where they were found.
  if (holes.length > 3) closing[0].fix?.commands.reverse()
  return [...closing, ...gather(blank, 'gap', (n, first) => `No picture in ${n} stretches (the first at ${clock(first.frame / fps)}).`, 'Extend the shots before')]
}

function trackIssues(p: Project): QualityIssue[] {
  const out: QualityIssue[] = []
  for (const t of p.tracks) {
    const clips = clipsOnTrack(p, t.id)
    if (!clips.length) continue
    if (t.hidden && t.kind === 'video' && clips.some((c) => c.kind !== 'adjustment')) {
      out.push({
        id: `hidden-track:${t.id}`,
        check: 'hidden-track',
        severity: t.role === 'main' ? 'critical' : 'warning',
        frame: clips[0].start,
        message: `“${t.name}” is hidden: its ${plural(clips.length, 'clip')} won’t be in the export.`,
        suggestion: 'Show the track again if it belongs in the video.',
        clipIds: clips.map((c) => c.id),
        fix: { label: 'Show the track', commands: [{ command: 'track.update', input: { id: t.id, patch: { hidden: false } } }] },
      })
    }
    const sounding = clips.filter((c) => c.kind === 'audio' || (c.kind === 'video' && !c.audio.detached && c.assetId && p.assets[c.assetId]?.hasAudio !== false))
    if (t.muted && sounding.length) {
      const speech = sounding.some((c) => p.assets[c.assetId!]?.transcript?.length)
      out.push({
        id: `muted-track:${t.id}`,
        check: 'muted-track',
        severity: speech ? 'warning' : 'info',
        frame: sounding[0].start,
        message: `“${t.name}” is muted: ${plural(sounding.length, 'clip')} ${sounding.length === 1 ? 'is' : 'are'} silent in the export${speech ? ', speech included' : ''}.`,
        suggestion: 'Unmute it if it should be heard.',
        clipIds: sounding.map((c) => c.id),
        fix: { label: 'Unmute', commands: [{ command: 'track.update', input: { id: t.id, patch: { muted: false } } }] },
      })
    }
  }
  const solo = p.tracks.filter((t) => t.solo)
  if (solo.length) {
    out.push({
      id: 'solo',
      check: 'solo',
      severity: 'warning',
      frame: 0,
      message: `Only soloed tracks are heard (${solo.map((t) => `“${t.name}”`).join(', ')}): the export leaves the others out.`,
      suggestion: 'Unsolo before exporting.',
      fix: { label: 'Unsolo', commands: solo.map((t) => ({ command: 'track.update' as const, input: { id: t.id, patch: { solo: false } } })) },
    })
  }
  return out
}

// ─── Captions and titles ─────────────────────────────────────────────────

/** Caption clips: text on visible caption tracks. */
function captionClips(p: Project) {
  const tracks = new Set(p.tracks.filter((t) => t.role === 'captions' && !t.hidden).map((t) => t.id))
  return Object.values(p.clips)
    .filter((c) => tracks.has(c.trackId) && c.kind === 'text' && c.text?.content.trim())
    .sort((a, b) => a.start - b.start)
}

/** How long a caption needs to be read: about 20 characters a second, never under a beat. */
export function readingTime(text: string) {
  const chars = text.replace(/\s+/g, ' ').trim().length
  const words = text.split(/\s+/).filter(Boolean).length
  return words <= 1 ? Math.max(0.25, chars / 22) : Math.max(0.7, chars / 20)
}

/** Many of one kind become one issue, with every fix in one go. */
function gather(items: QualityIssue[], check: CheckKind, summary: (n: number, first: QualityIssue) => string, label: string): QualityIssue[] {
  if (items.length <= 3) return items
  const commands = items.flatMap((i) => i.fix?.commands ?? [])
  const first = items[0]
  return [
    {
      ...first,
      id: `${check}:many:${first.frame}`,
      end: undefined,
      message: summary(items.length, first),
      clipIds: items.flatMap((i) => i.clipIds ?? []),
      ...(commands.length ? { fix: { label, commands } } : { fix: undefined }),
    },
  ]
}

function captionIssues(p: Project, words: TimelineWord[]): QualityIssue[] {
  const fps = p.settings.fps
  const caps = captionClips(p)
  if (!caps.length) return []
  const out: QualityIssue[] = []

  // Two caption tracks showing at once.
  const pairs = new Map<string, { a: string; b: string; count: number; frame: number }>()
  for (let i = 0; i < caps.length; i++) {
    for (let j = i + 1; j < caps.length && caps[j].start < clipEnd(caps[i]); j++) {
      const x = caps[i]
      const y = caps[j]
      if (x.trackId === y.trackId || Math.min(clipEnd(x), clipEnd(y)) - y.start < 2) continue
      const [a, b] = p.tracks.findIndex((t) => t.id === x.trackId) < p.tracks.findIndex((t) => t.id === y.trackId) ? [x.trackId, y.trackId] : [y.trackId, x.trackId]
      const key = `${a}|${b}`
      const hit = pairs.get(key)
      if (hit) hit.count++
      else pairs.set(key, { a, b, count: 1, frame: y.start })
    }
  }
  for (const { a, b, count, frame } of pairs.values()) {
    const name = (id: string) => p.tracks.find((t) => t.id === id)?.name ?? 'Captions'
    const fewer = clipsOnTrack(p, a).length < clipsOnTrack(p, b).length ? a : b
    out.push({
      id: `caption-overlap:${a}:${b}`,
      check: 'caption-overlap',
      severity: 'warning',
      frame,
      message: `Captions on “${name(a)}” and “${name(b)}” overlap ${count === 1 ? 'once' : count === 2 ? 'twice' : `${count} times`} — both show at once.`,
      suggestion: `Keep one set: hide or delete the other.`,
      fix: { label: `Hide “${name(fewer)}”`, commands: [{ command: 'track.update', input: { id: fewer, patch: { hidden: true } } }] },
    })
  }

  // Too short to read.
  const short: QualityIssue[] = []
  for (const c of caps) {
    const text = c.text!.content
    const need = readingTime(text)
    const has = c.duration / fps
    if (has >= need * 0.8) continue
    const next = clipsOnTrack(p, c.trackId).find((o) => o.start >= clipEnd(c))
    const room = (next ? next.start : Infinity) - clipEnd(c)
    const more = Math.min(room, Math.ceil(need * fps) - c.duration)
    short.push({
      id: `caption-short:${c.id}`,
      check: 'caption-short',
      severity: 'warning',
      frame: c.start,
      end: clipEnd(c),
      message: `Caption ${quote(text)} is on screen for ${has.toFixed(1)} s — too short to read (it needs about ${need.toFixed(1)} s).`,
      suggestion: more >= 1 ? 'Hold it longer.' : 'Split the words over fewer, longer captions, or slow the cut there.',
      clipIds: [c.id],
      ...(more >= 1 ? { fix: { label: 'Hold it longer', commands: [{ command: 'clip.trim', input: { id: c.id, edge: 'end', frame: clipEnd(c) + more } }] } } : {}),
    })
  }
  out.push(...gather(short, 'caption-short', (n, first) => `${n} captions are too short to read (the first at ${clock(first.frame / fps)}).`, 'Hold them longer'))

  // Against the speech they caption.
  if (words.length) {
    const late: QualityIssue[] = []
    const orphans: QualityIssue[] = []
    for (const c of caps) {
      const a = c.start / fps
      const b = clipEnd(c) / fps
      const tokens = wordTokens(c.text!.content.replace(/\n/g, ' '))
      const near = words.filter((w) => w.end > a - 3 && w.start < b + 3)
      if (!tokens.length) continue
      const under = near.filter((w) => w.end > a && w.start < b)
      const stream = near.flatMap((w) => wordTokens(w.text).map((t) => ({ t, w })))
      const { length, inB } = align(
        tokens,
        stream.map((s) => s.t),
      )
      if (length >= tokens.length * 0.6) {
        const matched = stream.filter((_, i) => inB[i]).map((s) => s.w)
        const spoken = Math.max(...matched.map((w) => w.end))
        if (b > spoken + 0.7) {
          const to = Math.max(c.start + 1, Math.ceil((spoken + 0.25) * fps))
          late.push({
            id: `caption-late:${c.id}`,
            check: 'caption-late',
            severity: 'info',
            frame: c.start,
            end: clipEnd(c),
            message: `Caption ${quote(c.text!.content)} stays ${(b - spoken).toFixed(1)} s after its words are said.`,
            suggestion: 'End it with the speech.',
            clipIds: [c.id],
            ...(to < clipEnd(c) ? { fix: { label: 'End it with the speech', commands: [{ command: 'clip.trim', input: { id: c.id, edge: 'end', frame: to } }] } } : {}),
          })
        }
      } else if (!under.length) {
        orphans.push({
          id: `caption-orphan:${c.id}`,
          check: 'caption-orphan',
          severity: 'warning',
          frame: c.start,
          end: clipEnd(c),
          message: `Caption ${quote(c.text!.content)} shows while nobody speaks.`,
          suggestion: 'Its speech may have been cut: delete the caption or move it to its words.',
          clipIds: [c.id],
        })
      }
    }
    out.push(...gather(late, 'caption-late', (n, first) => `${n} captions stay on after their words are said (the first at ${clock(first.frame / fps)}).`, 'End them with the speech'))
    out.push(...gather(orphans, 'caption-orphan', (n, first) => `${n} captions show while nobody speaks (the first at ${clock(first.frame / fps)}).`, ''))
  }
  return out
}

/** A box's extent on screen once rotated. */
function extent(b: TextBox) {
  const r = (b.rotation * Math.PI) / 180
  const hw = (Math.abs(b.w * Math.cos(r)) + Math.abs(b.h * Math.sin(r))) / 2
  const hh = (Math.abs(b.w * Math.sin(r)) + Math.abs(b.h * Math.cos(r))) / 2
  return { left: b.cx - hw, right: b.cx + hw, top: b.cy - hh, bottom: b.cy + hh }
}

/** Title-safe: the middle 90% of the frame. */
const SAFE = 0.05

function textIssues(p: Project, boxes: Record<string, TextBox>): QualityIssue[] {
  const { width: W, height: H } = p.settings
  const out: QualityIssue[] = []
  const captions = new Set(captionClips(p).map((c) => c.id))
  const texts = Object.values(p.clips).filter((c) => c.kind === 'text' && visibleTrack(p, c) && boxes[c.id])
  for (const c of texts) {
    const box = boxes[c.id]
    const e = extent(box)
    const kind = captions.has(c.id) ? 'Caption' : 'Title'
    const name = quote(c.text?.content.split('\n')[0] ?? c.name)
    const edges = [e.left < 0 && 'left', e.right > W && 'right', e.top < 0 && 'top', e.bottom > H && 'bottom'].filter(Boolean) as string[]
    const unsafe = [e.left < W * SAFE && 'left', e.right > W * (1 - SAFE) && 'right', e.top < H * SAFE && 'top', e.bottom > H * (1 - SAFE) && 'bottom'].filter(Boolean) as string[]
    const off = e.right <= 0 || e.left >= W || e.bottom <= 0 || e.top >= H
    if (!off && !edges.length && !unsafe.length) continue
    // Move it (and shrink it if it can't fit) into the title-safe area — unless it moves by keyframes or tracking.
    const still = !c.follow && !['x', 'y', 'scale'].some((k) => c.keyframes[k as 'x']?.length)
    const fit = Math.min(1, (W * (1 - 2 * SAFE)) / (e.right - e.left), (H * (1 - 2 * SAFE)) / (e.bottom - e.top))
    const hw = ((e.right - e.left) * fit) / 2
    const hh = ((e.bottom - e.top) * fit) / 2
    const cx = Math.min(Math.max(box.cx, W * SAFE + hw), W * (1 - SAFE) - hw)
    const cy = Math.min(Math.max(box.cy, H * SAFE + hh), H * (1 - SAFE) - hh)
    const patch = {
      x: Math.round(c.transform.x + (cx - box.cx)),
      y: Math.round(c.transform.y + (cy - box.cy)),
      ...(fit < 0.999 ? { scale: Math.round(c.transform.scale * fit * 1000) / 1000 } : {}),
    }
    const fix = still ? { label: 'Move it inside the safe area', commands: [{ command: 'clip.update' as const, input: { ids: [c.id], patch: { transform: patch } } }] } : undefined
    if (off || edges.length) {
      out.push({
        id: `text-offscreen:${c.id}`,
        check: 'text-offscreen',
        severity: 'critical',
        frame: c.start,
        end: clipEnd(c),
        message: off ? `${kind} ${name} is entirely off screen.` : `${kind} ${name} is cut off at the ${edges.join(' and ')} edge${edges.length > 1 ? 's' : ''}.`,
        suggestion: still ? 'Move it inside the frame.' : 'Its motion takes it out of frame: adjust its keyframes.',
        clipIds: [c.id],
        ...(fix ? { fix } : {}),
      })
    } else {
      out.push({
        id: `text-unsafe:${c.id}`,
        check: 'text-unsafe',
        severity: 'warning',
        frame: c.start,
        end: clipEnd(c),
        message: `${kind} ${name} is outside the title-safe area (${unsafe.join(' and ')}).`,
        suggestion: 'Keep text within the middle 90% of the frame so no screen crops it.',
        clipIds: [c.id],
        ...(fix ? { fix } : {}),
      })
    }
  }
  // A caption over a title at the same time.
  const titles = texts.filter((c) => !captions.has(c.id))
  for (const cap of texts.filter((c) => captions.has(c.id))) {
    const a = extent(boxes[cap.id])
    for (const t of titles) {
      if (t.start >= clipEnd(cap) || clipEnd(t) <= cap.start) continue
      const b = extent(boxes[t.id])
      const overlap = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
      const smaller = Math.min((a.right - a.left) * (a.bottom - a.top), (b.right - b.left) * (b.bottom - b.top))
      if (smaller > 0 && overlap > smaller * 0.2) {
        out.push({
          id: `text-covers:${cap.id}:${t.id}`,
          check: 'text-covers',
          severity: 'warning',
          frame: Math.max(cap.start, t.start),
          message: `Caption ${quote(cap.text!.content)} covers the title ${quote(t.text?.content ?? t.name)}.`,
          suggestion: 'Move the title, or the captions, so both can be read.',
          clipIds: [cap.id, t.id],
        })
        break
      }
    }
  }
  return out
}

// ─── Picture fit ─────────────────────────────────────────────────────────

const shape = (w: number, h: number) => {
  const r = w / h
  const known: [number, string][] = [
    [16 / 9, '16:9'],
    [9 / 16, '9:16'],
    [1, 'square'],
    [4 / 3, '4:3'],
    [4 / 5, '4:5'],
    [2.39, '2.39:1'],
    [3 / 4, '3:4'],
  ]
  const hit = known.find(([k]) => Math.abs(r / k - 1) < 0.03)
  return hit ? hit[1] : `${r.toFixed(2)}:1`
}

function fitIssues(p: Project): QualityIssue[] {
  const { width: W, height: H } = p.settings
  const out: QualityIssue[] = []
  const media = Object.values(p.clips).filter((c) => visibleTrack(p, c) && (c.kind === 'video' || c.kind === 'image') && c.assetId && shows(c))
  // Small media blown up.
  for (const c of media) {
    const a = p.assets[c.assetId!]
    if (!a?.width || !a.height || a.source.missing) continue
    const contain = Math.min(W / a.width, H / a.height)
    const scale = Math.max(c.transform.scale, ...(c.keyframes.scale?.map((k) => k.value) ?? []))
    const factor = contain * scale
    if (factor < 1.5) continue
    out.push({
      id: `upscaled:${c.id}`,
      check: 'upscaled',
      severity: factor >= 2 ? 'warning' : 'info',
      frame: c.start,
      end: clipEnd(c),
      message: `${quote(c.name)} (${a.width}×${a.height}) is shown at ${factor.toFixed(1)}× its size — it will look soft.`,
      suggestion: 'Use a sharper source, or show it smaller.',
      clipIds: [c.id],
    })
  }
  // Bars around the main picture.
  const mainTracks = p.tracks.filter((t) => t.role === 'main' && !t.hidden).map((t) => t.id)
  const order = new Map(p.tracks.map((t, i) => [t.id, i]))
  const boxed = new Map<string, { clips: Clip[]; bars: string; share: number }>()
  for (const c of media) {
    if (!mainTracks.includes(c.trackId)) continue
    const a = p.assets[c.assetId!]
    if (!a?.width || !a.height || a.alpha) continue
    const s = Math.min(W / a.width, H / a.height) * c.transform.scale
    let w = a.width * s
    let h = a.height * s
    let cx = W / 2 + c.transform.x
    let cy = H / 2 + c.transform.y
    if (c.crop) {
      cx += ((c.crop.left - c.crop.right) * w) / 2
      cy += ((c.crop.top - c.crop.bottom) * h) / 2
      w *= 1 - c.crop.left - c.crop.right
      h *= 1 - c.crop.top - c.crop.bottom
    }
    const covered = (Math.max(0, Math.min(W, cx + w / 2) - Math.max(0, cx - w / 2)) * Math.max(0, Math.min(H, cy + h / 2) - Math.max(0, cy - h / 2))) / (W * H)
    if (covered >= 0.97) continue
    // Something underneath fills the bars (a blurred copy, a background).
    const below = Object.values(p.clips).some((o) => o.id !== c.id && visibleTrack(p, o) && footage(o) && (order.get(o.trackId) ?? 0) > (order.get(c.trackId) ?? 0) && o.start < clipEnd(c) && clipEnd(o) > c.start)
    if (below) continue
    const bars = w < W * 0.99 && h < H * 0.99 ? 'a border' : w < W * 0.99 ? 'bars at the sides' : 'bars above and below'
    const key = `${c.assetId}|${bars}`
    const hit = boxed.get(key)
    if (hit) hit.clips.push(c)
    else boxed.set(key, { clips: [c], bars, share: 1 - covered })
  }
  for (const { clips, bars, share } of boxed.values()) {
    const a = p.assets[clips[0].assetId!]
    const fixable = clips.filter((c) => !c.keyframes.scale?.length && !c.keyframes.x?.length && !c.keyframes.y?.length && !c.crop)
    const fill = Math.max(W / a.width!, H / a.height!) / Math.min(W / a.width!, H / a.height!)
    out.push({
      id: `letterbox:${clips[0].id}`,
      check: 'letterbox',
      severity: 'warning',
      frame: clips[0].start,
      end: clipEnd(clips[0]),
      message: `${quote(clips[0].name)} (${shape(a.width!, a.height!)}) leaves ${bars} in the ${shape(W, H)} frame — ${Math.round(share * 100)}% of the picture${clips.length > 1 ? `, in ${clips.length} clips` : ''}.`,
      suggestion: 'Fill the frame (it crops the edges), or put something behind it.',
      clipIds: clips.map((c) => c.id),
      ...(fixable.length ? { fix: { label: 'Fill the frame', commands: [{ command: 'clip.update', input: { ids: fixable.map((c) => c.id), patch: { transform: { scale: Math.round(fill * 1000) / 1000, x: 0, y: 0 } } } }] } } : {}),
    })
  }
  // A timeline the wrong shape for its footage.
  const main = media.filter((c) => mainTracks.includes(c.trackId) && p.assets[c.assetId!]?.width && p.assets[c.assetId!]?.height)
  const total = main.reduce((s, c) => s + c.duration, 0)
  const byShape = new Map<string, { frames: number; w: number; h: number }>()
  for (const c of main) {
    const a = p.assets[c.assetId!]
    if (Math.abs(a.width! / a.height! / (W / H) - 1) <= 0.15) continue
    const key = shape(a.width!, a.height!)
    const hit = byShape.get(key)
    if (hit) hit.frames += c.duration
    else byShape.set(key, { frames: c.duration, w: a.width!, h: a.height! })
  }
  const [dominant] = [...byShape.entries()].sort((x, y) => y[1].frames - x[1].frames)
  if (dominant && total && dominant[1].frames >= total * 0.5 && dominant[1].frames >= p.settings.fps * 2) {
    const { w, h } = dominant[1]
    const long = Math.max(W, H)
    const size = w >= h ? `${long}×${Math.round((long * h) / w / 2) * 2}` : `${Math.round((long * w) / h / 2) * 2}×${long}`
    out.push({
      id: 'aspect',
      check: 'aspect',
      severity: 'warning',
      frame: 0,
      message: `Most of the footage is ${shape(w, h)}, but the timeline is ${shape(W, H)} (${W}×${H}).`,
      suggestion: `Make the canvas match (reframe to ${size}), or fill the frame clip by clip.`,
    })
  }
  return out
}

// ─── The rendered picture ────────────────────────────────────────────────

const isBlack = (s: FrameSample) => s.luma < 16 && s.peak < 40

/** The top piece of footage drawn at a frame. */
function topFootage(p: Project, frame: number) {
  for (const t of p.tracks) {
    if (t.kind !== 'video' || t.hidden) continue
    const c = Object.values(p.clips).find((x) => x.trackId === t.id && frame >= x.start && frame < clipEnd(x) && footage(x) && shows(x))
    if (c) return c
  }
  return undefined
}

/** Black or held still on purpose: fades, dips, and opacity animated down. */
function meantDark(p: Project, a: number, b: number, end: number) {
  const fps = p.settings.fps
  if (a <= fps * 1.5 || b >= end - fps * 1.5) return true
  return Object.values(p.clips).some((c) => {
    if (!visibleTrack(p, c) || c.start > b || clipEnd(c) < a) return false
    const tr = c.transitionIn
    if (tr && (tr.kind === 'dip' || tr.kind === 'dissolve') && Math.abs(c.start - a) <= tr.duration + fps) return true
    const inEnd = c.start + (c.animation.in.preset !== 'none' ? c.animation.in.duration : 0)
    const outStart = clipEnd(c) - (c.animation.out.preset !== 'none' ? c.animation.out.duration : 0)
    if ((inEnd > c.start && a < inEnd + fps) || (outStart < clipEnd(c) && b > outStart - fps)) return true
    return Boolean(c.keyframes.opacity?.some((k) => k.value < 0.05 && Math.abs(c.start + k.frame - (a + b) / 2) <= b - a + fps))
  })
}

function pictureIssues(p: Project, frames: FrameSample[], gaps: QualityIssue[]): QualityIssue[] {
  const fps = p.settings.fps
  const end = projectDuration(p)
  const samples = [...frames].sort((a, b) => a.frame - b.frame)
  if (samples.length < 2) return []
  const step = (samples[samples.length - 1].frame - samples[0].frame) / (samples.length - 1)
  const out: QualityIssue[] = []
  const inGap = (a: number, b: number) => gaps.some((g) => g.frame <= b && (g.end ?? g.frame) >= a)
  const runs = <T>(pick: (s: FrameSample, i: number) => boolean, then: (from: number, to: number) => T | null) => {
    const found: T[] = []
    for (let i = 0; i < samples.length; i++) {
      if (!pick(samples[i], i)) continue
      let j = i
      while (j + 1 < samples.length && pick(samples[j + 1], j + 1)) j++
      const hit = then(i, j)
      if (hit) found.push(hit)
      i = j
    }
    return found
  }
  // Black.
  out.push(
    ...runs(isBlack, (i, j) => {
      const a = samples[i].frame
      const b = Math.min(end, Math.round(samples[j].frame + step / 2))
      if (b - a < fps * 0.5 || inGap(a, b) || meantDark(p, a, b, end)) return null
      const clip = topFootage(p, Math.round((a + b) / 2))
      return {
        id: `black:${a}`,
        check: 'black' as const,
        severity: 'warning' as const,
        frame: a,
        end: b,
        message: clip ? `The picture is black from ${clock(a / fps)} to ${clock(b / fps)}, in ${quote(clip.name)}.` : `The picture is black from ${clock(a / fps)} to ${clock(b / fps)}.`,
        suggestion: clip ? 'Check the footage there (a lens cap, a dropped signal, a decode failure), or cut that stretch.' : 'Something there draws nothing: check the clips and their opacity.',
        ...(clip ? { clipIds: [clip.id] } : {}),
      }
    }),
  )
  // Frozen: footage that should move, and doesn't.
  const diff = (x: FrameSample, y: FrameSample) => x.grid.reduce((s, v, k) => s + Math.abs(v - (y.grid[k] ?? v)), 0) / Math.max(1, x.grid.length)
  const still = (i: number) => i > 0 && diff(samples[i - 1], samples[i]) < 0.6 && !isBlack(samples[i])
  out.push(
    ...runs(
      (_s, i) => still(i),
      (i, j) => {
        const a = samples[i - 1].frame
        const b = samples[j].frame
        if (b - a < fps * 2.5 || inGap(a, b)) return null
        const clip = topFootage(p, Math.round((a + b) / 2))
        if (!clip || clip.kind !== 'video' || clip.freeze || clip.sequenceId) return null
        const asset = clip.assetId ? p.assets[clip.assetId] : undefined
        if (!asset || asset.cursor || asset.kind !== 'video') return null
        if (topFootage(p, a)?.id !== clip.id || topFootage(p, b)?.id !== clip.id) return null
        // Moving before or after inside the same clip: a hiccup, not a still shot.
        const moves = samples.some((s, k) => k > 0 && (k < i - 1 || k > j) && s.frame >= clip.start && s.frame < clipEnd(clip) && samples[k - 1].frame >= clip.start && !still(k))
        return {
          id: `frozen:${a}`,
          check: 'frozen' as const,
          severity: moves ? ('warning' as const) : ('info' as const),
          frame: a,
          end: b,
          message: `${quote(clip.name)} doesn’t move from ${clock(a / fps)} to ${clock(b / fps)}${moves ? ' although it moves around it — a frozen or damaged stretch?' : '.'}`,
          suggestion: moves ? 'Check the footage there; cut or replace that stretch if it’s stuck.' : 'If it’s meant to be still, ignore this.',
          clipIds: [clip.id],
        }
      },
    ),
  )
  return out
}

// ─── The sound ───────────────────────────────────────────────────────────

function soundIssues(p: Project, m: SoundMeasure, words: TimelineWord[], target: number): QualityIssue[] {
  const fps = p.settings.fps
  const out: QualityIssue[] = []
  const master = p.master ?? { volume: 0, pan: 0 }
  const level = (t: number) => {
    const i = Math.floor((t - m.from) / 0.02)
    return i >= 0 && i < m.levels.length ? m.levels[i] : -120
  }
  const loudest = (a: number, b: number) => {
    let v = -120
    for (let t = a; t < b - 1e-9; t += 0.02) v = Math.max(v, level(t))
    return v
  }

  // Clipping.
  const stretches: { a: number; b: number; samples: number }[] = []
  for (const [t, n] of [...m.clipped].sort((x, y) => x[0] - y[0])) {
    const last = stretches[stretches.length - 1]
    if (last && t - last.b <= 1) {
      last.b = t + 0.5
      last.samples += n
    } else stretches.push({ a: t, b: t + 0.5, samples: n })
  }
  const total = stretches.reduce((s, x) => s + x.samples, 0)
  if (total >= 10) {
    const limiter = master.limiter?.enabled
    const fix: QualityFix = limiter
      ? { label: `Lower the master ${Math.ceil(m.peakDb + 1.5)} dB`, commands: [{ command: 'mix.update', input: { target: 'master', patch: { volume: Math.max(-60, master.volume - Math.ceil(m.peakDb + 1.5)) } } }] }
      : { label: 'Add a limiter on the master', commands: [{ command: 'mix.update', input: { target: 'master', patch: { limiter: { enabled: true, ceiling: -1 } } } }] }
    const first = stretches[0]
    out.push({
      id: `clipping:${Math.round(first.a * fps)}`,
      check: 'clipping',
      severity: total >= 1000 ? 'critical' : 'warning',
      frame: Math.round(first.a * fps),
      end: Math.round(first.b * fps),
      message: `The mix clips: ${total} samples at full scale${stretches.length > 1 ? ` in ${stretches.length} places, the first` : ''} at ${clock(first.a)} — audible distortion.`,
      suggestion: limiter ? 'Lower the loudest clip or track there, or the master.' : 'Put a limiter on the master, or lower the loudest clip or track.',
      fix,
    })
  }

  // Loudness.
  const heard = Object.values(p.clips).some((c) => isAudible(p, c))
  if (m.lufs === null && heard) {
    out.push({ id: 'loudness', check: 'loudness', severity: 'critical', frame: 0, message: 'The mix is silent, though there are clips with sound.', suggestion: 'Check the master fader, track mutes and clip volumes.' })
  } else if (m.lufs !== null) {
    const gain = Math.round(target - m.lufs)
    if (Math.abs(target - m.lufs) > 3) {
      const volume = Math.min(12, Math.max(-60, master.volume + gain))
      const guard = m.peakDb + gain > -1 && !master.limiter?.enabled
      out.push({
        id: 'loudness',
        check: 'loudness',
        severity: 'warning',
        frame: 0,
        message: `The mix is ${m.lufs.toFixed(1)} LUFS — ${gain > 0 ? 'quieter' : 'louder'} than the ${target} LUFS it should be for ${target === -14 ? 'online video' : 'its destination'}.`,
        suggestion: `Normalize to ${target} LUFS when exporting, or ${gain > 0 ? 'raise' : 'lower'} the master about ${Math.abs(gain)} dB.`,
        ...(volume !== master.volume
          ? {
              fix: {
                label: `${gain > 0 ? 'Raise' : 'Lower'} the master ${Math.abs(volume - master.volume)} dB${guard ? ' (with a limiter)' : ''}`,
                commands: [{ command: 'mix.update', input: { target: 'master', patch: { volume, ...(guard ? { limiter: { enabled: true, ceiling: -1 } } : {}) } } }],
              },
            }
          : {}),
      })
    }
  }

  // Sound that jumps at a cut.
  const end = projectDuration(p)
  const audible = Object.values(p.clips).filter((c) => isAudible(p, c))
  const edits = new Map<number, { ends: Clip[]; starts: Clip[] }>()
  for (const c of audible) {
    for (const [f, side] of [
      [c.start, 'starts'],
      [clipEnd(c), 'ends'],
    ] as const) {
      if (f <= 0 || f >= end) continue
      const e = edits.get(f) ?? { ends: [], starts: [] }
      e[side].push(c)
      edits.set(f, e)
    }
  }
  const abrupt: QualityIssue[] = []
  const bedIds = new Set(beds(p))
  // Music fades over a second; anything else over a few frames.
  const fade = (c: Clip) => Math.max(2, Math.min(bedIds.has(c.id) ? fps : Math.round(fps * 0.12), Math.floor(c.duration / 3)))
  for (const [f, { ends, starts }] of [...edits.entries()].sort((x, y) => x[0] - y[0])) {
    const t = f / fps
    const before = loudest(t - 0.06, t)
    const after = loudest(t, t + 0.06)
    if (Math.max(before, after) < -30 || Math.abs(before - after) < 15) continue
    const cutOff = ends.filter((c) => c.audio.fadeOut < 2 && before > after)
    const jumpIn = starts.filter((c) => c.audio.fadeIn < 2 && after > before)
    if (!cutOff.length && !jumpIn.length) continue
    const commands = [
      ...cutOff.map((c) => ({ command: 'clip.update' as const, input: { ids: [c.id], patch: { audio: { fadeOut: fade(c) } } } })),
      ...jumpIn.map((c) => ({ command: 'clip.update' as const, input: { ids: [c.id], patch: { audio: { fadeIn: fade(c) } } } })),
    ]
    const who = cutOff[0] ?? jumpIn[0]
    abrupt.push({
      id: `abrupt:${f}`,
      check: 'abrupt',
      severity: 'warning',
      frame: f,
      message: cutOff.length
        ? `The sound of ${quote(who.name)} cuts off at ${clock(t)} (${before.toFixed(0)} → ${after.toFixed(0)} dB).`
        : `The sound of ${quote(who.name)} jumps in at ${clock(t)} (${before.toFixed(0)} → ${after.toFixed(0)} dB).`,
      suggestion: cutOff.length ? 'Fade it out.' : 'Fade it in.',
      clipIds: [...cutOff, ...jumpIn].map((c) => c.id),
      fix: { label: cutOff.length && jumpIn.length ? 'Smooth the cut' : cutOff.length ? 'Fade it out' : 'Fade it in', commands },
    })
  }
  out.push(...gather(abrupt, 'abrupt', (n, first) => `The sound jumps at ${n} cuts with no fade (the first at ${clock(first.frame / fps)}).`, 'Add the fades'))

  // Silence where the transcript has words.
  const quiet = (w: TimelineWord) => loudest(w.start, Math.max(w.end, w.start + 0.04)) < -50
  const silent: QualityIssue[] = []
  for (let i = 0; i < words.length; i++) {
    if (!quiet(words[i])) continue
    let j = i
    while (j + 1 < words.length && words[j + 1].lane === words[i].lane && quiet(words[j + 1])) j++
    const run = words.slice(i, j + 1).filter((w) => w.lane === words[i].lane)
    const a = run[0].start
    const b = run[run.length - 1].end
    const timed = run.some((w) => w.timed)
    if ((timed && b - a >= 0.25) || (!timed && b - a >= 1 && run.length >= 2)) {
      silent.push({
        id: `speech-silent:${Math.round(a * fps)}`,
        check: 'speech-silent',
        severity: timed ? 'warning' : 'info',
        frame: Math.round(a * fps),
        end: Math.round(b * fps),
        message: `No sound under ${quote(run.map((w) => w.text).join(' '))} at ${clock(a)} — the transcript has words there.`,
        suggestion: 'Check that clip’s volume, mute and fades there: the voice may be turned down or cut.',
        clipIds: [...new Set(run.map((w) => w.clipId))],
      })
    }
    i = j
  }
  out.push(...gather(silent, 'speech-silent', (n, first) => `${n} stretches of speech have no sound (the first at ${clock(first.frame / fps)}).`, ''))
  return out
}

// ─── All together ────────────────────────────────────────────────────────

const ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2 }

/** Sorts issues most serious first, then by time. */
export const worstFirst = (a: QualityIssue, b: QualityIssue) => ORDER[a.severity] - ORDER[b.severity] || a.frame - b.frame

/** How many frames apart the picture is sampled: twice a second, or 600 frames across a long edit. */
export function sampleFrames(project: Project, range?: [number, number]): number[] {
  const [a, b] = range ?? [0, projectDuration(project)]
  const len = b - a
  if (len <= 0) return []
  const n = Math.max(1, Math.min(600, Math.ceil((len / project.settings.fps) * 2)))
  return Array.from({ length: n }, (_, i) => Math.min(b - 1, Math.floor(a + ((i + 0.5) * len) / n)))
}

/**
 * Every problem found in the edit (within `range`, frames), most serious first.
 * Without measurements only the timeline itself is checked.
 */
export function checkEdit(project: Project, measures: QualityMeasures = {}, range?: [number, number]): QualityIssue[] {
  if (!Object.keys(project.clips).length) {
    return [{ id: 'empty', check: 'empty', severity: 'critical', frame: 0, message: 'The timeline is empty.', suggestion: 'Put some media on the timeline.' }]
  }
  const words = timelineWords(project)
  const gaps = gapIssues(project)
  const issues = [
    ...mediaIssues(project),
    ...gaps,
    ...trackIssues(project),
    ...captionIssues(project, words),
    ...(measures.boxes ? textIssues(project, measures.boxes) : []),
    ...fitIssues(project),
    ...(measures.frames ? pictureIssues(project, measures.frames, gaps) : []),
    ...(measures.sound ? soundIssues(project, measures.sound, words, measures.target ?? -14) : []),
  ]
  const within = range ? issues.filter((i) => i.frame < range[1] && (i.end ?? i.frame + 1) > range[0]) : issues
  return within.sort(worstFirst)
}

/** One line on where the edit stands. */
export function verdict(issues: QualityIssue[]) {
  const n = (s: Severity) => issues.filter((i) => i.severity === s).length
  const critical = n('critical')
  const parts = [critical && plural(critical, 'critical issue'), n('warning') && plural(n('warning'), 'warning'), n('info') && plural(n('info'), 'note')].filter(Boolean)
  if (!issues.length) return { finished: true, text: 'No problems found.' }
  return {
    finished: critical === 0,
    text: `${parts.join(', ')}.${critical ? ' Critical issues mean the edit isn’t finished.' : ''}`,
  }
}
