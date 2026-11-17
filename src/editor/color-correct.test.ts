import { beforeEach, describe, expect, it } from 'vitest'
import {
  applyLevels,
  autoBalance,
  autoLevels,
  balanceFor,
  colorDistance,
  correctColor,
  correctionTable,
  correctPixels,
  hasCorrection,
  matchCurves,
  quantiles,
  samplePixels,
  toLinear,
  toSrgb,
} from './color-correct'
import { hasAdvancedGrade } from './color-math'
import { DEFAULT_COLOR } from './defaults'
import { createEmptyProject } from './new-project'
import { dispatch, getProject, useEditor } from './store'

/**
 * RGB samples (0..1) of a picture made by `f` over a grid of grey levels and
 * hues — neutral on average: every channel sees the same spread of colours.
 */
function picture(f: (r: number, g: number, b: number) => [number, number, number], n = 42) {
  const out: number[] = []
  const third = (Math.PI * 2) / 3
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const v = 0.05 + (0.85 * i) / (n - 1)
      const hue = (j / n) * Math.PI * 2
      const sat = 0.25
      const r = Math.min(1, Math.max(0, v * (1 + sat * Math.cos(hue))))
      const g = Math.min(1, Math.max(0, v * (1 + sat * Math.cos(hue - third))))
      const b = Math.min(1, Math.max(0, v * (1 + sat * Math.cos(hue + third))))
      out.push(...f(r, g, b))
    }
  return Float32Array.from(out)
}

/** A colour cast in linear light (like the wrong white balance on a camera). */
const cast = (k: [number, number, number]) => (r: number, g: number, b: number): [number, number, number] => [
  toSrgb(Math.min(1, toLinear(r) * k[0])),
  toSrgb(Math.min(1, toLinear(g) * k[1])),
  toSrgb(Math.min(1, toLinear(b) * k[2])),
]

const meanOf = (px: Float32Array) => {
  const m = [0, 0, 0]
  for (let i = 0; i < px.length; i += 3) for (let c = 0; c < 3; c++) m[c] += px[i + c]
  return m.map((v) => v / (px.length / 3))
}

describe('white balance', () => {
  it('makes a picked colour neutral and keeps its brightness', () => {
    const picked: [number, number, number] = [0.82, 0.74, 0.6]
    const balance = balanceFor(picked)
    const [r, g, b] = correctColor(picked, { balance })
    expect(Math.abs(r - g)).toBeLessThan(0.01)
    expect(Math.abs(g - b)).toBeLessThan(0.01)
    const y = (c: [number, number, number]) => 0.2126 * toLinear(c[0]) + 0.7152 * toLinear(c[1]) + 0.0722 * toLinear(c[2])
    expect(y([r, g, b])).toBeCloseTo(y(picked), 2)
    // A neutral pick changes nothing.
    expect(balanceFor([0.5, 0.5, 0.5])).toEqual({ r: 1, g: 1, b: 1 })
  })

  it('takes most of a colour cast out automatically, without going all the way', () => {
    const warm = picture(cast([1.25, 1, 0.7]))
    const gains = autoBalance(warm)
    expect(gains.b).toBeGreaterThan(1.1)
    expect(gains.r).toBeLessThan(1)
    const before = meanOf(warm)
    const after = meanOf(correctPixels(warm, { balance: gains }))
    expect(Math.abs(after[0] - after[2])).toBeLessThan(Math.abs(before[0] - before[2]) * 0.6)
    // A neutral picture stays as it is.
    const neutral = autoBalance(picture((r, g, b) => [r, g, b]))
    for (const k of ['r', 'g', 'b'] as const) expect(Math.abs(neutral[k] - 1)).toBeLessThan(0.04)
  })
})

describe('levels', () => {
  it('stretch flat footage toward black and white, gently', () => {
    const flat = picture((r, g, b) => [0.2 + r * 0.5, 0.2 + g * 0.5, 0.2 + b * 0.5])
    const l = autoLevels(flat)
    expect(l.black).toBeGreaterThan(0.1)
    expect(l.white).toBeLessThan(0.85)
    const [lo, hi] = quantiles(correctPixels(flat, { levels: l }), 3, [0.01, 0.99])
    expect(lo).toBeLessThan(0.12)
    expect(hi).toBeGreaterThan(0.85)
    expect(applyLevels(0.5, { black: 0, white: 1, gamma: 1 })).toBeCloseTo(0.5, 6)
    expect(applyLevels(0.5, { black: 0, white: 1, gamma: 2 })).toBeGreaterThan(0.6)
  })
})

