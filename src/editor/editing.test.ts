import { beforeEach, describe, expect, it } from 'vitest'
import { copyClips, pasteClips } from './clipboard'
import { createEmptyProject } from './new-project'
import { clipEnd, clipsOnTrack } from './ops'
import { dispatch, getProject, useEditor } from './store'
import { consumed, consumedAt, localForSource, sourceFrameAt, speedAt, splitInPoints } from './timing'
import type { Asset, Clip } from './types'

const FPS = 30
const trackId = (name: string) => getProject().tracks.find((t) => t.name === name)!.id
const clip = (id: string) => getProject().clips[id]
const spans = (name: string) => clipsOnTrack(getProject(), trackId(name)).map((c) => [c.start, clipEnd(c)])

function asset(id: string, seconds: number, kind: Asset['kind'] = 'video'): Asset {
  return { id, name: id, kind, duration: seconds, hasAudio: true, source: { type: 'file', url: `${id}.mp4`, mime: 'video/mp4', fileName: `${id}.mp4`, size: 1 }, addedAt: 0 }
}

/** Adds a clip through the command layer and returns its id. */
function add(track: string, start: number, duration: number, extra: { assetId?: string; inPoint?: number; kind?: Clip['kind'] } = {}) {
  const r = dispatch('clip.add', { trackId: trackId(track), kind: extra.kind ?? 'video', start, duration, assetId: extra.assetId, inPoint: extra.inPoint })
  if (!r.ok) throw new Error(r.error)
  return r.result as string
}

beforeEach(() => {
  useEditor.getState().loadProject(createEmptyProject('Editing'))
  dispatch('asset.add', { asset: asset('long', 60) })
  dispatch('asset.add', { asset: asset('short', 4) })
})

// ─── Timing ──────────────────────────────────────────────────────────────

describe('timing', () => {
  const base = { speed: 1, duration: 100, inPoint: 50, reverse: false, freeze: false, keyframes: {} } as Pick<Clip, 'speed' | 'duration' | 'inPoint' | 'reverse' | 'freeze' | 'keyframes'>

  it('maps constant speed, reverse and freeze frames', () => {
    expect(sourceFrameAt({ ...base, speed: 2 }, 10)).toBe(70)
    expect(consumed({ ...base, speed: 2 })).toBe(200)
    // Reversed: starts at the top of its range and runs down.
    expect(sourceFrameAt({ ...base, reverse: true }, 0)).toBe(150)
    expect(sourceFrameAt({ ...base, reverse: true }, 100)).toBe(50)
    expect(sourceFrameAt({ ...base, freeze: true }, 70)).toBe(50)
    expect(consumed({ ...base, freeze: true })).toBe(0)
  })

  it('integrates speed ramps so the footage never jumps', () => {
    const ramp = { ...base, keyframes: { speed: [{ frame: 0, value: 1, easing: 'linear' as const }, { frame: 100, value: 3, easing: 'linear' as const }] } }
    expect(speedAt(ramp, 50)).toBeCloseTo(2)
    // Linear 1 → 3 over 100 frames uses 200 frames of footage.
    expect(consumed(ramp)).toBeCloseTo(200, 0)
    // Monotonic, and the inverse finds the frame back.
    let prev = -1
    for (let f = 0; f <= 100; f += 5) {
      const s = sourceFrameAt(ramp, f)
      expect(s).toBeGreaterThan(prev)
      prev = s
      expect(localForSource(ramp, s)!).toBeCloseTo(f, 1)
    }
    expect(consumedAt(ramp, 50)).toBeCloseTo(75, 0)
  })

  it('splits keep each half on its own part of the source', () => {
    expect(splitInPoints({ ...base, speed: 2 }, 30)).toEqual({ left: 50, right: 110 })
    // Reversed: the left half shows the top of the range.
    expect(splitInPoints({ ...base, reverse: true }, 30)).toEqual({ left: 120, right: 50 })
  })
})

// ─── Trim tools ──────────────────────────────────────────────────────────

