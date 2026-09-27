/**
 * .cube LUT files (the Adobe / Resolve format): 3D LUTs, and 1D LUTs (turned
 * into a 3D one), with custom input domains. The result is 8-bit RGB, red
 * fastest — the layout a WebGL 3D texture takes directly.
 */

export interface ParsedLut {
  title: string | null
  size: number
  data: Uint8Array
}

const to8 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255)

export function parseCube(text: string): ParsedLut {
  let title: string | null = null
  let size3 = 0
  let size1 = 0
  let min = [0, 0, 0]
  let max = [1, 1, 1]
  const values: number[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const [key, ...rest] = line.split(/\s+/)
    const upper = key.toUpperCase()
    if (upper === 'TITLE') title = line.slice(5).trim().replace(/^"|"$/g, '') || null
    else if (upper === 'LUT_3D_SIZE') size3 = Number(rest[0])
    else if (upper === 'LUT_1D_SIZE') size1 = Number(rest[0])
    else if (upper === 'DOMAIN_MIN') min = rest.slice(0, 3).map(Number)
    else if (upper === 'DOMAIN_MAX') max = rest.slice(0, 3).map(Number)
    else if (upper === 'LUT_3D_INPUT_RANGE' || upper === 'LUT_1D_INPUT_RANGE') {
      const [lo, hi] = rest.map(Number)
      min = [lo, lo, lo]
      max = [hi, hi, hi]
    } else if (/^[-+.\deE]/.test(key)) {
      const nums = line.split(/\s+/).map(Number)
      if (nums.length >= 3 && nums.every(Number.isFinite)) values.push(nums[0], nums[1], nums[2])
    }
  }
  const norm = (v: number, c: number) => (v - min[c]) / (max[c] - min[c] || 1)

  if (size3) {
    if (size3 < 2 || size3 > 65) throw new Error(`A ${size3}-point 3D LUT isn’t supported (2–65)`)
    const n = size3 ** 3
    if (values.length < n * 3) throw new Error(`The LUT has ${values.length / 3} entries; a ${size3}-point LUT needs ${n}`)
    const data = new Uint8Array(n * 3)
    for (let i = 0; i < n * 3; i++) data[i] = to8(norm(values[i], i % 3))
    return { title, size: size3, data }
  }
  if (size1) {
    if (values.length < size1 * 3) throw new Error(`The LUT has ${values.length / 3} entries; it says ${size1}`)
    // A 1D LUT curves each channel on its own; sample it into a 33-point cube.
    const size = 33
    const lookup = (v: number, c: number) => {
      const x = Math.min(1, Math.max(0, v)) * (size1 - 1)
      const i = Math.floor(x)
      const j = Math.min(size1 - 1, i + 1)
      const f = x - i
      return norm(values[i * 3 + c] * (1 - f) + values[j * 3 + c] * f, c)
    }
    const data = new Uint8Array(size ** 3 * 3)
    let k = 0
    for (let b = 0; b < size; b++)
      for (let g = 0; g < size; g++)
        for (let r = 0; r < size; r++) {
          data[k++] = to8(lookup(r / (size - 1), 0))
          data[k++] = to8(lookup(g / (size - 1), 1))
          data[k++] = to8(lookup(b / (size - 1), 2))
        }
    return { title, size, data }
  }
  throw new Error('That isn’t a .cube LUT (no LUT_3D_SIZE or LUT_1D_SIZE)')
}
