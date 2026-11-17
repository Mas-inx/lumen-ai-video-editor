/**
 * Media the compositor draws: still images, image sequences (Blender /
 * HyperFrames renders) and video. Preview plays video through <video>
 * elements (hardware decoding, smooth playback); exports and stills draw each
 * frame with frame-exact WebCodecs reads through `withVideoFrames`, so the
 * preview keeps playing live while an export runs in the background.
 *
 * Everything here is kept within bounds: decoded pictures up to a budget (the
 * least recently drawn go first and are loaded again when they're needed), and
 * players only for clips drawn lately.
 */
import { Lru } from '@/lib/lru'

type Entry = HTMLImageElement | 'loading' | 'error'
type ImageCache = Lru<string, Entry>

const MB = 1024 * 1024
/** What a decoded picture takes, roughly: four bytes a pixel. Loading and failed ones take nothing. */
const pictureBytes = (e: Entry) => (e instanceof HTMLImageElement ? Math.max(1, e.naturalWidth * e.naturalHeight * 4) : 0)

/** Pictures that frames being exported (or made into stills) have waited for, held until they're drawn — one set per frame feeder. */
const holds = new Set<Set<string>>()
const held = (url: string) => {
  for (const h of holds) if (h.has(url)) return true
  return false
}

/** A set of pictures to keep in memory whatever else loads (fill it per frame); `release` when done. */
export function holdPictures() {
  const urls = new Set<string>()
  holds.add(urls)
  return { urls, release: () => void holds.delete(urls) }
}

/** Stills: photos, posters, overlays (a 24-megapixel photo is 96 MB decoded). */
const images: ImageCache = new Lru({ max: 256, budget: 512 * MB, size: pictureBytes, pinned: held })
const waiters = new Map<string, ((img: HTMLImageElement | null) => void)[]>()
const listeners = new Set<() => void>()