describe('trim tools', () => {
  it('ripple trims on an ordinary track, keeping later clips butted up', () => {
    const a = add('Overlay', 0, 60, { assetId: 'long' })
    add('Overlay', 60, 30, { assetId: 'long' })
    add('Overlay', 120, 30, { assetId: 'long' })
    expect(dispatch('clip.trim', { id: a, edge: 'end', frame: 40, ripple: true }).ok).toBe(true)
    expect(spans('Overlay')).toEqual([[0, 40], [40, 70], [100, 130]])
    // Ripple on the start keeps the clip in place and takes frames off its head.
    dispatch('clip.trim', { id: a, edge: 'start', frame: 10, ripple: true })
    expect(spans('Overlay')).toEqual([[0, 30], [30, 60], [90, 120]])
    expect(clip(a).inPoint).toBe(10)
  })

  it('rolls the cut between two clips without moving anything else', () => {
    const a = add('Overlay', 0, 60, { assetId: 'long' })
    const b = add('Overlay', 60, 60, { assetId: 'long', inPoint: 300 })
    const r = dispatch('clip.roll', { id: b, frame: 80 })
    expect(r).toEqual({ ok: true, result: 80 })
    expect([clip(a).duration, clip(b).start, clip(b).duration, clip(b).inPoint]).toEqual([80, 80, 40, 320])
    // Can't roll past the footage the right clip has before its head.
    dispatch('clip.roll', { id: b, frame: 0 })
    expect(clip(b).start).toBe(1)
  })

  it('slips footage within the media and reports how far it went', () => {
    const a = add('Overlay', 0, 60, { assetId: 'short', inPoint: 20 })
    expect(dispatch('clip.slip', { id: a, frames: 1000 })).toEqual({ ok: true, result: 40 })
    expect(clip(a).inPoint).toBe(60)
    expect([clip(a).start, clip(a).duration]).toEqual([0, 60])
    expect(dispatch('clip.slip', { id: a, frames: -1000 })).toEqual({ ok: true, result: -60 })
  })

  it('slides a clip while its neighbours give and take', () => {
    const a = add('Overlay', 0, 60, { assetId: 'long' })
    const b = add('Overlay', 60, 30, { assetId: 'long', inPoint: 600 })
    const c = add('Overlay', 90, 60, { assetId: 'long', inPoint: 900 })
    expect(dispatch('clip.slide', { id: b, frames: 20 })).toEqual({ ok: true, result: 20 })
    expect(spans('Overlay')).toEqual([[0, 80], [80, 110], [110, 150]])
    expect(clip(b).inPoint).toBe(600)
    expect(clip(c).inPoint).toBe(920)
    expect(clip(a).duration).toBe(80)
  })
})

// ─── Insert & overwrite ──────────────────────────────────────────────────

describe('insert and overwrite', () => {
  it('overwrite covers what is there; insert pushes it later', () => {
    const a = add('Overlay', 0, 100, { assetId: 'long' })
    const b = add('Titles', 0, 20, { kind: 'text' })
    dispatch('clip.move', { moves: [{ id: b, start: 40, trackId: trackId('Overlay') }], mode: 'overwrite' })
    expect(spans('Overlay')).toEqual([[0, 40], [40, 60], [60, 100]])
    const after = clipsOnTrack(getProject(), trackId('Overlay'))[2]
    expect(after.inPoint).toBe(60)
    expect(clip(a).duration).toBe(40)

    const c = add('Titles', 0, 10, { kind: 'text' })
    dispatch('clip.move', { moves: [{ id: c, start: 0, trackId: trackId('Overlay') }], mode: 'insert' })
    expect(spans('Overlay')).toEqual([[0, 10], [10, 50], [50, 70], [70, 110]])
  })
})

// ─── Freeze frames ───────────────────────────────────────────────────────

