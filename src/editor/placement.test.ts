import { beforeEach, describe, expect, it } from 'vitest'
import { createEmptyProject } from './new-project'
import { audioRole, placeAsset } from './placement'
import { getProject, useEditor } from './store'
import type { Asset } from './types'

function audio(id: string, name: string, extra: Partial<Asset> = {}): Asset {
  return {
    id,
    name,
    kind: 'audio',
    duration: 3,
    hasAudio: true,
    source: { type: 'file', url: `lumen-media://file/${id}.wav`, mime: 'audio/wav', fileName: `${id}.wav`, size: 1 },
    addedAt: 0,
    ...extra,
  }
}

const trackOf = (clipId: string | null) => getProject().tracks.find((t) => t.id === getProject().clips[clipId!]?.trackId)?.name

beforeEach(() => {
  const p = createEmptyProject('Placement')
  for (const a of [
    audio('fx', 'Whoosh', { tags: ['sfx:whoosh', 'sfx', 'Transitions'] }),
    audio('gen_fx', 'Door slam', { provenance: { integration: 'elevenlabs', tool: 'sound-generation' } }),
    audio('song', 'Night drive', { duration: 120, provenance: { integration: 'elevenlabs', tool: 'music' } }),
    audio('vo', 'Take 3', { duration: 30, transcript: [{ start: 0, end: 2, text: 'Hello' }] }),
    audio('named', 'intro-music-final', { duration: 90 }),
    audio('mystery', 'clip-0042', { duration: 12 }),
  ])
    p.assets[a.id] = a
  useEditor.getState().loadProject(p)
})

describe('audioRole', () => {
  it('reads tags, provenance, transcripts and names', () => {
    const a = getProject().assets
    expect(audioRole(a.fx)).toBe('sfx')
    expect(audioRole(a.gen_fx)).toBe('sfx')
    expect(audioRole(a.song)).toBe('music')
    expect(audioRole(a.vo)).toBe('voice')
    expect(audioRole(a.named)).toBe('music')
    expect(audioRole(a.mystery)).toBeNull()
  })
})

describe('placeAsset', () => {
  it('puts each kind of sound on its own track', () => {
    expect(trackOf(placeAsset('fx', 30))).toBe('Sound effects')
    expect(trackOf(placeAsset('song', 0))).toBe('Music')
    expect(trackOf(placeAsset('vo', 0))).toBe('Voice')
  })

  it('stacks a second effect on a new Sound effects track rather than moving it in time', () => {
    const first = placeAsset('fx', 30)
    const second = placeAsset('gen_fx', 45)
    expect(getProject().clips[second!].start).toBe(45)
    expect(trackOf(second)).toBe('Sound effects')
    expect(getProject().clips[second!].trackId).not.toBe(getProject().clips[first!].trackId)
  })

  it('falls back to the first free audio track for sounds it can’t classify', () => {
    expect(trackOf(placeAsset('mystery', 0))).toBe('Voice')
  })
})
