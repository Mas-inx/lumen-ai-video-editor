import { describe, expect, it, vi } from 'vitest'
import type { Asset, Clip, Project, SpeechSegment } from './types'

// Speech is read from transcripts here; nothing is decoded.
vi.mock('@/engine/audio-engine', () => ({
  isAudible: (project: Project, clip: Clip) => (clip.kind === 'audio' || clip.kind === 'video') && Boolean(clip.assetId) && !project.tracks.find((t) => t.id === clip.trackId)?.muted,
  loadAudio: async () => null,
  activeRegions: () => [],
  isLongAudio: () => false,
  activeRegionsStreamed: async () => null,
}))

const { align, findRetakes, sameWord, spokenSentences, startsLike, SURE, wordDistance, wordTokens } = await import('./retakes')
const { defaultChoices, takesToRemove } = await import('./speech-cuts')
const { createClip } = await import('./defaults')
const { createEmptyProject } = await import('./new-project')

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

/** A phrase with only its own timing (Whisper on this computer). */
const phrase = (start: number, end: number, text: string): SpeechSegment => ({ start, end, text })

let n = 0
function voice(transcript: SpeechSegment[], opts: { track?: string; start?: number } = {}) {
  const p = createEmptyProject('Takes')
  return addVoice(p, transcript, opts)
}

function addVoice(p: Project, transcript: SpeechSegment[], opts: { track?: string; start?: number } = {}) {
  const id = `asset_v${++n}`
  const duration = Math.max(...transcript.map((s) => s.end)) + 1
  const asset: Asset = {
    id,
    name: id,
    kind: 'audio',
    duration,
    hasAudio: true,
    source: { type: 'file', url: `lumen-media://file/${id}.wav`, mime: 'audio/wav', fileName: `${id}.wav`, size: 1 },
    transcript,
    addedAt: 0,
  }
  p.assets[id] = asset
  const track = p.tracks.find((t) => t.name === (opts.track ?? 'Voice'))!
  const c = createClip({ kind: 'audio', trackId: track.id, start: Math.round((opts.start ?? 0) * 30), duration: Math.round(duration * 30), assetId: id })
  p.clips[c.id] = c
  return p
}

const groupsOf = (p: Project) => findRetakes(spokenSentences(p))

describe('words as compared', () => {
  it('ignores case and punctuation, spells out contractions and keeps numbers whole', () => {
    expect(wordTokens('We’re')).toEqual(['we', 'are'])
    expect(wordTokens('can’t,')).toEqual(['can', 'not'])
    expect(wordTokens('“Settings.”')).toEqual(['settings'])
    expect(wordTokens('1,000')).toEqual(['1000'])
    expect(wordTokens('follow-up')).toEqual(['follow', 'up'])
    expect(wordTokens('—')).toEqual([])
  })

  it('treats plurals and one-letter slips as the same word, but never numbers', () => {
    expect(sameWord('button', 'buttons')).toBe(true)
    expect(sameWord('colour', 'color')).toBe(true)
    expect(sameWord('thirty', 'thirsty')).toBe(false)
    expect(sameWord('20', '30')).toBe(false)
    expect(sameWord('the', 'thy')).toBe(false)
  })

  it('measures overlap: common subsequence, edit distance, false starts', () => {
    const a = 'click the button at the top'.split(' ')
    const b = 'click the blue button at the top of the page'.split(' ')
    expect(align(a, b).length).toBe(6)
    expect(wordDistance(a, b)).toBe(4)
    expect(startsLike('so the first thing we'.split(' '), 'so the first thing we need to do'.split(' '))).toBe(true)
    expect(startsLike('the first step'.split(' '), 'the second step is easy'.split(' '))).toBe(false)
  })
})

