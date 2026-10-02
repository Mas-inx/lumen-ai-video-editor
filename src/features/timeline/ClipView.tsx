import { AudioLines, Blend, Crosshair, Film, Gauge, Image as ImageIcon, Layers, Link2, Move, Snowflake, Sparkles, Type, Video } from 'lucide-react'
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { clipBeats } from '@/editor/beat-grid'
import { allKeyframeFrames } from '@/editor/keyframes'
import { angleTracks } from '@/editor/sequences'
import { useEditor } from '@/editor/store'
import { openTimeline } from '@/editor/timeline-nav'
import { isRamped, type Timed } from '@/editor/timing'
import type { Asset, Clip, Sequence } from '@/editor/types'
import { useUI } from '@/editor/ui-store'
import { getPeaks } from '@/engine/audio'
import { useFilmstrip } from '@/features/assets/frames'
import { cn } from '@/lib/cn'
import { clamp } from '@/lib/math'
import { useLayout } from './layout'
import { CLIP_COLOR, dbToGain, useDrag } from './model'
import { cssColor, onThumb, paintFilm, paintWave } from './strips'
import { OVERSCAN, QUANTUM, useViewport } from './viewport'

const INSET = 3

export const ClipView = memo(function ClipView({ clipId, locked }: { clipId: string; locked: boolean }) {
  const { pps, fps, rowTop, rowHeight } = useLayout()
  const clip = useEditor((s) => s.project.clips[clipId])
  const asset = useEditor((s) => (clip?.assetId ? s.project.assets[clip.assetId] : undefined))
  const nested = useEditor((s) => (clip?.sequenceId ? s.project.sequences?.[clip.sequenceId] : undefined))
  const selected = useUI((s) => s.selection.includes(clipId))
  const aiAt = useUI((s) => s.aiTouched[clipId])
  const preview = useDrag((s) => s.previews[clipId])
  const held = useDrag((s) => s.dragIds.includes(clipId))
  const moving = useDrag((s) => s.mode === 'move')
  const isDropTarget = useDrag((s) => s.dropTargetClip === clipId)

  if (!clip) return null

  const start = preview?.start ?? clip.start
  const duration = preview?.duration ?? clip.duration
  const inPoint = preview?.inPoint ?? clip.inPoint
  const trackId = preview?.trackId ?? clip.trackId
  const left = (start / fps) * pps
  const width = Math.max(3, (duration / fps) * pps)
  const laneH = rowHeight[trackId] ?? rowHeight[clip.trackId]
  const height = laneH - INSET * 2
  const dy = (rowTop[trackId] ?? 0) - (rowTop[clip.trackId] ?? 0)
  const color = clip.sequenceId ? 'var(--color-clip-nest)' : CLIP_COLOR[clip.kind]
  const lifted = held && moving
  // Neighbours making room glide; the clip under the pointer tracks it exactly.
  const gliding = Boolean(preview) && !held
  const showLabel = width > 26
  const aiRecent = aiAt !== undefined && Date.now() - aiAt < 3000

  return (
    <div
      data-clip-id={clip.id}
      onDoubleClick={clip.sequenceId ? () => openTimeline(clip.sequenceId!, true) : undefined}
      className={cn(
        'group/clip absolute overflow-hidden rounded-[7px] transition-[box-shadow,filter] duration-150',
        'shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)] hover:brightness-110',
        selected && 'z-10 shadow-[inset_0_0_0_2px_#fff,0_0_0_1px_var(--clip),0_10px_28px_-8px_var(--clip)]',
        lifted && 'z-[25] cursor-grabbing opacity-95 shadow-[inset_0_0_0_2px_#fff,0_18px_40px_-12px_rgb(0_0_0/0.9)]',
        gliding && 'transition-[left,width,box-shadow,filter] duration-200 ease-[var(--ease-out-quart)]',
        isDropTarget && 'z-10 shadow-[inset_0_0_0_2px_var(--color-accent),0_0_0_3px_rgb(214_238_0/0.35)]',
        locked && 'pointer-events-none opacity-50 saturate-50',
      )}
      style={{
        left,
        width,
        top: INSET,
        height,
        transform: dy ? `translateY(${dy}px)` : undefined,
        ['--clip' as string]: color,
        background: clip.kind === 'audio' ? `color-mix(in oklab, ${color} 20%, #121310)` : '#0d0e0c',
      }}
    >
      {clip.sequenceId ? (
        <NestBody clip={clip} seq={nested} inPoint={inPoint} duration={duration} width={width} height={height} />
      ) : (
        <ClipBody clip={clip} asset={asset} inPoint={inPoint} duration={duration} left={left} width={width} height={height} />
      )}

      {showLabel && <ClipLabel clip={clip} asset={asset} nested={nested} />}

      {clip.kind === 'audio' && <Fades clip={clip} width={width} height={height} />}

      {selected && <KeyframeDiamonds clip={clip} duration={duration} width={width} />}

      {/* Trim handles */}
      {!locked && width > 14 && (
        <>
          <div data-handle="start" className="absolute inset-y-0 left-0 z-10 w-2 cursor-col-resize">
            <span className={cn('absolute top-1/2 left-[3px] h-[42%] max-h-7 w-[3px] -translate-y-1/2 rounded-full bg-white/90 opacity-0 shadow-[0_0_0_1px_rgb(0_0_0/0.3)] transition-opacity group-hover/clip:opacity-100', selected && 'opacity-100')} />
          </div>
          <div data-handle="end" className="absolute inset-y-0 right-0 z-10 w-2 cursor-col-resize">
            <span className={cn('absolute top-1/2 right-[3px] h-[42%] max-h-7 w-[3px] -translate-y-1/2 rounded-full bg-white/90 opacity-0 shadow-[0_0_0_1px_rgb(0_0_0/0.3)] transition-opacity group-hover/clip:opacity-100', selected && 'opacity-100')} />
          </div>
        </>
      )}

      {aiRecent && <div key={aiAt} className="ai-sweep pointer-events-none absolute inset-0" />}
    </div>
  )
})

