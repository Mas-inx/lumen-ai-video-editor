/**
 * The compositor (Canvas 2D + a shared WebGL stage for 3D).
 *
 * Renders one frame of the project: video tracks bottom→top, per-clip layers
 * with grade/effects, keyframed transforms, in/out animations, transitions,
 * adjustment layers and titles. Preview and export both render through here.
 */
import { FONTS } from '@/editor/defaults'
import { propAt } from '@/editor/keyframes'
import { adjacentBefore, clipEnd } from '@/editor/ops'
import { is3dEffect, is3dTransition } from '@/editor/presets'
import { sourceFrameAt, speedAt } from '@/editor/timing'
import type { AnimPreset, BlendMode, Clip, Crop, Effect, EffectKind, Project, Transition } from '@/editor/types'
import { clamp, easeInOutCubic, easeOutBack, easeOutCubic, lerp, noise1 } from '@/lib/math'
import { gradeFilter, gradeOverlays } from './color'
import { usePlayback } from '@/editor/playback'
import { grainCanvas } from './grain'
import { beginVideoFrame, endVideoFrame, getImage, sequenceFrame, sourceSize, videoFrame } from './media'
import { renderLayer3D } from './three/layer'
import { createStage, frameStage, scratchCanvas as scratchLayer, type Stage } from './three/stage'
import { renderText3D } from './three/text'
import { renderTransition3D } from './three/transitions'

/** On-screen footprint of a clip, in project pixels (center-based). */
export interface ClipBounds {
  cx: number
  cy: number
  w: number
  h: number
  rotation: number
  /** The point the clip scales and rotates around (its position), when that isn't the box center — a cropped picture. */
  px?: number
  py?: number
  /** The whole picture before cropping (same rotation), for the crop gizmo. */
  full?: { cx: number; cy: number; w: number; h: number }
}

type Rect = { x: number; y: number; w: number; h: number }

export interface RenderResult {
  bounds: Map<string, ClipBounds>
}

interface Mods {
  alpha?: number
  offsetX?: number
  scale?: number
  blur?: number
  /** 0..1 left-to-right reveal */
  wipe?: number
}

const BLEND: Record<BlendMode, GlobalCompositeOperation> = {
  normal: 'source-over',
  screen: 'screen',
  multiply: 'multiply',
  overlay: 'overlay',
  'soft-light': 'soft-light',
  lighten: 'lighten',
  darken: 'darken',
  'color-dodge': 'color-dodge',
  difference: 'difference',
}

let layerCanvas: HTMLCanvasElement | null = null
let scratchCanvas: HTMLCanvasElement | null = null

function sized(canvas: HTMLCanvasElement | null, w: number, h: number) {
  const c = canvas ?? document.createElement('canvas')
  if (c.width !== w || c.height !== h) {
    c.width = w
    c.height = h
  }
  return c
}

function resetCtx(ctx: CanvasRenderingContext2D) {
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
  ctx.filter = 'none'
  ctx.shadowColor = 'transparent'
  ctx.shadowBlur = 0
}

const fx = (clip: Clip, kind: EffectKind): Effect | undefined => clip.effects.find((e) => e.kind === kind && e.enabled)

// One WebGL stage shared by every 3D layer, title and transition.
let stage: Stage | null = null
function stage3D(W: number, H: number, project: Project) {
  stage ??= createStage()
  frameStage(stage, W, H, project.settings.width, project.settings.height)
  return stage
}

// ─── Frame ───────────────────────────────────────────────────────────────

/** Source time (seconds) a clip shows at a frame relative to its start — speed ramps, reverse and freeze frames included. */
export function clipSourceTime(clip: Clip, local: number, fps: number) {
  return sourceFrameAt(clip, local) / fps
}

/** The rate a playing video element should run at for a clip, or 0 when it must be stepped frame by frame. */
const playRate = (clip: Clip, local: number) => (clip.freeze || clip.reverse ? 0 : speedAt(clip, local))

