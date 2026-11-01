import { describe, expect, it } from 'vitest'
import { createClip } from './defaults'
import { createEmptyProject } from './new-project'
import { clipEnd, clipsOnTrack, detachAudio, reattachAudio, splitAudioClips, splitAudioTracks } from './ops'
import { streamInfo } from '@/engine/decode'
import type { Asset, AudioStreamInfo, Clip, Project } from './types'

// A recording with five audio tracks: Mic, Game, Comms, App, and everything mixed as a backup.
const STREAMS: AudioStreamInfo[] = ['Mic', 'Game', 'Comms', 'App', null].map((name, index) => ({ index, name, channels: 2, codec: 'aac' }))

// Pass null for a recording with a single audio track (undefined would pick the default five).
function setup(streams: AudioStreamInfo[] | null = STREAMS) {
  const p = createEmptyProject('Multi')
  const asset: Asset = {
    id: 'asset_rec',
    name: 'Session',
    kind: 'video',
    duration: 10,
    hasAudio: true,
    ...(streams ? { audioTracks: streams } : {}),
    source: { type: 'file', url: 'lumen-media://file/session.mkv', mime: 'video/x-matroska', fileName: 'session.mkv', size: 1 },
    addedAt: 0,
  }
  p.assets[asset.id] = asset
  const main = p.tracks.find((t) => t.role === 'main')!
  const clip = createClip({ kind: 'video', trackId: main.id, start: 0, duration: 300, assetId: asset.id, name: 'Session' })
  p.clips[clip.id] = clip
  return { p, clip, asset }
}

const audioTracks = (p: Project) => p.tracks.filter((t) => t.kind === 'audio')
const onTrack = (p: Project, name: string) => clipsOnTrack(p, p.tracks.find((t) => t.name === name)!.id)

describe('streamInfo', () => {
  it('lists the streams only when there is a choice to make', () => {
    const t = (name: string | null) => ({ name, numberOfChannels: 2, codec: 'aac' as const })
    expect(streamInfo([])).toBeUndefined()
    expect(streamInfo([t('Mic')])).toBeUndefined()
    expect(streamInfo([t('Mic'), t('  '), t(null)])).toEqual([
      { index: 0, name: 'Mic', channels: 2, codec: 'aac' },
      { index: 1, name: null, channels: 2, codec: 'aac' },
      { index: 2, name: null, channels: 2, codec: 'aac' },
    ])
  })
})