// ─── Bodies ──────────────────────────────────────────────────────────────

/**
 * The stretch of a clip worth drawing — clip-local pixels near the screen. Clips
 * fully inside the window never re-render while scrolling; long ones re-render a
 * few times per screen width as the window steps along.
 */
function useClipWindow(left: number, width: number): [number, number] {
  const x0 = useViewport((s) => clamp(Math.floor((s.scrollLeft - OVERSCAN) / QUANTUM) * QUANTUM - left, 0, width))
  const x1 = useViewport((s) => clamp(Math.ceil((s.scrollLeft + Math.max(s.width, 1) + OVERSCAN) / QUANTUM) * QUANTUM - left, 0, width))
  return [x0, x1]
}

function ClipBody({ clip, asset, inPoint, duration, left, width, height }: { clip: Clip; asset?: Asset; inPoint: number; duration: number; left: number; width: number; height: number }) {
  const [x0, x1] = useClipWindow(left, width)
  const timing = useMemo<Timed>(
    () => ({ speed: clip.speed, duration, inPoint, reverse: clip.reverse, freeze: clip.freeze, keyframes: clip.keyframes }),
    [clip.speed, duration, inPoint, clip.reverse, clip.freeze, clip.keyframes],
  )
  const { fps } = useLayout()
  // Music with a beat grid shows its beats (clip-local frames, following trims and speed).
  const grid = asset?.beats
  const beats = useMemo(
    () => (grid && asset ? clipBeats({ assets: { [asset.id]: asset }, settings: { width: 0, height: 0, fps, background: '' } }, { ...clip, start: 0, duration, inPoint }).map((b) => ({ frame: b.frame, down: b.down })) : undefined),
    [grid, asset, clip, duration, inPoint, fps],
  )
  switch (clip.kind) {
    case 'video':
    case 'image': {
      const strip = clip.kind === 'video' && asset?.hasAudio && !clip.audio.detached && !clip.freeze && height >= 56 ? 15 : 0
      return (
        <>
          {asset && x1 > x0 && <FilmCanvas asset={asset} timing={timing} x0={x0} x1={x1} height={height - strip} />}
          <div className="absolute inset-x-0 top-0 h-6 bg-gradient-to-b from-black/60 to-transparent" />
          <div className="absolute inset-x-0 top-0 h-[2px] opacity-90" style={{ background: 'var(--clip)' }} />
          {strip > 0 && asset && (
            <div className="absolute inset-x-0 bottom-0 border-t border-black/40 bg-[color-mix(in_oklab,var(--clip)_22%,#10110e)]" style={{ height: strip }}>
              {x1 > x0 && <WaveCanvas asset={asset} timing={timing} x0={x0} x1={x1} height={strip - 1} gain={dbToGain(clip.audio.volume)} color={`color-mix(in oklab, ${CLIP_COLOR[clip.kind]} 70%, white)`} />}
            </div>
          )}
        </>
      )
    }
    case 'audio':
      return asset ? (
        <div className="absolute inset-x-0 top-[14px] bottom-[2px]">
          {x1 > x0 && (
            <WaveCanvas
              asset={asset}
              timing={timing}
              x0={x0}
              x1={x1}
              height={Math.max(4, height - 16)}
              gain={dbToGain(clip.audio.volume)}
              fadeIn={clip.audio.fadeIn}
              fadeOut={clip.audio.fadeOut}
              color={`color-mix(in oklab, ${CLIP_COLOR[clip.kind]} 82%, white)`}
              beats={beats}
            />
          )}
        </div>
      ) : null
    case 'text':
      return (
        <div className="absolute inset-0 bg-[linear-gradient(180deg,color-mix(in_oklab,var(--clip)_42%,#16140f),color-mix(in_oklab,var(--clip)_26%,#121110))]">
          <div className="absolute inset-x-0 top-0 h-[2px]" style={{ background: 'var(--clip)' }} />
        </div>
      )
    case 'adjustment':
      return (
        <div className="absolute inset-0 bg-[repeating-linear-gradient(135deg,color-mix(in_oklab,var(--clip)_30%,#141015)_0_7px,color-mix(in_oklab,var(--clip)_20%,#121014)_7px_14px)]">
          <div className="absolute inset-x-0 top-0 h-[2px]" style={{ background: 'var(--clip)' }} />
        </div>
      )
  }
}

