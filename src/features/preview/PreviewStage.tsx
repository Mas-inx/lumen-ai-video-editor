import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { create } from 'zustand'
import { FONTS } from '@/editor/defaults'
import { setAnimatable } from '@/editor/edit'
import { clipEnd } from '@/editor/ops'
import { usePlayback } from '@/editor/playback'
import { dispatch, getProject, useEditor } from '@/editor/store'
import type { Clip, Crop, Mask } from '@/editor/types'
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

const frameListeners = new Set<(canvas: HTMLCanvasElement) => void>()

/** Called with the program monitor's canvas after every redraw (for the scopes). */
export function onPreviewFrame(fn: (canvas: HTMLCanvasElement) => void) {
  frameListeners.add(fn)
  return () => void frameListeners.delete(fn)
}

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
      for (const fn of frameListeners) fn(canvas)
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
      useUI.subscribe((s, p) => (s.selection !== p.selection || s.useProxies !== p.useProxies) && req()),
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

// ─── Crop gizmo ──────────────────────────────────────────────────────────

type CropHandle = 'l' | 'r' | 't' | 'b' | 'tl' | 'tr' | 'bl' | 'br' | 'move'

const NO_CROP: Crop = { left: 0, right: 0, top: 0, bottom: 0, radius: 0 }

