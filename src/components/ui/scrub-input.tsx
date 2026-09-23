import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { cn } from '@/lib/cn'
import { clamp } from '@/lib/math'

interface ScrubInputProps {
  value: number
  onChange: (value: number) => void
  /** Called once when a drag or edit finishes. */
  onCommit?: () => void
  min?: number
  max?: number
  step?: number
  /** Value change per pixel dragged (defaults to `step`). */
  sensitivity?: number
  precision?: number
  unit?: string
  /** Short label shown inside the field, e.g. "X". */
  prefix?: string
  className?: string
  disabled?: boolean
  'aria-label'?: string
}

/**
 * Figma/Blender-style number field: drag horizontally to scrub (Shift = fine,
 * Alt = coarse), click to type, arrow keys to nudge.
 */
export function ScrubInput({
  value,
  onChange,
  onCommit,
  min = -Infinity,
  max = Infinity,
  step = 1,
  sensitivity,
  precision = 0,
  unit,
  prefix,
  className,
  disabled,
  ...rest
}: ScrubInputProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const drag = useRef<{ x: number; start: number; moved: boolean } | null>(null)

  const fmt = (v: number) => (precision ? v.toFixed(precision) : String(Math.round(v)))
  const set = (v: number) => onChange(clamp(Number(v.toFixed(Math.max(precision, 3))), min, max))

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || editing || e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, start: value, moved: false }
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.x
    if (!d.moved && Math.abs(dx) < 3) return
    d.moved = true
    const factor = e.shiftKey ? 0.1 : e.altKey ? 10 : 1
    set(d.start + dx * (sensitivity ?? step) * factor)
  }
  const onPointerUp = () => {
    const d = drag.current
    drag.current = null
    if (!d) return
    if (d.moved) onCommit?.()
    else {
      setDraft(fmt(value))
      setEditing(true)
    }
  }

  const commitDraft = () => {
    const n = Number(draft.replace(/[^\d.+-]/g, ''))
    if (draft.trim() && Number.isFinite(n)) set(n)
    setEditing(false)
    onCommit?.()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    e.preventDefault()
    const dir = e.key === 'ArrowUp' ? 1 : -1
    set(value + dir * step * (e.shiftKey ? 10 : 1))
  }

  return (
    <div
      role="spinbutton"
      tabIndex={disabled ? -1 : 0}
      aria-label={rest['aria-label']}
      aria-valuenow={value}
      aria-valuemin={Number.isFinite(min) ? min : undefined}
      aria-valuemax={Number.isFinite(max) ? max : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onKeyDown={onKeyDown}
      className={cn(
        'group/scrub relative flex h-7 min-w-0 cursor-ew-resize items-center gap-1.5 rounded-[7px] bg-white/[0.045] px-2 text-sm tabular text-fg shadow-[inset_0_0_0_1px_rgb(255_255_255/0.05)] outline-none transition-colors hover:bg-white/[0.07] focus-visible:ring-2 focus-visible:ring-accent/60',
        disabled && 'pointer-events-none opacity-40',
        editing && 'cursor-text bg-surface-4 ring-2 ring-accent/60',
        className,
      )}
    >
      {prefix && <span className="text-2xs font-semibold text-fg-4 group-hover/scrub:text-fg-3">{prefix}</span>}
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.target.select()}
          onBlur={commitDraft}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') commitDraft()
            if (e.key === 'Escape') setEditing(false)
          }}
          className="w-full min-w-0 bg-transparent text-sm tabular text-fg outline-none"
        />
      ) : (
        <span className="min-w-0 flex-1 truncate">
          {fmt(value)}
          {unit && <span className="ml-0.5 text-fg-4">{unit}</span>}
        </span>
      )}
    </div>
  )
}
