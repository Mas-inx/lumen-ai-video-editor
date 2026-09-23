import { beforeEach, describe, expect, it } from 'vitest'
import { createClip } from './defaults'
import { createEmptyProject } from './new-project'
import { clipEnd } from './ops'
import { beginTransaction, dispatch, endTransaction, getProject, migrateProject, rollbackTo, savepoint, useEditor } from './store'
import type { Project } from './types'

const trackId = (name: string) => getProject().tracks.find((t) => t.name === name)!.id

beforeEach(() => useEditor.getState().loadProject(createEmptyProject('Store')))

describe('dispatch', () => {
  it('applies a command as one undoable step', () => {
    const v0 = useEditor.getState().version
    const r = dispatch('clip.add', { trackId: trackId('Titles'), kind: 'text', start: 10, duration: 30 })
    expect(r.ok).toBe(true)
    const id = (r as { result: string }).result
    expect(getProject().clips[id]).toMatchObject({ start: 10, duration: 30 })
    expect(useEditor.getState().version).toBe(v0 + 1)

    useEditor.getState().undo()
    expect(getProject().clips[id]).toBeUndefined()
    useEditor.getState().redo()
    expect(getProject().clips[id]).toMatchObject({ start: 10, duration: 30 })
  })

  it('rejects invalid input without touching the project or history', () => {
    const before = getProject()
    const r = dispatch('clip.add', { trackId: trackId('Titles'), kind: 'text', start: -5, duration: 0 })
    expect(r.ok).toBe(false)
    expect(getProject()).toBe(before)
    expect(useEditor.getState().past).toHaveLength(0)
  })

  it('reports command errors instead of throwing', () => {
    const r = dispatch('clip.split', { frame: 500 })
    expect(r).toEqual({ ok: false, error: 'Nothing to split at the playhead' })
  })

  it('refuses edits on locked tracks', () => {
    const r = dispatch('clip.add', { trackId: trackId('Titles'), kind: 'text', start: 0, duration: 30 })
    const id = (r as { result: string }).result
    dispatch('track.update', { id: trackId('Titles'), patch: { locked: true } })
    const del = dispatch('clip.delete', { ids: [id] })
    expect(del.ok).toBe(false)
    expect(getProject().clips[id]).toBeDefined()
  })

  it('applies background data without an undo step or an unsaved-changes bump', () => {
    const r = dispatch('clip.add', { trackId: trackId('Titles'), kind: 'text', start: 0, duration: 30 })
    const id = (r as { result: string }).result
    const { version, past } = useEditor.getState()
    dispatch('clip.update', { ids: [id], patch: { name: 'Renamed' } }, { history: false })
    expect(getProject().clips[id].name).toBe('Renamed')
    expect(useEditor.getState().version).toBe(version)
    expect(useEditor.getState().past).toHaveLength(past.length)
  })

  it('merges rapid edits with the same coalesce key (slider drags)', () => {
    const r = dispatch('clip.add', { trackId: trackId('Titles'), kind: 'text', start: 0, duration: 30 })
    const id = (r as { result: string }).result
    const steps = useEditor.getState().past.length
    for (const x of [10, 20, 30]) dispatch('clip.update', { ids: [id], patch: { transform: { x } } }, { coalesce: 'drag' })
    expect(useEditor.getState().past).toHaveLength(steps + 1)
    useEditor.getState().undo()
    expect(getProject().clips[id].transform.x).toBe(0)
  })
})

