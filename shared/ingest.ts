/**
 * Frame ingest: another app on this computer sends finished frames over
 * loopback HTTP — GS Cinematic Studio filming GTA V frame by frame, a renderer,
 * a capture tool — and Lumen encodes each shot, once, into a master clip in the
 * media library. This file is the contract both halves of Lumen share: the
 * receiver in the main process and the encoder in the editor.
 */

export const INGEST_PATH = '/ingest/v1'
export const INGEST_DEFAULT_PORT = 47911

/** Frame bodies Lumen accepts. */
export const INGEST_FORMATS = ['rgba', 'bgra', 'png'] as const
export type IngestFormat = (typeof INGEST_FORMATS)[number]

/** Which row comes first in a raw frame. WebGL reads bottom-up; sending it as is saves the sender a flip. */
export type IngestOrigin = 'top-left' | 'bottom-left'

export type IngestQuality = 'lossless' | 'master' | 'compact'

export interface IngestQualityInfo {
  id: IngestQuality
  name: string
  hint: string
  /** VP9 quantizer (0 is mathematically lossless). */
  quantizer: number
}

/**
 * How hard the master is compressed. All three keep full colour resolution
 * (4:4:4). Sizes are for typical footage at 1440p; they scale with the picture.
 */
export const INGEST_QUALITIES: IngestQualityInfo[] = [
  { id: 'master', name: 'Master', hint: 'Visually lossless — about 0.5 MB a frame at 1440p', quantizer: 2 },
  { id: 'lossless', name: 'Lossless', hint: 'Every pixel exactly as sent — about 3 MB a frame at 1440p, slower to play', quantizer: 0 },
  { id: 'compact', name: 'Compact', hint: 'High quality, small files — about 0.25 MB a frame at 1440p', quantizer: 10 },
]

export const ingestQuality = (id: unknown): IngestQualityInfo => INGEST_QUALITIES.find((q) => q.id === id) ?? INGEST_QUALITIES[0]

export type IngestStatus = 'receiving' | 'assembling' | 'done' | 'error'

export type IngestMetaValue = string | number | boolean | null | IngestMetaValue[] | { [key: string]: IngestMetaValue }

/** What the sender says about a clip. Free-form JSON: kept with the asset, never interpreted here. */
export type IngestMeta = Record<string, IngestMetaValue>

/** The largest `POST /clips` body. A long scene's cue sheet rides in `meta`. */
export const INGEST_REQUEST_BYTES = 2 * 1024 * 1024

/** How much nested `meta` (lists and objects, as JSON) is kept with a clip. */
export const INGEST_META_BYTES = 512 * 1024

export interface IngestClipRequest {
  name: string
  width: number
  height: number
  fps: number
  /** Frames the sender plans to send (0 when it didn't say). */
  frames: number
  format: IngestFormat
  origin: IngestOrigin
  quality: IngestQuality
  meta: IngestMeta
}

export interface IngestClip extends IngestClipRequest {
  id: string
  status: IngestStatus
  /** Frames accepted from the sender. */
  received: number
  /** Frames the encoder has finished. */
  encoded: number
  createdAt: number
  updatedAt: number
  assetId?: string
  path?: string
  durationSeconds?: number
  codec?: string
  bytes?: number
  error?: string
}

/** What the editor reports when a clip's file is written and in the media library. */
export interface IngestResult {
  assetId: string
  path: string
  bytes: number
  codec: string
  durationSeconds: number
}

export interface IngestState {
  running: boolean
  port: number
  /** Base URL of the endpoints, when running. */
  url?: string
  token: string
  error?: string
  /** Quality used when a sender doesn't ask for one. */
  quality: IngestQuality
  /** Where masters are written. */
  folder: string
  /** Newest first. */
  clips: IngestClip[]
}

/** The files and frame feed the editor's encoder gets for one clip. */
export interface IngestSession {
  clip: IngestClip
  /** Long-poll URL the encoder pulls frames from. */
  nextUrl: string
  master: { id: string; path: string }
  proxy: { id: string; path: string } | null
}

/** Clips at least this large get a small proxy made alongside the master (the same rule as imported footage). */
export const INGEST_PROXY_FROM = 2560
export const INGEST_PROXY_HEIGHT = 540

