import { describe, expect, it } from 'vitest'
import { toGbr, toI420, toI444, yuvToRgb } from './ingest-convert'

/** Y′CbCr of one RGB colour, the textbook way (BT.709, limited range), before rounding. */
function exact(r: number, g: number, b: number) {
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return [16 + (219 * y) / 255, 128 + (224 * ((b - y) / 1.8556)) / 255, 128 + (224 * ((r - y) / 1.5748)) / 255]
}

const reference = (r: number, g: number, b: number) => exact(r, g, b).map(Math.round)

function pixels(colors: [number, number, number][], order: 'rgba' | 'bgra' = 'rgba') {
  const out = new Uint8Array(colors.length * 4)
  colors.forEach(([r, g, b], i) => out.set(order === 'rgba' ? [r, g, b, 7] : [b, g, r, 7], i * 4))
  return out
}

describe('frames to the master’s colour', () => {
  it('is the standard BT.709 conversion, to the code value', () => {
    const colors: [number, number, number][] = [
      [0, 0, 0],
      [255, 255, 255],
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [0, 64, 255],
      [128, 128, 128],
      [20, 24, 10],
    ]
    // Every colour of a coarse cube too.
    for (let r = 0; r < 256; r += 17) for (let g = 0; g < 256; g += 17) for (let b = 0; b < 256; b += 17) colors.push([r, g, b])
    while (colors.length % 2) colors.push([1, 2, 3])
    const n = colors.length
    const out = toI444(pixels(colors), n, 1, 'rgba', false)
    // The nearest code value to the true one (an exact half may round either way).
    let worst = 0
    colors.forEach(([r, g, b], i) => exact(r, g, b).forEach((want, plane) => (worst = Math.max(worst, Math.abs(out[plane * n + i] - want)))))
    expect(worst).toBeLessThanOrEqual(0.501)
    // Black and white land on the ends of the limited range, and grey has no colour.
    expect([out[0], out[n], out[2 * n]]).toEqual([16, 128, 128])
    expect([out[1], out[n + 1], out[2 * n + 1]]).toEqual([235, 128, 128])
  })

  it('comes back within two code values of every colour', () => {
    const colors: [number, number, number][] = []
    for (let r = 0; r < 256; r += 5) for (let g = 0; g < 256; g += 5) for (let b = 0; b < 256; b += 5) colors.push([r, g, b])
    const n = colors.length
    const out = toI444(pixels(colors), n, 1, 'rgba', false)
    let worst = 0
    colors.forEach(([r, g, b], i) => {
      const [rr, gg, bb] = yuvToRgb(out[i], out[n + i], out[2 * n + i])
      worst = Math.max(worst, Math.abs(rr - r), Math.abs(gg - g), Math.abs(bb - b))
    })
    expect(worst).toBeLessThanOrEqual(2)
  })

  it('reads BGRA and bottom-up frames', () => {
    // A 2×2 frame: red, green on top; blue, white below.
    const top: [number, number, number][] = [
      [255, 0, 0],
      [0, 255, 0],
    ]
    const bottom: [number, number, number][] = [
      [0, 0, 255],
      [255, 255, 255],
    ]
    const want = toI444(pixels([...top, ...bottom]), 2, 2, 'rgba', false)
    expect(toI444(pixels([...top, ...bottom], 'bgra'), 2, 2, 'bgra', false)).toEqual(want)
    expect(toI444(pixels([...bottom, ...top]), 2, 2, 'rgba', true)).toEqual(want)
    expect(toI444(pixels([...bottom, ...top], 'bgra'), 2, 2, 'bgra', true)).toEqual(want)
  })

  it('keeps RGB as it is for lossless masters, as green, blue, red planes', () => {
    const colors: [number, number, number][] = [
      [0, 64, 255],
      [1, 2, 3],
      [255, 254, 253],
      [17, 0, 200],
    ]
    const want = new Uint8Array([64, 2, 254, 0, 255, 3, 253, 200, 0, 1, 255, 17])
    expect(toGbr(pixels(colors), 2, 2, 'rgba', false)).toEqual(want)
    expect(toGbr(pixels(colors, 'bgra'), 2, 2, 'bgra', false)).toEqual(want)
    // Bottom-up: the rows swap, the pixels in them don't.
    expect(toGbr(pixels([colors[2], colors[3], colors[0], colors[1]]), 2, 2, 'rgba', true)).toEqual(want)
  })

  it('averages each 2×2 block for half-resolution colour', () => {
    const block: [number, number, number][] = [
      [200, 40, 40],
      [100, 40, 40],
      [200, 80, 40],
      [100, 80, 40],
    ]
    const out = toI420(pixels(block), 2, 2, 'rgba', false)
    expect(out).toHaveLength(6)
    expect([...out.slice(0, 4)]).toEqual(block.map(([r, g, b]) => reference(r, g, b)[0]))
    const [, cb, cr] = reference(150, 60, 40)
    expect([out[4], out[5]]).toEqual([cb, cr])
    // Bottom-up gives the same picture.
    expect(toI420(pixels([block[2], block[3], block[0], block[1]]), 2, 2, 'rgba', true)).toEqual(out)
  })
})
