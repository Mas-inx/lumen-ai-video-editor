/**
 * Thumbnail renders for the asset browser, made with the real 3D engine on a
 * small dedicated WebGL context — so a card always shows exactly what applying
 * the transition, effect or title will do.
 */
import { DEFAULT_TEXT } from '@/editor/defaults'
import { EFFECTS, TITLE_PRESETS } from '@/editor/presets'
import { useEditor } from '@/editor/store'
import type { EffectKind, TransitionKind } from '@/editor/types'
import { previewCanvas } from '../preview-art'
import { renderLayer3D } from './layer'
import { createStage, frameStage, type Stage } from './stage'
import { renderText3D } from './text'
import { renderTransition3D } from './transitions'

const PW = 1920
const PH = 1080
let stage: Stage | null = null

function previewStage(w: number, h: number) {
  stage ??= createStage()
  frameStage(stage, w, h, PW, PH)
  return stage
}

/** The user's own footage when there is some, abstract artwork otherwise. */
const art = (slot: 0 | 1) => previewCanvas(useEditor.getState().project, slot).canvas

function blit(target: HTMLCanvasElement, source: HTMLCanvasElement | null) {
  const ctx = target.getContext('2d')!
  ctx.clearRect(0, 0, target.width, target.height)
  if (source) ctx.drawImage(source, 0, 0, target.width, target.height)
}

export function drawTransitionPreview(target: HTMLCanvasElement, kind: TransitionKind, p: number) {
  const s = previewStage(target.width, target.height)
  blit(target, renderTransition3D(s, kind, p, art(0), art(1)))
}

export function drawEffectPreview(target: HTMLCanvasElement, kind: EffectKind, t: number) {
  const s = previewStage(target.width, target.height)
  const amount = EFFECTS.find((e) => e.kind === kind)?.amount ?? 60
  const out = renderLayer3D(s, {
    canvas: art(0),
    x: 0,
    y: 0,
    z: 0,
    scale: 1,
    rotation: 0,
    rotateX: 0,
    rotateY: 0,
    opacity: 1,
    effects: [{ id: 'preview', kind, enabled: true, amount }],
    t,
  })
  const ctx = target.getContext('2d')!
  ctx.fillStyle = '#0c0d0b'
  ctx.fillRect(0, 0, target.width, target.height)
  ctx.drawImage(out, 0, 0, target.width, target.height)
}

/** Returns false while the title's font is still loading. */
export function drawTitlePreview(target: HTMLCanvasElement, presetId: string, t: number) {
  const preset = TITLE_PRESETS.find((p) => p.id === presetId)
  if (!preset) return true
  const s = previewStage(target.width, target.height)
  const style = { ...DEFAULT_TEXT, ...preset.text, content: preset.sample, size: (preset.text.size ?? 120) * 1.9 }
  const r = renderText3D(s, { style, x: 0, y: 0, z: 0, scale: 1, rotation: 0, rotateX: 8, rotateY: Math.sin(t * 0.9) * 22, opacity: 1, t })
  if (!r) return false
  blit(target, r.canvas)
  return true
}
