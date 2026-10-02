/**
 * Drawing clip bodies on the timeline: filmstrips and waveforms painted into a
 * single canvas per clip, covering only the stretch near the screen. One canvas
 * per clip (instead of a DOM tile per thumbnail and an SVG path the width of the
 * clip) keeps zooming and scrolling smooth however long and busy the timeline is.
 */
import { PEAKS_PER_SECOND } from '@/editor/defaults'
import { sourceFrameAt, type Timed } from '@/editor/timing'
import type { Asset } from '@/editor/types'
import { filmstripFrame, type Filmstrip } from '@/engine/decode'
import { sequenceFrameUrl } from '@/engine/media'

// ─── Thumbnails of stills ────────────────────────────────────────────────
// Posters, photos and image-sequence frames, decoded once at thumbnail size
// (a full-size PNG frame is megabytes; the timeline needs 90 pixels of it).

const THUMB_H = 90
const THUMB_LIMIT = 360
const thumbs = new Map<string, ImageBitmap | 'loading' | 'error'>()
const thumbListeners = new Set<(url: string) => void>()

/** Called with a still's url once its thumbnail is ready. */
export function onThumb(fn: (url: string) => void) {
  thumbListeners.add(fn)
  return () => void thumbListeners.delete(fn)
}

/** A thumbnail of a still image, or null while it loads (`onThumb` says when it's there). */
export function thumbFor(url: string): ImageBitmap | null {
  const hit = thumbs.get(url)
  if (hit instanceof ImageBitmap) {
    // Most recently used goes last.
    thumbs.delete(url)
    thumbs.set(url, hit)
    return hit
  }
  if (hit) return null
  thumbs.set(url, 'loading')
  const img = new Image()
  if (!url.startsWith('data:') && !url.startsWith('blob:')) img.crossOrigin = 'anonymous'
  img.decoding = 'async'
  img.onload = () => {
    const h = Math.min(THUMB_H * 2, img.naturalHeight || THUMB_H)
    createImageBitmap(img, { resizeHeight: h, resizeQuality: 'medium' })
      .then((bmp) => {
        thumbs.set(url, bmp)
        while (thumbs.size > THUMB_LIMIT) {
          const oldest = thumbs.keys().next().value
          if (oldest === undefined) break
          const old = thumbs.get(oldest)
          if (old instanceof ImageBitmap) old.close()
          thumbs.delete(oldest)
        }
        thumbListeners.forEach((fn) => fn(url))
      })
      .catch(() => thumbs.set(url, 'error'))
  }
  img.onerror = () => thumbs.set(url, 'error')
  img.src = url
  return null
}

/** The url of the still that stands in for a tile at source time `t` (seconds). */
function stillUrl(asset: Asset, t: number): string | undefined {
  const src = asset.source
  if (src.type === 'file') return asset.kind === 'image' ? src.url : src.poster
  // Image sequences: the frame nearest to every half second, so zooming doesn't load every frame.
  if (src.type === 'sequence') return sequenceFrameUrl(src, Math.floor((Math.round(t * 2) / 2) * src.fps))
  return undefined
}

// ─── Painting ────────────────────────────────────────────────────────────

export const dprOf = () => Math.min(2, window.devicePixelRatio || 1)

const colors = new Map<string, string>()
let probe: HTMLElement | null = null

/**
 * A CSS colour (theme variables, color-mix…) as a value canvas understands.
 * Resolved once per distinct colour: asking for computed styles while painting
 * forces the browser to recalculate styles for the whole timeline each time.
 */
export function cssColor(css: string) {
  let hit = colors.get(css)
  if (hit) return hit
  probe ??= Object.assign(document.createElement('span'), { hidden: true })
  if (!probe.isConnected) document.body.append(probe)
  probe.style.color = css
  hit = getComputedStyle(probe).color
  colors.set(css, hit)
  return hit
}

