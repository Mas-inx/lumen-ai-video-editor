/**
 * Styles: house styles that set more than colour — how titles are set, where
 * they sit and how they move, the captions, the transitions on cuts, and the
 * footage's look, finishing and camera move — applied to the timeline or the
 * selection in one undo step. The brand kit sits on top: the identity every
 * style keeps on a branded project.
 */
import { Check, Pencil, Plus, Stamp } from 'lucide-react'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { toast } from 'sonner'
import type { BrandKit } from '@shared/brand'
import { Button } from '@/components/ui/button'
import { Segmented } from '@/components/ui/segmented'
import { Select } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tip } from '@/components/ui/tooltip'
import { LOOKS, TRANSITIONS } from '@/editor/presets'
import { getProject, useEditor } from '@/editor/store'
import { applyStyle, STYLE_PARTS, STYLES, styleToApply, type StylePart, type StylePlan, type StyleSpec, type TitleLook, type TitlePlace } from '@/editor/styles'
import type { AnimPreset, ColorGrade } from '@/editor/types'
import { useUI } from '@/editor/ui-store'
import { fontCss } from '@/engine/fonts'
import { usePreviewArt } from '@/engine/preview-art'
import { cn } from '@/lib/cn'
import { applyBrandKit, createKit, kitFontCss, loadBrandKits, setActiveKit, useBrandKits, type BrandPart } from '@/project/brand'
import { Chip, PanelHeader, scrollArea, SectionLabel } from './shared'

type Scope = 'timeline' | 'selection'

const PART_LABEL: Record<StylePart, string> = { titles: 'Titles', captions: 'Captions', transitions: 'Cuts', footage: 'Footage' }

/** What the style does to the plan of a timeline, said in a toast. */
function summary(plan: StylePlan) {
  const c = plan.counts
  const bits = [c.titles && `${c.titles} title${c.titles > 1 ? 's' : ''}`, c.captions && `${c.captions} caption${c.captions > 1 ? 's' : ''}`, c.cuts && `${c.cuts} cut${c.cuts > 1 ? 's' : ''}`, c.footage && `${c.footage} shot${c.footage > 1 ? 's' : ''}`].filter(Boolean)
  return [bits.join(' · '), ...plan.skipped].filter(Boolean).join('\n')
}

/** The clips a scope covers: the selection, or undefined for the whole timeline. */
function scopeClips(scope: Scope): string[] | undefined | null {
  if (scope === 'timeline') return undefined
  const sel = useUI.getState().selection.filter((id) => getProject().clips[id])
  return sel.length ? sel : null
}

