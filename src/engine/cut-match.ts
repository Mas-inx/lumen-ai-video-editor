/**
 * Reading a cut for smart transitions: how the outgoing frame's content lines
 * up with the incoming one (a coarse flow field from block matching), which
 * transition suits the cut, and how to time it so the shots swap on a beat.
 * Pure maths on small grayscale frames, unit-tested.
 */
import type { TransitionAlign, TransitionKind } from '@/editor/types'
import { halve, Integral, makeTemplate, pyramidSearch, type Gray } from './tracker'

/** The flow field's cells across and down. */
export const FLOW_COLS = 24
export const FLOW_ROWS = 14

/** Longest a warp may move anything, as a fraction of the frame. */
const MAX_SHIFT = 0.3

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/**
 * Where each block of `a` is found in `b`: an offset per cell (x then y, as
 * fractions of the frame), smoothed so a warp along it stays fluid, and how
 * well the blocks matched on average (0..1). Blocks with nothing to match
 * (flat sky, black) or that match badly take their neighbours' offsets.
 */
export function blockFlow(a: Gray, b: Gray, cols = FLOW_COLS, rows = FLOW_ROWS): { flow: Float32Array; confidence: number } {
  const aHalf = halve(a)
  const bHalf = halve(b)
  const bI = new Integral(b)
  const bHalfI = new Integral(bHalf)
  // Blocks wider than a cell (they overlap): smaller ones are ambiguous at the coarse level of the search.
  const size = Math.max(16, Math.round(a.width / 12))
  const r = Math.max(6, Math.round(a.width * 0.2))
  const raw = new Float32Array(cols * rows * 2)
  const good = new Uint8Array(cols * rows)
  let scores = 0
  let tried = 0
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      const tx = clamp(Math.round(((i + 0.5) / cols) * a.width - size / 2), 0, a.width - size)
      const ty = clamp(Math.round(((j + 0.5) / rows) * a.height - size / 2), 0, a.height - size)
      const t = makeTemplate(a, tx, ty, size, size)
      if (!t) continue
      const th = makeTemplate(aHalf, tx / 2, ty / 2, size >> 1, size >> 1)
      const m = pyramidSearch(b, bI, bHalf, bHalfI, t, th, tx, ty, r)
      tried++
      scores += Math.max(0, m.score)
      if (!(m.score >= 0.35)) continue
      raw[(j * cols + i) * 2] = (m.x - tx) / a.width
      raw[(j * cols + i) * 2 + 1] = (m.y - ty) / a.height
      good[j * cols + i] = 1
    }
  return { flow: smoothFlow(raw, good, cols, rows), confidence: tried ? scores / tried : 0 }
}

/** Outliers out (a 3×3 median of the good cells), holes filled from their neighbours, then softened and capped. */
export function smoothFlow(raw: Float32Array, good: Uint8Array, cols: number, rows: number): Float32Array {
  const at = (i: number, j: number) => j * cols + i
  let field = new Float32Array(raw)
  // Median of each cell's good neighbourhood.
  const med = new Float32Array(field.length)
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      for (let c = 0; c < 2; c++) {
        const v: number[] = []
        for (let dj = -1; dj <= 1; dj++)
          for (let di = -1; di <= 1; di++) {
            const x = i + di
            const y = j + dj
            if (x < 0 || y < 0 || x >= cols || y >= rows || !good[at(x, y)]) continue
            v.push(field[at(x, y) * 2 + c])
          }
        med[at(i, j) * 2 + c] = v.length ? v.sort((p, q) => p - q)[v.length >> 1] : 0
      }
    }
  field = med
  // Cells nothing matched in take their neighbours' offsets, spreading in from the good ones.
  let known = new Uint8Array(good)
  for (let pass = 0; pass < Math.max(cols, rows); pass++) {
    let changed = false
    const next = new Uint8Array(known)
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        if (known[at(i, j)]) continue
        let sx = 0
        let sy = 0
        let n = 0
        for (let dj = -1; dj <= 1; dj++)
          for (let di = -1; di <= 1; di++) {
            const x = i + di
            const y = j + dj
            if (x < 0 || y < 0 || x >= cols || y >= rows || !known[at(x, y)]) continue
            sx += field[at(x, y) * 2]
            sy += field[at(x, y) * 2 + 1]
            n++
          }
        if (!n) continue
        field[at(i, j) * 2] = sx / n
        field[at(i, j) * 2 + 1] = sy / n
        next[at(i, j)] = 1
        changed = true
      }
    known = next
    if (!changed) break
  }
  // Two passes of a 3×3 box blur, then no offset longer than MAX_SHIFT.
  for (let pass = 0; pass < 2; pass++) {
    const out = new Float32Array(field.length)
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++)
        for (let c = 0; c < 2; c++) {
          let s = 0
          let n = 0
          for (let dj = -1; dj <= 1; dj++)
            for (let di = -1; di <= 1; di++) {
              const x = i + di
              const y = j + dj
              if (x < 0 || y < 0 || x >= cols || y >= rows) continue
              s += field[at(x, y) * 2 + c]
              n++
            }
          out[at(i, j) * 2 + c] = s / n
        }
    field = out
  }
  for (let k = 0; k < field.length; k += 2) {
    const len = Math.hypot(field[k], field[k + 1])
    if (len > MAX_SHIFT) {
      field[k] *= MAX_SHIFT / len
      field[k + 1] *= MAX_SHIFT / len
    }
    field[k] = Math.round(field[k] * 10000) / 10000
    field[k + 1] = Math.round(field[k + 1] * 10000) / 10000
  }
  return field
}

