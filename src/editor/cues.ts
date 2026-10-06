/**
 * Cues: what happens in a clip that has no sound of its own — a line said, a
 * cut, footsteps — as the app that made the clip described it (GS Cinematic
 * Studio sends a cue sheet with every render). They sit on the media item in
 * source seconds; a clip on the timeline shows the ones inside its trim.
 */
import { localForSource } from './timing'
import type { Asset, AssetCue, Clip } from './types'

/** The most cues kept on one media item. */
export const MAX_CUES = 2000

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const words = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 500) : undefined)
const round3 = (n: number) => Math.round(n * 1000) / 1000

/** The fields that name a cue, most telling first. */
const LABELS = ['text', 'label', 'shot', 'sound', 'effect', 'do', 'react', 'style', 'mode', 'weapon', 'model', 'name']
const WHO = ['speaker', 'who']
const TAKEN = new Set(['at', 'kind', 'seconds', ...WHO])

/**
 * Reads a cue sheet as a sender wrote it: a list of `{ at, kind, … }` with `at`
 * in seconds from the clip's first frame. Anything that isn't a cue is skipped;
 * what a cue says beyond its time, kind, words and length is kept in `data`.
 */
export function parseCues(raw: unknown, duration = Infinity): AssetCue[] {
  if (!Array.isArray(raw)) return []
  const out: AssetCue[] = []
  for (const item of raw) {
    if (!isRecord(item) || typeof item.at !== 'number' || !Number.isFinite(item.at)) continue
    if (item.at < 0 || item.at > duration) continue
    const kind = words(item.kind)?.slice(0, 32).toLowerCase() ?? 'cue'
    const named = LABELS.find((k) => words(item[k]))
    const who = words(WHO.map((k) => item[k]).find(words))
    const data: NonNullable<AssetCue['data']> = {}
    for (const [k, v] of Object.entries(item)) {
      if (TAKEN.has(k) || k === named) continue
      if (typeof v === 'string') {
        if (v) data[k.slice(0, 32)] = v.slice(0, 300)
      } else if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) data[k.slice(0, 32)] = v
    }
    out.push({
      at: round3(item.at),
      kind,
      label: (named && words(item[named])) || who || kind,
      ...(typeof item.seconds === 'number' && item.seconds > 0 && Number.isFinite(item.seconds) ? { seconds: round3(item.seconds) } : {}),
      ...(who ? { who } : {}),
      ...(Object.keys(data).length ? { data } : {}),
    })
    if (out.length >= MAX_CUES) break
  }
  return out.sort((a, b) => a.at - b.at)
}

/** A cue in a few words: “Boss: You are late.”, “Cut: Arrival”, “Footsteps (confident)”. */
export function cueText(cue: AssetCue) {
  switch (cue.kind) {
    case 'speech':
    case 'line':
      return cue.who && cue.who !== cue.label ? `${cue.who}: ${cue.label}` : cue.label
    case 'cut':
      return `Cut: ${cue.label}`
    case 'walk':
      return `${cue.who ? `${cue.who} walks` : 'Footsteps'}${cue.label !== cue.who && cue.label !== 'walk' ? ` (${cue.label})` : ''}`
    case 'marker':
      return cue.label
    default: {
      const kind = cue.kind.charAt(0).toUpperCase() + cue.kind.slice(1)
      return cue.label === cue.kind ? kind : `${kind}: ${cue.label}`
    }
  }
}

export type CueTone = 'speech' | 'cut' | 'sound' | 'action'

/** How a cue is coloured: something said, a cut, something heard, something done. */
export function cueTone(kind: string): CueTone {
  if (kind === 'speech' || kind === 'line') return 'speech'
  if (kind === 'cut' || kind === 'marker') return 'cut'
  if (kind === 'sfx' || kind === 'walk' || kind === 'fx' || kind === 'drive') return 'sound'
  return 'action'
}

export interface ClipCue {
  /** Frames from the clip's start. */
  frame: number
  cue: AssetCue
}

/** The cues a clip shows, where they fall inside it (its trim, speed and direction applied). */
export function clipCues(clip: Clip, asset: Asset | undefined, fps: number): ClipCue[] {
  if (!asset?.cues?.length || clip.freeze) return []
  const out: ClipCue[] = []
  for (const cue of asset.cues) {
    const local = localForSource(clip, cue.at * fps)
    if (local === null || !Number.isFinite(local) || local >= clip.duration) continue
    out.push({ frame: Math.round(local), cue })
  }
  return out.sort((a, b) => a.frame - b.frame)
}