function ClipLabel({ clip, asset, nested }: { clip: Clip; asset?: Asset; nested?: Sequence }) {
  const Icon = nested?.multicam ? Video : clip.sequenceId ? Layers : clip.kind === 'video' ? Film : clip.kind === 'image' ? ImageIcon : clip.kind === 'audio' ? AudioLines : clip.kind === 'text' ? Type : Blend
  const text = clip.kind === 'text' ? clip.text?.content.replace(/\n/g, ' · ') : clip.name
  const angles = nested?.multicam ? angleTracks(nested) : []
  const angle = angles.findIndex((t) => t.id === clip.angle)
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 flex h-[18px] min-w-0 items-center gap-1 px-1.5 pt-px text-[11px] leading-none font-medium text-white [text-shadow:0_1px_2px_rgb(0_0_0/0.7)]">
      <Icon className="size-3 shrink-0 opacity-80" />
      {angles.length > 0 && (
        <span className="shrink-0 rounded bg-white px-1 py-px text-[9.5px] font-bold text-black tabular [text-shadow:none]" title={angles[Math.max(0, angle)]?.name}>
          {Math.max(0, angle) + 1}
        </span>
      )}
      <span className="min-w-0 truncate">{text}</span>
      {clip.groupId && <Link2 className="size-3 shrink-0 opacity-80" aria-label="Linked" />}
      {(clip.follow || clip.masks?.some((m) => m.follow)) && <Crosshair className="size-3 shrink-0 opacity-80" aria-label="Tracked" />}
      {clip.stabilize && <Move className="size-3 shrink-0 opacity-80" aria-label="Stabilized" />}
      {clip.freeze ? (
        <span className="ml-0.5 flex shrink-0 items-center gap-0.5 rounded bg-black/40 px-1 py-px text-[9.5px] font-semibold">
          <Snowflake className="size-2.5" />
          Freeze
        </span>
      ) : (
        (clip.speed !== 1 || isRamped(clip)) && (
          <span className="ml-0.5 flex shrink-0 items-center gap-0.5 rounded bg-black/40 px-1 py-px text-[9.5px] font-semibold tabular">
            <Gauge className="size-2.5" />
            {isRamped(clip) ? 'Ramp' : `${clip.speed}×`}
          </span>
        )
      )}
      {clip.effects.length > 0 && (
        <span className="flex shrink-0 items-center gap-0.5 rounded bg-black/40 px-1 py-px text-[9.5px] font-semibold">
          <Sparkles className="size-2.5" />
          {clip.effects.length}
        </span>
      )}
      {asset?.generated && <span className="shrink-0 rounded bg-ai px-1 py-px text-[9px] font-bold text-accent-fg [text-shadow:none]">AI</span>}
    </div>
  )
}

/**
 * A nested timeline: a miniature of what's inside — its clips as bars, one row
 * per track, for the stretch this clip shows.
 */