/** How far a flow field moves things on average (fractions of the frame). */
export function flowMagnitude(flow: Float32Array) {
  let s = 0
  for (let k = 0; k < flow.length; k += 2) s += Math.hypot(flow[k], flow[k + 1])
  return flow.length ? s / (flow.length / 2) : 0
}

/** A flow field as stored in a project (base64 float32) and back. */
export function encodeFlow(flow: Float32Array): string {
  const bytes = new Uint8Array(flow.buffer, flow.byteOffset, flow.byteLength)
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}

export function decodeFlow(data: string): Float32Array {
  const bin = atob(data)
  const bytes = new Uint8Array(bin.length - (bin.length % 4))
  for (let i = 0; i < bytes.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Float32Array(bytes.buffer)
}

/** What was read at a cut, for choosing its transition. */
export interface CutReading {
  /** The camera's motion around the cut, in frame heights a second. */
  motion: { x: number; y: number }
  /** How well the outgoing frame's blocks were found in the incoming one (0..1). */
  flowConfidence: number
  /** How far the flow field moves things on average (fractions of the frame). */
  flowMagnitude: number
  /** How far apart the shots are in colour and tone (0 = the same; see colorDistance). */
  colorDistance: number
  /** How clearly each shot has a subject (0..1). */
  fromConfidence: number
  toConfidence: number
}

/** The smart transition that suits a cut, and why. */
export function chooseTransition(r: CutReading): { kind: TransitionKind; reason: string } {
  const speed = Math.hypot(r.motion.x, r.motion.y)
  if (speed > 0.3) return { kind: 'whip', reason: `the camera is moving (${speed.toFixed(2)} frame heights a second), so a whip pan carries its motion on` }
  if (r.flowConfidence > 0.55 && r.flowMagnitude < 0.12) return { kind: 'morph', reason: 'the two frames line up closely, so one can melt into the other' }
  if (r.colorDistance > 0.09) return { kind: 'match', reason: 'the shots differ in colour, so the next one starts in this one’s colours and eases into its own' }
  if (r.fromConfidence > 0.35 && r.toConfidence > 0.35) return { kind: 'through', reason: 'both shots have a clear subject to zoom into and out of' }
  return { kind: 'luma', reason: 'nothing else ties the shots together, so the next one’s light leads in' }
}

/** The way a whip pan goes: the camera's direction, snapped to across or down (a whip is a pan or a tilt). */
export function whipDirection(motion?: { x: number; y: number }): [number, number] {
  if (!motion || Math.hypot(motion.x, motion.y) < 0.05) return [1, 0]
  return Math.abs(motion.x) >= Math.abs(motion.y) ? [Math.sign(motion.x), 0] : [0, Math.sign(motion.y)]
}

/**
 * Timing that lands the moment the shots swap — a transition's middle — on a
 * beat, without moving the cut: centred on the cut when a beat is right there
 * (one beat long), otherwise starting or ending at the cut and twice as long
 * as the distance to the beat. Null when no beat is near enough (frames).
 */
export function beatTiming(cut: number, beats: number[], fps: number): { duration: number; align: TransitionAlign; beat: number } | null {
  if (!beats.length) return null
  let nearest = beats[0]
  for (const b of beats) if (Math.abs(b - cut) < Math.abs(nearest - cut)) nearest = b
  const delta = nearest - cut
  const min = Math.round(0.3 * fps)
  const max = Math.round(1.2 * fps)
  if (Math.abs(delta) * 2 < min) {
    const i = beats.indexOf(nearest)
    const gap = beats.length > 1 ? (beats[Math.min(beats.length - 1, i + 1)] - beats[Math.max(0, i - 1)]) / (i > 0 && i < beats.length - 1 ? 2 : 1) : 0.6 * fps
    return { duration: clamp(Math.round(gap), min, max), align: 'center', beat: nearest }
  }
  if (Math.abs(delta) * 2 <= max) return { duration: Math.round(Math.abs(delta) * 2), align: delta > 0 ? 'after' : 'before', beat: nearest }
  return null
}