describe('spokenSentences', () => {
  it('splits on punctuation, long pauses and the transcriber’s phrases', () => {
    const p = voice([said(0, 'Hello there. Welcome back'), said(3.5, 'today we build a desk'), said(6, 'okay')])
    const s = spokenSentences(p)
    expect(s.map((x) => x.text)).toEqual(['Hello there.', 'Welcome back', 'today we build a desk', 'okay'])
    expect(s[1].start).toBeCloseTo(0.8)
    expect(s[1].end).toBeCloseTo(1.5)
    // Ids are tied to the media and the second each sentence starts at.
    expect(s[0].id).toMatch(/^[0-9a-z]{4}@0$/)
    expect(s[2].id).toMatch(/@350$/)
    expect(new Set(s.map((x) => x.id)).size).toBe(4)
  })

  it('breaks after a word that is cut off when the voice starts over', () => {
    const s = spokenSentences(voice([said(0, 'So the first thing we— So the first thing we need is a plan.')]))
    expect(s.map((x) => x.text)).toEqual(['So the first thing we—', 'So the first thing we need is a plan.'])
  })

  it('keeps abbreviations and a hesitation inside the sentence', () => {
    const s = spokenSentences(voice([said(0, 'Ask Dr. Smith and then... we go home.')]))
    expect(s).toHaveLength(1)
  })
})

describe('findRetakes', () => {
  it('a sentence said twice word for word: the later take stays, and it’s sure', () => {
    const g = groupsOf(voice([said(0, 'Click the big button at the top.'), said(4, 'Click the big button at the top.')]))
    expect(g).toHaveLength(1)
    expect(g[0]).toMatchObject({ kind: 'repeat', keep: 1 })
    expect(g[0].confidence).toBeGreaterThanOrEqual(SURE)
    expect(g[0].reason).toMatch(/later take is usually the redo/)
  })

  it('a false start: the take that stops part-way goes, the full one stays', () => {
    const g = groupsOf(voice([said(0, 'So the first thing we—'), said(3, 'So the first thing we need to do is open the settings.')]))
    expect(g).toHaveLength(1)
    expect(g[0]).toMatchObject({ kind: 'restart', keep: 1 })
    expect(g[0].confidence).toBeGreaterThanOrEqual(0.85)
    expect(g[0].reason).toMatch(/Take 1 \(“So the first thing we—”\) stops part-way; take 2 says it in full/)
  })

  it('a near repeat with more in it: keeps the take that says everything', () => {
    const g = groupsOf(voice([said(0, 'Click the button at the top.'), said(4, 'Click the blue button at the top of the page.')]))
    expect(g[0]).toMatchObject({ kind: 'similar', keep: 1 })
    expect(g[0].reason).toMatch(/Take 2 says everything take 1 does, and more \(“blue”, “page”\)/)
    expect(g[0].confidence).toBeLessThan(SURE)
  })

  it('never drops the take with information the other lacks — even when it came first', () => {
    const g = groupsOf(voice([said(0, 'We built the whole studio in thirty days with three people.'), said(6, 'We built the studio in thirty days.')]))
    expect(g[0]).toMatchObject({ keep: 0 })
    expect(g[0].reason).toMatch(/Take 1 says everything take 2 does, and more \(“whole”, “three”, “people”\)/)
  })

  it('takes that each say something the other doesn’t aren’t interchangeable: unsure, left to the user', () => {
    const g = groupsOf(voice([said(0, 'We built it in twenty days.'), said(4, 'We built it in thirty days.')]))
    expect(g).toHaveLength(1)
    expect(g[0].confidence).toBeLessThanOrEqual(0.4)
    expect(g[0].reason).toMatch(/take 1 has “twenty” where take 2 has “thirty” — they aren’t interchangeable/)
    expect(defaultChoices(g, SURE)[g[0].id]).toBe('all')
  })

  it('a line said again much later is likely on purpose', () => {
    const p = voice([said(0, 'Subscribe for more videos like this.'), said(5, 'Today we paint the kitchen.'), said(60, 'First the walls get primer.'), said(120, 'Subscribe for more videos like this.')])
    const g = groupsOf(p)
    expect(g).toHaveLength(1)
    expect(g[0]).toMatchObject({ kind: 'repeat' })
    expect(g[0].confidence).toBeLessThan(0.5)
    expect(g[0].reason).toMatch(/likely on purpose/)
  })

  it('short emphatic repeats and rhetorical triples stay', () => {
    const twice = groupsOf(voice([said(0, 'Thank you.'), said(1.2, 'Thank you.')]))
    expect(twice[0].confidence).toBeLessThan(0.5)
    expect(twice[0].reason).toMatch(/emphasis/)
    const thrice = groupsOf(voice([said(0, 'Faster.'), said(0.8, 'Faster.'), said(1.6, 'Faster.')]))
    expect(thrice).toHaveLength(1)
    expect(thrice[0].takes).toHaveLength(3)
    expect(thrice[0].confidence).toBeLessThan(0.3)
  })

  it('compares what one voice says, not two people agreeing', () => {
    const p = voice([said(0, 'We built it in thirty days.')])
    addVoice(p, [said(3, 'We built it in thirty days.')], { track: 'Music' })
    expect(groupsOf(p)).toEqual([])
  })

  it('takes “sorry, let me start again” out with the take it apologises for', () => {
    const g = groupsOf(voice([said(0, 'Click the—'), said(2, 'Sorry, let me start again.'), said(5, 'Click the button at the top.')]))
    expect(g).toHaveLength(1)
    expect(g[0].asides).toHaveLength(1)
    expect(g[0].reason).toMatch(/“Sorry, let me start again\.” goes with it/)
    const out = takesToRemove(g, defaultChoices(g, SURE))
    expect(out.sentences).toHaveLength(2)
  })

  it('a take broken off and started over in other words is a restart, but checked', () => {
    const g = groupsOf(voice([said(0, 'We went with the—'), said(2.5, 'We went for React on the front end.')]))
    expect(g[0]).toMatchObject({ kind: 'restart', keep: 1 })
    expect(g[0].confidence).toBeLessThan(SURE)
    expect(g[0].reason).toMatch(/starts over in other words/)
  })

  it('with only phrase timings, sentences cut inside a phrase are unsure; whole phrases are fine', () => {
    const inside = groupsOf(voice([phrase(0, 6, 'Click the big button at the top. Click the big button at the top.')]))
    expect(inside[0].confidence).toBeLessThanOrEqual(0.6)
    expect(inside[0].reason).toMatch(/estimated/)
    const whole = groupsOf(voice([phrase(0, 2.5, 'Click the big button at the top.'), phrase(3.5, 6, 'Click the big button at the top.')]))
    expect(whole[0].confidence).toBeGreaterThanOrEqual(SURE)
  })
})

