/**
 * The render bar: a thin strip along the bottom of the ruler showing how each
 * stretch of the timeline will play — green rendered, red needs rendering to
 * play smoothly, yellow probably plays, nothing for simple cuts. The chunk
 * being rendered right now shows in the accent colour.
 */
import type { Project } from '@/editor/types'
import { chunkFrames, chunkSpan, chunkState, type ChunkState } from '@/engine/render-cache'
import { cssColor } from './strips'

export const RENDER_BAR_H = 3

const COLOR: Partial<Record<ChunkState, string>> = {
  rendered: 'var(--color-ok)',
  light: 'var(--color-warn)',
  heavy: 'var(--color-danger)',
}

export function paintRenderBar(
  ctx: CanvasRenderingContext2D,
  project: Project,
  view: { pps: number; scrollLeft: number; width: number; y: number; rendering: number | null },
) {
  const fps = project.settings.fps
  const chunkSec = chunkFrames(fps) / fps
  const first = Math.max(0, Math.floor(view.scrollLeft / view.pps / chunkSec))
  const last = Math.ceil((view.scrollLeft + view.width) / view.pps / chunkSec)
  // Runs of one colour are drawn as one bar, so there are no seams between chunks.
  let runColor: string | null = null
  let runX = 0
  let runEnd = 0
  const flush = () => {
    if (runColor && runEnd > runX) {
      ctx.fillStyle = runColor
      ctx.fillRect(runX, view.y, runEnd - runX, RENDER_BAR_H)
    }
  }
  for (let i = first; i < last; i++) {
    const state = chunkState(project, i)
    const css = i === view.rendering ? 'var(--color-accent)' : COLOR[state]
    const color = css ? cssColor(css) : null
    const [f0, f1] = chunkSpan(project, i)
    const x0 = (f0 / fps) * view.pps - view.scrollLeft
    const x1 = (Math.max(f1, f0) / fps) * view.pps - view.scrollLeft
    if (color === runColor && Math.abs(x0 - runEnd) < 0.5) {
      runEnd = x1
      continue
    }
    flush()
    runColor = color
    runX = x0
    runEnd = x1
  }
  flush()
}
