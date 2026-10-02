import { beforeEach, describe, expect, it } from 'vitest'
import { previewScale, recordPlaybackDraw, resetAutoRes, useAutoRes } from './preview-res'

const BUDGET = 1000 / 30

describe('preview resolution', () => {
  beforeEach(() => resetAutoRes())

  it('uses the paused setting while paused and the fixed setting while playing', () => {
    expect(previewScale(0.25, 1, false)).toBe(1)
    expect(previewScale(0.25, 0.5, true)).toBe(0.25)
    expect(previewScale('auto', 0.5, false)).toBe(0.5)
  })

  it('auto steps down when drawing eats most of the frame', () => {
    for (let i = 0; i < 8; i++) recordPlaybackDraw(BUDGET * 0.8, 0, BUDGET, i * 33)
    expect(useAutoRes.getState().level).toBe(0.5)
    expect(previewScale('auto', 1, true)).toBe(0.5)
  })

  it('auto steps down when playback skips frames', () => {
    for (let i = 0; i < 8; i++) recordPlaybackDraw(2, 1, BUDGET, i * 33)
    expect(useAutoRes.getState().level).toBe(0.5)
  })

  it('auto never goes below a quarter', () => {
    for (let n = 0; n < 6; n++) for (let i = 0; i < 8; i++) recordPlaybackDraw(BUDGET, 3, BUDGET, n * 1000 + i * 33)
    expect(useAutoRes.getState().level).toBe(0.25)
  })

  it('auto steps back up after a few roomy seconds', () => {
    for (let i = 0; i < 8; i++) recordPlaybackDraw(BUDGET, 0, BUDGET, i * 33)
    expect(useAutoRes.getState().level).toBe(0.5)
    let t = 1000
    for (; t < 3500; t += 33) recordPlaybackDraw(1, 0, BUDGET, t)
    expect(useAutoRes.getState().level).toBe(0.5)
    for (; t < 5000; t += 33) recordPlaybackDraw(1, 0, BUDGET, t)
    expect(useAutoRes.getState().level).toBe(1)
  })
})
