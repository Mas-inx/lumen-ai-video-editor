import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Asset, Clip, ClipKind, Project } from './types'

// Speech activity per asset, standing in for decoding and measuring real audio.
const activity = new Map<string, [number, number][]>()

vi.mock('@/engine/audio-engine', () => ({
  isAudible: (project: Project, clip: Clip) =>
    (clip.kind === 'audio' || clip.kind === 'video') && Boolean(clip.assetId) && !project.tracks.find((t) => t.id === clip.trackId)?.muted,
  loadAudio: async (asset: Asset) => ({ assetId: asset.id }),
  activeRegions: (buffer: { assetId: string }) => activity.get(buffer.assetId) ?? [],
  // Long recordings stream; these tests use short ones.
  isLongAudio: () => false,
  activeRegionsStreamed: async (asset: Asset) => activity.get(asset.id) ?? [],
}))

const { addCaptions, duckMusic, findPauses, removePauses, silentCuts, timelineTranscript } = await import('./smart')
const { useEditor, getProject } = await import('./store')
const { createClip, createTrack } = await import('./defaults')
const { createEmptyProject } = await import('./new-project')
const { clipEnd, clipsOnTrack } = await import('./ops')

let n = 0
function asset(duration: number, speech: [number, number][], extra: Partial<Asset> = {}): Asset {
  const id = `asset_${++n}`
  activity.set(id, speech)
  return {
    id,
    name: id,
    kind: 'audio',
    duration,
    hasAudio: true,
    source: { type: 'file', url: `lumen-media://file/${id}.wav`, mime: 'audio/wav', fileName: `${id}.wav`, size: 1 },
    addedAt: 0,
    ...extra,
  }
}

function setup() {
  const p = createEmptyProject('Smart')
  const track = (name: string) => p.tracks.find((t) => t.name === name)!.id
  const add = (trackName: string, kind: ClipKind, start: number, duration: number, extra: Partial<Clip> = {}) => {
    const c = createClip({ kind, trackId: track(trackName), start, duration, ...extra })
    p.clips[c.id] = c
    return c
  }
  const withAsset = (a: Asset) => {
    p.assets[a.id] = a
    return a.id
  }
  const load = () => useEditor.getState().loadProject(p)
  const on = (trackName: string) => clipsOnTrack(getProject(), track(trackName)).map((c) => [c.start, clipEnd(c)])
  return { p, track, add, withAsset, load, on }
}

beforeEach(() => activity.clear())

describe('findPauses', () => {
  it('finds long silences between phrases, keeping a breath either side', async () => {
    const { p, add, withAsset } = setup()
    const voice = add('Voice', 'audio', 0, 210, { assetId: withAsset(asset(7, [[0, 2], [3.5, 5], [5.3, 7]])) })
    const reports = await findPauses(p)
    expect(reports).toHaveLength(1)
    expect(reports[0].clip.id).toBe(voice.id)
    // 2.12s → 3.38s at 30 fps; the 0.3s gap is too short to cut.
    expect(reports[0].cuts).toEqual([[64, 101]])
    expect(reports[0].from).toBe('audio')
  })

  it('follows the clip on the timeline (offset, trimmed source, speed)', async () => {
    const { p, add, withAsset } = setup()
    add('Voice', 'audio', 30, 60, { inPoint: 30, speed: 2, assetId: withAsset(asset(10, [[0, 2], [3.5, 5]])) })
    const [r] = await findPauses(p)
    // Source 2.12s → timeline 30 + (2.12 - 1) * 30 / 2 = 46.8
    expect(r.cuts).toEqual([[47, 66]])
  })

  it('falls back to transcript timings when the audio can’t be measured', async () => {
    const { p, add, withAsset } = setup()
    const a = asset(7, [], { transcript: [{ start: 0, end: 2, text: 'Hello there.' }, { start: 4, end: 6, text: 'Welcome back.' }] })
    p.tracks.find((t) => t.name === 'Voice')!.muted = true
    add('Voice', 'audio', 0, 210, { assetId: withAsset(a) })
    const [r] = await findPauses(p)
    expect(r.from).toBe('transcript')
    expect(r.cuts).toEqual([[64, 116]])
  })
})

