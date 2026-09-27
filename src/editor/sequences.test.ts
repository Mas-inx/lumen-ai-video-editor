import { beforeEach, describe, expect, it } from 'vitest'
import { followOffset, pathPoint, smoothChannel, stabilizeAt, autoZoom } from './motion'
import { createEmptyProject } from './new-project'
import { clipEnd, clipsOnTrack, projectDuration, sourceFrames } from './ops'
import { allSequences, openSequenceId, sequenceView, usesOf, wouldLoop, withSequenceOpen } from './sequences'
import { dispatch, getProject, useEditor } from './store'
import type { Asset, Stabilization } from './types'

const trackId = (name: string) => getProject().tracks.find((t) => t.name === name)!.id
const clip = (id: string) => getProject().clips[id]

function asset(id: string, seconds: number, kind: Asset['kind'] = 'video'): Asset {
  return { id, name: id, kind, duration: seconds, hasAudio: true, source: { type: 'file', url: `${id}.mp4`, mime: 'video/mp4', fileName: `${id}.mp4`, size: 1 }, addedAt: 0 }
}

function add(track: string, start: number, duration: number, assetId = 'long', kind: 'video' | 'audio' = 'video') {
  const r = dispatch('clip.add', { trackId: trackId(track), kind, start, duration, assetId })
  if (!r.ok) throw new Error(r.error)
  return r.result as string
}

function ok<T = unknown>(r: { ok: true; result: unknown } | { ok: false; error: string }): T {
  if (!r.ok) throw new Error(r.error)
  return r.result as T
}

beforeEach(() => {
  useEditor.getState().loadProject(createEmptyProject('Timelines'))
  dispatch('asset.add', { asset: asset('long', 60) })
  dispatch('asset.add', { asset: asset('cam2', 50) })
})

describe('timelines', () => {
  it('creates, switches, renames and undoes back', () => {
    const a = add('Main', 0, 90)
    const mainId = openSequenceId(getProject())
    const second = ok<string>(dispatch('sequence.create', { name: 'Vertical', settings: { width: 1080, height: 1920 } }))
    expect(openSequenceId(getProject())).toBe(second)
    expect(getProject().settings.width).toBe(1080)
    expect(Object.keys(getProject().clips)).toHaveLength(0)
    // The first timeline waits, untouched, with its clip.
    expect(getProject().sequences?.[mainId].clips[a]).toBeTruthy()
    add('Main', 0, 30)
    ok(dispatch('sequence.rename', { id: second, name: 'Shorts cut' }))
    expect(allSequences(getProject()).map((s) => s.name)).toEqual(['Main timeline', 'Shorts cut'])
    ok(dispatch('sequence.open', { id: mainId }))
    expect(getProject().clips[a]).toBeTruthy()
    expect(getProject().settings.width).toBe(1920)
    // Undo walks back through the switch.
    useEditor.getState().undo()
    expect(openSequenceId(getProject())).toBe(second)
    expect(Object.keys(getProject().clips)).toHaveLength(1)
    useEditor.getState().redo()
    expect(openSequenceId(getProject())).toBe(mainId)
  })

  it('duplicates with fresh ids and deletes only unused, closed timelines', () => {
    add('Main', 0, 90)
    const mainId = openSequenceId(getProject())
    const copy = ok<string>(dispatch('sequence.duplicate', { id: mainId }))
    const stored = getProject().sequences![copy]
    expect(stored.name).toBe('Main timeline copy')
    expect(Object.keys(stored.clips)).toHaveLength(1)
    expect(Object.keys(stored.clips)[0]).not.toBe(Object.keys(getProject().clips)[0])
    expect(stored.tracks[0].id).not.toBe(getProject().tracks[0].id)
    expect(dispatch('sequence.delete', { id: mainId }).ok).toBe(false)
    ok(dispatch('sequence.delete', { id: copy }))
    expect(getProject().sequences?.[copy]).toBeUndefined()
  })

  it('exports a closed timeline as if it were open', () => {
    add('Main', 0, 90)
    const mainId = openSequenceId(getProject())
    ok(dispatch('sequence.create', { name: 'B' }))
    const view = withSequenceOpen(getProject(), mainId)
    expect(openSequenceId(view)).toBe(mainId)
    expect(projectDuration(view)).toBe(90)
    // The real project didn't change.
    expect(projectDuration(getProject())).toBe(0)
  })
})