/** Canvas widths grow and shrink in steps this big (device pixels), so zooming reuses them instead of reallocating every frame. */
const WIDTH_STEP = 512

/**
 * Sizes a canvas for at least `w` × `h` CSS pixels and returns a context drawing
 * in clip-local CSS pixels starting at `x0`. The canvas may be a little wider than
 * asked (the clip clips it); it's only reallocated when the size moves past a step.
 * `soft` canvases rasterize on the CPU: much faster for thousands of tiny shapes (waveforms).
 */
export function prepare(canvas: HTMLCanvasElement, x0: number, w: number, h: number, soft = false) {
  const dpr = dprOf()
  const need = Math.max(1, Math.ceil(w * dpr))
  const pw = canvas.width >= need && canvas.width - need < WIDTH_STEP * 2 ? canvas.width : Math.ceil(need / WIDTH_STEP) * WIDTH_STEP
  const ph = Math.max(1, Math.round(h * dpr))
  if (canvas.width !== pw) canvas.width = pw
  if (canvas.height !== ph) canvas.height = ph
  canvas.style.width = `${pw / dpr}px`
  canvas.style.height = `${h}px`
  const ctx = canvas.getContext('2d', soft ? { willReadFrequently: true } : undefined)!
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, pw, ph)
  ctx.setTransform(dpr, 0, 0, dpr, -x0 * dpr, 0)
  return ctx
}

function drawCover(ctx: CanvasRenderingContext2D, src: CanvasImageSource & { width: number; height: number }, x: number, y: number, w: number, h: number) {
  const r = Math.max(w / src.width, h / src.height)
  const sw = w / r
  const sh = h / r
  ctx.drawImage(src, (src.width - sw) / 2, (src.height - sh) / 2, sw, sh, x, y, w, h)
}

export interface FilmParams {
  asset: Asset
  timing: Timed
  fps: number
  pps: number
  /** Clip-local pixels to draw: [x0, x1). */
  x0: number
  x1: number
  height: number
  strip: Filmstrip | null
}

/** Thumbnails across [x0, x1) of a clip, one tile per ~1.6 lane heights. */
export function paintFilm(canvas: HTMLCanvasElement, p: FilmParams) {
  const ctx = prepare(canvas, p.x0, p.x1 - p.x0, p.height, true)
  const tileW = Math.max(36, Math.round(p.height * 1.6))
  const first = Math.floor(p.x0 / tileW)
  const last = Math.ceil(p.x1 / tileW)
  ctx.imageSmoothingQuality = 'medium'
  for (let i = first; i < last; i++) {
    const x = i * tileW
    const mid = Math.min(p.timing.duration, ((x + tileW / 2) / p.pps) * p.fps)
    const t = Math.max(0, sourceFrameAt(p.timing, mid) / p.fps)
    const frame = p.strip ? filmstripFrame(p.strip, t) : null
    const url = frame ? undefined : stillUrl(p.asset, t)
    const src = frame ?? (url ? thumbFor(url) : null)
    if (src) drawCover(ctx, src, x, 0, tileW, p.height)
    ctx.fillStyle = 'rgba(0,0,0,0.35)'
    ctx.fillRect(x + tileW - 1, 0, 1, p.height)
  }
}

// ─── Waveforms ───────────────────────────────────────────────────────────

/** Max-pyramids of peak lists: level k holds the max of every 2^k peaks, so any range's max takes O(log n). */
const pyramids = new WeakMap<Float32Array, Float32Array[]>()

function pyramid(peaks: Float32Array) {
  let levels = pyramids.get(peaks)
  if (levels) return levels
  levels = [peaks]
  let cur = peaks
  while (cur.length > 1) {
    const next = new Float32Array(Math.ceil(cur.length / 2))
    for (let i = 0; i < next.length; i++) next[i] = Math.max(cur[2 * i], cur[2 * i + 1] ?? 0)
    levels.push(next)
    cur = next
  }
  pyramids.set(peaks, levels)
  return levels
}

