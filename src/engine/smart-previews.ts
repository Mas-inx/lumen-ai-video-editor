/**
 * The Transitions panel's smart cards: the two preview pictures (the project's
 * own footage, or artwork before there is any) read like a real cut — subjects,
 * flow, colours — and carried one into the other by the same GPU shader the
 * timeline uses.
 */
import { matchCurves, samplePixels } from '@/editor/color-correct'
import { focusOf } from '@/editor/subject-frame'
import type { TransitionKind, TransitionMatch } from '@/editor/types'
import { toGray } from './analysis'
import { blockFlow, encodeFlow, FLOW_COLS, FLOW_ROWS } from './cut-match'
import { gpuTransition } from './gl-transition'
import { getImage } from './media'

interface Pair {
  a: HTMLCanvasElement
  b: HTMLCanvasElement
  match: TransitionMatch
}

const pairs = new Map<string, Pair>()

/** A picture covering a w × h canvas. */
function cover(img: HTMLImageElement | HTMLCanvasElement, w: number, h: number) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  const iw = img instanceof HTMLImageElement ? img.naturalWidth : img.width
  const ih = img instanceof HTMLImageElement ? img.naturalHeight : img.height
  const r = Math.max(w / Math.max(1, iw), h / Math.max(1, ih))
  ctx.drawImage(img, (w - iw * r) / 2, (h - ih * r) / 2, iw * r, ih * r)
  return c
}

function pair(a: string, b: string, w: number, h: number): Pair | null {
  const key = `${a}|${b}|${w}x${h}`
  const known = pairs.get(key)
  if (known) return known
  const ia = getImage(a)
  const ib = getImage(b)
  if (!(ia instanceof HTMLImageElement) || !(ib instanceof HTMLImageElement)) return null
  const ca = cover(ia, w, h)
  const cb = cover(ib, w, h)
  const small = (c: HTMLCanvasElement) => {
    const s = cover(c, 160, 90)
    const rgba = s.getContext('2d')!.getImageData(0, 0, 160, 90).data
    return { rgba, gray: { data: toGray(rgba), width: 160, height: 90 } }
  }
  const sa = small(ca)
  const sb = small(cb)
  const from = focusOf(sa.rgba, 160, 90)
  const to = focusOf(sb.rgba, 160, 90)
  const { red, green, blue } = matchCurves(samplePixels(sb.rgba, 2), samplePixels(sa.rgba, 2))
  const match: TransitionMatch = {
    from: { x: from.x, y: from.y },
    to: { x: to.x, y: to.y },
    motion: { x: 1, y: 0 },
    flow: { w: FLOW_COLS, h: FLOW_ROWS, data: encodeFlow(blockFlow(sa.gray, sb.gray).flow) },
    color: { red, green, blue },
  }
  if (pairs.size > 8) pairs.delete(pairs.keys().next().value!)
  const p = { a: ca, b: cb, match }
  pairs.set(key, p)
  return p
}

/** Draws smart transition `kind` at `p` between preview pictures `a` and `b`; false while they load. */
export function drawSmartPreview(canvas: HTMLCanvasElement, kind: TransitionKind, p: number, a: string, b: string): boolean {
  const pr = pair(a, b, canvas.width, canvas.height)
  if (!pr) return false
  const out = gpuTransition(kind, p, pr.a, pr.b, pr.match)
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(out ?? pr.b, 0, 0, canvas.width, canvas.height)
  return true
}
