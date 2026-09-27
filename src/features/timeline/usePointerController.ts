/**
 * Every pointer gesture on the timeline: move (with snapping, cross-track
 * moves, gap-seeking and insert / overwrite), trim and ripple trim, the roll,
 * slip and slide tools, audio fades, blade, marquee select and ruler
 * scrubbing. Gestures preview through the drag store and commit a single
 * command on release, so each gesture is one clean undo step.
 *
 * Grouped clips (a video and its detached sound, or a user group) select
 * together; hold Alt to pick just one.
 */
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react'
import { toast } from 'sonner'
import type { EditMode } from '@/editor/commands'
import {
  adjacentAfter,
  adjacentBefore,
  clipEnd,
  clipsOnTrack,
  editPoints,
  isMagneticTrack,
  magneticLayout,
  resolveMoveDelta,
  rollBounds,
  setClipEnd,
  setClipStart,
  slideBounds,
  slipBounds,
  trackAccepts,
  trimBounds,
  withGroups,
} from '@/editor/ops'
import { playback, usePlayback } from '@/editor/playback'
import { dispatch, getProject } from '@/editor/store'
import { averageSpeed, consumed } from '@/editor/timing'
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

/** Where a trim leaves a clip, for live previews — exact, speed ramps and reverse included. */
function trimmed(clip: Clip, edge: 'start' | 'end', frame: number): ClipPreview {
  const c = { ...clip, keyframes: { ...clip.keyframes } }
  if (edge === 'start') setClipStart(c, frame)
  else setClipEnd(c, frame)
  return { start: c.start, duration: c.duration, trackId: c.trackId, inPoint: c.inPoint }
}

const still = (c: Clip, start = c.start): ClipPreview => ({ start, duration: c.duration, trackId: c.trackId, inPoint: c.inPoint })

