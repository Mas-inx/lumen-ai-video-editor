import { describe, expect, it, vi } from 'vitest'

vi.mock('@/engine/compositor', () => ({ clipSourceTime: (_c: unknown, local: number, fps: number) => local / fps }))

const { depthRange, normalizeDepth, steadyDepth } = await import('./depth')

describe('depth maps', () => {
  it('hold their range steady from frame to frame', () => {
    const frame = (scale: number) => Float32Array.from({ length: 1000 }, (_, i) => (i / 999) * scale)
    const first = depthRange(frame(10), null)
    expect(first[0]).toBeCloseTo(0.2, 0)
    expect(first[1]).toBeCloseTo(9.8, 0)
    // A frame whose prediction suddenly comes out twice as big moves the range only part of the way.
    const next = depthRange(frame(20), first)
    expect(next[1]).toBeGreaterThan(first[1])
    expect(next[1]).toBeLessThan(19.6 * 0.5 + first[1] * 0.5)
  })

  it('turn raw depth into a picture, nearer brighter', () => {
    const d = normalizeDepth(Float32Array.from([0, 5, 10, 20]), [0, 10])
    expect(Array.from(d)).toEqual([0, 128, 255, 255])
  })

  it('calm shimmer but keep real movement', () => {
    const prev = new Uint8Array([100, 100])
    const d = steadyDepth(new Uint8Array([110, 200]), prev)
    expect(d[0]).toBe(108)
    expect(d[1]).toBe(200)
  })
})