/** The loudest peak in [a, b) (peak indices). */
function rangeMax(levels: Float32Array[], a: number, b: number) {
  const n = levels[0].length
  a = Math.max(0, a)
  b = Math.min(n, b)
  let m = 0
  while (a < b) {
    let k = 0
    while (k + 1 < levels.length && a % (1 << (k + 1)) === 0 && a + (1 << (k + 1)) <= b) k++
    m = Math.max(m, levels[k][a >> k])
    a += 1 << k
  }
  return m
}

export interface WaveParams {
  peaks: Float32Array
  timing: Timed
  fps: number
  pps: number
  x0: number
  x1: number
  height: number
  gain: number
  fadeIn: number
  fadeOut: number
  color: string
  /** The music's beats: clip-local frames, downbeats drawn stronger. */
  beats?: { frame: number; down: boolean }[]
}

/** The waveform across [x0, x1) of a clip, one bar per device pixel column (rasterized on the CPU, where thousands of bars are cheap). */
export function paintWave(canvas: HTMLCanvasElement, p: WaveParams) {
  const ctx = prepare(canvas, p.x0, p.x1 - p.x0, p.height, true)
  const levels = pyramid(p.peaks)
  const dpr = dprOf()
  const step = 1 / dpr
  const mid = p.height / 2
  const half = p.height * 0.47
  const { duration } = p.timing
  const peakAt = (local: number) => (sourceFrameAt(p.timing, local) / p.fps) * PEAKS_PER_SECOND
  ctx.fillStyle = p.color
  for (let x = Math.floor(p.x0 * dpr) / dpr; x < p.x1; x += step) {
    const l0 = Math.min(duration, (x / p.pps) * p.fps)
    const l1 = Math.min(duration, ((x + step) / p.pps) * p.fps)
    const a = peakAt(l0)
    const b = peakAt(l1)
    const lo = Math.floor(Math.min(a, b))
    const hi = Math.max(lo + 1, Math.ceil(Math.max(a, b)))
    let env = 1
    if (p.fadeIn > 0 && l0 < p.fadeIn) env *= l0 / p.fadeIn
    if (p.fadeOut > 0 && duration - l0 < p.fadeOut) env *= (duration - l0) / p.fadeOut
    const amp = Math.min(1, Math.max(0.015, rangeMax(levels, lo, hi) * p.gain * env))
    ctx.fillRect(x, mid - amp * half, step, amp * half * 2)
  }
  if (p.beats?.length) {
    // The beat grid. Beats land on the loudest hits, so a plain line disappears
    // into the waveform: bars get a two-tone hairline (light beside dark reads on
    // any background), and every beat a ringed dot along the bottom edge.
    // Packed tight (zoomed out), only the bars keep their dots.
    const spacing = p.beats.length > 1 ? ((p.beats[1].frame - p.beats[0].frame) / p.fps) * p.pps : Infinity
    const y = p.height - 3.5
    for (const b of p.beats) {
      const x = Math.round(((b.frame / p.fps) * p.pps) * dpr) / dpr
      if (x < p.x0 - 4 || x > p.x1 + 4) continue
      if (b.down) {
        ctx.fillStyle = 'rgba(255,255,255,0.6)'
        ctx.fillRect(x, 0, 1, p.height)
        ctx.fillStyle = 'rgba(0,0,0,0.35)'
        ctx.fillRect(x + 1, 0, 1, p.height)
      } else if (spacing < 7) continue
      const r = b.down ? 2.5 : 1.75
      ctx.beginPath()
      ctx.arc(x + 0.5, y, r + 1, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(0,0,0,0.6)'
      ctx.fill()
      ctx.beginPath()
      ctx.arc(x + 0.5, y, r, 0, Math.PI * 2)
      ctx.fillStyle = b.down ? '#ffffff' : 'rgba(255,255,255,0.85)'
      ctx.fill()
    }
  }
}
