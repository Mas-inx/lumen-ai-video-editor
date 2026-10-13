import { describe, expect, it } from 'vitest'
import type { CursorTrack } from '@shared/capture'
import { zoomKeys, zoomSpans, type ZoomTarget } from './autozoom'

const track = (clicks: [number, number, number, ('left' | 'right')?, number?][]): CursorTrack => ({
  moves: [],
  rate: 30,
  clicks: clicks.map(([t, x, y, button = 'left', held]) => ({ t, x, y, button, ...(held ? { held } : {}) })),
})

// A 1920×1080 recording filling a 1920×1080 timeline at 30 fps: a 20-second clip from the start of its media.
const target: ZoomTarget = { duration: 600, inPoint: 0, fps: 30, scale: 1, x: 0, y: 0, mediaWidth: 1920, mediaHeight: 1080, frameWidth: 1920, frameHeight: 1080 }

describe('where to zoom', () => {
  it('pushes in before a click, holds after it and pulls out', () => {
    const [span, ...rest] = zoomSpans(track([[5, 0.25, 0.5]]), 0, 20)
    expect(rest).toEqual([])
    expect(span).toEqual({ from: 4.55, in: 5, until: 6.6, to: 7.2, looks: [{ t: 5, x: 0.25, y: 0.5 }] })
  })

  it('keeps clicks close together in one zoom, and far apart in two', () => {
    const spans = zoomSpans(track([[5, 0.2, 0.2], [6, 0.3, 0.2], [7.5, 0.8, 0.8], [15, 0.5, 0.5]]), 0, 20)
    expect(spans).toHaveLength(2)
    expect(spans[0].looks.map((l) => l.t)).toEqual([5, 6, 7.5])
    // It stays until the last click of the group has had its hold.
    expect(spans[0].until).toBeCloseTo(9.1)
    expect(spans[1].looks).toHaveLength(1)
  })

  it('holds through a drag', () => {
    const [span] = zoomSpans(track([[5, 0.2, 0.2, 'left', 2]]), 0, 20)
    expect(span.until).toBeCloseTo(8.6)
  })

  it('ignores clicks outside the picture, outside the stretch, and other buttons unless asked', () => {
    const t = track([[1, -0.2, 0.5], [2, 0.5, 1.4], [3, 0.5, 0.5, 'right'], [30, 0.5, 0.5], [4, 0.5, 0.5]])
    expect(zoomSpans(t, 0, 20).map((s) => s.looks[0].t)).toEqual([4])
    expect(zoomSpans(t, 0, 20, { buttons: ['left', 'right'] })[0].looks.map((l) => l.t)).toEqual([3, 4])
    expect(zoomSpans(t, 10, 20)).toEqual([])
  })

  it('never starts before the stretch or ends after it', () => {
    const spans = zoomSpans(track([[0.1, 0.5, 0.5], [19.8, 0.5, 0.5]]), 0, 20)
    expect(spans[0].from).toBe(0)
    expect(spans[1].until).toBe(20)
    expect(spans[1].to).toBe(20)
  })
})

describe('zoom keyframes', () => {
  it('centres the click, zoomed, and returns to where the clip was', () => {
    const keys = zoomKeys(track([[5, 0.25, 0.5]]), target)
    // 0.25 across a 1920-wide picture is 480 px left of centre; at 2× that is 960 px, moved right to centre it.
    expect(keys.scale.map((k) => [k.frame, k.value])).toEqual([[137, 1], [150, 2], [198, 2], [216, 1]])
    expect(keys.x.map((k) => [k.frame, k.value])).toEqual([[137, 0], [150, 960], [198, 960], [216, 0]])
    expect(keys.y.map((k) => k.value)).toEqual([0, 0, 0, 0])
    // Each key's curve is the one to the next key: ease in, stay, ease out, stay.
    expect(keys.scale.map((k) => k.easing)).toEqual(['cubic-in-out', 'hold', 'cubic-in-out', 'hold'])
  })

  it('never shows past the edge of the picture', () => {
    // A click in the very corner: centring it would show nothing but black on two sides.
    const keys = zoomKeys(track([[5, 0.02, 0.98]]), target)
    expect(keys.x[1].value).toBe(960)
    expect(keys.y[1].value).toBe(-540)
    const closer = zoomKeys(track([[5, 0.02, 0.98]]), target, { zoom: 3 })
    expect(closer.x[1].value).toBe(1920)
    expect(closer.y[1].value).toBe(-1080)
  })

  it('pans between clicks of one zoom', () => {
    const keys = zoomKeys(track([[5, 0.25, 0.5], [7, 0.75, 0.5]]), target)
    // In on the first, glide to the second shortly before it lands, out after its hold.
    expect(keys.x.map((k) => [k.frame, k.value])).toEqual([[137, 0], [150, 960], [197, 960], [210, -960], [258, -960], [276, 0]])
    expect(keys.scale.map((k) => k.value)).toEqual([1, 2, 2, 2, 2, 1])
  })

  it('counts from the clip’s own start, for a clip cut out of its recording', () => {
    // The clip starts 4 seconds into the media and is 6 seconds long: only the click at 5 s is inside it.
    const keys = zoomKeys(track([[2, 0.5, 0.5], [5, 0.25, 0.5], [12, 0.5, 0.5]]), { ...target, inPoint: 120, duration: 180 })
    expect(keys.spans).toHaveLength(1)
    expect(keys.scale.map((k) => k.frame)).toEqual([17, 30, 78, 96])
  })

  it('starts from the clip’s own size and place, and scales a smaller picture’s reach', () => {
    // A 1280×720 recording shown at half size in a 1920×1080 frame, moved 100 px right.
    const keys = zoomKeys(track([[5, 0.5, 0.5]]), { ...target, mediaWidth: 1280, mediaHeight: 720, scale: 0.5, x: 100, y: 0 })
    expect(keys.scale.map((k) => k.value)).toEqual([0.5, 1, 1, 0.5])
    // The middle of the picture stays the middle: only the clip's own offset is carried along.
    expect(keys.x.map((k) => k.value)).toEqual([100, 200, 200, 100])
  })

  it('has nothing to say without clicks', () => {
    expect(zoomKeys(track([]), target)).toEqual({ scale: [], x: [], y: [], spans: [] })
  })
})
