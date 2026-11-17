import { beforeEach, describe, expect, it } from 'vitest'
import { createEmptyProject } from './new-project'
import { reframe } from './smart'
import { dispatch, getProject, useEditor } from './store'
import { focusKey, focusOf, medianFocus, reframeOffset } from './subject-frame'

/** A soft grey-blue background with a textured, skin-toned subject centred at (sx, sy). */
function frame(w: number, h: number, sx: number, sy: number) {
  const rgba = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const bg = 90 + Math.round((y / h) * 30)
      rgba.set([bg - 10, bg, bg + 20, 255], i)
      const d = Math.hypot((x / w - sx) * (w / h), y / h - sy)
      if (d < 0.14) {
        const tex = (x * 7 + y * 13) % 5 < 2 ? 25 : 0
        rgba.set([205 - tex, 150 - tex, 120 - tex, 255], i)
      }
    }
  return rgba
}

describe('finding the subject', () => {
  it('finds a face-like subject off the centre, and is unsure of a flat picture', () => {
    const f = focusOf(frame(160, 90, 0.27, 0.45), 160, 90)
    expect(f.x).toBeGreaterThan(0.18)
    expect(f.x).toBeLessThan(0.36)
    expect(f.y).toBeGreaterThan(0.3)
    expect(f.y).toBeLessThan(0.6)
    expect(f.confidence).toBeGreaterThan(0.3)
    const flat = new Uint8ClampedArray(160 * 90 * 4).fill(128)
    expect(focusOf(flat, 160, 90).confidence).toBe(0)
  })

  it('takes the middle of several readings', () => {
    const m = medianFocus([
      { x: 0.3, y: 0.4, confidence: 0.8 },
      { x: 0.9, y: 0.5, confidence: 0.2 },
      { x: 0.32, y: 0.42, confidence: 0.7 },
    ])
    expect(m.x).toBe(0.32)
    expect(m.y).toBe(0.42)
  })
})

describe('placing a shot in a new frame', () => {
  const vertical = (x: number) => reframeOffset({ mediaW: 1920, mediaH: 1080, canvasW: 1080, canvasH: 1920, focus: { x, y: 0.5 } })

  it('moves the subject toward the middle without uncovering an edge', () => {
    expect(vertical(0.5).x).toBe(0)
    // The picture is 3413 px wide on a 1080 px canvas: a subject at a quarter moves right.
    const left = vertical(0.25)
    expect(left.x).toBeGreaterThan(800)
    expect(left.x).toBeLessThanOrEqual(Math.round((3413 - 1080) / 2) + 1)
    // As far as the picture allows, and no further.
    expect(vertical(0).x).toBe(vertical(0.05).x)
    expect(vertical(1).x).toBe(-vertical(0).x)
  })

  it('keeps shots of the same footage together across timelines', () => {
    expect(focusKey({ assetId: 'a', inPoint: 10, duration: 50, speed: 1 })).toBe(focusKey({ assetId: 'a', inPoint: 10, duration: 50, speed: 1 }))
  })
})

describe('reframing with subjects', () => {
  beforeEach(() => useEditor.getState().loadProject(createEmptyProject('Reframe')))

  it('places each shot by its subject, and centres shots it knows nothing about', () => {
    const p = getProject()
    const main = p.tracks.find((t) => t.role === 'main')!.id
    const source = { type: 'file' as const, url: 'lumen-media://local/a.mp4', fileName: 'a.mp4', mime: 'video/mp4', size: 1 }
    dispatch('asset.add', { asset: { id: 'a1', name: 'Interview', kind: 'video', duration: 10, width: 1920, height: 1080, source, addedAt: 0 } })
    const left = (dispatch('clip.add', { trackId: main, kind: 'video', assetId: 'a1', start: 0, duration: 60 }) as { result: string }).result
    const plain = (dispatch('clip.add', { trackId: main, kind: 'video', assetId: 'a1', start: 60, duration: 60, inPoint: 60 }) as { result: string }).result
    reframe(1080, 1920, 'user', (c) => (c.id === left ? { x: 0.3, y: 0.45 } : undefined))
    const after = getProject()
    expect(after.settings.width).toBe(1080)
    expect(after.clips[left].transform.x).toBeGreaterThan(400)
    expect(after.clips[plain].transform.x).toBe(0)
    expect(after.clips[left].transform.scale).toBeCloseTo(after.clips[plain].transform.scale, 6)
  })
})
