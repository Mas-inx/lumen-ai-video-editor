/**
 * Raw frames to the encoder's colour: 8-bit RGBA (or BGRA) to Y′CbCr, BT.709,
 * limited range — the exact, standard conversion, done here so the result
 * never depends on what an encoder would have picked. Fixed-point with 20
 * fractional bits: every sample is the true value rounded to the nearest code
 * (within a thousandth of a code at exact halves).
 */

const KR = 0.2126
const KB = 0.0722
const KG = 1 - KR - KB
const S = 20
const ONE = 1 << S
const fixed = (k: number) => Math.round(k * ONE)

// Luma spans 16..235 and chroma 16..240 of the 8-bit range.
const Y_SCALE = 219 / 255
const C_SCALE = 224 / 255
const YR = fixed(KR * Y_SCALE)
const YG = fixed(KG * Y_SCALE)
const YB = fixed(KB * Y_SCALE)
const UR = fixed((-KR / (2 * (1 - KB))) * C_SCALE)
const UG = fixed((-KG / (2 * (1 - KB))) * C_SCALE)
const UB = fixed(0.5 * C_SCALE)
const VR = fixed(0.5 * C_SCALE)
const VG = fixed((-KG / (2 * (1 - KR))) * C_SCALE)
const VB = fixed((-KB / (2 * (1 - KR))) * C_SCALE)
const Y_OFFSET = 16 * ONE + (ONE >> 1)
const C_OFFSET = 128 * ONE + (ONE >> 1)

export type RawOrder = 'rgba' | 'bgra'

/** Pixels as 32-bit words when the bytes line up (one read a pixel instead of three). */
function words(src: Uint8Array, pixels: number) {
  if (src.byteOffset % 4 === 0) return new Uint32Array(src.buffer, src.byteOffset, pixels)
  const copy = new Uint8Array(pixels * 4)
  copy.set(src.subarray(0, pixels * 4))
  return new Uint32Array(copy.buffer)
}

export const i444Size = (width: number, height: number) => width * height * 3
export const i420Size = (width: number, height: number) => width * height + 2 * (width >> 1) * (height >> 1)

/**
 * Full colour resolution: planes Y, Cb, Cr, each width × height. `flip` reads
 * the rows bottom-up (frames read straight from WebGL). Alpha is ignored.
 */
export function toI444(src: Uint8Array, width: number, height: number, order: RawOrder, flip: boolean, out = new Uint8Array(i444Size(width, height))) {
  const n = width * height
  const px = words(src, n)
  const rShift = order === 'rgba' ? 0 : 16
  const bShift = order === 'rgba' ? 16 : 0
  let o = 0
  for (let y = 0; y < height; y++) {
    let i = (flip ? height - 1 - y : y) * width
    for (const end = i + width; i < end; i++, o++) {
      const v = px[i]
      const r = (v >>> rShift) & 255
      const g = (v >>> 8) & 255
      const b = (v >>> bShift) & 255
      out[o] = (YR * r + YG * g + YB * b + Y_OFFSET) >> S
      out[n + o] = (UR * r + UG * g + UB * b + C_OFFSET) >> S
      out[2 * n + o] = (VR * r + VG * g + VB * b + C_OFFSET) >> S
    }
  }
  return out
}

/**
 * The pixels as they are, in the plane order VP9 uses for RGB: green, blue,
 * red. Nothing is converted, so with a lossless encoder nothing is lost.
 */
export function toGbr(src: Uint8Array, width: number, height: number, order: RawOrder, flip: boolean, out = new Uint8Array(i444Size(width, height))) {
  const n = width * height
  const px = words(src, n)
  const rShift = order === 'rgba' ? 0 : 16
  const bShift = order === 'rgba' ? 16 : 0
  let o = 0
  for (let y = 0; y < height; y++) {
    let i = (flip ? height - 1 - y : y) * width
    for (const end = i + width; i < end; i++, o++) {
      const v = px[i]
      out[o] = (v >>> 8) & 255
      out[n + o] = (v >>> bShift) & 255
      out[2 * n + o] = (v >>> rShift) & 255
    }
  }
  return out
}

/** Half colour resolution: Y at full size, Cb and Cr from the average of each 2×2 block. Width and height must be even. */
export function toI420(src: Uint8Array, width: number, height: number, order: RawOrder, flip: boolean, out = new Uint8Array(i420Size(width, height))) {
  const n = width * height
  const px = words(src, n)
  const rShift = order === 'rgba' ? 0 : 16
  const bShift = order === 'rgba' ? 16 : 0
  const cw = width >> 1
  const ch = height >> 1
  let o = 0
  for (let y = 0; y < height; y++) {
    let i = (flip ? height - 1 - y : y) * width
    for (const end = i + width; i < end; i++, o++) {
      const v = px[i]
      out[o] = (YR * ((v >>> rShift) & 255) + YG * ((v >>> 8) & 255) + YB * ((v >>> bShift) & 255) + Y_OFFSET) >> S
    }
  }
  let u = n
  let vAt = n + cw * ch
  for (let y = 0; y < ch; y++) {
    const top = (flip ? height - 1 - 2 * y : 2 * y) * width
    const bottom = (flip ? height - 2 - 2 * y : 2 * y + 1) * width
    for (let x = 0; x < cw; x++, u++, vAt++) {
      const a = px[top + 2 * x]
      const b = px[top + 2 * x + 1]
      const c = px[bottom + 2 * x]
      const d = px[bottom + 2 * x + 1]
      const r = (((a >>> rShift) & 255) + ((b >>> rShift) & 255) + ((c >>> rShift) & 255) + ((d >>> rShift) & 255) + 2) >> 2
      const g = (((a >>> 8) & 255) + ((b >>> 8) & 255) + ((c >>> 8) & 255) + ((d >>> 8) & 255) + 2) >> 2
      const bl = (((a >>> bShift) & 255) + ((b >>> bShift) & 255) + ((c >>> bShift) & 255) + ((d >>> bShift) & 255) + 2) >> 2
      out[u] = (UR * r + UG * g + UB * bl + C_OFFSET) >> S
      out[vAt] = (VR * r + VG * g + VB * bl + C_OFFSET) >> S
    }
  }
  return out
}

/** The exact inverse, for checks: one Y′CbCr sample (limited range) back to 8-bit RGB. */
export function yuvToRgb(y: number, cb: number, cr: number): [number, number, number] {
  const yy = (y - 16) / 219
  const pb = (cb - 128) / 224
  const pr = (cr - 128) / 224
  const r = yy + 2 * (1 - KR) * pr
  const b = yy + 2 * (1 - KB) * pb
  const g = (yy - KR * r - KB * b) / KG
  const to8 = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)))
  return [to8(r), to8(g), to8(b)]
}