/**
 * Every clip `renderFrame` draws at `frame`, bottom to top, including the
 * outgoing clip of a transition (drawn past its end, into its handle).
 */
export function clipsDrawnAt(project: Project, frame: number): { clip: Clip; local: number }[] {
  const out: { clip: Clip; local: number }[] = []
  const visual = project.tracks.filter((t) => t.kind === 'video' && !t.hidden)
  for (let i = visual.length - 1; i >= 0; i--) {
    const clip = Object.values(project.clips).find((c) => c.trackId === visual[i].id && frame >= c.start && frame < clipEnd(c))
    if (!clip) continue
    const local = frame - clip.start
    const tr = clip.transitionIn
    const prev = tr && local < tr.duration ? adjacentBefore(project, clip) : undefined
    if (prev) out.push({ clip: prev, local: frame - prev.start })
    out.push({ clip, local })
  }
  return out
}

export function renderFrame(ctx: CanvasRenderingContext2D, project: Project, frame: number): RenderResult {
  const W = ctx.canvas.width
  const H = ctx.canvas.height
  const bounds = new Map<string, ClipBounds>()
  beginVideoFrame()

  ctx.save()
  resetCtx(ctx)
  ctx.fillStyle = project.settings.background
  ctx.fillRect(0, 0, W, H)

  const clipsByTrack = new Map<string, Clip[]>()
  for (const c of Object.values(project.clips)) {
    const list = clipsByTrack.get(c.trackId)
    if (list) list.push(c)
    else clipsByTrack.set(c.trackId, [c])
  }

  const visual = project.tracks.filter((t) => t.kind === 'video' && !t.hidden)
  for (let i = visual.length - 1; i >= 0; i--) {
    const clip = clipsByTrack.get(visual[i].id)?.find((c) => frame >= c.start && frame < clipEnd(c))
    if (!clip) continue
    const local = frame - clip.start
    const tr = clip.transitionIn
    const prev = tr && local < tr.duration ? adjacentBefore(project, clip) : undefined
    if (tr && prev) drawTransition(ctx, project, prev, clip, frame, tr, local / tr.duration, bounds)
    else drawClip(ctx, project, clip, frame, {}, bounds)
  }

  ctx.restore()
  endVideoFrame()
  return { bounds }
}

function drawTransition(
  ctx: CanvasRenderingContext2D,
  project: Project,
  prev: Clip,
  clip: Clip,
  frame: number,
  tr: Transition,
  p: number,
  bounds: Map<string, ClipBounds>,
) {
  if (is3dTransition(tr.kind)) {
    // Composite each shot on its own, then hand both to the 3D stage.
    const W = ctx.canvas.width
    const H = ctx.canvas.height
    const a = scratchLayer('transition-a', W, H)
    drawClip(a.ctx, project, prev, frame, {}, bounds)
    const b = scratchLayer('transition-b', W, H)
    drawClip(b.ctx, project, clip, frame, {}, bounds)
    const out = renderTransition3D(stage3D(W, H, project), tr.kind, p, a.canvas, b.canvas)
    if (out) {
      ctx.save()
      resetCtx(ctx)
      ctx.drawImage(out, 0, 0, W, H)
      ctx.restore()
    }
    return
  }
  const e = easeInOutCubic(p)
  const PW = project.settings.width
  const draw = (c: Clip, m: Mods) => drawClip(ctx, project, c, frame, m, bounds)
  switch (tr.kind) {
    case 'dissolve':
      draw(prev, {})
      draw(clip, { alpha: e })
      break
    case 'dip':
      if (p < 0.5) draw(prev, { alpha: 1 - easeInOutCubic(p * 2) })
      else draw(clip, { alpha: easeInOutCubic((p - 0.5) * 2) })
      break
    case 'flash': {
      draw(p < 0.5 ? prev : clip, {})
      ctx.save()
      resetCtx(ctx)
      ctx.globalAlpha = Math.pow(1 - Math.abs(p - 0.5) * 2, 1.6)
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height)
      ctx.restore()
      break
    }
    case 'slide':
      draw(prev, {})
      draw(clip, { offsetX: (1 - e) * PW })
      break
    case 'push':
      draw(prev, { offsetX: -e * PW })
      draw(clip, { offsetX: (1 - e) * PW })
      break
    case 'zoom':
      draw(prev, { alpha: 1 - e, scale: 1 + e * 0.35 })
      draw(clip, { alpha: e, scale: 0.86 + 0.14 * easeOutCubic(p) })
      break
    case 'wipe':
      draw(prev, {})
      draw(clip, { wipe: e })
      break
    case 'blur':
      draw(prev, { blur: e * 18 })
      draw(clip, { alpha: e, blur: (1 - e) * 18 })
      break
  }
}

