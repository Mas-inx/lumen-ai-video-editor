/**
 * The compositor (Canvas 2D + a shared WebGL stage for 3D).
 *
 * Renders one frame of the project: video tracks bottom→top, per-clip layers
 * with grade/effects, keyframed transforms, in/out animations, transitions,
 * adjustment layers and titles. Preview and export both render through here.
 */
import { propAt } from '@/editor/keyframes'
import { followOffset, stabilizeAt, type Correction } from '@/editor/motion'
import { adjacentBefore, clipEnd } from '@/editor/ops'
import { is3dEffect, is3dTransition } from '@/editor/presets'
import { angleTrackOf, angleTracks, sequenceView } from '@/editor/sequences'
import { sourceFrameAt, speedAt } from '@/editor/timing'
import type { AnimPreset, BlendMode, Clip, Crop, Effect, EffectKind, Mask, Project, Track, Transition } from '@/editor/types'
import { clamp, easeInOutCubic, easeOutBack, easeOutCubic, lerp, noise1 } from '@/lib/math'
import { gradeFilter, gradeOverlays } from './color'
import { fontCss, fontFileUrl } from './fonts'
import { gpuGrade, needsGpuGrade } from './gl-grade'
import { usePlayback } from '@/editor/playback'
import { useUI } from '@/editor/ui-store'
import { grainCanvas } from './grain'
import { applyMatte } from './matte-gl'
import { beginVideoFrame, endVideoFrame, getImage, isExporting, sequenceFrame, sourceSize, videoFrame } from './media'
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
  /** Where the clip's full-frame layer sits (its center, scale and rotation), for editing masks. */
  layer?: { cx: number; cy: number; scale: number; rotation: number }
}

type Rect = { x: number; y: number; w: number; h: number }

export interface RenderResult {
  bounds: Map<string, ClipBounds>
}

