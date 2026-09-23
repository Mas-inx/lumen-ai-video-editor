import { Slider as RadixSlider } from 'radix-ui'
import { cn } from '@/lib/cn'

interface SliderProps {
  value: number
  min?: number
  max?: number
  step?: number
  /** Fill from the midpoint (for -100..100 style values). */
  bipolar?: boolean
  /** CSS gradient painted on the track instead of a fill (e.g. temperature). */
  gradient?: string
  /** Double-click resets to this value. */
  defaultValue?: number
  onChange: (value: number) => void
  onCommit?: (value: number) => void
  className?: string
  disabled?: boolean
  'aria-label'?: string
}

export function Slider({
  value,
  min = 0,
  max = 100,
  step = 1,
  bipolar,
  gradient,
  defaultValue,
  onChange,
  onCommit,
  className,
  disabled,
  ...rest
}: SliderProps) {
  const pct = ((value - min) / (max - min)) * 100
  const mid = ((0 - min) / (max - min)) * 100
  const customFill = bipolar || gradient

  return (
    <RadixSlider.Root
      className={cn('group/slider relative flex h-5 w-full touch-none items-center select-none', disabled && 'opacity-40', className)}
      value={[value]}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onValueChange={([v]) => onChange(v)}
      onValueCommit={([v]) => onCommit?.(v)}
      onDoubleClick={() => defaultValue !== undefined && (onChange(defaultValue), onCommit?.(defaultValue))}
      aria-label={rest['aria-label']}
    >
      <RadixSlider.Track
        className="relative h-[3px] w-full grow overflow-hidden rounded-full bg-white/[0.09]"
        style={gradient ? { background: gradient } : undefined}
      >
        {!customFill && <RadixSlider.Range className="absolute h-full rounded-full bg-accent" />}
        {bipolar && !gradient && (
          <span
            className="absolute h-full rounded-full bg-accent"
            style={{ left: `${Math.min(pct, mid)}%`, width: `${Math.abs(pct - mid)}%` }}
          />
        )}
      </RadixSlider.Track>
      {bipolar && <span className="pointer-events-none absolute top-1/2 h-2 w-px -translate-y-1/2 bg-white/20" style={{ left: `${mid}%` }} />}
      <RadixSlider.Thumb
        className="block size-3 rounded-full bg-white shadow-[0_0_0_1px_rgb(0_0_0/0.25),0_2px_6px_rgb(0_0_0/0.5)] outline-none transition-[transform,box-shadow] duration-150 group-hover/slider:scale-110 focus-visible:ring-4 focus-visible:ring-accent/40 active:scale-125"
      />
    </RadixSlider.Root>
  )
}