// ─── Animation ───────────────────────────────────────────────────────────

interface AnimState {
  alpha: number
  dx: number
  dy: number
  scale: number
  blur: number
  wipe: number
  reveal: number
  /** 3D entrance/exit rotation, degrees */
  rotX: number
  rotY: number
}

function animState(clip: Clip, local: number): AnimState {
  const s: AnimState = { alpha: 1, dx: 0, dy: 0, scale: 1, blur: 0, wipe: 1, reveal: 1, rotX: 0, rotY: 0 }
  const apply = (preset: AnimPreset, p: number, dir: 1 | -1) => {
    const e = easeOutCubic(clamp(p, 0, 1))
    switch (preset) {
      case 'fade':
        s.alpha *= e
        break
      case 'rise':
        s.alpha *= e
        s.dy += (1 - e) * 70 * dir
        break
      case 'drop':
        s.alpha *= e
        s.dy -= (1 - e) * 70 * dir
        break
      case 'pop':
        s.scale *= lerp(0.55, 1, easeOutBack(clamp(p, 0, 1)))
        s.alpha *= Math.min(1, p * 3)
        break
      case 'zoom':
        s.scale *= lerp(1.3, 1, e)
        s.alpha *= e
        break
      case 'blur':
        s.blur += (1 - e) * 26
        s.alpha *= Math.min(1, p * 1.6)
        break
      case 'wipe':
        s.wipe = Math.min(s.wipe, e)
        break
      case 'typewriter':
        s.reveal = Math.min(s.reveal, clamp(p, 0, 1))
        break
      case 'spin3d':
        s.rotY += (1 - e) * 95 * dir
        s.alpha *= Math.min(1, p * 2.5)
        break
      case 'flip3d':
        s.rotX += (1 - e) * 88 * dir
        s.alpha *= Math.min(1, p * 2.5)
        break
      case 'none':
        break
    }
  }
  const { in: aIn, out: aOut } = clip.animation
  if (aIn.preset !== 'none' && local < aIn.duration) apply(aIn.preset, local / aIn.duration, 1)
  const fromEnd = clip.duration - local
  if (aOut.preset !== 'none' && fromEnd <= aOut.duration) apply(aOut.preset, fromEnd / aOut.duration, -1)
  return s
}

// ─── Clips ───────────────────────────────────────────────────────────────

const failed3D = new Set<string>()

