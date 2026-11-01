import { beforeEach, describe, expect, it } from 'vitest'
import { createEmptyProject } from './new-project'
import { audioRole, placeAsset } from './placement'
import { dispatch, getProject, useEditor } from './store'
import type { Asset } from './types'
import { useUI } from './ui-store'

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
    expect(trackOf(placeAsset('vo', 0))).toBe('Voice any')
  })

  it('stacks a second effect on a new Sound effects track rather than moving it in time', () => {
    const first = placeAsset('fx', 30)
    const second = placeAsset('gen_fx', 45)
    expect(getProject().clips[second!].start).toBe(45)
    expect(trackOf(second)).toBe('Sound effects')
    expect(getProject().clips[second!].trackId).not.toBe(getProject().clips[first!].trackId)
  })

  it('falls back to the first free audio track for sounds it can’t classify', () => {
    expect(trackOf(placeAsset('mystery', 0))).toBe('Voice any')
  })
})

describe('placeAsset with several audio tracks', () => {
  const stream = (index: number, name: string) => ({ index, name, channels: 2, codec: 'aac' })
  const video = (id: string, extra: Partial<Asset> = {}): Asset => ({
    id,
    name: id,
    kind: 'video',
    duration: 10,
    hasAudio: true,
    source: { type: 'file', url: `lumen-media://file/${id}.mkv`, mime: 'video/x-matroska', fileName: `${id}.mkv`, size: 1 },
    addedAt: 0,
    ...extra,
  })

  beforeEach(() => {
    const p = getProject()
    for (const a of [
      video('multi', { audioTracks: [stream(0, 'Mic'), stream(1, 'Game'), stream(2, 'Comms')] }),
      video('single'),
    ])
      p.assets[a.id] = a
    useEditor.getState().loadProject(p)
    useUI.getState().setAudioTracksClip(null)
  })

  it('asks which audio tracks to use when the file has more than one', () => {
    const id = placeAsset('multi', 0)
    expect(useUI.getState().audioTracksClipId).toBe(id)
  })

  it('does not ask when the file has a single audio track', () => {
    placeAsset('single', 0)
    expect(useUI.getState().audioTracksClipId).toBeNull()
  })

  it('does not interrupt the AI', () => {
    placeAsset('multi', 0, { source: 'ai' })
    expect(useUI.getState().audioTracksClipId).toBeNull()
  })
})

describe('splitting a multi-track recording', () => {
  it('puts each chosen track on its own named audio track, linked to the picture', () => {
    const p = getProject()
    p.assets.rec = {
      id: 'rec',
      name: 'rec',
      kind: 'video',
      duration: 10,
      hasAudio: true,
      source: { type: 'file', url: 'lumen-media://file/rec.mkv', mime: 'video/x-matroska', fileName: 'rec.mkv', size: 1 },
      addedAt: 0,
      audioTracks: [0, 1, 2, 3, 4].map((index) => ({ index, name: null, channels: 2, codec: 'aac' })),
    }
    useEditor.getState().loadProject(p)
    const clipId = placeAsset('rec', 0)!
    // Mic, game, comms, app — but not the combined backup, which would play everything twice.
    const res = dispatch('clip.splitAudioTracks', { id: clipId, tracks: [0, 1, 2, 3], names: { '0': 'Voice Mic', '1': 'Main Sync', '2': 'Voice Comms', '3': 'App' } })
    expect(res.ok).toBe(true)
    const made = (res as { result: string[] }).result.map((id) => getProject().clips[id])
    expect(made.map((c) => c.name)).toEqual(['Voice Mic', 'Main Sync', 'Voice Comms', 'App'])
    expect(new Set(made.map((c) => c.trackId)).size).toBe(4)
    expect(made.map((c) => getProject().assets[c.assetId!].source.type === 'file' && (getProject().assets[c.assetId!].source as { audioTrack?: number }).audioTrack)).toEqual([0, 1, 2, 3])
    // The picture goes silent and stays linked to every track.
    expect(getProject().clips[clipId].audio.detached).toBe(true)
    expect(made.every((c) => c.groupId === getProject().clips[clipId].groupId)).toBe(true)
    // The mic track can be muted on its own without touching the others.
    const mic = getProject().tracks.find((t) => t.name === 'Voice Mic')!
    dispatch('track.update', { id: mic.id, patch: { muted: true } })
    expect(getProject().tracks.find((t) => t.name === 'Voice Mic')!.muted).toBe(true)
    expect(getProject().tracks.find((t) => t.name === 'Voice Comms')!.muted).toBeFalsy()
  })
})