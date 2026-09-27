/**
 * Speed ramp editor: a curve of speed over the clip. Drag points to reshape it,
 * double-click to add or remove one. The clip keeps the same footage, so its
 * length follows the curve.
 */
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { evalKeyframes } from '@/editor/keyframes'
import { SPEED_RAMPS } from '@/editor/presets'
import { dispatch } from '@/editor/store'
import { isRamped, MAX_SPEED, MIN_SPEED } from '@/editor/timing'
import type { Clip, Keyframe } from '@/editor/types'
import { cn } from '@/lib/cn'
import { clamp } from '@/lib/math'

interface Point {
  at: number
  speed: number
}

const W = 260
const H = 96
const PAD = 8
// Speed runs on a log scale: 0.1× at the bottom, 16× at the top, 1× a third of the way up.
const LOG_MIN = Math.log2(MIN_SPEED)
const LOG_MAX = Math.log2(MAX_SPEED)
const toY = (speed: number) => PAD + (1 - (Math.log2(speed) - LOG_MIN) / (LOG_MAX - LOG_MIN)) * (H - PAD * 2)
const fromY = (y: number) => 2 ** (LOG_MIN + (1 - (y - PAD) / (H - PAD * 2)) * (LOG_MAX - LOG_MIN))
const toX = (at: number) => PAD + at * (W - PAD * 2)
const fromX = (x: number) => (x - PAD) / (W - PAD * 2)
const GRID = [0.25, 0.5, 1, 2, 4, 8]

const pointsOf = (clip: Clip): Point[] =>
  isRamped(clip) ? clip.keyframes.speed!.map((k) => ({ at: clamp(k.frame / clip.duration, 0, 1), speed: k.value })) : [{ at: 0, speed: clip.speed }, { at: 1, speed: clip.speed }]

const round = (s: number) => Math.round(s * 100) / 100