function drawClip(ctx: CanvasRenderingContext2D, project: Project, clip: Clip, frame: number, mods: Mods, bounds: Map<string, ClipBounds>) {
  const local = frame - clip.start
  if (clip.kind === 'adjustment') {
    drawAdjustment(ctx, clip, local, project.settings.fps, mods)
    return
  }

  const W = ctx.canvas.width
  const H = ctx.canvas.height
  const { width: PW, height: PH, fps } = project.settings
  const k = W / PW
  const t = local / fps
  const anim = animState(clip, local)

  let x = propAt(clip, 'x', local) + anim.dx + (mods.offsetX ?? 0)
  let y = propAt(clip, 'y', local) + anim.dy
  let rotation = propAt(clip, 'rotation', local)
  let scale = propAt(clip, 'scale', local) * anim.scale * (mods.scale ?? 1)
  const opacity = propAt(clip, 'opacity', local) * anim.alpha * (mods.alpha ?? 1)
  if (opacity <= 0.002 || scale <= 0.001) return

  const rotateX = propAt(clip, 'rotateX', local) + anim.rotX
  const rotateY = propAt(clip, 'rotateY', local) + anim.rotY
  const z = propAt(clip, 'z', local)
  const fx3d = clip.effects.filter((e) => e.enabled && is3dEffect(e.kind))
  const text3d = clip.kind === 'text' && Boolean(clip.text && clip.text.extrude > 0)
  if (text3d || fx3d.length || Math.abs(rotateX) > 0.01 || Math.abs(rotateY) > 0.01 || Math.abs(z) > 0.5) {
    try {
      draw3D(ctx, project, clip, local, { x, y, z, rotation, rotateX, rotateY, scale, opacity, anim, mods, fx3d, text3d }, bounds)
      return
    } catch (err) {
      // A 3D failure (bad font tables, lost GL context…) must never blank the
      // frame — fall through and draw the clip flat.
      if (!failed3D.has(clip.id)) console.warn(`3D render failed for clip ${clip.id}; drawing it flat`, err)
      failed3D.add(clip.id)
    }
  }

  const shake = fx(clip, 'shake')
  if (shake) {
    const a = shake.amount / 100
    x += noise1(t * 11, 1) * 26 * a
    y += noise1(t * 11, 2) * 18 * a
    rotation += noise1(t * 9, 3) * 1.2 * a
  }
  const pulse = fx(clip, 'pulse')
  if (pulse) {
    const beat = 60 / 100
    scale *= 1 + (pulse.amount / 100) * 0.09 * Math.exp(-((t % beat) / beat) * 6)
  }

  ctx.save()
  resetCtx(ctx)
  ctx.globalAlpha = opacity
  ctx.globalCompositeOperation = BLEND[clip.blend]
  ctx.translate((PW / 2 + x) * k, (PH / 2 + y) * k)
  ctx.rotate((rotation * Math.PI) / 180)
  ctx.scale(scale, scale)

  const wipe = Math.min(anim.wipe, mods.wipe ?? 1)

  if (clip.kind === 'text' && clip.text) {
    const box = drawText(ctx, clip, k, anim.reveal, wipe, anim.blur + (mods.blur ?? 0))
    bounds.set(clip.id, { cx: PW / 2 + x, cy: PH / 2 + y, w: (box.w / k) * scale, h: (box.h / k) * scale, rotation })
    ctx.restore()
    return
  }

  const { canvas: layer, rect, full } = renderMediaLayer(project, clip, local, W, H)
  if (wipe < 1) {
    ctx.beginPath()
    ctx.rect(-W / 2, -H / 2, W * wipe, H)
    ctx.clip()
  }
  const blur = anim.blur + (mods.blur ?? 0) + (fx(clip, 'blur')?.amount ?? 0) * 0.25
  const mono = fx(clip, 'mono')?.amount ?? 0
  ctx.filter = gradeFilter(clip.color, { mono, blur: blur * k })
  ctx.drawImage(layer, -W / 2, -H / 2, W, H)

  const glow = fx(clip, 'glow')
  if (glow) {
    ctx.globalCompositeOperation = 'screen'
    ctx.globalAlpha = opacity * (glow.amount / 100) * 0.75
    ctx.filter = `blur(${(18 * k).toFixed(1)}px) brightness(1.25)`
    ctx.drawImage(layer, -W / 2, -H / 2, W, H)
  }
  const rgb = fx(clip, 'rgb')
  if (rgb) {
    const off = (rgb.amount / 100) * 14 * k
    ctx.globalCompositeOperation = 'screen'
    ctx.globalAlpha = opacity * 0.4
    ctx.filter = 'sepia(1) saturate(8) hue-rotate(-45deg)'
    ctx.drawImage(layer, -W / 2 - off, -H / 2, W, H)
    ctx.filter = 'sepia(1) saturate(8) hue-rotate(150deg)'
    ctx.drawImage(layer, -W / 2 + off, -H / 2, W, H)
  }
  ctx.restore()

  // The box around the picture itself (not the letterbox around it), so the gizmo hugs what you see.
  const box = (r: Rect) => {
    const a = (rotation * Math.PI) / 180
    const dx = ((r.x + r.w / 2 - W / 2) / k) * scale
    const dy = ((r.y + r.h / 2 - H / 2) / k) * scale
    return { cx: PW / 2 + x + dx * Math.cos(a) - dy * Math.sin(a), cy: PH / 2 + y + dx * Math.sin(a) + dy * Math.cos(a), w: (r.w / k) * scale, h: (r.h / k) * scale }
  }
  bounds.set(clip.id, { ...box(rect), rotation, px: PW / 2 + x, py: PH / 2 + y, ...(clip.crop ? { full: box(full) } : {}) })
}

