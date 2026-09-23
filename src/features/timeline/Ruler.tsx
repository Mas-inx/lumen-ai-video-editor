import { useEffect, useRef, useState } from 'react'
import { ContextMenu } from 'radix-ui'
import { Trash } from 'lucide-react'
import { projectDuration } from '@/editor/ops'
import { playback, usePlayback } from '@/editor/playback'
import { dispatch, useEditor } from '@/editor/store'
import type { Marker } from '@/editor/types'
import { parseTimecode, formatTimecode } from '@/lib/time'
import { Tip } from '@/components/ui/tooltip'
import { useLayout } from './layout'
import { HEADER_W, RULER_H } from './model'

export const MARKER_COLORS: Record<Marker['color'], string> = {
  lime: '#d6ee00',
  violet: '#8b7bff',
  pink: '#f472b6',
  amber: '#f5b73b',
  emerald: '#3ccf91',
  sky: '#38bdf8',
}

const pad = (n: number) => String(n).padStart(2, '0')

function label(sec: number, major: number, fps: number) {
  const whole = Math.floor(sec + 1e-6)
  const m = Math.floor(whole / 60)
  const s = whole % 60
  if (major >= 1) return `${m}:${pad(s)}`
  const f = Math.round((sec - whole) * fps)
  return f === 0 ? `${m}:${pad(s)}` : `${pad(f)}f`
}

export function Ruler({ width, laneViewport, scrollLeft }: { width: number; laneViewport: number; scrollLeft: number }) {
  const { pps, fps } = useLayout()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const markers = useEditor((s) => s.project.markers)
  const end = useEditor((s) => projectDuration(s.project))

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || laneViewport <= 0) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(laneViewport * dpr)
    canvas.height = Math.round(RULER_H * dpr)
    const ctx = canvas.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, laneViewport, RULER_H)

    const frame = 1 / fps
    const steps = [frame, 2 * frame, 5 * frame, 10 * frame, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800]
    const major = steps.find((s) => s * pps >= 80) ?? 1800
    const divisions = major * pps >= 160 ? 10 : 5
    const minor = Math.max(frame, major / divisions)

    // Past-the-end shading
    const endX = (end / fps) * pps - scrollLeft
    if (endX < laneViewport) {
      ctx.fillStyle = 'rgba(0,0,0,0.22)'
      ctx.fillRect(Math.max(0, endX), 0, laneViewport - Math.max(0, endX), RULER_H)
    }

    const startSec = Math.max(0, Math.floor(scrollLeft / pps / minor) * minor)
    const endSec = (scrollLeft + laneViewport) / pps
    ctx.font = '500 10px "Geist Mono Variable", ui-monospace, monospace'
    ctx.textBaseline = 'alphabetic'
    for (let t = startSec; t <= endSec + minor; t += minor) {
      const x = Math.round(t * pps - scrollLeft) + 0.5
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-4
      const mid = !isMajor && Math.abs((t * 2) / major - Math.round((t * 2) / major)) < 1e-4
      ctx.fillStyle = isMajor ? 'rgba(255,255,255,0.34)' : mid ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.11)'
      const h = isMajor ? 10 : mid ? 7 : 4
      ctx.fillRect(x - 0.5, RULER_H - h, 1, h)
      if (isMajor) {
        ctx.fillStyle = '#7d7d88'
        ctx.fillText(label(t, major, fps), x + 5, 13)
      }
    }
  }, [pps, fps, laneViewport, scrollLeft, end])

  return (
    <div data-ruler className="relative shrink-0 border-b border-line bg-surface" style={{ width, height: RULER_H }}>
      <canvas ref={canvasRef} className="pointer-events-none sticky top-0 block" style={{ left: HEADER_W, width: laneViewport, height: RULER_H }} />
      {markers.map((m) => (
        <MarkerFlag key={m.id} marker={m} x={(m.frame / fps) * pps} />
      ))}
      <PlayheadHandle />
    </div>
  )
}