function NestBody({ clip, seq, inPoint, duration, width, height }: { clip: Clip; seq?: Sequence; inPoint: number; duration: number; width: number; height: number }) {
  const { fps } = useLayout()
  const bars = useMemo(() => {
    if (!seq) return []
    // Visible stretch of the nested timeline, in its own frames.
    const k = seq.settings.fps / fps
    const a = inPoint * k
    const b = (inPoint + duration) * k
    const rows = seq.tracks.filter((t) => (seq.multicam ? t.kind === 'video' : true))
    return rows.flatMap((t, row) =>
      Object.values(seq.clips)
        .filter((c) => c.trackId === t.id && c.start < b && c.start + c.duration > a)
        .map((c) => ({
          id: c.id,
          row,
          rows: rows.length,
          left: ((Math.max(a, c.start) - a) / (b - a)) * 100,
          width: ((Math.min(b, c.start + c.duration) - Math.max(a, c.start)) / (b - a)) * 100,
          color: CLIP_COLOR[c.kind],
          active: seq.multicam ? t.id === clip.angle || (!clip.angle && row === 0) : true,
        })),
    )
  }, [seq, inPoint, duration, fps, clip.angle])
  const top = 20
  const usable = Math.max(8, height - top - 4)
  return (
    <div className="absolute inset-0 bg-[linear-gradient(180deg,color-mix(in_oklab,var(--clip)_30%,#12110f),color-mix(in_oklab,var(--clip)_14%,#0f0f0d))]">
      <div className="absolute inset-x-0 top-0 h-[2px]" style={{ background: 'var(--clip)' }} />
      {!seq && <div className="absolute inset-x-0 top-5 px-1.5 text-[10px] text-danger">Timeline missing</div>}
      {width > 30 &&
        bars.map((bar) => {
          const h = Math.max(2, Math.min(7, usable / bar.rows - 2))
          return (
            <span
              key={bar.id}
              className="absolute rounded-[2px]"
              style={{
                left: `${bar.left}%`,
                width: `max(2px, ${bar.width}%)`,
                top: top + bar.row * (h + 2),
                height: h,
                background: bar.color,
                opacity: bar.active ? 0.85 : 0.28,
              }}
            />
          )
        })}
    </div>
  )
}

// ─── Filmstrip ───────────────────────────────────────────────────────────

/** Re-renders when a still this asset shows becomes ready (posters, photos, sequence frames). */
function useThumbTick(asset: Asset) {
  const [tick, setTick] = useState(0)
  const prefix = asset.source.type === 'sequence' ? asset.source.base : asset.source.type === 'file' ? (asset.kind === 'image' ? asset.source.url : (asset.source.poster ?? '')) : ''
  useEffect(() => (prefix ? onThumb((url) => url.startsWith(prefix) && setTick((t) => t + 1)) : undefined), [prefix])
  return tick
}

/** What a strip canvas shows: the zoom and clip-local stretch it was painted at, and everything else that went into it. */
interface Painted {
  pps: number
  x0: number
  x1: number
  inputs: unknown[]
}

/**
 * Paints a strip canvas whenever what it shows changes, except in the middle of
 * a zoom gesture: then the canvas is stretched to the new zoom (no drawing, no
 * new pixels for the GPU) and painted properly when the gesture settles. The
 * painter sizes the canvas (in steps, so zooming reuses it); this places it.
 */
function useStripPaint(ref: RefObject<HTMLCanvasElement | null>, pps: number, x0: number, x1: number, inputs: unknown[], paint: (canvas: HTMLCanvasElement) => void) {
  const painted = useRef<Painted | null>(null)
  const zooming = useViewport((s) => s.zooming)
  useLayoutEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const last = painted.current
    const same = last !== null && last.inputs.length === inputs.length && last.inputs.every((v, i) => Object.is(v, inputs[i]))
    if (same && last.pps === pps && last.x0 === x0 && last.x1 === x1) return
    // Clips coming into view mid-zoom draw when it settles.
    if (zooming && last === null) return
    if (same && zooming && last.pps !== pps) {
      const r = pps / last.pps
      canvas.style.left = `${last.x0 * r}px`
      canvas.style.transform = `scaleX(${r})`
      return
    }
    canvas.style.left = `${x0}px`
    canvas.style.transform = ''
    paint(canvas)
    painted.current = { pps, x0, x1, inputs }
  })
}

function FilmCanvas({ asset, timing, x0, x1, height }: { asset: Asset; timing: Timed; x0: number; x1: number; height: number }) {
  const { fps, pps } = useLayout()
  const ref = useRef<HTMLCanvasElement>(null)
  const strip = useFilmstrip(asset)
  const progress = strip ? strip.frames.reduce((n, f) => n + (f ? 1 : 0), 0) : 0
  const thumbs = useThumbTick(asset)
  useStripPaint(ref, pps, x0, x1, [asset, timing, fps, height, strip, progress, thumbs], (canvas) => paintFilm(canvas, { asset, timing, fps, pps, x0, x1, height, strip }))
  return <canvas ref={ref} className="pointer-events-none absolute top-0 left-0 origin-top-left" />
}

