import { describe, expect, it } from 'vitest'
import { rankBroll, scriptSentences, sentencesOf, stem, terms, undescribed, words } from './broll'
import { createClip } from './defaults'
import { createEmptyProject } from './new-project'
import type { Asset, Project } from './types'

function asset(id: string, kind: Asset['kind'], extra: Partial<Asset> = {}, path?: string): Asset {
  const fileName = path ? path.split('/').pop()! : 'MVI_0001.MP4'
  return { id, name: id, kind, source: { type: 'file', url: `lumen-media://file/${id}`, path, mime: 'video/mp4', fileName, size: 1 }, addedAt: 1, ...extra }
}

/** A library of B-roll that says what it is in every way the project can know it. */
function library(): Project {
  const p = createEmptyProject('B-roll')
  const list = [
    // Only its folder says what it is.
    asset('drone', 'video', { name: 'DJI_0042' }, 'D:/Footage/Mountains/DJI_0042.mp4'),
    asset('city', 'video', { name: 'City lights', tags: ['night', 'skyline'] }),
    asset('coffee', 'image', { name: 'Shot 3', description: 'A barista pours a latte in a sunny cafe' }),
    asset('beach', 'image', { name: 'Generated image', generated: true, provenance: { integration: 'openai', tool: 'image', prompt: 'Golden hour waves rolling onto a quiet beach' }, tags: ['ai'] }),
    asset('vlog', 'video', { name: 'Vlog day 2', transcript: [{ start: 3, end: 6.5, text: 'Today we drive the coast road at sunrise' }, { start: 9, end: 11, text: 'Lunch by the water' }] }),
    asset('mystery', 'image', { name: 'IMG_1234' }, 'C:/Users/me/Pictures/IMG_1234.jpg'),
    // Not B-roll: sound, a transparent overlay, a matte.
    asset('voice', 'audio', { name: 'City voiceover' }),
    asset('lower3', 'video', { name: 'City lower third', alpha: true }),
    asset('matte', 'video', { name: 'City matte', matteOf: { assetId: 'city', subject: 'person', from: 0, to: 1 } }),
  ]
  for (const a of list) p.assets[a.id] = a
  return p
}

const best = (p: Project, text: string, opts = {}) => rankBroll(p, [{ text }], opts).suggestions[0]

describe('words', () => {
  it('lower-case, unaccented, split on case and punctuation, without filler', () => {
    expect(words('DJI_0042 sunsetBeach — Café, um, the 2024 trip')).toEqual(['dji', 'sunset', 'beach', 'cafe', '2024', 'trip'])
  })

  it('stem so that forms of a word meet', () => {
    expect(stem('driving')).toBe(stem('drive'))
    expect(stem('drives')).toBe(stem('drive'))
    expect(stem('cities')).toBe('city')
    expect(stem('beaches')).toBe('beach')
    expect(stem('mountains')).toBe('mountain')
    expect(stem('stopped')).toBe('stop')
    expect(terms('Running offices')).toEqual([stem('run'), stem('office')])
  })
})

