import { create } from 'zustand'
import { usePlayback } from '@/editor/playback'
import { useEditor } from '@/editor/store'
import { useUI } from '@/editor/ui-store'
import { clamp } from '@/lib/math'

/**
 * What part of the timeline is on screen, in lane pixels (0 = the start of the
 * timeline). Lanes mount only the clips near it and clips draw only the part of
 * their filmstrip and waveform near it, so a long, busy timeline costs about as
 * much as a short one. Scrolling updates this store, not the timeline component.
 */
export const useViewport = create<{ scrollLeft: number; width: number; zooming: boolean }>(() => ({ scrollLeft: 0, width: 0, zooming: false }))

// ─── Zooming ─────────────────────────────────────────────────────────────

let anchor: { sec: number; px: number } | null = null

/** Makes the next zoom keep `sec` (timeline seconds) where it is on screen, `px` lane pixels from the left edge, instead of the playhead. */
export function anchorNextZoom(sec: number, px: number) {
  anchor = { sec, px }
}

// Zoom steps in quick succession are a gesture (wheel, pinch, slider drag). During
// one, filmstrips and waveforms stretch what they last drew instead of redrawing
// every step, and redraw once it settles. A lone step redraws right away.
let lastZoomAt = -Infinity
let settle: ReturnType<typeof setTimeout> | undefined

useUI.subscribe((s, prev) => {
  if (s.pxPerSecond === prev.pxPerSecond) return
  const now = performance.now()
  const gap = now - lastZoomAt
  lastZoomAt = now
  // The new scroll position goes in with the new zoom, so the timeline renders once
  // per step with the right clips on screen (the scroll element follows it).
  const view = useViewport.getState()
  let left: number
  if (anchor) left = anchor.sec * s.pxPerSecond - anchor.px
  else {
    const sec = usePlayback.getState().frame / useEditor.getState().project.settings.fps
    left = sec * s.pxPerSecond - clamp(sec * prev.pxPerSecond - view.scrollLeft, 0, view.width)
  }
  anchor = null
  useViewport.setState({ scrollLeft: Math.max(0, left), zooming: view.zooming || gap < 600 })
  // Settles a little after the steps stop; slow computers step slowly, so it waits longer for them.
  clearTimeout(settle)
  settle = setTimeout(() => useViewport.setState({ zooming: false }), clamp(gap * 2, 160, 700))
})

// ─── The drawn window ────────────────────────────────────────────────────

/** Lane pixels kept drawn beyond each side of the screen, so scrolling never shows a blank edge. */
export const OVERSCAN = 700
/** The drawn window moves in steps this big, so components update every few hundred pixels of scrolling, not every pixel. */
export const QUANTUM = 350

const lo = (s: { scrollLeft: number }) => Math.max(0, Math.floor((s.scrollLeft - OVERSCAN) / QUANTUM) * QUANTUM)
const hi = (s: { scrollLeft: number; width: number }) => Math.ceil((s.scrollLeft + Math.max(s.width, 1) + OVERSCAN) / QUANTUM) * QUANTUM

/** The lane pixels worth drawing right now: [from, to). */
export function useLaneWindow(): [number, number] {
  return [useViewport(lo), useViewport(hi)]
}

/** The same window, read once (event handlers, effects). */
export function laneWindow(): [number, number] {
  const s = useViewport.getState()
  return [lo(s), hi(s)]
}
