import { describe, expect, it } from 'vitest'
import { createClip } from '@/editor/defaults'
import { createEmptyProject } from '@/editor/new-project'
import type { Asset, Project } from '@/editor/types'
import { mediaToProject, projectToLayer, projectToMedia, trackingSource } from './analysis-actions'

const video: Asset = { id: 'a', name: 'cam', kind: 'video', duration: 10, width: 1280, height: 720, hasAudio: true, source: { type: 'file', url: 'a.mp4', mime: 'video/mp4', fileName: 'a.mp4', size: 1 }, addedAt: 0 }
const portrait: Asset = { ...video, id: 'p', width: 720, height: 1280 }

function setup(): Project {
  const p = createEmptyProject('Map')
  p.assets.a = video
  p.assets.p = portrait
  return p
}

describe('footage ↔ frame mapping', () => {
  it('maps a full-frame clip’s footage onto the frame', () => {
    const p = setup()
    const clip = createClip({ kind: 'video', trackId: p.tracks[2].id, start: 0, duration: 300, assetId: 'a' })
    expect(mediaToProject(p, clip, video, 0, 0.5, 0.5)).toEqual([0, 0])
    expect(mediaToProject(p, clip, video, 0, 1, 1)).toEqual([960, 540])
    // A portrait picture is fitted inside: its right edge sits well inside the frame.
    const tall = createClip({ kind: 'video', trackId: p.tracks[2].id, start: 0, duration: 300, assetId: 'p' })
    expect(mediaToProject(p, tall, portrait, 0, 1, 0.5)[0]).toBeCloseTo((1080 * (720 / 1280)) / 2, 6)
  })

  it('goes back and forth through moves, scaling, turns and stabilization', () => {
    const p = setup()
    const clip = createClip({ kind: 'video', trackId: p.tracks[2].id, start: 0, duration: 300, assetId: 'a', transform: { x: 120, y: -80, scale: 1.4, rotation: 12 } })
    clip.stabilize = { start: 0, rate: 30, path: [0, 0, 0, 0.02, -0.01, 0.01, 0.05, 0.02, -0.02], smooth: 0.3, zoom: 1.08, rotation: true }
    for (const [u, v] of [
      [0.2, 0.7],
      [0.9, 0.1],
    ]) {
      const [x, y] = mediaToProject(p, clip, video, 1, u, v)
      const [u2, v2] = projectToMedia(p, clip, video, 1, x, y)
      expect(u2).toBeCloseTo(u, 9)
      expect(v2).toBeCloseTo(v, 9)
    }
    // Mask space of an untransformed adjustment layer is just the frame.
    const adj = createClip({ kind: 'adjustment', trackId: p.tracks[0].id, start: 0, duration: 300 })
    expect(projectToLayer(p, adj, 0, 480, -270)).toEqual([0.75, 0.25])
  })

  it('reads the footage under a clip — or the clip itself for its masks', () => {
    const p = setup()
    const main = createClip({ kind: 'video', trackId: p.tracks[2].id, start: 0, duration: 300, assetId: 'a' })
    const pip = createClip({ kind: 'video', trackId: p.tracks[1].id, start: 0, duration: 300, assetId: 'p' })
    const title = createClip({ kind: 'text', trackId: p.tracks[0].id, start: 0, duration: 300 })
    for (const c of [main, pip, title]) p.clips[c.id] = c
    expect(trackingSource(p, title, 10, false)?.id).toBe(pip.id)
    expect(trackingSource(p, pip, 10, false)?.id).toBe(main.id)
    expect(trackingSource(p, pip, 10, true)?.id).toBe(pip.id)
    expect(trackingSource(p, main, 10, false)).toBeNull()
  })
})
