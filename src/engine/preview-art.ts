/**
 * What effect, transition and look cards preview on: frames of the user's own
 * footage once the project has some, and abstract gradient artwork before that.
 */
import { useEffect, useState } from 'react'
import { useEditor } from '@/editor/store'
import type { Asset, Project } from '@/editor/types'
import { getImage, onMediaReady, sequenceFrameUrl } from './media'

export const PREVIEW_W = 480
export const PREVIEW_H = 270

/** The two frames cards preview on (A and B for transitions). */
function candidates(project: Project): string[] {
  const urls: string[] = []
  const visual = Object.values(project.assets)
    .filter((a) => a.kind !== 'audio' && !(a.source.type === 'file' && a.source.missing))
    .sort((a, b) => a.addedAt - b.addedAt)
  for (const a of visual) {
    const url = stillOf(a)
    if (url && !urls.includes(url)) urls.push(url)
    if (urls.length === 2) break
  }
  return urls
}

function stillOf(a: Asset): string | undefined {
  const src = a.source
  if (src.type === 'file') return a.kind === 'image' ? src.url : src.poster
  return src.poster ?? sequenceFrameUrl(src, Math.floor(src.frameCount / 2))
}

const canvases = new Map<string, HTMLCanvasElement>()

function drawCover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, W: number, H: number, mirror = false) {
  const r = Math.max(W / img.naturalWidth, H / img.naturalHeight)
  const w = img.naturalWidth * r
  const h = img.naturalHeight * r
  ctx.save()
  if (mirror) {
    ctx.translate(W, 0)
    ctx.scale(-1, 1)
  }
  ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h)
  ctx.restore()
}

/** Abstract artwork with a full tonal range and several hues, so grades and effects read clearly. */
function drawArt(ctx: CanvasRenderingContext2D, slot: 0 | 1, W: number, H: number) {
  const palette =
    slot === 0
      ? { from: '#0d2c3b', to: '#e0873a', glow: '#fff1c2', blob1: '#d6ee00', blob2: '#2e7fb8', floor: '#081016' }
      : { from: '#241036', to: '#2ec4c9', glow: '#e8fbff', blob1: '#ff6a8d', blob2: '#5ef2a6', floor: '#0b0914' }
  const bg = ctx.createLinearGradient(0, 0, W, H)
  bg.addColorStop(0, palette.from)
  bg.addColorStop(1, palette.to)
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, W, H)
  const blob = (x: number, y: number, r: number, color: string, alpha: number) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r)
    g.addColorStop(0, color)
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.globalAlpha = alpha
    ctx.fillStyle = g
    ctx.fillRect(0, 0, W, H)
  }
  blob(W * (slot ? 0.72 : 0.28), H * 0.3, H * 0.55, palette.glow, 0.85)
  blob(W * (slot ? 0.2 : 0.8), H * 0.7, H * 0.6, palette.blob1, 0.55)
  blob(W * 0.5, H * 0.95, H * 0.7, palette.blob2, 0.5)
  ctx.globalAlpha = 1
  const floor = ctx.createLinearGradient(0, H * 0.62, 0, H)
  floor.addColorStop(0, 'rgba(0,0,0,0)')
  floor.addColorStop(1, palette.floor)
  ctx.fillStyle = floor
  ctx.fillRect(0, 0, W, H)
}

/**
 * A preview canvas for slot 0 (A) or 1 (B). `version` changes whenever what it
 * shows changes, so callers can re-render.
 */
export function previewCanvas(project: Project, slot: 0 | 1, W = PREVIEW_W, H = PREVIEW_H): { canvas: HTMLCanvasElement; version: string } {
  const urls = candidates(project)
  const url = urls[slot] ?? urls[0]
  const img = url ? getImage(url) : null
  const ready = img instanceof HTMLImageElement
  const version = ready ? `${url}|${slot}` : `art|${slot}`
  const key = `${version}|${W}x${H}`
  let canvas = canvases.get(key)
  if (!canvas) {
    canvas = document.createElement('canvas')
    canvas.width = W
    canvas.height = H
    const ctx = canvas.getContext('2d')!
    if (ready) drawCover(ctx, img, W, H, slot === 1 && !urls[1])
    else drawArt(ctx, slot, W, H)
    canvases.set(key, canvas)
    if (canvases.size > 24) canvases.delete(canvases.keys().next().value!)
  }
  return { canvas, version: key }
}

const urlCache = new Map<string, string>()

/** Data URL of a preview slot (for <img> cards). */
export function previewUrl(project: Project, slot: 0 | 1) {
  const { canvas, version } = previewCanvas(project, slot)
  let url = urlCache.get(version)
  if (!url) {
    url = canvas.toDataURL('image/jpeg', 0.85)
    urlCache.set(version, url)
    if (urlCache.size > 24) urlCache.delete(urlCache.keys().next().value!)
  }
  return url
}

const versions = (project: Project) => `${previewCanvas(project, 0).version}#${previewCanvas(project, 1).version}`

/** Re-renders when the project's media (or a still it depends on) changes. */
export function usePreviewArt() {
  useEditor((s) => s.project.assets)
  const [, setSeen] = useState('')
  useEffect(
    () =>
      // Stills load asynchronously; only re-render when what the cards show actually changes.
      onMediaReady(() => setSeen(versions(useEditor.getState().project))),
    [],
  )
  const project = useEditor.getState().project
  const a = previewUrl(project, 0)
  const b = previewUrl(project, 1)
  return { a, b, key: versions(project) }
}
