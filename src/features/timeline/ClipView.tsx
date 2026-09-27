import { AudioLines, Blend, Crosshair, Film, Gauge, Image as ImageIcon, Layers, Link2, Move, Snowflake, Sparkles, Type, Video } from 'lucide-react'
import { memo, useMemo } from 'react'
import { PEAKS_PER_SECOND } from '@/editor/defaults'
import { allKeyframeFrames } from '@/editor/keyframes'
import { angleTracks } from '@/editor/sequences'
import { useEditor } from '@/editor/store'
import { openTimeline } from '@/editor/timeline-nav'
import { isRamped, sourceFrameAt, type Timed } from '@/editor/timing'
import type { Asset, Clip, Sequence } from '@/editor/types'
import { useUI } from '@/editor/ui-store'
import { getPeaks } from '@/engine/audio'
import { sequenceFrameUrl } from '@/engine/media'
import { FrameCanvas, stripFrame, useFilmstrip } from '@/features/assets/frames'
import { cn } from '@/lib/cn'
import { clamp } from '@/lib/math'
import { useLayout } from './layout'
import { CLIP_COLOR, dbToGain, useDrag } from './model'

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
        <ClipBody clip={clip} asset={asset} inPoint={inPoint} duration={duration} width={width} height={height} />
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

function ClipBody({ clip, asset, inPoint, duration, width, height }: { clip: Clip; asset?: Asset; inPoint: number; duration: number; width: number; height: number }) {
  const { fps, pps } = useLayout()
  const timing: Timed = { speed: clip.speed, duration, inPoint, reverse: clip.reverse, freeze: clip.freeze, keyframes: clip.keyframes }
  switch (clip.kind) {
    case 'video':
    case 'image': {
      const strip = clip.kind === 'video' && asset?.hasAudio && !clip.audio.detached && !clip.freeze && height >= 56 ? 15 : 0
      return (
        <>
          {asset && <Filmstrip asset={asset} timing={timing} fps={fps} pps={pps} width={width} height={height - strip} />}
          <div className="absolute inset-x-0 top-0 h-6 bg-gradient-to-b from-black/60 to-transparent" />
          <div className="absolute inset-x-0 top-0 h-[2px] opacity-90" style={{ background: 'var(--clip)' }} />
          {strip > 0 && asset && (
            <div className="absolute inset-x-0 bottom-0 border-t border-black/40 bg-[color-mix(in_oklab,var(--clip)_22%,#10110e)]" style={{ height: strip }}>
              <Waveform asset={asset} timing={timing} width={width} gain={dbToGain(clip.audio.volume)} color="color-mix(in oklab, var(--clip) 70%, white)" />
            </div>
          )}
        </>
      )
    }
    case 'audio':
      return asset ? (
        <div className="absolute inset-x-0 top-[14px] bottom-[2px]">
          <Waveform
            asset={asset}
            timing={timing}
            width={width}
            gain={dbToGain(clip.audio.volume)}
            fadeIn={clip.audio.fadeIn}
            fadeOut={clip.audio.fadeOut}
            color="color-mix(in oklab, var(--clip) 82%, white)"
          />
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

/** A still for a source time: an image sequence frame, or the file's image / poster. */
function stillAt(asset: Asset, seconds: number): string | undefined {
  const src = asset.source
  if (src.type === 'file') return asset.kind === 'image' ? src.url : src.poster
  if (src.type === 'sequence') return sequenceFrameUrl(src, Math.floor(seconds * src.fps))
  return undefined
}

function Filmstrip({ asset, timing, fps, pps, width, height }: { asset: Asset; timing: Timed; fps: number; pps: number; width: number; height: number }) {
  const tileW = Math.max(36, Math.round(height * 1.6))
  const count = Math.min(200, Math.max(1, Math.ceil(width / tileW)))
  const strip = useFilmstrip(asset)
  const tiles: { frame: ImageBitmap | null; url?: string }[] = []
  for (let i = 0; i < count; i++) {
    const xMid = i * tileW + tileW / 2
    const t = Math.max(0, sourceFrameAt(timing, Math.min(timing.duration, (xMid / pps) * fps)) / fps)
    const frame = stripFrame(strip, t)
    tiles.push({ frame, url: frame ? undefined : stillAt(asset, Math.round(t * 2) / 2) })
  }
  return (
    <div className="absolute inset-x-0 top-0 flex overflow-hidden" style={{ height }}>
      {tiles.map((tile, i) => (
        <div key={i} className="h-full shrink-0 border-r border-black/35 bg-cover bg-center" style={{ width: tileW, backgroundImage: tile.url ? `url(${tile.url})` : undefined }}>
          {tile.frame && <FrameCanvas frame={tile.frame} />}
        </div>
      ))}
    </div>
  )
}

// ─── Waveform ────────────────────────────────────────────────────────────

interface WaveformProps {
  asset: Asset
  /** Where the clip's frames come from in the source — speed ramps and reverse included. */
  timing: Timed
  width: number
  gain: number
  fadeIn?: number
  fadeOut?: number
  color: string
}

export function Waveform({ asset, timing, width, gain, fadeIn = 0, fadeOut = 0, color }: WaveformProps) {
  const { fps } = useLayout()
  const { speed, duration, inPoint, reverse, freeze, keyframes } = timing
  const path = useMemo(() => {
    const peaks = getPeaks(asset)
    if (!peaks) return ''
    const n = clamp(Math.floor(width / 2.2), 8, 1600)
    const t = { speed, duration, inPoint, reverse, freeze, keyframes }
    const peakAt = (local: number) => (sourceFrameAt(t, local) / fps) * PEAKS_PER_SECOND
    const amps: number[] = []
    for (let j = 0; j <= n; j++) {
      const x = peakAt((j / n) * duration)
      const y = peakAt(((j + 1) / n) * duration)
      const a = Math.floor(Math.min(x, y))
      const b = Math.max(a + 1, Math.floor(Math.max(x, y)))
      let peak = 0
      for (let k = a; k < b && k < peaks.length; k++) peak = Math.max(peak, peaks[k] ?? 0)
      const local = (j / n) * duration
      let env = 1
      if (fadeIn > 0 && local < fadeIn) env *= local / fadeIn
      if (fadeOut > 0 && duration - local < fadeOut) env *= (duration - local) / fadeOut
      amps.push(Math.min(1, Math.max(0.015, peak * gain * env)))
    }
    let d = `M0 50`
    amps.forEach((a, j) => (d += `L${j} ${(50 - a * 47).toFixed(1)}`))
    for (let j = amps.length - 1; j >= 0; j--) d += `L${j} ${(50 + amps[j] * 47).toFixed(1)}`
    return `${d}Z`
  }, [asset, inPoint, duration, speed, reverse, freeze, keyframes, width, gain, fadeIn, fadeOut, fps])

  if (!path) return null
  return (
    <svg className="absolute inset-0 h-full w-full" viewBox={`0 0 ${clamp(Math.floor(width / 2.2), 8, 1600)} 100`} preserveAspectRatio="none" aria-hidden>
      <path d={path} fill={color} />
    </svg>
  )
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

function KeyframeDiamonds({ clip, duration, width }: { clip: Clip; duration: number; width: number }) {
  const frames = allKeyframeFrames(clip)
  if (!frames.length) return null
  return (
    <>
      {frames.map((f) => (
        <span
          key={f}
          className="pointer-events-none absolute bottom-[4px] z-10 size-[7px] -translate-x-1/2 rotate-45 bg-white shadow-[0_0_0_1px_rgb(0_0_0/0.45)]"
          style={{ left: clamp((f / duration) * width, 4, width - 4) }}
        />
      ))}
    </>
  )
}
