import { describe, expect, it } from 'vitest'
import { detectBeats } from './beats'

const RATE = 44100

/** A drum loop: a kick on every downbeat (4/4), a snare-ish hit on 2 and 4, hats on every beat, starting at `offset` seconds. */
function loop(bpm: number, seconds: number, offset = 0.1, seed = 3) {
  const out = new Float32Array(Math.round(seconds * RATE))
  let s = seed
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647 - 0.5
  const beat = 60 / bpm
  for (let i = 0; offset + i * beat < seconds - 0.3; i++) {
    const at = Math.round((offset + i * beat) * RATE)
    const kick = i % 4 === 0
    for (let k = 0; k < RATE * 0.18; k++) {
      const t = k / RATE
      let v = 0
      if (kick) v += Math.sin(2 * Math.PI * (55 + 80 * Math.exp(-t * 30)) * t) * Math.exp(-t * 12) * 0.9
      if (i % 2 === 1) v += rnd() * Math.exp(-t * 25) * 0.5
      v += rnd() * Math.exp(-t * 80) * 0.25
      if (at + k < out.length) out[at + k] += v
    }
  }
  return out
}

describe('beat detection', () => {
  it('finds the tempo, the beats and the downbeats of a 120 BPM loop', async () => {
    const grid = await detectBeats([loop(120, 24)], RATE)
    expect(grid.bpm).toBeGreaterThan(117)
    expect(grid.bpm).toBeLessThan(123)
    expect(grid.times.length).toBeGreaterThan(40)
    // Beats sit on the hits: 0.1 s + n × 0.5 s, within a frame or two.
    const offsets = grid.times.slice(2, -2).map((t) => Math.abs(((t - 0.1 + 0.25) % 0.5) - 0.25))
    expect(Math.max(...offsets)).toBeLessThan(0.035)
    // Downbeats are the kicks: 0.1 s + n × 2 s.
    const downs = grid.downbeats.slice(1, -1).map((t) => Math.abs(((t - 0.1 + 1) % 2) - 1))
    expect(Math.max(...downs)).toBeLessThan(0.05)
    expect(grid.confidence).toBeGreaterThan(0.3)
  })

  it('follows other tempos', async () => {
    const grid = await detectBeats([loop(97, 30, 0.37)], RATE)
    expect(Math.abs(grid.bpm - 97)).toBeLessThan(2.5)
  })

  it('is not confident about noise', async () => {
    let s = 9
    const noise = Float32Array.from({ length: RATE * 12 }, () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 0.3)
    const grid = await detectBeats([noise], RATE)
    expect(grid.confidence).toBeLessThan(0.5)
  })
})
