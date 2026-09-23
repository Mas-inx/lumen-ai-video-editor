import { describe, expect, it } from 'vitest'
import { measureLoudness } from './loudness'

function sine(seconds: number, dbfs: number, sampleRate = 48000, hz = 997) {
  const a = Math.pow(10, dbfs / 20)
  return Float32Array.from({ length: Math.round(seconds * sampleRate) }, (_, i) => a * Math.sin((2 * Math.PI * hz * i) / sampleRate))
}

describe('measureLoudness', () => {
  it('reads the EBU R128 reference tone: stereo 1 kHz at −23 dBFS is −23 LUFS', () => {
    const tone = sine(10, -23)
    const r = measureLoudness([tone, tone], 48000)
    expect(r.lufs).toBeCloseTo(-23, 1)
    expect(r.shortTermMax).toBeCloseTo(-23, 1)
    expect(r.peakDb).toBeCloseTo(-23, 1)
    expect(r.rmsDb).toBeCloseTo(-26.01, 1)
    expect(r.clipped).toBe(0)
    expect(r.seconds).toBe(10)
  })

  it('works at any sample rate', () => {
    const tone = sine(10, -23, 44100)
    expect(measureLoudness([tone, tone], 44100).lufs).toBeCloseTo(-23, 1)
  })

  it('counts a mono signal once (3 dB quieter than the same tone on both channels)', () => {
    expect(measureLoudness([sine(10, -23)], 48000).lufs).toBeCloseTo(-26.01, 1)
  })

  it('gates out silence, so pauses don’t drag the reading down', () => {
    const tone = sine(10, -20)
    const withPauses = new Float32Array(tone.length * 2)
    withPauses.set(tone, 0)
    const r = measureLoudness([withPauses, withPauses], 48000)
    // Half of it is silence: ungated it would read −23. The blocks straddling the cut still count.
    expect(r.lufs!).toBeGreaterThan(-20.2)
    expect(r.lufs!).toBeLessThan(-19.9)
  })

  it('reports silence as having no loudness', () => {
    const r = measureLoudness([new Float32Array(48000 * 2)], 48000)
    expect(r.lufs).toBeNull()
    expect(r.peakDb).toBe(-Infinity)
  })

  it('counts clipped samples', () => {
    const loud = sine(1, 3) // peaks above full scale, as a hot master would
    const clippedToFull = loud.map((v) => Math.max(-1, Math.min(1, v)))
    const r = measureLoudness([clippedToFull], 48000)
    expect(r.clipped).toBeGreaterThan(1000)
    expect(r.peakDb).toBeCloseTo(0, 5)
  })
})
