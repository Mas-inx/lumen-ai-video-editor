/**
 * One animation loop for every level meter. It runs while the timeline plays —
 * and for a moment after, so meters can fall back to silence — and sleeps the
 * rest of the time, instead of redrawing the window at the display's refresh
 * rate while nothing makes a sound.
 */
import { usePlayback } from '@/editor/playback'

type MeterFn = (now: number, dt: number) => void

const fns = new Set<MeterFn>()
let raf = 0
let last = 0
let quietSince: number | null = null
/** How long meters keep moving after playback stops (they fall at 24 dB/s). */
const SETTLE_MS = 2600

function frame(now: number) {
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000))
  last = now
  for (const fn of fns) fn(now, dt)
  if (usePlayback.getState().playing) quietSince = null
  else quietSince ??= now
  if (!fns.size || (quietSince !== null && now - quietSince > SETTLE_MS)) {
    raf = 0
    return
  }
  raf = requestAnimationFrame(frame)
}

/** Runs the loop for a while (playback started, a meter appeared). */
export function wakeMeters() {
  if (raf || !fns.size) return
  last = performance.now()
  quietSince = null
  raf = requestAnimationFrame(frame)
}

/** Calls `fn` on every meter frame; returns the unsubscribe. */
export function onMeterFrame(fn: MeterFn) {
  fns.add(fn)
  wakeMeters()
  return () => void fns.delete(fn)
}

usePlayback.subscribe((s, prev) => {
  if (s.playing && !prev.playing) wakeMeters()
})
