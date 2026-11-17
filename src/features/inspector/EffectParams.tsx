/**
 * Settings for light and lens effects, drawn from each effect's controls in the
 * catalog (editor/presets.ts): sliders, colours, styles, switches, and a pad to
 * place the light on the frame — or off it. Relight also shows its depth map.
 */
import { ScanEye, Trash } from 'lucide-react'
import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { IconButton } from '@/components/ui/button'
import { Row } from '@/components/ui/section'
import { Select } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { EFFECTS, fxNumber, fxString, type EffectControl } from '@/editor/presets'
import { dispatch, useEditor } from '@/editor/store'
import type { Clip, Effect } from '@/editor/types'
import { actions } from '@/features/shell/actions'
import { cn } from '@/lib/cn'
import { clamp } from '@/lib/math'

type Set = (params: Record<string, number | string>, key?: string) => void

export function EffectParams({ clip, fx }: { clip: Clip; fx: Effect }) {
  const meta = EFFECTS.find((e) => e.kind === fx.kind)
  if (!meta?.controls?.length) return null
  // A vignette from before vignettes had settings keeps its classic round shape until one is changed; then it takes them all.
  const classic = fx.kind === 'vignette' && !fx.params
  const set: Set = (params, key) =>
    dispatch('effect.update', { clipId: clip.id, effectId: fx.id, patch: { params: classic ? { ...meta.params, ...params } : params } }, key ? { coalesce: `fxp:${fx.id}:${key}` } : undefined)
  const following = fxNumber(fx, 'follow', 0) > 0
  return (
    <div className="mt-2 space-y-1 pl-1">
      {classic && <p className="pb-1 text-2xs text-fg-4">Classic round vignette — change any setting to shape it.</p>}
      {meta.controls.map((c) => (
        <Control key={c.key} c={c} fx={fx} set={set} dimmed={c.type === 'point' && following} />
      ))}
      {fx.kind === 'relight' && <DepthRow clip={clip} />}
    </div>
  )
}

function Label({ text, hint }: { text: string; hint?: string }) {
  return <span title={hint}>{text}</span>
}

function Control({ c, fx, set, dimmed }: { c: EffectControl; fx: Effect; set: Set; dimmed?: boolean }) {
  switch (c.type) {
    case 'slider': {
      const v = fxNumber(fx, c.key, c.default)
      return (
        <Row label={<Label text={c.label} hint={c.hint} />}>
          <Slider aria-label={c.label} value={v} min={c.min} max={c.max} defaultValue={c.default} onChange={(x) => set({ [c.key]: Math.round(x) }, c.key)} />
          <span className="w-9 shrink-0 text-right text-xs text-fg-3 tabular">
            {Math.round(v)}
            {c.unit ?? ''}
          </span>
        </Row>
      )
    }
    case 'color': {
      const v = fxString(fx, c.key, c.default)
      return (
        <Row label={<Label text={c.label} hint={c.hint} />}>
          <label className="relative size-5 shrink-0 cursor-pointer overflow-hidden rounded-full ring-1 ring-white/25 transition-transform hover:scale-110" title={c.hint ?? 'Pick a colour'} style={{ background: v }}>
            <input type="color" value={v} onChange={(e) => set({ [c.key]: e.target.value }, c.key)} className="absolute inset-0 cursor-pointer opacity-0" />
          </label>
          <span className="text-xs text-fg-3 uppercase tabular">{v}</span>
        </Row>
      )
    }
    case 'select': {
      const v = fxString(fx, c.key, c.default)
      return (
        <Row label={<Label text={c.label} hint={c.hint} />}>
          <Select aria-label={c.label} value={v} onChange={(x) => set({ [c.key]: x })} options={c.options} className="w-full" />
        </Row>
      )
    }
    case 'switch': {
      const on = fxNumber(fx, c.key, c.default) > 0
      return (
        <Row label={<Label text={c.label} hint={c.hint} />}>
          <span className="flex-1 truncate text-2xs text-fg-4">{c.hint}</span>
          <Switch aria-label={c.label} checked={on} onChange={(x) => set({ [c.key]: x ? 1 : 0 })} />
        </Row>
      )
    }
    case 'point':
      return (
        <Row label={<Label text={c.label} hint={c.hint} />} className="items-start py-1">
          <PointPad
            x={fxNumber(fx, c.key, c.default[0])}
            y={fxNumber(fx, c.keyY, c.default[1])}
            min={c.min}
            max={c.max}
            dimmed={dimmed}
            note={dimmed ? 'Following the brightest light' : undefined}
            onChange={(x, y, key) => set({ [c.key]: x, [c.keyY]: y }, `pt:${key}`)}
            onReset={() => set({ [c.key]: c.default[0], [c.keyY]: c.default[1] })}
          />
        </Row>
      )
  }
}