describe('words said twice in a row', () => {
  it('finds the stumble and cuts the first run, so the sentence carries on', () => {
    const g = groupsOf(voice([said(0, 'I think we can, we can do this.')]))
    expect(g).toHaveLength(1)
    expect(g[0]).toMatchObject({ kind: 'stumble', keep: 1, stumble: { first: [2, 3], second: [4, 5] } })
    expect(g[0].confidence).toBeGreaterThanOrEqual(SURE)
    expect(g[0].takes.map((t) => t.text)).toEqual(['we can,', 'we can'])
    expect(takesToRemove(g, { [g[0].id]: 1 }).words).toEqual([{ sentence: g[0].takes[0].sentenceId, from: 2, to: 3 }])
    // Keeping the first run takes the second.
    expect(takesToRemove(g, { [g[0].id]: 0 }).words).toEqual([{ sentence: g[0].takes[0].sentenceId, from: 4, to: 5 }])
  })

  it('skips fillers between the runs and cuts them too', () => {
    const g = groupsOf(voice([said(0, 'So the plan is, um, the plan is simple.')]))
    expect(g[0].stumble).toMatchObject({ first: [1, 3], second: [5, 7] })
    expect(g[0].takes[0].text).toBe('the plan is, um,')
  })

  it('a stuttered small word is a stumble; “very very” and “that that” are meant', () => {
    expect(groupsOf(voice([said(0, 'Open the the menu.')]))[0].confidence).toBeGreaterThanOrEqual(0.7)
    expect(groupsOf(voice([said(0, 'It was very very good.')]))[0].confidence).toBeLessThan(0.5)
    expect(groupsOf(voice([said(0, 'I know that that works.')]))[0].confidence).toBeLessThan(0.5)
    expect(groupsOf(voice([said(0, 'No no no, not like that.')]))[0].confidence).toBeLessThan(0.5)
  })

  it('needs word timings to be sure of a cut inside a phrase', () => {
    const g = groupsOf(voice([phrase(0, 4, 'I think we can, we can do this.')]))
    expect(g[0].confidence).toBeLessThanOrEqual(0.55)
  })

  it('isn’t looked for again inside a take that goes anyway', () => {
    const g = groupsOf(voice([said(0, 'We can, we can—'), said(3, 'We can, we can do this together.')]))
    expect(g.filter((x) => x.kind === 'stumble').map((x) => x.takes[0].sentenceId)).toEqual([g[0].takes[1].sentenceId])
  })
})
