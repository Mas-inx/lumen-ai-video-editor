/**
 * Advanced colour: lift / gamma / gain wheels, tone curves, HSL bands and LUTs.
 * All of it runs in the GPU grade (engine/gl-grade.ts); the editors here only
 * shape the numbers.
 */
import { Blend, Circle, FileUp, Plus, RotateCcw, Spline, SwatchBook, Trash } from 'lucide-react'
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { toast } from 'sonner'
import { IconButton } from '@/components/ui/button'
import { Row, Section } from '@/components/ui/section'
import { Segmented } from '@/components/ui/segmented'
import { Select } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { HSL_BANDS, evalCurve, isIdentityCurve, isNeutralHsl, isNeutralWheel, normalizePoints } from '@/editor/color-math'
import { IDENTITY_CURVES, NEUTRAL_WHEELS } from '@/editor/defaults'
import { parseCube } from '@/editor/lut'
import { dispatch, useEditor } from '@/editor/store'
import type { Clip, CurvePoints, Curves, HslBand, Wheel, Wheels } from '@/editor/types'
import { bytesToBase64 } from '@/engine/fonts'
import { uid } from '@/lib/id'
import { cn } from '@/lib/cn'
import { clamp } from '@/lib/math'

type Patch = Parameters<typeof dispatch<'clip.update'>>[1]['patch']
const update = (ids: string[], color: NonNullable<Patch>['color'], key?: string, label?: string) =>
  dispatch('clip.update', { ids, patch: { color, look: null } }, { ...(key ? { coalesce: key } : {}), ...(label ? { label } : {}) })

// ─── Wheels ──────────────────────────────────────────────────────────────

const WHEELS: { key: keyof Wheels; label: string; hint: string }[] = [
  { key: 'lift', label: 'Lift', hint: 'Shadows' },
  { key: 'gamma', label: 'Gamma', hint: 'Midtones' },
  { key: 'gain', label: 'Gain', hint: 'Highlights' },
]

export function WheelsSection({ clips }: { clips: Clip[] }) {
  const ids = clips.map((c) => c.id)
  const wheels = clips[0].color.wheels ?? NEUTRAL_WHEELS
  const active = WHEELS.some((w) => !isNeutralWheel(wheels[w.key]))
  const set = (key: keyof Wheels, w: Partial<Wheel>, coalesce: string) => update(ids, { wheels: { [key]: { ...wheels[key], ...w } } }, `wheel:${ids.join()}:${key}:${coalesce}`, 'Colour wheels')
  return (
    <Section
      title="Colour wheels"
      icon={<Circle />}
      defaultOpen={active}
      actions={
        active && (
          <IconButton size="xs" label="Reset wheels" onClick={() => update(ids, { wheels: null }, undefined, 'Reset colour wheels')}>
            <RotateCcw />
          </IconButton>
        )
      }
    >
      <div className="grid grid-cols-3 gap-2">
        {WHEELS.map((w) => (
          <div key={w.key} className="flex min-w-0 flex-col items-center gap-1.5">
            <ColorWheel value={wheels[w.key]} onChange={(v, k) => set(w.key, v, k)} />
            <Slider
              aria-label={`${w.label} brightness`}
              value={wheels[w.key].luma * 100}
              min={-100}
              max={100}
              bipolar
              defaultValue={0}
              onChange={(v) => set(w.key, { luma: Math.round(v) / 100 }, 'luma')}
            />
            <div className="text-center leading-tight">
              <div className="text-2xs font-semibold text-fg-2">{w.label}</div>
              <div className="text-[10px] text-fg-4">{w.hint}</div>
            </div>
          </div>
        ))}
      </div>
    </Section>
  )
}

