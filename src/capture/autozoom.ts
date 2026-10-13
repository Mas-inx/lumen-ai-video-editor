/**
 * Zooms on clicks: turns a screen recording's click data into keyframes that
 * push in on where the pointer clicked, hold while the clicking goes on there,
 * and ease back out — the look of a narrated software demo.
 *
 * It only reads the pointer data and returns keyframes; the editor's own
 * commands put them on the clip, so every zoom can be moved, changed or undone.
 */
import type { CursorClick, CursorTrack } from '@shared/capture'
import type { Easing } from '@/editor/easing'

export interface ZoomOptions {
  /** How far to push in: 2 shows half the picture's width. */
  zoom?: number
  /** Seconds the zoom stays after the last click of a group. */
  hold?: number
  /** Seconds the push-in takes, ending as the click lands. */
  lead?: number
  /** Seconds the pull-out takes. */
  out?: number
  /** Clicks this close together (seconds) share one zoom, which pans between them. */
  group?: number
  /** Which buttons count. */
  buttons?: CursorClick['button'][]
}

export const ZOOM_DEFAULTS = { zoom: 2, hold: 1.6, lead: 0.45, out: 0.6, group: 2.5 } as const

/** One stretch of being zoomed in: where it looks at each moment. */
export interface ZoomSpan {
  /** Seconds on the media: the push-in starts, the first click lands, the last look ends, the pull-out is done. */
  from: number
  in: number
  until: number
  to: number
  /** Where it looks and from when (media seconds; fractions of the picture). */
  looks: { t: number; x: number; y: number }[]
}

/**
 * The stretches to zoom in on, from a recording's clicks between two times on
 * the media. Clicks outside the picture are ignored.
 */
export function zoomSpans(track: CursorTrack, from: number, to: number, opts: ZoomOptions = {}): ZoomSpan[] {
  // A setting left out (or passed as undefined) is its default.
  const o = { hold: opts.hold ?? ZOOM_DEFAULTS.hold, lead: opts.lead ?? ZOOM_DEFAULTS.lead, out: opts.out ?? ZOOM_DEFAULTS.out, group: opts.group ?? ZOOM_DEFAULTS.group }
  const buttons = new Set(opts.buttons ?? ['left'])
  const clicks = track.clicks.filter((c) => buttons.has(c.button) && c.t >= from && c.t <= to && c.x >= 0 && c.x <= 1 && c.y >= 0 && c.y <= 1).sort((a, b) => a.t - b.t)
  const spans: ZoomSpan[] = []
  for (const c of clicks) {
    const last = spans[spans.length - 1]
    // A drag ends where the button came up: the zoom holds from there.
    const end = c.t + (c.held ?? 0)
    if (last && c.t - last.until + o.hold <= o.group) {
      last.looks.push({ t: c.t, x: c.x, y: c.y })
      last.until = Math.min(to, end + o.hold)
      last.to = Math.min(to, last.until + o.out)
      continue
    }
    const start = Math.max(from, c.t - o.lead)
    // No room to pull out and push in again: stay in and pan across.
    if (last && start < last.to) {
      last.looks.push({ t: c.t, x: c.x, y: c.y })
      last.until = Math.min(to, end + o.hold)
      last.to = Math.min(to, last.until + o.out)
      continue
    }
    const until = Math.min(to, end + o.hold)
    spans.push({ from: start, in: Math.max(start, c.t), until, to: Math.min(to, until + o.out), looks: [{ t: c.t, x: c.x, y: c.y }] })
  }
  // Times to the millisecond: sums of tenths aren't exact.
  const ms = (n: number) => Math.round(n * 1000) / 1000
  return spans.map((s) => ({ ...s, from: ms(s.from), in: ms(s.in), until: ms(s.until), to: ms(s.to) }))
}

export interface ZoomKey {
  /** Frames from the clip's start. */
  frame: number
  value: number
  easing: Easing
}

export interface ZoomKeys {
  scale: ZoomKey[]
  x: ZoomKey[]
  y: ZoomKey[]
  spans: ZoomSpan[]
}

export interface ZoomTarget {
  /** The clip's length and where it starts in its media, in frames; the timeline's frame rate. */
  duration: number
  inPoint: number
  fps: number
  /** The clip's own size and place: what the zooms start from and return to. */
  scale: number
  x: number
  y: number
  /** The media's size and the timeline's, in pixels. */
  mediaWidth: number
  mediaHeight: number
  frameWidth: number
  frameHeight: number
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/**
 * Keyframes that zoom a clip in on its clicks. Empty when there are no clicks
 * inside the clip.
 */
export function zoomKeys(track: CursorTrack, target: ZoomTarget, opts: ZoomOptions = {}): ZoomKeys {
  const { fps, inPoint, duration } = target
  const zoom = clamp(opts.zoom ?? ZOOM_DEFAULTS.zoom, 1.1, 6)
  const from = inPoint / fps
  const to = (inPoint + duration) / fps
  const spans = zoomSpans(track, from, to, opts)
  // The picture as it sits in the frame at the clip's own size.
  const fit = Math.min(target.frameWidth / target.mediaWidth, target.frameHeight / target.mediaHeight)
  const width = target.mediaWidth * fit * target.scale
  const height = target.mediaHeight * fit * target.scale
  /** Where the clip has to sit, zoomed in, for a point of the picture to be mid-frame — without showing past the picture's edge. */
  const place = (px: number, py: number) => {
    const maxX = Math.max(0, (width * zoom - target.frameWidth) / 2)
    const maxY = Math.max(0, (height * zoom - target.frameHeight) / 2)
    return { x: Math.round(clamp(-(px - 0.5) * width * zoom, -maxX, maxX) + target.x * zoom), y: Math.round(clamp(-(py - 0.5) * height * zoom, -maxY, maxY) + target.y * zoom) }
  }
  const frame = (t: number) => clamp(Math.round(t * fps) - inPoint, 0, Math.max(0, duration - 1))
  const out: ZoomKeys = { scale: [], x: [], y: [], spans }
  const put = (f: number, scale: number, x: number, y: number, easing: Easing) => {
    // Two keys on one frame: the later one wins.
    for (const [list, value] of [
      [out.scale, scale],
      [out.x, x],
      [out.y, y],
    ] as const) {
      const at = list.findIndex((k) => k.frame === f)
      if (at >= 0) list[at] = { frame: f, value, easing }
      else list.push({ frame: f, value, easing })
    }
  }
  for (const span of spans) {
    const first = place(span.looks[0].x, span.looks[0].y)
    put(frame(span.from), target.scale, target.x, target.y, 'cubic-in-out')
    put(frame(span.in), target.scale * zoom, first.x, first.y, 'hold')
    // Later clicks: stay where it was until shortly before each, then glide over.
    let prev = first
    for (const look of span.looks.slice(1)) {
      const glide = Math.max(span.in, look.t - Math.min(0.5, opts.lead ?? ZOOM_DEFAULTS.lead))
      const next = place(look.x, look.y)
      if (next.x === prev.x && next.y === prev.y) continue
      put(frame(glide), target.scale * zoom, prev.x, prev.y, 'cubic-in-out')
      put(frame(look.t), target.scale * zoom, next.x, next.y, 'hold')
      prev = next
    }
    put(frame(span.until), target.scale * zoom, prev.x, prev.y, 'cubic-in-out')
    put(frame(span.to), target.scale, target.x, target.y, 'hold')
  }
  for (const list of [out.scale, out.x, out.y]) list.sort((a, b) => a.frame - b.frame)
  return out
}
