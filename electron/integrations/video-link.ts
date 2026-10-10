import { AsyncLocalStorage } from 'node:async_hooks'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { finished } from 'node:stream/promises'
import { app, net } from 'electron'
import type { TranscriptSegment, WebVideo, WebVideoOptions, WebVideoPicture } from '../../shared/integrations'
import { allowPath, fileUrl, workDir } from './paths'
import { absolute, checkUrl, decodeEntities, isCancelledRedirect, meta, redirectTarget, strip, UA } from './web'

/**
 * Watching a linked video for the Copilot without bringing it into the project:
 * what it is, what is said, what it looks like. YouTube and Vimeo give all three
 * without downloading the video — captions, and the small preview pictures their
 * players show when you hover the timeline. A plain video file is saved to a
 * temporary file the editor samples frames from. Other sites give what their
 * pages say in public, and yt-dlp (only if the user has it) opens the rest.
 *
 * Nothing here signs in or sends cookies, and every request — redirects and
 * addresses taken from pages and answers included — goes through the same
 * public-address check as the other web tools.
 */

// ─── Requests ────────────────────────────────────────────────────────────

const PAGE_BYTES = 8 * 1024 * 1024
/** Room for the captions of a ten-hour video, or one big sprite sheet. */
const DATA_BYTES = 24 * 1024 * 1024
/** The largest file downloaded to watch a link. */
export const FILE_CAP = 400 * 1024 * 1024
const ANSWER_MS = 20_000
const DOWNLOAD_MS = 10 * 60_000

interface Ask {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  accept?: string
}

interface Reply {
  url: URL
  res: Response
  /** The content type, without parameters. */
  type: string
  /** How long the body may still take (a download gets longer than a page). */
  allow(ms: number): void
}

/** The watch a request belongs to. Stopping the watch ends whatever it has in flight, and starts nothing more. */
const watching = new AsyncLocalStorage<AbortSignal>()
const watches = new Map<string, AbortController>()
const STOPPED = 'Stopped.'

// No Referer or Origin: Electron's network stack refuses a request that sets them (ERR_BLOCKED_BY_CLIENT).
const sent = (ask: Ask) => ({ 'User-Agent': UA, Accept: ask.accept ?? '*/*', 'Accept-Language': 'en-US,en;q=0.9', ...ask.headers })

/** One request to a public address. Each hop is checked, and no cookies go out or get kept. */
async function open(raw: string, ask: Ask = {}): Promise<Reply> {
  let url = await checkUrl(raw)
  const watch = watching.getStore()
  for (let hop = 0; hop < 6; hop++) {
    if (watch?.aborted) throw new Error(STOPPED)
    const stop = new AbortController()
    let timer = setTimeout(() => stop.abort(), ANSWER_MS)
    timer.unref?.()
    let res: Response
    try {
      res = await net.fetch(url.href, { method: ask.method ?? 'GET', redirect: 'manual', credentials: 'omit', headers: sent(ask), body: ask.body, signal: watch ? AbortSignal.any([stop.signal, watch]) : stop.signal })
    } catch (err) {
      clearTimeout(timer)
      if (watch?.aborted) throw new Error(STOPPED)
      const to = isCancelledRedirect(err) && ask.method !== 'POST' ? await redirectTarget(url, sent(ask), ANSWER_MS) : null
      if (to) {
        url = await checkUrl(new URL(to, url).href)
        continue
      }
      throw new Error(stop.signal.aborted ? `${url.hostname} took too long to answer.` : `Couldn’t reach ${url.hostname}${err instanceof Error && err.message ? ` (${err.message})` : ''}.`)
    }
    const location = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && location) {
      clearTimeout(timer)
      void res.body?.cancel().catch(() => {})
      if (ask.method === 'POST') throw new Error(`${url.hostname} redirected a request that can’t be redirected.`)
      url = await checkUrl(new URL(location, url).href)
      continue
    }
    const allow = (ms: number) => {
      clearTimeout(timer)
      timer = setTimeout(() => stop.abort(), ms)
      timer.unref?.()
    }
    return { url, res, type: (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase(), allow }
  }
  throw new Error('Too many redirects.')
}

const drop = (reply: Reply) => void reply.res.body?.cancel().catch(() => {})

/** The body, up to `max` bytes (what is past that is left unread). */
async function read(res: Response, max: number): Promise<Buffer> {
  const reader = res.body?.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (reader) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => {})
      break
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

async function fetchText(raw: string, ask: Ask = {}, max = PAGE_BYTES): Promise<string> {
  const reply = await open(raw, ask)
  if (!reply.res.ok) {
    drop(reply)
    throw new Error(`${reply.url.hostname} answered ${reply.res.status}.`)
  }
  return (await read(reply.res, max)).toString('utf8')
}

async function fetchJson<T>(raw: string, ask: Ask = {}, max = PAGE_BYTES): Promise<T> {
  return JSON.parse(await fetchText(raw, { accept: 'application/json', ...ask }, max)) as T
}

async function fetchPicture(raw: string): Promise<WebVideoPicture | null> {
  try {
    const reply = await open(raw, { accept: 'image/webp,image/png,image/jpeg,*/*;q=0.5' })
    if (!reply.res.ok || !reply.type.startsWith('image/')) {
      drop(reply)
      return null
    }
    const bytes = await read(reply.res, DATA_BYTES)
    return bytes.length ? { bytes, mime: reply.type } : null
  } catch {
    return null
  }
}

/** Runs `fn` over `items`, a few at a time, keeping their order. */
async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i])
      }
    }),
  )
  return out
}

// ─── Small things ────────────────────────────────────────────────────────

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const finite = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const round = (v: number, places = 2) => Math.round(v * 10 ** places) / 10 ** places
/** Zero-width spaces, direction marks and byte-order marks that sites sprinkle into text. */
const INVISIBLE = new RegExp(`[${String.fromCharCode(0x200b, 0x200e, 0x200f, 0xfeff)}]`, 'g')
const tidy = (s: string) => s.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim()

/** "1:02:03" / "4:05". */
export function clock(seconds: number) {
  const s = Math.max(0, Math.round(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const rest = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${m}:${rest}`
}

/** "1:02:03" → 3723. */
const fromClock = (stamp: string) => stamp.split(':').reduce((sum, part) => sum * 60 + Number(part.replace(',', '.')), 0)

const megabytes = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`)

/** An ISO 8601 length ("PT19M11S") in seconds. */
export function isoDuration(text: string): number | undefined {
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(text.trim())
  if (!m || !m.slice(1).some(Boolean)) return undefined
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0)
}

function parseUrl(raw: string, base?: URL): URL | null {
  try {
    const url = new URL(raw, base)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null
  } catch {
    return null
  }
}

const bare = (host: string) => host.toLowerCase().replace(/^(www|m|mobile)\./, '')

interface Wanted {
  frames: number
  from?: number
  to?: number
  transcript: boolean
  language?: string
}

function wanted(o: WebVideoOptions): Wanted {
  const from = finite(o.from)
  const to = finite(o.to)
  return {
    frames: Math.round(clamp(finite(o.frames) ?? 16, 4, 48)),
    ...(from !== undefined && from > 0 ? { from } : {}),
    ...(to !== undefined && to > 0 ? { to } : {}),
    transcript: o.transcript !== false,
    ...(typeof o.language === 'string' && /^[a-z]{2,3}(-[\w-]{2,12})?$/i.test(o.language.trim()) ? { language: o.language.trim() } : {}),
  }
}

/** The stretch to watch, within the video. */
function stretch(want: Wanted, duration: number): [number, number] {
  const from = Math.max(0, want.from ?? 0)
  const to = Math.min(duration, want.to ?? duration)
  if (to <= from) throw new Error(`That stretch is empty — the video is ${clock(duration)} long (${Math.round(duration)} seconds).`)
  return [from, to]
}

// ─── Captions ────────────────────────────────────────────────────────────

/** One caption as the site shows it: often a few words. */
export interface Cue {
  start: number
  end: number
  text: string
}

interface Json3 {
  events?: { tStartMs?: number; dDurationMs?: number; segs?: { utf8?: string }[] }[]
}

/** YouTube's JSON captions. Auto-generated tracks come a few words at a time, with empty line-break events between. */
export function parseJson3(data: unknown): Cue[] {
  const cues: Cue[] = []
  for (const e of (data as Json3)?.events ?? []) {
    const text = (e.segs ?? []).map((s) => s.utf8 ?? '').join('')
    if (!text.trim() || typeof e.tStartMs !== 'number') continue
    cues.push({ start: e.tStartMs / 1000, end: (e.tStartMs + (e.dDurationMs ?? 0)) / 1000, text })
  }
  return cues
}

/** Caption XML, in both shapes YouTube serves: `<p t d>` in milliseconds and the older `<text start dur>` in seconds. */
export function parseCaptionXml(xml: string): Cue[] {
  const cues: Cue[] = []
  const attr = (tag: string, name: string) => Number(new RegExp(`\\b${name}="([\\d.]+)"`).exec(tag)?.[1] ?? NaN)
  for (const m of xml.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)) {
    const start = attr(m[1], 't')
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, ''))
    if (Number.isFinite(start) && text.trim()) cues.push({ start: start / 1000, end: (start + (attr(m[1], 'd') || 0)) / 1000, text })
  }
  if (cues.length) return cues
  for (const m of xml.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)) {
    const start = attr(m[1], 'start')
    // This shape escapes its text twice ("&amp;#39;").
    const text = decodeEntities(decodeEntities(m[2].replace(/<[^>]+>/g, '')))
    if (Number.isFinite(start) && text.trim()) cues.push({ start, end: start + (attr(m[1], 'dur') || 0), text })
  }
  return cues
}