describe('splitAudioTracks', () => {
  it('puts each chosen stream on its own audio track, linked to the picture, which goes silent', () => {
    const { p, clip } = setup()
    const made = splitAudioTracks(p, clip, [0, 1, 2, 3])
    expect(made).toHaveLength(4)
    // Own track per stream, so any one can be muted or cut alone.
    expect(new Set(made.map((c) => c.trackId)).size).toBe(4)
    for (const name of ['Mic', 'Game', 'Comms', 'App']) expect(onTrack(p, name)).toHaveLength(1)
    // Same place, length and source offset as the picture.
    for (const c of made) expect([c.start, clipEnd(c), c.inPoint, c.kind]).toEqual([0, 300, 0, 'audio'])
    // Each plays its own stream of the same file.
    const played = made.map((c) => p.assets[c.assetId!].source)
    expect(played.map((s) => (s.type === 'file' ? s.audioTrack : -1))).toEqual([0, 1, 2, 3])
    expect(played.every((s) => s.type === 'file' && s.url === 'lumen-media://file/session.mkv')).toBe(true)
    // Linked, and the picture no longer plays its own sound (the mixed backup, stream 5, isn't added).
    expect(new Set([clip.groupId, ...made.map((c) => c.groupId)]).size).toBe(1)
    expect(clip.groupId).toBeTruthy()
    expect(clip.audio.detached).toBe(true)
  })

  it('names tracks from the recording, falls back to "Audio N", and takes custom names', () => {
    const { p, clip } = setup()
    splitAudioTracks(p, clip, [0, 4], { 0: 'Voice Jimmy' })
    expect(audioTracks(p).map((t) => t.name)).toContain('Voice Jimmy')
    expect(audioTracks(p).map((t) => t.name)).toContain('Audio 5')
    expect(audioTracks(p).map((t) => t.name)).not.toContain('Mic')
  })

  it('keeps what is already placed, adds the new, and removes the unchecked', () => {
    const { p, clip } = setup()
    const [mic, game] = splitAudioTracks(p, clip, [0, 1])
    mic.audio.volume = -6 // an edit that must survive
    const added = splitAudioTracks(p, clip, [0, 2])
    expect(added).toHaveLength(1) // only Comms is new
    expect(p.clips[mic.id].audio.volume).toBe(-6)
    expect(p.clips[game.id]).toBeUndefined() // Game was unchecked
    expect([...splitAudioClips(p, clip).keys()].sort()).toEqual([0, 2])
    // Doing it again with the same choice adds nothing.
    expect(splitAudioTracks(p, clip, [0, 2])).toHaveLength(0)
    expect(Object.values(p.assets).filter((a) => a.kind === 'audio')).toHaveLength(3) // streams 0, 1, 2 — made once each
  })

  it('choosing none puts the sound back in the video', () => {
    const { p, clip } = setup()
    splitAudioTracks(p, clip, [0, 1])
    splitAudioTracks(p, clip, [])
    expect(splitAudioClips(p, clip).size).toBe(0)
    expect(clip.audio.detached).toBeUndefined()
    expect(Object.values(p.clips).filter((c) => c.kind === 'audio')).toHaveLength(0)
  })

  it('muting one stream leaves the others and the picture alone (the cough)', () => {
    const { p, clip } = setup()
    const [mic, game] = splitAudioTracks(p, clip, [0, 1])
    p.tracks.find((t) => t.id === mic.trackId)!.muted = true
    expect(p.tracks.find((t) => t.id === game.trackId)!.muted).toBeFalsy()
    expect(p.clips[clip.id].audio.volume).toBe(clip.audio.volume)
  })

  it('splits each place a video is used separately and reuses tracks of the same name', () => {
    const { p, clip } = setup()
    splitAudioTracks(p, clip, [0, 1])
    const again = createClip({ kind: 'video', trackId: clip.trackId, start: 300, duration: 120, assetId: clip.assetId, name: 'Session 2' })
    p.clips[again.id] = again
    const made = splitAudioTracks(p, again, [0, 1])
    expect(made).toHaveLength(2)
    // The Mic and Game tracks are free after the first clip, so they're reused rather than duplicated.
    expect(audioTracks(p).filter((t) => t.name === 'Mic')).toHaveLength(1)
    expect(onTrack(p, 'Mic').map((c) => c.start)).toEqual([0, 300])
  })

  it('refuses a recording with only one audio track, a non-video clip, or an unknown stream', () => {
    const single = setup(null)
    expect(() => splitAudioTracks(single.p, single.clip, [0])).toThrow(/several audio tracks/)
    const { p, clip } = setup()
    expect(() => splitAudioTracks(p, clip, [9])).toThrow(/no audio track 10/)
    const sound: Clip = createClip({ kind: 'audio', trackId: audioTracks(p)[0].id, start: 0, duration: 30, assetId: clip.assetId })
    p.clips[sound.id] = sound
    expect(() => splitAudioTracks(p, sound, [0])).toThrow(/isn’t a video clip/)
  })

  it('reattaching the sound removes the split clips too', () => {
    const { p, clip } = setup()
    splitAudioTracks(p, clip, [0, 1, 2])
    reattachAudio(p, clip)
    expect(Object.values(p.clips).filter((c) => c.kind === 'audio')).toHaveLength(0)
    expect(clip.audio.detached).toBeUndefined()
    // The ordinary single-stream detach still works afterwards.
    expect(detachAudio(p, clip).kind).toBe('audio')
  })
})
