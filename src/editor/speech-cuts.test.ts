import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Asset, ClipKind, SpeechSegment } from './types'

// Each recording's sound: where it's loud, in source seconds. Decoded as a
// quiet-or-loud signal so the real level and speech detectors read it.
const sound = new Map<string, [number, number][]>()
const RATE = 8000
function decoded(asset: Asset) {
  const data = new Float32Array(Math.ceil((asset.duration ?? 1) * RATE))
  for (const [a, b] of sound.get(asset.id) ?? []) for (let i = Math.floor(a * RATE); i < Math.min(data.length, Math.ceil(b * RATE)); i++) data[i] = 0.3 * Math.sin(i * 0.9)
  return { sampleRate: RATE, length: data.length, duration: asset.duration ?? 1, numberOfChannels: 1, getChannelData: () => data } as unknown as AudioBuffer
}
vi.mock('@/engine/audio-engine', async (original) => ({
  ...(await original<typeof import('@/engine/audio-engine')>()),
  loadAudio: async (asset: Asset) => decoded(asset),
}))

const { planSpeechCuts, removeSpeech, takesToRemove } = await import('./speech-cuts')
const { findRetakes, spokenSentences } = await import('./retakes')
const { removePauses } = await import('./smart')
const { useEditor, getProject } = await import('./store')
const { createClip, createTrack } = await import('./defaults')
const { createEmptyProject } = await import('./new-project')
const { clipEnd, clipsOnTrack } = await import('./ops')

/** A phrase whose words the transcriber timed: each word 0.3 s with 0.1 s between. */
function said(start: number, text: string, word = 0.3, gap = 0.1): SpeechSegment {
  let t = start
  const words = text.split(' ').map((w) => {
    const x = { start: t, end: t + word, text: w }
    t += word + gap
    return x
  })
  return { start, end: words[words.length - 1].end, text, words }
}

let n = 0
function setup() {
  const p = createEmptyProject('Cuts')
  const track = (name: string) => p.tracks.find((t) => t.name === name)!.id
  const add = (trackName: string, kind: ClipKind, start: number, duration: number, extra: Record<string, unknown> = {}) => {
    const c = createClip({ kind, trackId: track(trackName), start, duration, ...extra })
    p.clips[c.id] = c
    return c
  }
  /** A recording on a track, heard where its words are (unless `loud` says otherwise). */
  const voice = (trackName: string, transcript: SpeechSegment[] | null, opts: { at?: number; duration?: number; loud?: [number, number][] } = {}) => {
    const id = `asset_c${++n}`
    const duration = opts.duration ?? Math.max(...(transcript ?? [{ end: 5 }]).map((s) => s.end)) + 1
    const asset: Asset = {
      id,
      name: `${trackName} recording`,
      kind: 'audio',
      duration,
      hasAudio: true,
      source: { type: 'file', url: `lumen-media://file/${id}.wav`, mime: 'audio/wav', fileName: `${id}.wav`, size: 1 },
      ...(transcript ? { transcript } : {}),
      addedAt: 0,
    }
    p.assets[id] = asset
    sound.set(id, opts.loud ?? (transcript ?? []).flatMap((s) => (s.words ?? [s]).map((w) => [w.start, w.end] as [number, number])))
    return add(trackName, 'audio', Math.round((opts.at ?? 0) * 30), Math.round(duration * 30), { assetId: id, name: `${trackName} recording` })
  }
  const load = () => useEditor.getState().loadProject(p)
  const on = (trackName: string) => clipsOnTrack(getProject(), track(trackName)).map((c) => [c.start, clipEnd(c)])
  return { p, track, add, voice, load, on }
}

const sentenceIds = () => spokenSentences(getProject()).map((s) => s.id)
const idOf = (text: string) => spokenSentences(getProject()).find((s) => s.text === text)!.id

beforeEach(() => sound.clear())

