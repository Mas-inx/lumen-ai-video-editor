import { describe, expect, it } from 'vitest'
import { BeatInput } from './beats'

/** A few seconds of stereo noise at `rate`. */
function stereo(seconds: number, rate: number) {
  let s = 11
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647 - 0.5
  return [0, 1].map(() => Float32Array.from({ length: Math.round(seconds * rate) }, rnd))
}

describe('BeatInput', () => {
  it('gives the same samples fed a stretch at a time (a streamed file) as fed all at once', () => {
    for (const rate of [48000, 44100, 192000]) {
      const channels = stereo(3, rate)
      const whole = new BeatInput(rate)
      whole.push(channels)
      // Stretches that don't line up with the decimation step, as minute-long reads at 192 kHz don't.
      const parts = new BeatInput(rate)
      const cuts = [0, 1001, 50_003, 77_777, channels[0].length]
      for (let i = 0; i + 1 < cuts.length; i++) parts.push(channels.map((c) => c.subarray(cuts[i], cuts[i + 1])))
      expect(parts.rate).toBe(whole.rate)
      expect(Math.abs(parts.rate - 11025)).toBeLessThan(1200)
      expect(Array.from(parts.samples())).toEqual(Array.from(whole.samples()))
    }
  })

  it('mixes the channels down to one', () => {
    const input = new BeatInput(11025)
    input.push([Float32Array.of(1, 1, 0), Float32Array.of(0, -1, 0)])
    expect(Array.from(input.samples())).toEqual([0.5, 0, 0])
  })
})
