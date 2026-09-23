/**
 * Media the compositor draws: still images, image sequences (Blender /
 * HyperFrames renders) and video. Preview plays video through <video>
 * elements (hardware decoding, smooth playback); export swaps in frame-exact
 * WebCodecs reads through `setExportFrames`.
 */

type Entry = HTMLImageElement | 'loading' | 'error'
const images = new Map<string, Entry>()
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

function loadImage(url: string, cache: Map<string, Entry>, onDone?: () => void) {
  cache.set(url, 'loading')
  const img = new Image()
  // Canvases that draw these must stay readable for export (WebCodecs refuses tainted canvases).
  if (!url.startsWith('data:') && !url.startsWith('blob:')) img.crossOrigin = 'anonymous'
  img.decoding = 'async'
  img.onload = () => {
    cache.set(url, img)
    waiters.get(url)?.forEach((fn) => fn(img))
    waiters.delete(url)
    onDone?.()
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
export function ensureImage(url: string, cache: Map<string, Entry> = images): Promise<HTMLImageElement | null> {
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

const frameCache = new Map<string, Entry>()
const FRAME_CACHE_LIMIT = 240

export function sequenceFrameUrl(src: SequenceSource, index: number) {
  const i = Math.min(src.frameCount - 1, Math.max(0, index))
  return src.base + src.pattern.replace(/%0(\d)d/, (_, n: string) => String(i + 1).padStart(Number(n), '0'))
}

function loadFrame(url: string) {
  const entry = frameCache.get(url)
  if (entry) {
    // refresh LRU position
    frameCache.delete(url)
    frameCache.set(url, entry)
    return entry
  }
  loadImage(url, frameCache)
  if (frameCache.size > FRAME_CACHE_LIMIT) {
    const oldest = frameCache.keys().next().value
    if (oldest) frameCache.delete(oldest)
  }
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
    const prev = frameCache.get(sequenceFrameUrl(src, index - back))
    if (prev instanceof HTMLImageElement) return prev
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
// audio engine plays the mix.

interface VideoEntry {
  el: HTMLVideoElement
  ready: boolean
  failed: boolean
}

const videos = new Map<string, VideoEntry>()
const usedThisFrame = new Set<string>()

/** During export, video frames come from here (frame-exact WebCodecs reads) instead of <video>. */
type ExportFrames = (clipId: string) => CanvasImageSource | null
let exportFrames: ExportFrames | null = null

export function setExportFrames(fn: ExportFrames | null) {
  exportFrames = fn
  if (fn) for (const v of videos.values()) v.el.pause()
}

export const isExporting = () => exportFrames !== null

export function beginVideoFrame() {
  usedThisFrame.clear()
}

/** Pauses videos whose clips weren't drawn this frame (not while frames come from elsewhere). */
export function endVideoFrame() {
  if (exportFrames) return
  for (const [key, v] of videos) if (!usedThisFrame.has(key) && !v.el.paused) v.el.pause()
}

/**
 * Draws with frame-exact video frames from `source` (stills for the AI, snapshots)
 * without disturbing the live preview. `draw` must be synchronous, like renderFrame.
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
    v.el.pause()
    v.el.removeAttribute('src')
    v.el.load()
    videos.delete(key)
  }
}

export function videoFrame(key: string, url: string, t: number, playing: boolean): CanvasImageSource | null {
  if (exportFrames) return exportFrames(key)
  let entry = videos.get(key)
  if (!entry || entry.el.src !== new URL(url, location.href).href) {
    entry?.el.pause()
    const el = document.createElement('video')
    el.muted = true
    el.playsInline = true
    el.preload = 'auto'
    el.crossOrigin = 'anonymous'
    const created: VideoEntry = { el, ready: false, failed: false }
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
  if (playing) {
    if (el.paused) void el.play().catch(() => {})
    if (Math.abs(el.currentTime - target) > 0.25) el.currentTime = target
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