describe('nesting', () => {
  it('nests clips into a timeline and plays it from one clip', () => {
    const a = add('Overlay', 30, 60)
    const b = add('Overlay', 120, 30)
    const music = add('Music', 40, 50, 'long', 'audio')
    const { clipId, sequenceId } = ok<{ clipId: string; sequenceId: string }>(dispatch('clip.nest', { ids: [a, b, music] }))
    const nest = clip(clipId)
    expect(nest.sequenceId).toBe(sequenceId)
    expect([nest.start, clipEnd(nest), nest.kind]).toEqual([30, 150, 'video'])
    expect(clip(a)).toBeUndefined()
    const seq = getProject().sequences![sequenceId]
    expect(Object.values(seq.clips).map((c) => c.start).sort((x, y) => x - y)).toEqual([0, 10, 90])
    expect(seq.tracks.map((t) => t.kind)).toEqual(['video', 'audio'])
    // A nested clip can't run past its timeline.
    expect(sourceFrames(getProject(), nest)).toBe(120)
    const view = sequenceView(getProject(), sequenceId)!
    expect(view.settings).toEqual(getProject().settings)
    expect(usesOf(getProject(), sequenceId)).toEqual([{ sequenceId: openSequenceId(getProject()), name: 'Main timeline', clipIds: [clipId] }])
  })

  it('keeps the magnetic main track in sync when main-track clips are nested', () => {
    const first = add('Main', 0, 100)
    const second = add('Main', 100, 100)
    const third = add('Main', 200, 100)
    const over = add('Overlay', 80, 60)
    const { clipId } = ok<{ clipId: string }>(dispatch('clip.nest', { ids: [second, over] }))
    const nest = clip(clipId)
    // The nest covers exactly what the main clip did; the overlay's head sits inside the nested timeline.
    expect([nest.trackId, nest.start, nest.duration, nest.inPoint]).toEqual([trackId('Main'), 100, 100, 20])
    expect(clip(third).start).toBe(200)
    expect(clip(first).start).toBe(0)
  })

  it('refuses loops and breaks nests apart again', () => {
    const a = add('Overlay', 30, 60)
    const { clipId, sequenceId } = ok<{ clipId: string; sequenceId: string }>(dispatch('clip.nest', { ids: [a] }))
    const here = openSequenceId(getProject())
    expect(wouldLoop(getProject(), sequenceId, here)).toBe(true)
    // Inside the nested timeline, the outer one can't be nested.
    ok(dispatch('sequence.open', { id: sequenceId }))
    const res = dispatch('clip.add', { trackId: getProject().tracks[0].id, kind: 'video', start: 0, duration: 30, sequenceId: here })
    expect(res.ok).toBe(false)
    // Nor can the nested clip be pasted inside the timeline it plays.
    const snapshot = structuredClone(getProject().sequences![here].clips[clipId]) as never
    expect(dispatch('clip.paste', { clips: [snapshot], at: 0 })).toMatchObject({ ok: false, error: expect.stringMatching(/can't go inside itself/) })
    ok(dispatch('sequence.open', { id: here }))
    // Pasting it back where it belongs is fine.
    expect(dispatch('clip.paste', { clips: [snapshot], at: 300 }).ok).toBe(true)
    useEditor.getState().undo()
    // Trim the nest's head, then break it apart: only what it showed comes back.
    ok(dispatch('clip.trim', { id: clipId, edge: 'start', frame: 40 }))
    const added = ok<string[]>(dispatch('clip.unnest', { id: clipId }))
    expect(added).toHaveLength(1)
    const back = clip(added[0])
    expect([back.start, clipEnd(back), back.inPoint]).toEqual([40, 90, 10])
    expect(clip(clipId)).toBeUndefined()
  })

  it('removing media removes it from closed timelines too', () => {
    add('Overlay', 0, 30, 'cam2')
    const here = openSequenceId(getProject())
    ok(dispatch('sequence.create', { name: 'Other' }))
    ok(dispatch('asset.remove', { ids: ['cam2'] }))
    expect(Object.keys(getProject().sequences![here].clips)).toHaveLength(0)
  })
})

describe('multicam', () => {
  it('lines angles up by offset and cuts between them', () => {
    const { sequenceId, clipId } = ok<{ sequenceId: string; clipId: string }>(
      dispatch('multicam.create', { name: 'Interview', angles: [{ assetId: 'long', offset: 0 }, { assetId: 'cam2', offset: 2.5 }], audio: 0 }),
    )
    const seq = getProject().sequences![sequenceId]
    expect(seq.multicam).toBe(true)
    const pics = Object.values(seq.clips).filter((c) => c.kind === 'video')
    expect(pics.map((c) => c.start).sort((a, b) => a - b)).toEqual([0, 75])
    expect(pics.every((c) => c.audio.detached)).toBe(true)
    // Only the first angle's sound is on.
    expect(seq.tracks.filter((t) => t.kind === 'audio').map((t) => t.muted)).toEqual([false, true])
    const mc = clip(clipId)
    expect(mc.angle).toBe(seq.tracks[0].id)
    expect(mc.duration).toBe(Math.max(60 * 30, 75 + 50 * 30))
    const right = ok<string>(dispatch('multicam.switch', { frame: 300, angle: 2 }))
    expect(clip(right).start).toBe(300)
    expect(clip(right).angle).toBe(seq.tracks[1].id)
    expect(clip(clipId).angle).toBe(seq.tracks[0].id)
    expect(dispatch('multicam.switch', { frame: 10, angle: 3 }).ok).toBe(false)
    expect(clipsOnTrack(getProject(), mc.trackId)).toHaveLength(2)
  })
})

describe('motion data', () => {
  it('follows a tracked path relative to where tracking began', () => {
    const path = { start: 10, ref: 2, points: [0, 0, 5, 1, 10, 2, 20, 4] }
    expect(pathPoint(path, 11)).toEqual([5, 1])
    expect(followOffset(path, 12)).toEqual([0, 0])
    expect(followOffset(path, 13)).toEqual([10, 2])
    // Before the path it holds the first point, after it the last.
    expect(followOffset(path, 0)).toEqual([-10, -2])
    expect(followOffset(path, 99)).toEqual([10, 2])
    expect(followOffset(path, 12.5)).toEqual([5, 1])
  })

  it('smooths a shaky camera path and zooms just enough', () => {
    // A slow pan with a jitter of ±1% on alternate frames.
    const path: number[] = []
    for (let i = 0; i < 120; i++) path.push(i * 0.001 + (i % 2 ? 0.01 : -0.01), 0, 0)
    const smooth = smoothChannel(path, 3, 0, 8)
    // The smoothed path keeps the pan but loses the jitter.
    expect(Math.abs(smooth[60] - 0.06)).toBeLessThan(0.002)
    const s: Stabilization = { start: 0, rate: 30, path, smooth: 0.5, zoom: 1, rotation: true }
    const c = stabilizeAt(s, 61 / 30)
    expect(Math.abs(c.dx + 0.01)).toBeLessThan(0.002)
    const z = autoZoom(s)
    expect(z).toBeGreaterThan(1.015)
    expect(z).toBeLessThan(1.03)
  })
})
