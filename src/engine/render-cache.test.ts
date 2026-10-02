import { describe, expect, it, vi } from 'vitest'
import { createClip } from '@/editor/defaults'
import { createEmptyProject } from '@/editor/new-project'
import type { Asset, Clip, ClipKind, Project } from '@/editor/types'

// The compositor and decoders need a browser; keys and spans don't.
vi.mock('./compositor', () => ({ clipsDrawnAt: () => [], renderFrame: () => ({ bounds: new Map() }) }))
vi.mock('./stills', () => ({ FrameFeeder: class {} }))
vi.mock('./media', () => ({ withVideoFrames: (_: unknown, draw: () => unknown) => draw() }))

const { chunkFrames, chunkKey, chunkSpan } = await import('./render-cache')

function setup() {
  const p = createEmptyProject('Renders')
  const track = (name: string) => p.tracks.find((t) => t.name === name)!.id
  const asset: Asset = { id: 'a1', name: 'Shot', kind: 'video', duration: 60, width: 1920, height: 1080, fps: 30, source: { type: 'file', url: 'lumen-media://local/a.mp4', fileName: 'a.mp4', mime: 'video/mp4', size: 1 }, addedAt: 0 }
  p.assets[asset.id] = asset
  const add = (trackName: string, kind: ClipKind, start: number, duration: number, extra: Partial<Clip> = {}) => {
    const c = createClip({ kind, trackId: track(trackName), start, duration, assetId: kind === 'video' ? asset.id : undefined, ...extra })
    p.clips[c.id] = c
    return c
  }
  return { p, add, track }
}

/** A copy of the project with one clip changed (the store makes new objects the same way). */
const withClip = (p: Project, id: string, patch: Partial<Clip>): Project => ({ ...p, clips: { ...p.clips, [id]: { ...p.clips[id], ...patch } } })

describe('render chunks', () => {
  it('cuts the timeline into two-second chunks, the last one ending with the timeline', () => {
    const { p, add } = setup()
    add('Main', 'video', 0, 100)
    expect(chunkFrames(30)).toBe(60)
    expect(chunkFrames(23.976)).toBe(48)
    expect(chunkSpan(p, 0)).toEqual([0, 60])
    expect(chunkSpan(p, 1)).toEqual([60, 100])
    expect(chunkSpan(p, 2)).toEqual([120, 120])
  })

  it('has no key where nothing is drawn', () => {
    const { p, add } = setup()
    add('Main', 'video', 60, 60)
    expect(chunkKey(p, 0, 0.5)).toBeNull()
    expect(chunkKey(p, 1, 0.5)).toEqual(expect.any(String))
  })

  it('keys change with the picture, not with sound or names', () => {
    const { p, add } = setup()
    const a = add('Main', 'video', 0, 120)
    const key = chunkKey(p, 0, 0.5)
    expect(chunkKey(withClip(p, a.id, { audio: { ...a.audio, volume: -6 } }), 0, 0.5)).toBe(key)
    expect(chunkKey(withClip(p, a.id, { name: 'Renamed' }), 0, 0.5)).toBe(key)
    expect(chunkKey(withClip(p, a.id, { transform: { ...a.transform, scale: 1.2 } }), 0, 0.5)).not.toBe(key)
    expect(chunkKey(p, 0, 1)).not.toBe(key)
    const renamed = { ...p, assets: { ...p.assets, a1: { ...p.assets.a1, name: 'New name', favorite: true } } }
    expect(chunkKey(renamed, 0, 0.5)).toBe(key)
    const moved = { ...p, assets: { ...p.assets, a1: { ...p.assets.a1, source: { type: 'file' as const, url: 'lumen-media://local/b.mp4', fileName: 'b.mp4', mime: 'video/mp4', size: 1 } } } }
    expect(chunkKey(moved, 0, 0.5)).not.toBe(key)
  })

  it('an edit only touches the chunks it overlaps, and undoing it brings the same keys back', () => {
    const { p, add } = setup()
    add('Main', 'video', 0, 60)
    const b = add('Main', 'video', 60, 60)
    const k0 = chunkKey(p, 0, 0.5)
    const k1 = chunkKey(p, 1, 0.5)
    const edited = withClip(p, b.id, { transform: { ...b.transform, x: 40 } })
    expect(chunkKey(edited, 0, 0.5)).toBe(k0)
    expect(chunkKey(edited, 1, 0.5)).not.toBe(k1)
    const undone = withClip(edited, b.id, { transform: { ...b.transform } })
    expect(chunkKey(undone, 1, 0.5)).toBe(k1)
  })

  it('hidden tracks don’t count', () => {
    const { p, add, track } = setup()
    add('Main', 'video', 0, 60)
    const key = chunkKey(p, 0, 0.5)
    add('Overlay', 'video', 0, 60)
    // Edits make new objects (keys are remembered per project state).
    const next = { ...p, clips: { ...p.clips } }
    expect(chunkKey(next, 0, 0.5)).not.toBe(key)
    const hidden = { ...next, tracks: next.tracks.map((t) => (t.id === track('Overlay') ? { ...t, hidden: true } : t)) }
    expect(chunkKey(hidden, 0, 0.5)).toBe(key)
  })

  it('a transition into a chunk depends on the clip before it', () => {
    const { p, add } = setup()
    const a = add('Main', 'video', 0, 60)
    add('Main', 'video', 60, 60, { transitionIn: { kind: 'dissolve', duration: 12 } })
    const k1 = chunkKey(p, 1, 0.5)
    expect(chunkKey(withClip(p, a.id, { transform: { ...a.transform, scale: 0.5 } }), 1, 0.5)).not.toBe(k1)
  })
})