interface Placement {
  x: number
  y: number
  z: number
  rotation: number
  rotateX: number
  rotateY: number
  scale: number
  opacity: number
  anim: AnimState
  mods: Mods
  fx3d: Effect[]
  text3d: boolean
}

/** Renders a clip through the 3D stage: extruded titles, or a flat render placed in space. */
function draw3D(ctx: CanvasRenderingContext2D, project: Project, clip: Clip, local: number, p: Placement, bounds: Map<string, ClipBounds>) {
  const W = ctx.canvas.width
  const H = ctx.canvas.height
  const { width: PW, height: PH, fps } = project.settings
  const k = W / PW
  const t = local / fps
  const s3 = stage3D(W, H, project)
  const place = { x: p.x, y: p.y, z: p.z, scale: p.scale, rotation: p.rotation, rotateX: p.rotateX, rotateY: p.rotateY, opacity: p.opacity, t }
  let out: HTMLCanvasElement | null = null
  let bw = PW * p.scale
  let bh = PH * p.scale

  if (p.text3d && clip.text) {
    const r = renderText3D(s3, { style: clip.text, ...place })
    if (r) {
      out = r.canvas
      bw = r.width * p.scale
      bh = r.height * p.scale
    }
  } else {
    const flat = scratchLayer('flat-layer', W, H)
    const wipe = Math.min(p.anim.wipe, p.mods.wipe ?? 1)
    if (clip.kind === 'text' && clip.text) {
      flat.ctx.translate(W / 2, H / 2)
      const box = drawText(flat.ctx, clip, k, p.anim.reveal, wipe, p.anim.blur + (p.mods.blur ?? 0))
      bw = (box.w / k) * p.scale
      bh = (box.h / k) * p.scale
    } else {
      const layer = renderMediaLayer(project, clip, local, W, H).canvas
      if (wipe < 1) {
        flat.ctx.beginPath()
        flat.ctx.rect(0, 0, W * wipe, H)
        flat.ctx.clip()
      }
      const blur = p.anim.blur + (p.mods.blur ?? 0) + (fx(clip, 'blur')?.amount ?? 0) * 0.25
      flat.ctx.filter = gradeFilter(clip.color, { mono: fx(clip, 'mono')?.amount ?? 0, blur: blur * k })
      flat.ctx.drawImage(layer, 0, 0, W, H)
    }
    out = renderLayer3D(s3, { canvas: flat.canvas, ...place, effects: p.fx3d })
  }

  if (out) {
    ctx.save()
    resetCtx(ctx)
    ctx.globalCompositeOperation = BLEND[clip.blend]
    if (p.text3d && clip.text?.material === 'neon') {
      // Bloom for neon titles: a blurred additive copy under the sharp one.
      ctx.globalCompositeOperation = 'lighter'
      ctx.filter = `blur(${(14 * k).toFixed(1)}px)`
      ctx.drawImage(out, 0, 0, W, H)
      ctx.filter = 'none'
      ctx.globalCompositeOperation = BLEND[clip.blend]
    }
    ctx.drawImage(out, 0, 0, W, H)
    ctx.restore()
  }
  bounds.set(clip.id, { cx: PW / 2 + p.x, cy: PH / 2 + p.y, w: bw, h: bh, rotation: p.rotation })
}