export const wantsIngestProxy = (width: number, height: number) => Math.max(width, height) >= INGEST_PROXY_FROM

export const MAX_SIDE = 8192
export const MAX_PIXELS = 7680 * 4320
export const MAX_FRAMES = 1_000_000

/** Bytes of one raw frame (8-bit RGBA or BGRA). */
export const rawFrameBytes = (width: number, height: number) => width * height * 4

/** The largest body a frame of this clip may have. */
export function maxFrameBytes(clip: Pick<IngestClipRequest, 'width' | 'height' | 'format'>) {
  const raw = rawFrameBytes(clip.width, clip.height)
  // PNG is usually much smaller than the raw frame; noise can make it slightly larger.
  return clip.format === 'png' ? Math.ceil(raw * 1.1) + 65536 : raw
}

export class IngestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message)
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

const isScalar = (v: unknown): v is string | number | boolean => typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))

/**
 * `meta` as it is kept: text, numbers and true/false always; lists and objects
 * (a cue sheet) while they fit in {@link INGEST_META_BYTES}. What doesn't fit is
 * left out — a clip is never refused for what is said about it.
 */
function cleanMeta(v: unknown): IngestMeta {
  if (!isRecord(v)) return {}
  const out: IngestMeta = {}
  let nested = 0
  for (const [k, value] of Object.entries(v).slice(0, 64)) {
    const key = k.slice(0, 48)
    if (typeof value === 'string') out[key] = value.slice(0, 2000)
    else if (isScalar(value)) out[key] = value
    else if (value && typeof value === 'object') {
      // Through JSON: plain data only, and its size is known.
      const json = JSON.stringify(value)
      if (nested + json.length > INGEST_META_BYTES) continue
      nested += json.length
      out[key] = JSON.parse(json) as IngestMetaValue
    }
  }
  return out
}

/** The text, numbers and true/false of a clip's `meta`: what lists of clips carry. Lists inside it are counted. */
export function metaSummary(meta: IngestMeta): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(meta)) {
    if (isScalar(value)) out[key] = value
    else if (Array.isArray(value)) out[key] = value.length
  }
  return out
}

/** Checks the body of `POST /clips`. Throws an {@link IngestError} naming what's wrong. */
export function parseClipRequest(body: unknown, defaults: { quality: IngestQuality }): IngestClipRequest {
  if (!isRecord(body)) throw new IngestError(400, 'bad_request', 'Send a JSON object with name, width, height, fps and frames.')
  const int = (key: string) => (typeof body[key] === 'number' && Number.isInteger(body[key]) ? (body[key] as number) : NaN)
  const width = int('width')
  const height = int('height')
  if (!(width >= 16 && height >= 16)) throw new IngestError(400, 'bad_size', 'width and height must be whole numbers of at least 16.')
  if (width % 2 || height % 2) throw new IngestError(400, 'bad_size', `width and height must be even (got ${width}×${height}).`)
  if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) throw new IngestError(400, 'too_large', `Frames can be at most 8K (7680×4320); got ${width}×${height}.`)
  const fps = typeof body.fps === 'number' ? body.fps : NaN
  if (!(fps >= 1 && fps <= 240)) throw new IngestError(400, 'bad_fps', 'fps must be a number from 1 to 240.')
  const frames = body.frames === undefined || body.frames === null ? 0 : int('frames')
  if (!(frames >= 0 && frames <= MAX_FRAMES)) throw new IngestError(400, 'bad_frames', `frames must be a whole number up to ${MAX_FRAMES}.`)
  const format = body.format === undefined ? 'rgba' : body.format
  if (!INGEST_FORMATS.includes(format as IngestFormat)) throw new IngestError(400, 'bad_format', `format must be one of ${INGEST_FORMATS.join(', ')}.`)
  const origin = body.origin === undefined ? 'top-left' : body.origin
  if (origin !== 'top-left' && origin !== 'bottom-left') throw new IngestError(400, 'bad_origin', 'origin must be "top-left" or "bottom-left".')
  if (body.quality !== undefined && !INGEST_QUALITIES.some((q) => q.id === body.quality)) {
    throw new IngestError(400, 'bad_quality', `quality must be one of ${INGEST_QUALITIES.map((q) => q.id).join(', ')}.`)
  }
  const name = (typeof body.name === 'string' ? body.name : '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Clip'
  return {
    name,
    width,
    height,
    fps,
    frames,
    format: format as IngestFormat,
    origin,
    quality: (body.quality as IngestQuality | undefined) ?? defaults.quality,
    meta: cleanMeta(body.meta),
  }
}