export function SpeedRamp({ clip }: { clip: Clip }) {
  const ramped = isRamped(clip)
  const [points, setPoints] = useState<Point[]>(() => pointsOf(clip))
  const dragging = useRef(false)
  const svgRef = useRef<SVGSVGElement>(null)
  // Follow the clip (undo, presets, the AI) whenever we're not mid-drag.
  useEffect(() => {
    if (!dragging.current) setPoints(pointsOf(clip))
  }, [clip])

  const commit = (next: Point[], key?: string) => dispatch('clip.setSpeedRamp', { id: clip.id, points: next.map((p) => ({ at: p.at, speed: round(p.speed) })) }, { coalesce: key })

  const local = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect()
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H }
  }

  const drag = (e: ReactPointerEvent, index: number) => {
    e.preventDefault()
    e.stopPropagation()
    dragging.current = true
    const key = `ramp:${clip.id}:${Date.now()}`
    let current = points
    const move = (ev: PointerEvent) => {
      const p = local(ev)
      const next = current.map((pt, i) => {
        if (i !== index) return pt
        const first = i === 0
        const last = i === current.length - 1
        // The ends stay at the clip's edges; the rest keep their order.
        const at = first ? 0 : last ? 1 : clamp(fromX(p.x), current[i - 1].at + 0.02, current[i + 1].at - 0.02)
        let speed = clamp(fromY(p.y), MIN_SPEED, MAX_SPEED)
        if (!ev.altKey && Math.abs(Math.log2(speed)) < 0.08) speed = 1
        return { at, speed }
      })
      current = next
      setPoints(next)
      commit(next, key)
    }
    const up = () => {
      dragging.current = false
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const addAt = (e: ReactMouseEvent) => {
    const p = local(e)
    const at = clamp(fromX(p.x), 0.02, 0.98)
    const kfs: Keyframe[] = points.map((pt) => ({ frame: pt.at * 1000, value: pt.speed, easing: 'ease' }))
    const speed = evalKeyframes(kfs, at * 1000)
    const next = [...points, { at, speed }].sort((a, b) => a.at - b.at)
    setPoints(next)
    commit(next)
  }

  const remove = (index: number) => {
    if (index === 0 || index === points.length - 1) return
    const next = points.filter((_, i) => i !== index)
    setPoints(next)
    commit(next)
  }

  // The curve itself, sampled with the same easing playback uses.
  const kfs: Keyframe[] = points.map((pt) => ({ frame: pt.at * 1000, value: pt.speed, easing: 'ease' }))
  let d = ''
  for (let i = 0; i <= 120; i++) {
    const at = i / 120
    d += `${i ? 'L' : 'M'}${toX(at).toFixed(1)} ${toY(clamp(evalKeyframes(kfs, at * 1000), MIN_SPEED, MAX_SPEED)).toFixed(1)}`
  }
  const area = `${d}L${toX(1)} ${H - PAD}L${toX(0)} ${H - PAD}Z`
  const activePreset = SPEED_RAMPS.find((r) => r.points.length === points.length && r.points.every((p, i) => Math.abs(p.at - points[i].at) < 0.02 && Math.abs(p.speed - points[i].speed) < 0.02))

  return (
    <div className="space-y-2.5">
      <div className="grid grid-cols-4 gap-1">
        {SPEED_RAMPS.map((r) => (
          <button
            key={r.id}
            type="button"
            title={r.description}
            onClick={() => commit(r.points)}
            className={cn(
              'h-7 truncate rounded-md px-1 text-2xs font-medium transition-colors',
              activePreset?.id === r.id ? 'bg-accent/18 text-accent-2 shadow-[inset_0_0_0_1px_rgb(214_238_0/0.4)]' : 'bg-white/[0.04] text-fg-3 hover:bg-white/[0.07] hover:text-fg',
            )}
          >
            {r.name}
          </button>
        ))}
        <button
          type="button"
          disabled={!ramped}
          onClick={() => dispatch('clip.setSpeedRamp', { id: clip.id, points: null })}
          className="h-7 rounded-md bg-white/[0.04] px-1 text-2xs font-medium text-fg-3 transition-colors hover:bg-white/[0.07] hover:text-fg disabled:opacity-40"
        >
          No ramp
        </button>
      </div>
      <div className="relative overflow-hidden rounded-lg bg-black/30 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]">
        <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="block h-24 w-full touch-none select-none" preserveAspectRatio="none" onDoubleClick={addAt}>
          {GRID.map((s) => (
            <g key={s}>
              <line x1={PAD} x2={W - PAD} y1={toY(s)} y2={toY(s)} stroke="white" strokeOpacity={s === 1 ? 0.18 : 0.06} strokeDasharray={s === 1 ? undefined : '2 3'} vectorEffect="non-scaling-stroke" />
            </g>
          ))}
          <path d={area} fill="var(--color-accent)" fillOpacity={0.08} />
          <path d={d} fill="none" stroke="var(--color-accent)" strokeWidth={1.75} vectorEffect="non-scaling-stroke" />
        </svg>
        {/* Points as HTML so they stay round whatever the panel width. */}
        {points.map((p, i) => (
          <span
            key={i}
            onPointerDown={(e) => drag(e, i)}
            onDoubleClick={(e) => (e.stopPropagation(), remove(i))}
            title={`${round(p.speed)}×`}
            className="absolute size-3 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full border-2 border-accent bg-surface shadow-[0_1px_4px_rgb(0_0_0/0.6)] transition-transform hover:scale-125 active:cursor-grabbing"
            style={{ left: `${(toX(p.at) / W) * 100}%`, top: `${(toY(p.speed) / H) * 100}%` }}
          />
        ))}
        <div className="pointer-events-none absolute top-1 right-1.5 flex flex-col items-end font-mono text-[9px] leading-tight text-fg-4">
          <span>{round(Math.max(...points.map((p) => p.speed)))}× max</span>
          <span>{round(Math.min(...points.map((p) => p.speed)))}× min</span>
        </div>
      </div>
      <p className="text-2xs text-fg-4">Drag points to shape the ramp · double-click to add or remove one · it snaps to 1× (hold Alt to skip).</p>
    </div>
  )
}