/** WebVTT (and SRT, which differs only in its comma). */
export function parseVtt(text: string): Cue[] {
  const cues: Cue[] = []
  for (const block of text.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n')
    const at = lines.findIndex((l) => l.includes('-->'))
    const m = at < 0 ? null : /((?:\d+:)?\d+:\d+[.,]\d+)\s*-->\s*((?:\d+:)?\d+:\d+[.,]\d+)/.exec(lines[at])
    if (!m) continue
    const said = decodeEntities(lines.slice(at + 1).join(' ').replace(/<[^>]+>/g, ''))
    if (said.trim()) cues.push({ start: fromClock(m[1]), end: fromClock(m[2]), text: said })
  }
  return cues
}

/** Captions in whichever of those formats the text is. */
export function parseCaptions(text: string): Cue[] {
  const t = text.trimStart()
  if (t.startsWith('{')) {
    try {
      return parseJson3(JSON.parse(t))
    } catch {
      return []
    }
  }
  return t.startsWith('<') ? parseCaptionXml(t) : parseVtt(t)
}

/**
 * Joins caption fragments into lines that read like sentences: about 8–15
 * seconds each, broken where a sentence ends or the speaker pauses.
 */
export function mergeCues(cues: Cue[], min = 8, max = 15): TranscriptSegment[] {
  const sorted = cues.map((c) => ({ ...c, text: tidy(c.text) })).filter((c) => c.text).sort((a, b) => a.start - b.start)
  const lines: TranscriptSegment[] = []
  let line: TranscriptSegment | null = null
  sorted.forEach((cue, i) => {
    // Auto-generated cues stay on screen into the next one: a cue is over when the next starts.
    const end = Math.max(cue.start, Math.min(cue.end, sorted[i + 1]?.start ?? cue.end))
    if (line) {
      const span = cue.start - line.start
      const pause = cue.start - line.end
      const sentence = /[.!?…。！？]["'”’)\]]*$/.test(line.text)
      if (end - line.start > max || pause >= 4 || (span >= min && (sentence || pause >= 1))) {
        lines.push(line)
        line = null
      }
    }
    if (!line) line = { start: cue.start, end, text: cue.text }
    else {
      line.text += ` ${cue.text}`
      line.end = Math.max(line.end, end)
    }
  })
  if (line) lines.push(line)
  return lines.map((l) => ({ start: round(l.start), end: round(l.end), text: l.text }))
}

export interface CaptionTrack {
  url: string
  language: string
  /** Made by speech recognition, not by a person. */
  auto: boolean
}

const primary = (language: string) => language.toLowerCase().split(/[-_]/)[0]

/**
 * The track to read: one a person wrote in the language asked for, then one in
 * English, then an auto-generated one (asked language, English, any), then
 * whatever there is.
 */
export function pickTrack(tracks: CaptionTrack[], language?: string): CaptionTrack | null {
  const lang = (code: string) => (t: CaptionTrack) => t.language.toLowerCase() === code.toLowerCase() || primary(t.language) === primary(code)
  const exact = (code: string) => (t: CaptionTrack) => t.language.toLowerCase() === code.toLowerCase()
  const manual = tracks.filter((t) => !t.auto)
  const auto = tracks.filter((t) => t.auto)
  const asked = language ? [exact(language), lang(language)] : []
  return (
    asked.map((is) => manual.find(is)).find(Boolean) ??
    manual.find(exact('en')) ??
    manual.find(lang('en')) ??
    asked.map((is) => auto.find(is)).find(Boolean) ??
    // A person's captions in the language spoken beat the machine's.
    manual.find((t) => auto.some(lang(t.language))) ??
    auto.find(lang('en')) ??
    auto[0] ??
    manual[0] ??
    null
  )
}

const listed = (tracks: CaptionTrack[]) => [...new Set(tracks.map((t) => (t.auto ? `${t.language} (auto)` : t.language)))].slice(0, 40)

/** Lines that fall in the stretch asked for. */
function within(lines: TranscriptSegment[], want: Wanted) {
  const from = want.from ?? 0
  const to = want.to ?? Infinity
  return lines.filter((l) => l.end > from && l.start < to)
}

async function readTrack(tracks: CaptionTrack[], want: Wanted, agent?: string): Promise<WebVideo['transcript'] | undefined> {
  const track = pickTrack(tracks, want.language)
  if (!track) return undefined
  const url = new URL(track.url)
  // YouTube's own format carries exact timings and no markup.
  if (url.pathname === '/api/timedtext') url.searchParams.set('fmt', 'json3')
  const cues = parseCaptions(await fetchText(url.href, agent ? { headers: { 'User-Agent': agent } } : {}, DATA_BYTES))
  if (!cues.length) return undefined
  return { language: track.language, kind: track.auto ? 'auto-generated' : 'manual', lines: within(mergeCues(cues), want), available: listed(tracks) }
}

// ─── Chapters ────────────────────────────────────────────────────────────

export interface Chapter {
  start: number
  title: string
}

const STAMP = String.raw`(?:\d{1,2}:)?\d{1,2}:\d{2}`
const STAMP_FIRST = new RegExp(String.raw`^[-–—•*·▶►\s]*[\[(]?(${STAMP})[\])]?\s*[-–—:|.]*\s*(\S.*)$`)
const STAMP_LAST = new RegExp(String.raw`^(\S.*?)\s*[-–—:|.(\[]*\s*(${STAMP})[\])]?$`)
const RANGE_END = new RegExp(String.raw`^${STAMP}\s*[-–—:|.\])]*\s*`)

/** Chapters written into a description: lines like "0:00 Intro" or "Finale — 1:02:03", in climbing order. */
export function descriptionChapters(description: string, duration?: number): Chapter[] {
  const out: Chapter[] = []
  for (const raw of description.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.length > 160) continue
    const first = STAMP_FIRST.exec(line)
    const lastly = first ? null : STAMP_LAST.exec(line)
    const stamp = first?.[1] ?? lastly?.[2]
    const title = tidy((first?.[2] ?? lastly?.[1] ?? '').replace(RANGE_END, ''))
    if (!stamp || !title) continue
    const start = fromClock(stamp)
    if (duration && start >= duration) continue
    out.push({ start, title: title.slice(0, 120) })
  }
  // A chapter list climbs; anything else is times mentioned in passing.
  return out.length >= 2 && out.every((c, i) => i === 0 || c.start > out[i - 1].start) ? out : []
}

interface YtText {
  simpleText?: string
  runs?: { text?: string }[]
}
const ytText = (t?: YtText) => t?.simpleText ?? t?.runs?.map((r) => r.text ?? '').join('') ?? ''

