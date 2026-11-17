import { beforeEach, describe, expect, it } from 'vitest'
import { createClip } from './defaults'
import { createEmptyProject } from './new-project'
import { dispatch, getProject, useEditor } from './store'
import { plannedSeconds, rangeOfClips, sceneClips, sceneRange, sceneStarts } from './storyboard'
import type { Asset, Project } from './types'

const still = (id: string, name: string): Asset => ({
  id,
  name,
  kind: 'image',
  width: 1920,
  height: 1080,
  source: { type: 'file', url: `lumen-media://file/${id}.jpg`, mime: 'image/jpeg', fileName: `${id}.jpg`, size: 1 },
  addedAt: 1,
})

const trackId = (p: Project, name: string) => p.tracks.find((t) => t.name === name)!.id

beforeEach(() => {
  const p = createEmptyProject('Plan')
  for (const a of [still('a_city', 'City skyline'), still('a_road', 'Road trip')]) p.assets[a.id] = a
  // Two shots on the main track: 0–90 and 90–150.
  const main = trackId(p, 'Main')
  p.clips.c1 = createClip({ id: 'c1', kind: 'image', trackId: main, start: 0, duration: 90, assetId: 'a_city' })
  p.clips.c2 = createClip({ id: 'c2', kind: 'image', trackId: main, start: 90, duration: 60, assetId: 'a_road' })
  useEditor.getState().loadProject(p)
})

const add = (scenes: Record<string, unknown>[], index?: number) => {
  const res = dispatch('storyboard.addScenes', { scenes, ...(index !== undefined ? { index } : {}) } as never)
  if (!res.ok) throw new Error(res.error)
  return res.result as string[]
}

const scenes = () => getProject().storyboard!.scenes

describe('storyboard commands', () => {
  it('make the storyboard with the first scenes, filling in what they leave out', () => {
    expect(getProject().storyboard).toBeUndefined()
    const [a, b] = add([{ title: 'Hook', script: 'What if your city had no cars?', treatment: 'broll', seconds: 4 }, { title: 'Proof' }])
    expect(scenes().map((s) => s.id)).toEqual([a, b])
    expect(scenes()[0]).toMatchObject({ title: 'Hook', treatment: 'broll', seconds: 4, status: 'planned', transition: null, needs: [], assetIds: [] })
    expect(scenes()[1]).toMatchObject({ title: 'Proof', script: '', treatment: 'footage', seconds: 5, notes: '' })
    expect(useEditor.getState().past.at(-1)?.label).toBe('Add 2 scenes')
    useEditor.getState().undo()
    expect(getProject().storyboard).toBeUndefined()
  })

  it('insert at an index, and refuse ids that are taken or media that isn’t there', () => {
    add([{ id: 'one', title: 'One' }, { id: 'three', title: 'Three' }])
    add([{ id: 'two', title: 'Two' }], 1)
    expect(scenes().map((s) => s.title)).toEqual(['One', 'Two', 'Three'])
    expect(dispatch('storyboard.addScenes', { scenes: [{ id: 'two' }] })).toMatchObject({ ok: false, error: expect.stringMatching(/already a scene with id two/) })
    expect(dispatch('storyboard.addScenes', { scenes: [{ assetIds: ['a_city', 'ghost'] }] })).toMatchObject({ ok: false, error: expect.stringMatching(/No media ghost/) })
    expect(scenes()).toHaveLength(3)
  })

  it('update a scene, and say which scenes there are when the id is wrong', () => {
    const [id] = add([{ title: 'Intro' }])
    expect(dispatch('storyboard.updateScene', { id, patch: { status: 'in-progress', needs: ['A drone shot of the bay'], assetIds: ['a_city', 'a_city'], transition: { kind: 'dissolve', seconds: 0.5 } } }).ok).toBe(true)
    expect(scenes()[0]).toMatchObject({ status: 'in-progress', needs: ['A drone shot of the bay'], assetIds: ['a_city'], transition: { kind: 'dissolve', seconds: 0.5 } })
    const bad = dispatch('storyboard.updateScene', { id: 'nope', patch: { title: 'x' } })
    expect(bad).toMatchObject({ ok: false, error: expect.stringMatching(new RegExp(`Scene nope isn’t in the storyboard — scenes: ${id} \\(1\\. Intro\\)`)) })
    expect(dispatch('storyboard.updateScene', { id, patch: { status: 'done' } })).toMatchObject({ ok: true })
    expect(useEditor.getState().past.at(-1)?.label).toBe('Scene done')
  })

  it('merge typing into one undo step', () => {
    const [id] = add([{ title: '' }])
    const steps = useEditor.getState().past.length
    for (const title of ['T', 'Th', 'The', 'The end']) dispatch('storyboard.updateScene', { id, patch: { title } }, { coalesce: `scene:${id}:title` })
    expect(scenes()[0].title).toBe('The end')
    expect(useEditor.getState().past.length).toBe(steps + 1)
  })

  it('reorder and remove scenes — the clips they were made into stay', () => {
    const [a, b, c] = add([{ title: 'A' }, { title: 'B' }, { title: 'C' }])
    dispatch('storyboard.moveScene', { id: c, index: 0 })
    expect(scenes().map((s) => s.title)).toEqual(['C', 'A', 'B'])
    dispatch('storyboard.moveScene', { id: c, index: 99 })
    expect(scenes().map((s) => s.title)).toEqual(['A', 'B', 'C'])
    dispatch('storyboard.updateScene', { id: a, patch: { produced: { clipIds: ['c1'] } } })
    expect(dispatch('storyboard.removeScenes', { ids: [a, b] }).ok).toBe(true)
    expect(scenes().map((s) => s.id)).toEqual([c])
    expect(getProject().clips.c1).toBeDefined()
    expect(dispatch('storyboard.removeScenes', { ids: ['ghost'] }).ok).toBe(false)
  })

  it('set the brief and the style, and clear the style with null', () => {
    dispatch('storyboard.update', { brief: 'A 30 s teaser for the city’s car-free day', style: 'documentary' })
    expect(getProject().storyboard).toMatchObject({ brief: 'A 30 s teaser for the city’s car-free day', style: 'documentary', scenes: [] })
    expect(useEditor.getState().past.at(-1)?.label).toBe('New storyboard')
    dispatch('storyboard.update', { style: null })
    expect(getProject().storyboard!.style).toBeUndefined()
    expect(useEditor.getState().past.at(-1)?.label).toBe('Edit storyboard')
  })
})

