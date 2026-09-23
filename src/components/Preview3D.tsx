import { useEffect, useRef } from 'react'
import { onMediaReady } from '@/engine/media'
import { cn } from '@/lib/cn'

interface Preview3DProps {
  /** Draws one frame; `t` is seconds of hover time. Return false to retry later (assets loading). */
  draw: (canvas: HTMLCanvasElement, t: number) => boolean | void
  /** Time shown at rest. */
  rest?: number
  active: boolean
  className?: string
}

/**
 * A small canvas rendered by the 3D engine: a still at rest, animated while
 * `active` (hovered). Only hovered cards run a render loop.
 */
export function Preview3D({ draw, rest = 0.5, active, className }: Preview3DProps) {
  const ref = useRef<HTMLCanvasElement>(null)
  const drawRef = useRef(draw)
  useEffect(() => {
    drawRef.current = draw
  })

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    if (!active) {
      const paint = () => drawRef.current(canvas, rest) !== false
      if (paint()) return
      // Assets (fonts) still loading — repaint as soon as they're ready.
      return onMediaReady(() => void paint())
    }
    let raf = 0
    const start = performance.now()
    const loop = (now: number) => {
      drawRef.current(canvas, rest + (now - start) / 1000)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [active, rest])

  return <canvas ref={ref} width={320} height={180} className={cn('block h-full w-full', className)} />
}