describe('placing a speech cut', () => {
  it('takes a whole take from just before it to a breath before what follows, keeping the pause before it', async () => {
    const { voice, load } = setup()
    voice('Voice', [said(0, 'Hello everyone.'), said(1.5, 'Click the big button at the top.'), said(5, 'Click the big button at the top.')])
    load()
    const [, take1] = sentenceIds()
    const { cuts, refused } = await planSpeechCuts(getProject(), { sentences: [take1] })
    expect(refused).toEqual([])
    // 1.46 s → 44 (a breath after “everyone.” ends at 0.7); 4.9 s → 147 (a breath before take 2 at 5.0).
    expect(cuts).toEqual([{ from: 44, to: 147, text: 'Click the big button at the top.', lane: expect.any(String), notes: [] }])
  })

  it('never splits a word: a range through a word takes it whole or leaves it whole, and says so', async () => {
    const { voice, load } = setup()
    // Click 1.5–1.8 · the 1.9–2.2 · big 2.3–2.6 · button 2.7–3.0 · at 3.1–3.4 …
    voice('Voice', [said(0, 'Hello everyone.'), said(1.5, 'Click the big button at the top.')])
    load()
    const most = await planSpeechCuts(getProject(), { ranges: [[2.35, 3.05]] })
    expect(most.cuts[0]).toMatchObject({ from: 69, to: 91, text: 'big button' })
    expect(most.cuts[0].notes).toEqual(['Took all of “big” at 0:02.3: the range went through it.'])
    const little = await planSpeechCuts(getProject(), { ranges: [[2.5, 3.05]] })
    expect(little.cuts[0]).toMatchObject({ from: 80, to: 91, text: 'button' })
    expect(little.cuts[0].notes).toEqual(['Kept “big” at 0:02.3 whole: the range only clipped it.'])
    // Every edge sits between words.
    for (const c of [...most.cuts, ...little.cuts]) {
      for (const f of [c.from, c.to]) {
        const t = f / 30
        expect(spokenSentences(getProject()).flatMap((s) => s.words).some((w) => t > w.start + 0.001 && t < w.end - 0.001)).toBe(false)
      }
    }
  })

  it('a range between words keeps a breath from them; one inside a word is refused', async () => {
    const { voice, load } = setup()
    voice('Voice', [said(0, 'One two.'), said(2, 'Three four.')])
    load()
    const pause = await planSpeechCuts(getProject(), { ranges: [[0.7, 2]] })
    // “two.” ends at 0.7 and “Three” starts at 2.0: 0.8 s → 1.9 s.
    expect(pause.cuts).toEqual([{ from: 24, to: 57, text: '', notes: [] }])
    const inside = await planSpeechCuts(getProject(), { ranges: [[0.45, 0.55]] })
    expect(inside.cuts).toEqual([])
    expect(inside.refused[0].reason).toMatch(/inside the word “two\.”/)
  })

  it('stops a breath before another voice’s reply, and refuses to cut through someone talking over the take', async () => {
    const { p, voice, load } = setup()
    p.tracks.push(createTrack('audio', { name: 'Interview B' }))
    voice('Voice', [said(0, 'So what did you build?'), said(3, 'So what did you build there?')])
    // B answers at 2.2 s, before the question is asked again — and says “Mm” over the second take.
    voice('Interview B', [said(2.2, 'A desk.'), said(3.9, 'Mm.')])
    load()
    const [first, second] = [idOf('So what did you build?'), idOf('So what did you build there?')]
    const r = await planSpeechCuts(getProject(), { sentences: [first] })
    // From the start to a breath before “A” (2.1 s), not on to the voice's own next word at 3.0 s.
    expect(r.cuts).toEqual([{ from: 0, to: 63, text: 'So what did you build?', lane: expect.any(String), notes: [] }])
    const over = await planSpeechCuts(getProject(), { sentences: [second] })
    expect(over.cuts).toEqual([])
    expect(over.refused[0]).toMatchObject({ what: '“So what did you build there?”' })
    expect(over.refused[0].reason).toMatch(/another voice speaks there \(“Mm\.” at 0:03\.9\) — cutting it would take their words too/)
    // Two voices inside one range can't be cut apart.
    const both = await planSpeechCuts(getProject(), { ranges: [[1.5, 2.6]] })
    expect(both.cuts).toEqual([])
    expect(both.refused[0].reason).toMatch(/two voices speak in it \(“build\?” and “A”\)/)
  })

  it('treats a voice with no transcript the same way, from its sound', async () => {
    const { p, voice, load } = setup()
    p.tracks.push(createTrack('audio', { name: 'Dialog C' }))
    voice('Voice', [said(0, 'So what did you build?'), said(3, 'So what did you build there?')])
    voice('Dialog C', null, { duration: 6, loud: [[2.2, 2.6], [4, 4.4]] })
    load()
    const [first, second] = [idOf('So what did you build?'), idOf('So what did you build there?')]
    expect((await planSpeechCuts(getProject(), { sentences: [first] })).cuts).toEqual([{ from: 0, to: 63, text: 'So what did you build?', lane: expect.any(String), notes: [] }])
    const over = await planSpeechCuts(getProject(), { sentences: [second] })
    expect(over.refused[0].reason).toMatch(/“Dialog C recording” has speech there that isn’t transcribed/)
  })

  it('follows the sound where words only have their phrase’s timing', async () => {
    const { voice, load } = setup()
    // One phrase, two sentences: the transcript can only guess where the second starts (3.0 s). The sound pauses 2.6–3.2 s.
    voice('Voice', [{ start: 0, end: 6, text: 'Click the big button at the top. Click the big button at the top.' }], { loud: [[0, 2.6], [3.2, 6]] })
    load()
    const [first] = sentenceIds()
    const { cuts } = await planSpeechCuts(getProject(), { sentences: [first] })
    // Ends a breath before the second take begins in the sound (3.1 s), not at the guess.
    expect(cuts[0].to).toBe(93)
    expect(cuts[0].notes).toContain('Word timings are estimated here — check the cut by ear.')
  })
})