/** A name that's safe as a file name on every platform. */
export function ingestFileBase(name: string) {
  const base = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/, '')
    .trim()
    .slice(0, 96)
  return !base || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(base) ? 'Clip' : base
}

/** The status object `GET /clips/{id}` answers with. */
export function clipStatusBody(clip: IngestClip) {
  return {
    clip_id: clip.id,
    name: clip.name,
    status: clip.status,
    received: clip.received,
    encoded: clip.encoded,
    frames: clip.frames || clip.received,
    quality: clip.quality,
    ...(clip.status === 'done'
      ? { asset_id: clip.assetId, path: clip.path, duration_seconds: clip.durationSeconds, codec: clip.codec, bytes: clip.bytes }
      : {}),
    ...(clip.error ? { error: clip.error } : {}),
  }
}

// ─── The master's codec ──────────────────────────────────────────────────

/** VP9 levels: [level × 10, luma samples per second, luma picture size]. */
const VP9_LEVELS: [number, number, number][] = [
  [10, 829440, 36864],
  [11, 2764800, 73728],
  [20, 4608000, 122880],
  [21, 9216000, 245760],
  [30, 20736000, 552960],
  [31, 36864000, 983040],
  [40, 83558400, 2228224],
  [41, 160432128, 2228224],
  [50, 311951360, 8912896],
  [51, 588251136, 8912896],
  [52, 1176502272, 8912896],
  [60, 1176502272, 35651584],
  [61, 2353004544, 35651584],
  [62, 4706009088, 35651584],
]

/** The lowest VP9 level that holds this picture at this frame rate. */
export function vp9Level(width: number, height: number, fps: number) {
  const size = width * height
  return (VP9_LEVELS.find(([, rate, picture]) => size <= picture && size * fps <= rate) ?? VP9_LEVELS[VP9_LEVELS.length - 1])[0]
}

/**
 * How the master stores colour.
 * - yuv444: Y′CbCr, BT.709, limited range, full colour resolution — the standard for video.
 * - rgb: the sender's red, green and blue as they are (VP9's identity matrix). With the
 *   lossless quantizer every pixel comes back exactly; Y′CbCr can't promise that, because
 *   8-bit Y′CbCr has no code for some RGB colours.
 * - yuv420: half colour resolution, for a computer that can't encode 4:4:4.
 */
export type MasterPixels = 'rgb' | 'yuv444' | 'yuv420'

/**
 * The master is VP9 with full colour resolution: profile 1 (4:4:4, 8-bit). It
 * is encoded and decoded in software on every computer, so the picture is the
 * same whatever the graphics card — and Chromium turns 8-bit 4:4:4 back into
 * RGB exactly (10-bit takes a coarser path and comes out less accurate).
 */
export function vp9Codec(width: number, height: number, fps: number, pixels: MasterPixels = 'yuv444') {
  const level = String(vp9Level(width, height, fps)).padStart(2, '0')
  // profile.level.bitDepth.chromaSubsampling.primaries.transfer.matrix.fullRange
  if (pixels === 'rgb') return `vp09.01.${level}.08.03.01.13.00.01`
  return pixels === 'yuv444' ? `vp09.01.${level}.08.03.01.01.01.00` : `vp09.00.${level}.08.01.01.01.01.00`
}

export const MASTER_COLOR = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false } as const
/** sRGB, coded as RGB. */
export const MASTER_COLOR_RGB = { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'rgb', fullRange: true } as const

export function codecLabel(pixels: MasterPixels, quality: IngestQuality, codec: 'vp9' | 'avc' = 'vp9') {
  if (codec === 'avc') return 'H.264 High 4:2:0 (high bitrate)'
  if (pixels === 'rgb') return 'VP9 RGB 4:4:4 8-bit (lossless)'
  const q = quality === 'lossless' ? 'lossless' : quality === 'master' ? 'visually lossless' : 'high quality'
  return `VP9 ${pixels === 'yuv444' ? '4:4:4' : '4:2:0'} 8-bit (${q})`
}
