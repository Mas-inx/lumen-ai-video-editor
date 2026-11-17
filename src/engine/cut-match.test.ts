import { beforeEach, describe, expect, it } from 'vitest'
import { createEmptyProject } from '@/editor/new-project'
import { effectParamsDoc, isSmartTransition, TRANSITIONS } from '@/editor/presets'
import { dispatch, getProject, useEditor } from '@/editor/store'
import { beatTiming, blockFlow, chooseTransition, decodeFlow, encodeFlow, flowMagnitude, smoothFlow, whipDirection, type CutReading } from './cut-match'
import type { Gray } from './tracker'

/** A random texture (a seeded noise, softened) — something block matching can lock onto. */
function texture(w: number, h: number, seed = 7): Gray {
  let s = seed
  const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  const raw = Float32Array.from({ length: w * h }, () => rand() * 255)
  const data = new Float32Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let sum = 0
      let n = 0
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = Math.min(w - 1, Math.max(0, x + dx))
          const yy = Math.min(h - 1, Math.max(0, y + dy))
          sum += raw[yy * w + xx]
          n++
        }
      data[y * w + x] = sum / n
    }
  return { data, width: w, height: h }
}

/** `g` with its content moved by (dx, dy) pixels. */
function shifted(g: Gray, dx: number, dy: number): Gray {
  const data = new Float32Array(g.data.length)
  for (let y = 0; y < g.height; y++)
    for (let x = 0; x < g.width; x++) {
      const sx = Math.min(g.width - 1, Math.max(0, x - dx))
      const sy = Math.min(g.height - 1, Math.max(0, y - dy))
      data[y * g.width + x] = g.data[sy * g.width + sx]
    }
  return { data, width: g.width, height: g.height }
}

describe('reading a cut', () => {
  it('finds where the outgoing frame’s content is in the incoming one', () => {
    const a = texture(192, 108)
    const b = shifted(a, 9, -5)
    const { flow, confidence } = blockFlow(a, b)
    expect(confidence).toBeGreaterThan(0.6)
    // The middle of the field (edges lose content off the frame, and borrow from their neighbours).
    const median = (c: 0 | 1) => {
      const v: number[] = []
      for (let k = c; k < flow.length; k += 2) v.push(flow[k])
      return v.sort((p, q) => p - q)[v.length >> 1]
    }
    expect(median(0)).toBeCloseTo(9 / 192, 2)
    expect(median(1)).toBeCloseTo(-5 / 108, 2)
    // A frame against itself doesn't move.
    expect(flowMagnitude(blockFlow(a, a).flow)).toBeLessThan(0.002)
  })

  it('fills cells nothing matched in from their neighbours, and caps long moves', () => {
    const cols = 4
    const rows = 3
    const raw = new Float32Array(cols * rows * 2)
    const good = new Uint8Array(cols * rows).fill(1)
    for (let k = 0; k < raw.length; k += 2) raw[k] = 0.05
    good[5] = 0
    raw[10] = 0
    const out = smoothFlow(raw, good, cols, rows)
    expect(out[10]).toBeCloseTo(0.05, 3)
    const far = smoothFlow(new Float32Array(raw.length).fill(0.9), new Uint8Array(cols * rows).fill(1), cols, rows)
    expect(Math.hypot(far[0], far[1])).toBeLessThanOrEqual(0.3001)
  })

  it('keeps a flow field exactly through the project', () => {
    const f = Float32Array.from([0.01, -0.02, 0.125, 0.3])
    expect(Array.from(decodeFlow(encodeFlow(f)))).toEqual(Array.from(f))
  })
})

