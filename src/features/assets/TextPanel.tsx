import { Plus } from 'lucide-react'
import { useState, type CSSProperties } from 'react'
import { Preview3D } from '@/components/Preview3D'
import { FONTS } from '@/editor/defaults'
import { placeTitle } from '@/editor/placement'
import { usePlayback } from '@/editor/playback'
import { TITLE_PRESETS, type TitlePreset } from '@/editor/presets'
import { useUI } from '@/editor/ui-store'
import { drawTitlePreview } from '@/engine/three/previews'
import { dnd } from '@/features/dnd'
import { PanelHeader, scrollArea, SectionLabel } from './shared'

export function TextPanel() {
  return (
    <>
      <PanelHeader title="Text" />
      <div className={scrollArea}>
        <SectionLabel>3D titles</SectionLabel>
        <div className="grid grid-cols-2 gap-2.5">
          {TITLE_PRESETS.filter((p) => p.is3d).map((p) => (
            <TitleCard key={p.id} preset={p} />
          ))}
        </div>
        <SectionLabel>Title styles</SectionLabel>
        <div className="grid grid-cols-2 gap-2.5">
          {TITLE_PRESETS.filter((p) => !p.is3d).map((p) => (
            <TitleCard key={p.id} preset={p} />
          ))}
        </div>
        <p className="mt-4 px-1 text-2xs leading-relaxed text-fg-4">Click to add at the playhead, or drag onto the timeline. Every style is fully editable — font, color, animation and position.</p>
      </div>
    </>
  )
}

function previewStyle(p: TitlePreset): CSSProperties {
  const t = p.text
  const size = Math.max(10, Math.min(19, (t.size ?? 96) * 0.14))
  return {
    fontFamily: FONTS[t.font ?? 'sans'].css,
    fontSize: size,
    fontWeight: t.weight ?? 600,
    fontStyle: t.italic ? 'italic' : undefined,
    // Cards are small — cap wide tracking so the sample stays readable.
    letterSpacing: `${Math.min(t.letterSpacing ?? 0, 0.24)}em`,
    textTransform: t.uppercase ? 'uppercase' : undefined,
    color: t.color ?? '#fff',
    textShadow: t.glow ? `0 0 12px ${t.glow}, 0 0 4px ${t.glow}` : '0 2px 8px rgba(0,0,0,0.6)',
    background: t.background ?? undefined,
    padding: t.background ? '3px 8px' : undefined,
    borderRadius: t.background ? 4 : undefined,
    textAlign: t.align ?? 'center',
  }
}

function TitleCard({ preset }: { preset: TitlePreset }) {
  const add = () => {
    const id = placeTitle(preset.id, usePlayback.getState().frame)
    if (id) useUI.getState().select([id])
  }
  const alignLeft = preset.text.align === 'left'
  const [hover, setHover] = useState(false)
  return (
    <div
      draggable
      onDragStart={(e) => dnd.start(e, { type: 'title', presetId: preset.id }, preset.name)}
      onDragEnd={dnd.end}
      onClick={add}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      className="group/title cursor-pointer"
    >
      {preset.is3d ? (
        <div className="relative aspect-video overflow-hidden rounded-[10px] bg-[radial-gradient(ellipse_at_30%_20%,#23261b,#111210_70%)] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)] transition-shadow duration-200 group-hover/title:shadow-[0_0_0_1px_rgb(255_255_255/0.16),0_10px_24px_-10px_rgb(0_0_0/0.9)]">
          <Preview3D active={hover} rest={0.6} draw={(canvas, t) => drawTitlePreview(canvas, preset.id, t)} />
          <span className="absolute top-1.5 left-1.5 rounded-md bg-black/55 px-1.5 py-0.5 text-[9px] font-bold tracking-wide text-white backdrop-blur-sm">3D</span>
          <span className="absolute top-1.5 right-1.5 grid size-6 scale-90 place-items-center rounded-full bg-white text-black opacity-0 shadow-lg transition-[opacity,transform] duration-200 group-hover/title:scale-100 group-hover/title:opacity-100">
            <Plus className="size-3.5" strokeWidth={2.5} />
          </span>
        </div>
      ) : (
      <div
        className={`relative flex aspect-video items-center overflow-hidden rounded-[10px] bg-[radial-gradient(ellipse_at_30%_20%,#23261b,#111210_70%)] px-2.5 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)] transition-shadow duration-200 group-hover/title:shadow-[0_0_0_1px_rgb(255_255_255/0.16),0_10px_24px_-10px_rgb(0_0_0/0.9)] ${alignLeft ? 'items-end justify-start pb-3' : 'justify-center'}`}
      >
        <span className="line-clamp-2 max-w-full leading-tight text-balance transition-transform duration-500 ease-out group-hover/title:scale-[1.06]" style={previewStyle(preset)}>
          {preset.sample}
        </span>
        <span className="absolute top-1.5 right-1.5 grid size-6 scale-90 place-items-center rounded-full bg-white text-black opacity-0 shadow-lg transition-[opacity,transform] duration-200 group-hover/title:scale-100 group-hover/title:opacity-100">
          <Plus className="size-3.5" strokeWidth={2.5} />
        </span>
      </div>
      )}
      <div className="mt-1.5 px-0.5 text-xs font-medium text-fg-2 group-hover/title:text-fg">{preset.name}</div>
    </div>
  )
}