/**
 * Content + grade washes + per-clip texture effects, drawn untransformed.
 * Returns the layer, the rect the visible picture covers and the rect of the whole picture before cropping.
 */
function renderMediaLayer(project: Project, clip: Clip, local: number, W: number, H: number): { canvas: HTMLCanvasElement; rect: Rect; full: Rect } {
  layerCanvas = sized(layerCanvas, W, H)
  const lctx = layerCanvas.getContext('2d')!
  resetCtx(lctx)
  lctx.clearRect(0, 0, W, H)

  const fps = project.settings.fps
  const asset = clip.assetId ? project.assets[clip.assetId] : undefined
  const t = clipSourceTime(clip, local, fps)
  let rect = { x: 0, y: 0, w: W, h: H }

  if (!asset) drawSlate(lctx, W, H, 'Media missing')
  else if (asset.source.missing) drawSlate(lctx, W, H, `Media offline — ${asset.source.type === 'file' ? asset.source.fileName : asset.name}`)
  else if (asset.source.type === 'file' && asset.kind === 'video') {
    const video = videoFrame(clip.id, asset.source.url, t, usePlayback.getState().playing, playRate(clip, local))
    if (video) rect = drawContain(lctx, video, W, H)
    else if (asset.source.poster) {
      const img = getImage(asset.source.poster)
      if (img instanceof HTMLImageElement) rect = drawContain(lctx, img, W, H)
    }
  } else if (asset.source.type === 'file') {
    const img = getImage(asset.source.url)
    if (img === 'error') drawSlate(lctx, W, H, 'Media offline')
    else if (img) rect = drawContain(lctx, img, W, H)
  } else if (asset.source.type === 'sequence') {
    const img = sequenceFrame(asset.source, t)
    if (img === 'error') drawSlate(lctx, W, H, 'Frames missing')
    else if (img) rect = drawContain(lctx, img, W, H)
  }

  const full = rect
  let shape: Path2D | null = null
  if (clip.crop) {
    rect = cropRect(full, clip.crop)
    shape = new Path2D()
    shape.roundRect(rect.x, rect.y, rect.w, rect.h, (clip.crop.radius * Math.min(rect.w, rect.h)) / 2)
    // Keep only the cropped (rounded) picture.
    lctx.globalCompositeOperation = 'destination-in'
    lctx.fill(shape)
    lctx.globalCompositeOperation = 'source-over'
  }

  const overlays = asset?.alpha ? [] : gradeOverlays(clip.color)
  const vignette = clip.color.vignette + (fx(clip, 'vignette')?.amount ?? 0)
  const grain = fx(clip, 'grain')
  const leak = fx(clip, 'leak')
  if (overlays.length || vignette || grain || leak) {
    lctx.save()
    if (shape) lctx.clip(shape)
    else {
      lctx.beginPath()
      lctx.rect(rect.x, rect.y, rect.w, rect.h)
      lctx.clip()
    }
    for (const o of overlays) {
      lctx.globalCompositeOperation = 'soft-light'
      lctx.globalAlpha = o.alpha
      lctx.fillStyle = o.color
      lctx.fillRect(0, 0, W, H)
    }
    lctx.globalCompositeOperation = 'source-over'
    lctx.globalAlpha = 1
    if (vignette) drawVignette(lctx, W, H, Math.min(100, vignette) / 100)
    if (leak) drawLeak(lctx, W, H, local / fps, leak.amount / 100)
    if (grain) drawGrain(lctx, W, H, local, grain.amount / 100)
    lctx.restore()
  }
  return { canvas: layerCanvas, rect, full }
}

/** The part of a picture rect a crop keeps. */
export function cropRect(r: Rect, crop: Crop): Rect {
  const left = Math.min(crop.left, 0.95)
  const top = Math.min(crop.top, 0.95)
  const w = Math.max(0.01, 1 - left - crop.right)
  const h = Math.max(0.01, 1 - top - crop.bottom)
  return { x: r.x + r.w * left, y: r.y + r.h * top, w: r.w * w, h: r.h * h }
}