interface YtInitialData {
  playerOverlays?: {
    playerOverlayRenderer?: {
      decoratedPlayerBarRenderer?: {
        decoratedPlayerBarRenderer?: {
          playerBar?: { multiMarkersPlayerBarRenderer?: { markersMap?: { key?: string; value?: { chapters?: { chapterRenderer?: { title?: YtText; timeRangeStartMillis?: number } }[] } }[] } }
        }
      }
    }
  }
}

/** The chapters on the watch page's player bar: the uploader's when there are any, else YouTube's automatic ones. */
export function youtubeChapters(data: unknown): Chapter[] {
  const maps = (data as YtInitialData)?.playerOverlays?.playerOverlayRenderer?.decoratedPlayerBarRenderer?.decoratedPlayerBarRenderer?.playerBar?.multiMarkersPlayerBarRenderer?.markersMap ?? []
  const map = maps.find((m) => m.key === 'DESCRIPTION_CHAPTERS' && m.value?.chapters?.length) ?? maps.find((m) => m.value?.chapters?.length)
  return (map?.value?.chapters ?? []).flatMap((c) => {
    const title = tidy(ytText(c.chapterRenderer?.title))
    const ms = c.chapterRenderer?.timeRangeStartMillis
    return title && typeof ms === 'number' ? [{ start: ms / 1000, title }] : []
  })
}

// ─── Preview pictures (storyboards) ──────────────────────────────────────

/** A grid of small frames across a video, split over numbered sheets (`$M` in the address). */
export interface Storyboard {
  url: string
  /** One tile, in pixels. */
  width: number
  height: number
  /** Tiles in the whole video. */
  count: number
  columns: number
  rows: number
  /** Milliseconds of video between tiles. */
  interval: number
}

/**
 * The storyboards of a YouTube player response. The spec is a base address,
 * then one `width#height#count#columns#rows#interval#name#signature` per size,
 * separated by "|"; `$L` in the address is the size's number and `$N` its name.
 */
export function parseStoryboards(spec: string, duration: number): Storyboard[] {
  const [base, ...levels] = spec.split('|')
  if (!base || !/^https?:\/\//.test(base)) return []
  return levels.flatMap((level, i) => {
    const [w, h, n, cols, rows, ms, name, sigh] = level.split('#')
    const [width, height, count, columns, perColumn] = [w, h, n, cols, rows].map(Number)
    if (![width, height, count, columns, perColumn].every((v) => Number.isFinite(v) && v > 0) || !name) return []
    const address = base.replace('$L', () => String(i)).replace('$N', () => name)
    const url = sigh ? `${address}${address.includes('?') ? '&' : '?'}sigh=${sigh}` : address
    // The smallest size has no interval: its frames just divide the video.
    const interval = Number(ms) > 0 ? Number(ms) : (Math.max(1, duration) * 1000) / count
    return [{ url, width, height, count, columns, rows: perColumn, interval }]
  })
}

/** The storyboard with the biggest tiles. */
export const largestStoryboard = (boards: Storyboard[]) => boards.reduce<Storyboard | null>((best, b) => (!best || b.width * b.height > best.width * best.height ? b : best), null)

export interface Tile {
  /** The tile's number in the whole video. */
  index: number
  /** The second of video it shows. */
  time: number
  sheet: number
  x: number
  y: number
  width: number
  height: number
}

/** The tile showing the video at `time`: which sheet it is on, and where. */
export function storyboardTile(board: Storyboard, time: number): Tile {
  const index = clamp(Math.floor((time * 1000) / board.interval), 0, board.count - 1)
  const perSheet = board.columns * board.rows
  const cell = index % perSheet
  return {
    index,
    time: round((index * board.interval) / 1000),
    sheet: Math.floor(index / perSheet),
    x: (cell % board.columns) * board.width,
    y: Math.floor(cell / board.columns) * board.height,
    width: board.width,
    height: board.height,
  }
}

/** `count` moments spread evenly over a stretch: the middle of each slice, so a fade at either end isn't all there is. */
export const spread = (from: number, to: number, count: number) => Array.from({ length: count }, (_, i) => from + ((i + 0.5) * (to - from)) / count)

/** Up to `count` different tiles spread over a stretch. */
export function pickTiles(board: Storyboard, from: number, to: number, count: number): Tile[] {
  const seen = new Set<number>()
  return spread(from, to, count)
    .map((t) => storyboardTile(board, t))
    .filter((t) => !seen.has(t.index) && seen.add(t.index))
}

/** Downloads only the sheets the tiles are on. */
async function loadTiles(board: Storyboard, tiles: Tile[]): Promise<WebVideo['tiles'] | undefined> {
  const numbers = [...new Set(tiles.map((t) => t.sheet))]
  const loaded = await pool(numbers, 6, (n) => fetchPicture(board.url.replace('$M', () => String(n))))
  const sheets: WebVideoPicture[] = []
  const place = new Map<number, number>()
  numbers.forEach((n, i) => {
    const picture = loaded[i]
    if (!picture) return
    place.set(n, sheets.length)
    sheets.push(picture)
  })
  const frames = tiles.filter((t) => place.has(t.sheet)).map((t) => ({ time: t.time, sheet: place.get(t.sheet)!, x: t.x, y: t.y, width: t.width, height: t.height }))
  return frames.length ? { sheets, frames } : undefined
}

// ─── YouTube ─────────────────────────────────────────────────────────────

const YOUTUBE_HOSTS = ['youtube.com', 'youtube-nocookie.com', 'youtu.be']
const isYouTube = (url: URL) => YOUTUBE_HOSTS.includes(bare(url.hostname).replace(/^(music|gaming)\./, ''))

/** The video id in any kind of YouTube link: watch, youtu.be, Shorts, live, embed, YouTube Music. */
export function youtubeId(url: URL): string | null {
  if (!isYouTube(url)) return null
  const id = (s?: string | null) => (s && /^[\w-]{11}$/.test(s) ? s : null)
  const [first, second] = url.pathname.split('/').filter(Boolean)
  if (bare(url.hostname) === 'youtu.be') return id(first)
  if (first === 'watch') return id(url.searchParams.get('v'))
  return ['shorts', 'live', 'embed', 'v', 'e'].includes(first) ? id(second) : null
}

/** The video a YouTube page says it is about (its canonical link). */
export function canonicalYouTubeId(html: string): string | null {
  const href = /<link\b[^>]*rel=["']canonical["'][^>]*>/i.exec(html)?.[0]
  const url = href && parseUrl(decodeEntities(/href=["']([^"']+)["']/i.exec(href)?.[1] ?? ''))
  return url ? youtubeId(url) : null
}

interface YtPlayer {
  playabilityStatus?: { status?: string; reason?: string; errorScreen?: { playerErrorMessageRenderer?: { subreason?: YtText } } }
  videoDetails?: {
    videoId?: string
    title?: string
    author?: string
    lengthSeconds?: string
    shortDescription?: string
    viewCount?: string
    isLive?: boolean
    isLiveContent?: boolean
    thumbnail?: { thumbnails?: { url?: string; width?: number }[] }
  }
  captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: { baseUrl?: string; languageCode?: string; kind?: string }[] } }
  storyboards?: { playerStoryboardSpecRenderer?: { spec?: string } }
  microformat?: { playerMicroformatRenderer?: { publishDate?: string; uploadDate?: string } }
}

/**
 * YouTube's own apps, as the player endpoint knows them. The website's caption
 * addresses come back empty without a token only a browser can make; the apps'
 * work as they are. Two, so one changing doesn't take the transcript with it.
 */
const YOUTUBE_APPS = [
  {
    agent: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
    client: { clientName: 'IOS', clientVersion: '20.10.4', deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.3.2.22D82' },
  },
  {
    agent: 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip',
    client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, osName: 'Android', osVersion: '11' },
  },
]

async function youtubePlayer(id: string, app: (typeof YOUTUBE_APPS)[number]): Promise<YtPlayer | null> {
  const player = await fetchJson<YtPlayer>('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': app.agent },
    body: JSON.stringify({ context: { client: { ...app.client, hl: 'en' } }, videoId: id, contentCheckOk: false, racyCheckOk: false }),
  })
  // An answer about some other video is no answer.
  return player.videoDetails?.videoId && player.videoDetails.videoId !== id ? null : player
}

