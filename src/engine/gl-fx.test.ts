import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_COLOR } from '@/editor/defaults'
import { createEmptyProject } from '@/editor/new-project'
import { EFFECTS, effectParamsDoc, fxNumber, fxString } from '@/editor/presets'
import { dispatch, getProject, useEditor } from '@/editor/store'
import { brightestIn, LEVELS, needsFx, pyramidWeights, rgbOf } from './gl-fx'

describe('the blur pyramid', () => {
  it('spreads the same light further as the radius grows', () => {
    for (const r of [0, 0.3, 0.7, 1]) {
      const w = pyramidWeights(r)
      expect(w).toHaveLength(LEVELS)
      expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6)
    }
    const peak = (w: number[]) => w.indexOf(Math.max(...w))
    expect(peak(pyramidWeights(0))).toBe(0)
    expect(peak(pyramidWeights(1))).toBe(LEVELS - 1)
    expect(peak(pyramidWeights(0.5))).toBeGreaterThan(peak(pyramidWeights(0.2)))
    // A shallower pyramid (halation) never reaches past its deepest level.
    expect(peak(pyramidWeights(1, 4))).toBe(4)
  })
})

describe('following the light', () => {
  it('finds the brightest spot, and says when there is none', () => {
    const w = 16
    const h = 9
    const rgba = new Uint8ClampedArray(w * h * 4)
    for (let i = 0; i < w * h; i++) rgba.set([30, 30, 30, 255], i * 4)
    for (const [x, y] of [
      [11, 2],
      [12, 2],
      [11, 3],
      [12, 3],
    ])
      rgba.set([255, 250, 240, 255], (y * w + x) * 4)
    const spot = brightestIn(rgba, w, h)
    expect(spot.x).toBeCloseTo(12 / 16, 2)
    expect(spot.y).toBeCloseTo(3 / 9, 2)
    expect(spot.v).toBeGreaterThan(0.95)
    expect(brightestIn(new Uint8ClampedArray(w * h * 4), w, h).v).toBe(0)
  })

  it('reads colours', () => {
    expect(rgbOf('#ff8000')).toEqual([1, 128 / 255, 0])
    expect(rgbOf('nonsense')).toEqual([1, 1, 1])
  })
})

describe('light effects', () => {
  beforeEach(() => useEditor.getState().loadProject(createEmptyProject('Light')))
  const add = () => {
    const track = getProject().tracks.find((t) => t.kind === 'video')!.id
    return (dispatch('clip.add', { trackId: track, kind: 'adjustment', start: 0, duration: 30 }) as { result: string }).result
  }

  it('start from their preset settings, and old effects keep how they looked', () => {
    const id = add()
    dispatch('effect.add', { ids: [id], kind: 'glow' })
    const glow = getProject().clips[id].effects[0]
    expect(fxNumber(glow, 'threshold')).toBe(55)
    // A glow saved before it had settings glows the whole picture, as it did.
    expect(fxNumber({ kind: 'glow' }, 'threshold')).toBe(0)
    expect(fxString({ kind: 'leak' }, 'style')).toBe('drift')
    expect(fxString({ kind: 'flare', params: { style: 'star' } }, 'style')).toBe('star')
    expect(fxNumber({ kind: 'rays' }, 'y')).toBeCloseTo(0.1)
  })

  it('every light effect can be added and documents its settings', () => {
    const id = add()
    for (const kind of ['halation', 'rays', 'flare', 'relight', 'leak', 'vignette'] as const) {
      expect(dispatch('effect.add', { ids: [id], kind }).ok).toBe(true)
      expect(effectParamsDoc()).toContain(`${kind} {`)
    }
    const clip = getProject().clips[id]
    expect(needsFx(clip)).toBe(true)
    expect(needsFx({ effects: [], color: DEFAULT_COLOR })).toBe(false)
    expect(needsFx({ effects: [], color: { ...DEFAULT_COLOR, vignette: -20 } })).toBe(true)
    for (const e of EFFECTS.filter((x) => x.controls))
      for (const c of e.controls!) if (c.type !== 'point' && c.type !== 'color' && c.type !== 'select' && c.type !== 'switch') expect(c.default).toBeGreaterThanOrEqual(c.min)
  })

  it('depth maps attach only as depth maps, and go away with their footage', () => {
    const p = getProject()
    const main = p.tracks.find((t) => t.role === 'main')!.id
    const source = { type: 'file' as const, url: 'lumen-media://local/a.mp4', fileName: 'a.mp4', mime: 'video/mp4', size: 1 }
    dispatch('asset.add', { asset: { id: 'a1', name: 'Shot', kind: 'video', duration: 4, source, addedAt: 0 } })
    dispatch('asset.add', { asset: { id: 'd1', name: 'Shot — depth map', kind: 'video', duration: 4, source, depthOf: { assetId: 'a1', from: 0, to: 4 }, addedAt: 0 } })
    const clipId = (dispatch('clip.add', { trackId: main, kind: 'video', assetId: 'a1', start: 0, duration: 60 }) as { result: string }).result
    expect(dispatch('clip.update', { ids: [clipId], patch: { depth: { assetId: 'a1', from: 0 } } }).ok).toBe(false)
    expect(dispatch('clip.update', { ids: [clipId], patch: { depth: { assetId: 'd1', from: 0 } } }).ok).toBe(true)
    dispatch('asset.remove', { ids: ['a1'] })
    expect(getProject().assets.d1).toBeUndefined()
  })
})