/** Ctrl while dragging inserts (pushes clips later); Shift overwrites what's there. */
const editModeOf = (e: PointerEvent): EditMode => (e.ctrlKey || e.metaKey ? 'insert' : e.shiftKey ? 'overwrite' : 'free')

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
    const picked = e.altKey ? [clip.id] : withGroups(project, [clip.id])
    let collapseSelection = false
    if (!ui.selection.includes(clip.id)) ui.select(picked, additive ? 'add' : 'replace')
    else if (additive) {
      ui.select(picked, 'toggle')
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
    let mode: EditMode = 'free'

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
        mode = editModeOf(ev)

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
        } else if (mode !== 'free') {
          // Land exactly where dropped: insert pushes what's there later, overwrite covers it.
          for (const m of moving) {
            preview(originals[m.id], m.start, m.trackId)
            plan[m.id] = { start: m.start, trackId: m.trackId }
          }
          if (mode === 'insert') {
            const exclude = new Set(ids)
            for (const trackId of new Set(moving.map((m) => m.trackId))) {
              if (isMagneticTrack(project, trackId)) continue
              const mine = moving.filter((m) => m.trackId === trackId)
              const a = Math.min(...mine.map((m) => m.start))
              const len = Math.max(...mine.map((m) => m.start + m.duration)) - a
              // (A clip across the insert point gets cut there on release.)
              for (const c of clipsOnTrack(project, trackId, exclude)) if (c.start >= a) preview(c, c.start + len)
            }
          }
          text = `${mode === 'insert' ? 'Insert' : 'Overwrite'} at ${formatTimecode(previews[clip.id].start, L().fps)}`
        } else {
          const fix = resolveMoveDelta(project, moving, 0)
          if (fix) snapFrame = null
          for (const m of moving) {
            preview(originals[m.id], m.start + fix, m.trackId)
            plan[m.id] = { start: m.start + fix, trackId: m.trackId }
          }
          const moveBy = previews[clip.id].start - clip.start
          text = `${formatTimecode(previews[clip.id].start, L().fps)}   ${moveBy >= 0 ? '+' : '−'}${formatDuration(Math.abs(moveBy), L().fps)}   · Ctrl insert · Shift overwrite`
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
            const res = dispatch('clip.move', { moves, mode })
            if (!res.ok) toast(res.error)
          }
        } else if (collapseSelection) useUI.getState().select(picked)
        resetDrag()
        useDrag.setState({ dropGhost: null })
      },
    )
  }

  function trim(e: ReactPointerEvent, clip: Clip, edge: 'start' | 'end') {
    const project = getProject()
    const ui = useUI.getState()
    if (!ui.selection.includes(clip.id)) ui.select([clip.id])
    const bounded = trimBounds(project, clip, edge)
    const free = trimBounds(project, clip, edge, true)
    const origin = edge === 'start' ? clip.start : clipEnd(clip)
    const magnetic = isMagneticTrack(project, clip.trackId)
    const later = clipsOnTrack(project, clip.trackId).filter((c) => c.id !== clip.id && c.start >= clipEnd(clip))
    // Rippling neighbours move with the trim, so they can't be snap targets.
    const targets = snapTargets(project, new Set([clip.id, ...later.map((c) => c.id)]))
    const start = toContent(e.clientX, e.clientY).x
    let target = origin
    let ripple = magnetic
    document.body.style.cursor = 'col-resize'

    session(
      (ev) => {
        const p = toContent(ev.clientX, ev.clientY)
        // Ctrl ripples on any track: later clips follow the edge, so no gap opens.
        ripple = magnetic || ev.ctrlKey || ev.metaKey
        const [min, max] = ripple ? free : bounded
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
        const after = trimmed(clip, edge, target)
        const previews: Record<string, ClipPreview> = {}
        if (ripple) {
          // Ripple trim: this clip keeps its place, everything after it slides.
          previews[clip.id] = { ...after, start: clip.start }
          const shift = after.duration - clip.duration
          for (const c of later) previews[c.id] = still(c, c.start + shift)
        } else previews[clip.id] = after
        useDrag.setState({
          mode: 'trim',
          dragIds: [clip.id],
          previews,
          snapFrame,
          readout: { x: p.x, y: p.y, text: `${formatDuration(after.duration, L().fps)}  ·  ${ripple ? 'ripple' : `${formatTimecode(target, L().fps)}  ·  Ctrl ripple`}` },
        })
      },
      () => {
        if (target !== origin) {
          const res = dispatch('clip.trim', { id: clip.id, edge, frame: target, ripple: ripple && !magnetic })
          if (!res.ok) toast(res.error)
        }
        resetDrag()
      },
    )
  }

  /** Roll tool: drag the cut nearest the pointer — the clip on one side grows as the other shrinks. */
  function roll(e: ReactPointerEvent, clip: Clip) {
    const project = getProject()
    const at = frameAtX(toContent(e.clientX, e.clientY).x)
    const right = Math.abs(at - clip.start) <= Math.abs(at - clipEnd(clip)) ? clip : adjacentAfter(project, clip)
    const left = right && adjacentBefore(project, right)
    if (!right || !left) {
      toast('Roll moves a cut between two clips that touch — grab one next to its neighbour')
      return
    }
    useUI.getState().select([left.id, right.id])
    const [min, max] = rollBounds(project, left, right)
    const origin = right.start
    const targets = snapTargets(project, new Set([left.id, right.id]))
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
        const moveBy = target - origin
        useDrag.setState({
          mode: 'trim',
          dragIds: [left.id, right.id],
          previews: { [left.id]: trimmed(left, 'end', target), [right.id]: trimmed(right, 'start', target) },
          snapFrame,
          readout: { x: p.x, y: p.y, text: `Roll ${moveBy >= 0 ? '+' : '−'}${formatDuration(Math.abs(moveBy), L().fps)}  ·  cut at ${formatTimecode(target, L().fps)}` },
        })
      },
      () => {
        if (target !== origin) {
          const res = dispatch('clip.roll', { id: right.id, frame: target })
          if (!res.ok) toast(res.error)
        }
        resetDrag()
      },
    )
  }

  /** Slip tool: drag to show an earlier or later part of the footage, in the same place and length. */
  function slip(e: ReactPointerEvent, clip: Clip) {
    const project = getProject()
    useUI.getState().select([clip.id])
    const [lo, hi] = slipBounds(project, clip)
    if (!lo && !hi) {
      toast(clip.freeze ? 'A freeze frame holds one frame — there’s nothing to slip' : 'Slip needs a video or audio clip with footage to spare')
      return
    }
    const start = toContent(e.clientX, e.clientY).x
    // Dragging right pulls earlier footage into view, like sliding film under a window.
    const perFrame = Math.max(0.1, averageSpeed(clip)) * (clip.reverse ? -1 : 1)
    const fps = L().fps
    let slipBy = 0
    document.body.style.cursor = 'ew-resize'
    session(
      (ev) => {
        const p = toContent(ev.clientX, ev.clientY)
        const df = Math.round(((p.x - start) / L().pps) * fps)
        slipBy = clamp(Math.round(-df * perFrame), lo, hi)
        const inPoint = clip.inPoint + slipBy
        useDrag.setState({
          mode: 'trim',
          dragIds: [clip.id],
          previews: { [clip.id]: { ...still(clip), inPoint } },
          readout: { x: p.x, y: p.y, text: `Slip ${slipBy >= 0 ? '+' : '−'}${formatDuration(Math.abs(slipBy), fps)}  ·  ${formatTimecode(inPoint, fps)} → ${formatTimecode(Math.round(inPoint + consumed(clip)), fps)}` },
        })
      },
      () => {
        if (slipBy) {
          const res = dispatch('clip.slip', { id: clip.id, frames: slipBy })
          if (!res.ok) toast(res.error)
        }
        resetDrag()
      },
      false,
    )
  }

  /** Slide tool: move a clip along its track while its neighbours give and take frames. */
  function slide(e: ReactPointerEvent, clip: Clip) {
    const project = getProject()
    useUI.getState().select([clip.id])
    const prev = adjacentBefore(project, clip)
    const next = adjacentAfter(project, clip)
    const [lo, hi] = slideBounds(project, clip)
    const targets = snapTargets(project, new Set([clip.id, ...(prev ? [prev.id] : []), ...(next ? [next.id] : [])]))
    const start = toContent(e.clientX, e.clientY).x
    let slideBy = 0
    document.body.style.cursor = 'ew-resize'
    session(
      (ev) => {
        const p = toContent(ev.clientX, ev.clientY)
        let d = Math.round(((p.x - start) / L().pps) * L().fps)
        let snapFrame: number | null = null
        if (snapping(ev)) {
          const s = nearestSnap([clip.start + d, clipEnd(clip) + d], targets, snapThreshold())
          if (s) {
            d += s.adjust
            snapFrame = s.frame
          }
        }
        slideBy = clamp(d, lo, hi)
        if (slideBy !== d) snapFrame = null
        const previews: Record<string, ClipPreview> = { [clip.id]: still(clip, clip.start + slideBy) }
        if (prev) previews[prev.id] = trimmed(prev, 'end', clipEnd(prev) + slideBy)
        if (next) previews[next.id] = trimmed(next, 'start', next.start + slideBy)
        useDrag.setState({
          mode: 'move',
          dragIds: [clip.id],
          previews,
          snapFrame,
          readout: { x: p.x, y: p.y, text: `Slide ${slideBy >= 0 ? '+' : '−'}${formatDuration(Math.abs(slideBy), L().fps)}  ·  ${formatTimecode(clip.start + slideBy, L().fps)}` },
        })
      },
      () => {
        if (slideBy) {
          const res = dispatch('clip.slide', { id: clip.id, frames: slideBy })
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
    // Linked clips are cut together (Alt cuts just this one; Shift cuts every track).
    const ids = e.shiftKey ? undefined : e.altKey ? [clip.id] : withGroups(getProject(), [clip.id])
    const res = dispatch('clip.split', { frame: f, ids })
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
        useUI.getState().select([...new Set([...base, ...(ev.altKey ? hits : withGroups(getProject(), hits))])])
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
      const tool = useUI.getState().tool
      if (tool === 'blade' && !handle) return blade(e, clip)
      if (tool === 'roll') return roll(e, clip)
      if (tool === 'slip') return slip(e, clip)
      if (tool === 'slide') return slide(e, clip)
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