describe('freeze frames', () => {
  it('holds the frame under the playhead and pushes the rest later', () => {
    const a = add('Main', 0, 90, { assetId: 'long', inPoint: 30 })
    const r = dispatch('clip.freeze', { id: a, frame: 30, duration: 60 })
    expect(r.ok).toBe(true)
    const hold = clip((r as { result: string }).result)
    expect(hold).toMatchObject({ freeze: true, start: 30, duration: 60, inPoint: 60 })
    expect(spans('Main')).toEqual([[0, 30], [30, 90], [90, 150]])
  })

  it('cuts linked sound at the same point so it stays in sync', () => {
    const a = add('Main', 0, 90, { assetId: 'long' })
    const [sound] = (dispatch('clip.detachAudio', { ids: [a] }) as { result: string[] }).result
    dispatch('clip.freeze', { id: a, frame: 30, duration: 30 })
    const pieces = clipsOnTrack(getProject(), clip(sound).trackId)
    expect(pieces.map((c) => [c.start, clipEnd(c)])).toEqual([[0, 30], [60, 120]])
    const tail = clipsOnTrack(getProject(), trackId('Main')).at(-1)!
    expect(tail.groupId).toBeDefined()
    expect(pieces[1].groupId).toBe(tail.groupId)
  })
})

// ─── Linked sound & groups ───────────────────────────────────────────────

describe('linked sound and groups', () => {
  it('detached sound follows its picture when the main track repacks', () => {
    const first = add('Main', 0, 60, { assetId: 'long' })
    const second = add('Main', 60, 60, { assetId: 'long', inPoint: 300 })
    const [sound] = (dispatch('clip.detachAudio', { ids: [second] }) as { result: string[] }).result
    expect(clip(second).audio.detached).toBe(true)
    expect(clip(sound)).toMatchObject({ kind: 'audio', start: 60, inPoint: 300, groupId: clip(second).groupId })
    // Trimming the first clip ripples the main track — the sound keeps up.
    dispatch('clip.trim', { id: first, edge: 'end', frame: 40 })
    expect(clip(second).start).toBe(40)
    expect(clip(sound).start).toBe(40)
  })

  it('reattaching brings the mix back and removes the sound clip', () => {
    const a = add('Main', 0, 60, { assetId: 'long' })
    const [sound] = (dispatch('clip.detachAudio', { ids: [a] }) as { result: string[] }).result
    dispatch('clip.update', { ids: [sound], patch: { audio: { volume: -6 } } })
    dispatch('clip.reattachAudio', { ids: [a] })
    expect(clip(sound)).toBeUndefined()
    expect(clip(a).audio).toMatchObject({ volume: -6 })
    expect(clip(a).audio.detached).toBeUndefined()
    expect(clip(a).groupId).toBeUndefined()
  })

  it('razoring a group links each piece of picture to its piece of sound', () => {
    const a = add('Main', 0, 90, { assetId: 'long' })
    const [sound] = (dispatch('clip.detachAudio', { ids: [a] }) as { result: string[] }).result
    const rights = (dispatch('clip.split', { frame: 45, ids: [a, sound] }) as { result: string[] }).result
    const [rv, ra] = rights.map(clip)
    expect(rv.groupId).toBe(ra.groupId)
    expect(rv.groupId).not.toBe(clip(a).groupId)
    expect(clip(a).groupId).toBe(clip(sound).groupId)
  })

  it('groups merge, and a group of one dissolves', () => {
    const a = add('Overlay', 0, 30, { assetId: 'long' })
    const b = add('Titles', 0, 30, { kind: 'text' })
    dispatch('clip.group', { ids: [a, b] })
    expect(clip(a).groupId).toBe(clip(b).groupId)
    dispatch('clip.delete', { ids: [b] })
    expect(clip(a).groupId).toBeUndefined()
  })
})

// ─── Clipboard ───────────────────────────────────────────────────────────

