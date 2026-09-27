import { beforeEach, describe, expect, it } from 'vitest'
import { fontCss } from '@/engine/fonts'
import { curveTable, evalCurve, hasAdvancedGrade, wheelColor, wheelParams } from './color-math'
import { DEFAULT_COLOR, NEUTRAL_WHEELS } from './defaults'
import { parseCube } from './lut'
import { createEmptyProject } from './new-project'
import { dispatch, getProject, useEditor } from './store'

const trackId = (name: string) => getProject().tracks.find((t) => t.name === name)!.id
const add = (kind: 'video' | 'text' | 'adjustment', track = 'Overlay') => (dispatch('clip.add', { trackId: trackId(track), kind, start: 0, duration: 60 }) as { result: string }).result
const clip = (id: string) => getProject().clips[id]

beforeEach(() => useEditor.getState().loadProject(createEmptyProject('Grading')))

describe('curves', () => {
  it('pass through their points and never overshoot', () => {
    const pts: [number, number][] = [
      [0, 0],
      [0.25, 0.15],
      [0.75, 0.85],
      [1, 1],
    ]
    expect(evalCurve(pts, 0.25)).toBeCloseTo(0.15, 6)
    expect(evalCurve(pts, 0.75)).toBeCloseTo(0.85, 6)
    const t = curveTable(pts, 256)
    for (let i = 1; i < 256; i++) expect(t[i]).toBeGreaterThanOrEqual(t[i - 1] - 1e-6)
    // The identity stays the identity.
    expect(evalCurve([[0, 0], [1, 1]], 0.37)).toBeCloseTo(0.37, 6)
  })

  it('handle points out of order and flat stretches', () => {
    expect(evalCurve([[1, 1], [0, 0.2]], 0)).toBeCloseTo(0.2, 6)
    const flat: [number, number][] = [
      [0, 0],
      [0.4, 0.5],
      [0.6, 0.5],
      [1, 1],
    ]
    expect(evalCurve(flat, 0.5)).toBeCloseTo(0.5, 6)
  })
})

describe('wheels', () => {
  it('push colour without changing brightness, and neutral does nothing', () => {
    const [r, g, b] = wheelColor({ x: 1, y: 0, luma: 0 })
    expect(r + g + b).toBeCloseTo(0, 6)
    expect(r).toBeGreaterThan(0)
    const p = wheelParams(NEUTRAL_WHEELS)
    expect(p).toEqual({ lift: [0, 0, 0], gamma: [1, 1, 1], gain: [1, 1, 1] })
  })

  it('only advanced grades need the GPU', () => {
    expect(hasAdvancedGrade(DEFAULT_COLOR)).toBe(false)
    expect(hasAdvancedGrade({ ...DEFAULT_COLOR, wheels: NEUTRAL_WHEELS })).toBe(false)
    expect(hasAdvancedGrade({ ...DEFAULT_COLOR, hsl: { blue: { hue: 10, saturation: 0, luminance: 0 } } })).toBe(true)
  })
})

describe('parseCube', () => {
  it('reads a 3D LUT, red fastest, with its title', () => {
    const cube = `TITLE "Swap"\nLUT_3D_SIZE 2\n# red fastest\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n`
    const lut = parseCube(cube)
    expect(lut.title).toBe('Swap')
    expect(lut.size).toBe(2)
    expect([...lut.data.slice(3, 6)]).toEqual([255, 0, 0])
    expect([...lut.data.slice(21, 24)]).toEqual([255, 255, 255])
  })

  it('scales custom domains and turns 1D LUTs into cubes', () => {
    const lut = parseCube('LUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 2 2 2\n' + '2 2 2\n'.repeat(8))
    expect(lut.data[0]).toBe(255)
    const oneD = parseCube('LUT_1D_SIZE 2\n0 0 0\n0.5 0.5 0.5\n')
    expect(oneD.size).toBe(33)
    expect(oneD.data[oneD.data.length - 1]).toBe(128)
  })

  it('rejects files that aren’t LUTs', () => {
    expect(() => parseCube('hello')).toThrow()
    expect(() => parseCube('LUT_3D_SIZE 4\n0 0 0\n')).toThrow(/entries/)
  })
})

