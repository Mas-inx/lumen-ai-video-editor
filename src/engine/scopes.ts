/**
 * Video scopes, measured from the rendered frame: a luma waveform, an RGB
 * parade, a vectorscope and a histogram. Each is accumulated from pixels and
 * painted as a glowing density plot, like on a grading panel.
 */

export type ScopeKind = 'waveform' | 'parade' | 'vectorscope' | 'histogram'

const R = 0.2126
const G = 0.7152
const B = 0.0722

/** Paints a scope of `pixels` (RGBA, w×h) into `out` (any size). */
export function drawScope(kind: ScopeKind, pixels: Uint8ClampedArray, w: number, h: number, out: HTMLCanvasElement) {
  const ctx = out.getContext('2d')!
  const W = out.width
  const H = out.height
  ctx.fillStyle = '#0b0b0d'
  ctx.fillRect(0, 0, W, H)
  if (kind === 'waveform') waveform(ctx, pixels, w, h, W, H, [[R, G, B]], ['#8dff9a'])
  else if (kind === 'parade')
    waveform(
      ctx,
      pixels,
      w,
      h,
      W,
      H,
      [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      ['#ff6262', '#5dff7a', '#6b8cff'],
    )
  else if (kind === 'vectorscope') vectorscope(ctx, pixels, W, H)
  else histogram(ctx, pixels, W, H)
}

function glow(count: number, max: number) {
  return count ? Math.min(1, 0.18 + Math.log1p(count) / Math.log1p(max)) : 0
}

function hexRgb(hex: string) {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Columns of the picture, each pixel plotted at its level (0 at the bottom, 100% at the top). */
function waveform(ctx: CanvasRenderingContext2D, px: Uint8ClampedArray, w: number, h: number, W: number, H: number, weights: number[][], colors: string[]) {
  const lanes = weights.length
  const laneW = Math.floor(W / lanes)
  const img = ctx.createImageData(W, H)
  weights.forEach((wt, lane) => {
    const grid = new Uint32Array(laneW * H)
    let max = 1
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4
        if (px[i + 3] < 8) continue
        const v = (px[i] * wt[0] + px[i + 1] * wt[1] + px[i + 2] * wt[2]) / 255
        const gx = Math.min(laneW - 1, Math.floor((x / w) * laneW))
        const gy = Math.min(H - 1, Math.floor((1 - v) * (H - 1)))
        const c = ++grid[gy * laneW + gx]
        if (c > max) max = c
      }
    }
    const [cr, cg, cb] = hexRgb(colors[lane])
    for (let gy = 0; gy < H; gy++)
      for (let gx = 0; gx < laneW; gx++) {
        const a = glow(grid[gy * laneW + gx], max)
        if (!a) continue
        const o = (gy * W + lane * laneW + gx) * 4
        img.data[o] = cr * a
        img.data[o + 1] = cg * a
        img.data[o + 2] = cb * a
        img.data[o + 3] = 255
      }
  })
  ctx.putImageData(img, 0, 0)
  ctx.strokeStyle = 'rgba(255,255,255,0.12)'
  ctx.fillStyle = 'rgba(255,255,255,0.35)'
  ctx.font = '9px "Geist Mono Variable", monospace'
  for (const level of [0, 25, 50, 75, 100]) {
    const y = Math.round((1 - level / 100) * (H - 1)) + 0.5
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(W, y)
    ctx.stroke()
    ctx.fillText(String(level), 2, Math.min(H - 2, Math.max(9, y - 2)))
  }
  for (let l = 1; l < lanes; l++) {
    ctx.beginPath()
    ctx.moveTo(l * laneW + 0.5, 0)
    ctx.lineTo(l * laneW + 0.5, H)
    ctx.stroke()
  }
}