describe('where a scene was produced', () => {
  it('is the stretch its clips cover, given just the clips', () => {
    const [id] = add([{ title: 'Both shots' }])
    expect(dispatch('storyboard.updateScene', { id, patch: { produced: { clipIds: ['c2', 'c1'] } } }).ok).toBe(true)
    expect(scenes()[0].produced).toEqual({ timelineId: 'seq_main', from: 0, to: 150, clipIds: ['c2', 'c1'] })
    expect(useEditor.getState().past.at(-1)?.label).toBe('Link scene to the timeline')
  })

  it('follows its clips through later edits, and keeps its stretch once they’re gone', () => {
    const [id] = add([{ title: 'Road', produced: { clipIds: ['c2'] } }])
    expect(sceneRange(getProject(), scenes()[0])).toMatchObject({ from: 90, to: 150, fps: 30, open: true, clipIds: ['c2'] })
    // The magnetic main track closes up when the first shot goes.
    dispatch('clip.delete', { ids: ['c1'] })
    expect(sceneRange(getProject(), scenes()[0])).toMatchObject({ from: 0, to: 60 })
    expect(sceneClips(getProject(), scenes()[0]).map((c) => c.id)).toEqual(['c2'])
    dispatch('clip.delete', { ids: ['c2'] })
    expect(sceneRange(getProject(), scenes()[0])).toMatchObject({ from: 90, to: 150, clipIds: [] })
    expect(scenes()[0].id).toBe(id)
  })

  it('takes frames too, checks them, and clears with null', () => {
    const [id] = add([{ title: 'Frames' }])
    expect(dispatch('storyboard.updateScene', { id, patch: { produced: { from: 30, to: 60 } } }).ok).toBe(true)
    expect(scenes()[0].produced).toEqual({ timelineId: 'seq_main', from: 30, to: 60 })
    expect(dispatch('storyboard.updateScene', { id, patch: { produced: { from: 60, to: 60 } } })).toMatchObject({ ok: false, error: 'to must be after from' })
    expect(dispatch('storyboard.updateScene', { id, patch: { produced: {} } })).toMatchObject({ ok: false, error: expect.stringMatching(/clipIds.*or from and to/) })
    expect(dispatch('storyboard.updateScene', { id, patch: { produced: { clipIds: ['ghost'] } } })).toMatchObject({ ok: false, error: expect.stringMatching(/None of those clips/) })
    expect(dispatch('storyboard.updateScene', { id, patch: { produced: { timelineId: 'seq_gone', from: 0, to: 5 } } })).toMatchObject({ ok: false, error: 'Timeline seq_gone not found' })
    dispatch('storyboard.updateScene', { id, patch: { produced: null } })
    expect(scenes()[0].produced).toBeUndefined()
  })

  it('stays on its own timeline when another one opens', () => {
    add([{ title: 'Main', produced: { clipIds: ['c1'] } }])
    const other = dispatch('sequence.create', { name: 'Vertical', settings: { width: 1080, height: 1920 } })
    expect(other.ok).toBe(true)
    const range = sceneRange(getProject(), scenes()[0])!
    expect(range).toMatchObject({ timelineId: 'seq_main', open: false, from: 0, to: 90 })
    expect(sceneClips(getProject(), scenes()[0])).toEqual([])
    expect(rangeOfClips(getProject(), ['c1'], 'seq_main')).toEqual([0, 90])
  })

  it('is re-timed with its timeline when the frame rate changes', () => {
    add([{ title: 'Frames', produced: { from: 30, to: 90 } }])
    dispatch('project.update', { settings: { fps: 60 } })
    expect(scenes()[0].produced).toMatchObject({ from: 60, to: 180 })
  })
})

