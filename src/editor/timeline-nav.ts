/**
 * Moving between timelines: each keeps its own playhead, and opening a nested
 * clip's timeline leaves a trail back to where you came from.
 */
import { create } from 'zustand'
import { playback, usePlayback } from './playback'
import { openSequenceId, openSequenceName } from './sequences'
import { dispatch, useEditor } from './store'

interface NavState {
  /** Timelines to go back to, oldest first (opened by stepping into nested clips). */
  trail: { id: string; name: string }[]
}

export const useTimelineNav = create<NavState>(() => ({ trail: [] }))

const playheads = new Map<string, number>()

/** Opens a timeline; `fromNest` remembers the way back. False when it couldn't. */
export function openTimeline(id: string, fromNest = false) {
  const p = useEditor.getState().project
  const here = openSequenceId(p)
  if (id === here) return true
  const res = dispatch('sequence.open', { id })
  if (!res.ok) return false
  useTimelineNav.setState((s) => ({ trail: fromNest ? [...s.trail, { id: here, name: openSequenceName(p) }] : [] }))
  return true
}

/** Back to the timeline a nested clip was opened from. */
export function timelineBack() {
  const trail = useTimelineNav.getState().trail
  const last = trail[trail.length - 1]
  if (!last) return
  useTimelineNav.setState({ trail: trail.slice(0, -1) })
  dispatch('sequence.open', { id: last.id })
}

let started = false

export function startTimelineNav() {
  if (started) return
  started = true
  useEditor.subscribe((s, prev) => {
    if (s.project.id !== prev.project.id) {
      playheads.clear()
      useTimelineNav.setState({ trail: [] })
      return
    }
    const now = openSequenceId(s.project)
    const was = openSequenceId(prev.project)
    if (now === was) return
    // Each timeline keeps its own playhead.
    playheads.set(was, usePlayback.getState().frame)
    playback.pause()
    playback.seek(playheads.get(now) ?? 0)
    // Undoing into the timeline we came from walks the trail back too.
    const trail = useTimelineNav.getState().trail
    if (trail[trail.length - 1]?.id === now) useTimelineNav.setState({ trail: trail.slice(0, -1) })
    else if (trail.some((t) => !s.project.sequences?.[t.id] && t.id !== now)) useTimelineNav.setState({ trail: trail.filter((t) => s.project.sequences?.[t.id]) })
  })
}
