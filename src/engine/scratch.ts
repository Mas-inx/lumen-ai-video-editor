/**
 * Scratch canvases by name (a layer, a mask, a nesting level's picture, a 3D
 * layer's flat render): reused frame after frame, and let go once a few seconds
 * of drawing haven't needed them — a nested timeline, an effect or a 3D
 * transition that's no longer on screen doesn't keep full-size pixels around.
 */

interface Scratch {
  canvas: HTMLCanvasElement
  /** The frame it was last asked for in. */
  frame: number
}

const pool = new Map<string, Scratch>()
const released = new Set<(canvas: HTMLCanvasElement) => void>()
let frame = 0

/** Frames a scratch canvas is kept for without being asked for: a few seconds of playback, an export's next stretch. */
export const SCRATCH_FRAMES = 300

/** The canvas called `name`, `w` × `h` pixels (its contents are whatever was drawn last). */
export function scratchCanvas(name: string, w: number, h: number) {
  let s = pool.get(name)
  if (!s) pool.set(name, (s = { canvas: document.createElement('canvas'), frame }))
  s.frame = frame
  if (s.canvas.width !== w || s.canvas.height !== h) {
    s.canvas.width = w
    s.canvas.height = h
  }
  return s.canvas
}

/** Called with each canvas that's let go (to drop what was made from it, like a texture). */
export function onScratchReleased(fn: (canvas: HTMLCanvasElement) => void) {
  released.add(fn)
  return () => void released.delete(fn)
}

/** One frame has been drawn: canvases `keep` frames haven't asked for are emptied and let go. */
export function sweepScratch(keep = SCRATCH_FRAMES) {
  frame++
  for (const [name, s] of pool) {
    if (frame - s.frame <= keep) continue
    pool.delete(name)
    released.forEach((fn) => fn(s.canvas))
    // Empty now rather than whenever it's collected.
    s.canvas.width = 0
    s.canvas.height = 0
  }
}