/** A JSON object a page assigns to a variable in a script (`name = {…}`). */
export function embeddedJson(html: string, name: string): unknown {
  const found = new RegExp(`${name}\\s*=\\s*\\{`).exec(html)
  if (!found) return null
  const start = found.index + found[0].length - 1
  let depth = 0
  let quoted = false
  for (let i = start; i < html.length; i++) {
    const c = html[i]
    if (quoted) {
      if (c === '\\') i++
      else if (c === '"') quoted = false
    } else if (c === '"') quoted = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(html.slice(start, i + 1))
      } catch {
        return null
      }
    }
  }
  return null
}

/** The watch page: the website's player answer (it lists the largest preview pictures) and the chapters. */
async function youtubePage(id: string) {
  const html = await fetchText(`https://www.youtube.com/watch?v=${id}&hl=en`, { accept: 'text/html' })
  const player = embeddedJson(html, 'ytInitialPlayerResponse') as YtPlayer | null
  return { player: player?.videoDetails?.videoId && player.videoDetails.videoId !== id ? null : player, data: embeddedJson(html, 'ytInitialData') }
}

const playable = (p?: YtPlayer | null) => p?.playabilityStatus?.status === 'OK'

const youtubeTracks = (p: YtPlayer): CaptionTrack[] =>
  (p.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []).flatMap((t) => (t.baseUrl && t.languageCode ? [{ url: t.baseUrl, language: t.languageCode, auto: t.kind === 'asr' }] : []))

async function watchYouTube(id: string, want: Wanted): Promise<WebVideo> {
  const page = youtubePage(id).catch(() => null)
  let viaApp: YtPlayer | null = null
  let transcript: WebVideo['transcript']
  let tracks: CaptionTrack[] = []
  for (const app of YOUTUBE_APPS) {
    const player = await youtubePlayer(id, app).catch(() => null)
    if (!player) continue
    if (!viaApp || (playable(player) && !playable(viaApp))) viaApp = player
    if (!playable(player)) continue
    tracks = youtubeTracks(player)
    if (!want.transcript || !tracks.length) break
    transcript = await readTrack(tracks, want, app.agent).catch(() => undefined)
    if (transcript) break
  }
  const site = await page
  const answers = [viaApp, site?.player].filter((p): p is YtPlayer => Boolean(p))
  const best = answers.find(playable) ?? answers.find((p) => p.videoDetails?.title) ?? answers[0]
  if (!best) throw new Error('YouTube didn’t answer. Check the connection and try again.')
  const details = best.videoDetails ?? {}
  const said = [best.playabilityStatus?.reason ?? 'This video is unavailable', ytText(best.playabilityStatus?.errorScreen?.playerErrorMessageRenderer?.subreason)]
  const refusal = playable(best) ? '' : said.map((s) => tidy(s).replace(/\.$/, '')).filter(Boolean).join('. ')
  if (refusal && !details.title) throw new Error(`YouTube says: “${refusal}.” Check the link — the video may be removed or private.`)

  // A stream that is live (or was, and is gone) reports a length that means nothing.
  const duration = details.isLive || (refusal && details.isLiveContent) ? undefined : Number(details.lengthSeconds) || undefined
  const description = details.shortDescription ?? ''
  const published = answers.map((p) => p.microformat?.playerMicroformatRenderer).map((m) => m?.publishDate ?? m?.uploadDate).find(Boolean)
  const video: WebVideo = {
    url: `https://www.youtube.com/watch?v=${id}`,
    site: 'YouTube',
    ...(details.title ? { title: details.title } : {}),
    ...(details.author ? { author: details.author } : {}),
    ...(duration ? { duration } : {}),
    ...(description ? { description } : {}),
    ...(published ? { published: published.slice(0, 10) } : {}),
    ...(Number(details.viewCount) ? { views: Number(details.viewCount) } : {}),
    ...(details.isLive ? { live: true } : {}),
    chapters: [],
    watchedWith: '',
    notes: [],
  }
  const how: string[] = []
  const chapters = youtubeChapters(site?.data)
  video.chapters = chapters.length ? chapters : descriptionChapters(description, duration)

  if (refusal) {
    video.notes.push(`YouTube won’t play this video: “${refusal}.” Lumen doesn’t sign in or work around restrictions, so there is no transcript and there are no frames — only the title, description and thumbnail.`)
  } else if (details.isLive) {
    video.notes.push('It’s live right now: a stream that is still running has no transcript and no frames to spread over it — only its title, description and current thumbnail. Watch it again once it has ended.')
  } else {
    if (transcript) {
      video.transcript = transcript
      how.push('YouTube captions')
    } else if (want.transcript) {
      video.notes.push(
        tracks.length
          ? `YouTube lists captions (${listed(tracks).slice(0, 8).join(', ')}) but didn’t hand them over this time, so there is no transcript. Try again in a moment.`
          : viaApp && playable(viaApp)
            ? 'This video has no captions, so there is no transcript of what is said.'
            : 'YouTube didn’t give Lumen the captions this time, so there is no transcript. Try again in a moment.',
      )
    }
    const board = duration ? largestStoryboard(answers.filter(playable).flatMap((p) => parseStoryboards(p.storyboards?.playerStoryboardSpecRenderer?.spec ?? '', duration))) : null
    if (board && duration) {
      const [from, to] = stretch(want, duration)
      const every = `one every ${round(board.interval / 1000, 1)} s`
      video.tiles = await loadTiles(board, pickTiles(board, from, to, want.frames))
      if (!video.tiles) video.notes.push('YouTube’s preview frames didn’t load, so only the thumbnail is shown. Try again in a moment.')
      else {
        how.push(`YouTube preview frames (${every}, ${board.width}×${board.height})`)
        if (video.tiles.frames.length < want.frames && (to - from) * 1000 < want.frames * board.interval) video.notes.push(`YouTube keeps ${every.replace('one', 'one preview frame')}, so this stretch has ${video.tiles.frames.length} different frames.`)
      }
    } else if (!(await viaYtDlp(new URL(video.url), video, { ...want, transcript: false }, how))) {
      video.notes.push(`YouTube has no preview frames for this video (it is very short or very new), so only its thumbnail is shown.${findYtDlp() ? '' : ' With yt-dlp installed, Lumen can look at the video itself.'}`)
    }
  }
  if (!video.tiles) {
    const thumbs = [...(details.thumbnail?.thumbnails ?? [])].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))
    video.thumbnail = (thumbs[0]?.url ? await fetchPicture(thumbs[0].url) : null) ?? (await fetchPicture(`https://i.ytimg.com/vi/${id}/hqdefault.jpg`)) ?? undefined
  }
  return done(video, how)
}

function done(video: WebVideo, how: string[]): WebVideo {
  video.watchedWith = how.join(', ') || 'the page’s public details only'
  if (video.description && video.description.length > 6000) video.description = `${video.description.slice(0, 6000)}…`
  return video
}

// ─── Pages with a video on them ──────────────────────────────────────────

export interface PageVideo {
  title?: string
  description?: string
  author?: string
  site?: string
  duration?: number
  published?: string
  thumbnail?: string
  /** Addresses that may be the video file itself. */
  media: string[]
  /** Players the page carries (a YouTube or Vimeo frame). */
  embeds: string[]
  /** The page's oEmbed address, when it names one. */
  oembed?: string
  /** The page says it has a video (whether or not it says where). */
  video: boolean
}

const VIDEO_FILE = /\.(mp4|m4v|mov|webm|mkv)$/i
/** Sites that show their videos only inside their own player, usually after sign-in. */
const PLAYER_ONLY = /(^|\.)(tiktok\.com|instagram\.com|twitch\.tv|facebook\.com|fb\.watch|reddit\.com|redd\.it|dailymotion\.com|dai\.ly|bilibili\.com|threads\.(net|com)|snapchat\.com|linkedin\.com|rumble\.com|kick\.com|vk\.com)$/

interface LdVideo {
  '@type'?: string | string[]
  name?: string
  description?: string
  duration?: string
  uploadDate?: string
  contentUrl?: string
  embedUrl?: string
  thumbnailUrl?: string | string[] | { url?: string }
  author?: { name?: string } | string
}

