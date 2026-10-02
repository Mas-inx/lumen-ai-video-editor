import { Loader2, Plus } from 'lucide-react'
import { useState, type CSSProperties } from 'react'
import { Preview3D } from '@/components/Preview3D'
import { fontCss } from '@/engine/fonts'
import { placeTitle } from '@/editor/placement'
import { usePlayback } from '@/editor/playback'
import { TITLE_PRESETS, type TitlePreset } from '@/editor/presets'
import { CAPTION_STYLES, type CaptionStyle, type CaptionStyleSpec } from '@/editor/subtitles'
import { useUI } from '@/editor/ui-store'
import { drawTitlePreview } from '@/engine/three/previews'
import { dnd } from '@/features/dnd'
import { actions } from '@/features/shell/actions'
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
        <SectionLabel>Auto captions</SectionLabel>
        <CaptionStyles />
      </div>
    </>
  )
}

/** Samples of each caption style, with the words a viewer would see at that moment. */
const CAPTION_SAMPLES: Record<CaptionStyle, { text: string; accent?: number }> = {
  clean: { text: 'and that’s where it all began' },
  bold: { text: 'This changes' },
  word: { text: 'Secret', accent: 0 },
  boxed: { text: 'Here’s the plan' },
}

function CaptionStyles() {
  const [busy, setBusy] = useState<CaptionStyle | null>(null)
  const run = async (style: CaptionStyle) => {
    if (busy) return
    setBusy(style)
    try {
      await actions.captionSpeech(style)
    } finally {
      setBusy(null)
    }
  }
  return (
    <>
      <div className="grid grid-cols-2 gap-2.5">
        {CAPTION_STYLES.map((s) => (
          <CaptionCard key={s.id} spec={s} busy={busy === s.id} disabled={busy !== null && busy !== s.id} onPick={() => void run(s.id)} />
        ))}
      </div>
      <p className="mt-4 px-1 text-2xs leading-relaxed text-fg-4">Transcribes the speech on the timeline, then lays timed captions on their own track — replacing earlier ones. Each caption is a title you can restyle.</p>
    </>
  )
}

function captionPreview(spec: CaptionStyleSpec): CSSProperties {
  const t = spec.text
  // Scaled from the real caption size, kept legible and inside the card.
  const size = Math.min(21, Math.max(11, Math.round(spec.size * 260)))
  return {
    fontFamily: fontCss(t.font ?? 'sans'),
    fontSize: size,
    fontWeight: t.weight ?? 600,
    letterSpacing: `${t.letterSpacing ?? 0}em`,
    textTransform: t.uppercase ? 'uppercase' : undefined,
    color: t.color ?? '#fff',
    background: t.background ?? undefined,
    padding: t.background ? '2px 7px' : undefined,
    borderRadius: t.background ? 3 : undefined,
    WebkitTextStroke: t.outline ? `${Math.max(2, Math.round(size * t.outline.width * 1.6))}px ${t.outline.color}` : undefined,
    paintOrder: 'stroke fill',
    textShadow: t.shadow ? '0 2px 6px rgba(0,0,0,0.55)' : undefined,
  }
}

/** How each style moves in, played on hover so the card shows the motion too. */
const CAPTION_HOVER: Record<CaptionStyle, string> = {
  clean: 'opacity-70 group-hover/cap:opacity-100',
  bold: 'scale-[0.94] group-hover/cap:scale-100',
  word: 'scale-[0.9] group-hover/cap:scale-100',
  boxed: 'translate-y-1 group-hover/cap:translate-y-0',
}

function CaptionCard({ spec, busy, disabled, onPick }: { spec: CaptionStyleSpec; busy: boolean; disabled: boolean; onPick: () => void }) {
  const sample = CAPTION_SAMPLES[spec.id]
  const words = sample.text.split(' ')
  return (
    <button type="button" onClick={onPick} disabled={disabled} className="group/cap text-left disabled:opacity-50" title={spec.description}>
      <div className="relative flex aspect-video items-end justify-center overflow-hidden rounded-[10px] bg-[linear-gradient(180deg,#2a2d22,#141512_75%)] px-2 pb-[16%] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)] transition-shadow duration-200 group-hover/cap:shadow-[0_0_0_1px_rgb(255_255_255/0.16),0_10px_24px_-10px_rgb(0_0_0/0.9)]">
        <span
          className={`max-w-full text-center leading-tight text-balance transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.2,0.9,0.25,1.25)] ${CAPTION_HOVER[spec.id]}`}
          style={captionPreview(spec)}
        >
          {words.map((w, i) => (
            <span key={i} style={sample.accent === i ? { color: '#ffd84a' } : undefined}>
              {i ? ' ' : ''}
              {w}
            </span>
          ))}
        </span>
        {busy && (
          <span className="absolute inset-0 grid place-items-center bg-black/55">
            <Loader2 className="size-5 animate-spin text-white" />
          </span>
        )}
      </div>
      <div className="mt-1.5 px-0.5 text-xs font-medium text-fg-2 group-hover/cap:text-fg">{spec.name}</div>
    </button>
  )
}

function previewStyle(p: TitlePreset): CSSProperties {
  const t = p.text
  const size = Math.max(10, Math.min(19, (t.size ?? 96) * 0.14))
  return {
    fontFamily: fontCss(t.font ?? 'sans'),
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
