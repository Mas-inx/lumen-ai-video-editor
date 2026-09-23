import { ChevronLeft, ChevronRight, Diamond } from 'lucide-react'
import type { ReactNode } from 'react'
import { ScrubInput } from '@/components/ui/scrub-input'
import { Slider } from '@/components/ui/slider'
import { Tip } from '@/components/ui/tooltip'
import { Row } from '@/components/ui/section'
import { setAnimatable } from '@/editor/edit'
import { isAnimated, keyframeAt, propAt } from '@/editor/keyframes'
import { playback, usePlayback } from '@/editor/playback'
import { dispatch } from '@/editor/store'
import type { AnimatableProp, Clip } from '@/editor/types'
import { cn } from '@/lib/cn'
import { clamp } from '@/lib/math'

/** Current value of a property at the playhead (re-renders only while animated). */
export function usePropValue(clip: Clip, prop: AnimatableProp) {
  const animated = isAnimated(clip, prop)
  const local = usePlayback((s) => (animated ? clamp(s.frame - clip.start, 0, clip.duration) : 0))
  return propAt(clip, prop, local)
}

export function KeyframeButton({ clip, prop }: { clip: Clip; prop: AnimatableProp }) {
  const animated = isAnimated(clip, prop)
  const local = usePlayback((s) => clamp(s.frame - clip.start, 0, clip.duration))
  const here = keyframeAt(clip, prop, local)
  const kfs = clip.keyframes[prop] ?? []
  const prev = [...kfs].reverse().find((k) => k.frame < local)
  const next = kfs.find((k) => k.frame > local)

  const toggle = () => {
    if (here) dispatch('keyframe.remove', { clipId: clip.id, prop, frame: local })
    else dispatch('keyframe.set', { clipId: clip.id, prop, frame: local, value: propAt(clip, prop, local) })
  }

  return (
    <div className="flex items-center">
      {animated && (
        <button
          type="button"
          aria-label="Previous keyframe"
          disabled={!prev}
          onClick={() => prev && (playback.pause(), playback.seek(clip.start + prev.frame))}
          className="grid h-5 w-3 place-items-center text-fg-4 hover:text-fg disabled:opacity-30"
        >
          <ChevronLeft className="size-3" />
        </button>
      )}
      <Tip content={here ? 'Remove keyframe' : animated ? 'Add keyframe here' : 'Animate this property'}>
        <button type="button" onClick={toggle} className="grid size-5 place-items-center rounded-md outline-none hover:bg-white/[0.06] focus-visible:ring-2 focus-visible:ring-accent/60">
          <Diamond
            className={cn('size-[11px] transition-colors', here ? 'fill-accent-2 text-accent-2' : animated ? 'text-accent-2' : 'text-fg-4 hover:text-fg-2')}
            strokeWidth={2.2}
          />
        </button>
      </Tip>
      {animated && (
        <button
          type="button"
          aria-label="Next keyframe"
          disabled={!next}
          onClick={() => next && (playback.pause(), playback.seek(clip.start + next.frame))}
          className="grid h-5 w-3 place-items-center text-fg-4 hover:text-fg disabled:opacity-30"
        >
          <ChevronRight className="size-3" />
        </button>
      )}
    </div>
  )
}

interface PropSliderProps {
  clip: Clip
  prop: AnimatableProp
  label: string
  min: number
  max: number
  step?: number
  /** display transform (e.g. 1 → 100%) */
  display?: (v: number) => number
  fromDisplay?: (v: number) => number
  unit?: string
  precision?: number
  defaultValue: number
  bipolar?: boolean
}

/** Slider + scrub field + keyframe toggle for an animatable property. */
export function PropSlider({ clip, prop, label, min, max, step = 1, display = (v) => v, fromDisplay = (v) => v, unit, precision = 0, defaultValue, bipolar }: PropSliderProps) {
  const value = usePropValue(clip, prop)
  const key = `insp:${clip.id}:${prop}`
  const set = (v: number) => setAnimatable(clip.id, prop, v, key)
  return (
    <Row label={label} trailing={<KeyframeButton clip={clip} prop={prop} />}>
      <Slider value={display(value)} min={display(min)} max={display(max)} step={step} bipolar={bipolar} defaultValue={display(defaultValue)} onChange={(v) => set(fromDisplay(v))} />
      <ScrubInput
        value={display(value)}
        onChange={(v) => set(fromDisplay(v))}
        min={display(min)}
        max={display(max)}
        step={step}
        precision={precision}
        unit={unit}
        className="w-[68px] shrink-0"
      />
    </Row>
  )
}

/** Simple non-animatable slider row with a value readout. */
export function ValueSlider({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  bipolar,
  gradient,
  unit,
  defaultValue = 0,
  format,
  trailing,
}: {
  label: ReactNode
  value: number
  onChange: (v: number) => void
  min: number
  max: number
  step?: number
  bipolar?: boolean
  gradient?: string
  unit?: string
  defaultValue?: number
  format?: (v: number) => string
  trailing?: ReactNode
}) {
  return (
    <Row label={label} trailing={trailing}>
      <Slider value={value} min={min} max={max} step={step} bipolar={bipolar} gradient={gradient} defaultValue={defaultValue} onChange={onChange} />
      <ScrubInput value={value} onChange={onChange} min={min} max={max} step={step} unit={unit} className="w-[56px] shrink-0" />
      {format && <span className="sr-only">{format(value)}</span>}
    </Row>
  )
}

export const SWATCHES = ['#ffffff', '#d6ee00', '#fde68a', '#fca5a5', '#f9a8d4', '#c4b5fd', '#93c5fd', '#6ee7b7', '#111111']

export function ColorSwatches({ value, onChange, allowNone }: { value: string | null; onChange: (c: string | null) => void; allowNone?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-[5px]">
      {allowNone && (
        <button
          type="button"
          aria-label="None"
          onClick={() => onChange(null)}
          className={cn('relative size-[18px] rounded-full bg-white/[0.06] ring-1 ring-white/10', value === null && 'ring-2 ring-accent ring-offset-2 ring-offset-surface')}
        >
          <span className="absolute inset-x-1 top-1/2 h-px -translate-y-1/2 rotate-45 bg-danger" />
        </button>
      )}
      {SWATCHES.map((c) => (
        <button
          key={c}
          type="button"
          aria-label={c}
          onClick={() => onChange(c)}
          className={cn('size-[18px] rounded-full ring-1 ring-black/30 transition-transform hover:scale-110', value?.toLowerCase().startsWith(c) && 'ring-2 ring-accent ring-offset-2 ring-offset-surface')}
          style={{ background: c }}
        />
      ))}
      <label className="relative size-[18px] cursor-pointer overflow-hidden rounded-full bg-[conic-gradient(#f87171,#fbbf24,#34d399,#60a5fa,#a78bfa,#f472b6,#f87171)] ring-1 ring-black/30 transition-transform hover:scale-110" title="Custom color">
        <input type="color" value={value?.slice(0, 7) ?? '#ffffff'} onChange={(e) => onChange(e.target.value)} className="absolute inset-0 cursor-pointer opacity-0" />
      </label>
    </div>
  )
}