/** Every schema.org VideoObject in a page's JSON-LD, however deeply it sits. */
function ldVideos(html: string): LdVideo[] {
  const out: LdVideo[] = []
  const visit = (node: unknown, depth: number) => {
    if (!node || typeof node !== 'object' || depth > 6) return
    if (Array.isArray(node)) return node.forEach((n) => visit(n, depth + 1))
    const type = (node as LdVideo)['@type']
    if (type === 'VideoObject' || (Array.isArray(type) && type.includes('VideoObject'))) out.push(node as LdVideo)
    for (const value of Object.values(node)) visit(value, depth + 1)
  }
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      visit(JSON.parse(m[1]), 0)
    } catch {
      /* not JSON after all */
    }
  }
  return out
}

/** What a page says in public about the video on it: Open Graph, Twitter cards, JSON-LD, and its own video tags. */
export function parseVideoPage(html: string, base: URL): PageVideo {
  const ld = ldVideos(html)[0]
  const text = (...values: (string | undefined)[]) => values.map((v) => (typeof v === 'string' ? tidy(v) : '')).find(Boolean)
  const link = (v: unknown) => (typeof v === 'string' && v ? absolute(v, base) : null)
  const ldThumb = Array.isArray(ld?.thumbnailUrl) ? ld.thumbnailUrl[0] : typeof ld?.thumbnailUrl === 'object' ? ld.thumbnailUrl?.url : ld?.thumbnailUrl
  const seconds = Number(meta(html, 'video:duration') ?? meta(html, 'og:video:duration'))
  const duration = seconds > 0 ? seconds : isoDuration(ld?.duration ?? meta(html, 'duration') ?? '')
  const published = text(ld?.uploadDate, meta(html, 'article:published_time'), meta(html, 'og:video:release_date'))

  const declared = meta(html, 'og:video:type') ?? ''
  const og = [meta(html, 'og:video:secure_url'), meta(html, 'og:video:url'), meta(html, 'og:video')]
  const tags = [...html.matchAll(/<(?:video|source)\b[^>]*\ssrc=["']([^"']+)["'][^>]*>/gi)].filter((m) => /^<video/i.test(m[0]) || /type=["']video\//i.test(m[0]) || VIDEO_FILE.test(m[1].split('?')[0])).map((m) => m[1])
  const media = [ld?.contentUrl, meta(html, 'twitter:player:stream'), ...og.filter((u) => u && (declared.startsWith('video/') || VIDEO_FILE.test(u.split('?')[0]))), ...tags]
  const frames = [...html.matchAll(/<iframe\b[^>]*\ssrc=["']([^"']+)["']/gi)].map((m) => m[1])
  const embeds = [ld?.embedUrl, ...og, meta(html, 'twitter:player'), ...frames]
  const unique = (list: unknown[]) => [...new Set(list.map(link).filter((u): u is string => Boolean(u)))]
  const oembed = /<link\b[^>]*type=["']application\/json\+oembed["'][^>]*>/i.exec(html)?.[0]
  const oembedHref = oembed && link(/href=["']([^"']+)["']/i.exec(oembed)?.[1])
  const author = typeof ld?.author === 'string' ? ld.author : ld?.author?.name

  const page: PageVideo = {
    title: text(meta(html, 'og:title'), meta(html, 'twitter:title'), ld?.name, strip(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '')),
    description: text(meta(html, 'og:description'), ld?.description, meta(html, 'description'), meta(html, 'twitter:description')),
    author: text(author, meta(html, 'author')),
    site: text(meta(html, 'og:site_name')),
    duration: duration && duration > 0 ? duration : undefined,
    published: published && /^(19|20)\d{2}-\d{2}-\d{2}/.test(published) ? published.slice(0, 10) : undefined,
    thumbnail: link(meta(html, 'og:image:secure_url') ?? meta(html, 'og:image') ?? meta(html, 'twitter:image') ?? ldThumb) ?? undefined,
    // A name that ends like a video file first: it is the likeliest to be one.
    media: unique(media).sort((a, b) => Number(VIDEO_FILE.test(new URL(b).pathname)) - Number(VIDEO_FILE.test(new URL(a).pathname))),
    embeds: unique(embeds),
    oembed: oembedHref ?? undefined,
    video: Boolean(ld) || media.some(Boolean) || og.some(Boolean) || /^video/.test(meta(html, 'og:type') ?? '') || meta(html, 'twitter:card') === 'player' || /<video\b/i.test(html),
  }
  return Object.fromEntries(Object.entries(page).filter(([, v]) => v !== undefined)) as unknown as PageVideo
}

/** Fills in what isn't known yet. */
function fill(video: WebVideo, more: Partial<Pick<WebVideo, 'title' | 'author' | 'duration' | 'description' | 'published'>>) {
  for (const key of ['title', 'author', 'duration', 'description', 'published'] as const) {
    const value = more[key]
    if (video[key] === undefined && value !== undefined && value !== '') Object.assign(video, { [key]: value })
  }
}

/** Sites whose pages say nothing without scripts, but answer oEmbed. */
const OEMBED: [RegExp, string][] = [
  [/(^|\.)tiktok\.com$/, 'https://www.tiktok.com/oembed?url='],
  [/(^|\.)dailymotion\.com$|^dai\.ly$/, 'https://www.dailymotion.com/services/oembed?url='],
]

interface OEmbed {
  title?: string
  author_name?: string
  provider_name?: string
  thumbnail_url?: string
  description?: string
  duration?: number
}

async function readOEmbed(address: string, video: WebVideo): Promise<string | undefined> {
  const o = await fetchJson<OEmbed>(address)
  fill(video, { title: tidy(o.title ?? '') || undefined, author: tidy(o.author_name ?? '') || undefined, description: tidy(o.description ?? '') || undefined, duration: finite(o.duration) })
  if (o.provider_name && video.site.includes('.')) video.site = o.provider_name
  return typeof o.thumbnail_url === 'string' ? o.thumbnail_url : undefined
}

// ─── Vimeo ───────────────────────────────────────────────────────────────

/** The video (and, for unlisted ones, the hash) in a Vimeo link or player address. */
export function vimeoRef(url: URL): { id: string; hash?: string } | null {
  const host = bare(url.hostname)
  const hash = (h?: string | null) => (h && /^[\da-f]{6,}$/i.test(h) ? { hash: h } : {})
  if (host === 'player.vimeo.com') {
    const id = /^\/video\/(\d+)/.exec(url.pathname)?.[1]
    return id ? { id, ...hash(url.searchParams.get('h')) } : null
  }
  if (host !== 'vimeo.com') return null
  const m = /\/(\d{6,})(?:\/([\da-f]{6,}))?\/?$/i.exec(url.pathname)
  return m ? { id: m[1], ...hash(m[2] ?? url.searchParams.get('h')) } : null
}

interface VimeoConfig {
  video?: { title?: string; duration?: number; owner?: { name?: string }; thumbnail_url?: string }
  request?: {
    text_tracks?: { lang?: string; url?: string; kind?: string; provenance?: string }[]
    thumb_preview?: { url?: string; frame_width?: number; frame_height?: number; columns?: number; frames?: number }
  }
}

/** Vimeo's player config is public: the title, captions, and one sprite sheet of frames across the video. */
async function readVimeo(ref: { id: string; hash?: string }, video: WebVideo, want: Wanted, how: string[]): Promise<string | undefined> {
  const config = await fetchJson<VimeoConfig>(`https://player.vimeo.com/video/${ref.id}/config${ref.hash ? `?h=${ref.hash}` : ''}`).catch(() => null)
  if (!config) return undefined
  video.site = 'Vimeo'
  fill(video, { title: config.video?.title, author: config.video?.owner?.name, duration: finite(config.video?.duration) })
  const tracks: CaptionTrack[] = (config.request?.text_tracks ?? []).flatMap((t) => {
    const url = t.url ? absolute(t.url, new URL('https://player.vimeo.com')) : null
    return url && t.lang ? [{ url, language: t.lang, auto: Boolean(t.provenance && t.provenance !== 'user_uploaded') }] : []
  })
  if (want.transcript) {
    video.transcript = await readTrack(tracks, want).catch(() => undefined)
    if (video.transcript) how.push('Vimeo captions')
    else video.notes.push(tracks.length ? 'Vimeo lists captions but didn’t hand them over, so there is no transcript.' : 'This video has no captions on Vimeo, so there is no transcript of what is said.')
  }
  const sprite = config.request?.thumb_preview
  const duration = video.duration
  if (duration && sprite?.url && sprite.frame_width && sprite.frame_height && sprite.columns && sprite.frames) {
    const board: Storyboard = { url: sprite.url, width: Math.round(sprite.frame_width), height: Math.round(sprite.frame_height), count: sprite.frames, columns: sprite.columns, rows: Math.ceil(sprite.frames / sprite.columns), interval: (duration * 1000) / sprite.frames }
    const [from, to] = stretch(want, duration)
    video.tiles = await loadTiles(board, pickTiles(board, from, to, want.frames))
    if (video.tiles) how.push(`Vimeo preview frames (one every ${round(board.interval / 1000, 1)} s, ${board.width}×${board.height})`)
  }
  return config.video?.thumbnail_url
}

// ─── Posts on X ──────────────────────────────────────────────────────────

/** The post number in an x.com / twitter.com link. */
export function xPostId(url: URL): string | null {
  if (!['x.com', 'twitter.com'].includes(bare(url.hostname))) return null
  return /\/status(?:es)?\/(\d{5,25})/.exec(url.pathname)?.[1] ?? null
}

interface XVariant {
  bitrate?: number
  content_type?: string
  url?: string
}

/** The MP4 to watch: the largest up to about 480p — enough to see, quick to fetch. */
export function pickXVariant(variants: XVariant[]): string | null {
  const files = variants
    .filter((v) => v.url && v.content_type === 'video/mp4')
    .map((v) => {
      const size = /\/(\d{2,4})x(\d{2,4})\//.exec(v.url!)
      return { url: v.url!, short: size ? Math.min(Number(size[1]), Number(size[2])) : 0, bitrate: v.bitrate ?? 0 }
    })
    .sort((a, b) => a.short - b.short || a.bitrate - b.bitrate)
  return (files.filter((f) => f.short > 0 && f.short <= 480).pop() ?? files[0])?.url ?? null
}

interface XPost {
  text?: string
  created_at?: string
  user?: { name?: string; screen_name?: string }
  mediaDetails?: { type?: string; media_url_https?: string; video_info?: { duration_millis?: number; variants?: XVariant[] } }[]
}

/** A post through the endpoint X's own embeds use: its text, and the video file when it has one. */
async function readXPost(id: string, video: WebVideo, media: string[]): Promise<string | undefined> {
  // The token X's embed script derives from the post number.
  const token = ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '')
  const post = await fetchJson<XPost>(`https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${token}&lang=en`)
  video.site = 'X'
  const said = tidy(post.text ?? '')
  const clip = post.mediaDetails?.find((m) => m.video_info)
  fill(video, {
    title: said ? (said.length > 100 ? `${said.slice(0, 100)}…` : said) : undefined,
    description: post.text?.trim() || undefined,
    author: post.user?.name ? `${post.user.name}${post.user.screen_name ? ` (@${post.user.screen_name})` : ''}` : undefined,
    published: post.created_at && /^\d{4}-\d{2}-\d{2}/.test(post.created_at) ? post.created_at.slice(0, 10) : undefined,
    duration: clip?.video_info?.duration_millis ? clip.video_info.duration_millis / 1000 : undefined,
  })
  const file = pickXVariant(clip?.video_info?.variants ?? [])
  if (file) media.push(file)
  else video.notes.push('This post on X has no video on it: what is here is its text and picture.')
  return clip?.media_url_https ?? post.mediaDetails?.[0]?.media_url_https
}

// ─── Video files ─────────────────────────────────────────────────────────

/** What an answer is, from its content type (and, when the server doesn't know, its name). */
export function mediaKind(type: string, pathname: string): 'video' | 'stream' | 'audio' | 'image' | 'page' {
  const t = type.split(';')[0].trim().toLowerCase()
  // Playlists of segments (HLS, DASH), not files.
  if (/mpegurl|dash\+xml/.test(t) || /\.(m3u8|mpd)$/i.test(pathname)) return 'stream'
  if (t.startsWith('video/')) return 'video'
  if (t.startsWith('audio/')) return 'audio'
  if (t.startsWith('image/')) return 'image'
  if ((!t || t === 'application/octet-stream' || t === 'binary/octet-stream') && VIDEO_FILE.test(pathname)) return 'video'
  return 'page'
}

const tooBig = (bytes: number | null, cap: number) =>
  `The video file is ${bytes ? megabytes(bytes) : `over ${megabytes(cap)}`} — Lumen downloads at most ${megabytes(cap)} to watch a link, so it wasn’t watched.`

/**
 * Saves a download to `file`, refusing anything over `cap`: up front when the
 * server says how long it is, and by stopping the download when it doesn't.
 */
export async function saveCapped(res: Response, file: string, cap = FILE_CAP): Promise<number> {
  const declared = Number(res.headers.get('content-length'))
  if (declared > cap) {
    void res.body?.cancel().catch(() => {})
    throw new Error(tooBig(declared, cap))
  }
  const reader = res.body?.getReader()
  if (!reader) throw new Error('The download came back empty.')
  const out = fs.createWriteStream(file)
  const disk: { error?: Error } = {}
  out.on('error', (err) => (disk.error = err))
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > cap) throw new Error(tooBig(null, cap))
      if (disk.error) throw disk.error
      if (!out.write(value)) await once(out, 'drain')
    }
    out.end()
    await finished(out)
  } catch (err) {
    await reader.cancel().catch(() => {})
    // Windows won't delete a file that is still open: wait for the stream to let go of it.
    if (!out.closed) {
      out.destroy()
      await once(out, 'close').catch(() => {})
    }
    await fs.promises.rm(file, { force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
    throw err
  }
  if (!size) {
    await fs.promises.rm(file, { force: true }).catch(() => {})
    throw new Error('The download came back empty.')
  }
  return size
}

const FILE_EXT: Record<string, string> = { 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'video/x-matroska': '.mkv', 'video/x-m4v': '.m4v' }
const FILE_MIME: Record<string, string> = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska' }

/** Temporary files the editor is still reading. */
const kept = new Map<string, { dir: string; at: number }>()
/** Long enough for the editor to sample its frames; a forgotten file doesn't outlive this. */
const KEEP_MS = 15 * 60_000
let tidied = false

/** Deletes a watched video's temporary file. */
export function releaseVideo(id: string) {
  const file = kept.get(id)
  if (!file) return
  kept.delete(id)
  fs.rm(file.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }, () => {})
}

