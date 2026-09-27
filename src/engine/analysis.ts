/**
 * Reading footage for analysis: every frame of a stretch of video, decoded
 * small (WebCodecs), as pixels — what scene detection, motion tracking and
 * stabilization look at.
 */
import { CanvasSink } from 'mediabunny'
import { openInput } from './decode'

export class AnalysisCancelled extends Error {
  constructor() {
    super('Cancelled')
  }
}

export interface ScannedFrame {
  /** Source seconds */
  t: number
  rgba: Uint8ClampedArray
  width: number
  height: number
}

/**
 * Decodes source seconds [from, to) of a video `width` pixels wide, frame by
 * frame, and hands each frame's RGBA pixels to `onFrame`. Returns the size used.
 */
export async function scanFrames(
  url: string,
  from: number,
  to: number,
  width: number,
  onFrame: (frame: ScannedFrame) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<{ width: number; height: number; frames: number }> {
  const input = openInput(url)
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track || !(await track.canDecode())) throw new Error('This video can’t be decoded here.')
    const w = Math.max(16, Math.round(Math.min(width, track.displayWidth) / 2) * 2)
    const h = Math.max(16, Math.round((w * track.displayHeight) / track.displayWidth / 2) * 2)
    const sink = new CanvasSink(track, { width: w, height: h, fit: 'fill', poolSize: 2 })
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    let frames = 0
    for await (const wrapped of sink.canvases(Math.max(0, from), to)) {
      if (signal?.aborted) throw new AnalysisCancelled()
      ctx.drawImage(wrapped.canvas, 0, 0)
      await onFrame({ t: wrapped.timestamp, rgba: ctx.getImageData(0, 0, w, h).data, width: w, height: h })
      frames++
      // Keep the editor responsive.
      if (frames % 8 === 0) await new Promise((r) => setTimeout(r, 0))
    }
    return { width: w, height: h, frames }
  } finally {
    input.dispose()
  }
}

/** Luma (0..255) of RGBA pixels. */
export function toGray(rgba: Uint8ClampedArray, out = new Float32Array(rgba.length / 4)) {
  for (let i = 0, j = 0; j < out.length; i += 4, j++) out[j] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]
  return out
}