/** Drag the edges, corners or the middle of the crop box over the whole (dimmed) picture. */
function CropGizmo({ clip, b, scale }: { clip: Clip; b: ClipBounds; scale: number }) {
  const full = b.full ?? { cx: b.cx, cy: b.cy, w: b.w, h: b.h }
  const crop = clip.crop ?? NO_CROP
  const box = { left: crop.left * full.w, top: crop.top * full.h, width: (1 - crop.left - crop.right) * full.w, height: (1 - crop.top - crop.bottom) * full.h }

  const startDrag = (e: ReactPointerEvent, handle: CropHandle) => {
    e.stopPropagation()
    e.preventDefault()
    const start = { ...crop }
    const x0 = e.clientX
    const y0 = e.clientY
    const a = (-b.rotation * Math.PI) / 180
    const key = `crop:${clip.id}:${handle}:${Date.now()}`
    const move = (ev: PointerEvent) => {
      // Screen delta → project pixels → the picture's own (unrotated) axes → fractions of it.
      const sx = (ev.clientX - x0) / scale
      const sy = (ev.clientY - y0) / scale
      const fx = (sx * Math.cos(a) - sy * Math.sin(a)) / full.w
      const fy = (sx * Math.sin(a) + sy * Math.cos(a)) / full.h
      const next = { ...start }
      const min = 0.02
      if (handle === 'move') {
        const dx = Math.max(-start.left, Math.min(start.right, fx))
        const dy = Math.max(-start.top, Math.min(start.bottom, fy))
        next.left = start.left + dx
        next.right = start.right - dx
        next.top = start.top + dy
        next.bottom = start.bottom - dy
      } else {
        if (handle.includes('l')) next.left = Math.max(0, Math.min(1 - start.right - min, start.left + fx))
        if (handle.includes('r')) next.right = Math.max(0, Math.min(1 - start.left - min, start.right - fx))
        if (handle.includes('t')) next.top = Math.max(0, Math.min(1 - start.bottom - min, start.top + fy))
        if (handle.includes('b')) next.bottom = Math.max(0, Math.min(1 - start.top - min, start.bottom - fy))
      }
      const r = (v: number) => Math.min(0.95, Math.round(v * 10000) / 10000)
      dispatch('clip.update', { ids: [clip.id], patch: { crop: { left: r(next.left), right: r(next.right), top: r(next.top), bottom: r(next.bottom) } } }, { coalesce: key, label: 'Crop' })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const handle = (h: CropHandle, className: string, cursor: string) => (
    <span key={h} onPointerDown={(e) => startDrag(e, h)} className={cn('absolute z-10 bg-white shadow-[0_0_0_1.5px_var(--color-accent),0_1px_4px_rgb(0_0_0/0.6)]', className)} style={{ cursor }} />
  )

  return (
    <>
      <div
        className="absolute overflow-hidden"
        style={{ left: (full.cx - full.w / 2) * scale, top: (full.cy - full.h / 2) * scale, width: full.w * scale, height: full.h * scale, transform: `rotate(${b.rotation}deg)` }}
      >
        <div className="pointer-events-none absolute inset-0 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.25)]" />
        <div
          className="absolute cursor-move shadow-[0_0_0_9999px_rgb(0_0_0/0.55)]"
          onPointerDown={(e) => startDrag(e, 'move')}
          style={{ left: box.left * scale, top: box.top * scale, width: box.width * scale, height: box.height * scale }}
        >
          <div className="pointer-events-none absolute inset-0 shadow-[inset_0_0_0_1.5px_var(--color-accent)]" />
          {/* Rule of thirds */}
          <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,transparent_calc(33.33%-0.5px),rgb(255_255_255/0.28)_calc(33.33%-0.5px),rgb(255_255_255/0.28)_calc(33.33%+0.5px),transparent_calc(33.33%+0.5px),transparent_calc(66.66%-0.5px),rgb(255_255_255/0.28)_calc(66.66%-0.5px),rgb(255_255_255/0.28)_calc(66.66%+0.5px),transparent_calc(66.66%+0.5px)),linear-gradient(to_bottom,transparent_calc(33.33%-0.5px),rgb(255_255_255/0.28)_calc(33.33%-0.5px),rgb(255_255_255/0.28)_calc(33.33%+0.5px),transparent_calc(33.33%+0.5px),transparent_calc(66.66%-0.5px),rgb(255_255_255/0.28)_calc(66.66%-0.5px),rgb(255_255_255/0.28)_calc(66.66%+0.5px),transparent_calc(66.66%+0.5px))]" />
          {handle('l', '-left-[3px] top-1/2 h-6 w-[6px] -translate-y-1/2 rounded-full', 'ew-resize')}
          {handle('r', '-right-[3px] top-1/2 h-6 w-[6px] -translate-y-1/2 rounded-full', 'ew-resize')}
          {handle('t', '-top-[3px] left-1/2 h-[6px] w-6 -translate-x-1/2 rounded-full', 'ns-resize')}
          {handle('b', '-bottom-[3px] left-1/2 h-[6px] w-6 -translate-x-1/2 rounded-full', 'ns-resize')}
          {handle('tl', '-top-[4px] -left-[4px] size-2.5 rounded-[2px]', 'nwse-resize')}
          {handle('tr', '-top-[4px] -right-[4px] size-2.5 rounded-[2px]', 'nesw-resize')}
          {handle('bl', '-bottom-[4px] -left-[4px] size-2.5 rounded-[2px]', 'nesw-resize')}
          {handle('br', '-right-[4px] -bottom-[4px] size-2.5 rounded-[2px]', 'nwse-resize')}
        </div>
      </div>
      <button
        type="button"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => useUI.getState().setCropMode(false)}
        className="absolute top-2 left-1/2 z-20 -translate-x-1/2 rounded-full bg-accent px-3 py-1 text-xs font-semibold text-accent-fg shadow-[0_4px_16px_-4px_rgb(0_0_0/0.7)] hover:bg-accent-2"
      >
        Done cropping
      </button>
    </>
  )
}

// ─── Mask gizmo ──────────────────────────────────────────────────────────

type MaskHandle = 'move' | 'rotate' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

const rot = (x: number, y: number, deg: number) => {
  const a = (deg * Math.PI) / 180
  return { x: x * Math.cos(a) - y * Math.sin(a), y: x * Math.sin(a) + y * Math.cos(a) }
}