function sweep() {
  const now = Date.now()
  for (const [id, file] of kept) if (now - file.at > KEEP_MS) releaseVideo(id)
  if (tidied) return
  tidied = true
  app.once('will-quit', () => {
    for (const file of kept.values()) fs.rmSync(file.dir, { recursive: true, force: true })
  })
  // What a run that crashed mid-watch left behind (another copy of Lumen may be using newer ones).
  const root = path.join(app.getPath('temp'), 'lumen', 'watch')
  fs.readdir(root, (err, names) => {
    for (const name of err ? [] : names) {
      const dir = path.join(root, name)
      fs.stat(dir, (failed, stat) => {
        if (!failed && now - stat.mtimeMs > 3600_000) fs.rm(dir, { recursive: true, force: true }, () => {})
      })
    }
  })
}

/** Downloads a video answer to a temporary file the editor may read. */
async function keep(reply: Reply): Promise<NonNullable<WebVideo['file']>> {
  if (!reply.res.ok) {
    drop(reply)
    throw new Error(`${reply.url.hostname} answered ${reply.res.status} for the video file.`)
  }
  reply.allow(DOWNLOAD_MS)
  const named = path.extname(reply.url.pathname).toLowerCase()
  const mime = FILE_EXT[reply.type] ? reply.type : (FILE_MIME[named] ?? (reply.type.startsWith('video/') ? reply.type : 'video/mp4'))
  const id = randomUUID()
  const dir = workDir('watch', id)
  const file = path.join(dir, `video${FILE_EXT[mime] ?? (FILE_MIME[named] ? named : '.mp4')}`)
  try {
    const size = await saveCapped(reply.res, file)
    kept.set(id, { dir, at: Date.now() })
    allowPath(file)
    return { id, url: fileUrl(file), mime, size }
  } catch (err) {
    fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }, () => {})
    throw err
  }
}