describe('choosing a transition', () => {
  const still: CutReading = { motion: { x: 0, y: 0 }, flowConfidence: 0.3, flowMagnitude: 0.2, colorDistance: 0.02, fromConfidence: 0.1, toConfidence: 0.1 }
  it('carries motion on, melts matching frames, bridges colours, zooms between subjects', () => {
    expect(chooseTransition({ ...still, motion: { x: 0.6, y: 0.05 } }).kind).toBe('whip')
    expect(chooseTransition({ ...still, flowConfidence: 0.8, flowMagnitude: 0.04 }).kind).toBe('morph')
    expect(chooseTransition({ ...still, colorDistance: 0.15 }).kind).toBe('match')
    expect(chooseTransition({ ...still, fromConfidence: 0.6, toConfidence: 0.5 }).kind).toBe('through')
    expect(chooseTransition(still).kind).toBe('luma')
    for (const r of [still, { ...still, motion: { x: 1, y: 0 } }]) expect(chooseTransition(r).reason.length).toBeGreaterThan(10)
  })

  it('whips across or down, the way the camera goes', () => {
    expect(whipDirection({ x: -0.8, y: 0.2 })).toEqual([-1, 0])
    expect(whipDirection({ x: 0.1, y: 0.7 })).toEqual([0, 1])
    expect(whipDirection(undefined)).toEqual([1, 0])
  })
})

describe('timing to the music', () => {
  const beats = [0, 15, 30, 45, 60, 75]
  it('swaps the shots on a beat without moving the cut', () => {
    // A beat on the cut: centred, a beat long.
    expect(beatTiming(31, beats, 30)).toEqual({ duration: 15, align: 'center', beat: 30 })
    // A beat after the cut: starts at the cut, its middle on the beat.
    const after = beatTiming(38, [0, 45, 90], 30)!
    expect(after.align).toBe('after')
    expect(38 + after.duration / 2).toBeCloseTo(45, 0)
    // A beat before the cut: ends at it.
    expect(beatTiming(52, [0, 45, 90], 30)!.align).toBe('before')
    // Nothing near enough: left alone.
    expect(beatTiming(70, [0, 140], 30)).toBeNull()
    expect(beatTiming(10, [], 30)).toBeNull()
  })
})

describe('smart transitions and particles in the project', () => {
  beforeEach(() => useEditor.getState().loadProject(createEmptyProject('Smart')))

  it('are listed, take their reading, and refuse a malformed one', () => {
    expect(TRANSITIONS.filter((t) => t.smart).map((t) => t.kind)).toEqual(['morph', 'through', 'whip', 'luma', 'match'])
    expect(isSmartTransition('morph')).toBe(true)
    expect(isSmartTransition('dissolve')).toBe(false)
    const p = getProject()
    const main = p.tracks.find((t) => t.role === 'main')!.id
    const source = { type: 'file' as const, url: 'lumen-media://local/a.png', fileName: 'a.png', mime: 'image/png', size: 1 }
    dispatch('asset.add', { asset: { id: 'a1', name: 'One', kind: 'image', width: 1920, height: 1080, source, addedAt: 0 } })
    dispatch('clip.add', { trackId: main, kind: 'image', assetId: 'a1', start: 0, duration: 60 })
    const second = (dispatch('clip.add', { trackId: main, kind: 'image', assetId: 'a1', start: 60, duration: 60 }) as { result: string }).result
    const match = { from: { x: 0.3, y: 0.4 }, to: { x: 0.6, y: 0.5 }, motion: { x: 0.5, y: 0 }, flow: { w: 2, h: 2, data: encodeFlow(new Float32Array(8)) } }
    expect(dispatch('clip.setTransition', { id: second, transition: { kind: 'morph', duration: 20, match } }).ok).toBe(true)
    expect(getProject().clips[second].transitionIn?.match?.from).toEqual({ x: 0.3, y: 0.4 })
    expect(dispatch('clip.setTransition', { id: second, transition: { kind: 'whip', duration: 20, match: { flow: { w: 1000, h: 2, data: '' } } } }).ok).toBe(false)
    // Particles are an effect like the others.
    expect(dispatch('effect.add', { ids: [second], kind: 'particles', params: { style: 'snow' } }).ok).toBe(true)
    expect(effectParamsDoc()).toContain('particles {')
  })
})