/**
 * The frame in miniature (with the area around it when the light may sit off
 * the frame) and a puck for the light: drag it, Shift for fine control,
 * double-click to put it back.
 */
function PointPad({ x, y, min, max, dimmed, note, onChange, onReset }: { x: number; y: number; min: number; max: number; dimmed?: boolean; note?: ReactNode; onChange: (x: number, y: number, key: string) => void; onReset: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const aspect = useEditor((s) => s.project.settings.width / Math.max(1, s.project.settings.height))
  const span = max - min
  const pct = (v: number) => ((v - min) / span) * 100
  const drag = (e: ReactPointerEvent) => {
    e.preventDefault()
    const r = ref.current!.getBoundingClientRect()
    const key = String(Date.now())
    const start = { x, y, cx: e.clientX, cy: e.clientY }
    const move = (ev: PointerEvent) => {
      const k = ev.shiftKey ? 0.2 : 1
      const nx = ev.shiftKey ? start.x + ((ev.clientX - start.cx) / r.width) * span * k : min + ((ev.clientX - r.left) / r.width) * span
      const ny = ev.shiftKey ? start.y + ((ev.clientY - start.cy) / r.height) * span * k : min + ((ev.clientY - r.top) / r.height) * span
      onChange(Math.round(clamp(nx, min, max) * 1000) / 1000, Math.round(clamp(ny, min, max) * 1000) / 1000, key)
    }
    move(e.nativeEvent)
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return (
    <div className="w-full space-y-1">
      <div
        ref={ref}
        onPointerDown={drag}
        onDoubleClick={onReset}
        className={cn('relative w-full cursor-crosshair touch-none overflow-hidden rounded-md bg-black/35 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]', dimmed && 'pointer-events-none opacity-40')}
        style={{ aspectRatio: String(aspect) }}
      >
        <span
          className="pointer-events-none absolute rounded-[3px] bg-white/[0.05] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.18)]"
          style={{ left: `${pct(0)}%`, top: `${pct(0)}%`, width: `${100 / span}%`, height: `${100 / span}%` }}
        />
        <span
          className="pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-accent/80 shadow-[0_0_10px_rgb(255_244_214/0.85)]"
          style={{ left: `${pct(x)}%`, top: `${pct(y)}%` }}
        />
      </div>
      <div className="flex justify-between text-2xs text-fg-4 tabular">
        <span>{note ?? `${Math.round(x * 100)}%, ${Math.round(y * 100)}%`}</span>
        {!note && <span>Shift to fine-tune</span>}
      </div>
    </div>
  )
}

/** Relight's depth map: make one on this computer (so the light follows the shapes), or drop it. */
function DepthRow({ clip }: { clip: Clip }) {
  const depth = useEditor((s) => (clip.depth ? s.project.assets[clip.depth.assetId] : undefined))
  if (clip.kind === 'adjustment' || clip.sequenceId)
    return <p className="pt-1 text-2xs text-fg-4">Here the light is shaped from the picture’s brightness — relight a video clip itself to follow its shapes.</p>
  return (
    <Row label="Depth">
      {depth ? (
        <>
          <span className="min-w-0 flex-1 truncate text-xs text-fg-2">The light follows the shapes in the shot</span>
          <IconButton size="xs" label="Remove the depth map" onClick={() => dispatch('clip.update', { ids: [clip.id], patch: { depth: null } }, { label: 'Remove depth map' })}>
            <Trash />
          </IconButton>
        </>
      ) : (
        <button
          type="button"
          onClick={() => void actions.makeDepthMap(clip.id)}
          title="Measures how near each point is, on this computer, so the light wraps around faces and objects"
          className="flex h-6 items-center gap-1 rounded-md bg-white/[0.06] px-2 text-2xs font-medium text-fg-2 hover:bg-white/[0.1] hover:text-fg"
        >
          <ScanEye className="size-3" /> Make depth map
        </button>
      )}
    </Row>
  )
}
