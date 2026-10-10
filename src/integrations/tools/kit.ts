/**
 * Building blocks shared by every agent tool: JSON-schema helpers, time
 * conversion, id lookups with errors that help a model recover, and results
 * that carry pictures.
 */
import type { BridgeTool } from '@shared/integrations'
import { projectDuration } from '@/editor/ops'
import { usePlayback } from '@/editor/playback'
import { getProject } from '@/editor/store'
import type { Asset, Clip, Track } from '@/editor/types'
import { formatTimecode } from '@/lib/time'

export type ToolArgs = Record<string, unknown>

/** Who is calling and what they can take. */
export interface ToolContext {
  /** The longest to wait on a job before answering, in seconds — set for callers over HTTP, who time out. */
  maxWait?: number
  /** Aborts when the user stops the Copilot turn that made this call: long work should stop with it. */
  signal?: AbortSignal
  /** Says how the work is getting on; the chat shows it on the tool's step. */
  progress?: (message: string) => void
}

export interface AgentTool extends BridgeTool {
  run: (args: ToolArgs, ctx?: ToolContext) => Promise<unknown>
}

/** How long a tool waits on a job: what was asked for (else `fallback`), within what the caller can take. */
export function waitSeconds(args: ToolArgs, ctx: ToolContext | undefined, fallback: number, max = 600) {
  const asked = typeof args.wait_seconds === 'number' && Number.isFinite(args.wait_seconds) ? args.wait_seconds : fallback
  return Math.max(0, Math.min(max, ctx?.maxWait ?? max, asked))
}

// ─── Schemas ─────────────────────────────────────────────────────────────

export const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false })
export const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra })
export const num = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'number', description, ...extra })
export const int = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'integer', description, ...extra })
export const bool = (description: string) => ({ type: 'boolean', description })
export const oneOf = (description: string, values: readonly string[]) => ({ type: 'string', enum: values, description })
export const list = (description: string, items: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type: 'array', items, description, ...extra })

// ─── Results with pictures ───────────────────────────────────────────────

export interface ToolImage {
  /** base64, no data: prefix */
  data: string
  mimeType: 'image/jpeg' | 'image/png'
}

/** A tool result that includes images for the model to look at. */
export class WithImages {
  constructor(
    readonly json: unknown,
    readonly images: ToolImage[],
  ) {}
}

export const withImages = (json: unknown, images: ToolImage[]) => new WithImages(json, images)

// ─── Arguments ───────────────────────────────────────────────────────────

export const has = (a: ToolArgs, key: string) => a[key] !== undefined && a[key] !== null
export const number = (a: ToolArgs, key: string) => (typeof a[key] === 'number' && Number.isFinite(a[key]) ? (a[key] as number) : undefined)
export const text = (a: ToolArgs, key: string) => (typeof a[key] === 'string' && a[key] ? (a[key] as string) : undefined)
export const strings = (a: ToolArgs, key: string) => (Array.isArray(a[key]) ? (a[key] as unknown[]).map(String) : [])
export const clampNum = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

// ─── Time ────────────────────────────────────────────────────────────────

export const fps = () => getProject().settings.fps
export const seconds = (frame: number) => Math.round((frame / fps()) * 1000) / 1000
export const toFrame = (sec: number) => Math.round(sec * fps())
export const timecode = (frame: number) => formatTimecode(frame, fps())

/** The frame a tool is about: `frame`, else `time_seconds`, else the playhead. */
export function frameArg(a: ToolArgs, fallback = usePlayback.getState().frame) {
  const f = number(a, 'frame')
  if (f !== undefined) return Math.max(0, Math.round(f))
  const s = number(a, 'time_seconds')
  if (s !== undefined) return Math.max(0, toFrame(s))
  return fallback
}

/** [from, to) in frames from `from_seconds` / `to_seconds`, defaulting to the whole timeline. */
export function rangeArg(a: ToolArgs): [number, number] {
  const end = projectDuration(getProject())
  const from = clampNum(toFrame(number(a, 'from_seconds') ?? 0), 0, end)
  const to = clampNum(toFrame(number(a, 'to_seconds') ?? end / fps()), from, end)
  return [from, to]
}

// ─── Lookups ─────────────────────────────────────────────────────────────

function suggest<T>(items: T[], label: (t: T) => string, max = 8) {
  const shown = items.slice(0, max).map(label).join(', ')
  return items.length ? ` Known: ${shown}${items.length > max ? `, … (${items.length} in all)` : ''}.` : ''
}

export function clipById(id: string): Clip {
  const p = getProject()
  const clip = p.clips[id]
  if (!clip) throw new Error(`No clip with id “${id}”.${suggest(Object.values(p.clips), (c) => `${c.id} (${c.name})`)} Call get_project for the full list.`)
  return clip
}

export function assetById(id: string): Asset {
  const p = getProject()
  const asset = p.assets[id]
  if (!asset) throw new Error(`No media with id “${id}”.${suggest(Object.values(p.assets), (a) => `${a.id} (${a.name})`)} Call find_media to search.`)
  return asset
}

export function trackById(id: string): Track {
  const p = getProject()
  const track = p.tracks.find((t) => t.id === id)
  if (!track) throw new Error(`No track with id “${id}”.${suggest(p.tracks, (t) => `${t.id} (${t.name})`)}`)
  return track
}

export const trackName = (id: string) => getProject().tracks.find((t) => t.id === id)?.name ?? id
