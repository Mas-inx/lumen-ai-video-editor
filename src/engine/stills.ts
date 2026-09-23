/**
 * Frame-exact stills: the timeline exactly as an export draws it, or frames of a
 * media file — the AI's eyes, and anything else that needs a true frame rather
 * than whatever the live preview happens to show. Video is decoded with
 * WebCodecs; the preview is never disturbed.
 */
import type { Asset, Clip, Project } from '@/editor/types'
import { clipSourceTime, clipsDrawnAt, renderFrame } from './compositor'
import { framesAt, VideoReader } from './decode'
import { ensureImage, ensureSequenceFrame, sequenceFrame, withVideoFrames } from './media'

/** Decodes, for one frame at a time, exactly the video frames the compositor will draw. */
export class FrameFeeder {
  private readers = new Map<string, VideoReader>()
  private ready = new Map<string, CanvasImageSource | null>()
  constructor(
    private project: Project,
    private width: number,
    private height: number,
  ) {}

  async prepare(frame: number) {
    this.ready.clear()
    const { fps } = this.project.settings
    for (const { clip, local } of clipsDrawnAt(this.project, frame)) {
      const asset = clip.assetId ? this.project.assets[clip.assetId] : undefined
      if (!asset || asset.source.missing) continue
      const t = clipSourceTime(clip, local, fps)
      if (asset.source.type === 'file' && asset.kind === 'video') {
        this.ready.set(clip.id, await this.reader(clip, asset.source.url).frameAt(Math.max(0, t)))
      } else if (asset.source.type === 'file' && asset.kind === 'image') {
        await ensureImage(asset.source.url)
      } else if (asset.source.type === 'sequence') {
        await ensureSequenceFrame(asset.source, Math.max(0, t))
      }
    }
  }

  private reader(clip: Clip, url: string) {
    let r = this.readers.get(clip.id)
    if (!r) {
      r = new VideoReader(url, this.width, this.height)
      this.readers.set(clip.id, r)
    }
    return r
  }

  frame = (clipId: string) => this.ready.get(clipId) ?? null

  dispose() {
    for (const r of this.readers.values()) r.dispose()
    this.readers.clear()
  }
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)

function blank(width: number, height: number) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

/** The timeline at each of `frames`, `width` pixels wide, exactly as an export would render it. */
export async function timelineStills(project: Project, frames: number[], width: number): Promise<HTMLCanvasElement[]> {
  const w = even(width)
  const h = even((w * project.settings.height) / project.settings.width)
  const feeder = new FrameFeeder(project, w, h)
  try {
    await document.fonts.ready
    const out: HTMLCanvasElement[] = []
    for (const frame of frames) {
      await feeder.prepare(frame)
      const canvas = blank(w, h)
      withVideoFrames(feeder.frame, () => renderFrame(canvas.getContext('2d')!, project, frame))
      out.push(canvas)
    }
    return out
  } finally {
    feeder.dispose()
  }
}

/** Frames of a media file at `times` (source seconds), at most `width` wide. */
export async function mediaStills(asset: Asset, times: number[], width: number): Promise<HTMLCanvasElement[]> {
  if (asset.kind === 'audio') throw new Error(`“${asset.name}” is audio — it has no pictures.`)
  if (asset.source.missing) throw new Error(`“${asset.name}” is offline — its file can’t be found.`)
  const aspect = asset.width && asset.height ? asset.width / asset.height : 16 / 9
  // Fit `width` wide; portrait media is allowed to be taller than it is wide.
  const maxH = Math.round(width / Math.min(aspect, 1))
  const src = asset.source
  if (src.type === 'sequence') {
    const out: HTMLCanvasElement[] = []
    for (const t of times) {
      await ensureSequenceFrame(src, t)
      const img = sequenceFrame(src, t)
      out.push(drawScaled(img instanceof HTMLImageElement ? img : null, width, aspect))
    }
    return out
  }
  if (asset.kind === 'image') {
    const img = await ensureImage(src.url)
    if (!img) throw new Error(`“${asset.name}” couldn’t be decoded.`)
    const still = drawScaled(img, width, img.naturalWidth / Math.max(1, img.naturalHeight))
    return times.map(() => still)
  }
  const duration = asset.duration ?? 0
  const fps = asset.fps ?? 30
  const clamped = times.map((t) => Math.max(0, Math.min(t, Math.max(0, duration - 1 / fps))))
  const frames = await framesAt(src.url, clamped, width, maxH)
  if (frames.every((f) => !f)) throw new Error(`Couldn’t decode frames from “${asset.name}”.`)
  return frames.map((f) => f ?? blank(even(width), even(width / aspect)))
}