function drawAdjustment(ctx: CanvasRenderingContext2D, clip: Clip, local: number, fps: number, mods: Mods) {
  const W = ctx.canvas.width
  const H = ctx.canvas.height
  const anim = animState(clip, local)
  const strength = propAt(clip, 'opacity', local) * anim.alpha * (mods.alpha ?? 1)
  if (strength <= 0.002) return
  scratchCanvas = sized(scratchCanvas, W, H)
  const sctx = scratchCanvas.getContext('2d')!
  resetCtx(sctx)
  sctx.clearRect(0, 0, W, H)
  sctx.drawImage(ctx.canvas, 0, 0)

  ctx.save()
  resetCtx(ctx)
  ctx.globalAlpha = strength
  const mono = fx(clip, 'mono')?.amount ?? 0
  const blur = (fx(clip, 'blur')?.amount ?? 0) * 0.25 * (W / 1920)
  ctx.filter = gradeFilter(clip.color, { mono, blur })
  ctx.drawImage(scratchCanvas, 0, 0)
  ctx.filter = 'none'
  for (const o of gradeOverlays(clip.color)) {
    ctx.globalCompositeOperation = 'soft-light'
    ctx.globalAlpha = o.alpha * strength
    ctx.fillStyle = o.color
    ctx.fillRect(0, 0, W, H)
  }
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = strength
  const vignette = clip.color.vignette + (fx(clip, 'vignette')?.amount ?? 0)
  if (vignette) drawVignette(ctx, W, H, Math.min(100, vignette) / 100)
  const leak = fx(clip, 'leak')
  if (leak) drawLeak(ctx, W, H, local / fps, leak.amount / 100)
  const grain = fx(clip, 'grain')
  if (grain) drawGrain(ctx, W, H, local, grain.amount / 100)
  ctx.restore()
}

// ─── Text ────────────────────────────────────────────────────────────────

const measureCache = new Map<string, number>()

function drawText(ctx: CanvasRenderingContext2D, clip: Clip, k: number, reveal: number, wipe: number, blur: number) {
  const st = clip.text!
  const size = st.size * k
  const content = st.uppercase ? st.content.toUpperCase() : st.content
  const lines = content.split('\n')
  ctx.font = `${st.italic ? 'italic ' : ''}${st.weight} ${size}px ${FONTS[st.font].css}`
  ctx.letterSpacing = `${(st.letterSpacing * size).toFixed(2)}px`
  ctx.textBaseline = 'middle'
  ctx.textAlign = st.align

  const widths = lines.map((line) => {
    const key = `${ctx.font}|${ctx.letterSpacing}|${line}`
    let w = measureCache.get(key)
    if (w === undefined) {
      w = ctx.measureText(line).width
      measureCache.set(key, w)
    }
    return w
  })
  const maxW = Math.max(1, ...widths)
  const lh = size * st.lineHeight
  const totalH = lh * lines.length
  const padX = st.background ? size * 0.5 : size * 0.12
  const padY = st.background ? size * 0.32 : size * 0.1
  const boxW = maxW + padX * 2
  const boxH = totalH + padY * 2
  const anchorX = st.align === 'left' ? -maxW / 2 : st.align === 'right' ? maxW / 2 : 0

  if (wipe < 1) {
    ctx.beginPath()
    ctx.rect(-boxW / 2, -boxH / 2, boxW * wipe, boxH)
    ctx.clip()
  }
  if (blur > 0.05) ctx.filter = `blur(${(blur * k).toFixed(2)}px)`

  if (st.background) {
    ctx.fillStyle = st.background
    ctx.beginPath()
    ctx.roundRect(-boxW / 2, -boxH / 2, boxW, boxH, size * 0.2)
    ctx.fill()
  }

  const total = content.replace(/\n/g, '').length
  const budget = reveal >= 1 ? Infinity : Math.floor(total * reveal)

  const paint = () => {
    let remaining = budget
    lines.forEach((line, i) => {
      if (remaining <= 0) return
      const visible = remaining === Infinity ? line : line.slice(0, remaining)
      remaining -= line.length
      const y = -totalH / 2 + lh * (i + 0.5)
      if (st.align === 'center' && visible.length < line.length) {
        // Keep typewriter text anchored where the finished line will sit.
        ctx.textAlign = 'left'
        ctx.fillText(visible, -widths[i] / 2, y)
        ctx.textAlign = 'center'
      } else ctx.fillText(visible, anchorX, y)
    })
  }

  ctx.fillStyle = st.color
  if (st.glow) {
    ctx.shadowColor = st.glow
    ctx.shadowBlur = size * 0.55
    paint()
    ctx.shadowBlur = size * 0.2
    paint()
  } else if (st.shadow > 0) {
    ctx.shadowColor = `rgba(0,0,0,${0.6 * st.shadow})`
    ctx.shadowBlur = size * 0.4 * st.shadow
    ctx.shadowOffsetY = size * 0.04 * st.shadow
    paint()
  } else paint()
  return { w: boxW, h: boxH }
}