describe('transactions', () => {
  it('group several commands into one undo step', () => {
    const entry = useEditor.getState().transaction('Build', 'ai', () => {
      dispatch('clip.add', { trackId: trackId('Titles'), kind: 'text', start: 0, duration: 30 })
      dispatch('clip.add', { trackId: trackId('Overlay'), kind: 'adjustment', start: 0, duration: 60 })
      dispatch('marker.add', { frame: 15 })
    })
    expect(entry).toMatchObject({ label: 'Build', source: 'ai' })
    expect(useEditor.getState().past).toHaveLength(1)
    expect(Object.keys(getProject().clips)).toHaveLength(2)
    useEditor.getState().undo()
    expect(Object.keys(getProject().clips)).toHaveLength(0)
    expect(getProject().markers).toHaveLength(0)
  })

  it('span async work with begin/end', () => {
    beginTransaction('Agent', 'ai')
    dispatch('marker.add', { frame: 1 })
    dispatch('marker.add', { frame: 2 })
    const entry = endTransaction()
    expect(entry?.patches.length).toBeGreaterThan(0)
    expect(useEditor.getState().past).toHaveLength(1)
  })

  it('leave no empty steps behind', () => {
    expect(useEditor.getState().transaction('Nothing', 'user', () => {})).toBeNull()
    expect(useEditor.getState().past).toHaveLength(0)
  })
})

describe('savepoints', () => {
  it('roll a failed multi-step edit back without leaving a history step', () => {
    const v0 = useEditor.getState().version
    const entry = useEditor.getState().transaction('Batch', 'ai', () => {
      const mark = savepoint()!
      dispatch('marker.add', { frame: 1 })
      dispatch('clip.add', { trackId: trackId('Titles'), kind: 'text', start: 0, duration: 30 })
      rollbackTo(mark)
    })
    expect(entry).toBeNull()
    expect(getProject().markers).toHaveLength(0)
    expect(Object.keys(getProject().clips)).toHaveLength(0)
    expect(useEditor.getState().past).toHaveLength(0)
    expect(useEditor.getState().version).toBe(v0)
  })

  it('only undo what came after the mark, inside a longer transaction', () => {
    useEditor.getState().transaction('Agent run', 'ai', () => {
      dispatch('marker.add', { frame: 1 })
      const mark = savepoint()!
      dispatch('marker.add', { frame: 2 })
      dispatch('marker.add', { frame: 3 })
      rollbackTo(mark)
      dispatch('marker.add', { frame: 4 })
    })
    expect(getProject().markers.map((m) => m.frame)).toEqual([1, 4])
    expect(useEditor.getState().past).toHaveLength(1)
    useEditor.getState().undo()
    expect(getProject().markers).toHaveLength(0)
  })

  it('are unavailable outside a transaction', () => {
    expect(savepoint()).toBeNull()
  })
})

describe('timeline.removeRange', () => {
  it('validates the stretch and undoes exactly', () => {
    dispatch('clip.add', { trackId: trackId('Overlay'), kind: 'adjustment', start: 0, duration: 100 })
    expect(dispatch('timeline.removeRange', { start: 50, end: 50 }).ok).toBe(false)
    const snapshot = JSON.stringify(getProject())
    expect(dispatch('timeline.removeRange', { start: 20, end: 50 }).ok).toBe(true)
    expect(Object.values(getProject().clips).map((c) => [c.start, clipEnd(c)])).toEqual([[0, 20], [20, 70]])
    useEditor.getState().undo()
    expect(JSON.stringify(getProject())).toBe(snapshot)
  })
})

describe('loadProject / migrateProject', () => {
  it('clears history and fills in fields older projects lack', () => {
    dispatch('marker.add', { frame: 1 })
    const old = createEmptyProject('Old') as Partial<Project> & Project
    const clip = createClip({ kind: 'text', trackId: old.tracks[0].id, start: 0, duration: 10 })
    // Saved before 3D transforms and newer text options existed.
    clip.transform = { x: 5, y: 0, scale: 1, rotation: 0, opacity: 1 } as typeof clip.transform
    clip.text = { content: 'Hi' } as typeof clip.text
    old.clips = { [clip.id]: clip }
    delete (old as { markers?: unknown }).markers

    const p = migrateProject(old)
    useEditor.getState().loadProject(p)
    expect(useEditor.getState().past).toHaveLength(0)
    const c = getProject().clips[clip.id]
    expect(c.transform).toMatchObject({ x: 5, rotateX: 0, rotateY: 0, z: 0 })
    expect(c.text).toMatchObject({ content: 'Hi', font: 'sans' })
    expect(getProject().markers).toEqual([])
  })
})
