import { describe, expect, it } from 'vitest'
import { createClip } from '@/editor/defaults'
import { activeRegions, clipGainAt, computePeaks } from './audio-engine'
import { videoBitrate } from './export'
import { encodeWav } from './wav'

/** Just enough of an AudioBuffer for the analysis and encoding code. */
function buffer(channels: Float32Array[], sampleRate: number): AudioBuffer {
  const length = channels[0].length
  return {
    sampleRate,
    length,
    duration: length / sampleRate,
    numberOfChannels: channels.length,
    getChannelData: (c: number) => channels[c],
  } as unknown as AudioBuffer
}

/** Tone bursts over a quiet noise floor: `spans` are [start, end] seconds of sound. */
function speechLike(seconds: number, spans: [number, number][], sampleRate = 16000) {
  const data = new Float32Array(Math.round(seconds * sampleRate))
  let seed = 7
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.002
  for (let i = 0; i < data.length; i++) {
    const t = i / sampleRate
    const on = spans.some(([a, b]) => t >= a && t < b)
    data[i] = noise() + (on ? 0.4 * Math.sin(2 * Math.PI * 220 * t) : 0)
  }
  return buffer([data], sampleRate)
}

describe('activeRegions', () => {
  it('finds where the sound is, to within a couple of hops', () => {
    const regions = activeRegions(speechLike(8, [[0.5, 2], [3.4, 5], [5.2, 7]]))
    // The 0.2s gap is shorter than a pause, so the last two phrases merge.
    expect(regions).toHaveLength(2)
    const [[a0, b0], [a1, b1]] = regions
    expect(a0).toBeCloseTo(0.5, 1)
    expect(b0).toBeCloseTo(2, 1)
    expect(a1).toBeCloseTo(3.4, 1)
    expect(b1).toBeCloseTo(7, 1)
  })

  it('ignores clicks shorter than a syllable', () => {
    expect(activeRegions(speechLike(4, [[1, 1.05], [2, 3]]))).toHaveLength(1)
  })

  it('handles silence and empty buffers', () => {
    expect(activeRegions(buffer([new Float32Array(16000)], 16000))).toEqual([])
    expect(activeRegions(buffer([new Float32Array(10)], 16000))).toEqual([])
  })
})

describe('computePeaks', () => {
  it('normalizes peaks at 50 per second', () => {
    const peaks = computePeaks(speechLike(2, [[1, 2]]))
    expect(peaks).toHaveLength(100)
    expect(Math.max(...peaks)).toBe(1)
    expect(Math.max(...peaks.slice(0, 45))).toBeLessThan(0.05)
  })
})

describe('clipGainAt', () => {
  it('combines volume, keyframes and fades', () => {
    const clip = createClip({ kind: 'audio', trackId: 't', start: 0, duration: 100, audio: { volume: -6, fadeIn: 10, fadeOut: 20 } })
    expect(clipGainAt(clip, 50)).toBeCloseTo(0.501, 3)
    expect(clipGainAt(clip, 0)).toBe(0)
    expect(clipGainAt(clip, 5)).toBeCloseTo(0.2506, 3)
    expect(clipGainAt(clip, 90)).toBeCloseTo(0.2506, 3)
    clip.keyframes.volume = [{ frame: 0, value: -60, easing: 'linear' }]
    expect(clipGainAt(clip, 50)).toBe(0)
  })
})

describe('encodeWav', () => {
  it('writes a valid 16-bit PCM file, clipping out-of-range samples', () => {
    const l = Float32Array.from([0, 0.5, -1, 2])
    const r = Float32Array.from([0, -0.5, 1, -2])
    const bytes = encodeWav(buffer([l, r], 48000))
    const v = new DataView(bytes.buffer)
    const text = (o: number, n: number) => String.fromCharCode(...bytes.slice(o, o + n))
    expect(bytes.length).toBe(44 + 4 * 2 * 2)
    expect(text(0, 4)).toBe('RIFF')
    expect(text(8, 4)).toBe('WAVE')
    expect(text(36, 4)).toBe('data')
    expect(v.getUint32(4, true)).toBe(36 + 16)
    expect(v.getUint16(22, true)).toBe(2)
    expect(v.getUint32(24, true)).toBe(48000)
    expect(v.getUint32(28, true)).toBe(48000 * 4)
    const samples = Array.from({ length: 8 }, (_, i) => v.getInt16(44 + i * 2, true))
    expect(samples).toEqual([0, 0, 16383, -16384, -32768, 32767, 32767, -32768])
  })
})

describe('videoBitrate', () => {
  it('scales with pixels, frame rate, codec efficiency and quality', () => {
    const hd = videoBitrate(1920, 1080, 30, 'avc', 70)
    expect(hd).toBeGreaterThan(10_000_000)
    expect(hd).toBeLessThan(20_000_000)
    expect(videoBitrate(3840, 2160, 30, 'avc', 70)).toBeCloseTo(hd * 4, -3)
    expect(videoBitrate(1920, 1080, 60, 'avc', 70)).toBeGreaterThan(hd)
    expect(videoBitrate(1920, 1080, 60, 'avc', 70)).toBeLessThan(hd * 2)
    expect(videoBitrate(1920, 1080, 30, 'av1', 70)).toBeLessThan(videoBitrate(1920, 1080, 30, 'hevc', 70))
    expect(videoBitrate(1920, 1080, 30, 'avc', 100)).toBeGreaterThan(hd)
    // Quality is clamped to 10..100.
    expect(videoBitrate(1920, 1080, 30, 'avc', 500)).toBe(videoBitrate(1920, 1080, 30, 'avc', 100))
    expect(videoBitrate(1920, 1080, 30, 'avc', -5)).toBe(videoBitrate(1920, 1080, 30, 'avc', 10))
  })
})