function MarkerFlag({ marker, x }: { marker: Marker; x: number }) {
  const color = MARKER_COLORS[marker.color]
  return (
    <ContextMenu.Root>
      <Tip content={marker.label} side="top">
        <ContextMenu.Trigger asChild>
          <button
            type="button"
            data-marker={marker.id}
            onPointerDown={(e) => {
              e.stopPropagation()
              playback.pause()
              playback.seek(marker.frame)
            }}
            className="absolute top-[3px] z-10 -translate-x-[1px] outline-none transition-transform hover:scale-110"
            style={{ left: x }}
          >
            <svg width="9" height="12" viewBox="0 0 9 12" aria-hidden>
              <path d="M1 0h6.5a1 1 0 0 1 1 1v6.2a1 1 0 0 1-.37.78L4.75 10.9a.4.4 0 0 1-.5 0L.87 7.98A1 1 0 0 1 .5 7.2V.5A.5.5 0 0 1 1 0Z" fill={color} />
            </svg>
          </button>
        </ContextMenu.Trigger>
      </Tip>
      <ContextMenu.Portal>
        <ContextMenu.Content className="popover z-[100] min-w-[180px] p-1 data-[state=open]:animate-pop-in">
          <div className="px-2 pt-1.5 pb-1 text-2xs font-semibold tracking-wider text-fg-4 uppercase">{marker.label}</div>
          <div className="flex gap-1 px-2 pb-1.5">
            {(Object.keys(MARKER_COLORS) as Marker['color'][]).map((c) => (
              <ContextMenu.Item
                key={c}
                onSelect={() => dispatch('marker.update', { id: marker.id, patch: { color: c } })}
                className="size-4 cursor-default rounded-full outline-none ring-offset-2 ring-offset-surface-2 data-[highlighted]:ring-2 data-[highlighted]:ring-white/60"
                style={{ background: MARKER_COLORS[c] }}
              />
            ))}
          </div>
          <ContextMenu.Item
            onSelect={() => dispatch('marker.remove', { id: marker.id })}
            className="flex h-8 items-center gap-2 rounded-[7px] px-2 text-sm text-danger outline-none data-[highlighted]:bg-white/[0.07]"
          >
            <Trash className="size-4" /> Remove marker
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}

function PlayheadHandle() {
  const { pps, fps } = useLayout()
  const frame = usePlayback((s) => s.frame)
  return (
    <div data-playhead className="absolute top-0 z-20 -translate-x-1/2 cursor-ew-resize px-1" style={{ left: (frame / fps) * pps }}>
      <svg width="13" height="18" viewBox="0 0 13 18" className="drop-shadow-[0_2px_4px_rgb(0_0_0/0.6)]" aria-hidden>
        <path d="M2 1.5h9a1.5 1.5 0 0 1 1.5 1.5v8.2a1.5 1.5 0 0 1-.52 1.14L7.1 16.5a1 1 0 0 1-1.2 0l-4.88-4.16A1.5 1.5 0 0 1 .5 11.2V3A1.5 1.5 0 0 1 2 1.5Z" fill="#fff" />
      </svg>
      <div className="absolute top-[16px] left-1/2 h-[14px] w-[1.5px] -translate-x-1/2 bg-white" />
    </div>
  )
}

/** The timecode readout in the ruler's corner — click to type a time and jump. */
export function TimecodeCell() {
  const frame = usePlayback((s) => s.frame)
  const fps = useEditor((s) => s.project.settings.fps)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  const commit = () => {
    const f = parseTimecode(draft, fps)
    if (f !== null) playback.seek(f)
    setEditing(false)
  }

  return (
    <div className="sticky left-0 z-50 flex shrink-0 items-center border-r border-b border-line bg-surface px-3" style={{ width: HEADER_W, height: RULER_H }}>
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.target.select()}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') setEditing(false)
          }}
          className="h-6 w-full rounded bg-white/[0.07] px-1.5 font-mono text-sm text-fg tabular outline-none ring-1 ring-accent/60"
        />
      ) : (
        <button
          type="button"
          onClick={() => (setDraft(formatTimecode(frame, fps)), setEditing(true))}
          className="flex items-baseline gap-2 rounded px-1 font-mono text-[13px] font-medium tracking-tight text-fg tabular outline-none hover:bg-white/[0.05]"
          title="Click to jump to a timecode"
        >
          {formatTimecode(frame, fps)}
          <span className="font-sans text-2xs font-medium text-fg-4">{fps} fps</span>
        </button>
      )}
    </div>
  )
}
