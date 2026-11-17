/**
 * The brand kit editor: colours, typefaces, logos and the house style every
 * project can be given. Kits are kept by the app (not the project) and saved
 * as you change them; applying one gives the open project its own copy.
 */
import { FileUp, ImagePlus, Plus, Trash, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { BRAND_LIMITS, type BrandCorner, type BrandFont, type BrandKit } from '@shared/brand'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ScrubInput } from '@/components/ui/scrub-input'
import { Segmented } from '@/components/ui/segmented'
import { Select } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { FONTS } from '@/editor/defaults'
import { EASING_NAMES } from '@/editor/easing'
import { ANIMATIONS, LOOKS, TRANSITIONS } from '@/editor/presets'
import { STYLES } from '@/editor/styles'
import type { CaptionStyle } from '@/editor/subtitles'
import type { FontId } from '@/editor/types'
import { useEditor } from '@/editor/store'
import { useUI } from '@/editor/ui-store'
import { bytesToBase64, fontCss } from '@/engine/fonts'
import { cn } from '@/lib/cn'
import { desktop } from '@/lib/platform'
import { addLogoTo, applyBrandKit, createKit, flushBrandKits, kitFontCss, loadBrandKits, removeKit, setActiveKit, updateKit, useBrandKits } from '@/project/brand'
import { KitPreview } from '@/features/assets/StylesPanel'

const CORNERS: { value: BrandCorner; label: string }[] = [
  { value: 'top-left', label: '↖' },
  { value: 'top-right', label: '↗' },
  { value: 'bottom-left', label: '↙' },
  { value: 'bottom-right', label: '↘' },
]

const WEIGHTS = [300, 400, 500, 600, 700, 800, 900].map((w) => ({ value: String(w), label: String(w) }))

