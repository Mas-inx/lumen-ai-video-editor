/**
 * Every pointer gesture on the timeline: move (with snapping, cross-track
 * moves and gap-seeking), trim, audio fades, blade, marquee select and
 * ruler scrubbing. Gestures preview through the drag store and commit a
 * single command on release, so each gesture is one clean undo step.
 */
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react'
import { toast } from 'sonner'
import { clipEnd, clipsOnTrack, editPoints, isMagneticTrack, magneticLayout, resolveMoveDelta, trackAccepts, trimBounds } from '@/editor/ops'
import { playback, usePlayback } from '@/editor/playback'
import { dispatch, getProject } from '@/editor/store'
import type { Clip, Project } from '@/editor/types'
import { useUI } from '@/editor/ui-store'
import { clamp } from '@/lib/math'
import { formatDuration, formatTimecode } from '@/lib/time'
import type { TimelineLayout } from './layout'
import { HEADER_W, SNAP_PX, resetDrag, useDrag, type ClipPreview, type DropGhost } from './model'

interface Env {
  scrollRef: RefObject<HTMLDivElement | null>
  contentRef: RefObject<HTMLDivElement | null>
  layoutRef: RefObject<TimelineLayout>
}

function snapTargets(project: Project, exclude: Set<string>) {
  const set = new Set<number>([0, usePlayback.getState().frame])
  for (const c of Object.values(project.clips)) {
    if (exclude.has(c.id)) continue
    set.add(c.start)
    set.add(clipEnd(c))
  }
  for (const m of project.markers) set.add(m.frame)
  return [...set]
}

function nearestSnap(edges: number[], targets: number[], threshold: number) {
  let best: { adjust: number; frame: number; dist: number } | null = null
  for (const t of targets) {
    for (const e of edges) {
      const dist = Math.abs(t - e)
      if (dist <= threshold && (!best || dist < best.dist)) best = { adjust: t - e, frame: t, dist }
    }
  }
  return best
}