describe('ranking B-roll', () => {
  it('finds media by its name and tags', () => {
    const s = best(library(), 'The city never sleeps at night')
    expect(s.candidates[0]).toMatchObject({ assetId: 'city', matched: expect.arrayContaining(['city', 'night']), fields: expect.arrayContaining(['name', 'tags']) })
    expect(s.pick).toBe('city')
  })

  it('finds it by meaning: related words in a description', () => {
    const s = best(library(), 'Nothing beats the first coffee of the morning')
    expect(s.candidates[0]).toMatchObject({ assetId: 'coffee', fields: ['description'], matched: expect.arrayContaining(['coffee']) })
  })

  it('reads generation prompts and folder names, not camera file names', () => {
    expect(best(library(), 'Waves at golden hour').candidates[0]).toMatchObject({ assetId: 'beach', fields: ['prompt'] })
    expect(best(library(), 'Up in the mountains').candidates[0]).toMatchObject({ assetId: 'drone', fields: ['folder'] })
    expect(best(library(), 'A DJI drone shot').candidates.map((c) => c.assetId)).not.toContain('mystery')
  })

  it('points at the moment in the media where it is said', () => {
    const s = best(library(), 'We drive along the coast')
    expect(s.candidates[0]).toMatchObject({ assetId: 'vlog', fields: ['transcript'], at: { start: 3, end: 6.5, text: 'Today we drive the coast road at sunrise' } })
  })

  it('never offers sound, transparent overlays or mattes', () => {
    const all = rankBroll(library(), [{ text: 'City lights at night, the city voiceover and the city matte' }], { perLine: 10 }).suggestions[0]
    expect(all.candidates.map((c) => c.assetId)).toEqual(['city'])
  })

  it('ranks closer matches higher and keeps scores between 0 and 1', () => {
    const s = best(library(), 'City skyline at night', { perLine: 10 })
    const city = s.candidates.find((c) => c.assetId === 'city')!
    expect(city.score).toBeGreaterThan(0.6)
    expect(city.score).toBeLessThanOrEqual(1)
    const weaker = best(library(), 'A city', { perLine: 10 }).candidates.find((c) => c.assetId === 'city')!
    expect(weaker.score).toBeLessThan(city.score)
  })

  it('says nothing when nothing fits, rather than guessing', () => {
    expect(best(library(), 'Quarterly tax compliance requirements').candidates).toEqual([])
  })

  it('varies the picks across lines, and can leave out what is already used', () => {
    const p = library()
    const lines = [{ text: 'The city at night' }, { text: 'The city skyline glows' }, { text: 'City streets' }]
    // Only one media item fits all three; it stays the pick rather than nothing.
    expect(rankBroll(p, lines).suggestions.map((s) => s.pick)).toEqual(['city', 'city', 'city'])
    p.clips.c1 = createClip({ kind: 'video', trackId: p.tracks.find((t) => t.role === 'main')!.id, start: 0, duration: 30, assetId: 'city' })
    expect(best(p, 'The city at night').candidates[0]).toMatchObject({ assetId: 'city', onTimeline: 1 })
    expect(best(p, 'The city at night', { unusedOnly: true }).candidates).toEqual([])
    expect(best(p, 'The city at night', { exclude: ['city'] }).candidates).toEqual([])
    expect(best(p, 'Waves at golden hour', { kinds: ['video'] }).candidates).toEqual([])
  })

  it('picks a different shot for the next line when there is one', () => {
    const p = library()
    p.assets.city2 = asset('city2', 'video', { name: 'City traffic', tags: ['night'] })
    const r = rankBroll(p, [{ text: 'The city at night' }, { text: 'The city at night again' }])
    expect(new Set(r.suggestions.map((s) => s.pick)).size).toBe(2)
  })

  it('lists media nothing describes', () => {
    const p = library()
    // The drone shot's name and file name are a camera's; only its folder says anything.
    expect(rankBroll(p, [{ text: 'anything' }]).undescribed).toEqual(['drone', 'mystery'])
    expect(undescribed(p.assets.mystery)).toBe(true)
    expect(undescribed(p.assets.coffee)).toBe(false)
    expect(undescribed(p.assets.beach)).toBe(false)
  })
})

describe('lines to match', () => {
  it('joins timed phrases into sentences', () => {
    const lines = sentencesOf([
      { start: 0, end: 1.2, text: 'We drove up' },
      { start: 1.2, end: 2.5, text: 'to the mountains.' },
      { start: 3, end: 4, text: 'The light was perfect!' },
      { start: 5, end: 6, text: 'um' },
    ])
    expect(lines).toEqual([
      { start: 0, end: 2.5, text: 'We drove up to the mountains.' },
      { start: 3, end: 4, text: 'The light was perfect!' },
    ])
  })

  it('splits a script into sentences and lines', () => {
    expect(scriptSentences('Our city wakes up. Coffee first!\nThen the commute')).toEqual([{ text: 'Our city wakes up.' }, { text: 'Coffee first!' }, { text: 'Then the commute' }])
  })
})