// ─── Texture helpers ─────────────────────────────────────────────────────

function drawContain(ctx: CanvasRenderingContext2D, img: CanvasImageSource, W: number, H: number) {
  const { w: iw, h: ih } = sourceSize(img)
  if (!iw || !ih) return { x: 0, y: 0, w: W, h: H }
  const r = Math.min(W / iw, H / ih)
  const w = iw * r
  const h = ih * r
  const rect = { x: (W - w) / 2, y: (H - h) / 2, w, h }
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, rect.x, rect.y, w, h)
  return rect
}

function drawSlate(ctx: CanvasRenderingContext2D, W: number, H: number, label: string) {
  const g = ctx.createLinearGradient(0, 0, W, H)
  g.addColorStop(0, '#2a1016')
  g.addColorStop(1, '#12070a')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, W, H)
  ctx.fillStyle = 'rgba(255,110,110,0.9)'
  ctx.font = `600 ${Math.round(H * 0.045)}px "Geist Variable", sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, W / 2, H / 2)
}

function drawVignette(ctx: CanvasRenderingContext2D, W: number, H: number, amount: number) {
  const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, W * 0.72)
  g.addColorStop(0, 'rgba(0,0,0,0)')
  g.addColorStop(1, `rgba(0,0,0,${(0.85 * amount).toFixed(3)})`)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, W, H)
}

function drawGrain(ctx: CanvasRenderingContext2D, W: number, H: number, frame: number, amount: number) {
  const pattern = ctx.createPattern(grainCanvas(), 'repeat')
  if (!pattern) return
  ctx.save()
  const off = (frame * 53) % 192
  ctx.translate(-off, -((off * 3) % 192))
  ctx.globalCompositeOperation = 'overlay'
  ctx.globalAlpha = 0.28 * amount
  ctx.fillStyle = pattern
  ctx.fillRect(0, 0, W + 192, H + 192)
  ctx.restore()
}

function drawLeak(ctx: CanvasRenderingContext2D, W: number, H: number, t: number, amount: number) {
  ctx.save()
  ctx.globalCompositeOperation = 'screen'
  const x = (0.2 + 0.6 * (0.5 + 0.5 * Math.sin(t * 0.7))) * W
  const y = (0.3 + 0.2 * Math.sin(t * 0.43 + 1)) * H
  const g = ctx.createRadialGradient(x, y, 0, x, y, W * 0.55)
  g.addColorStop(0, `rgba(255,150,70,${0.55 * amount})`)
  g.addColorStop(0.45, `rgba(255,70,120,${0.25 * amount})`)
  g.addColorStop(1, 'rgba(255,70,120,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, W, H)
  ctx.restore()
}

/** Renders a frame into a fresh canvas (thumbnails, export preview, snapshots). */
export function renderToCanvas(project: Project, frame: number, width: number) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = Math.round((width * project.settings.height) / project.settings.width)
  renderFrame(canvas.getContext('2d')!, project, frame)
  return canvas
}
