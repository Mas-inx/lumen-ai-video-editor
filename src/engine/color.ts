import type { ColorGrade } from '@/editor/types'

/**
 * Color grade → CSS/canvas filter. Canvas 2D accepts the same filter syntax as
 * CSS, so the preview compositor and the look thumbnails share one pipeline.
 */
export function gradeFilter(g: ColorGrade, extra: { mono?: number; blur?: number } = {}): string {
  const parts: string[] = []
  const brightness = 1 + (g.exposure / 100) * 0.7
  const contrast = 1 + (g.contrast / 100) * 0.65
  const saturate = g.saturation <= -100 ? 0 : 1 + g.saturation / 100
  if (brightness !== 1) parts.push(`brightness(${brightness.toFixed(3)})`)
  if (contrast !== 1) parts.push(`contrast(${contrast.toFixed(3)})`)
  if (saturate !== 1) parts.push(`saturate(${saturate.toFixed(3)})`)
  if (extra.mono) parts.push(`grayscale(${Math.min(100, extra.mono)}%)`)
  if (extra.blur && extra.blur > 0.05) parts.push(`blur(${extra.blur.toFixed(2)}px)`)
  return parts.length ? parts.join(' ') : 'none'
}

/** Temperature and tint as soft-light color washes. */
export function gradeOverlays(g: ColorGrade): { color: string; alpha: number }[] {
  const out: { color: string; alpha: number }[] = []
  if (g.temperature) out.push({ color: g.temperature > 0 ? '#ff963a' : '#3a8cff', alpha: (Math.abs(g.temperature) / 100) * 0.55 })
  if (g.tint) out.push({ color: g.tint > 0 ? '#ff4fd2' : '#44ff88', alpha: (Math.abs(g.tint) / 100) * 0.4 })
  return out
}

export function isNeutral(g: ColorGrade) {
  return !g.exposure && !g.contrast && !g.saturation && !g.temperature && !g.tint && !g.vignette
}
