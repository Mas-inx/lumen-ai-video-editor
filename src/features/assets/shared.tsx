import type { ReactNode } from 'react'
import type { Asset } from '@/editor/types'
import { sequenceFrameUrl } from '@/engine/media'
import { cn } from '@/lib/cn'

export function PanelHeader({ title, children, accent }: { title: ReactNode; children?: ReactNode; accent?: boolean }) {
  return (
    <div className="flex h-11 shrink-0 items-center justify-between gap-2 px-3.5">
      <h2 className={cn('text-md font-semibold tracking-tight', accent ? 'text-ai' : 'text-fg')}>{title}</h2>
      <div className="flex items-center gap-1">{children}</div>
    </div>
  )
}

export function SectionLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mt-4 mb-2 flex items-center justify-between px-0.5 first:mt-1">
      <span className="text-2xs font-semibold tracking-wider text-fg-4 uppercase">{children}</span>
      {right}
    </div>
  )
}

export function Chip({ active, onClick, children, count }: { active?: boolean; onClick?: () => void; children: ReactNode; count?: number }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/60',
        active ? 'bg-white/[0.12] text-fg shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]' : 'text-fg-3 hover:bg-white/[0.05] hover:text-fg-2',
      )}
    >
      {children}
      {count !== undefined && <span className={cn('tabular', active ? 'text-fg-3' : 'text-fg-4')}>{count}</span>}
    </button>
  )
}

/** Poster image for any visual asset — or, for image sequences given `t` (seconds), the frame there. */
export function assetThumb(asset: Asset, t?: number): string | undefined {
  const src = asset.source
  if (src.type === 'file') return asset.kind === 'image' ? src.url : src.poster
  if (src.type === 'sequence') return t === undefined ? (src.poster ?? sequenceFrameUrl(src, 0)) : sequenceFrameUrl(src, Math.floor(t * src.fps))
  return undefined
}

/** A small waveform drawn from the media's measured peaks (flat while it's being analysed). */
export function MiniWave({ peaks, bars = 28, className }: { peaks?: number[]; bars?: number; className?: string }) {
  const heights = Array.from({ length: bars }, (_, i) => {
    if (!peaks?.length) return 0.08
    const a = Math.floor((i / bars) * peaks.length)
    const b = Math.max(a + 1, Math.floor(((i + 1) / bars) * peaks.length))
    let m = 0
    for (let j = a; j < b; j++) m = Math.max(m, peaks[j] ?? 0)
    return Math.max(0.08, m)
  })
  return (
    <div className={cn('flex h-full items-center gap-[2px]', !peaks?.length && 'animate-pulse-soft', className)}>
      {heights.map((h, i) => (
        <span key={i} className="w-[2px] shrink-0 rounded-full bg-current" style={{ height: `${h * 100}%` }} />
      ))}
    </div>
  )
}

export const scrollArea = 'min-h-0 flex-1 overflow-y-auto px-3.5 pb-4'