describe('grade commands', () => {
  it('merges curves and wheels and removes them with null', () => {
    const v = add('video')
    dispatch('clip.update', { ids: [v], patch: { color: { curves: { red: [[0, 0.1], [1, 1]] } } } })
    expect(clip(v).color.curves!.red).toEqual([[0, 0.1], [1, 1]])
    expect(clip(v).color.curves!.master).toEqual([[0, 0], [1, 1]])
    dispatch('clip.update', { ids: [v], patch: { color: { wheels: { gain: { x: 0.2, y: 0, luma: 0 } } } } })
    expect(clip(v).color.wheels!.lift).toEqual({ x: 0, y: 0, luma: 0 })
    dispatch('clip.update', { ids: [v], patch: { color: { curves: null, wheels: null } } })
    expect(clip(v).color.curves).toBeUndefined()
    expect(clip(v).color.wheels).toBeUndefined()
  })

  it('LUTs must be in the project, and removing one clears it from clips', () => {
    const v = add('video')
    expect(dispatch('clip.update', { ids: [v], patch: { color: { lut: { id: 'nope', amount: 1 } } } }).ok).toBe(false)
    expect(dispatch('lut.add', { lut: { name: 'Bad', size: 2, data: btoa('xx') } }).ok).toBe(false)
    const lut = (dispatch('lut.add', { lut: { name: 'Id', size: 2, data: btoa('\0'.repeat(24)) } }) as { result: string }).result
    dispatch('clip.update', { ids: [v], patch: { color: { lut: { id: lut, amount: 0.5 } } } })
    expect(clip(v).color.lut).toEqual({ id: lut, amount: 0.5 })
    dispatch('lut.remove', { id: lut })
    expect(clip(v).color.lut).toBeUndefined()
  })

  it('keys keep their settings, and updates merge into them', () => {
    const v = add('video')
    dispatch('effect.add', { ids: [v], kind: 'chromaKey' })
    const fx = () => clip(v).effects.find((e) => e.kind === 'chromaKey')!
    expect(fx().params).toMatchObject({ color: '#00d84a', tolerance: 32 })
    dispatch('effect.update', { clipId: v, effectId: fx().id, patch: { params: { tolerance: 50 } } })
    expect(fx().params).toMatchObject({ color: '#00d84a', tolerance: 50 })
  })

  it('masks are added, edited and removed', () => {
    const adj = add('adjustment')
    const m = (dispatch('mask.add', { clipId: adj, mask: { shape: 'rectangle', invert: true } }) as { result: string }).result
    expect(clip(adj).masks![0]).toMatchObject({ shape: 'rectangle', invert: true, x: 0.5, feather: 0.04 })
    dispatch('mask.update', { clipId: adj, maskId: m, patch: { x: 0.3, feather: 0.2 } })
    expect(clip(adj).masks![0]).toMatchObject({ x: 0.3, feather: 0.2 })
    dispatch('mask.remove', { clipId: adj, maskId: m })
    expect(clip(adj).masks).toBeUndefined()
  })
})

describe('fonts', () => {
  it('titles can use embedded fonts and fall back when one is removed', () => {
    const t = add('text', 'Titles')
    const f = (dispatch('font.add', { font: { name: 'Mine', family: 'Lumen Mine x', fileName: 'mine.ttf', data: 'AAAA' } }) as { result: string }).result
    expect(dispatch('clip.update', { ids: [t], patch: { text: { font: `custom:${f}` } } }).ok).toBe(true)
    expect(fontCss(clip(t).text!.font, getProject())).toMatch(/^"Lumen Mine x"/)
    expect(dispatch('clip.update', { ids: [t], patch: { text: { font: 'comic' as 'sans' } } }).ok).toBe(false)
    dispatch('font.remove', { id: f })
    expect(clip(t).text!.font).toBe('sans')
  })
})
