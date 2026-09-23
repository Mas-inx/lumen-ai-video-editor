import { describe, expect, it } from 'vitest'
import { createClip } from './defaults'
import { createEmptyProject } from './new-project'
import { clipEnd, clipsOnTrack, deleteClips, normalizeProject, removeRange, splitClip } from './ops'
import type { Clip, ClipKind } from './types'

function setup() {
  const p = createEmptyProject('Test')
  const track = (name: string) => p.tracks.find((t) => t.name === name)!.id
  const add = (trackName: string, kind: ClipKind, start: number, duration: number, extra: Partial<Clip> = {}) => {
    const c = createClip({ kind, trackId: track(trackName), start, duration, ...extra })
    p.clips[c.id] = c
    return c
  }
  const on = (trackName: string) => clipsOnTrack(p, track(trackName)).map((c) => [c.start, clipEnd(c)])
  return { p, track, add, on }
}

describe('splitClip', () => {
  it('splits source, keeps motion continuous and resets the join', () => {
    const { p, add } = setup()
    const c = add('Overlay', 'video', 10, 100, {
      inPoint: 30,
      speed: 2,
      keyframes: { opacity: [{ frame: 0, value: 0, easing: 'linear' }, { frame: 100, value: 1, easing: 'linear' }] },
      audio: { volume: 0, fadeIn: 5, fadeOut: 5, enhance: false, denoise: false },
    })
    const right = splitClip(p, c, 60)!
    expect([c.start, c.duration]).toEqual([10, 50])
    expect([right.start, right.duration, right.inPoint]).toEqual([60, 50, 130])
    expect(c.keyframes.opacity!.at(-1)).toMatchObject({ frame: 50, value: 0.5 })
    expect(right.keyframes.opacity![0]).toMatchObject({ frame: 0, value: 0.5 })
    expect(right.keyframes.opacity!.at(-1)).toMatchObject({ frame: 50, value: 1 })
    expect(c.audio.fadeOut).toBe(0)
    expect(right.audio.fadeIn).toBe(0)
    expect(right.audio.fadeOut).toBe(5)
  })

  it('refuses to split outside the clip', () => {
    const { p, add } = setup()
    const c = add('Overlay', 'video', 10, 20)
    expect(splitClip(p, c, 10)).toBeNull()
    expect(splitClip(p, c, 30)).toBeNull()
  })
})

describe('deleteClips', () => {
  it('ripple closes the gap on that track only', () => {
    const { p, add, on } = setup()
    const a = add('Overlay', 'video', 0, 10)
    add('Overlay', 'video', 10, 10)
    add('Overlay', 'video', 30, 10)
    add('Titles', 'text', 40, 10)
    deleteClips(p, [a.id], true)
    expect(on('Overlay')).toEqual([[0, 10], [20, 30]])
    expect(on('Titles')).toEqual([[40, 50]])
  })
})

describe('normalizeProject', () => {
  it('packs the magnetic main track edge to edge from 0', () => {
    const { p, add, on } = setup()
    add('Main', 'video', 15, 10)
    add('Main', 'video', 40, 20)
    normalizeProject(p)
    expect(on('Main')).toEqual([[0, 10], [10, 30]])
  })
})

describe('removeRange', () => {
  it('cuts every unlocked track and closes up, keeping everything in sync', () => {
    const { p, add, on } = setup()
    add('Voice', 'audio', 0, 100) // across the stretch: cut
    add('Titles', 'text', 20, 10) // before: untouched
    add('Titles', 'text', 45, 10) // inside: removed
    add('Titles', 'text', 70, 10) // after: moves left
    add('Overlay', 'video', 35, 20) // starts before, ends inside: trimmed
    add('Overlay', 'video', 55, 20) // starts inside, ends after: head trimmed
    removeRange(p, 40, 60)
    expect(on('Voice')).toEqual([[0, 40], [40, 80]])
    expect(on('Titles')).toEqual([[20, 30], [50, 60]])
    expect(on('Overlay')).toEqual([[35, 40], [40, 55]])
    const [left, right] = clipsOnTrack(p, p.tracks.find((t) => t.name === 'Voice')!.id)
    expect(right.inPoint).toBe(60)
    // A frame of fade either side keeps the join click-free.
    expect(left.audio.fadeOut).toBe(1)
    expect(right.audio.fadeIn).toBe(1)
  })

  it('leaves locked tracks alone', () => {
    const { p, add, on } = setup()
    p.tracks.find((t) => t.name === 'Titles')!.locked = true
    add('Titles', 'text', 70, 10)
    add('Overlay', 'video', 70, 10)
    removeRange(p, 40, 60)
    expect(on('Titles')).toEqual([[70, 80]])
    expect(on('Overlay')).toEqual([[50, 60]])
  })

  it('plays kept-whole clips on through the join, keyframes following the edit', () => {
    const { p, add } = setup()
    const music = add('Music', 'audio', 0, 300, {
      keyframes: {
        volume: [
          { frame: 0, value: -12, easing: 'linear' },
          { frame: 50, value: 0, easing: 'ease' },
          { frame: 150, value: -12, easing: 'linear' },
        ],
      },
    })
    removeRange(p, 40, 100, new Set([music.id]))
    const after = p.clips[music.id]
    expect([after.start, after.duration, after.inPoint]).toEqual([0, 240, 0])
    const kfs = after.keyframes.volume!
    expect(kfs[0]).toMatchObject({ frame: 0, value: -12 })
    // Resumes at the level it had at frame 100, heading for the keyframe that followed.
    expect(kfs[1]).toMatchObject({ frame: 40, easing: 'ease' })
    expect(kfs[1].value).toBeGreaterThan(-12)
    expect(kfs[1].value).toBeLessThan(0)
    expect(kfs[2]).toMatchObject({ frame: 90, value: -12 })
  })

  it('starts kept-whole clips that begin inside the stretch at the join, trimming any overlap', () => {
    const { p, add, on } = setup()
    const whoosh = add('Sound effects', 'audio', 45, 25) // starts inside: begins at the join, head intact
    const hit = add('Sound effects', 'audio', 72, 10) // after: moves left to 52
    const sting = add('Music', 'audio', 45, 10) // wholly inside: kept, at the join
    removeRange(p, 40, 60, new Set([whoosh.id, hit.id, sting.id]))
    // The whoosh would now run into the hit, so it's trimmed back to it.
    expect(on('Sound effects')).toEqual([[40, 52], [52, 62]])
    expect(p.clips[whoosh.id].inPoint).toBe(0)
    expect(on('Music')).toEqual([[40, 50]])
  })

  it('moves markers with the edit', () => {
    const { p } = setup()
    p.markers = [
      { id: 'a', frame: 10, label: 'a', color: 'lime' },
      { id: 'b', frame: 50, label: 'b', color: 'lime' },
      { id: 'c', frame: 90, label: 'c', color: 'lime' },
    ]
    removeRange(p, 40, 60)
    expect(p.markers.map((m) => m.frame)).toEqual([10, 40, 70])
  })

  it('re-packs the magnetic main track', () => {
    const { p, add, on } = setup()
    add('Main', 'video', 0, 50)
    add('Main', 'video', 50, 50)
    normalizeProject(p)
    removeRange(p, 30, 70)
    expect(on('Main')).toEqual([[0, 30], [30, 60]])
  })

  it('ignores empty stretches', () => {
    const { p, add, on } = setup()
    add('Overlay', 'video', 0, 50)
    removeRange(p, 20, 20)
    expect(on('Overlay')).toEqual([[0, 50]])
  })
})