const NO_FILE_TRANSCRIPT = 'There is no transcript: this is a plain video file with no captions beside it. To hear what is said, bring it into the project with import_media_url and use transcribe_media.'

/** Tries each address until one answers with a video file. True when one did; otherwise why not (empty when none was a video at all). */
async function watchFile(addresses: string[], video: WebVideo, how: string[], headers?: Record<string, string>): Promise<true | string> {
  let trouble = ''
  for (const address of addresses.slice(0, 4)) {
    try {
      const reply = await open(address, { accept: 'video/*,*/*;q=0.8', headers })
      const kind = mediaKind(reply.type, reply.url.pathname)
      if (kind !== 'video') {
        drop(reply)
        if (kind === 'stream') trouble ||= 'The site serves this video as a stream of segments (HLS or DASH), which Lumen can’t sample directly.'
        continue
      }
      video.file = await keep(reply)
      how.push(`the video file itself (${megabytes(video.file.size)}, downloaded to a temporary file)`)
      return true
    } catch (err) {
      trouble = err instanceof Error ? err.message : String(err)
    }
  }
  return trouble
}

// ─── yt-dlp (only if the user has it) ────────────────────────────────────

let ytDlp: string | undefined

/** yt-dlp on the PATH. Lumen never downloads or bundles it. */
export function findYtDlp(): string | null {
  if (ytDlp && fs.existsSync(ytDlp)) return ytDlp
  const name = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const file = path.join(dir.replace(/^"|"$/g, ''), name)
    try {
      if (dir && fs.statSync(file).isFile()) return (ytDlp = file)
    } catch {
      /* not here */
    }
  }
  return null
}

interface YtDlpFormat {
  url?: string
  ext?: string
  protocol?: string
  vcodec?: string
  height?: number
  filesize?: number
  filesize_approx?: number
  has_drm?: boolean
  http_headers?: Record<string, string>
}

interface YtDlpSub {
  ext?: string
  url?: string
}

interface YtDlpInfo {
  title?: string
  uploader?: string
  channel?: string
  duration?: number
  description?: string
  upload_date?: string
  thumbnail?: string
  extractor_key?: string
  is_live?: boolean
  chapters?: { start_time?: number; title?: string }[]
  subtitles?: Record<string, YtDlpSub[]>
  automatic_captions?: Record<string, YtDlpSub[]>
  formats?: YtDlpFormat[]
}

/** How well this computer is likely to decode a codec: H.264 everywhere, then VP9, AV1, the rest. */
const codecRank = (codec = '') => (/^avc/.test(codec) ? 0 : /^vp0?9/.test(codec) ? 1 : /^av01/.test(codec) ? 2 : /^vp0?8/.test(codec) ? 3 : 4)

/**
 * The format to download for a look: a plain file (not a segmented stream),
 * under the size cap when its size is known, at most 480p when there is one
 * that small — in the codec most likely to decode, then the sharpest of
 * those, then the lightest. Otherwise the smallest there is.
 */
export function pickFormat(formats: YtDlpFormat[], cap = FILE_CAP): YtDlpFormat | null {
  const files = formats.filter((f) => f.url && /^https?:/.test(f.url) && (f.protocol ?? 'https').startsWith('http') && f.vcodec && f.vcodec !== 'none' && !f.has_drm && ['mp4', 'm4v', 'webm', 'mov', 'mkv'].includes(f.ext ?? '') && (f.filesize ?? f.filesize_approx ?? 0) <= cap)
  const size = (f: YtDlpFormat) => f.filesize ?? f.filesize_approx ?? Infinity
  const height = (f: YtDlpFormat) => f.height ?? 0
  const small = files.filter((f) => height(f) > 0 && height(f) <= 480)
  if (small.length) return small.sort((a, b) => codecRank(a.vcodec) - codecRank(b.vcodec) || height(b) - height(a) || size(a) - size(b))[0]
  return [...files].sort((a, b) => (height(a) || Infinity) - (height(b) || Infinity) || codecRank(a.vcodec) - codecRank(b.vcodec) || size(a) - size(b))[0] ?? null
}

/** The caption tracks in yt-dlp's answer, in the formats Lumen reads. */
export function ytDlpTracks(info: YtDlpInfo, language?: string): CaptionTrack[] {
  const best = (subs: YtDlpSub[]) => ['json3', 'vtt', 'srv3', 'srv1', 'srt'].map((ext) => subs.find((s) => s.ext === ext && s.url)).find(Boolean)?.url
  const tracks = (map: Record<string, YtDlpSub[]> | undefined, auto: boolean) =>
    Object.entries(map ?? {}).flatMap(([lang, subs]) => {
      const url = lang === 'live_chat' || !Array.isArray(subs) ? undefined : best(subs)
      return url ? [{ url, language: lang.replace(/-orig$/, ''), auto }] : []
    })
  // Auto captions come machine-translated into a hundred languages: only the spoken one, English and the one asked for matter.
  const spoken = Object.keys(info.automatic_captions ?? {}).filter((l) => l.endsWith('-orig')).map((l) => primary(l))
  const wanted = new Set(['en', ...spoken, ...(language ? [primary(language)] : [])])
  const auto = Object.fromEntries(Object.entries(info.automatic_captions ?? {}).filter(([lang]) => lang.endsWith('-orig') || wanted.has(primary(lang))))
  return [...tracks(info.subtitles, false), ...tracks(auto, true)]
}

function runYtDlp(bin: string, url: string): Promise<YtDlpInfo> {
  return new Promise((resolve, reject) => {
    // No config and no playlist: one video, no cookies from the user's own setup.
    execFile(bin, ['--ignore-config', '--no-playlist', '--no-warnings', '--skip-download', '-J', '--', url], { timeout: 90_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true, signal: watching.getStore() }, (err, stdout, stderr) => {
      if (watching.getStore()?.aborted) return reject(new Error(STOPPED))
      if (err) {
        const said = String(stderr).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop()
        return reject(new Error(said ? said.replace(/^ERROR:\s*/, '').slice(0, 300) : err.message))
      }
      try {
        resolve(JSON.parse(String(stdout)) as YtDlpInfo)
      } catch {
        reject(new Error('yt-dlp answered with something unreadable.'))
      }
    })
  })
}

/** Headers yt-dlp says the file needs — never cookies, and none Electron refuses to send. */
const downloadHeaders = (h: Record<string, string> = {}) => Object.fromEntries(Object.entries(h).filter(([name, value]) => typeof value === 'string' && /^(user-agent|accept|accept-language)$/i.test(name)))