/**
 * Edits a mask on the canvas: drag inside to move it, the edges and corners to
 * resize it (the opposite side stays put), the top knob to rotate it.
 */
function MaskGizmo({ clip, mask, layer, pw, ph, scale }: { clip: Clip; mask: Mask; layer: NonNullable<ClipBounds['layer']>; pw: number; ph: number; scale: number }) {
  // The mask lives in the clip's full-frame layer; place it in project pixels.
  const offset = rot((mask.x - 0.5) * pw * layer.scale, (mask.y - 0.5) * ph * layer.scale, layer.rotation)
  const cx = layer.cx + offset.x
  const cy = layer.cy + offset.y
  const w = mask.width * pw * layer.scale
  const h = mask.height * ph * layer.scale
  const angle = layer.rotation + mask.rotation

  const startDrag = (e: ReactPointerEvent, handle: MaskHandle) => {
    e.stopPropagation()
    e.preventDefault()
    const start = { ...mask }
    const x0 = e.clientX
    const y0 = e.clientY
    const key = `maskgizmo:${mask.id}:${handle}:${Date.now()}`
    const frameEl = (e.currentTarget as HTMLElement).closest('[data-gizmo-root]') as HTMLElement
    const r = frameEl.getBoundingClientRect()
    const center = { x: cx, y: cy }
    const move = (ev: PointerEvent) => {
      // Screen → project pixels → the layer's own axes → fractions of the frame.
      const d = rot((ev.clientX - x0) / scale / layer.scale, (ev.clientY - y0) / scale / layer.scale, -layer.rotation)
      const patch: Partial<Mask> = {}
      if (handle === 'move') {
        patch.x = start.x + d.x / pw
        patch.y = start.y + d.y / ph
      } else if (handle === 'rotate') {
        const p = { x: (ev.clientX - r.left) / scale, y: (ev.clientY - r.top) / scale }
        let deg = (Math.atan2(p.y - center.y, p.x - center.x) * 180) / Math.PI + 90 - layer.rotation
        if (ev.shiftKey) deg = Math.round(deg / 15) * 15
        patch.rotation = Math.round(((((deg + 180) % 360) + 360) % 360) - 180)
      } else {
        // Resize in the mask's own axes, keeping the opposite edge in place.
        const local = rot(d.x, d.y, -start.rotation)
        const sx = handle.includes('e') ? 1 : handle.includes('w') ? -1 : 0
        const sy = handle.includes('s') ? 1 : handle.includes('n') ? -1 : 0
        const wpx = Math.max(8, start.width * pw + sx * local.x)
        const hpx = Math.max(8, start.height * ph + sy * local.y)
        const shift = rot((sx * (wpx - start.width * pw)) / 2, (sy * (hpx - start.height * ph)) / 2, start.rotation)
        patch.width = wpx / pw
        patch.height = hpx / ph
        patch.x = start.x + shift.x / pw
        patch.y = start.y + shift.y / ph
      }
      const round = (v: number) => Math.round(v * 10000) / 10000
      for (const k of Object.keys(patch) as (keyof Mask)[]) if (typeof patch[k] === 'number' && k !== 'rotation') (patch as Record<string, number>)[k] = round(patch[k] as number)
      dispatch('mask.update', { clipId: clip.id, maskId: mask.id, patch }, { coalesce: key, label: 'Edit mask' })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const knob = (h: MaskHandle, className: string, cursor: string) => (
    <span key={h} onPointerDown={(e) => startDrag(e, h)} className={cn('absolute z-10 size-2.5 rounded-[3px] border-[1.5px] border-accent bg-white shadow-[0_1px_4px_rgb(0_0_0/0.5)]', className)} style={{ cursor }} />
  )

  return (
    <>
      <div
        className="absolute cursor-move"
        onPointerDown={(e) => startDrag(e, 'move')}
        style={{ left: (cx - w / 2) * scale, top: (cy - h / 2) * scale, width: w * scale, height: h * scale, transform: `rotate(${angle}deg)` }}
      >
        <div
          className={cn('pointer-events-none absolute inset-0 border-[1.5px] border-dashed border-accent shadow-[0_0_0_1px_rgb(0_0_0/0.35)]', mask.shape === 'ellipse' ? 'rounded-[50%]' : 'rounded-[2px]')}
          style={mask.shape === 'rectangle' ? { borderRadius: `${(mask.roundness * Math.min(w, h) * scale) / 2}px` } : undefined}
        />
        {mask.feather > 0 && (
          <div
            className={cn('pointer-events-none absolute border border-dotted border-accent/50', mask.shape === 'ellipse' && 'rounded-[50%]')}
            style={{ inset: `${-mask.feather * Math.min(pw, ph) * 0.5 * layer.scale * scale}px` }}
          />
        )}
        {knob('nw', '-top-[5px] -left-[5px]', 'nwse-resize')}
        {knob('ne', '-top-[5px] -right-[5px]', 'nesw-resize')}
        {knob('sw', '-bottom-[5px] -left-[5px]', 'nesw-resize')}
        {knob('se', '-right-[5px] -bottom-[5px]', 'nwse-resize')}
        {knob('n', '-top-[5px] left-1/2 -translate-x-1/2', 'ns-resize')}
        {knob('s', '-bottom-[5px] left-1/2 -translate-x-1/2', 'ns-resize')}
        {knob('w', 'top-1/2 -left-[5px] -translate-y-1/2', 'ew-resize')}
        {knob('e', 'top-1/2 -right-[5px] -translate-y-1/2', 'ew-resize')}
        <span className="pointer-events-none absolute -top-6 left-1/2 h-6 w-px -translate-x-1/2 bg-accent/70" />
        <span onPointerDown={(e) => startDrag(e, 'rotate')} className="absolute -top-[30px] left-1/2 size-3 -translate-x-1/2 cursor-grab rounded-full border-[1.5px] border-accent bg-white shadow-[0_1px_4px_rgb(0_0_0/0.5)]" />
      </div>
      <button
        type="button"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => useUI.getState().setMaskEdit(null)}
        className="absolute top-2 left-1/2 z-20 -translate-x-1/2 rounded-full bg-accent px-3 py-1 text-xs font-semibold text-accent-fg shadow-[0_4px_16px_-4px_rgb(0_0_0/0.7)] hover:bg-accent-2"
      >
        Done with mask
      </button>
    </>
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

  const cropMode = useUI((s) => s.cropMode)
  const b = clipId ? bounds.get(clipId) : undefined
  const active = clip && frame >= clip.start && frame < clipEnd(clip) && clip.kind !== 'audio' && clip.kind !== 'adjustment'
  const cropping = Boolean(cropMode && active && b && (clip.kind === 'video' || clip.kind === 'image'))
  const maskEdit = useUI((s) => s.maskEdit)
  const mask = maskEdit ? clip?.masks?.find((m) => m.id === maskEdit) : undefined
  const onScreen = Boolean(clip && frame >= clip.start && frame < clipEnd(clip))
  // Adjustment layers cover the frame untransformed; other clips report where their layer sits.
  const layer = b?.layer ?? (clip?.kind === 'adjustment' ? { cx: pw / 2, cy: ph / 2, scale: 1, rotation: 0 } : undefined)
  const masking = Boolean(mask && onScreen && layer)

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
    // Scale and rotation pivot on the clip's position, which a crop can move off the box center.
    const center = { x: b.px ?? b.cx, y: b.py ?? b.cy }
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
      {cropping && clip && b && !playing && <CropGizmo clip={clip} b={b} scale={scale} />}
      {masking && clip && mask && layer && !playing && <MaskGizmo clip={clip} mask={mask} layer={layer} pw={pw} ph={ph} scale={scale} />}
      {active && b && !playing && !cropping && !masking && (
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