export function StylesPanel() {
  const [scope, setScope] = useState<Scope>('timeline')
  const [parts, setParts] = useState<StylePart[]>(STYLE_PARTS)
  const [keepBrand, setKeepBrand] = useState(true)
  const brand = useEditor((s) => s.project.brand?.name)
  const selected = useUI((s) => s.selection.length)
  const art = usePreviewArt()
  // The style most of the timeline wears.
  const active = useEditor((s) => {
    const count = new Map<string, number>()
    for (const c of Object.values(s.project.clips)) if (c.style && c.kind !== 'audio') count.set(c.style, (count.get(c.style) ?? 0) + 1)
    return [...count].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  })

  const toggle = (part: StylePart) => setParts((p) => (p.includes(part) ? (p.length > 1 ? p.filter((x) => x !== part) : p) : [...p, part]))

  const apply = (spec: StyleSpec) => {
    const clipIds = scopeClips(scope)
    if (clipIds === null) return void toast('Select clips first', { description: 'Or switch to Timeline to style everything.' })
    const styled = styleToApply(getProject(), spec.id, keepBrand) ?? spec
    try {
      const plan = applyStyle(styled, { clipIds, parts })
      if (!plan.steps.length) toast('Nothing to style here', { description: 'Add titles or footage — or turn on more parts.' })
      else toast.success(`${styled.name} applied`, { description: summary(plan) })
    } catch (err) {
      toast.error('Couldn’t apply the style', { description: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <>
      <PanelHeader title="Styles" />
      <div className={scrollArea}>
        <BrandKitCard scope={scope} parts={parts} />
        <SectionLabel>House styles</SectionLabel>
        <Segmented<Scope>
          stretch
          value={scope}
          onChange={setScope}
          options={[
            { value: 'timeline', label: 'Whole timeline' },
            { value: 'selection', label: selected ? `${selected} selected` : 'Selection' },
          ]}
        />
        <div className="mt-2 mb-3 flex flex-wrap gap-1">
          {STYLE_PARTS.map((p) => (
            <Chip key={p} active={parts.includes(p)} onClick={() => toggle(p)}>
              {PART_LABEL[p]}
            </Chip>
          ))}
        </div>
        {brand && (
          <label className="mb-3 flex items-center gap-2 px-0.5 text-xs text-fg-3">
            <Switch aria-label={`Keep the ${brand} typefaces and colours`} checked={keepBrand} onChange={setKeepBrand} />
            Keep {brand}’s typefaces and colours
          </label>
        )}
        <div className="grid grid-cols-2 gap-x-2.5 gap-y-3">
          {STYLES.map((s) => (
            <StyleCard key={s.id} spec={s} src={art.a} active={active === s.id} onApply={() => apply(s)} />
          ))}
        </div>
        <p className="mt-4 px-1 text-2xs leading-relaxed text-fg-4">
          A style sets titles’ type, place and motion, the caption style, the transitions on cuts, and the footage’s look, finish and camera move — in one undo step. Effects you added yourself stay; everything stays editable.
        </p>
      </div>
    </>
  )
}

// ─── Style cards ─────────────────────────────────────────────────────────

/** Where a title sits on a card, like it sits on the frame. */
const PLACE: Record<TitlePlace, string> = {
  center: 'inset-x-[8%] top-1/2 -translate-y-1/2 text-center',
  upper: 'inset-x-[8%] top-[16%] text-center',
  lower: 'inset-x-[8%] bottom-[18%] text-center',
  bottom: 'inset-x-[8%] bottom-[8%] text-center',
  left: 'left-[7%] right-[20%] top-1/2 -translate-y-1/2 text-left',
  'lower-left': 'left-[7%] right-[25%] bottom-[13%] text-left',
  'top-left': 'left-[7%] right-[25%] top-[9%] text-left',
}

/** The same entrances the compositor plays, for the card to play on hover. */
const ENTRANCE: Record<AnimPreset, Keyframe[]> = {
  none: [],
  fade: [{ opacity: 0 }, { opacity: 1 }],
  rise: [
    { opacity: 0, transform: 'translateY(9px)' },
    { opacity: 1, transform: 'none' },
  ],
  drop: [
    { opacity: 0, transform: 'translateY(-9px)' },
    { opacity: 1, transform: 'none' },
  ],
  pop: [
    { opacity: 0, transform: 'scale(0.55)' },
    { opacity: 1, transform: 'scale(1.06)', offset: 0.7 },
    { opacity: 1, transform: 'scale(1)' },
  ],
  zoom: [
    { opacity: 0, transform: 'scale(1.3)' },
    { opacity: 1, transform: 'scale(1)' },
  ],
  blur: [
    { opacity: 0, filter: 'blur(7px)' },
    { opacity: 1, filter: 'blur(0px)' },
  ],
  wipe: [{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0 0 0)' }],
  typewriter: [{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0 0 0)' }],
  spin3d: [
    { opacity: 0, transform: 'perspective(200px) rotateY(95deg)' },
    { opacity: 1, transform: 'none' },
  ],
  flip3d: [
    { opacity: 0, transform: 'perspective(200px) rotateX(88deg)' },
    { opacity: 1, transform: 'none' },
  ],
}

/** The look, near enough for a card (the compositor's grade is the real thing). */
function lookFilter(grade: ColorGrade | undefined): CSSProperties {
  if (!grade) return {}
  const warm = Math.max(0, grade.temperature) / 260
  return {
    filter: `brightness(${1 + grade.exposure / 180}) contrast(${1 + grade.contrast / 150}) saturate(${Math.max(0, 1 + grade.saturation / 100)}) sepia(${warm}) hue-rotate(${Math.min(0, grade.temperature) * 0.3}deg)`,
  }
}

function sampleStyle(look: TitleLook, px: number): CSSProperties {
  return {
    fontFamily: fontCss(look.font ?? 'sans'),
    fontWeight: look.weight ?? 600,
    fontStyle: look.italic ? 'italic' : undefined,
    textTransform: look.uppercase ? 'uppercase' : undefined,
    letterSpacing: `${Math.min(look.tracking ?? 0, 0.3)}em`,
    lineHeight: look.lineHeight ?? 1.1,
    color: look.color ?? '#fff',
    fontSize: px,
    background: look.background ?? undefined,
    padding: look.background ? '1px 4px' : undefined,
    borderRadius: look.background ? 2 : undefined,
    textShadow: look.shadow ? `0 1px ${Math.round(4 * look.shadow + 1)}px rgba(0,0,0,0.6)` : undefined,
  }
}

function StyleCard({ spec, src, active, onApply }: { spec: StyleSpec; src: string; active: boolean; onApply: () => void }) {
  const headline = useRef<HTMLSpanElement>(null)
  const label = useRef<HTMLSpanElement>(null)
  const look = LOOKS.find((l) => l.id === spec.look)
  const play = () => {
    for (const [el, t] of [
      [headline.current, spec.headline],
      [label.current, spec.label],
    ] as const) {
      if (!el || !t.in) continue
      const frames = ENTRANCE[t.in.preset]
      if (frames.length) el.animate(frames, { duration: Math.max(180, t.in.seconds * 1000), easing: t.in.preset === 'typewriter' ? 'steps(10)' : 'cubic-bezier(0.215, 0.61, 0.355, 1)', delay: el === label.current ? 120 : 0, fill: 'backwards' })
    }
  }
  const transition = spec.transition ? (TRANSITIONS.find((t) => t.kind === spec.transition!.kind)?.name ?? spec.transition.kind) : 'Straight cuts'
  const camera = spec.camera ? { push: 'push-in', 'ken-burns': 'Ken Burns', drift: 'drift' }[spec.camera.move] + (spec.camera.on === 'stills' ? ' on stills' : '') : 'still camera'
  return (
    <button type="button" onClick={onApply} onPointerEnter={play} className="group/style text-left outline-none" title={spec.description}>
      <div
        className={cn(
          'relative aspect-video overflow-hidden rounded-[10px] bg-black shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)] transition-shadow duration-200 group-hover/style:shadow-[0_0_0_1px_rgb(255_255_255/0.18),0_10px_24px_-10px_rgb(0_0_0/0.9)]',
          active && 'shadow-[0_0_0_2px_var(--color-accent),0_0_0_5px_rgb(214_238_0/0.2)]',
        )}
      >
        <img src={src} alt="" draggable={false} className="h-full w-full object-cover transition-transform duration-[1.6s] ease-out group-hover/style:scale-[1.06]" style={lookFilter(look?.grade)} />
        {look && look.grade.vignette > 0 && <div className="absolute inset-0" style={{ background: `radial-gradient(ellipse at center, transparent 45%, rgba(0,0,0,${(0.8 * look.grade.vignette) / 100}))` }} />}
        <span className={cn('absolute leading-none', PLACE[spec.headline.place ?? 'center'])}>
          <span ref={headline} className="inline-block max-w-full truncate" style={sampleStyle(spec.headline, Math.min(17, Math.max(8, (spec.headline.size ?? 0.08) * 95)))}>
            The big idea
          </span>
        </span>
        {spec.label.place !== spec.headline.place && (
          <span className={cn('absolute leading-none', PLACE[spec.label.place ?? 'lower-left'])}>
            <span ref={label} className="inline-block max-w-full truncate" style={sampleStyle(spec.label, Math.min(8, Math.max(5.5, (spec.label.size ?? 0.03) * 190)))}>
              Ana Ruiz · Director
            </span>
          </span>
        )}
        {active && (
          <span className="absolute top-1.5 right-1.5 grid size-5 place-items-center rounded-full bg-accent text-accent-fg shadow">
            <Check className="size-3" strokeWidth={3} />
          </span>
        )}
      </div>
      <div className={cn('mt-1.5 px-0.5 text-xs font-medium', active ? 'text-accent-2' : 'text-fg-2 group-hover/style:text-fg')}>{spec.name}</div>
      <div className="truncate px-0.5 text-2xs text-fg-4">
        {transition} · {camera}
      </div>
    </button>
  )
}

// ─── Brand kit ───────────────────────────────────────────────────────────

/** The brand kit: the colours, type and logos every project can wear — set up, picked, applied, edited. */
function BrandKitCard({ scope, parts }: { scope: Scope; parts: StylePart[] }) {
  const store = useBrandKits((s) => s.store)
  const loaded = useBrandKits((s) => s.loaded)
  const onProject = useEditor((s) => s.project.brand?.kitId)
  const [busy, setBusy] = useState(false)
  useEffect(() => void loadBrandKits(), [])
  const kit = store.kits.find((k) => k.id === store.activeId) ?? store.kits[0]
  const open = () => useUI.getState().setBrandOpen(true)

  if (!loaded) return null
  if (!kit) {
    return (
      <div className="mt-1 rounded-[10px] bg-white/[0.025] px-3 py-3 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.05)]">
        <div className="flex items-center gap-2">
          <Stamp className="size-4 shrink-0 text-fg-3" />
          <span className="text-sm font-medium text-fg">Brand kit</span>
        </div>
        <p className="mt-1 text-xs leading-relaxed text-fg-3">Your colours, typefaces and logos, kept for every project — and kept by every style.</p>
        <Button
          size="sm"
          variant="secondary"
          className="mt-2.5 w-full"
          onClick={() => {
            createKit()
            open()
          }}
        >
          <Plus /> Set up a brand kit
        </Button>
      </div>
    )
  }

  const apply = async () => {
    const clipIds = scopeClips(scope)
    if (clipIds === null) return void toast('Select clips first', { description: 'Or switch to Timeline to brand everything.' })
    setBusy(true)
    try {
      const r = await applyBrandKit({ kitId: kit.id, clipIds, parts: [...parts, 'logo'] satisfies BrandPart[] })
      toast.success(`${r.brand.name} applied`, { description: [summary(r.plan), r.logoClipId ? 'Logo in the corner' : '', ...r.notes].filter(Boolean).join('\n') })
    } catch (err) {
      toast.error('Couldn’t apply the brand kit', { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-1 rounded-[10px] bg-white/[0.025] px-3 pt-2.5 pb-3 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.05)]">
      <div className="flex items-center gap-2">
        <Stamp className="size-4 shrink-0 text-fg-3" />
        {store.kits.length > 1 ? (
          <Select aria-label="Brand kit" value={kit.id} onChange={setActiveKit} options={store.kits.map((k) => ({ value: k.id, label: k.name }))} className="min-w-0 flex-1" />
        ) : (
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{kit.name}</span>
        )}
        {onProject === kit.id && <span className="shrink-0 rounded-md bg-ok/10 px-1.5 py-0.5 text-2xs font-medium text-ok">On this project</span>}
      </div>
      <KitPreview kit={kit} />
      <div className="mt-2.5 flex gap-1.5">
        <Button size="sm" variant="primary" className="flex-1" disabled={busy} onClick={() => void apply()}>
          Apply brand
        </Button>
        <Tip content="Colours, typefaces, logos and house style">
          <Button size="sm" variant="secondary" onClick={open}>
            <Pencil /> Edit
          </Button>
        </Tip>
      </div>
    </div>
  )
}

/** The kit at a glance: its colours, its typefaces in themselves, and its logo. */
export function KitPreview({ kit }: { kit: BrandKit }) {
  const logo = kit.logos.find((l) => l.id === kit.watermark.logoId) ?? kit.logos[0]
  return (
    <div className="mt-2 flex items-center gap-2.5">
      <div className="flex -space-x-1">
        {kit.colors.slice(0, 6).map((c, i) => (
          <span key={i} title={c.name || c.hex} className="size-[18px] rounded-full ring-2 ring-surface-2" style={{ background: c.hex }} />
        ))}
      </div>
      <div className="min-w-0 flex-1 leading-tight">
        <div className="truncate text-sm text-fg" style={{ fontFamily: kitFontCss(kit.fonts.heading, `${kit.id}-h`), fontWeight: kit.titles.weight }}>
          {kit.name}
        </div>
        <div className="truncate text-2xs text-fg-3" style={{ fontFamily: kitFontCss(kit.fonts.body, `${kit.id}-b`) }}>
          The quick brown fox
        </div>
      </div>
      {logo && <img src={logo.url} alt="" draggable={false} className="h-7 max-w-[56px] shrink-0 object-contain" />}
    </div>
  )
}