function drawScaled(img: HTMLImageElement | null, width: number, aspect: number) {
  const w = even(width)
  const canvas = blank(w, even(w / aspect))
  if (img) canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
  return canvas
}

// ─── Contact sheets ──────────────────────────────────────────────────────

export interface SheetCell {
  image: CanvasImageSource & { width: number; height: number }
  label: string
}

/** Columns that keep the sheet close to 16:10 with the fewest empty cells. */
export function sheetColumns(count: number, cellAspect: number) {
  let best = 1
  let bestScore = Infinity
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols)
    const score = Math.abs(Math.log((cols * cellAspect) / rows / 1.6)) + (rows * cols - count) * 0.04
    if (score < bestScore) {
      best = cols
      bestScore = score
    }
  }
  return best
}

/** Cell width that keeps the whole sheet around a megapixel — what vision models read well. */
export function sheetCellWidth(count: number, cellAspect: number, columns: number, maxWidth = 1600, pixels = 1_150_000) {
  const byArea = Math.sqrt((pixels * cellAspect) / Math.max(1, count))
  const byWidth = (maxWidth - SHEET_GAP * (columns + 1)) / columns
  return Math.max(96, Math.floor(Math.min(byArea, byWidth)))
}

const SHEET_GAP = 6

/** Lays stills out in a labelled grid: one image the AI can read at a glance. */
export function contactSheet(cells: SheetCell[]): HTMLCanvasElement {
  if (!cells.length) throw new Error('Nothing to lay out')
  const aspect = cells[0].image.width / Math.max(1, cells[0].image.height)
  const cols = sheetColumns(cells.length, aspect)
  const rows = Math.ceil(cells.length / cols)
  const cw = sheetCellWidth(cells.length, aspect, cols)
  const ch = Math.round(cw / aspect)
  const sheet = blank(SHEET_GAP + cols * (cw + SHEET_GAP), SHEET_GAP + rows * (ch + SHEET_GAP))
  const ctx = sheet.getContext('2d')!
  ctx.fillStyle = '#0b0b0a'
  ctx.fillRect(0, 0, sheet.width, sheet.height)
  const font = Math.max(11, Math.min(16, Math.round(cw / 22)))
  ctx.font = `600 ${font}px system-ui, sans-serif`
  ctx.textBaseline = 'middle'
  cells.forEach((cell, i) => {
    const x = SHEET_GAP + (i % cols) * (cw + SHEET_GAP)
    const y = SHEET_GAP + Math.floor(i / cols) * (ch + SHEET_GAP)
    ctx.drawImage(cell.image, x, y, cw, ch)
    const pad = Math.round(font * 0.45)
    const tw = ctx.measureText(cell.label).width
    ctx.fillStyle = 'rgba(0,0,0,0.72)'
    ctx.fillRect(x, y, tw + pad * 2, font + pad * 2)
    ctx.fillStyle = '#ffffff'
    ctx.fillText(cell.label, x + pad, y + pad + font / 2)
  })
  return sheet
}

/** Base64 (no data: prefix) for an MCP / model image block. */
export function canvasBase64(canvas: HTMLCanvasElement, mimeType: 'image/jpeg' | 'image/png' = 'image/jpeg', quality = 0.85) {
  const url = canvas.toDataURL(mimeType, quality)
  return url.slice(url.indexOf(',') + 1)
}