describe('shot matching', () => {
  it('lines a shot up with a differently exposed, differently coloured reference', () => {
    const src = picture((r, g, b) => [r, g, b])
    const ref = picture((r, g, b) => [Math.min(1, 0.06 + r * 0.8), Math.min(1, 0.03 + g * 0.85), Math.min(1, 0.1 + b * 0.75)])
    const match = matchCurves(src, ref)
    for (const ch of [match.red, match.green, match.blue]) {
      expect(ch.length).toBeLessThanOrEqual(16)
      for (let i = 1; i < ch.length; i++) {
        expect(ch[i][0]).toBeGreaterThan(ch[i - 1][0])
        expect(ch[i][1]).toBeGreaterThanOrEqual(ch[i - 1][1])
      }
    }
    const before = colorDistance(src, ref)
    const after = colorDistance(correctPixels(src, { match }), ref)
    expect(after).toBeLessThan(before * 0.3)
  })
})

describe('the correction table', () => {
  it('is null when there is nothing to correct, and rises in every channel when there is', () => {
    expect(correctionTable(DEFAULT_COLOR)).toBeNull()
    expect(hasCorrection({ balance: { r: 1, g: 1, b: 1 } })).toBe(false)
    const t = correctionTable({ balance: { r: 1.2, g: 1, b: 0.8 }, levels: { black: 0.05, white: 0.95, gamma: 1.1 } })!
    for (let c = 0; c < 3; c++) for (let i = 1; i < 256; i++) expect(t[i * 3 + c]).toBeGreaterThanOrEqual(t[(i - 1) * 3 + c] - 1e-6)
    // Red got warmer than blue at middle grey.
    expect(t[128 * 3]).toBeGreaterThan(t[128 * 3 + 2])
  })

  it('samples only pixels you can see', () => {
    const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 0])
    expect(Array.from(samplePixels(rgba))).toEqual([1, 0, 0])
  })
})

describe('correction on clips', () => {
  beforeEach(() => useEditor.getState().loadProject(createEmptyProject('Correct')))
  const add = () => {
    const track = getProject().tracks.find((t) => t.kind === 'video')!.id
    return (dispatch('clip.add', { trackId: track, kind: 'adjustment', start: 0, duration: 30 }) as { result: string }).result
  }

  it('sets, merges and removes balance, levels and a match through clip.update', () => {
    const id = add()
    expect(dispatch('clip.update', { ids: [id], patch: { color: { balance: { b: 1.2 }, levels: { black: 0.04 } } } }).ok).toBe(true)
    const g = getProject().clips[id].color
    expect(g.balance).toEqual({ r: 1, g: 1, b: 1.2 })
    expect(g.levels).toEqual({ black: 0.04, white: 1, gamma: 1 })
    expect(hasAdvancedGrade(g) || hasCorrection(g)).toBe(true)
    const curve: [number, number][] = [
      [0, 0.02],
      [1, 0.97],
    ]
    dispatch('clip.update', { ids: [id], patch: { color: { match: { red: curve, green: curve, blue: curve, ref: 'other' } } } })
    expect(getProject().clips[id].color.match?.ref).toBe('other')
    dispatch('clip.update', { ids: [id], patch: { color: { balance: null, levels: null, match: null } } })
    const after = getProject().clips[id].color
    expect(after.balance).toBeUndefined()
    expect(after.levels).toBeUndefined()
    expect(after.match).toBeUndefined()
  })

  it('takes a lightening vignette and refuses out-of-range gains', () => {
    const id = add()
    expect(dispatch('clip.update', { ids: [id], patch: { color: { vignette: -40 } } }).ok).toBe(true)
    expect(getProject().clips[id].color.vignette).toBe(-40)
    expect(dispatch('clip.update', { ids: [id], patch: { color: { balance: { r: 9 } } } }).ok).toBe(false)
  })
})