describe('removeSpeech', () => {
  it('cuts takes as one undo step that ripples like removing pauses: titles, markers and B-roll follow, music plays on', async () => {
    const { p, add, voice, load, on } = setup()
    voice('Voice', [said(0, 'Hello everyone.'), said(1.5, 'Click the big button at the top.'), said(5, 'Click the big button at the top.')])
    const title = add('Titles', 'text', 180, 60, { name: 'Lower third' })
    add('Overlay', 'image', 120, 60, { name: 'Screenshot' })
    const musicId = 'asset_music'
    p.assets[musicId] = { id: musicId, name: 'Bed', kind: 'audio', duration: 60, hasAudio: true, source: { type: 'file', url: 'lumen-media://file/bed.wav', mime: 'audio/wav', fileName: 'bed.wav', size: 1 }, addedAt: 0 }
    const music = add('Music', 'audio', 0, 300, { assetId: musicId })
    p.markers.push({ id: 'm1', frame: 200, label: 'Point', color: 'lime' })
    load()
    const before = useEditor.getState().past.length

    const groups = findRetakes(spokenSentences(getProject()))
    expect(groups).toHaveLength(1)
    const r = await removeSpeech(takesToRemove(groups, { [groups[0].id]: groups[0].keep }), { label: 'Cut repeated takes', source: 'user' })
    expect(r.refused).toEqual([])
    expect(r.cuts).toHaveLength(1)
    expect(r.cuts[0]).toMatchObject({ from: 44, to: 147, join: 44, next: { text: 'Click the big button at the top.' } })
    expect(r.cuts[0].next!.start).toBeCloseTo(5 - 103 / 30, 3)
    expect(r.seconds).toBeCloseTo(103 / 30)
    expect(r.remaining).toEqual([])

    const after = getProject()
    expect(after.clips[title.id].start).toBe(180 - 103)
    // The B-roll across the cut loses the part inside it and closes up with the speech.
    expect(on('Overlay')).toEqual([[44, 44 + 180 - 147]])
    expect(after.markers[0].frame).toBe(200 - 103)
    expect(after.clips[music.id]).toMatchObject({ start: 0, duration: 300 - 103 })
    // The recording is 8.7 s long (261 frames).
    expect(on('Voice')).toEqual([[0, 44], [44, 261 - 103]])
    expect(useEditor.getState().past).toHaveLength(before + 1)
    expect(useEditor.getState().past.at(-1)).toMatchObject({ label: 'Cut repeated takes', source: 'user' })

    useEditor.getState().undo()
    expect(getProject().clips[title.id].start).toBe(180)
    expect(on('Voice')).toEqual([[0, 261]])
  })

  it('cuts a stumble inside a sentence between its words', async () => {
    const { voice, load } = setup()
    voice('Voice', [said(0, 'I think we can, we can do this.')])
    load()
    const [g] = findRetakes(spokenSentences(getProject()))
    const r = await removeSpeech(takesToRemove([g], { [g.id]: 1 }))
    // “we can,” goes: from 0.767 s (between “think” and “we”) to 1.533 s (between “can,” and “we”).
    expect(r.cuts[0]).toMatchObject({ from: 23, to: 46, text: 'we can,' })
    expect(spokenSentences(getProject()).map((s) => s.text)).toEqual(['I think we can do this.'])
    expect(r.remaining).toEqual([])
  })

  it('says what repetition is left around the cuts', async () => {
    const { voice, load } = setup()
    voice('Voice', [said(0, 'Open the menu.'), said(2, 'Open the menu.'), said(4, 'Open the menu.'), said(6, 'Then pick a colour.')])
    load()
    const ids = sentenceIds()
    const r = await removeSpeech({ sentences: [ids[0]] })
    expect(r.cuts).toHaveLength(1)
    expect(r.remaining).toHaveLength(1)
    expect(r.remaining[0].takes.map((t) => t.text)).toEqual(['Open the menu.', 'Open the menu.'])
  })

  it('reports ids that are gone and changes nothing', async () => {
    const { voice, load } = setup()
    voice('Voice', [said(0, 'Hello there.')])
    load()
    const steps = useEditor.getState().past.length
    const r = await removeSpeech({ sentences: ['zzzz@999'] })
    expect(r.cuts).toEqual([])
    expect(r.refused[0].reason).toMatch(/isn’t on the timeline any more/)
    expect(useEditor.getState().past).toHaveLength(steps)
  })
})

describe('removing pauses keeps every word whole', () => {
  it('leaves a quiet word the transcript has inside a measured pause', async () => {
    const { voice, load, on } = setup()
    // The sound misses “and” (2.6–2.8 s), which the transcriber heard.
    const transcript = [said(0, 'We drove north'), { start: 2.6, end: 2.8, text: 'and', words: [{ start: 2.6, end: 2.8, text: 'and' }] }, said(3.5, 'then we camped.')]
    voice('Voice', transcript, { duration: 6, loud: [[0, 2], [3.5, 5]] })
    load()
    const r = await removePauses()
    expect(r.notes).toEqual(['Kept “and” at 0:02.6: the transcript has that word inside the pause.'])
    // The pause before “and” is too short to cut once a breath is kept; the one after it goes.
    expect(r.removed).toBe(1)
    expect(on('Voice')).toEqual([[0, 88], [88, 180 - 13]])
  })
})
