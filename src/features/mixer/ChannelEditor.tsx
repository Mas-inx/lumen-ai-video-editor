/**
 * The selected mixer channel's processing: an EQ with a live response curve you
 * can drag, a compressor and a limiter, each with a gain-reduction readout.
 */
import { Plus, Trash, Wand } from 'lucide-react'
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { IconButton } from '@/components/ui/button'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu'
import { ScrubInput } from '@/components/ui/scrub-input'
import { Switch } from '@/components/ui/switch'
import { DEFAULT_BUS, DEFAULT_COMPRESSOR, DEFAULT_EQ, DEFAULT_LIMITER } from '@/editor/defaults'
import { dispatch, useEditor } from '@/editor/store'
import type { CompressorSettings, EqSettings, LimiterSettings } from '@/editor/types'
import { audioEngine } from '@/engine/audio-engine'
import { onMeterFrame } from '@/engine/meter-clock'
import { eqResponse, logFrequencies } from '@/engine/eq-response'
import { cn } from '@/lib/cn'
import { clamp } from '@/lib/math'
import { Slider } from '@/components/ui/slider'

type Target = 'master' | string

type Patch = {
  eq?: Partial<EqSettings> | null
  compressor?: Partial<CompressorSettings> | null
  limiter?: Partial<LimiterSettings> | null
  volume?: number
  pan?: number
}

const update = (target: Target, patch: Patch, key?: string, label?: string) => dispatch('mix.update', { target, patch }, { ...(key ? { coalesce: key } : {}), ...(label ? { label } : {}) })

/** Channel presets: a starting point for the common jobs. */
const PRESETS: { id: string; name: string; description: string; patch: Patch }[] = [
  {
    id: 'voice',
    name: 'Clear voice',
    description: 'Cuts rumble and mud, adds presence, evens out the level',
    patch: {
      eq: { enabled: true, lowCut: 80, lowFreq: 220, lowGain: -2.5, midFreq: 3200, midGain: 2.5, midQ: 1, highFreq: 10000, highGain: 2 },
      compressor: { enabled: true, threshold: -22, ratio: 3, attack: 6, release: 120, makeup: 3 },
      limiter: null,
    },
  },
  {
    id: 'music',
    name: 'Music under voice',
    description: 'Scoops the speech range so words sit on top, glues the bed',
    patch: {
      eq: { enabled: true, lowCut: 30, lowFreq: 120, lowGain: 0, midFreq: 2500, midGain: -4, midQ: 0.9, highFreq: 9000, highGain: 0 },
      compressor: { enabled: true, threshold: -24, ratio: 2, attack: 25, release: 300, makeup: 1.5 },
      limiter: null,
    },
  },
  {
    id: 'master',
    name: 'Finished master',
    description: 'Gentle glue compression and a −1 dB ceiling',
    patch: { compressor: { enabled: true, threshold: -14, ratio: 2, attack: 30, release: 250, makeup: 1 }, limiter: { enabled: true, ceiling: -1 } },
  },
  { id: 'flat', name: 'Flat', description: 'No processing', patch: { eq: null, compressor: null, limiter: null } },
]