export function BrandKitDialog() {
  const open = useUI((s) => s.brandOpen)
  const setOpen = useUI((s) => s.setBrandOpen)
  const store = useBrandKits((s) => s.store)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (open) void loadBrandKits()
    else flushBrandKits()
  }, [open])
  const kit = store.kits.find((k) => k.id === store.activeId) ?? store.kits[0]
  const set = (patch: Partial<BrandKit> | ((k: BrandKit) => Partial<BrandKit>)) => kit && updateKit(kit.id, patch)

  const apply = async () => {
    if (!kit) return
    setBusy(true)
    try {
      const r = await applyBrandKit({ kitId: kit.id })
      toast.success(`${r.brand.name} applied to the project`, { description: [r.logoClipId ? 'Logo in the corner' : '', ...r.notes].filter(Boolean).join('\n') || undefined })
      setOpen(false)
    } catch (err) {
      toast.error('Couldn’t apply the brand kit', { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen} title="Brand kit" description="Colours, typefaces and logos you use everywhere — every style keeps them." className="w-[min(640px,calc(100vw-32px))]">
      {!kit ? (
        <div className="px-5 pb-5">
          <p className="text-sm text-fg-3">No brand kit yet.</p>
          <Button className="mt-3" variant="primary" onClick={() => createKit()}>
            <Plus /> New brand kit
          </Button>
        </div>
      ) : (
        <>
          <div className="max-h-[min(70vh,700px)] space-y-5 overflow-y-auto px-5 pt-1 pb-5">
            <div className="flex items-center gap-2">
              {store.kits.length > 1 && <Select aria-label="Brand kit" value={kit.id} onChange={setActiveKit} options={store.kits.map((k) => ({ value: k.id, label: k.name || 'Untitled' }))} className="w-40" size="md" />}
              <Input aria-label="Name" value={kit.name} onChange={(e) => set({ name: e.target.value })} placeholder="Brand name" className="flex-1" />
              <Button size="md" variant="ghost" disabled={store.kits.length >= BRAND_LIMITS.kits} onClick={() => createKit()}>
                <Plus /> New
              </Button>
              <Button size="md" variant="ghost" aria-label="Delete this kit" className="text-fg-3 hover:text-danger" onClick={() => removeKit(kit.id)}>
                <Trash />
              </Button>
            </div>
            <div className="rounded-lg bg-white/[0.03] px-3 py-2 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.05)]">
              <KitPreview kit={kit} />
            </div>

            <Colors kit={kit} />
            <Typefaces kit={kit} />
            <Logos kit={kit} />

            <Section title="Titles">
              <Line label="Text">
                <KitColor kit={kit} value={kit.titles.color} onChange={(color) => set((k) => ({ titles: { ...k.titles, color } }))} none="Each style’s" />
              </Line>
              <Line label="Box">
                <KitColor kit={kit} value={kit.titles.background} onChange={(background) => set((k) => ({ titles: { ...k.titles, background } }))} none="No box" />
              </Line>
              <Line label="Weight">
                <Select aria-label="Weight" value={String(kit.titles.weight)} onChange={(w) => set((k) => ({ titles: { ...k.titles, weight: Number(w) } }))} options={WEIGHTS} className="w-24" />
                <label className="ml-3 flex items-center gap-2 text-xs text-fg-3">
                  <Switch aria-label="All capitals" checked={kit.titles.uppercase} onChange={(uppercase) => set((k) => ({ titles: { ...k.titles, uppercase } }))} /> All caps
                </label>
              </Line>
              <Line label="Tracking">
                <Slider value={kit.titles.tracking} min={-0.1} max={0.5} step={0.01} defaultValue={0} onChange={(tracking) => set((k) => ({ titles: { ...k.titles, tracking } }))} />
                <ScrubInput aria-label="Tracking" value={kit.titles.tracking} onChange={(tracking) => set((k) => ({ titles: { ...k.titles, tracking } }))} min={-0.5} max={2} step={0.01} precision={2} unit="em" className="w-[72px] shrink-0" />
              </Line>
            </Section>

            <Section title="Captions">
              <Line label="Style">
                <Segmented<CaptionStyle>
                  value={kit.captions.style as CaptionStyle}
                  onChange={(style) => set((k) => ({ captions: { ...k.captions, style } }))}
                  options={[
                    { value: 'clean', label: 'Clean' },
                    { value: 'bold', label: 'Bold' },
                    { value: 'word', label: 'Word by word' },
                    { value: 'boxed', label: 'Boxed' },
                  ]}
                />
              </Line>
              <Line label="Key words">
                <KitColor kit={kit} value={kit.captions.accent} onChange={(accent) => set((k) => ({ captions: { ...k.captions, accent } }))} none="Default" />
              </Line>
              <Line label="Case">
                <Select
                  aria-label="Caption case"
                  value={kit.captions.uppercase === null ? 'style' : kit.captions.uppercase ? 'upper' : 'spoken'}
                  onChange={(v) => set((k) => ({ captions: { ...k.captions, uppercase: v === 'style' ? null : v === 'upper' } }))}
                  options={[
                    { value: 'style', label: 'As the caption style sets it' },
                    { value: 'upper', label: 'ALL CAPS' },
                    { value: 'spoken', label: 'As spoken' },
                  ]}
                  className="w-56"
                />
              </Line>
            </Section>

            <Section title="Look and motion">
              <Line label="Builds on">
                <Select aria-label="Base style" value={kit.style ?? 'none'} onChange={(v) => set({ style: v === 'none' ? null : v })} options={[{ value: 'none', label: 'No style — just the brand' }, ...STYLES.map((s) => ({ value: s.id, label: s.name }))]} className="w-56" />
              </Line>
              <Line label="Look">
                <Select aria-label="Look" value={kit.look ?? 'none'} onChange={(v) => set({ look: v === 'none' ? null : v })} options={[{ value: 'none', label: 'Leave footage as it is' }, ...LOOKS.map((l) => ({ value: l.id, label: l.name }))]} className="w-56" />
              </Line>
              <Line label="Titles in">
                <Select aria-label="Title entrance" value={kit.motion.titleIn} onChange={(titleIn) => set((k) => ({ motion: { ...k.motion, titleIn } }))} options={ANIMATIONS.map((a) => ({ value: a.preset, label: a.name }))} className="w-32" />
                <span className="ml-2 text-xs text-fg-4">out</span>
                <Select aria-label="Title exit" value={kit.motion.titleOut} onChange={(titleOut) => set((k) => ({ motion: { ...k.motion, titleOut } }))} options={ANIMATIONS.filter((a) => !a.textOnly).map((a) => ({ value: a.preset, label: a.name }))} className="w-32" />
                <ScrubInput aria-label="Title animation length" value={kit.motion.seconds} onChange={(seconds) => set((k) => ({ motion: { ...k.motion, seconds: Math.round(seconds * 100) / 100 } }))} min={0.1} max={4} step={0.05} sensitivity={0.01} precision={2} unit="s" className="ml-1 w-[64px] shrink-0" />
              </Line>
              <Line label="Easing">
                <Select aria-label="Easing" value={kit.motion.easing} onChange={(easing) => set((k) => ({ motion: { ...k.motion, easing } }))} options={EASING_NAMES.map((e) => ({ value: e, label: e }))} className="w-40" />
              </Line>
              <Line label="On cuts">
                <Select
                  aria-label="Transition on cuts"
                  value={kit.motion.transition ?? 'keep'}
                  onChange={(v) => set((k) => ({ motion: { ...k.motion, transition: v === 'keep' ? null : v } }))}
                  options={[{ value: 'keep', label: 'Leave cuts as they are' }, { value: 'cut', label: 'Straight cuts' }, ...TRANSITIONS.map((t) => ({ value: t.kind, label: t.name }))]}
                  className="w-56"
                />
                {kit.motion.transition && kit.motion.transition !== 'cut' && (
                  <ScrubInput aria-label="Transition length" value={kit.motion.transitionSeconds} onChange={(s) => set((k) => ({ motion: { ...k.motion, transitionSeconds: Math.round(s * 100) / 100 } }))} min={0.1} max={4} step={0.05} sensitivity={0.01} precision={2} unit="s" className="ml-1 w-[64px] shrink-0" />
                )}
              </Line>
            </Section>
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3">
            <span className="text-xs text-fg-4">Saved as you go · applying is one undo step</span>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Done
              </Button>
              <Button variant="primary" disabled={busy} onClick={() => void apply()}>
                Apply to this project
              </Button>
            </div>
          </div>
        </>
      )}
    </Dialog>
  )
}

function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-2xs font-semibold tracking-wider text-fg-4 uppercase">{title}</h3>
        {right}
      </div>
      <div className="space-y-1.5">{children}</div>
    </section>
  )
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-8 items-center gap-2">
      <span className="w-20 shrink-0 text-xs text-fg-3">{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-1">{children}</div>
    </div>
  )
}

