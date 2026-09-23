import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { create } from 'zustand'
import { FONTS } from '@/editor/defaults'
import { setAnimatable } from '@/editor/edit'
import { clipEnd } from '@/editor/ops'
import { usePlayback } from '@/editor/playback'
import { getProject, useEditor } from '@/editor/store'
import { useUI } from '@/editor/ui-store'
import { renderFrame, type ClipBounds } from '@/engine/compositor'
import { onMediaReady } from '@/engine/media'
import { useElementSize } from '@/lib/hooks'
import { cn } from '@/lib/cn'

/** On-screen bounds of visible clips; re-published only when a selected clip's box changes. */
export const useBounds = create<{ bounds: Map<string, ClipBounds> }>(() => ({ bounds: new Map() }))
/** Always-fresh bounds from the last draw, for hit-testing without re-renders. */
const latestBounds = { current: new Map<string, ClipBounds>() }

const quality = { full: 1, half: 0.5 }

export function PreviewStage({ q = 'full' }: { q?: keyof typeof quality }) {
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { width: sw, height: sh } = useElementSize(stageRef)
  const pw = useEditor((s) => s.project.settings.width)
  const ph = useEditor((s) => s.project.settings.height)
  const showGuides = useUI((s) => s.showGuides)

  // Fit the frame inside the stage with breathing room.
  const pad = 20
  const scale = Math.max(0.01, Math.min((sw - pad * 2) / pw, (sh - pad * 2) / ph))
  const fw = Math.max(0, Math.floor(pw * scale))
  const fh = Math.max(0, Math.floor(ph * scale))

  // Render loop: coalesce every trigger into one draw per animation frame.
  const needsRender = useRef(true)
  const raf = useRef(0)
  const requestRender = useRef(() => {})
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !fw || !fh) return
    const dpr = Math.min(2, window.devicePixelRatio || 1) * quality[q]
    canvas.width = Math.max(1, Math.round(fw * dpr))
    canvas.height = Math.max(1, Math.round(fh * dpr))
    const ctx = canvas.getContext('2d', { alpha: false })!
    const draw = () => {
      raf.current = 0
      if (!needsRender.current) return
      needsRender.current = false
      const { bounds } = renderFrame(ctx, getProject(), usePlayback.getState().frame)
      latestBounds.current = bounds
      const prev = useBounds.getState().bounds
      const sel = useUI.getState().selection
      if (sel.some((id) => JSON.stringify(prev.get(id)) !== JSON.stringify(bounds.get(id)))) useBounds.setState({ bounds })
    }
    requestRender.current = () => {
      needsRender.current = true
      if (!raf.current) raf.current = requestAnimationFrame(draw)
    }
    requestRender.current()
    return () => {
      cancelAnimationFrame(raf.current)
      raf.current = 0
    }
  }, [fw, fh, q])

  useEffect(() => {
    const req = () => requestRender.current()
    const unsubs = [
      usePlayback.subscribe((s, p) => s.frame !== p.frame && req()),
      useEditor.subscribe((s, p) => s.project !== p.project && req()),
      useUI.subscribe((s, p) => s.selection !== p.selection && req()),
      onMediaReady(req),
    ]
    // Canvas text needs the web fonts actually loaded before the first draw;
    // faces that load lazily later (italics, heavier weights) trigger a redraw too.
    void Promise.all(Object.values(FONTS).map((f) => document.fonts.load(`400 48px ${f.css}`))).then(req)
    document.fonts.addEventListener('loadingdone', req)
    return () => {
      unsubs.forEach((u) => u())
      document.fonts.removeEventListener('loadingdone', req)
    }
  }, [])

  return (
    <div ref={stageRef} className="relative min-h-0 flex-1 overflow-hidden bg-[radial-gradient(ellipse_at_center,rgb(255_255_255/0.025),transparent_70%)]">
      <div
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-[3px] bg-black shadow-[0_0_0_1px_rgb(255_255_255/0.06),0_24px_70px_-18px_rgb(0_0_0/0.95)]"
        style={{ width: fw, height: fh }}
      >
        <canvas ref={canvasRef} className="block h-full w-full rounded-[3px]" style={{ width: fw, height: fh }} />
        {showGuides && <SafeGuides />}
        <Gizmo scale={scale} />
      </div>
    </div>
  )
}

function SafeGuides() {
  return (
    <div className="pointer-events-none absolute inset-0">
      <div className="absolute inset-[3.5%] rounded-[2px] border border-dashed border-white/25" />
      <div className="absolute inset-[10%] rounded-[2px] border border-dashed border-white/15" />
      <div className="absolute top-0 bottom-0 left-1/2 w-px bg-white/15" />
      <div className="absolute top-1/2 right-0 left-0 h-px bg-white/15" />
    </div>
  )
}

// ─── Transform gizmo ─────────────────────────────────────────────────────

type Handle = 'move' | 'nw' | 'ne' | 'sw' | 'se' | 'rotate'