describe('the plan', () => {
  it('adds up: where each scene starts, and the planned length', () => {
    add([{ seconds: 3 }, { seconds: 4.5 }, { seconds: 2 }])
    expect(sceneStarts(getProject().storyboard)).toEqual([0, 3, 7.5])
    expect(plannedSeconds(getProject().storyboard)).toBe(9.5)
    expect(sceneStarts(undefined)).toEqual([])
  })

  it('lets go of media that leaves the project', () => {
    add([{ assetIds: ['a_city', 'a_road'] }])
    dispatch('asset.remove', { ids: ['a_city'] })
    expect(scenes()[0].assetIds).toEqual(['a_road'])
  })
})

describe('media descriptions', () => {
  it('are set, trimmed and cleared with asset_update', () => {
    dispatch('asset.update', { id: 'a_city', patch: { description: '  Aerial dusk skyline, lights coming on  ' } })
    expect(getProject().assets.a_city.description).toBe('Aerial dusk skyline, lights coming on')
    expect(useEditor.getState().past.at(-1)?.label).toBe('Describe media')
    dispatch('asset.update', { id: 'a_city', patch: { description: '' } })
    expect(getProject().assets.a_city.description).toBeUndefined()
  })
})

describe('the project brand', () => {
  const brand = {
    name: 'Acme',
    colors: [{ name: 'Orange', hex: '#ff5a36' }],
    fonts: { heading: 'display' as const, body: 'sans' as const },
    logoAssetIds: ['a_city'],
    titles: { color: '#ffffff', background: null, weight: 700, uppercase: false, tracking: 0 },
    captions: { style: 'bold' as const, accent: '#ff5a36', uppercase: null },
    look: 'vivid',
    motion: { titleIn: 'rise' as const, titleOut: 'fade' as const, seconds: 0.5, easing: 'cubic-out' as const, transition: 'cut' as const, transitionSeconds: 0.5 },
    style: 'commercial',
  }

  it('is set and removed as one step each, its fonts and logos checked', () => {
    expect(dispatch('brand.set', { brand }).ok).toBe(true)
    expect(getProject().brand).toMatchObject({ name: 'Acme', logoAssetIds: ['a_city'] })
    expect(useEditor.getState().past.at(-1)?.label).toBe('Brand: Acme')
    expect(dispatch('brand.set', { brand: { ...brand, fonts: { heading: 'custom:nope', body: 'sans' } } })).toMatchObject({ ok: false, error: expect.stringMatching(/custom:nope isn’t in this project/) })
    expect(dispatch('brand.set', { brand: { ...brand, logoAssetIds: ['ghost'] } })).toMatchObject({ ok: false, error: expect.stringMatching(/No media ghost/) })
    expect(dispatch('brand.set', { brand: { ...brand, colors: [{ name: 'Bad', hex: 'orange' }] } }).ok).toBe(false)
    dispatch('asset.remove', { ids: ['a_city'] })
    expect(getProject().brand!.logoAssetIds).toEqual([])
    dispatch('brand.set', { brand: null })
    expect(getProject().brand).toBeUndefined()
  })
})
