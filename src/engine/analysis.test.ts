import { describe, expect, it } from 'vitest'
import { contentDelta, cutsFromScores, sceneThresholds, toHsv } from './scenes'
import { crossCorrelate, envelopeOffset, onsetEnvelope, refineOffset } from './sync'
import { followPatch, frameMotion, type Gray } from './tracker'

/** Deterministic noise. */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

/** A smooth random texture (value noise), sampled at any point — so shifted and turned views of it can be made. */
function texture(seed: number, cell = 6) {
  const r = rng(seed)
  const grid = new Float32Array(256 * 256).map(() => r() * 255)
  const at = (x: number, y: number) => grid[(((y % 256) + 256) % 256) * 256 + (((x % 256) + 256) % 256)]
  return (x: number, y: number) => {
    const gx = x / cell
    const gy = y / cell
    const x0 = Math.floor(gx)
    const y0 = Math.floor(gy)
    const fx = gx - x0
    const fy = gy - y0
    const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx
    const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx
    return top * (1 - fy) + bottom * fy
  }
}

function image(width: number, height: number, fn: (x: number, y: number) => number): Gray {
  const data = new Float32Array(width * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = fn(x, y)
  return { data, width, height }
}

describe('scene detection', () => {
  it('measures colour change between frames', () => {
    const red = new Uint8ClampedArray([255, 0, 0, 255, 255, 0, 0, 255])
    const blue = new Uint8ClampedArray([0, 0, 255, 255, 0, 0, 255, 255])
    expect(contentDelta(toHsv(red), toHsv(red))).toBe(0)
    // Hue 0 vs 120 (a third of the wheel), same saturation and value.
    expect(contentDelta(toHsv(red), toHsv(blue))).toBeCloseTo(60 / 3 + 0, 5)
  })

  it('finds jumps well above their neighbours, not steady motion', () => {
    const r = rng(3)
    const scores = Array.from({ length: 300 }, (_, i) => (i === 0 ? 0 : 4 + r() * 3))
    // Cuts at 50 and 180; a long burst of fast motion (high but steady) from 100 to 140.
    scores[50] = 60
    scores[180] = 40
    for (let i = 100; i < 140; i++) scores[i] = 30 + r() * 4
    const { ratio, minContent } = sceneThresholds(50)
    expect(cutsFromScores(scores, { ratio, minContent, minGap: 15 })).toEqual([50, 180])
    // Two cuts closer than the shortest shot count once.
    scores[185] = 50
    expect(cutsFromScores(scores, { ratio, minContent, minGap: 15 })).toEqual([50, 180])
  })
})

describe('audio sync', () => {
  it('cross-correlates like the direct sum', () => {
    const r = rng(7)
    const a = Float32Array.from({ length: 37 }, () => r() - 0.5)
    const b = Float32Array.from({ length: 11 }, () => r() - 0.5)
    const c = crossCorrelate(a, b)
    for (const k of [-10, -3, 0, 5, 26, 36]) {
      let s = 0
      for (let n = 0; n < b.length; n++) if (n + k >= 0 && n + k < a.length) s += a[n + k] * b[n]
      expect(c[k + b.length - 1]).toBeCloseTo(s, 9)
    }
  })

  it('finds how far one recording is from another by their sound', () => {
    const rate = 8000
    const r = rng(11)
    // A room: claps and speech-like bursts over noise, 30 s long.
    const room = new Float32Array(rate * 30)
    for (let i = 0; i < room.length; i++) room[i] = (r() - 0.5) * 0.01
    for (let k = 0; k < 40; k++) {
      const at = Math.floor(r() * (room.length - rate))
      const len = Math.floor(rate * (0.05 + r() * 0.3))
      for (let i = 0; i < len; i++) room[at + i] += Math.sin(i * 0.3 * (1 + k % 5)) * Math.exp(-i / (len / 3)) * 0.5
    }
    // Camera B started 3.217 s after camera A, recorded 20 s, quieter and noisier.
    const lag = Math.round(3.217 * rate)
    const b = new Float32Array(rate * 20)
    for (let i = 0; i < b.length; i++) b[i] = room[i + lag] * 0.3 + (r() - 0.5) * 0.004
    const coarse = envelopeOffset(onsetEnvelope(room, rate, 100), onsetEnvelope(b, rate, 100), 100)
    expect(Math.abs(coarse.offset - 3.217)).toBeLessThan(0.015)
    expect(coarse.confidence).toBeGreaterThan(8)
    const fine = refineOffset(onsetEnvelope(room, rate, 1000), onsetEnvelope(b, rate, 1000), 1000, coarse.offset, 0.03)
    expect(Math.abs(fine - 3.217)).toBeLessThan(0.003)
    // The other way round: A starts 3.217 s into B's timeline would be negative.
    const back = envelopeOffset(onsetEnvelope(b, rate, 100), onsetEnvelope(room, rate, 100), 100)
    expect(Math.abs(back.offset + 3.217)).toBeLessThan(0.015)
  })
})

describe('motion tracking', () => {
  it('follows a textured patch moving over a textured background', () => {
    const bg = texture(1, 9)
    const obj = texture(2, 3)
    const W = 320
    const H = 180
    const frames = Array.from({ length: 40 }, (_, i) => {
      // The object (a 30×30 square) moves right and down on a curve, with sub-pixel steps.
      const ox = 60 + i * 3.4
      const oy = 50 + 25 * Math.sin(i / 8)
      return {
        t: i / 30,
        gray: image(W, H, (x, y) => (x >= ox && x < ox + 30 && y >= oy && y < oy + 30 ? obj(x - ox, y - oy) : bg(x, y) * 0.8)),
        truth: [(ox + 15) / W, (oy + 15) / H],
      }
    })
    const box = { x: 75 / W, y: 65 / H, w: 30 / W, h: 30 / H }
    const path = followPatch(frames, box)
    expect(path).toHaveLength(40)
    for (let i = 0; i < 40; i += 7) {
      expect(Math.abs(path[i].x - frames[i].truth[0]) * W).toBeLessThan(1)
      expect(Math.abs(path[i].y - frames[i].truth[1]) * H).toBeLessThan(1)
    }
  })

  it('measures camera shift and turn, ignoring something moving on its own', () => {
    const scene = texture(5, 7)
    const W = 320
    const H = 180
    const view = (dx: number, dy: number, angle: number, walker?: number) =>
      image(W, H, (x, y) => {
        if (walker !== undefined && x > walker && x < walker + 40 && y > 60 && y < 120) return 255 - scene(x * 3, y * 3)
        // What the camera sees: the scene shifted and turned about the frame centre.
        const cx = x - W / 2
        const cy = y - H / 2
        const c = Math.cos(-angle)
        const s = Math.sin(-angle)
        return scene(cx * c - cy * s + W / 2 - dx, cx * s + cy * c + H / 2 - dy)
      })
    const m = frameMotion(view(0, 0, 0, 100), view(2.5, -1.5, 0.01, 110))
    expect(m.dx).toBeCloseTo(2.5, 0)
    expect(m.dy).toBeCloseTo(-1.5, 0)
    expect(m.angle).toBeCloseTo(0.01, 2)
    expect(m.used).toBeGreaterThan(20)
  })
})
