import { useState, type CSSProperties } from 'react'
import { Preview3D } from '@/components/Preview3D'
import { applyEffect } from '@/editor/placement'
import { EFFECTS } from '@/editor/presets'
import type { EffectKind } from '@/editor/types'
import { useUI } from '@/editor/ui-store'
import { usePreviewArt } from '@/engine/preview-art'
import { drawEffectPreview } from '@/engine/three/previews'
import { dnd } from '@/features/dnd'
import { cn } from '@/lib/cn'
import { PanelHeader, scrollArea, SectionLabel } from './shared'

const NOISE = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/></filter><rect width="120" height="120" filter="url(#n)" opacity="0.9"/></svg>')}")`

const imgStyle: Partial<Record<EffectKind, CSSProperties>> = {
  blur: { filter: 'blur(2.5px)' },
  mono: { filter: 'grayscale(1) contrast(1.15)' },
  sharpen: { filter: 'contrast(1.35) saturate(1.1)' },
}

/** Previews an effect on the user's footage (or abstract artwork before there is any). */
const CHECKER = 'repeating-conic-gradient(#3a3a40 0% 25%, #242428 0% 50%) 50% / 12px 12px'

export function EffectPreview({ kind, src, className }: { kind: EffectKind; src: string; className?: string }) {
  if (kind === 'chromaKey' || kind === 'lumaKey')
    return (
      <div className={cn('relative aspect-video overflow-hidden rounded-[10px]', className)} style={{ background: CHECKER }}>
        <img
          src={src}
          alt=""
          draggable={false}
          className="h-full w-full object-cover"
          style={
            kind === 'lumaKey'
              ? { maskImage: `url(${src})`, maskMode: 'luminance', maskSize: 'cover', maskPosition: 'center' }
              : { maskImage: 'linear-gradient(100deg, transparent 38%, black 62%)' }
          }
        />
      </div>
    )
  return (
    <div className={cn('relative aspect-video overflow-hidden rounded-[10px] bg-black', className)}>
      <img
        src={src}
        alt=""
        draggable={false}
        className={cn(
          'h-full w-full object-cover transition-transform duration-700',
          kind === 'shake' && 'group-hover/fx:animate-[fx-shake_0.35s_linear_infinite]',
          kind === 'pulse' && 'group-hover/fx:animate-[fx-pulse_0.6s_ease-out_infinite]',
        )}
        style={imgStyle[kind]}
      />
      {kind === 'glow' && <img src={src} alt="" className="absolute inset-0 h-full w-full object-cover opacity-70 mix-blend-screen blur-md brightness-125" />}
      {kind === 'rgb' && (
        <>
          <img src={src} alt="" className="absolute inset-0 h-full w-full translate-x-[3px] object-cover opacity-50 mix-blend-screen [filter:sepia(1)_saturate(8)_hue-rotate(-45deg)]" />
          <img src={src} alt="" className="absolute inset-0 h-full w-full -translate-x-[3px] object-cover opacity-50 mix-blend-screen [filter:sepia(1)_saturate(8)_hue-rotate(150deg)]" />
        </>
      )}
      {kind === 'vignette' && <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_35%,rgb(0_0_0/0.85))]" />}
      {kind === 'grain' && <div className="absolute inset-0 opacity-40 mix-blend-overlay group-hover/fx:animate-[fx-grain_0.4s_steps(4)_infinite]" style={{ backgroundImage: NOISE }} />}
      {kind === 'leak' && (
        <div className="absolute -inset-1/2 bg-[radial-gradient(circle_at_center,rgb(255_150_70/0.75),rgb(255_70_120/0.35)_35%,transparent_60%)] mix-blend-screen animate-[fx-leak_5s_ease-in-out_infinite_alternate]" />
      )}
    </div>
  )
}

export function EffectsPanel() {
  const selection = useUI((s) => s.selection)
  const [hovered, setHovered] = useState<EffectKind | null>(null)
  const art = usePreviewArt()

  const card = (fx: (typeof EFFECTS)[number]) => (
    <button
      key={fx.kind}
      type="button"
      draggable
      onDragStart={(e) => dnd.start(e, { type: 'effect', kind: fx.kind }, fx.name)}
      onDragEnd={dnd.end}
      onClick={() => applyEffect(fx.kind, useUI.getState().selection)}
      onPointerEnter={() => setHovered(fx.kind)}
      onPointerLeave={() => setHovered((h) => (h === fx.kind ? null : h))}
      className="group/fx text-left outline-none"
    >
      {fx.is3d ? (
        <div className="relative aspect-video overflow-hidden rounded-[10px] bg-[#0c0d0b] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)] transition-shadow duration-200 group-hover/fx:shadow-[0_0_0_1px_rgb(255_255_255/0.18),0_10px_24px_-10px_rgb(0_0_0/0.9)]">
          <Preview3D key={art.key} active={hovered === fx.kind} rest={1.2} draw={(canvas, t) => drawEffectPreview(canvas, fx.kind, t)} />
          <span className="absolute top-1.5 left-1.5 rounded-md bg-black/55 px-1.5 py-0.5 text-[9px] font-bold tracking-wide text-white backdrop-blur-sm">3D</span>
        </div>
      ) : (
        <EffectPreview
          kind={fx.kind}
          src={art.a}
          className="shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)] transition-shadow duration-200 group-hover/fx:shadow-[0_0_0_1px_rgb(255_255_255/0.18),0_10px_24px_-10px_rgb(0_0_0/0.9)] group-focus-visible/fx:ring-2 group-focus-visible/fx:ring-accent/60"
        />
      )}
      <div className="mt-1.5 px-0.5">
        <div className="text-xs font-medium text-fg-2 group-hover/fx:text-fg">{fx.name}</div>
        <div className="truncate text-2xs text-fg-4">{fx.description}</div>
      </div>
    </button>
  )

  return (
    <>
      <PanelHeader title="Effects" />
      <div className={scrollArea}>
        <SectionLabel right={<span className="text-2xs text-fg-4">{selection.length ? `${selection.length} selected` : 'Select a clip'}</span>}>3D</SectionLabel>
        <div className="grid grid-cols-2 gap-x-2.5 gap-y-3">{EFFECTS.filter((e) => e.is3d).map(card)}</div>
        <SectionLabel>Stylize</SectionLabel>
        <div className="grid grid-cols-2 gap-x-2.5 gap-y-3">{EFFECTS.filter((e) => !e.is3d).map(card)}</div>
      </div>
    </>
  )
}