export function onMediaReady(fn: () => void) {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

/** Something the renderer draws (image, font, frame) just became available. */
export function notifyMediaReady() {
  listeners.forEach((fn) => fn())
}

function loadImage(url: string, cache: ImageCache) {
  cache.set(url, 'loading')
  const img = new Image()
  // Canvases that draw these must stay readable for export (WebCodecs refuses tainted canvases).
  if (!url.startsWith('data:') && !url.startsWith('blob:')) img.crossOrigin = 'anonymous'
  img.decoding = 'async'
  img.onload = () => {
    // Just asked for, so the most recent — counted at its real size now, which may push older pictures out.
    cache.set(url, img)
    waiters.get(url)?.forEach((fn) => fn(img))
    waiters.delete(url)
    notifyMediaReady()
  }
  img.onerror = () => {
    cache.set(url, 'error')
    waiters.get(url)?.forEach((fn) => fn(null))
    waiters.delete(url)
    notifyMediaReady()
  }
  img.src = url
}

/** Returns the decoded image, null while loading, or 'error' if it can't be read. */
export function getImage(url: string): HTMLImageElement | null | 'error' {
  const entry = images.get(url)
  if (entry === 'loading') return null
  if (entry) return entry
  loadImage(url, images)
  return null
}

/** Resolves once an image is decoded (export waits for every frame it draws). */
export function ensureImage(url: string, cache: ImageCache = images): Promise<HTMLImageElement | null> {
  const entry = cache.get(url)
  if (entry instanceof HTMLImageElement) return Promise.resolve(entry)
  if (entry === 'error') return Promise.resolve(null)
  return new Promise((resolve) => {
    const list = waiters.get(url) ?? []
    list.push(resolve)
    waiters.set(url, list)
    if (!entry) loadImage(url, cache)
  })
}

// ─── Image sequences (Blender / HyperFrames renders) ──────────────────────

interface SequenceSource {
  base: string
  pattern: string
  frameCount: number
  fps: number
}

/**
 * Frames of every sequence together, the least recently drawn going first: room
 * for the frames each one shows and prefetches (about 90 at 1080p), never more.
 */
const frameCache: ImageCache = new Lru({ max: 240, budget: 768 * MB, size: pictureBytes, pinned: held })

export function sequenceFrameUrl(src: SequenceSource, index: number) {
  const i = Math.min(src.frameCount - 1, Math.max(0, index))
  return src.base + src.pattern.replace(/%0(\d)d/, (_, n: string) => String(i + 1).padStart(Number(n), '0'))
}

function loadFrame(url: string) {
  const entry = frameCache.get(url)
  if (entry) return entry
  loadImage(url, frameCache)
  return 'loading' as const
}

export const sequenceIndex = (src: SequenceSource, t: number) => Math.floor(t * src.fps + 1e-6)

/**
 * The frame of an image sequence at source time `t` (seconds). While a frame is
 * still decoding, the nearest earlier loaded frame is shown so playback never
 * flashes; the next frames are prefetched.
 */
export function sequenceFrame(src: SequenceSource, t: number): HTMLImageElement | null | 'error' {
  const index = sequenceIndex(src, t)
  for (let k = 1; k <= 10; k++) if (index + k < src.frameCount) loadFrame(sequenceFrameUrl(src, index + k))
  const entry = loadFrame(sequenceFrameUrl(src, index))
  if (entry instanceof HTMLImageElement || entry === 'error') return entry
  for (let back = 1; back <= 12; back++) {
    // Looked at without counting as drawn, so frames left behind can still go first.
    const url = sequenceFrameUrl(src, index - back)
    if (frameCache.peek(url) instanceof HTMLImageElement) return frameCache.get(url) as HTMLImageElement
  }
  return null
}

/** Waits until the exact sequence frame for `t` is decoded. */
export function ensureSequenceFrame(src: SequenceSource, t: number) {
  return ensureImage(sequenceFrameUrl(src, sequenceIndex(src, t)), frameCache)
}

// ─── Video files ─────────────────────────────────────────────────────────
// One <video> per clip: plays natively while the timeline plays (re-synced
// on drift) and seeks exactly while scrubbing. Their sound is muted — the
// audio engine plays the mix. A player its clip hasn't drawn for a while (the
// playhead is far away, or the clip is gone) is let go, buffers and decoder
// with it; coming back makes a new one.

interface VideoEntry {
  el: HTMLVideoElement
  ready: boolean
  failed: boolean
  /** The preview frame its clip was last drawn in. */
  used: number
}

const videos = new Map<string, VideoEntry>()
const usedThisFrame = new Set<string>()
/**
 * Preview frames drawn with video in them so far: players age by these, so a long
 * pause, or a rendered preview playing instead, doesn't make every one idle.
 */
let drawn = 0

/** A player not drawn for this many of those frames (half a minute of a 30 fps timeline playing) is let go. */
const IDLE_FRAMES = 900
/** At most this many players wait unused at once: the most recently drawn are kept, for scrubbing back and forth. */
const MAX_IDLE = 8

/** Which idle players to let go: those unused for `idleFor` (frames, at `now`), and beyond the `maxIdle` most recently used. */
export function playersToRelease(idle: { key: string; used: number }[], now: number, maxIdle = MAX_IDLE, idleFor = IDLE_FRAMES): string[] {
  return [...idle]
    .sort((a, b) => b.used - a.used)
    .filter((p, i) => i >= maxIdle || now - p.used >= idleFor)
    .map((p) => p.key)
}

/** Stops a player for good and lets go of everything it holds. */
function release(v: VideoEntry) {
  v.el.pause()
  v.el.removeAttribute('src')
  v.el.load()
}

/** While an export (or still) frame is drawn, video frames come from here (frame-exact WebCodecs reads) instead of <video>. */
type ExportFrames = (key: string) => CanvasImageSource | null
let exportFrames: ExportFrames | null = null

/** A frame for an export or a still is being drawn right now (not the live preview). */
export const isExporting = () => exportFrames !== null

export function beginVideoFrame() {
  usedThisFrame.clear()
}

/** Pauses videos whose clips weren't drawn this frame, and lets go of long-idle ones (not while frames come from elsewhere). */
export function endVideoFrame() {
  if (exportFrames) return
  if (usedThisFrame.size) drawn++
  const idle: { key: string; used: number }[] = []
  for (const [key, v] of videos) {
    if (usedThisFrame.has(key)) {
      v.used = drawn
      continue
    }
    if (!v.el.paused) v.el.pause()
    idle.push({ key, used: v.used })
  }
  if (!idle.length) return
  for (const key of playersToRelease(idle, drawn)) {
    release(videos.get(key)!)
    videos.delete(key)
  }
}

/**
 * Draws with frame-exact video frames from `source` (export frames, stills for
 * the AI, snapshots) without disturbing the live preview. `draw` must be
 * synchronous, like renderFrame.
 */
export function withVideoFrames<T>(source: ExportFrames, draw: () => T): T {
  const previous = exportFrames
  exportFrames = source
  try {
    return draw()
  } finally {
    exportFrames = previous
  }
}

/** Drops the <video> elements of clips that no longer exist. */
export function pruneVideos(keep: Set<string>) {
  for (const [key, v] of videos) {
    if (keep.has(key)) continue
    release(v)
    videos.delete(key)
  }
}

/**
 * The frame of a video at source time `t`. While playing, the element runs at `rate`
 * (the clip's speed) and is only re-seeked when it drifts; a rate of 0 (reversed
 * clips, freeze frames) steps it frame by frame instead.
 */
export function videoFrame(key: string, url: string, t: number, playing: boolean, rate = 1): CanvasImageSource | null {
  if (exportFrames) return exportFrames(key)
  let entry = videos.get(key)
  if (!entry || entry.el.src !== new URL(url, location.href).href) {
    // Another file for this clip (a proxy turned on or off, relinked media): the old player goes for good.
    if (entry) release(entry)
    const el = document.createElement('video')
    el.muted = true
    el.playsInline = true
    el.preload = 'auto'
    el.crossOrigin = 'anonymous'
    const created: VideoEntry = { el, ready: false, failed: false, used: drawn }
    el.addEventListener('loadeddata', () => {
      created.ready = true
      notifyMediaReady()
    })
    el.addEventListener('error', () => {
      created.failed = true
      notifyMediaReady()
    })
    el.addEventListener('seeked', notifyMediaReady)
    el.src = url
    videos.set(key, (entry = created))
  }
  usedThisFrame.add(key)
  const { el } = entry
  if (!entry.ready || entry.failed) return null
  const target = Math.max(0, Math.min(t, (el.duration || t + 1) - 0.01))
  if (playing && rate > 0) {
    const r = Math.min(16, Math.max(0.0625, rate))
    if (Math.abs(el.playbackRate - r) > 0.005) el.playbackRate = r
    if (el.paused) void el.play().catch(() => {})
    if (Math.abs(el.currentTime - target) > 0.25 * Math.max(1, r)) el.currentTime = target
  } else if (playing) {
    if (!el.paused) el.pause()
    if (Math.abs(el.currentTime - target) > 0.02 && !el.seeking) el.currentTime = target
  } else {
    if (!el.paused) el.pause()
    if (Math.abs(el.currentTime - target) > 0.02 && !el.seeking) el.currentTime = target
  }
  return el
}

/** Natural size of anything the compositor can draw. */
export function sourceSize(src: CanvasImageSource): { w: number; h: number } {
  if (src instanceof HTMLVideoElement) return { w: src.videoWidth, h: src.videoHeight }
  if (src instanceof HTMLImageElement) return { w: src.naturalWidth, h: src.naturalHeight }
  if (typeof VideoFrame !== 'undefined' && src instanceof VideoFrame) return { w: src.displayWidth, h: src.displayHeight }
  const s = src as { width: number | SVGAnimatedLength; height: number | SVGAnimatedLength }
  return { w: typeof s.width === 'number' ? s.width : s.width.baseVal.value, h: typeof s.height === 'number' ? s.height : s.height.baseVal.value }
}

/** What each live video player is showing (diagnostics: are proxies in use?). */
export const playingSources = () => [...videos.values()].map((v) => v.el.currentSrc || v.el.src)
