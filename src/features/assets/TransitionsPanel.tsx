import { useState } from 'react'
import { toast } from 'sonner'
import { Preview3D } from '@/components/Preview3D'
import { applyTransition } from '@/editor/placement'
import { TRANSITIONS } from '@/editor/presets'
import type { TransitionKind } from '@/editor/types'
import { useUI } from '@/editor/ui-store'
import { usePreviewArt } from '@/engine/preview-art'
import { drawTransitionPreview } from '@/engine/three/previews'
import { dnd } from '@/features/dnd'
import { clamp } from '@/lib/math'
import { PanelHeader, scrollArea, SectionLabel } from './shared'

/** CSS keyframe name per 2D transition — the B frame animates over A on hover. */
const ANIM: Partial<Record<TransitionKind, string>> = {
  dissolve: 'tr-dissolve',
  dip: 'tr-dip',
  flash: 'tr-flash',
  slide: 'tr-slide',
  push: 'tr-push-b',
  zoom: 'tr-zoom',
  wipe: 'tr-wipe',
  blur: 'tr-blur',
}

const cardClass =
  'relative aspect-video overflow-hidden rounded-[10px] bg-black shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)] transition-shadow duration-200 group-hover/tr:shadow-[0_0_0_1px_rgb(255_255_255/0.18),0_10px_24px_-10px_rgb(0_0_0/0.9)]'

function TransitionPreview2D({ kind, a, b }: { kind: TransitionKind; a: string; b: string }) {
  // At rest each card is frozen at a telling moment of its transition.
  const rest = kind === 'dip' || kind === 'flash' ? '-0.5s' : '-0.72s'
  return (
    <div className={cardClass}>
      <img src={a} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover" style={{ ['--tr-at' as string]: rest }} data-tr-a={kind} />
      <img src={b} alt="" draggable={false} className="tr-b absolute inset-0 h-full w-full object-cover" style={{ ['--tr' as string]: ANIM[kind], ['--tr-at' as string]: rest }} data-kind={kind} />
      {(kind === 'dip' || kind === 'flash') && <div className={`tr-veil absolute inset-0 ${kind === 'dip' ? 'bg-black' : 'bg-white'}`} style={{ ['--tr-at' as string]: rest }} />}
    </div>
  )
}

function TransitionPreview3D({ kind, active }: { kind: TransitionKind; active: boolean }) {
  return (
    <div className={cardClass}>
      <Preview3D
        active={active}
        rest={0}
        draw={(canvas, t) => {
          // At rest: mid-transition. Hovered: loop the whole move with a short hold.
          const p = active ? clamp(((t % 2.4) - 0.3) / 1.6, 0, 1) : 0.46
          drawTransitionPreview(canvas, kind, p)
        }}
      />
      <span className="absolute top-1.5 left-1.5 rounded-md bg-black/55 px-1.5 py-0.5 text-[9px] font-bold tracking-wide text-white backdrop-blur-sm">3D</span>
    </div>
  )
}

export function TransitionsPanel() {
  const [hovered, setHovered] = useState<TransitionKind | null>(null)
  const art = usePreviewArt()
  const apply = (kind: TransitionKind) => {
    const sel = useUI.getState().selection
    if (sel.length !== 1) return toast('Select the clip after a cut, then pick a transition')
    applyTransition(kind, sel[0])
  }

  const card = (t: (typeof TRANSITIONS)[number]) => (
    <button
      key={t.kind}
      type="button"
      draggable
      onDragStart={(e) => dnd.start(e, { type: 'transition', kind: t.kind }, t.name)}
      onDragEnd={dnd.end}
      onClick={() => apply(t.kind)}
      onPointerEnter={() => setHovered(t.kind)}
      onPointerLeave={() => setHovered((h) => (h === t.kind ? null : h))}
      className="group/tr text-left outline-none"
    >
      {t.is3d ? <TransitionPreview3D key={art.key} kind={t.kind} active={hovered === t.kind} /> : <TransitionPreview2D kind={t.kind} a={art.a} b={art.b} />}
      <div className="mt-1.5 px-0.5">
        <div className="text-xs font-medium text-fg-2 group-hover/tr:text-fg">{t.name}</div>
        <div className="truncate text-2xs text-fg-4">{t.description}</div>
      </div>
    </button>
  )

  return (
    <>
      <PanelHeader title="Transitions" />
      <div className={scrollArea}>
        <SectionLabel>3D</SectionLabel>
        <div className="grid grid-cols-2 gap-x-2.5 gap-y-3">{TRANSITIONS.filter((t) => t.is3d).map(card)}</div>
        <SectionLabel>Classic</SectionLabel>
        <div className="grid grid-cols-2 gap-x-2.5 gap-y-3">{TRANSITIONS.filter((t) => !t.is3d).map(card)}</div>
        <p className="mt-4 px-1 text-2xs leading-relaxed text-fg-4">Drop a transition onto the clip that comes after a cut, or select that clip and click.</p>
      </div>
    </>
  )
}
