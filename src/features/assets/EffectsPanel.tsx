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
      {kind === 'halation' && (
        <img src={src} alt="" className="absolute inset-0 h-full w-full object-cover opacity-75 mix-blend-screen blur-[3px] [filter:brightness(0.95)_contrast(1.6)_sepia(1)_saturate(7)_hue-rotate(-28deg)]" />
      )}
      {kind === 'rays' && (
        <div
          className="absolute inset-0 mix-blend-screen"
          style={{
            background:
              'radial-gradient(ellipse at 50% -10%, rgb(255 244 222 / 0.55), transparent 55%), repeating-conic-gradient(from 150deg at 50% -12%, rgb(255 238 206 / 0.32) 0deg 3deg, transparent 3deg 9deg)',
            maskImage: 'linear-gradient(to bottom, black 10%, transparent 92%)',
          }}
        />
      )}
      {kind === 'flare' && (
        <div
          className="absolute inset-0 mix-blend-screen transition-transform duration-700 group-hover/fx:translate-x-[6%]"
          style={{
            background: [
              'radial-gradient(circle at 26% 28%, rgb(255 246 230 / 0.95) 0 2.5%, rgb(255 214 160 / 0.45) 7%, transparent 22%)',
              'radial-gradient(ellipse 60% 2.2% at 26% 28%, rgb(150 190 255 / 0.7), transparent)',
              'radial-gradient(circle at 58% 62%, rgb(120 255 190 / 0.22) 0 4%, transparent 4.5%)',
              'radial-gradient(circle at 70% 76%, transparent 0 9%, rgb(255 140 220 / 0.25) 9.5% 10.5%, transparent 11%)',
              'radial-gradient(circle at 80% 88%, rgb(140 170 255 / 0.25) 0 2.5%, transparent 3%)',
            ].join(', '),
          }}
        />
      )}
      {kind === 'particles' && (
        <div
          className="absolute inset-0 mix-blend-screen transition-transform duration-[1600ms] ease-linear group-hover/fx:translate-y-[14%]"
          style={{
            background: [
              'radial-gradient(circle at 18% 22%, rgb(255 250 240 / 0.95) 0 1.2%, transparent 1.8%)',
              'radial-gradient(circle at 42% 12%, rgb(255 250 240 / 0.8) 0 0.9%, transparent 1.4%)',
              'radial-gradient(circle at 63% 34%, rgb(255 250 240 / 0.9) 0 1.5%, transparent 2.2%)',
              'radial-gradient(circle at 82% 18%, rgb(255 250 240 / 0.7) 0 0.8%, transparent 1.3%)',
              'radial-gradient(circle at 30% 56%, rgb(255 250 240 / 0.85) 0 1.1%, transparent 1.7%)',
              'radial-gradient(circle at 72% 64%, rgb(255 250 240 / 0.9) 0 1.6%, transparent 2.4%)',
              'radial-gradient(circle at 12% 80%, rgb(255 250 240 / 0.6) 0 0.8%, transparent 1.3%)',
              'radial-gradient(circle at 52% 84%, rgb(255 250 240 / 0.75) 0 1.2%, transparent 1.8%)',
              'radial-gradient(circle at 90% 88%, rgb(255 250 240 / 0.8) 0 1%, transparent 1.6%)',
            ].join(', '),
          }}
        />
      )}
      {kind === 'relight' && (
        <>
          <div className="absolute inset-0 bg-black/35" />
          <div className="absolute inset-0 mix-blend-overlay bg-[radial-gradient(circle_at_24%_30%,rgb(255_226_190/0.95),rgb(255_200_150/0.35)_30%,transparent_62%)] transition-transform duration-700 group-hover/fx:translate-x-[18%]" />
        </>
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
        <SectionLabel>Light</SectionLabel>
        <div className="grid grid-cols-2 gap-x-2.5 gap-y-3">{EFFECTS.filter((e) => e.light).map(card)}</div>
        <SectionLabel>Stylize</SectionLabel>
        <div className="grid grid-cols-2 gap-x-2.5 gap-y-3">{EFFECTS.filter((e) => !e.is3d && !e.light).map(card)}</div>
      </div>
    </>
  )
}
