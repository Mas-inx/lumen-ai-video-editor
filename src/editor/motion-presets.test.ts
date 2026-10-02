import { beforeEach, describe, expect, it } from 'vitest'
import { createClip } from './defaults'
import { propAt } from './keyframes'
import { mergeKeyframes, MOTION_PRESETS, presetKeyframes } from './motion-presets'
import { createEmptyProject } from './new-project'
import { dispatch, getProject, useEditor } from './store'

const FRAME = { width: 1920, height: 1080, fps: 30 }

function clip(duration = 150) {
  return createClip({ kind: 'video', trackId: 't', start: 0, duration })
}

describe('motion presets', () => {
  it('every preset makes keyframes inside the clip', () => {
    const c = clip()
    for (const p of MOTION_PRESETS) {
      const { keys, range } = presetKeyframes(c, p.id, FRAME, { at: 60 })
      expect(Object.keys(keys).length, p.id).toBeGreaterThan(0)
      expect(range[0]).toBeGreaterThanOrEqual(0)
      expect(range[1]).toBeLessThanOrEqual(c.duration - 1)
      for (const list of Object.values(keys)) for (const k of list!) expect(k.frame >= range[0] && k.frame <= range[1], p.id).toBe(true)
    }
  })

  it('camera moves span the clip and glide', () => {
    const { keys, range } = presetKeyframes(clip(), 'ken-burns', FRAME)
    expect(range).toEqual([0, 149])
    expect(keys.scale![0].value).toBe(1)
    expect(keys.scale![1].value).toBeCloseTo(1.12, 3)
    expect(keys.scale![0].easing).toBe('sine-in-out')
  })

  it('entrances come from the right side and end where the clip is', () => {
    const c = clip()
    c.transform.x = 100
    const left = presetKeyframes(c, 'slide-in-left', FRAME).keys.x!
    expect(left[0].value).toBeLessThan(100)
    expect(left.at(-1)!.value).toBe(100)
    expect(presetKeyframes(c, 'slide-in-right', FRAME).keys.x![0].value).toBeGreaterThan(100)
    expect(presetKeyframes(c, 'slide-in-up', FRAME).keys.y![0].value).toBeGreaterThan(0) // rises from below
    expect(presetKeyframes(c, 'slide-in-down', FRAME).keys.y![0].value).toBeLessThan(0) // drops from above
    expect(presetKeyframes(c, 'pop-in', FRAME).keys.scale![0].easing).toBe('back-out')
  })

  it('exits sit at the end of the clip', () => {
    const { range, keys } = presetKeyframes(clip(), 'fade-out', FRAME)
    expect(range).toEqual([134, 149])
    expect(keys.opacity!.at(-1)!.value).toBe(0)
  })

  it('emphasis rides on what the clip already does', () => {
    const c = clip()
    c.keyframes.scale = presetKeyframes(c, 'ken-burns', FRAME).keys.scale
    const before = propAt(c, 'scale', 60)
    const { keys, range } = presetKeyframes(c, 'punch', FRAME, { at: 60 })
    expect(keys.scale![0].value).toBeCloseTo(before, 3)
    expect(keys.scale![1].value).toBeGreaterThan(before * 1.1)
    const merged = mergeKeyframes(c.keyframes.scale, keys.scale!, range)
    expect(merged[0].frame).toBe(0)
    expect(merged.at(-1)!.frame).toBe(149)
    expect(merged.length).toBe(5)
  })
})

describe('clip.animate', () => {
  beforeEach(() => useEditor.getState().loadProject(createEmptyProject('Motion')))

  it('adds editable keyframes in one undo step', () => {
    const track = getProject().tracks.find((t) => t.name === 'Overlay')!.id
    const res = dispatch('clip.add', { trackId: track, kind: 'image', start: 0, duration: 90 })
    const id = res.ok ? (res.result as string) : ''
    expect(dispatch('clip.animate', { clipId: id, preset: 'push-in', intensity: 2, easing: 'expo-in-out' }).ok).toBe(true)
    const scale = getProject().clips[id].keyframes.scale!
    expect(scale[0].easing).toBe('expo-in-out')
    expect(scale.at(-1)!.value).toBeCloseTo(1.5, 3)
    useEditor.getState().undo()
    expect(getProject().clips[id].keyframes.scale).toBeUndefined()
  })

  it('refuses audio and unknown presets', () => {
    const track = getProject().tracks.find((t) => t.kind === 'audio')!.id
    const res = dispatch('clip.add', { trackId: track, kind: 'audio', start: 0, duration: 90 })
    const id = res.ok ? (res.result as string) : ''
    expect(dispatch('clip.animate', { clipId: id, preset: 'push-in' }).ok).toBe(false)
    expect(dispatch('clip.animate', { clipId: id, preset: 'teleport' as 'push-in' }).ok).toBe(false)
  })
})