/** Opens the page with the user's yt-dlp: details, captions and a small file to look at. True when it gave frames. */
async function viaYtDlp(url: URL, video: WebVideo, want: Wanted, how: string[]): Promise<boolean> {
  const bin = findYtDlp()
  if (!bin) return false
  let info: YtDlpInfo
  try {
    info = await runYtDlp(bin, url.href)
  } catch (err) {
    video.notes.push(`yt-dlp couldn’t open it: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
  if (info.extractor_key && info.extractor_key !== 'Generic' && video.site.includes('.')) video.site = info.extractor_key
  fill(video, {
    title: info.title,
    author: info.uploader ?? info.channel,
    duration: finite(info.duration),
    description: info.description,
    published: /^\d{8}$/.test(info.upload_date ?? '') ? `${info.upload_date!.slice(0, 4)}-${info.upload_date!.slice(4, 6)}-${info.upload_date!.slice(6)}` : undefined,
  })
  if (info.is_live) video.live = true
  if (!video.chapters.length) video.chapters = (info.chapters ?? []).flatMap((c) => (typeof c.start_time === 'number' && c.title ? [{ start: c.start_time, title: tidy(c.title) }] : []))
  if (want.transcript && !video.transcript) {
    video.transcript = await readTrack(ytDlpTracks(info, want.language), want).catch(() => undefined)
    if (video.transcript) how.push('captions found by yt-dlp')
  }
  const format = info.is_live ? null : pickFormat(info.formats ?? [])
  if (!format?.url) {
    video.notes.push(info.is_live ? 'It’s live right now, so there are no frames to spread over it.' : 'yt-dlp found the video, but only as a stream of segments or over the size limit — not as a file Lumen can sample frames from.')
    return false
  }
  const watched = await watchFile([format.url], video, how, downloadHeaders(format.http_headers))
  if (watched === true) how.push('found by yt-dlp')
  else video.notes.push(`yt-dlp found the video but its file didn’t download${watched ? `: ${watched}` : '.'}`)
  return watched === true
}

// ─── Everything that isn't YouTube ───────────────────────────────────────

const fileTitle = (url: URL) => {
  const name = url.pathname.split('/').filter(Boolean).pop() ?? ''
  try {
    return decodeURIComponent(name) || url.hostname
  } catch {
    return name || url.hostname
  }
}

async function watchElsewhere(url: URL, want: Wanted): Promise<WebVideo> {
  const video: WebVideo = { url: url.href, site: bare(url.hostname), chapters: [], watchedWith: '', notes: [] }
  const how: string[] = []
  /** Addresses that may be the video file. */
  const media: string[] = []
  let thumbnail: string | undefined
  let blocked = ''
  /** The page says there is a video, or the site is one that keeps its videos to its own player. */
  let promised = PLAYER_ONLY.test(bare(url.hostname))
  /** A post with only text and pictures: there is nothing to watch, and nothing went wrong. */
  let plainPost = false

  const post = xPostId(url)
  if (post) {
    thumbnail = await readXPost(post, video, media).catch((err: unknown) => {
      blocked = `X didn’t show this post (${err instanceof Error ? err.message.replace(/\.$/, '') : 'no answer'}) — it may be deleted, private or age-restricted.`
      return undefined
    })
    plainPost = !blocked && !media.length
    promised = true
  } else {
    const reply = await open(url.href, { accept: 'text/html,application/xhtml+xml,video/*;q=0.9,*/*;q=0.8' })
    const kind = mediaKind(reply.type, reply.url.pathname)
    if (kind === 'video') {
      video.url = reply.url.href
      video.title = fileTitle(reply.url)
      video.file = await keep(reply)
      video.notes.push(NO_FILE_TRANSCRIPT)
      return done(video, [`the video file itself (${megabytes(video.file.size)}, downloaded to a temporary file)`])
    }
    if (kind !== 'page') {
      drop(reply)
      if (kind === 'stream') throw new Error('That address is a stream playlist (HLS or DASH), not a video file or a page. Pass the page the video is on.')
      throw new Error(kind === 'audio' ? 'That link is an audio file, not a video. import_media_url brings it into the project.' : 'That link is a picture, not a video. read_web_page shows it.')
    }
    if (!reply.res.ok) {
      drop(reply)
      const gone = reply.res.status === 404 || reply.res.status === 410
      blocked = `${reply.url.hostname} answered ${reply.res.status} — ${gone ? 'there is nothing at that address.' : 'it may need sign-in or turn automated visits away.'}`
    } else {
      const page = parseVideoPage((await read(reply.res, PAGE_BYTES)).toString('utf8'), reply.url)
      const players = page.embeds.map((e) => parseUrl(e)).filter((u): u is URL => Boolean(u))
      // A page that just carries a YouTube player: watch that video.
      const [youtube, ...others] = [...new Set(players.map(youtubeId).filter((id): id is string => Boolean(id)))]
      if (youtube) {
        const embedded = await watchYouTube(youtube, want)
        const more = others.length ? ` The page has ${others.length === 1 ? 'one more video' : `${others.length} more videos`}: ${others.slice(0, 5).map((id) => `https://www.youtube.com/watch?v=${id}`).join(', ')}.` : ''
        embedded.notes.unshift(`The page at ${reply.url.hostname} carries this YouTube video; that is what was watched.${more}`)
        return embedded
      }
      promised ||= page.video
      video.url = reply.url.href
      if (page.site) video.site = page.site
      fill(video, page)
      media.push(...page.media)
      thumbnail = page.thumbnail
      // The page's own player address carries the hash an unlisted video needs.
      const vimeos = [vimeoRef(reply.url), ...players.map(vimeoRef)].filter((v): v is NonNullable<typeof v> => Boolean(v))
      const vimeo = vimeos.find((v) => v.hash) ?? vimeos[0]
      const known = OEMBED.find(([host]) => host.test(bare(reply.url.hostname)))?.[1]
      const oembed = page.oembed ?? (known ? known + encodeURIComponent(reply.url.href) : undefined)
      if (vimeo) thumbnail = (await readVimeo(vimeo, video, want, how)) ?? thumbnail
      else if (oembed) thumbnail = (await readOEmbed(oembed, video).catch(() => undefined)) ?? thumbnail
    }
  }

  // The video file itself, when the page names one; then yt-dlp, when the user has it.
  const tried = !video.tiles && media.length ? await watchFile(media, video, how) : ''
  if (!video.tiles && !video.file && !plainPost) await viaYtDlp(url, video, want, how)
  if (video.file && !video.transcript && want.transcript) video.notes.push(NO_FILE_TRANSCRIPT)
  if (!video.tiles && !video.file && !plainPost) {
    const install = findYtDlp() ? '' : promised ? ` Installing yt-dlp (github.com/yt-dlp/yt-dlp) lets Lumen watch ${video.site} and many other sites.` : ' With yt-dlp installed (github.com/yt-dlp/yt-dlp), Lumen can open many more sites.'
    if (!video.title && !video.description) throw new Error(blocked || `Lumen found no video at ${url.hostname}: the page names none in public.${install}`)
    const why = blocked || (typeof tried === 'string' && tried)
    video.notes.unshift(
      why || promised
        ? `Lumen couldn’t watch this one: ${why || `${video.site} only hands its videos to its own player, often only after sign-in.`} What is here is the page’s public title, description and thumbnail.${install}`
        : `Lumen found no video on this page: nothing in it names one in public. It may be loaded by scripts (screenshot_web_page shows the page as a browser draws it), or there may be none.${install}`,
    )
  }
  if (!video.tiles && thumbnail) video.thumbnail = (await fetchPicture(thumbnail)) ?? undefined
  return done(video, how)
}

// ─── The one way in ──────────────────────────────────────────────────────

/**
 * Watches the video at `raw`: details, transcript and frames as far as they
 * can be had without signing in. With `release`, deletes the temporary file an
 * earlier answer pointed at instead; with `cancel`, stops a watch in progress.
 */
export async function watchVideo(raw: string, options: WebVideoOptions = {}): Promise<WebVideo> {
  const nothing: WebVideo = { url: '', site: '', chapters: [], watchedWith: '', notes: [] }
  if (typeof options.release === 'string' && options.release) {
    releaseVideo(options.release)
    return nothing
  }
  if (typeof options.cancel === 'string' && options.cancel) {
    watches.get(options.cancel)?.abort()
    return nothing
  }
  const id = typeof options.id === 'string' ? options.id.slice(0, 64) : ''
  const stop = new AbortController()
  if (id) watches.set(id, stop)
  try {
    const video = await watching.run(stop.signal, () => watchPublic(raw, options))
    if (!stop.signal.aborted) return video
    // Stopped as the last request came back: the file it kept isn't wanted.
    if (video.file) releaseVideo(video.file.id)
    throw new Error(STOPPED)
  } catch (err) {
    throw stop.signal.aborted ? new Error(STOPPED) : err
  } finally {
    if (id) watches.delete(id)
  }
}

async function watchPublic(raw: string, options: WebVideoOptions): Promise<WebVideo> {
  sweep()
  const want = wanted(options)
  const url = await checkUrl(String(raw))
  // A channel's "/live" address is whatever it is streaming now: its page names the video.
  const id = youtubeId(url) ?? (isYouTube(url) && /\/live\/?$/.test(url.pathname) ? canonicalYouTubeId(await fetchText(url.href, { accept: 'text/html' }).catch(() => '')) : null)
  if (id) return watchYouTube(id, want)
  if (isYouTube(url)) throw new Error('That YouTube link isn’t one video — it’s a channel, playlist or search. Pass the link of a single video.')
  return watchElsewhere(url, want)
}