export interface RenderOptions {
  /** Leave what nothing covers transparent instead of filling the background colour (alpha exports). */
  transparent?: boolean
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

function sized(canvas: HTMLCanvasElement | null, w: number, h: number) {
  const c = canvas ?? document.createElement('canvas')
  if (c.width !== w || c.height !== h) {
    c.width = w
    c.height = h
  }
  return c
}

// ─── Nesting ─────────────────────────────────────────────────────────────
// A nested timeline renders into a canvas of its own, one level down. Scratch
// canvases are per level, so drawing a nested clip never disturbs the level
// above; players and decoders of clips inside go by the path of nested clips
// leading to them, so a timeline nested twice plays twice.

const MAX_DEPTH = 8
let depth = 0
let keyPrefix = ''
const scratchCanvases = new Map<string, HTMLCanvasElement>()

function scratch(name: string, w: number, h: number) {
  const key = `${name}@${depth}`
  const c = sized(scratchCanvases.get(key) ?? null, w, h)
  scratchCanvases.set(key, c)
  return c
}

/** The key a clip's player and frame decoder go by. */
export const renderKey = (clip: Pick<Clip, 'id'>, prefix = '') => prefix + clip.id

/**
 * The multicam angle viewer: while the preview draws a multicam clip, it can
 * draw each camera angle too (same players, so they all keep playing).
 */
export type AngleSink = (clip: Clip, angles: Track[], draw: (trackId: string, ctx: CanvasRenderingContext2D) => void) => void
let angleSink: AngleSink | null = null
export function setAngleSink(sink: AngleSink | null) {
  angleSink = sink
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

export function renderFrame(ctx: CanvasRenderingContext2D, project: Project, frame: number, opts: RenderOptions = {}): RenderResult {
  const W = ctx.canvas.width
  const H = ctx.canvas.height
  const bounds = new Map<string, ClipBounds>()
  beginVideoFrame()

  ctx.save()
  resetCtx(ctx)
  if (opts.transparent) ctx.clearRect(0, 0, W, H)
  else {
    ctx.fillStyle = project.settings.background
    ctx.fillRect(0, 0, W, H)
  }
  drawTracks(ctx, project, frame, bounds)
  ctx.restore()
  endVideoFrame()
  return { bounds }
}

const byTrackCache = new WeakMap<Record<string, Clip>, Map<string, Clip[]>>()
function clipsByTrack(project: Project) {
  let map = byTrackCache.get(project.clips)
  if (!map) {
    map = new Map()
    for (const c of Object.values(project.clips)) {
      const list = map.get(c.trackId)
      if (list) list.push(c)
      else map.set(c.trackId, [c])
    }
    byTrackCache.set(project.clips, map)
  }
  return map
}

/** A timeline's video tracks, bottom to top — or only one of them (a multicam angle). */
function drawTracks(ctx: CanvasRenderingContext2D, project: Project, frame: number, bounds: Map<string, ClipBounds>, only?: string) {
  const byTrack = clipsByTrack(project)
  const visual = project.tracks.filter((t) => t.kind === 'video' && (only ? t.id === only : !t.hidden))
  for (let i = visual.length - 1; i >= 0; i--) {
    const clip = byTrack.get(visual[i].id)?.find((c) => frame >= c.start && frame < clipEnd(c))
    if (!clip) continue
    const local = frame - clip.start
    const tr = clip.transitionIn
    const prev = tr && local < tr.duration ? adjacentBefore(project, clip) : undefined
    if (tr && prev) drawTransition(ctx, project, prev, clip, frame, tr, local / tr.duration, bounds)
    else drawClip(ctx, project, clip, frame, {}, bounds)
  }
}

/**
 * A nested clip's picture: its timeline at the frame it shows, drawn one level
 * down at the size it will cover (so nothing is scaled twice). Null when its
 * timeline is missing.
 */
function nestedPicture(project: Project, clip: Clip, local: number, W: number, H: number): HTMLCanvasElement | null {
  const view = clip.sequenceId ? sequenceView(project, clip.sequenceId) : null
  if (!view || view === project || depth >= MAX_DEPTH) return null
  const { width: NW, height: NH, fps: NF } = view.settings
  const r = Math.min(W / NW, H / NH)
  const w = Math.max(2, Math.round(NW * r))
  const h = Math.max(2, Math.round(NH * r))
  const frame = clipSourceTime(clip, local, project.settings.fps) * NF
  const multicam = Boolean(view.sequence?.multicam)
  const angle = multicam ? angleTrackOf(view, clip) : undefined
  const prefix = keyPrefix
  depth++
  keyPrefix = `${prefix}${clip.id}>`
  try {
    const canvas = scratch('nested', w, h)
    const nctx = canvas.getContext('2d')!
    resetCtx(nctx)
    nctx.clearRect(0, 0, w, h)
    drawTracks(nctx, view, frame, new Map(), angle)
    if (multicam && depth === 1 && angleSink && !isExporting()) {
      angleSink(clip, angleTracks(view), (trackId, actx) => {
        resetCtx(actx)
        actx.clearRect(0, 0, actx.canvas.width, actx.canvas.height)
        drawTracks(actx, view, frame, new Map(), trackId)
      })
    }
    return canvas
  } finally {
    depth--
    keyPrefix = prefix
  }
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
    const a = scratchLayer(`transition-a@${depth}`, W, H)
    drawClip(a.ctx, project, prev, frame, {}, bounds)
    const b = scratchLayer(`transition-b@${depth}`, W, H)
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
    drawAdjustment(ctx, project, clip, local, project.settings.fps, mods)
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
  if (clip.follow) {
    // Tracked motion: the clip moves with the point it follows.
    const [fx0, fy0] = followOffset(clip.follow, local)
    x += fx0
    y += fy0
  }
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
    const box = drawText(ctx, project, clip, k, anim.reveal, wipe, anim.blur + (mods.blur ?? 0))
    bounds.set(clip.id, { cx: PW / 2 + x, cy: PH / 2 + y, w: (box.w / k) * scale, h: (box.h / k) * scale, rotation })
    ctx.restore()
    return
  }

  const { canvas: layer, rect, full, graded } = renderMediaLayer(project, clip, local, W, H)
  if (wipe < 1) {
    ctx.beginPath()
    ctx.rect(-W / 2, -H / 2, W * wipe, H)
    ctx.clip()
  }
  const blur = anim.blur + (mods.blur ?? 0) + (fx(clip, 'blur')?.amount ?? 0) * 0.25
  const mono = fx(clip, 'mono')?.amount ?? 0
  ctx.filter = graded ? blurFilter(blur * k) : gradeFilter(clip.color, { mono, blur: blur * k })
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
  bounds.set(clip.id, { ...box(rect), rotation, px: PW / 2 + x, py: PH / 2 + y, layer: { cx: PW / 2 + x, cy: PH / 2 + y, scale, rotation }, ...(clip.crop ? { full: box(full) } : {}) })
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
  // Taken when needed: drawing a nested timeline's layer can use (and reframe) the stage.
  const s3 = () => stage3D(W, H, project)
  const place = { x: p.x, y: p.y, z: p.z, scale: p.scale, rotation: p.rotation, rotateX: p.rotateX, rotateY: p.rotateY, opacity: p.opacity, t }
  let out: HTMLCanvasElement | null = null
  let bw = PW * p.scale
  let bh = PH * p.scale

  if (p.text3d && clip.text) {
    const r = renderText3D(s3(), { style: clip.text, fontUrl: fontFileUrl(project, clip.text.font), ...place })
    if (r) {
      out = r.canvas
      bw = r.width * p.scale
      bh = r.height * p.scale
    }
  } else {
    const flat = scratchLayer(`flat-layer@${depth}`, W, H)
    const wipe = Math.min(p.anim.wipe, p.mods.wipe ?? 1)
    if (clip.kind === 'text' && clip.text) {
      flat.ctx.translate(W / 2, H / 2)
      const box = drawText(flat.ctx, project, clip, k, p.anim.reveal, wipe, p.anim.blur + (p.mods.blur ?? 0))
      bw = (box.w / k) * p.scale
      bh = (box.h / k) * p.scale
    } else {
      const { canvas: layer, graded } = renderMediaLayer(project, clip, local, W, H)
      if (wipe < 1) {
        flat.ctx.beginPath()
        flat.ctx.rect(0, 0, W * wipe, H)
        flat.ctx.clip()
      }
      const blur = p.anim.blur + (p.mods.blur ?? 0) + (fx(clip, 'blur')?.amount ?? 0) * 0.25
      flat.ctx.filter = graded ? blurFilter(blur * k) : gradeFilter(clip.color, { mono: fx(clip, 'mono')?.amount ?? 0, blur: blur * k })
      flat.ctx.drawImage(layer, 0, 0, W, H)
    }
    out = renderLayer3D(s3(), { canvas: flat.canvas, ...place, effects: p.fx3d })
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
function renderMediaLayer(project: Project, clip: Clip, local: number, W: number, H: number): { canvas: HTMLCanvasElement; rect: Rect; full: Rect; graded: boolean } {
  // A nested timeline is drawn first, one level down, before this level's layer is touched.
  const nested = clip.sequenceId ? nestedPicture(project, clip, local, W, H) : null
  const layerCanvas = scratch('layer', W, H)
  const lctx = layerCanvas.getContext('2d')!
  resetCtx(lctx)
  lctx.clearRect(0, 0, W, H)

  const fps = project.settings.fps
  const asset = clip.assetId ? project.assets[clip.assetId] : undefined
  const t = clipSourceTime(clip, local, fps)
  const stab = clip.stabilize ? stabilizeAt(clip.stabilize, t) : undefined
  let rect = { x: 0, y: 0, w: W, h: H }

  if (clip.sequenceId) {
    if (nested) rect = drawContain(lctx, nested, W, H, stab)
    else if (!project.sequences?.[clip.sequenceId]) drawSlate(lctx, W, H, 'Timeline missing')
  } else if (!asset) drawSlate(lctx, W, H, 'Media missing')
  else if (asset.source.missing) drawSlate(lctx, W, H, `Media offline — ${asset.source.type === 'file' ? asset.source.fileName : asset.name}`)
  else if (asset.source.type === 'file' && asset.kind === 'video') {
    // The preview plays a proxy when there is one; exports read the original (see media.ts).
    const url = asset.proxy && useUI.getState().useProxies ? asset.proxy.url : asset.source.url
    const video = videoFrame(renderKey(clip, keyPrefix), url, t, usePlayback.getState().playing, playRate(clip, local))
    if (video) rect = drawContain(lctx, video, W, H, stab)
    else if (asset.source.poster) {
      const img = getImage(asset.source.poster)
      if (img instanceof HTMLImageElement) rect = drawContain(lctx, img, W, H, stab)
    }
  } else if (asset.source.type === 'file') {
    const img = getImage(asset.source.url)
    if (img === 'error') drawSlate(lctx, W, H, 'Media offline')
    else if (img) rect = drawContain(lctx, img, W, H, stab)
  } else if (asset.source.type === 'sequence') {
    const img = sequenceFrame(asset.source, t)
    if (img === 'error') drawSlate(lctx, W, H, 'Frames missing')
    else if (img) rect = drawContain(lctx, img, W, H, stab)
  }

  if (clip.matte) applySubjectMatte(lctx, project, clip, local, W, H, t, stab)

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

  if (clip.masks?.length) applyMasks(lctx, clip.masks, W, H, local)

  // Pictures with see-through parts (titles with alpha, nested timelines with gaps) get no colour washes over them.
  const seeThrough = Boolean(asset?.alpha || clip.sequenceId)
  // Curves, wheels, HSL, LUTs, keys and sharpening run on the GPU.
  let graded = false
  if (needsGpuGrade(clip)) {
    const out = gpuGrade(layerCanvas, { color: clip.color, effects: clip.effects, mono: fx(clip, 'mono')?.amount ?? 0, washes: !seeThrough }, project)
    if (out) {
      lctx.clearRect(0, 0, W, H)
      lctx.drawImage(out, 0, 0)
      graded = true
    }
  }

  const overlays = seeThrough || graded ? [] : gradeOverlays(clip.color)
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
    // Only on the picture itself: keyed-out and masked-off areas stay clear.
    lctx.globalCompositeOperation = 'source-atop'
    lctx.globalAlpha = 1
    if (vignette) drawVignette(lctx, W, H, Math.min(100, vignette) / 100)
    if (leak) drawLeak(lctx, W, H, local / fps, leak.amount / 100)
    if (grain) drawGrain(lctx, W, H, local, grain.amount / 100)
    lctx.restore()
  }
  return { canvas: layerCanvas, rect, full, graded }
}

/** Players and decoders of a clip's subject matte go by the clip's key plus this. */
const MATTE_KEY = '#matte'

/**
 * Cuts a layer down to the clip's subject (or, inverted, everything but it):
 * the matte frame is drawn exactly like the picture — same fit, same
 * stabilization — and its brightness becomes the layer's alpha.
 */
function applySubjectMatte(lctx: CanvasRenderingContext2D, project: Project, clip: Clip, local: number, W: number, H: number, t: number, stab?: Correction) {
  const m = clip.matte!
  const asset = project.assets[m.assetId]
  let frame: CanvasImageSource | null = null
  if (asset && asset.source.type === 'file' && !asset.source.missing) {
    if (asset.kind === 'image') {
      const img = getImage(asset.source.url)
      if (img instanceof HTMLImageElement) frame = img
    } else frame = videoFrame(renderKey(clip, keyPrefix) + MATTE_KEY, asset.source.url, Math.max(0, t - m.from), usePlayback.getState().playing, playRate(clip, local))
  }
  if (!frame) {
    // The matte is still loading: show nothing of a cut-out rather than the whole picture over what's behind it.
    if (!m.invert) lctx.clearRect(0, 0, W, H)
    return
  }
  const mc = scratch('matte', W, H)
  const mctx = mc.getContext('2d')!
  resetCtx(mctx)
  mctx.fillStyle = '#000'
  mctx.fillRect(0, 0, W, H)
  drawContain(mctx, frame, W, H, stab)
  if (!applyMatte(lctx.canvas, mc, m.invert)) {
    // No WebGL: a hard-edged cut from the matte's brightness, on the CPU.
    const layer = lctx.getImageData(0, 0, W, H)
    const matte = mctx.getImageData(0, 0, W, H).data
    for (let i = 0; i < layer.data.length; i += 4) {
      const k = (m.invert ? 255 - matte[i] : matte[i]) / 255
      layer.data[i + 3] = Math.round(layer.data[i + 3] * k)
    }
    lctx.putImageData(layer, 0, 0)
  }
}

/**
 * Cuts a layer down to its masks: shapes add up, inverted ones cut holes (with
 * only inverted masks, the rest of the frame shows), edges feathered by a blur.
 * Masks following a tracked point move with it.
 */
function applyMasks(ctx: CanvasRenderingContext2D, masks: Mask[], W: number, H: number, local: number) {
  const maskCanvas = scratch('mask', W, H)
  const m = maskCanvas.getContext('2d')!
  resetCtx(m)
  m.clearRect(0, 0, W, H)
  m.fillStyle = '#fff'
  if (masks.every((x) => x.invert)) m.fillRect(0, 0, W, H)
  const short = Math.min(W, H)
  for (const mask of [...masks.filter((x) => !x.invert), ...masks.filter((x) => x.invert)]) {
    m.save()
    m.globalCompositeOperation = mask.invert ? 'destination-out' : 'source-over'
    m.globalAlpha = mask.opacity
    m.filter = mask.feather > 0 ? `blur(${(mask.feather * short * 0.5).toFixed(1)}px)` : 'none'
    const [ox, oy] = mask.follow ? followOffset(mask.follow, local) : [0, 0]
    m.translate((mask.x + ox) * W, (mask.y + oy) * H)
    m.rotate((mask.rotation * Math.PI) / 180)
    const w = mask.width * W
    const h = mask.height * H
    m.beginPath()
    if (mask.shape === 'ellipse') m.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2)
    else m.roundRect(-w / 2, -h / 2, w, h, (mask.roundness * Math.min(w, h)) / 2)
    m.fill()
    m.restore()
  }
  ctx.save()
  resetCtx(ctx)
  ctx.globalCompositeOperation = 'destination-in'
  ctx.drawImage(maskCanvas, 0, 0)
  ctx.restore()
}

/** The part of a picture rect a crop keeps. */
export function cropRect(r: Rect, crop: Crop): Rect {
  const left = Math.min(crop.left, 0.95)
  const top = Math.min(crop.top, 0.95)
  const w = Math.max(0.01, 1 - left - crop.right)
  const h = Math.max(0.01, 1 - top - crop.bottom)
  return { x: r.x + r.w * left, y: r.y + r.h * top, w: r.w * w, h: r.h * h }
}

/**
 * An adjustment layer grades everything beneath it: the frame so far is copied,
 * graded (on the GPU for curves, wheels, HSL and LUTs), cut to the layer's masks
 * and laid back over the original at the layer's strength.
 */
function drawAdjustment(ctx: CanvasRenderingContext2D, project: Project, clip: Clip, local: number, fps: number, mods: Mods) {
  const W = ctx.canvas.width
  const H = ctx.canvas.height
  const anim = animState(clip, local)
  const strength = propAt(clip, 'opacity', local) * anim.alpha * (mods.alpha ?? 1)
  if (strength <= 0.002) return
  const scratchCanvas = scratch('below', W, H)
  const sctx = scratchCanvas.getContext('2d')!
  resetCtx(sctx)
  sctx.clearRect(0, 0, W, H)
  sctx.drawImage(ctx.canvas, 0, 0)

  const adjustCanvas = scratch('adjust', W, H)
  const actx = adjustCanvas.getContext('2d')!
  resetCtx(actx)
  actx.clearRect(0, 0, W, H)
  const mono = fx(clip, 'mono')?.amount ?? 0
  const blur = (fx(clip, 'blur')?.amount ?? 0) * 0.25 * (W / 1920)
  const gpu = needsGpuGrade(clip) ? gpuGrade(scratchCanvas, { color: clip.color, effects: clip.effects, mono, washes: true }, project) : null
  if (gpu) {
    actx.filter = blurFilter(blur)
    actx.drawImage(gpu, 0, 0)
    actx.filter = 'none'
  } else {
    actx.filter = gradeFilter(clip.color, { mono, blur })
    actx.drawImage(scratchCanvas, 0, 0)
    actx.filter = 'none'
    for (const o of gradeOverlays(clip.color)) {
      actx.globalCompositeOperation = 'soft-light'
      actx.globalAlpha = o.alpha
      actx.fillStyle = o.color
      actx.fillRect(0, 0, W, H)
    }
  }
  actx.globalCompositeOperation = 'source-over'
  actx.globalAlpha = 1
  const vignette = clip.color.vignette + (fx(clip, 'vignette')?.amount ?? 0)
  if (vignette) drawVignette(actx, W, H, Math.min(100, vignette) / 100)
  const leak = fx(clip, 'leak')
  if (leak) drawLeak(actx, W, H, local / fps, leak.amount / 100)
  const grain = fx(clip, 'grain')
  if (grain) drawGrain(actx, W, H, local, grain.amount / 100)
  if (clip.masks?.length) applyMasks(actx, clip.masks, W, H, local)

  ctx.save()
  resetCtx(ctx)
  ctx.globalAlpha = strength
  ctx.drawImage(adjustCanvas, 0, 0)
  ctx.restore()
}

const blurFilter = (px: number) => (px > 0.05 ? `blur(${px.toFixed(2)}px)` : 'none')

// ─── Text ────────────────────────────────────────────────────────────────

const measureCache = new Map<string, number>()

function drawText(ctx: CanvasRenderingContext2D, project: Project, clip: Clip, k: number, reveal: number, wipe: number, blur: number) {
  const st = clip.text!
  const size = st.size * k
  const content = st.uppercase ? st.content.toUpperCase() : st.content
  const lines = content.split('\n')
  ctx.font = `${st.italic ? 'italic ' : ''}${st.weight} ${size}px ${fontCss(st.font, project)}`
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

  const outline = st.outline && st.outline.width > 0 ? st.outline : null
  const paint = () => {
    let remaining = budget
    // An outline is stroked under the fill, so it grows outward and never thins the letters.
    const draw = (text: string, x: number, y: number) => {
      if (outline) {
        ctx.save()
        ctx.lineJoin = 'round'
        ctx.miterLimit = 2
        ctx.lineWidth = outline.width * size * 2
        ctx.strokeStyle = outline.color
        ctx.strokeText(text, x, y)
        ctx.restore()
      }
      ctx.fillText(text, x, y)
    }
    lines.forEach((line, i) => {
      if (remaining <= 0) return
      const visible = remaining === Infinity ? line : line.slice(0, remaining)
      remaining -= line.length
      const y = -totalH / 2 + lh * (i + 0.5)
      if (st.align === 'center' && visible.length < line.length) {
        // Keep typewriter text anchored where the finished line will sit.
        ctx.textAlign = 'left'
        draw(visible, -widths[i] / 2, y)
        ctx.textAlign = 'center'
      } else draw(visible, anchorX, y)
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

/** Fits a picture in the frame; a stabilized clip's picture is shifted, turned and zoomed inside its own box. */
function drawContain(ctx: CanvasRenderingContext2D, img: CanvasImageSource, W: number, H: number, stab?: Correction) {
  const { w: iw, h: ih } = sourceSize(img)
  if (!iw || !ih) return { x: 0, y: 0, w: W, h: H }
  const r = Math.min(W / iw, H / ih)
  const w = iw * r
  const h = ih * r
  const rect = { x: (W - w) / 2, y: (H - h) / 2, w, h }
  ctx.imageSmoothingQuality = 'high'
  if (stab && (stab.dx || stab.dy || stab.angle || stab.zoom !== 1)) {
    ctx.save()
    ctx.beginPath()
    ctx.rect(rect.x, rect.y, w, h)
    ctx.clip()
    ctx.translate(rect.x + w / 2, rect.y + h / 2)
    ctx.scale(stab.zoom, stab.zoom)
    ctx.rotate(stab.angle)
    ctx.translate(stab.dx * w, stab.dy * h)
    ctx.drawImage(img, -w / 2, -h / 2, w, h)
    ctx.restore()
  } else ctx.drawImage(img, rect.x, rect.y, w, h)
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
export function renderToCanvas(project: Project, frame: number, width: number, opts: RenderOptions = {}) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = Math.round((width * project.settings.height) / project.settings.width)
  renderFrame(canvas.getContext('2d')!, project, frame, opts)
  return canvas
}

// ─── What gets drawn ─────────────────────────────────────────────────────

/** Every player key the open timeline can draw, nested timelines included. */
export function allRenderKeys(project: Project, prefix = '', level = 0, out = new Set<string>()): Set<string> {
  for (const c of Object.values(project.clips)) {
    out.add(prefix + c.id)
    if (!c.sequenceId || level >= MAX_DEPTH) continue
    const view = sequenceView(project, c.sequenceId)
    if (view && view !== project) allRenderKeys(view, `${prefix}${c.id}>`, level + 1, out)
  }
  return out
}

export interface DrawnMedia {
  clip: Clip
  /** Frame within the clip. */
  local: number
  /** The timeline the clip belongs to (a nested one for clips inside nests). */
  view: Project
  /** Its player / decoder key. */
  key: string
  /** Seconds to take off the clip's source time (a subject matte starts where it was made from). */
  offset?: number
}

/**
 * Every media clip a frame draws, nested timelines opened up (only the shown
 * angle of a multicam clip) — what an export decodes before drawing the frame.
 */
export function mediaDrawnAt(project: Project, frame: number, prefix = '', level = 0, only?: string): DrawnMedia[] {
  const out: DrawnMedia[] = []
  const visual = project.tracks.filter((t) => t.kind === 'video' && (only ? t.id === only : !t.hidden))
  const byTrack = clipsByTrack(project)
  for (let i = visual.length - 1; i >= 0; i--) {
    const clip = byTrack.get(visual[i].id)?.find((c) => frame >= c.start && frame < clipEnd(c))
    if (!clip) continue
    const local = frame - clip.start
    const tr = clip.transitionIn
    const prev = tr && local < tr.duration ? adjacentBefore(project, clip) : undefined
    for (const [c, l] of prev ? ([[prev, frame - prev.start], [clip, local]] as const) : ([[clip, local]] as const)) {
      if (c.sequenceId) {
        const view = sequenceView(project, c.sequenceId)
        if (!view || view === project || level >= MAX_DEPTH) continue
        const nf = clipSourceTime(c, l, project.settings.fps) * view.settings.fps
        const angle = view.sequence?.multicam ? angleTrackOf(view, c) : undefined
        out.push(...mediaDrawnAt(view, nf, `${prefix}${c.id}>`, level + 1, angle))
      } else {
        out.push({ clip: c, local: l, view: project, key: renderKey(c, prefix) })
        if (c.matte) out.push({ clip: { ...c, assetId: c.matte.assetId }, local: l, view: project, key: renderKey(c, prefix) + MATTE_KEY, offset: c.matte.from })
      }
    }
  }
  return out
}

/**
 * Keeps the live players of the video drawn at `frame` in step without drawing
 * anything: while rendered previews play, just before live drawing takes over.
 */
export function primeVideos(project: Project, frame: number) {
  beginVideoFrame()
  const playing = usePlayback.getState().playing
  for (const { clip, local, view, key, offset } of mediaDrawnAt(project, frame)) {
    const asset = clip.assetId ? view.assets[clip.assetId] : undefined
    if (!asset || asset.source.missing || asset.source.type !== 'file' || asset.kind !== 'video') continue
    const url = asset.proxy && useUI.getState().useProxies ? asset.proxy.url : asset.source.url
    videoFrame(key, url, Math.max(0, clipSourceTime(clip, local, view.settings.fps) - (offset ?? 0)), playing, playRate(clip, local))
  }
  endVideoFrame()
}

/** Pauses every live video player (rendered previews are showing instead). */
export function restVideos() {
  beginVideoFrame()
  endVideoFrame()
}
