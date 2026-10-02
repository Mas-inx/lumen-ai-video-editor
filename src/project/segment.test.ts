import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/engine/compositor', () => ({ clipSourceTime: (_c: unknown, local: number, fps: number) => local / fps }))

const { steady, subjectBox } = await import('./segment')
const { createEmptyProject } = await import('@/editor/new-project')
const { dispatch, getProject, useEditor } = await import('@/editor/store')

describe('subject mattes', () => {
  it('find the subject’s box', () => {
    const w = 40
    const h = 20
    const alpha = new Uint8Array(w * h)
    for (let y = 4; y < 18; y++) for (let x = 10; x < 22; x++) alpha[y * w + x] = 255
    const box = subjectBox(alpha, w, h)!
    expect(box.x).toBeCloseTo(10 / 40, 2)
    expect(box.y).toBeCloseTo(4 / 20, 2)
    expect(box.w).toBeGreaterThan(0.25)
    expect(subjectBox(new Uint8Array(w * h), w, h)).toBeNull()
  })

  it('calm flicker but keep real motion', () => {
    const prev = new Uint8Array([200, 200, 0, 255])
    const next = steady(new Uint8Array([220, 20, 30, 0]), prev)
    expect(next[0]).toBe(210) // small change: blended
    expect(next[1]).toBe(20) // big change: real motion, kept
    expect(next[2]).toBe(15)
    expect(next[3]).toBe(0)
  })
})

describe('mattes on clips', () => {
  beforeEach(() => useEditor.getState().loadProject(createEmptyProject('Matte')))

  it('only accept real mattes, and go away with their footage', () => {
    const p = getProject()
    const main = p.tracks.find((t) => t.role === 'main')!.id
    const source = { type: 'file' as const, url: 'lumen-media://local/a.mp4', fileName: 'a.mp4', mime: 'video/mp4', size: 1 }
    dispatch('asset.add', { asset: { id: 'a1', name: 'Shot', kind: 'video', duration: 4, source, addedAt: 0 } })
    dispatch('asset.add', { asset: { id: 'plain', name: 'Other', kind: 'video', duration: 4, source, addedAt: 0 } })
    dispatch('asset.add', { asset: { id: 'm1', name: 'Shot — person matte', kind: 'video', duration: 4, source, matteOf: { assetId: 'a1', subject: 'person', from: 0, to: 4 }, addedAt: 0 } })
    const r = dispatch('clip.add', { trackId: main, kind: 'video', start: 0, duration: 60, assetId: 'a1' })
    const id = r.ok ? (r.result as string) : ''
    expect(dispatch('clip.update', { ids: [id], patch: { matte: { assetId: 'plain', from: 0 } } }).ok).toBe(false)
    expect(dispatch('clip.update', { ids: [id], patch: { matte: { assetId: 'm1', from: 0 } } }).ok).toBe(true)
    expect(getProject().clips[id].matte?.assetId).toBe('m1')
    // Removing the matte's footage takes the matte (and the clips using the footage) with it.
    dispatch('asset.remove', { ids: ['a1'] })
    expect(getProject().assets.m1).toBeUndefined()
    expect(getProject().clips[id]).toBeUndefined()
  })

  it('removing just the matte shows the whole picture again', () => {
    const p = getProject()
    const main = p.tracks.find((t) => t.role === 'main')!.id
    const source = { type: 'file' as const, url: 'lumen-media://local/a.mp4', fileName: 'a.mp4', mime: 'video/mp4', size: 1 }
    dispatch('asset.add', { asset: { id: 'a1', name: 'Shot', kind: 'video', duration: 4, source, addedAt: 0 } })
    dispatch('asset.add', { asset: { id: 'm1', name: 'Matte', kind: 'video', duration: 4, source, matteOf: { assetId: 'a1', subject: 'person', from: 0, to: 4 }, addedAt: 0 } })
    const r = dispatch('clip.add', { trackId: main, kind: 'video', start: 0, duration: 60, assetId: 'a1', patch: { matte: { assetId: 'm1', from: 0 } } })
    const id = r.ok ? (r.result as string) : ''
    dispatch('asset.remove', { ids: ['m1'] })
    expect(getProject().clips[id].matte).toBeUndefined()
  })
})
