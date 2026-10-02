/**
 * Preview resolution while playing. Fixed settings render at that fraction of
 * the viewer's resolution; Auto starts at full and steps down when this computer
 * can't keep up (frames take too long to draw, or playback skips frames), and
 * back up once there's room again — so heavy timelines stay smooth on slow
 * machines and stay sharp on fast ones. Paused frames always use the paused
 * setting (full by default): what you inspect is exact.
 */
import { create } from 'zustand'
import type { PreviewRes } from '@/editor/ui-store'

const LEVELS = [1, 0.5, 0.25, 0.125]

/** What Auto renders at right now (the viewer's resolution menu shows it). */
export const useAutoRes = create<{ level: number }>(() => ({ level: 1 }))

const recent: { ms: number; dropped: number }[] = []
let roomySince = 0

/** The fraction of the viewer's resolution to render the next frame at. */
export function previewScale(setting: PreviewRes, paused: Exclude<PreviewRes, 'auto'>, playing: boolean) {
  if (!playing) return paused
  return setting === 'auto' ? useAutoRes.getState().level : setting
}

function step(dir: 1 | -1) {
  const i = LEVELS.indexOf(useAutoRes.getState().level)
  const next = LEVELS[Math.max(0, Math.min(LEVELS.length - 2, i - dir))]
  if (next === useAutoRes.getState().level) return
  useAutoRes.setState({ level: next })
  recent.length = 0
  roomySince = 0
}

/**
 * Tells Auto how a frame drawn during playback went: how long drawing it took
 * (ms), how many timeline frames were skipped since the last one, and the frame
 * budget (ms per frame at the project's frame rate).
 */
export function recordPlaybackDraw(ms: number, dropped: number, budget: number, now = performance.now()) {
  recent.push({ ms, dropped: Math.max(0, dropped) })
  if (recent.length > 16) recent.shift()
  if (recent.length < 8) return
  const avg = recent.reduce((a, r) => a + r.ms, 0) / recent.length
  const drops = recent.reduce((a, r) => a + r.dropped, 0)
  // Behind: the drawing alone eats most of the frame, or frames are being skipped.
  if (avg > budget * 0.55 || drops >= 5) {
    step(-1)
    return
  }
  // Plenty of room for a while: try the next resolution up.
  if (avg < budget * 0.16 && drops === 0) {
    roomySince ||= now
    if (now - roomySince > 3000) step(1)
  } else roomySince = 0
}

/** A new project starts Auto at full resolution again. */
export function resetAutoRes() {
  useAutoRes.setState({ level: 1 })
  recent.length = 0
  roomySince = 0
}
