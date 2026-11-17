/**
 * Keeping the subject in frame when a shot is reframed (16:9 → 9:16 and the
 * like): where the subject of a picture is, and where to move the picture so
 * that it stays in a new frame. Pure maths, unit-tested.
 *
 * Without a subject matte, the subject is found the way a person looks at a
 * frame: detail and edges (the subject is usually the sharpest thing), skin
 * tones, and colour, weighed gently toward the middle and the upper third.
 */

export interface Focus {
  /** The subject's centre, as fractions of the picture. */
  x: number
  y: number
  /** 0..1: how clearly one region stands out (low for flat or evenly busy pictures). */
  confidence: number
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Where the subject of an RGBA picture is. */
export function focusOf(rgba: ArrayLike<number>, w: number, h: number): Focus {
  if (w < 3 || h < 3) return { x: 0.5, y: 0.5, confidence: 0 }
  const lum = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) lum[i] = (0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]) / 255
  const score = new Float32Array(w * h)
  const values: number[] = []
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const gx = lum[i + 1] - lum[i - 1]
      const gy = lum[i + w] - lum[i - w]
      const edge = Math.min(1, Math.hypot(gx, gy) * 4)
      const r = rgba[i * 4]
      const g = rgba[i * 4 + 1]
      const b = rgba[i * 4 + 2]
      const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b
      const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b
      const skin = cb >= 77 && cb <= 127 && cr >= 137 && cr <= 173 && lum[i] > 0.15 ? 1 : 0
      const hi = Math.max(r, g, b)
      const sat = hi > 0 ? (hi - Math.min(r, g, b)) / hi : 0
      const dx = x / w - 0.5
      const dy = y / h - 0.42
      const centre = Math.exp(-(dx * dx) / (2 * 0.32 * 0.32) - (dy * dy) / (2 * 0.38 * 0.38))
      const s = (edge * 0.7 + skin * 0.6 + sat * 0.12) * (0.55 + 0.45 * centre)
      score[i] = s
      values.push(s)
    }
  values.sort((a, b) => a - b)
  const floor = values[Math.floor(values.length * 0.85)]
  const top = values[values.length - 1]
  if (!(top > floor + 1e-4)) return { x: 0.5, y: 0.5, confidence: 0 }
  let sx = 0
  let sy = 0
  let sw = 0
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const k = score[y * w + x] - floor
      if (k <= 0) continue
      sx += (x + 0.5) * k
      sy += (y + 0.5) * k
      sw += k
    }
  const cx = sx / sw / w
  const cy = sy / sw / h
  // How tight the standout region is: spread around its centre, against the whole frame's.
  let spread = 0
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const k = score[y * w + x] - floor
      if (k > 0) spread += k * ((x / w - cx) ** 2 + (y / h - cy) ** 2)
    }
  const confidence = clamp(1 - Math.sqrt(spread / sw) / 0.35, 0, 1)
  return { x: clamp(cx, 0, 1), y: clamp(cy, 0, 1), confidence: Math.round(confidence * 100) / 100 }
}

/** The middle of several readings of a shot (robust to a frame or two where something else stood out). */
export function medianFocus(readings: Focus[]): Focus {
  if (!readings.length) return { x: 0.5, y: 0.5, confidence: 0 }
  const mid = (k: 'x' | 'y' | 'confidence') => {
    const v = readings.map((r) => r[k]).sort((a, b) => a - b)
    return v[Math.floor(v.length / 2)]
  }
  return { x: mid('x'), y: mid('y'), confidence: mid('confidence') }
}

/**
 * Where a picture that covers the canvas should sit so that `focus` is as
 * close to the middle as it can be without uncovering an edge: x, y offsets
 * from the canvas centre, in canvas pixels (a clip's transform x and y).
 */
export function reframeOffset(o: { mediaW: number; mediaH: number; canvasW: number; canvasH: number; focus: Pick<Focus, 'x' | 'y'> }) {
  const cover = Math.max(o.canvasW / o.mediaW, o.canvasH / o.mediaH)
  const pw = o.mediaW * cover
  const ph = o.mediaH * cover
  const maxX = Math.max(0, (pw - o.canvasW) / 2)
  const maxY = Math.max(0, (ph - o.canvasH) / 2)
  // Faces read best a little above the middle of a tall frame: aim the subject's centre slightly high.
  const aimY = o.canvasH > o.canvasW ? -0.06 * o.canvasH : 0
  return {
    // `|| 0`: no -0 in the project.
    x: Math.round(clamp(-(o.focus.x - 0.5) * pw, -maxX, maxX)) || 0,
    y: Math.round(clamp(-(o.focus.y - 0.5) * ph + aimY, -maxY, maxY)) || 0,
  }
}

/** The key a shot's focus is kept under: the same footage over the same stretch, whichever timeline it's on. */
export const focusKey = (c: { assetId?: string; inPoint: number; duration: number; speed: number }) => `${c.assetId}@${c.inPoint}+${c.duration}x${c.speed}`