export function usePointerController({ scrollRef, contentRef, layoutRef }: Env) {
  const L = () => layoutRef.current
  const toContent = (clientX: number, clientY: number) => {
    const r = contentRef.current!.getBoundingClientRect()
    return { x: clientX - r.left, y: clientY - r.top }
  }
  const frameAtX = (contentX: number) => Math.max(0, Math.round(((contentX - HEADER_W) / L().pps) * L().fps))
  const rowAt = (y: number) => L().tracks.findIndex((t) => y >= L().rowTop[t.id] && y < L().rowTop[t.id] + L().rowHeight[t.id])
  const snapThreshold = () => (SNAP_PX / L().pps) * L().fps
  const snapping = (e: PointerEvent) => useUI.getState().snapping && !e.altKey

  /** Pointer session with rAF edge auto-scroll that replays the last move. */
  function session(onMove: (e: PointerEvent) => void, onUp: (e: PointerEvent) => void, autoScroll = true) {
    let last: PointerEvent | null = null
    let raf = 0
    const tick = () => {
      raf = 0
      const el = scrollRef.current
      if (!el || !last || !autoScroll) return
      const r = el.getBoundingClientRect()
      const edge = 48
      let dx = 0
      if (last.clientX > r.right - edge) dx = Math.min(24, (last.clientX - (r.right - edge)) / 2)
      else if (last.clientX < r.left + HEADER_W + edge) dx = -Math.min(24, (r.left + HEADER_W + edge - last.clientX) / 2)
      if (dx) {
        el.scrollLeft += dx
        onMove(last)
        raf = requestAnimationFrame(tick)
      }
    }
    const move = (e: PointerEvent) => {
      last = e
      onMove(e)
      if (!raf) raf = requestAnimationFrame(tick)
    }
    const up = (e: PointerEvent) => {
      cancelAnimationFrame(raf)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      document.body.style.cursor = ''
      onUp(e)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  // ── Gestures ──────────────────────────────────────────────────────────

  function scrub(e: ReactPointerEvent) {
    playback.pause()
    const seekTo = (clientX: number, clientY: number, shift: boolean) => {
      let f = frameAtX(toContent(clientX, clientY).x)
      if (shift) {
        const pts = editPoints(getProject())
        f = pts.reduce((best, p) => (Math.abs(p - f) < Math.abs(best - f) ? p : best), f)
      }
      playback.seek(f)
    }
    seekTo(e.clientX, e.clientY, e.shiftKey)
    useDrag.setState({ mode: 'scrub' })
    document.body.style.cursor = 'ew-resize'
    session(
      (ev) => seekTo(ev.clientX, ev.clientY, ev.shiftKey),
      () => resetDrag(),
      true,
    )
  }

  function move(e: ReactPointerEvent, clip: Clip) {
    const project = getProject()
    const ui = useUI.getState()
    const additive = e.shiftKey || e.metaKey || e.ctrlKey
    let collapseSelection = false
    if (!ui.selection.includes(clip.id)) ui.select([clip.id], additive ? 'add' : 'replace')
    else if (additive) {
      ui.select([clip.id], 'toggle')
      return
    } else collapseSelection = true

    const lockedTracks = new Set(project.tracks.filter((t) => t.locked).map((t) => t.id))
    const ids = useUI.getState().selection.filter((id) => project.clips[id] && !lockedTracks.has(project.clips[id].trackId))
    const originals = Object.fromEntries(ids.map((id) => [id, project.clips[id]]))
    const trackIndex = Object.fromEntries(L().tracks.map((t, i) => [t.id, i]))
    const originRow = trackIndex[clip.trackId]
    const targets = snapTargets(project, new Set(ids))
    const start = toContent(e.clientX, e.clientY)
    let moved = false
    /** Where each affected clip will land on release (previews are only visuals). */
    let plan: Record<string, { start: number; trackId: string }> = {}

    session(
      (ev) => {
        const p = toContent(ev.clientX, ev.clientY)
        if (!moved && Math.abs(p.x - start.x) < 4 && Math.abs(p.y - start.y) < 4) return
        if (!moved) document.body.style.cursor = 'grabbing'
        moved = true
        let delta = Math.round(((p.x - start.x) / L().pps) * L().fps)
        let snapFrame: number | null = null
        if (snapping(ev)) {
          const s = nearestSnap([clip.start + delta, clipEnd(clip) + delta], targets, snapThreshold())
          if (s) {
            delta += s.adjust
            snapFrame = s.frame
          }
        }
        const hover = rowAt(p.y)
        let shift = hover >= 0 ? hover - originRow : 0
        const fits = (s: number) =>
          ids.every((id) => {
            const t = L().tracks[trackIndex[originals[id].trackId] + s]
            return t && !t.locked && trackAccepts(t, originals[id].kind)
          })
        if (shift !== 0 && !fits(shift)) shift = 0
        const moving = ids.map((id) => ({
          id,
          start: originals[id].start + delta,
          duration: originals[id].duration,
          trackId: L().tracks[trackIndex[originals[id].trackId] + shift].id,
        }))
        const previews: Record<string, ClipPreview> = {}
        const preview = (c: Clip, start: number, trackId = c.trackId) => (previews[c.id] = { start, duration: c.duration, trackId, inPoint: c.inPoint })
        const target = moving[0].trackId
        let dropGhost: DropGhost | null = null
        let text: string
        plan = {}

        if (isMagneticTrack(project, target) && moving.every((m) => m.trackId === target)) {
          // Magnetic main track: the held clip floats with the pointer, a slot opens
          // where it will land and the neighbours glide aside to make room.
          const order = [...moving].sort((a, b) => originals[a.id].start - originals[b.id].start)
          const { starts } = magneticLayout(project, target, order, frameAtX(p.x))
          for (const [id, slot] of Object.entries(starts)) {
            const c = project.clips[id]
            plan[id] = { start: slot, trackId: target }
            preview(c, ids.includes(id) ? Math.max(0, c.start + delta) : slot, target)
          }
          const first = Math.min(...order.map((m) => starts[m.id]))
          const length = order.reduce((sum, m) => sum + m.duration, 0)
          dropGhost = { trackId: target, start: first, duration: length, label: '', kind: clip.kind }
          snapFrame = null
          text = `Insert at ${formatTimecode(starts[clip.id], L().fps)}`
        } else {
          const fix = resolveMoveDelta(project, moving, 0)
          if (fix) snapFrame = null
          for (const m of moving) {
            preview(originals[m.id], m.start + fix, m.trackId)
            plan[m.id] = { start: m.start + fix, trackId: m.trackId }
          }
          const moveBy = previews[clip.id].start - clip.start
          text = `${formatTimecode(previews[clip.id].start, L().fps)}   ${moveBy >= 0 ? '+' : '−'}${formatDuration(Math.abs(moveBy), L().fps)}`
        }
        // Clips leaving a magnetic track: the ones left behind close the gap.
        for (const trackId of new Set(ids.map((id) => originals[id].trackId))) {
          if (!isMagneticTrack(project, trackId) || moving.some((m) => m.trackId === trackId)) continue
          let cursor = 0
          for (const c of clipsOnTrack(project, trackId, new Set(ids))) {
            preview(c, cursor)
            cursor += c.duration
          }
        }
        useDrag.setState({ mode: 'move', dragIds: ids, previews, dropGhost, snapFrame, readout: { x: p.x, y: p.y, text } })
      },
      () => {
        if (moved) {
          const moves = Object.entries(plan)
            .filter(([id, pl]) => project.clips[id] && (pl.start !== project.clips[id].start || pl.trackId !== project.clips[id].trackId))
            .map(([id, pl]) => ({ id, start: pl.start, trackId: pl.trackId }))
          if (moves.length) {
            const res = dispatch('clip.move', { moves })
            if (!res.ok) toast(res.error)
          }
        } else if (collapseSelection) useUI.getState().select([clip.id])
        resetDrag()
        useDrag.setState({ dropGhost: null })
      },
    )
  }

  function trim(e: ReactPointerEvent, clip: Clip, edge: 'start' | 'end') {
    const project = getProject()
    const ui = useUI.getState()
    if (!ui.selection.includes(clip.id)) ui.select([clip.id])
    const [min, max] = trimBounds(project, clip, edge)
    const origin = edge === 'start' ? clip.start : clipEnd(clip)
    const magnetic = isMagneticTrack(project, clip.trackId)
    const later = magnetic ? clipsOnTrack(project, clip.trackId).filter((c) => c.start > clip.start) : []
    // Rippling neighbours move with the trim, so they can't be snap targets.
    const targets = snapTargets(project, new Set([clip.id, ...later.map((c) => c.id)]))
    const start = toContent(e.clientX, e.clientY).x
    let target = origin
    document.body.style.cursor = 'col-resize'

    session(
      (ev) => {
        const p = toContent(ev.clientX, ev.clientY)
        let f = origin + Math.round(((p.x - start) / L().pps) * L().fps)
        let snapFrame: number | null = null
        if (snapping(ev)) {
          const s = nearestSnap([f], targets, snapThreshold())
          if (s) {
            f += s.adjust
            snapFrame = s.frame
          }
        }
        target = clamp(f, min, max)
        if (target !== f) snapFrame = null
        const inPoint = edge === 'start' ? Math.max(0, clip.inPoint + Math.round((target - clip.start) * clip.speed)) : clip.inPoint
        const duration = edge === 'start' ? clipEnd(clip) - target : target - clip.start
        const previews: Record<string, ClipPreview> = {}
        if (magnetic) {
          // Ripple trim: this clip keeps its place, everything after it slides.
          previews[clip.id] = { start: clip.start, duration, trackId: clip.trackId, inPoint }
          const shift = duration - clip.duration
          for (const c of later) previews[c.id] = { start: c.start + shift, duration: c.duration, trackId: c.trackId, inPoint: c.inPoint }
        } else {
          previews[clip.id] = { start: edge === 'start' ? target : clip.start, duration, trackId: clip.trackId, inPoint }
        }
        useDrag.setState({
          mode: 'trim',
          dragIds: [clip.id],
          previews,
          snapFrame,
          readout: { x: p.x, y: p.y, text: `${formatDuration(duration, L().fps)}  ·  ${magnetic ? 'ripple' : formatTimecode(target, L().fps)}` },
        })
      },
      () => {
        if (target !== origin) {
          const res = dispatch('clip.trim', { id: clip.id, edge, frame: target })
          if (!res.ok) toast(res.error)
        }
        resetDrag()
      },
    )
  }

  function fade(e: ReactPointerEvent, clip: Clip, which: 'fadeIn' | 'fadeOut') {
    useUI.getState().select([clip.id])
    const origin = clip.audio[which]
    const start = toContent(e.clientX, e.clientY).x
    const max = Math.floor(clip.duration / 2)
    document.body.style.cursor = 'ew-resize'
    session(
      (ev) => {
        const p = toContent(ev.clientX, ev.clientY)
        const df = Math.round(((p.x - start) / L().pps) * L().fps)
        const value = clamp(origin + (which === 'fadeIn' ? df : -df), 0, max)
        dispatch('clip.update', { ids: [clip.id], patch: { audio: { [which]: value } } }, { coalesce: `fade:${clip.id}:${which}`, label: which === 'fadeIn' ? 'Fade in' : 'Fade out' })
        useDrag.setState({ mode: 'fade', readout: { x: p.x, y: p.y, text: `${which === 'fadeIn' ? 'Fade in' : 'Fade out'}  ${formatDuration(value, L().fps)}` } })
      },
      () => resetDrag(),
      false,
    )
  }

  function blade(e: ReactPointerEvent, clip: Clip) {
    let f = frameAtX(toContent(e.clientX, e.clientY).x)
    const playhead = usePlayback.getState().frame
    if (useUI.getState().snapping && Math.abs(playhead - f) <= snapThreshold()) f = playhead
    const res = dispatch('clip.split', { frame: f, ids: e.shiftKey ? undefined : [clip.id] })
    if (!res.ok) toast(res.error)
  }

  function marquee(e: ReactPointerEvent) {
    const ui = useUI.getState()
    const additive = e.shiftKey || e.metaKey || e.ctrlKey
    const base = additive ? ui.selection : []
    const o = toContent(e.clientX, e.clientY)
    let moved = false
    session(
      (ev) => {
        const p = toContent(ev.clientX, ev.clientY)
        if (!moved && Math.hypot(p.x - o.x, p.y - o.y) < 4) return
        moved = true
        const x0 = Math.min(o.x, p.x) - HEADER_W
        const x1 = Math.max(o.x, p.x) - HEADER_W
        const y0 = Math.min(o.y, p.y)
        const y1 = Math.max(o.y, p.y)
        const { pps, fps, rowTop, rowHeight, tracks } = L()
        const hitTracks = new Set(tracks.filter((t) => !t.locked && rowTop[t.id] < y1 && rowTop[t.id] + rowHeight[t.id] > y0).map((t) => t.id))
        const hits = Object.values(getProject().clips)
          .filter((c) => hitTracks.has(c.trackId) && (c.start / fps) * pps < x1 && (clipEnd(c) / fps) * pps > x0)
          .map((c) => c.id)
        useUI.getState().select([...new Set([...base, ...hits])])
        useDrag.setState({ mode: 'marquee', marquee: { x0: Math.min(o.x, p.x), y0, x1: Math.max(o.x, p.x), y1 } })
      },
      () => {
        if (!moved && !additive) useUI.getState().clearSelection()
        resetDrag()
      },
    )
  }

  // ── Dispatcher ────────────────────────────────────────────────────────

  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    if (target.closest('input,textarea,button')) return
    if (target.closest('[data-ruler]') || target.closest('[data-playhead]')) {
      e.preventDefault()
      scrub(e)
      return
    }
    const clipEl = target.closest<HTMLElement>('[data-clip-id]')
    if (clipEl) {
      e.preventDefault()
      const clip = getProject().clips[clipEl.dataset.clipId!]
      if (!clip) return
      const handle = target.closest<HTMLElement>('[data-handle]')?.dataset.handle
      if (useUI.getState().tool === 'blade' && !handle) return blade(e, clip)
      if (handle === 'start' || handle === 'end') return trim(e, clip, handle)
      if (handle === 'fade-in') return fade(e, clip, 'fadeIn')
      if (handle === 'fade-out') return fade(e, clip, 'fadeOut')
      return move(e, clip)
    }
    if (target.closest('[data-lane],[data-lane-filler]')) {
      e.preventDefault()
      marquee(e)
    }
  }

  /** Blade preview line while hovering with the blade tool. */
  const onPointerMove = (e: ReactPointerEvent) => {
    if (useUI.getState().tool !== 'blade' || useDrag.getState().mode) {
      if (useDrag.getState().bladeFrame !== null) useDrag.setState({ bladeFrame: null })
      return
    }
    const p = toContent(e.clientX, e.clientY)
    if (p.x < HEADER_W || !(e.target as HTMLElement).closest('[data-lane]')) {
      if (useDrag.getState().bladeFrame !== null) useDrag.setState({ bladeFrame: null })
      return
    }
    let f = frameAtX(p.x)
    const playhead = usePlayback.getState().frame
    if (useUI.getState().snapping && Math.abs(playhead - f) <= snapThreshold()) f = playhead
    useDrag.setState({ bladeFrame: f })
  }

  const onPointerLeave = () => {
    if (useDrag.getState().bladeFrame !== null) useDrag.setState({ bladeFrame: null })
  }

  return { onPointerDown, onPointerMove, onPointerLeave, frameAtX, rowAt, toContent }
}