/** One of the kit's colours, a colour of your own, or none. */
function KitColor({ kit, value, onChange, none }: { kit: BrandKit; value: string | null; onChange: (c: string | null) => void; none: string }) {
  return (
    <div className="flex flex-wrap items-center gap-[5px]">
      <button
        type="button"
        onClick={() => onChange(null)}
        className={cn('h-[18px] rounded-full bg-white/[0.06] px-2 text-[10px] text-fg-3 ring-1 ring-white/10 hover:text-fg-2', value === null && 'text-fg ring-2 ring-accent ring-offset-2 ring-offset-surface')}
      >
        {none}
      </button>
      {kit.colors.map((c, i) => (
        <button
          key={i}
          type="button"
          aria-label={c.name || c.hex}
          title={c.name || c.hex}
          onClick={() => onChange(c.hex)}
          className={cn('size-[18px] rounded-full ring-1 ring-black/30 transition-transform hover:scale-110', value?.toLowerCase() === c.hex.toLowerCase() && 'ring-2 ring-accent ring-offset-2 ring-offset-surface')}
          style={{ background: c.hex }}
        />
      ))}
      {value && !kit.colors.some((c) => c.hex.toLowerCase() === value.toLowerCase()) && (
        <span title={value} className="size-[18px] rounded-full ring-2 ring-accent ring-offset-2 ring-offset-surface" style={{ background: value }} />
      )}
      <label className="relative size-[18px] cursor-pointer overflow-hidden rounded-full bg-[conic-gradient(#f87171,#fbbf24,#34d399,#60a5fa,#a78bfa,#f472b6,#f87171)] ring-1 ring-black/30 transition-transform hover:scale-110" title="Another colour">
        <input type="color" value={value ?? '#ffffff'} onChange={(e) => onChange(e.target.value)} className="absolute inset-0 cursor-pointer opacity-0" />
      </label>
    </div>
  )
}