// ─── Waveform ────────────────────────────────────────────────────────────

interface WaveCanvasProps {
  asset: Asset
  /** Where the clip's frames come from in the source — speed ramps and reverse included. */
  timing: Timed
  x0: number
  x1: number
  height: number
  gain: number
  fadeIn?: number
  fadeOut?: number
  /** Any CSS colour: theme variables and color-mix are fine. */
  color: string
  beats?: { frame: number; down: boolean }[]
}

function WaveCanvas({ asset, timing, x0, x1, height, gain, fadeIn = 0, fadeOut = 0, color, beats }: WaveCanvasProps) {
  const { fps, pps } = useLayout()
  const ref = useRef<HTMLCanvasElement>(null)
  const peaks = getPeaks(asset)
  useStripPaint(ref, pps, x0, x1, [peaks, timing, fps, height, gain, fadeIn, fadeOut, color, beats], (canvas) => {
    if (peaks) paintWave(canvas, { peaks, timing, fps, pps, x0, x1, height, gain, fadeIn, fadeOut, color: cssColor(color), beats })
  })
  if (!peaks) return null
  return <canvas ref={ref} aria-hidden className="pointer-events-none absolute top-0 left-0 origin-top-left" />
}

// ─── Fades & keyframes ───────────────────────────────────────────────────

function Fades({ clip, width, height }: { clip: Clip; width: number; height: number }) {
  const { fps, pps } = useLayout()
  const fin = (clip.audio.fadeIn / fps) * pps
  const fout = (clip.audio.fadeOut / fps) * pps
  return (
    <>
      <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
        {fin > 1 && <polygon points={`0,0 ${fin},0 0,${height}`} className="fill-black/35" />}
        {fin > 1 && <line x1="0" y1={height} x2={fin} y2="0" className="stroke-white/50" strokeWidth={1} />}
        {fout > 1 && <polygon points={`${width - fout},0 ${width},0 ${width},${height}`} className="fill-black/35" />}
        {fout > 1 && <line x1={width - fout} y1="0" x2={width} y2={height} className="stroke-white/50" strokeWidth={1} />}
      </svg>
      {width > 40 && (
        <>
          <div data-handle="fade-in" className="absolute top-[3px] z-20 size-2.5 -translate-x-1/2 cursor-ew-resize rounded-full bg-white opacity-0 shadow-[0_0_0_1.5px_rgb(0_0_0/0.35)] transition-opacity group-hover/clip:opacity-100" style={{ left: Math.max(7, fin) }} />
          <div data-handle="fade-out" className="absolute top-[3px] z-20 size-2.5 translate-x-1/2 cursor-ew-resize rounded-full bg-white opacity-0 shadow-[0_0_0_1.5px_rgb(0_0_0/0.35)] transition-opacity group-hover/clip:opacity-100" style={{ right: Math.max(7, fout) }} />
        </>
      )}
    </>
  )
}

/** Keyframes on the selected clip: drag one to retime it (every property keyed there moves), click to go to it. */
function KeyframeDiamonds({ clip, duration, width }: { clip: Clip; duration: number; width: number }) {
  const frames = allKeyframeFrames(clip)
  const drag = useDrag((s) => (s.keyDrag?.clipId === clip.id ? s.keyDrag : null))
  if (!frames.length) return null
  const x = (f: number) => clamp((f / duration) * width, 4, width - 4)
  return (
    <>
      {frames.map((f) => (
        <span
          key={f}
          data-handle="keyframe"
          data-frame={f}
          title="Drag to retime · click to go to it"
          className={cn(
            'absolute bottom-[1px] z-[13] grid size-[13px] -translate-x-1/2 cursor-ew-resize place-items-center',
            drag?.from === f && 'opacity-30',
          )}
          style={{ left: x(f) }}
        >
          <span className="size-[7px] rotate-45 bg-white shadow-[0_0_0_1px_rgb(0_0_0/0.45)] transition-transform hover:scale-125" />
        </span>
      ))}
      {drag && drag.to !== drag.from && (
        <span className="pointer-events-none absolute bottom-[4px] z-[14] size-[8px] -translate-x-1/2 rotate-45 bg-accent shadow-[0_0_0_1px_rgb(0_0_0/0.5)]" style={{ left: x(drag.to) }} />
      )}
    </>
  )
}