describe('clipboard', () => {
  it('pastes copies at the playhead, keeping spacing and linking copies to each other', () => {
    const a = add('Overlay', 10, 30, { assetId: 'long' })
    const b = add('Titles', 20, 30, { kind: 'text' })
    dispatch('clip.group', { ids: [a, b] })
    copyClips(getProject(), [a, b])
    const res = pasteClips(200)
    expect(res.ok).toBe(true)
    const ids = (res as { ids: string[] }).ids
    const [ca, cb] = ids.map(clip)
    expect([ca.start, cb.start]).toEqual([200, 210])
    expect(ca.groupId).toBe(cb.groupId)
    expect(ca.groupId).not.toBe(clip(a).groupId)
    // One undo removes the whole paste.
    useEditor.getState().undo()
    expect(ids.map(clip)).toEqual([undefined, undefined])
  })

  it('pastes into another project, bringing the media along', () => {
    const a = add('Overlay', 0, 30, { assetId: 'long' })
    copyClips(getProject(), [a])
    useEditor.getState().loadProject(createEmptyProject('Other'))
    const res = pasteClips(0)
    expect(res.ok).toBe(true)
    expect(getProject().assets.long).toBeDefined()
  })

  it('pastes chosen attributes onto other clips', () => {
    const a = add('Overlay', 0, 30, { assetId: 'long' })
    const b = add('Overlay', 60, 30, { assetId: 'long' })
    dispatch('clip.update', { ids: [a], patch: { transform: { scale: 0.5 }, color: { exposure: 20 }, crop: { left: 0.1 } } })
    dispatch('clip.copyAttributes', { fromId: a, ids: [b], include: ['transform', 'crop'] })
    expect(clip(b).transform.scale).toBe(0.5)
    expect(clip(b).crop).toMatchObject({ left: 0.1 })
    expect(clip(b).color.exposure).toBe(0)
  })
})

// ─── Speed ───────────────────────────────────────────────────────────────

describe('speed ramps', () => {
  it('a ramp keeps the same footage by changing the clip length', () => {
    const a = add('Overlay', 0, 60, { assetId: 'long' })
    dispatch('clip.setSpeedRamp', { id: a, points: [{ at: 0, speed: 1, easing: 'linear' }, { at: 1, speed: 3, easing: 'linear' }] })
    const c = clip(a)
    expect(c.keyframes.speed).toHaveLength(2)
    expect(c.duration).toBe(30)
    expect(consumed(c)).toBeCloseTo(60, -1)
    // Removing it plays the same footage at the average speed.
    dispatch('clip.setSpeedRamp', { id: a, points: null })
    expect(clip(a).keyframes.speed).toBeUndefined()
    expect(clip(a).speed).toBeCloseTo(2, 1)
  })

  it('never ramps past the end of the media', () => {
    const a = add('Overlay', 0, 100, { assetId: 'short' })
    dispatch('keyframe.set', { clipId: a, prop: 'speed', frame: 0, value: 4 })
    dispatch('keyframe.set', { clipId: a, prop: 'speed', frame: 100, value: 4 })
    const c = clip(a)
    expect(consumed(c)).toBeLessThanOrEqual(4 * FPS + 0.5)
    expect(c.duration).toBe(30)
  })
})

// ─── In & out, tracks ────────────────────────────────────────────────────

describe('in and out points', () => {
  it('lift leaves a gap; extract closes it and clears the range', () => {
    add('Overlay', 0, 100, { assetId: 'long' })
    dispatch('timeline.setRange', { range: { in: 20, out: 50 } })
    dispatch('timeline.liftRange', { start: 20, end: 50 })
    expect(spans('Overlay')).toEqual([[0, 20], [50, 100]])
    useEditor.getState().undo()
    dispatch('timeline.removeRange', { start: 20, end: 50 })
    expect(spans('Overlay')).toEqual([[0, 20], [20, 70]])
    expect(getProject().range).toBeNull()
  })

  it('re-times the range with the frame rate', () => {
    dispatch('timeline.setRange', { range: { in: 30, out: 90 } })
    dispatch('project.update', { settings: { fps: 60 } })
    expect(getProject().range).toEqual({ in: 60, out: 180 })
  })
})

describe('tracks', () => {
  it('reorders and solos tracks', () => {
    const music = trackId('Music')
    dispatch('track.move', { id: music, index: 3 })
    expect(getProject().tracks[3].id).toBe(music)
    dispatch('track.update', { id: music, patch: { solo: true } })
    expect(getProject().tracks[3].solo).toBe(true)
    dispatch('track.update', { id: music, patch: { solo: false } })
    expect('solo' in getProject().tracks[3]).toBe(false)
  })
})