function Colors({ kit }: { kit: BrandKit }) {
  const setColors = (colors: BrandKit['colors']) => updateKit(kit.id, { colors })
  return (
    <Section
      title="Colours"
      right={
        <button type="button" disabled={kit.colors.length >= BRAND_LIMITS.colors} onClick={() => setColors([...kit.colors, { name: '', hex: '#888888' }])} className="flex items-center gap-1 text-2xs text-fg-3 hover:text-fg disabled:opacity-40">
          <Plus className="size-3" /> Add colour
        </button>
      }
    >
      <div className="grid grid-cols-2 gap-1.5">
        {kit.colors.map((c, i) => (
          <div key={i} className="group/c flex items-center gap-2 rounded-lg bg-white/[0.03] py-1 pr-1 pl-1.5 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.05)]">
            <label className="relative size-6 shrink-0 cursor-pointer overflow-hidden rounded-md ring-1 ring-black/30" style={{ background: c.hex }}>
              <input type="color" value={c.hex.length === 7 ? c.hex : '#888888'} onChange={(e) => setColors(kit.colors.map((x, j) => (j === i ? { ...x, hex: e.target.value } : x)))} className="absolute inset-0 cursor-pointer opacity-0" />
            </label>
            <input
              value={c.name}
              onChange={(e) => setColors(kit.colors.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
              placeholder="Name"
              spellCheck={false}
              className="h-6 min-w-0 flex-1 rounded-md bg-transparent px-1 text-sm text-fg outline-none placeholder:text-fg-4 focus:bg-white/[0.05]"
            />
            <span className="shrink-0 font-mono text-2xs text-fg-4 uppercase">{c.hex}</span>
            <button type="button" aria-label="Remove colour" onClick={() => setColors(kit.colors.filter((_, j) => j !== i))} className="grid size-5 shrink-0 place-items-center rounded-md text-fg-4 opacity-0 hover:bg-white/[0.06] hover:text-fg group-hover/c:opacity-100">
              <X className="size-3" />
            </button>
          </div>
        ))}
      </div>
    </Section>
  )
}

function Typefaces({ kit }: { kit: BrandKit }) {
  return (
    <Section title="Typefaces">
      <FontLine kit={kit} role="heading" label="Headings" />
      <FontLine kit={kit} role="body" label="Body & captions" />
    </Section>
  )
}

function FontLine({ kit, role, label }: { kit: BrandKit; role: 'heading' | 'body'; label: string }) {
  const file = useRef<HTMLInputElement>(null)
  // Fonts embedded in the open project can join the kit, for every project after it.
  const projectFonts = useEditor((s) => s.project.fonts)
  const font = kit.fonts[role]
  const setFont = (f: BrandFont) => updateKit(kit.id, (k) => ({ fonts: { ...k.fonts, [role]: f } }))
  const pick = (v: string) => {
    if (v === 'file') return
    const embedded = v.startsWith('project:') ? projectFonts?.[v.slice('project:'.length)] : undefined
    if (embedded) setFont({ name: embedded.name, fileName: embedded.fileName, data: embedded.data })
    else if (!v.startsWith('project:')) setFont({ builtin: v })
  }
  const load = async (list: FileList | null) => {
    const f = list?.[0]
    if (!f) return
    if (f.size > BRAND_LIMITS.fontBytes) return void toast.error('That font file is too large', { description: 'Fonts up to 12 MB.' })
    setFont({ name: f.name.replace(/\.[^.]+$/, ''), fileName: f.name, data: bytesToBase64(new Uint8Array(await f.arrayBuffer())) })
  }
  return (
    <Line label={label}>
      <Select<string>
        aria-label={label}
        value={'builtin' in font ? font.builtin : 'file'}
        onChange={pick}
        options={[
          ...(Object.keys(FONTS) as FontId[]).map((id) => ({ value: id, label: <span style={{ fontFamily: fontCss(id) }}>{FONTS[id].label}</span> })),
          ...Object.values(projectFonts ?? {})
            .filter((f) => 'builtin' in font || f.name !== font.name)
            .map((f) => ({ value: `project:${f.id}`, label: f.name, hint: 'in this project' })),
          ...('builtin' in font ? [] : [{ value: 'file', label: font.name }]),
        ]}
        className="w-48"
      />
      <Button size="sm" variant="ghost" onClick={() => file.current?.click()}>
        <FileUp /> Font file…
      </Button>
      <input ref={file} type="file" accept=".ttf,.otf,.woff,.woff2,font/*" className="hidden" onChange={(e) => void load(e.target.files).finally(() => (e.target.value = ''))} />
      <span className="min-w-0 flex-1 truncate text-right text-md text-fg-2" style={{ fontFamily: kitFontCss(font, `${kit.id}-${role}`), fontWeight: role === 'heading' ? kit.titles.weight : 400 }}>
        Aa Bb 123
      </span>
    </Line>
  )
}

function Logos({ kit }: { kit: BrandKit }) {
  const wm = kit.watermark
  const setWm = (patch: Partial<BrandKit['watermark']>) => updateKit(kit.id, (k) => ({ watermark: { ...k.watermark, ...patch } }))
  const add = async () => {
    try {
      await addLogoTo(kit.id)
    } catch (err) {
      toast.error('Couldn’t add the logo', { description: err instanceof Error ? err.message : String(err) })
    }
  }
  const remove = (id: string) => updateKit(kit.id, (k) => ({ logos: k.logos.filter((l) => l.id !== id), watermark: k.watermark.logoId === id ? { ...k.watermark, logoId: null } : k.watermark }))
  return (
    <Section
      title="Logos"
      right={
        <button type="button" disabled={!desktop || kit.logos.length >= BRAND_LIMITS.logos} title={desktop ? undefined : 'Needs the desktop app'} onClick={() => void add()} className="flex items-center gap-1 text-2xs text-fg-3 hover:text-fg disabled:opacity-40">
          <ImagePlus className="size-3" /> Add logo…
        </button>
      }
    >
      {kit.logos.length ? (
        <div className="grid grid-cols-4 gap-1.5">
          {kit.logos.map((l) => (
            <div key={l.id} className={cn('group/l relative rounded-lg bg-[repeating-conic-gradient(#1c1d1a_0%_25%,#252622_0%_50%)] bg-[length:12px_12px] p-1.5 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]', wm.logoId === l.id && 'shadow-[0_0_0_2px_var(--color-accent)]')}>
              <button type="button" title={wm.logoId === l.id ? 'In the corner' : 'Put this one in the corner'} onClick={() => setWm({ logoId: wm.logoId === l.id ? null : l.id })} className="block w-full outline-none">
                <img src={l.url} alt={l.name} draggable={false} className="mx-auto h-10 max-w-full object-contain" />
                <span className="mt-1 block truncate text-center text-2xs text-fg-3">{l.name}</span>
              </button>
              <button type="button" aria-label="Remove logo" onClick={() => remove(l.id)} className="absolute top-1 right-1 grid size-4 place-items-center rounded-full bg-black/70 text-white opacity-0 group-hover/l:opacity-100">
                <X className="size-2.5" />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-fg-4">{desktop ? 'PNG or SVG with a transparent background works best.' : 'Adding logos needs the Lumen desktop app.'}</p>
      )}
      {wm.logoId && (
        <>
          <Line label="In the corner">
            <Segmented<BrandCorner> value={wm.corner} onChange={(corner) => setWm({ corner })} options={CORNERS} />
          </Line>
          <Line label="Size">
            <Slider value={wm.size * 100} min={3} max={30} step={0.5} defaultValue={10} onChange={(v) => setWm({ size: v / 100 })} />
            <span className="w-12 shrink-0 text-right text-xs text-fg-3 tabular">{Math.round(wm.size * 100)}%</span>
          </Line>
          <Line label="Opacity">
            <Slider value={wm.opacity * 100} min={10} max={100} step={1} defaultValue={90} onChange={(v) => setWm({ opacity: v / 100 })} />
            <span className="w-12 shrink-0 text-right text-xs text-fg-3 tabular">{Math.round(wm.opacity * 100)}%</span>
          </Line>
        </>
      )}
    </Section>
  )
}