function Gizmo({ scale }: { scale: number }) {
  const selection = useUI((s) => s.selection)
  const playing = usePlayback((s) => s.playing)
  const frame = usePlayback((s) => s.frame)
  const bounds = useBounds((s) => s.bounds)
  const clipId = selection.length === 1 ? selection[0] : null
  const clip = useEditor((s) => (clipId ? s.project.clips[clipId] : undefined))
  const pw = useEditor((s) => s.project.settings.width)
  const ph = useEditor((s) => s.project.settings.height)
  const [guides, setGuides] = useState<{ v: boolean; h: boolean }>({ v: false, h: false })

  const b = clipId ? bounds.get(clipId) : undefined
  const active = clip && frame >= clip.start && frame < clipEnd(clip) && clip.kind !== 'audio' && clip.kind !== 'adjustment'

  const onCanvasPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // Click-to-select: pick the top-most visible clip under the pointer.
    if (e.target !== e.currentTarget) return
    const r = e.currentTarget.getBoundingClientRect()
    const x = (e.clientX - r.left) / scale
    const y = (e.clientY - r.top) / scale
    const hits = [...latestBounds.current.entries()].filter(([id, bb]) => {
      const c = getProject().clips[id]
      if (!c || c.kind === 'adjustment') return false
      const a = (-bb.rotation * Math.PI) / 180
      const dx = x - bb.cx
      const dy = y - bb.cy
      const lx = dx * Math.cos(a) - dy * Math.sin(a)
      const ly = dx * Math.sin(a) + dy * Math.cos(a)
      return Math.abs(lx) <= bb.w / 2 && Math.abs(ly) <= bb.h / 2
    })
    const top = hits[hits.length - 1]
    if (top) {
      useUI.getState().select([top[0]])
      useUI.getState().setRightTab('inspector')
    } else useUI.getState().clearSelection()
  }

  const startDrag = (e: ReactPointerEvent, handle: Handle) => {
    if (!clip || !b) return
    e.stopPropagation()
    e.preventDefault()
    const frameEl = (e.currentTarget as HTMLElement).closest('[data-gizmo-root]') as HTMLElement
    const r = frameEl.getBoundingClientRect()
    const toProject = (cx: number, cy: number) => ({ x: (cx - r.left) / scale, y: (cy - r.top) / scale })
    const p0 = toProject(e.clientX, e.clientY)
    const start = { x: clip.transform.x, y: clip.transform.y, scale: clip.transform.scale, rotation: clip.transform.rotation }
    const center = { x: b.cx, y: b.cy }
    const key = `gizmo:${clip.id}:${handle}:${Date.now()}`
    const move = (ev: PointerEvent) => {
      const p = toProject(ev.clientX, ev.clientY)
      if (handle === 'move') {
        let nx = start.x + (p.x - p0.x)
        let ny = start.y + (p.y - p0.y)
        const snap = 10 / scale
        const v = !ev.altKey && Math.abs(nx) < snap
        const h = !ev.altKey && Math.abs(ny) < snap
        if (v) nx = 0
        if (h) ny = 0
        setGuides({ v, h })
        // Same coalesce key for both axes → the whole drag is one undo step.
        setAnimatable(clip.id, 'x', Math.round(nx), key)
        setAnimatable(clip.id, 'y', Math.round(ny), key)
      } else if (handle === 'rotate') {
        const a0 = Math.atan2(p0.y - center.y, p0.x - center.x)
        const a1 = Math.atan2(p.y - center.y, p.x - center.x)
        let deg = start.rotation + ((a1 - a0) * 180) / Math.PI
        if (ev.shiftKey) deg = Math.round(deg / 15) * 15
        setAnimatable(clip.id, 'rotation', Math.round(deg * 10) / 10, key)
      } else {
        const d0 = Math.hypot(p0.x - center.x, p0.y - center.y)
        const d1 = Math.hypot(p.x - center.x, p.y - center.y)
        const s = Math.max(0.05, start.scale * (d1 / Math.max(1, d0)))
        setAnimatable(clip.id, 'scale', Math.round(s * 1000) / 1000, key)
      }
    }
    const up = () => {
      setGuides({ v: false, h: false })
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div data-gizmo-root className="absolute inset-0" onPointerDown={onCanvasPointerDown}>
      {guides.v && <div className="pointer-events-none absolute top-0 bottom-0 left-1/2 w-px bg-accent-2 shadow-[0_0_6px_var(--color-accent)]" />}
      {guides.h && <div className="pointer-events-none absolute top-1/2 right-0 left-0 h-px bg-accent-2 shadow-[0_0_6px_var(--color-accent)]" />}
      {active && b && !playing && (
        <div
          className="absolute cursor-move"
          onPointerDown={(e) => startDrag(e, 'move')}
          style={{
            left: (b.cx - b.w / 2) * scale,
            top: (b.cy - b.h / 2) * scale,
            width: b.w * scale,
            height: b.h * scale,
            transform: `rotate(${b.rotation}deg)`,
          }}
        >
          <div className="pointer-events-none absolute inset-0 rounded-[2px] shadow-[0_0_0_1.5px_var(--color-accent),0_0_0_4px_rgb(214_238_0/0.18)]" />
          {(['nw', 'ne', 'sw', 'se'] as const).map((h) => (
            <span
              key={h}
              onPointerDown={(e) => startDrag(e, h)}
              className={cn(
                'absolute size-2.5 rounded-[3px] border-[1.5px] border-accent bg-white shadow-[0_1px_4px_rgb(0_0_0/0.5)]',
                h === 'nw' && '-top-[5px] -left-[5px] cursor-nwse-resize',
                h === 'ne' && '-top-[5px] -right-[5px] cursor-nesw-resize',
                h === 'sw' && '-bottom-[5px] -left-[5px] cursor-nesw-resize',
                h === 'se' && '-right-[5px] -bottom-[5px] cursor-nwse-resize',
              )}
            />
          ))}
          <span className="pointer-events-none absolute -top-6 left-1/2 h-6 w-px -translate-x-1/2 bg-accent/70" />
          <span
            onPointerDown={(e) => startDrag(e, 'rotate')}
            className="absolute -top-[30px] left-1/2 size-3 -translate-x-1/2 cursor-grab rounded-full border-[1.5px] border-accent bg-white shadow-[0_1px_4px_rgb(0_0_0/0.5)]"
          />
        </div>
      )}
      {/* project-size hint for screen readers */}
      <span className="sr-only">
        Canvas {pw} by {ph}
      </span>
    </div>
  )
}