/** Colour on a disc: angle is hue, distance from the centre is saturation (BT.709 Cb/Cr). */
function vectorscope(ctx: CanvasRenderingContext2D, px: Uint8ClampedArray, W: number, H: number) {
  const size = Math.min(W, H)
  const ox = (W - size) / 2
  const oy = (H - size) / 2
  const grid = new Uint32Array(size * size)
  let max = 1
  const toXY = (r: number, g: number, b: number) => {
    const cb = -0.1146 * r - 0.3854 * g + 0.5 * b
    const cr = 0.5 * r - 0.4542 * g - 0.0458 * b
    return [Math.floor((0.5 + cb * 0.9) * (size - 1)), Math.floor((0.5 - cr * 0.9) * (size - 1))]
  }
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 8) continue
    const [x, y] = toXY(px[i] / 255, px[i + 1] / 255, px[i + 2] / 255)
    if (x < 0 || y < 0 || x >= size || y >= size) continue
    const c = ++grid[y * size + x]
    if (c > max) max = c
  }
  const img = ctx.createImageData(W, H)
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const a = glow(grid[y * size + x], max)
      if (!a) continue
      // Tint each dot with the colour it stands for.
      const u = x / (size - 1) - 0.5
      const v = 0.5 - y / (size - 1)
      const r = 0.6 + v * 1.4
      const g = 0.6 - u * 0.5 - v * 0.7
      const b = 0.6 + u * 1.6
      const o = ((y + Math.floor(oy)) * W + x + Math.floor(ox)) * 4
      img.data[o] = Math.min(255, 255 * a * Math.max(0.35, r))
      img.data[o + 1] = Math.min(255, 255 * a * Math.max(0.35, g))
      img.data[o + 2] = Math.min(255, 255 * a * Math.max(0.35, b))
      img.data[o + 3] = 255
    }
  ctx.putImageData(img, 0, 0)
  // Graticule: rings, the primary / secondary targets and the skin-tone line.
  const cx = ox + size / 2
  const cy = oy + size / 2
  ctx.strokeStyle = 'rgba(255,255,255,0.14)'
  for (const k of [0.25, 0.5]) {
    ctx.beginPath()
    ctx.arc(cx, cy, size * 0.9 * k, 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.font = '9px "Geist Mono Variable", monospace'
  ctx.fillStyle = 'rgba(255,255,255,0.45)'
  const targets: [string, number, number, number][] = [
    ['R', 1, 0, 0],
    ['Yl', 1, 1, 0],
    ['G', 0, 1, 0],
    ['Cy', 0, 1, 1],
    ['B', 0, 0, 1],
    ['Mg', 1, 0, 1],
  ]
  for (const [label, r, g, b] of targets) {
    const [x, y] = toXY(r * 0.75, g * 0.75, b * 0.75)
    ctx.strokeRect(ox + x - 4.5, oy + y - 4.5, 9, 9)
    ctx.fillText(label, ox + x + 6, oy + y + 3)
  }
  const [sx, sy] = toXY(0.87, 0.62, 0.5)
  const len = Math.hypot(ox + sx - cx, oy + sy - cy)
  ctx.strokeStyle = 'rgba(255,190,140,0.35)'
  ctx.beginPath()
  ctx.moveTo(cx, cy)
  ctx.lineTo(cx + ((ox + sx - cx) / len) * size * 0.45, cy + ((oy + sy - cy) / len) * size * 0.45)
  ctx.stroke()
}

/** How many pixels sit at each level, per channel and for luma. */
function histogram(ctx: CanvasRenderingContext2D, px: Uint8ClampedArray, W: number, H: number) {
  const bins = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)]
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 8) continue
    bins[0][px[i]]++
    bins[1][px[i + 1]]++
    bins[2][px[i + 2]]++
    bins[3][Math.round(px[i] * R + px[i + 1] * G + px[i + 2] * B)]++
  }
  let max = 1
  // Ignore the very ends when scaling, so a clipped black doesn't flatten everything else.
  for (const b of bins) for (let v = 1; v < 255; v++) max = Math.max(max, b[v])
  const colors = ['rgba(255,80,80,0.55)', 'rgba(80,255,110,0.55)', 'rgba(90,130,255,0.55)', 'rgba(240,240,240,0.5)']
  ctx.globalCompositeOperation = 'lighter'
  bins.forEach((b, c) => {
    ctx.beginPath()
    ctx.moveTo(0, H)
    for (let v = 0; v < 256; v++) ctx.lineTo((v / 255) * W, H - Math.min(1, b[v] / max) * (H - 4))
    ctx.lineTo(W, H)
    ctx.closePath()
    ctx.fillStyle = colors[c]
    ctx.fill()
  })
  ctx.globalCompositeOperation = 'source-over'
  ctx.strokeStyle = 'rgba(255,255,255,0.1)'
  for (const f of [0.25, 0.5, 0.75]) {
    ctx.beginPath()
    ctx.moveTo(f * W + 0.5, 0)
    ctx.lineTo(f * W + 0.5, H)
    ctx.stroke()
  }
}