/** A colour disc with a puck: drag toward a colour to push the tone that way; double-click to reset. */
function ColorWheel({ value, onChange }: { value: Wheel; onChange: (w: Partial<Wheel>, key: string) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const drag = (e: ReactPointerEvent) => {
    e.preventDefault()
    const key = String(Date.now())
    const r = ref.current!.getBoundingClientRect()
    const start = { x: value.x, y: value.y, cx: e.clientX, cy: e.clientY }
    const onPuck = (e.target as HTMLElement).dataset.puck !== undefined
    const move = (ev: PointerEvent) => {
      // On the puck, drag relatively (Shift for fine control); elsewhere, jump to the pointer.
      let x: number
      let y: number
      if (onPuck || ev.shiftKey) {
        const k = ev.shiftKey ? 0.2 : 1
        x = start.x + ((ev.clientX - start.cx) / (r.width / 2)) * k
        y = start.y - ((ev.clientY - start.cy) / (r.height / 2)) * k
      } else {
        x = (ev.clientX - (r.left + r.width / 2)) / (r.width / 2)
        y = -(ev.clientY - (r.top + r.height / 2)) / (r.height / 2)
      }
      const m = Math.hypot(x, y)
      if (m > 1) {
        x /= m
        y /= m
      }
      onChange({ x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 }, key)
    }
    if (!onPuck) move(e.nativeEvent)
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return (
    <div
      ref={ref}
      onPointerDown={drag}
      onDoubleClick={() => onChange({ x: 0, y: 0 }, 'reset')}
      className="relative aspect-square w-full max-w-[96px] cursor-crosshair rounded-full shadow-[inset_0_0_0_1px_rgb(255_255_255/0.12),0_4px_14px_-6px_rgb(0_0_0/0.8)]"
      style={{ background: 'radial-gradient(circle, rgb(40 40 44) 0%, rgb(40 40 44 / 0.2) 55%, transparent 72%), conic-gradient(from 90deg, #ff3b3b, #ff3bff, #3b5bff, #3bffff, #3bff5b, #ffff3b, #ff3b3b)' }}
    >
      <span className="pointer-events-none absolute top-1/2 left-1/2 h-px w-full -translate-x-1/2 bg-white/10" />
      <span className="pointer-events-none absolute top-1/2 left-1/2 h-full w-px -translate-x-1/2 -translate-y-1/2 bg-white/10" />
      <span
        data-puck
        className="absolute size-3 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full border-2 border-white bg-black/40 shadow-[0_1px_4px_rgb(0_0_0/0.7)] active:cursor-grabbing"
        style={{ left: `${50 + value.x * 50}%`, top: `${50 - value.y * 50}%` }}
      />
    </div>
  )
}

// ─── Curves ──────────────────────────────────────────────────────────────

type Channel = keyof Curves
const CHANNELS: { value: Channel; label: string; color: string }[] = [
  { value: 'master', label: 'RGB', color: '#f4f4f5' },
  { value: 'red', label: 'R', color: '#ff5a5a' },
  { value: 'green', label: 'G', color: '#4ade6a' },
  { value: 'blue', label: 'B', color: '#5a8cff' },
]

export function CurvesSection({ clips }: { clips: Clip[] }) {
  const ids = clips.map((c) => c.id)
  const curves = clips[0].color.curves ?? IDENTITY_CURVES
  const [channel, setChannel] = useState<Channel>('master')
  const active = CHANNELS.some((c) => !isIdentityCurve(curves[c.value]))
  const svg = useRef<SVGSVGElement>(null)
  const [dragging, setDragging] = useState<number | null>(null)
  const pts = normalizePoints(curves[channel])
  const S = 200
  const setPts = (next: CurvePoints, key?: string) => update(ids, { curves: { [channel]: next } }, key, 'Curves')

  const at = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = svg.current!.getBoundingClientRect()
    return [clamp((e.clientX - r.left) / r.width, 0, 1), clamp(1 - (e.clientY - r.top) / r.height, 0, 1)]
  }

  const drag = (index: number, e: ReactPointerEvent, initial: CurvePoints) => {
    e.preventDefault()
    e.stopPropagation()
    setDragging(index)
    const key = `curve:${ids.join()}:${channel}:${Date.now()}`
    let current = initial
    const move = (ev: PointerEvent) => {
      const [x, y] = at(ev)
      const first = index === 0
      const last = index === current.length - 1
      const lo = first ? 0 : current[index - 1][0] + 0.01
      const hi = last ? 1 : current[index + 1][0] - 0.01
      const nx = first ? 0 : last ? 1 : clamp(x, lo, hi)
      // Dragging a middle point far outside the box removes it.
      if (!first && !last && (y < -0.15 || y > 1.15)) return
      current = current.map((p, i) => (i === index ? [Math.round(nx * 1000) / 1000, Math.round(y * 1000) / 1000] : p)) as CurvePoints
      setPts(current, key)
    }
    const up = () => {
      setDragging(null)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const addPoint = (e: ReactPointerEvent) => {
    const [x] = at(e)
    if (pts.length >= 16 || pts.some((p) => Math.abs(p[0] - x) < 0.03)) return
    const y = evalCurve(pts, x)
    const next = normalizePoints([...pts, [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]])
    setPts(next)
    drag(
      next.findIndex((p) => p[0] === Math.round(x * 1000) / 1000),
      e,
      next,
    )
  }

  const path = (p: CurvePoints) => {
    let d = ''
    for (let i = 0; i <= 64; i++) {
      const x = i / 64
      d += `${i ? 'L' : 'M'}${(x * S).toFixed(1)} ${((1 - clamp(evalCurve(p, x), 0, 1)) * S).toFixed(1)}`
    }
    return d
  }
  const color = CHANNELS.find((c) => c.value === channel)!.color

  return (
    <Section
      title="Curves"
      icon={<Spline />}
      defaultOpen={active}
      actions={
        active && (
          <IconButton size="xs" label="Reset curves" onClick={() => update(ids, { curves: null }, undefined, 'Reset curves')}>
            <RotateCcw />
          </IconButton>
        )
      }
    >
      <div className="space-y-2">
        <Segmented stretch value={channel} onChange={setChannel} options={CHANNELS.map((c) => ({ value: c.value, label: c.label }))} />
        <div className="relative">
          <svg ref={svg} viewBox={`0 0 ${S} ${S}`} className="block aspect-square w-full touch-none rounded-lg bg-black/35 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]" onPointerDown={addPoint}>
            {[0.25, 0.5, 0.75].map((f) => (
              <g key={f} stroke="white" strokeOpacity={0.07}>
                <line x1={f * S} x2={f * S} y1={0} y2={S} />
                <line y1={f * S} y2={f * S} x1={0} x2={S} />
              </g>
            ))}
            <line x1={0} y1={S} x2={S} y2={0} stroke="white" strokeOpacity={0.12} strokeDasharray="3 4" />
            {CHANNELS.filter((c) => c.value !== channel && !isIdentityCurve(curves[c.value])).map((c) => (
              <path key={c.value} d={path(curves[c.value])} fill="none" stroke={c.color} strokeOpacity={0.35} strokeWidth={1} />
            ))}
            <path d={path(pts)} fill="none" stroke={color} strokeWidth={1.75} />
          </svg>
          {pts.map((p, i) => (
            <span
              key={i}
              onPointerDown={(e) => drag(i, e, pts)}
              onDoubleClick={() => i > 0 && i < pts.length - 1 && setPts(pts.filter((_, j) => j !== i))}
              className={cn('absolute size-3 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full border-2 bg-surface shadow-[0_1px_4px_rgb(0_0_0/0.6)]', dragging === i && 'scale-125')}
              style={{ left: `${p[0] * 100}%`, top: `${(1 - p[1]) * 100}%`, borderColor: color }}
            />
          ))}
        </div>
        <p className="text-2xs text-fg-4">Click the curve to add a point, drag to shape it, double-click a point (or drag it out) to remove it.</p>
      </div>
    </Section>
  )
}

// ─── HSL ─────────────────────────────────────────────────────────────────

export function HslSection({ clips }: { clips: Clip[] }) {
  const ids = clips.map((c) => c.id)
  const hsl = clips[0].color.hsl ?? {}
  const [band, setBand] = useState<HslBand>('orange')
  const v = hsl[band] ?? { hue: 0, saturation: 0, luminance: 0 }
  const active = !isNeutralHsl(hsl)
  const set = (patch: Partial<typeof v>, key: string) => update(ids, { hsl: { [band]: { ...v, ...patch } } }, `hsl:${ids.join()}:${band}:${key}`, 'HSL')
  const info = HSL_BANDS.find((b) => b.band === band)!
  return (
    <Section
      title="HSL"
      icon={<SwatchBook />}
      defaultOpen={active}
      actions={
        active && (
          <IconButton size="xs" label="Reset HSL" onClick={() => update(ids, { hsl: null }, undefined, 'Reset HSL')}>
            <RotateCcw />
          </IconButton>
        )
      }
    >
      <div className="space-y-2.5">
        <div className="flex justify-between">
          {HSL_BANDS.map((b) => {
            const adjusted = Boolean(hsl[b.band] && (hsl[b.band]!.hue || hsl[b.band]!.saturation || hsl[b.band]!.luminance))
            return (
              <button
                key={b.band}
                type="button"
                title={b.label}
                onClick={() => setBand(b.band)}
                className={cn('relative grid size-7 place-items-center rounded-full transition-transform hover:scale-110', band === b.band && 'ring-2 ring-white ring-offset-2 ring-offset-surface')}
              >
                <span className="size-5 rounded-full shadow-[inset_0_1px_0_rgb(255_255_255/0.4)]" style={{ background: b.swatch }} />
                {adjusted && <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-accent" />}
              </button>
            )
          })}
        </div>
        <div className="space-y-1">
          <Row label={`${info.label} hue`}>
            <Slider value={v.hue} min={-60} max={60} bipolar defaultValue={0} onChange={(hue) => set({ hue: Math.round(hue) }, 'h')} />
            <span className="w-10 shrink-0 text-right text-xs text-fg-3 tabular">{v.hue}°</span>
          </Row>
          <Row label="Saturation">
            <Slider value={v.saturation} min={-100} max={100} bipolar defaultValue={0} onChange={(s) => set({ saturation: Math.round(s) }, 's')} />
            <span className="w-10 shrink-0 text-right text-xs text-fg-3 tabular">{v.saturation}</span>
          </Row>
          <Row label="Luminance">
            <Slider value={v.luminance} min={-100} max={100} bipolar defaultValue={0} onChange={(l) => set({ luminance: Math.round(l) }, 'l')} />
            <span className="w-10 shrink-0 text-right text-xs text-fg-3 tabular">{v.luminance}</span>
          </Row>
        </div>
      </div>
    </Section>
  )
}

// ─── LUTs ────────────────────────────────────────────────────────────────

/** Reads a .cube file into the project; returns the new LUT's id. */
export async function importLutFile(file: File): Promise<string | null> {
  try {
    const parsed = parseCube(await file.text())
    const lutId = uid('lut')
    const name = parsed.title ?? file.name.replace(/\.cube$/i, '')
    const res = dispatch('lut.add', { lut: { id: lutId, name, size: parsed.size, data: bytesToBase64(parsed.data) } })
    if (!res.ok) throw new Error(res.error)
    toast.success(`Imported LUT “${name}”`)
    return lutId
  } catch (err) {
    toast.error('Couldn’t import that LUT', { description: err instanceof Error ? err.message : String(err) })
    return null
  }
}

export function LutSection({ clips }: { clips: Clip[] }) {
  const ids = clips.map((c) => c.id)
  const luts = useEditor((s) => s.project.luts)
  const lut = clips[0].color.lut
  const file = useRef<HTMLInputElement>(null)
  const list = Object.values(luts ?? {})
  return (
    <Section
      title="LUT"
      icon={<Blend />}
      defaultOpen={Boolean(lut)}
      actions={
        <IconButton size="xs" label="Import a .cube LUT" onClick={() => file.current?.click()}>
          <FileUp />
        </IconButton>
      }
    >
      <div className="space-y-2">
        <input
          ref={file}
          type="file"
          accept=".cube"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f) void importLutFile(f).then((lutId) => lutId && update(ids, { lut: { id: lutId, amount: 1 } }, undefined, 'Apply LUT'))
          }}
        />
        {list.length ? (
          <>
            <Row label="LUT">
              <Select
                aria-label="LUT"
                value={lut?.id ?? ''}
                onChange={(v) => update(ids, { lut: v ? { id: v, amount: lut?.amount ?? 1 } : null }, undefined, v ? 'Apply LUT' : 'Remove LUT')}
                options={[{ value: '', label: 'None' }, ...list.map((l) => ({ value: l.id, label: `${l.name} · ${l.size}³` }))]}
                className="w-full"
              />
            </Row>
            {lut && (
              <Row label="Amount">
                <Slider value={lut.amount * 100} min={0} max={100} defaultValue={100} onChange={(v) => update(ids, { lut: { amount: Math.round(v) / 100 } }, `lut:${ids.join()}`)} />
                <span className="w-10 shrink-0 text-right text-xs text-fg-3 tabular">{Math.round(lut.amount * 100)}%</span>
              </Row>
            )}
            {lut && (
              <button type="button" onClick={() => dispatch('lut.remove', { id: lut.id })} className="flex items-center gap-1.5 text-2xs text-fg-4 hover:text-danger">
                <Trash className="size-3" /> Remove this LUT from the project
              </button>
            )}
          </>
        ) : (
          <button type="button" onClick={() => file.current?.click()} className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-line-2 py-4 text-sm text-fg-3 hover:border-accent/50 hover:text-fg">
            <Plus className="size-4" /> Import a .cube LUT
          </button>
        )}
      </div>
    </Section>
  )
}
