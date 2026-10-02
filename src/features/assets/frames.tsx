import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Asset } from '@/editor/types'
import { filmstripFrame, getFilmstrip, onFilmstrip, type Filmstrip } from '@/engine/decode'
import { cn } from '@/lib/cn'

const stripKey = (asset: Asset | undefined) => (asset?.kind === 'video' && asset.source.type === 'file' ? `${asset.id}|${asset.source.url}` : null)

/** Thumbnails across a video file (decoded in the background on first use). Re-renders only as this file's thumbnails arrive. */
export function useFilmstrip(asset: Asset | undefined, enabled = true): Filmstrip | null {
  const [, setTick] = useState(0)
  const key = stripKey(asset)
  useEffect(() => (key ? onFilmstrip((k) => k === key && setTick((t) => t + 1)) : undefined), [key])
  if (!enabled || !asset || !key || asset.source.type !== 'file' || asset.source.missing || !asset.duration) return null
  return getFilmstrip(key, asset.source.url, asset.duration)
}

export function stripFrame(strip: Filmstrip | null, t: number) {
  return strip ? filmstripFrame(strip, t) : null
}

/** Draws a decoded frame, cropped to fill the box. */
export function FrameCanvas({ frame, className }: { frame: ImageBitmap | null; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useLayoutEffect(() => {
    const c = ref.current
    if (!c || !frame) return
    const w = c.clientWidth || frame.width
    const h = c.clientHeight || frame.height
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    c.width = Math.max(1, Math.round(w * dpr))
    c.height = Math.max(1, Math.round(h * dpr))
    const ctx = c.getContext('2d')!
    const r = Math.max(c.width / frame.width, c.height / frame.height)
    const dw = frame.width * r
    const dh = frame.height * r
    ctx.drawImage(frame, (c.width - dw) / 2, (c.height - dh) / 2, dw, dh)
  }, [frame])
  return <canvas ref={ref} className={cn('block h-full w-full', !frame && 'hidden', className)} />
}