export function ChannelEditor({ target }: { target: Target }) {
  const mix = useEditor((s) => (target === 'master' ? s.project.master : s.project.tracks.find((t) => t.id === target)?.mix)) ?? DEFAULT_BUS
  const name = useEditor((s) => (target === 'master' ? 'Master' : (s.project.tracks.find((t) => t.id === target)?.name ?? 'Track')))

  return (
    <div className="pb-4">
      <div className="flex h-11 items-center gap-2 px-4">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-fg">{name}</div>
          <div className="text-2xs text-fg-4">{target === 'master' ? 'Everything you hear and export passes through here' : 'EQ → compressor → limiter → fader → pan'}</div>
        </div>
        <Menu>
          <MenuTrigger asChild>
            <IconButton size="sm" label="Channel presets">
              <Wand />
            </IconButton>
          </MenuTrigger>
          <MenuContent align="end" className="w-64">
            {PRESETS.map((p) => (
              <MenuItem key={p.id} onSelect={() => update(target, p.patch, undefined, `${p.name} · ${name}`)}>
                <span className="flex flex-col">
                  <span>{p.name}</span>
                  <span className="text-2xs text-fg-4">{p.description}</span>
                </span>
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
      </div>

      <Processor
        title="EQ"
        present={Boolean(mix.eq)}
        enabled={Boolean(mix.eq?.enabled)}
        onAdd={() => update(target, { eq: { ...DEFAULT_EQ } }, undefined, `Add EQ · ${name}`)}
        onToggle={(v) => update(target, { eq: { enabled: v } })}
        onRemove={() => update(target, { eq: null }, undefined, `Remove EQ · ${name}`)}
      >
        {mix.eq && <EqEditor target={target} eq={mix.eq} />}
      </Processor>

      <Processor
        title="Compressor"
        present={Boolean(mix.compressor)}
        enabled={Boolean(mix.compressor?.enabled)}
        onAdd={() => update(target, { compressor: { ...DEFAULT_COMPRESSOR } }, undefined, `Add compressor · ${name}`)}
        onToggle={(v) => update(target, { compressor: { enabled: v } })}
        onRemove={() => update(target, { compressor: null }, undefined, `Remove compressor · ${name}`)}
        meter={<Reduction target={target} which="compressor" />}
      >
        {mix.compressor && (
          <div className="space-y-1">
            <Param label="Threshold" value={mix.compressor.threshold} min={-60} max={0} step={0.5} unit="dB" defaultValue={DEFAULT_COMPRESSOR.threshold} onChange={(v) => update(target, { compressor: { threshold: v } }, `comp:t:${target}`)} />
            <Param label="Ratio" value={mix.compressor.ratio} min={1} max={20} step={0.1} unit=":1" defaultValue={DEFAULT_COMPRESSOR.ratio} onChange={(v) => update(target, { compressor: { ratio: v } }, `comp:r:${target}`)} />
            <Param label="Attack" value={mix.compressor.attack} min={0.1} max={200} step={0.1} unit="ms" defaultValue={DEFAULT_COMPRESSOR.attack} onChange={(v) => update(target, { compressor: { attack: v } }, `comp:a:${target}`)} />
            <Param label="Release" value={mix.compressor.release} min={10} max={2000} step={5} unit="ms" precision={0} defaultValue={DEFAULT_COMPRESSOR.release} onChange={(v) => update(target, { compressor: { release: v } }, `comp:rel:${target}`)} />
            <Param label="Make-up" value={mix.compressor.makeup} min={0} max={24} step={0.5} unit="dB" defaultValue={0} onChange={(v) => update(target, { compressor: { makeup: v } }, `comp:m:${target}`)} />
          </div>
        )}
      </Processor>

      <Processor
        title="Limiter"
        present={Boolean(mix.limiter)}
        enabled={Boolean(mix.limiter?.enabled)}
        onAdd={() => update(target, { limiter: { ...DEFAULT_LIMITER } }, undefined, `Add limiter · ${name}`)}
        onToggle={(v) => update(target, { limiter: { enabled: v } })}
        onRemove={() => update(target, { limiter: null }, undefined, `Remove limiter · ${name}`)}
        meter={<Reduction target={target} which="limiter" />}
      >
        {mix.limiter && (
          <Param label="Ceiling" value={mix.limiter.ceiling} min={-12} max={0} step={0.1} unit="dB" defaultValue={DEFAULT_LIMITER.ceiling} onChange={(v) => update(target, { limiter: { ceiling: v } }, `lim:${target}`)} />
        )}
      </Processor>
    </div>
  )
}

/** A slider row with a wide value field (“150 ms” fits). */
function Param({ label, value, min, max, step, unit, precision = 1, defaultValue, onChange }: { label: string; value: number; min: number; max: number; step: number; unit: string; precision?: number; defaultValue: number; onChange: (v: number) => void }) {
  return (
    <div className="grid min-h-8 grid-cols-[68px_1fr_72px] items-center gap-2">
      <span className="truncate text-xs text-fg-3">{label}</span>
      <Slider aria-label={label} value={value} min={min} max={max} step={step} defaultValue={defaultValue} onChange={onChange} />
      <ScrubInput aria-label={label} value={value} onChange={onChange} min={min} max={max} step={step} precision={precision} unit={unit} className="w-full" />
    </div>
  )
}

function Processor({
  title,
  present,
  enabled,
  onAdd,
  onToggle,
  onRemove,
  meter,
  children,
}: {
  title: string
  present: boolean
  enabled: boolean
  onAdd: () => void
  onToggle: (v: boolean) => void
  onRemove: () => void
  meter?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="border-t border-line px-4 py-3">
      <div className="flex items-center gap-2">
        <span className={cn('text-sm font-semibold', present ? 'text-fg' : 'text-fg-3')}>{title}</span>
        {present && enabled && meter}
        <span className="flex-1" />
        {present ? (
          <>
            <IconButton size="xs" label={`Remove ${title.toLowerCase()}`} onClick={onRemove}>
              <Trash />
            </IconButton>
            <Switch aria-label={`${title} on`} checked={enabled} onChange={onToggle} />
          </>
        ) : (
          <button type="button" onClick={onAdd} className="flex h-6 items-center gap-1 rounded-md bg-white/[0.05] px-2 text-xs font-medium text-fg-2 transition-colors hover:bg-white/[0.09] hover:text-fg">
            <Plus className="size-3" /> Add
          </button>
        )}
      </div>
      {present && <div className={cn('mt-2.5', !enabled && 'pointer-events-none opacity-40')}>{children}</div>}
    </section>
  )
}

/** How much a compressor or limiter is turning the sound down right now. */
function Reduction({ target, which }: { target: Target; which: 'compressor' | 'limiter' }) {
  const bar = useRef<HTMLSpanElement>(null)
  const label = useRef<HTMLSpanElement>(null)
  useEffect(
    () =>
      onMeterFrame(() => {
        const r = audioEngine.reduction(target)?.[which] ?? 0
        const db = Math.min(0, r)
        if (bar.current) bar.current.style.width = `${Math.min(100, (-db / 20) * 100)}%`
        if (label.current) label.current.textContent = db < -0.05 ? `${db.toFixed(1)} dB` : ''
      }),
    [target, which],
  )
  return (
    <span className="flex items-center gap-1.5" title="Gain reduction">
      <span className="relative h-1.5 w-16 overflow-hidden rounded-full bg-black/50">
        <span ref={bar} className="absolute inset-y-0 right-0 w-0 rounded-full bg-warn" />
      </span>
      <span ref={label} className="w-12 font-mono text-[10px] text-warn tabular" />
    </span>
  )
}

// ─── EQ ──────────────────────────────────────────────────────────────────

const W = 320
const H = 120
const FREQS = logFrequencies(180)
const X = (f: number) => (Math.log(f / 20) / Math.log(1000)) * W
const F = (x: number) => 20 * Math.pow(1000, clamp(x / W, 0, 1))
const Y = (db: number) => H / 2 - (db / 24) * (H / 2 - 6)
const G = (y: number) => clamp(((H / 2 - y) / (H / 2 - 6)) * 24, -18, 18)

type Band = 'lowCut' | 'low' | 'mid' | 'high'

function EqEditor({ target, eq }: { target: Target; eq: EqSettings }) {
  const svg = useRef<SVGSVGElement>(null)
  const [active, setActive] = useState<Band | null>(null)
  const response = eqResponse(eq, FREQS)
  let d = ''
  response.forEach((db, i) => (d += `${i ? 'L' : 'M'}${X(FREQS[i]).toFixed(1)} ${Y(clamp(db, -24, 24)).toFixed(1)}`))
  const set = (patch: Partial<EqSettings>, key: string) => update(target, { eq: patch }, `eq:${key}:${target}`)

  const drag = (e: ReactPointerEvent, band: Band) => {
    e.preventDefault()
    e.stopPropagation()
    setActive(band)
    const key = `${band}:${Date.now()}`
    const move = (ev: PointerEvent) => {
      const r = svg.current!.getBoundingClientRect()
      const x = ((ev.clientX - r.left) / r.width) * W
      const y = ((ev.clientY - r.top) / r.height) * H
      const f = Math.round(F(x))
      const g = Math.round(G(y) * 2) / 2
      if (band === 'lowCut') set({ lowCut: f < 22 ? 0 : clamp(f, 20, 1000) }, key)
      else if (band === 'low') set({ lowFreq: clamp(f, 20, 1000), lowGain: g }, key)
      else if (band === 'mid') set({ midFreq: clamp(f, 100, 10000), midGain: g }, key)
      else set({ highFreq: clamp(f, 1000, 20000), highGain: g }, key)
    }
    const up = () => {
      setActive(null)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const handles: { band: Band; f: number; db: number; label: string }[] = [
    { band: 'lowCut', f: eq.lowCut || 20, db: eq.lowCut ? -3 : -18, label: eq.lowCut ? `Low cut ${eq.lowCut} Hz` : 'Low cut off — drag right' },
    { band: 'low', f: eq.lowFreq, db: eq.lowGain, label: `Low ${eq.lowGain > 0 ? '+' : ''}${eq.lowGain} dB · ${eq.lowFreq} Hz` },
    { band: 'mid', f: eq.midFreq, db: eq.midGain, label: `Mid ${eq.midGain > 0 ? '+' : ''}${eq.midGain} dB · ${eq.midFreq} Hz · Q ${eq.midQ} (wheel)` },
    { band: 'high', f: eq.highFreq, db: eq.highGain, label: `High ${eq.highGain > 0 ? '+' : ''}${eq.highGain} dB · ${eq.highFreq} Hz` },
  ]

  return (
    <div className="space-y-2.5">
      <div className="relative overflow-hidden rounded-lg bg-black/35 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]">
        <svg ref={svg} viewBox={`0 0 ${W} ${H}`} className="block h-[120px] w-full touch-none select-none" preserveAspectRatio="none">
          {[100, 1000, 10000].map((f) => (
            <line key={f} x1={X(f)} x2={X(f)} y1={0} y2={H} stroke="white" strokeOpacity={0.07} vectorEffect="non-scaling-stroke" />
          ))}
          {[-12, 0, 12].map((db) => (
            <line key={db} x1={0} x2={W} y1={Y(db)} y2={Y(db)} stroke="white" strokeOpacity={db === 0 ? 0.16 : 0.06} vectorEffect="non-scaling-stroke" />
          ))}
          <path d={`${d}L${W} ${H / 2}L0 ${H / 2}Z`} fill="var(--color-accent)" fillOpacity={0.1} />
          <path d={d} fill="none" stroke="var(--color-accent)" strokeWidth={1.75} vectorEffect="non-scaling-stroke" />
        </svg>
        {handles.map((h) => (
          <span
            key={h.band}
            title={h.label}
            onPointerDown={(e) => drag(e, h.band)}
            onWheel={h.band === 'mid' ? (e) => set({ midQ: clamp(Math.round((eq.midQ * (e.deltaY < 0 ? 1.12 : 1 / 1.12)) * 100) / 100, 0.1, 12) }, 'q') : undefined}
            className={cn(
              'absolute size-3 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full border-2 bg-surface shadow-[0_1px_4px_rgb(0_0_0/0.6)] transition-transform hover:scale-125 active:cursor-grabbing',
              h.band === 'lowCut' ? 'border-sky-300' : h.band === 'low' ? 'border-emerald-300' : h.band === 'mid' ? 'border-accent' : 'border-pink-300',
              h.band === 'lowCut' && !eq.lowCut && 'opacity-50',
              active === h.band && 'scale-125',
            )}
            style={{ left: `${(X(h.f) / W) * 100}%`, top: `${(Y(clamp(h.db, -24, 24)) / H) * 100}%` }}
          />
        ))}
        <div className="pointer-events-none absolute inset-x-2 bottom-1 flex justify-between font-mono text-[9px] text-fg-4">
          <span>20</span>
          <span>100</span>
          <span>1k</span>
          <span>10k</span>
          <span>20k</span>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-2xs text-fg-3">
        <Field label="Low cut">
          <ScrubInput aria-label="Low cut" value={eq.lowCut} onChange={(v) => set({ lowCut: Math.round(v) }, 'lc')} min={0} max={1000} step={5} unit="Hz" className="w-full" />
        </Field>
        <Field label="Mid Q">
          <ScrubInput aria-label="Mid Q" value={eq.midQ} onChange={(v) => set({ midQ: v }, 'q')} min={0.1} max={12} step={0.05} precision={2} className="w-full" />
        </Field>
        <Field label="Low">
          <ScrubInput aria-label="Low gain" value={eq.lowGain} onChange={(v) => set({ lowGain: v }, 'lg')} min={-24} max={24} step={0.5} precision={1} unit="dB" className="w-full" />
          <ScrubInput aria-label="Low frequency" value={eq.lowFreq} onChange={(v) => set({ lowFreq: Math.round(v) }, 'lf')} min={20} max={1000} step={5} unit="Hz" className="w-full" />
        </Field>
        <Field label="Mid">
          <ScrubInput aria-label="Mid gain" value={eq.midGain} onChange={(v) => set({ midGain: v }, 'mg')} min={-24} max={24} step={0.5} precision={1} unit="dB" className="w-full" />
          <ScrubInput aria-label="Mid frequency" value={eq.midFreq} onChange={(v) => set({ midFreq: Math.round(v) }, 'mf')} min={100} max={10000} step={10} unit="Hz" className="w-full" />
        </Field>
        <Field label="High">
          <ScrubInput aria-label="High gain" value={eq.highGain} onChange={(v) => set({ highGain: v }, 'hg')} min={-24} max={24} step={0.5} precision={1} unit="dB" className="w-full" />
          <ScrubInput aria-label="High frequency" value={eq.highFreq} onChange={(v) => set({ highFreq: Math.round(v) }, 'hf')} min={1000} max={20000} step={50} unit="Hz" className="w-full" />
        </Field>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 items-center gap-1.5">
      <span className="w-11 shrink-0">{label}</span>
      <span className="flex min-w-0 flex-1 gap-1">{children}</span>
    </label>
  )
}

