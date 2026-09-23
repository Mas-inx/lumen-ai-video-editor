import { mulberry32 } from '@/lib/math'

let grain: HTMLCanvasElement | null = null

/** A tileable 192px film-grain texture (deterministic, generated once). */
export function grainCanvas() {
  if (grain) return grain
  const c = document.createElement('canvas')
  c.width = c.height = 192
  const x = c.getContext('2d')!
  const img = x.createImageData(192, 192)
  const rnd = mulberry32(42)
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.floor(rnd() * 255)
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v
    img.data[i + 3] = 255
  }
  x.putImageData(img, 0, 0)
  grain = c
  return c
}