describe('silentCuts', () => {
  it('never cuts across another speaker’s line', async () => {
    const { p, add, withAsset } = setup()
    p.tracks.push(createTrack('audio', { name: 'Interview B' }))
    add('Voice', 'audio', 0, 210, { assetId: withAsset(asset(7, [[0, 2], [3.5, 7]])) })
    add('Interview B', 'audio', 0, 210, { assetId: withAsset(asset(7, [[2.3, 3.0]])) })
    expect(await silentCuts(p, await findPauses(p))).toEqual([])
  })

  it('keeps the part of a pause where everyone is quiet', async () => {
    const { p, add, withAsset } = setup()
    p.tracks.push(createTrack('audio', { name: 'Interview B' }))
    const a = add('Voice', 'audio', 0, 210, { assetId: withAsset(asset(7, [[0, 2], [3.5, 7]])) })
    add('Interview B', 'audio', 0, 210, { assetId: withAsset(asset(7, [[1.9, 2.2]])) })
    expect(await silentCuts(p, await findPauses(p, { clipIds: [a.id] }))).toEqual([[70, 101]])
  })
})

describe('removePauses', () => {
  it('closes up the whole timeline: captions and effects follow, music plays through', async () => {
    const { add, withAsset, load, on } = setup()
    add('Voice', 'audio', 0, 210, { assetId: withAsset(asset(7, [[0, 2], [3.5, 5], [5.3, 7]])) })
    add('Titles', 'text', 0, 60, { name: 'one' })
    add('Titles', 'text', 105, 45, { name: 'two' })
    const music = add('Music', 'audio', 0, 300, { assetId: withAsset(asset(60, [[0, 60]])) })
    const whoosh = add('Sound effects', 'audio', 80, 10, { assetId: withAsset(asset(1, [[0, 1]])) })
    load()

    const r = await removePauses()
    expect(r.removed).toBe(1)
    expect(r.seconds).toBeCloseTo(37 / 30)
    expect(on('Voice')).toEqual([[0, 64], [64, 173]])
    expect(on('Titles')).toEqual([[0, 60], [68, 113]])
    expect(getProject().clips[music.id]).toMatchObject({ start: 0, duration: 263 })
    expect(getProject().clips[whoosh.id]).toMatchObject({ start: 64, duration: 10 })
    expect(r.clips).toHaveLength(2)

    // One undo step puts everything back.
    useEditor.getState().undo()
    expect(on('Voice')).toEqual([[0, 210]])
    expect(on('Titles')).toEqual([[0, 60], [105, 150]])
    expect(getProject().clips[music.id].duration).toBe(300)
  })

  it('does nothing when there are no pauses', async () => {
    const { add, withAsset, load } = setup()
    add('Voice', 'audio', 0, 90, { assetId: withAsset(asset(3, [[0, 3]])) })
    load()
    const before = useEditor.getState().past.length
    expect(await removePauses()).toMatchObject({ removed: 0, seconds: 0 })
    expect(useEditor.getState().past.length).toBe(before)
  })
})

describe('timelineTranscript', () => {
  it('places each line where it plays on the timeline, and marks lines a cut runs through', async () => {
    const { add, withAsset, load } = setup()
    const a = asset(8, [], {
      transcript: [
        { start: 0.5, end: 2, text: 'First line' },
        { start: 3, end: 5, text: 'Second line' },
        { start: 6, end: 7.5, text: 'Third line' },
      ],
    })
    const id = withAsset(a)
    // The clip starts at 10 s on the timeline and plays 2.5 s → 7 s of the recording.
    add('Voice', 'audio', 300, 135, { assetId: id, inPoint: 75 })
    load()
    const lines = timelineTranscript(getProject())
    expect(lines.map((l) => l.text)).toEqual(['Second line', 'Third line'])
    expect(lines[0]).toMatchObject({ start: 10.5, end: 12.5 })
    expect(lines[0].partial).toBeUndefined()
    expect(lines[1]).toMatchObject({ start: 13.5, end: 14.5, partial: true })
    expect(timelineTranscript(getProject(), 13)).toHaveLength(1)
  })
})

