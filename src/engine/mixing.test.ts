import { beforeEach, describe, expect, it } from 'vitest'
import { createEmptyProject } from '@/editor/new-project'
import { dispatch, getProject, useEditor } from '@/editor/store'
import { crossfades } from './audio-engine'
import { eqResponse } from './eq-response'
import { LoudnessMeter, measureLoudness } from './loudness'
import { autoMakeupDb } from './mixer'
import { DEFAULT_EQ } from '@/editor/defaults'

const trackId = (name: string) => getProject().tracks.find((t) => t.name === name)!.id

beforeEach(() => useEditor.getState().loadProject(createEmptyProject('Mix')))

describe('mix.update', () => {
  it('sets levels and adds, edits and removes processors', () => {
    const voice = trackId('Voice')
    dispatch('mix.update', { target: voice, patch: { volume: -6, pan: -0.25 } })
    dispatch('mix.update', { target: voice, patch: { eq: { lowCut: 80 } } })
    const mix = () => getProject().tracks.find((t) => t.id === voice)!.mix!
    expect(mix()).toMatchObject({ volume: -6, pan: -0.25, eq: { ...DEFAULT_EQ, lowCut: 80 } })
    dispatch('mix.update', { target: voice, patch: { eq: { midGain: 3 }, compressor: { threshold: -20 } } })
    expect(mix().eq).toMatchObject({ lowCut: 80, midGain: 3 })
    expect(mix().compressor).toMatchObject({ enabled: true, threshold: -20, ratio: 3 })
    dispatch('mix.update', { target: voice, patch: { eq: null } })
    expect(mix().eq).toBeUndefined()
    expect(useEditor.getState().past.at(-1)?.label).toBe('Edit EQ · Voice')
  })

  it('mixes the master bus', () => {
    dispatch('mix.update', { target: 'master', patch: { limiter: { ceiling: -2 } } })
    expect(getProject().master).toMatchObject({ volume: 0, pan: 0, limiter: { enabled: true, ceiling: -2 } })
  })

  it('rejects out-of-range values', () => {
    expect(dispatch('mix.update', { target: 'master', patch: { volume: 40 } }).ok).toBe(false)
    expect(dispatch('mix.update', { target: 'nope', patch: { volume: 0 } }).ok).toBe(false)
  })
})

describe('eqResponse', () => {
  const at = (eq: Partial<typeof DEFAULT_EQ>, f: number) => eqResponse({ ...DEFAULT_EQ, ...eq }, [f])[0]

  it('is flat with every band at 0 dB', () => {
    for (const f of [20, 100, 1000, 10000, 20000]) expect(Math.abs(at({}, f))).toBeLessThan(0.01)
  })

  it('shelves and bells land where they should', () => {
    expect(at({ lowGain: 6, lowFreq: 200 }, 20)).toBeCloseTo(6, 0)
    expect(Math.abs(at({ lowGain: 6, lowFreq: 200 }, 10000))).toBeLessThan(0.2)
    expect(at({ midGain: -9, midFreq: 1000 }, 1000)).toBeCloseTo(-9, 1)
    expect(at({ highGain: 4, highFreq: 5000 }, 18000)).toBeCloseTo(4, 0)
  })

  it('the low cut is a flat Butterworth: −3 dB at the corner, steep below', () => {
    expect(at({ lowCut: 100 }, 100)).toBeCloseTo(-3, 0)
    expect(at({ lowCut: 100 }, 25)).toBeLessThan(-20)
    expect(Math.abs(at({ lowCut: 100 }, 1000))).toBeLessThan(0.1)
  })
})

describe('LoudnessMeter', () => {
  it('measures a stream in blocks exactly as it measures the whole', () => {
    const rate = 48000
    const n = rate * 12
    const x = new Float32Array(n)
    for (let i = 0; i < n; i++) x[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / rate) * (i % rate < rate * 0.7 ? 1 : 0.1)
    const whole = measureLoudness([x, x], rate)
    const meter = new LoudnessMeter(rate)
    for (let i = 0; i < n; i += 37_123) meter.push([x.subarray(i, i + 37_123), x.subarray(i, i + 37_123)])
    const streamed = meter.result()
    expect(streamed.lufs).toBeCloseTo(whole.lufs!, 6)
    expect(streamed.shortTermMax).toBeCloseTo(whole.shortTermMax!, 6)
    expect(streamed.peakDb).toBeCloseTo(whole.peakDb, 6)
  })
})

describe('autoMakeupDb', () => {
  it('matches the Web Audio compressor’s own make-up gain', () => {
    // Threshold −24, 4:1 → full scale comes out at −18 dB → make-up (1/0.126)^0.6 = +10.8 dB.
    expect(autoMakeupDb(-24, 4)).toBeCloseTo(10.8, 1)
    expect(autoMakeupDb(0, 4)).toBeCloseTo(0, 6)
  })
})

describe('crossfades', () => {
  it('a transition fades the next clip in and lets the one before ring out', () => {
    const voice = trackId('Voice')
    const a = (dispatch('clip.add', { trackId: voice, kind: 'audio', start: 0, duration: 60 }) as { result: string }).result
    const b = (dispatch('clip.add', { trackId: voice, kind: 'audio', start: 60, duration: 60 }) as { result: string }).result
    dispatch('clip.setTransition', { id: b, transition: { kind: 'dissolve', duration: 12 } })
    const p = getProject()
    expect(crossfades(p, p.clips[a])).toEqual({ fadeIn: 0, tail: 12 })
    expect(crossfades(p, p.clips[b])).toEqual({ fadeIn: 12, tail: 0 })

    // Centred on the cut: half the fade is over the end of the first clip, half over the start of the second.
    dispatch('clip.setTransition', { id: b, transition: { kind: 'dissolve', duration: 12, align: 'center' } })
    expect(crossfades(getProject(), getProject().clips[a])).toEqual({ fadeIn: 0, tail: 6, outLead: 6 })
    expect(crossfades(getProject(), getProject().clips[b])).toEqual({ fadeIn: 6, tail: 0, inLead: 6 })
    // Before the cut: the first clip is out by the cut, the second comes in whole.
    dispatch('clip.setTransition', { id: b, transition: { kind: 'dissolve', duration: 12, align: 'before' } })
    expect(crossfades(getProject(), getProject().clips[a])).toEqual({ fadeIn: 0, tail: 0, outLead: 12 })
    expect(crossfades(getProject(), getProject().clips[b])).toEqual({ fadeIn: 0, tail: 0, inLead: 12 })
  })
})
