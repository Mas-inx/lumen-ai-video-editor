import { describe, expect, it } from 'vitest'
import { clipCues, cueText, cueTone, MAX_CUES, parseCues } from './cues'
import type { Asset, Clip } from './types'

// A cue sheet as GS Cinematic Studio sends it (shared/beats.lua): seconds from the clip's first frame.
const SHEET = [
  { at: 1.5, frame: 485, kind: 'speech', actor: 'a1', speaker: 'Boss', text: 'You are late.', seconds: 1.5, voice: 'male_deep' },
  { at: 0, frame: 440, kind: 'cut', shot: 'Arrival', path: 'p1', seconds: 3.333 },
  { at: 0.2, frame: 446, kind: 'walk', actor: 'a1', speaker: 'Boss', style: 'confident', seconds: 0.6 },
  { at: 2.8, frame: 524, kind: 'sfx', label: 'Door', sound: 'door_slam', set: 'doors' },
  { at: 3, frame: 530, kind: 'fx', effect: 'core/exp_grd_bzgas_smoke' },
  { at: 3.1, frame: 533, kind: 'crowd', react: 'cheer', people: 12 },
  { at: 3.2, frame: 536, kind: 'ragdoll', actor: 'a2', speaker: 'Guard' },
]

describe('cue sheets', () => {
  it('are read in time order, with every cue named', () => {
    const cues = parseCues(SHEET, 3.333)
    expect(cues.map((c) => c.at)).toEqual([0, 0.2, 1.5, 2.8, 3, 3.1, 3.2])
    expect(cues[2]).toEqual({ at: 1.5, kind: 'speech', label: 'You are late.', seconds: 1.5, who: 'Boss', data: { frame: 485, actor: 'a1', voice: 'male_deep' } })
    expect(cues.map(cueText)).toEqual(['Cut: Arrival', 'Boss walks (confident)', 'Boss: You are late.', 'Sfx: Door', 'Fx: core/exp_grd_bzgas_smoke', 'Crowd: cheer', 'Ragdoll: Guard'])
    expect(cues.map((c) => cueTone(c.kind))).toEqual(['cut', 'sound', 'speech', 'sound', 'sound', 'action', 'action'])
    // What names the cue isn't repeated in its data; the rest is kept.
    expect(cues[3].data).toEqual({ frame: 524, sound: 'door_slam', set: 'doors' })
  })

  it('skip what is not a cue, and what falls outside the clip', () => {
    expect(parseCues(undefined)).toEqual([])
    expect(parseCues({ cues: [] })).toEqual([])
    expect(parseCues([null, 'x', { kind: 'speech' }, { at: 'soon', kind: 'cut' }, { at: -1, kind: 'cut' }, { at: 9, kind: 'cut' }, { at: 1 }], 3)).toEqual([{ at: 1, kind: 'cue', label: 'cue' }])
    expect(parseCues(Array.from({ length: MAX_CUES + 50 }, (_, i) => ({ at: i / 100, kind: 'marker', label: `m${i}` })))).toHaveLength(MAX_CUES)
  })

  it('fall inside a clip where its trim and speed put them', () => {
    const asset = { id: 'a', cues: parseCues(SHEET) } as Asset
    const clip = (patch: Partial<Clip>) => ({ id: 'c', assetId: 'a', start: 100, duration: 100, inPoint: 0, speed: 1, keyframes: {}, ...patch }) as Clip
    const frames = (c: Clip) => clipCues(c, asset, 30).map((x) => `${x.frame}:${x.cue.kind}`)
    expect(frames(clip({}))).toEqual(['0:cut', '6:walk', '45:speech', '84:sfx', '90:fx', '93:crowd', '96:ragdoll'])
    // Trimmed to start one second in: the cut and the walk are gone, the rest moved up.
    expect(frames(clip({ inPoint: 30, duration: 60 }))).toEqual(['15:speech', '54:sfx'])
    // At double speed everything comes twice as soon.
    expect(frames(clip({ speed: 2, duration: 50 }))).toEqual(['0:cut', '3:walk', '23:speech', '42:sfx', '45:fx', '47:crowd', '48:ragdoll'])
    expect(frames(clip({ freeze: true }))).toEqual([])
    expect(clipCues(clip({}), { id: 'b' } as Asset, 30)).toEqual([])
  })
})