describe('addCaptions', () => {
  it('lays timed captions from the transcript on a Captions track', () => {
    const { add, withAsset, load } = setup()
    const a = asset(8, [], {
      transcript: [
        { start: 0, end: 2, text: 'Welcome to the show' },
        { start: 3, end: 7, text: 'Today we build a video editor from scratch together' },
      ],
    })
    add('Voice', 'audio', 30, 240, { assetId: withAsset(a) })
    load()
    const r = addCaptions({ maxWords: 5 })
    const track = getProject().tracks.find((t) => t.role === 'captions')!
    expect(r).toMatchObject({ added: 3, trackId: track.id })
    const caps = clipsOnTrack(getProject(), track.id)
    expect(caps.map((c) => c.text!.content)).toEqual(['Welcome to the show', 'Today we build a video', 'editor from scratch together'])
    expect(caps[0].start).toBe(30)
    expect(caps[1].start).toBe(120)
    expect(clipEnd(caps[2])).toBe(240)
    // Running it again replaces the captions instead of stacking them.
    addCaptions({ maxWords: 5 })
    expect(clipsOnTrack(getProject(), track.id)).toHaveLength(3)
    expect(getProject().tracks.filter((t) => t.role === 'captions')).toHaveLength(1)
  })

  it('styles captions: a few big words at a time, or one word at a time with key words in colour', () => {
    const { add, withAsset, load } = setup()
    const a = asset(4, [], { transcript: [{ start: 0, end: 3, text: 'We built it in 30 days!' }] })
    add('Voice', 'audio', 0, 120, { assetId: withAsset(a) })
    load()
    const captions = () => clipsOnTrack(getProject(), getProject().tracks.find((t) => t.role === 'captions')!.id)

    addCaptions({ style: 'bold' })
    expect(captions().map((c) => c.text!.content)).toEqual(['We built it', 'in 30 days!'])
    expect(captions()[0].text).toMatchObject({ uppercase: true, background: null, outline: { color: '#000000' } })
    expect(captions()[0].animation?.in.preset).toBe('pop')

    addCaptions({ style: 'word', accent: '#ff0055' })
    expect(captions().map((c) => c.text!.content)).toEqual(['We', 'built', 'it', 'in', '30', 'days!'])
    expect(captions().map((c) => c.text!.color === '#ff0055')).toEqual([false, false, false, false, true, true])
    const { width, height } = getProject().settings
    expect(captions()[1].text!.size).toBe(Math.round(Math.min(width, height) * 0.095))

    // The default stays classic subtitles.
    addCaptions()
    expect(captions()).toHaveLength(1)
    expect(captions()[0].text).toMatchObject({ uppercase: false, background: 'rgba(0,0,0,0.55)' })
    expect(captions()[0].animation?.in.preset).toBe('fade')
  })

  it('captions what’s heard, once: silent copies and doubled speech are left out', () => {
    const { add, withAsset, load } = setup()
    const id = withAsset(
      asset(8, [], {
        kind: 'video',
        transcript: [
          { start: 0, end: 2, text: 'Hello there everyone' },
          { start: 3, end: 5, text: 'Welcome back to the channel' },
        ],
      }),
    )
    add('Main', 'video', 0, 240, { assetId: id })
    // The same interview as B-roll on top, still audible: it would say the first line twice.
    add('Overlay', 'video', 0, 90, { assetId: id })
    // A cut-out copy turned all the way down.
    add('Overlay', 'video', 120, 60, { assetId: id }).audio.volume = -60
    load()
    addCaptions({ maxWords: 8 })
    const caps = clipsOnTrack(getProject(), getProject().tracks.find((t) => t.role === 'captions')!.id)
    expect(caps.map((c) => [c.text!.content, c.start])).toEqual([
      ['Hello there everyone', 0],
      ['Welcome back to the channel', 90],
    ])
  })
})

describe('duckMusic', () => {
  it('dips the music under speech with volume keyframes', async () => {
    const { add, withAsset, load } = setup()
    add('Voice', 'audio', 0, 300, { assetId: withAsset(asset(10, [[1, 3], [6, 8]])) })
    const music = add('Music', 'audio', 0, 300, { assetId: withAsset(asset(60, [[0, 60]])) })
    load()
    const r = await duckMusic({ depth: 10 })
    expect(r).toMatchObject({ ducked: 1, regions: 2 })
    const { propAt } = await import('./keyframes')
    const m = getProject().clips[music.id]
    expect(propAt(m, 'volume', 60)).toBeCloseTo(-10) // under speech (2s)
    expect(propAt(m, 'volume', 150)).toBeCloseTo(0) // the gap between phrases (5s)
    expect(propAt(m, 'volume', 210)).toBeCloseTo(-10) // under speech (7s)
    expect(propAt(m, 'volume', 290)).toBeCloseTo(0) // after the speech
  })
})
