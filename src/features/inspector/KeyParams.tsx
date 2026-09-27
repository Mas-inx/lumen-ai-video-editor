/**
 * Settings for the chroma and luma keys: the key colour (with an eyedropper
 * that samples the untouched picture), tolerance, softness and spill.
 */
import { Pipette } from 'lucide-react'
import { toast } from 'sonner'
import { Row } from '@/components/ui/section'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { dispatch } from '@/editor/store'
import type { Clip, Effect } from '@/editor/types'
import { cn } from '@/lib/cn'

const SCREENS = [
  { color: '#00d84a', label: 'Green screen' },
  { color: '#0047ff', label: 'Blue screen' },
]

export function KeyParams({ clip, fx }: { clip: Clip; fx: Effect }) {
  const p = fx.params ?? {}
  const n = (key: string, fallback: number) => (typeof p[key] === 'number' ? (p[key] as number) : fallback)
  const set = (params: Record<string, number | string>, key?: string) => dispatch('effect.update', { clipId: clip.id, effectId: fx.id, patch: { params } }, key ? { coalesce: `key:${fx.id}:${key}` } : undefined)

  const pick = async () => {
    const Dropper = (window as unknown as { EyeDropper?: new () => { open(): Promise<{ sRGBHex: string }> } }).EyeDropper
    if (!Dropper) return void toast('This browser has no eyedropper — pick a preset or a colour instead')
    // Sample the picture as it is before keying, so the screen colour is still there.
    dispatch('effect.update', { clipId: clip.id, effectId: fx.id, patch: { enabled: false } }, { history: false })
    try {
      const { sRGBHex } = await new Dropper().open()
      dispatch('effect.update', { clipId: clip.id, effectId: fx.id, patch: { enabled: true } }, { history: false })
      set({ color: sRGBHex })
    } catch {
      dispatch('effect.update', { clipId: clip.id, effectId: fx.id, patch: { enabled: true } }, { history: false })
    }
  }

  if (fx.kind === 'lumaKey') {
    return (
      <div className="mt-2 space-y-1 pl-1">
        <Row label="Threshold">
          <Slider value={n('threshold', 18)} min={0} max={100} onChange={(v) => set({ threshold: Math.round(v) }, 't')} />
          <span className="w-8 text-right text-xs text-fg-3 tabular">{n('threshold', 18)}</span>
        </Row>
        <Row label="Softness">
          <Slider value={n('softness', 12)} min={0} max={100} onChange={(v) => set({ softness: Math.round(v) }, 's')} />
          <span className="w-8 text-right text-xs text-fg-3 tabular">{n('softness', 12)}</span>
        </Row>
        <Row label="Key out">
          <span className="flex-1 text-xs text-fg-3">{n('invert', 0) ? 'The bright parts' : 'The dark parts'}</span>
          <Switch aria-label="Key out the bright parts" checked={Boolean(n('invert', 0))} onChange={(v) => set({ invert: v ? 1 : 0 })} />
        </Row>
      </div>
    )
  }

  const color = String(p.color ?? '#00d84a')
  return (
    <div className="mt-2 space-y-1 pl-1">
      <Row label="Key colour">
        <div className="flex flex-1 items-center gap-1.5">
          {SCREENS.map((s) => (
            <button
              key={s.color}
              type="button"
              title={s.label}
              onClick={() => set({ color: s.color })}
              className={cn('size-5 rounded-full ring-1 ring-white/20 transition-transform hover:scale-110', color.toLowerCase() === s.color && 'ring-2 ring-white')}
              style={{ background: s.color }}
            />
          ))}
          <label className="relative size-5 cursor-pointer overflow-hidden rounded-full ring-2 ring-accent/60" title="Custom colour" style={{ background: color }}>
            <input type="color" value={color} onChange={(e) => set({ color: e.target.value }, 'c')} className="absolute inset-0 cursor-pointer opacity-0" />
          </label>
          <button type="button" onClick={() => void pick()} className="ml-auto flex h-6 items-center gap-1 rounded-md bg-white/[0.06] px-2 text-2xs font-medium text-fg-2 hover:bg-white/[0.1] hover:text-fg">
            <Pipette className="size-3" /> Pick
          </button>
        </div>
      </Row>
      <Row label="Tolerance">
        <Slider value={n('tolerance', 32)} min={0} max={100} onChange={(v) => set({ tolerance: Math.round(v) }, 't')} />
        <span className="w-8 text-right text-xs text-fg-3 tabular">{n('tolerance', 32)}</span>
      </Row>
      <Row label="Softness">
        <Slider value={n('softness', 18)} min={0} max={100} onChange={(v) => set({ softness: Math.round(v) }, 's')} />
        <span className="w-8 text-right text-xs text-fg-3 tabular">{n('softness', 18)}</span>
      </Row>
      <Row label="Spill">
        <Slider value={n('spill', 60)} min={0} max={100} onChange={(v) => set({ spill: Math.round(v) }, 'sp')} />
        <span className="w-8 text-right text-xs text-fg-3 tabular">{n('spill', 60)}</span>
      </Row>
    </div>
  )
}
