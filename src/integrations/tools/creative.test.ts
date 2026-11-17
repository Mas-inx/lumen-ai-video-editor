import { beforeEach, describe, expect, it } from 'vitest'
import { normalizeBrandKit } from '@shared/brand'
import type { Asset } from '@/editor/types'

const { agentTools, runAgentTool } = await import('../agent-tools')
const { useEditor, getProject, dispatch } = await import('@/editor/store')
const { createEmptyProject } = await import('@/editor/new-project')
const { createClip } = await import('@/editor/defaults')
const { useBrandKits, watermarkTransform } = await import('@/project/brand')
const { BUILTIN_SKILLS, describeTool, useSkills } = await import('../skills')

type Json = Record<string, any>

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = await runAgentTool(name, args)
  const text = res.content.find((c) => c.type === 'text')
  return { ...res, json: (res.isError ? { error: text && 'text' in text ? text.text : '' } : res.structuredContent) as Json }
}

const media = (id: string, kind: Asset['kind'], extra: Partial<Asset> = {}): Asset => ({
  id,
  name: id,
  kind,
  ...(kind !== 'image' ? { duration: 10 } : {}),
  source: { type: 'file', url: `lumen-media://file/${id}`, mime: kind === 'image' ? 'image/jpeg' : 'video/mp4', fileName: 'MVI_0001.MP4', size: 1 },
  addedAt: 1,
  ...extra,
})

beforeEach(() => {
  const p = createEmptyProject('Directing')
  const main = p.tracks.find((t) => t.name === 'Main')!.id
  const titles = p.tracks.find((t) => t.name === 'Titles')!.id
  // The interview speaks; the rest is B-roll waiting in the library.
  p.assets.interview = media('interview', 'video', { name: 'Mountain interview', hasAudio: true, transcript: [{ start: 0, end: 2.5, text: 'We drove up to the mountains.' }, { start: 3, end: 5, text: 'The city felt far away.' }] })
  p.assets.alps = media('alps', 'image', { name: 'Alps at dawn', tags: ['mountains', 'sunrise'] })
  p.assets.skyline = media('skyline', 'video', { name: 'Skyline timelapse', description: 'The city at night from a rooftop' })
  p.clips.i1 = createClip({ id: 'i1', kind: 'video', trackId: main, start: 0, duration: 150, assetId: 'interview' })
  p.clips.b1 = createClip({ id: 'b1', kind: 'image', trackId: main, start: 150, duration: 60, assetId: 'alps' })
  p.clips.t1 = createClip({ id: 't1', kind: 'text', trackId: titles, start: 0, duration: 60, text: { content: 'Up there', size: 150 } })
  useEditor.getState().loadProject(p)
  useBrandKits.setState({ store: { activeId: null, kits: [] }, loaded: true })
  useSkills.setState({ disk: [], off: [], on: [], loaded: true })
})

describe('the creative tools', () => {
  it('are registered, with the storyboard and brand commands', () => {
    const names = new Set(agentTools().map((t) => t.name))
    for (const name of ['get_storyboard', 'list_styles', 'apply_style', 'suggest_broll', 'get_brand_kit', 'apply_brand_kit', 'storyboard_update', 'storyboard_addScenes', 'storyboard_updateScene', 'storyboard_moveScene', 'storyboard_removeScenes', 'brand_set']) {
      expect(names.has(name), name).toBe(true)
    }
  })

  it('come with the director skill, which the planning tools point at', () => {
    const skill = BUILTIN_SKILLS.find((k) => k.name === 'video-director')!
    expect(skill.description).toMatch(/storyboard/)
    expect(skill.body).toMatch(/Let the user review it/)
    expect(describeTool('get_storyboard', 'The storyboard.')).toContain('use_skill("video-director")')
    expect(describeTool('storyboard_addScenes', 'Add scenes.')).toContain('use_skill("video-director")')
  })
})

describe('the storyboard, as the AI reads it', () => {
  it('says how to start when there is none', async () => {
    const res = await call('get_storyboard')
    expect(res.json).toMatchObject({ scenes: [] })
    expect(res.json.note).toMatch(/storyboard_addScenes/)
  })

  it('lists scenes in order with running times, and where produced ones are now', async () => {
    await call('storyboard_update', { brief: 'A 20 s film about leaving the city', style: 'documentary' })
    const added = await call('storyboard_addScenes', {
      scenes: [
        { title: 'Interview', script: 'We drove up to the mountains.', treatment: 'footage', seconds: 5, assetIds: ['interview'] },
        { title: 'Peaks', script: 'Up there it was quiet.', treatment: 'broll', seconds: 2, transition: { kind: 'dissolve', seconds: 0.5 }, needs: ['A wide of the valley'] },
      ],
    })
    const [first, second] = added.json.result as string[]
    await call('storyboard_updateScene', { id: second, patch: { produced: { clipIds: ['b1'] }, status: 'done' } })
    const res = await call('get_storyboard')
    expect(res.json).toMatchObject({ brief: 'A 20 s film about leaving the city', style: 'documentary', style_name: 'Documentary', planned_seconds: 7, done: 1, produced: 1 })
    expect(res.json.scenes[0]).toMatchObject({ n: 1, id: first, starts_at_seconds: 0, transition_in: 'cut', media: [{ asset_id: 'interview', name: 'Mountain interview', kind: 'video' }] })
    expect(res.json.scenes[1]).toMatchObject({
      n: 2,
      starts_at_seconds: 5,
      transition_in: { kind: 'dissolve', seconds: 0.5 },
      needs: ['A wide of the valley'],
      produced: { timeline: 'Main timeline', from_seconds: 5, to_seconds: 7, seconds: 2, clip_ids: ['b1'] },
    })
    expect((await call('get_storyboard', { scene_id: second })).json).toMatchObject({ n: 2, title: 'Peaks' })
    expect((await call('get_storyboard', { scene_id: 'nope' })).json.error).toMatch(/No scene “nope”.*Scenes: .*Interview/)
    expect((await call('get_project')).json.storyboard).toMatchObject({ scenes: 2, done: 1, style: 'documentary' })
  })
})

describe('styles for the AI', () => {
  it('list every rule, in seconds', async () => {
    const res = await call('list_styles')
    expect(res.json.styles.map((s: Json) => s.id)).toEqual(['editorial', 'commercial', 'kinetic', 'infographic', 'cinematic', 'documentary'])
    expect(res.json.styles.find((s: Json) => s.id === 'documentary')).toMatchObject({ transition: 'straight cuts', camera: { move: 'ken-burns', on: 'stills' }, headline: { in: 'fade 0.8s' }, motion_graphics: { 'lower-third': { style: 'minimal' } } })
  })

  it('apply as one AI step, to everything or to a storyboard scene', async () => {
    const steps = useEditor.getState().past.length
    const res = await call('apply_style', { style_id: 'cinematic' })
    expect(res.json).toMatchObject({ applied: 'Cinematic', titles: 1, footage: 2, cuts: 1 })
    expect(useEditor.getState().past).toHaveLength(steps + 1)
    expect(useEditor.getState().past.at(-1)).toMatchObject({ label: 'Apply Cinematic style', source: 'ai' })
    expect(getProject().clips.t1.text).toMatchObject({ uppercase: true, letterSpacing: 0.42 })

    const added = await call('storyboard_addScenes', { scenes: [{ title: 'Peaks', produced: { clipIds: ['b1'] } }] })
    const scene = (added.json.result as string[])[0]
    const scoped = await call('apply_style', { style_id: 'kinetic', scene_id: scene })
    expect(scoped.json).toMatchObject({ applied: 'Kinetic typography', footage: 1, titles: 0 })
    expect(getProject().clips.b1.style).toBe('kinetic')
    expect(getProject().clips.i1.style).toBe('cinematic')
  })

  it('explain what went wrong', async () => {
    expect((await call('apply_style', { style_id: 'vaporwave' })).json.error).toMatch(/no style “vaporwave”.*editorial, commercial/)
    expect((await call('apply_style', { style_id: 'brand' })).json.error).toMatch(/no brand yet — apply_brand_kit first/)
    expect((await call('apply_style', { style_id: 'cinematic', clip_ids: ['ghost'] })).json.error).toMatch(/None of those clips exist/)
    const added = await call('storyboard_addScenes', { scenes: [{ title: 'Not made yet' }] })
    expect((await call('apply_style', { style_id: 'cinematic', scene_id: (added.json.result as string[])[0] })).json.error).toMatch(/isn’t on the open timeline yet/)
  })
})

describe('suggest_broll', () => {
  it('matches what is said on the timeline to project media — not the speaker’s own footage', async () => {
    const res = await call('suggest_broll')
    expect(res.json.media_considered).toBe(2)
    const [mountains, city] = res.json.sentences
    expect(mountains).toMatchObject({ start_seconds: 0, end_seconds: 2.5, text: 'We drove up to the mountains.', pick: 'alps' })
    expect(mountains.candidates[0]).toMatchObject({ asset_id: 'alps', found_in: ['tags'], on_timeline: 1 })
    expect(mountains.candidates.map((c: Json) => c.asset_id)).not.toContain('interview')
    expect(city).toMatchObject({ text: 'The city felt far away.', pick: 'skyline' })
    expect(city.candidates[0]).toMatchObject({ found_in: ['description'] })
  })

  it('matches any text, or a storyboard scene’s script', async () => {
    expect((await call('suggest_broll', { text: 'Lights over the city at night. A sunrise in the alps.' })).json.sentences.map((s: Json) => s.pick)).toEqual(['skyline', 'alps'])
    const added = await call('storyboard_addScenes', { scenes: [{ title: 'Dawn', script: 'Sunrise over the peaks.' }, { title: 'Empty' }] })
    const [dawn, empty] = added.json.result as string[]
    expect((await call('suggest_broll', { scene_id: dawn })).json.sentences[0]).toMatchObject({ pick: 'alps' })
    expect((await call('suggest_broll', { scene_id: empty })).json.error).toMatch(/no script to match/)
  })

  it('says when there is nothing to match, or nothing to use', async () => {
    useEditor.getState().loadProject(createEmptyProject('Empty'))
    expect((await call('suggest_broll')).json.error).toMatch(/transcribe_media/)
    expect((await call('suggest_broll', { text: 'The sea' })).json.error).toMatch(/no video or still in the project/)
  })
})

describe('brand kits for the AI', () => {
  const kit = normalizeBrandKit(
    {
      id: 'brand_acme',
      name: 'Acme',
      colors: [{ name: 'Signal', hex: '#FF5A36' }, { name: 'Ink', hex: '#111111' }],
      fonts: { heading: { name: 'Acme Sans', fileName: 'AcmeSans.ttf', data: 'AAEAAAALAIAAAwAwT1MvMg==' }, body: { builtin: 'mono' } },
      titles: { color: '#ffffff', background: '#ff5a36', weight: 800, uppercase: true, tracking: 0.04 },
      captions: { style: 'word', accent: '#ff5a36', uppercase: null },
      look: 'vivid',
      motion: { titleIn: 'pop', titleOut: 'fade', seconds: 0.4, easing: 'back-out', transition: 'cut', transitionSeconds: 0.4 },
      style: 'commercial',
    },
    'brand_acme',
  )

  it('read the kits and the project’s own brand', async () => {
    expect((await call('get_brand_kit')).json).toMatchObject({ project_brand: null, kits: [], note: expect.stringMatching(/no brand kits yet/) })
    useBrandKits.setState({ store: { activeId: kit.id, kits: [kit] }, loaded: true })
    const res = await call('get_brand_kit')
    expect(res.json.kits).toEqual([{ id: 'brand_acme', name: 'Acme', active: true }])
    expect(res.json.kit).toMatchObject({ name: 'Acme', colors: [{ name: 'Signal', hex: '#ff5a36' }, { name: 'Ink', hex: '#111111' }], fonts: { heading: { name: 'Acme Sans', file: 'AcmeSans.ttf' }, body: { builtin: 'mono', name: 'Geist Mono' } }, style: 'commercial' })
    expect((await call('get_brand_kit', { kit_id: 'nope' })).json.error).toMatch(/No brand kit “nope”.*brand_acme \(Acme\)/)
  })

  it('apply a kit as one step: fonts embedded, the brand kept, the timeline styled', async () => {
    useBrandKits.setState({ store: { activeId: kit.id, kits: [kit] }, loaded: true })
    const before = JSON.stringify(getProject())
    const steps = useEditor.getState().past.length
    const res = await call('apply_brand_kit')
    expect(res.json).toMatchObject({ brand: 'Acme', fonts: { heading: 'Acme Sans', body: 'Geist Mono' }, builds_on: 'commercial', titles: 1, footage: 2 })
    const p = getProject()
    const font = Object.values(p.fonts ?? {})[0]
    expect(font).toMatchObject({ name: 'Acme Sans', fileName: 'AcmeSans.ttf' })
    expect(p.brand).toMatchObject({ kitId: 'brand_acme', name: 'Acme', fonts: { heading: `custom:${font.id}`, body: 'mono' }, look: 'vivid' })
    expect(p.clips.t1.text).toMatchObject({ font: `custom:${font.id}`, weight: 800, uppercase: true, color: '#ffffff' })
    expect(p.clips.t1.animation.in.preset).toBe('pop')
    expect(p.clips.b1).toMatchObject({ look: 'vivid', transitionIn: null, style: 'brand' })
    expect(useEditor.getState().past).toHaveLength(steps + 1)
    expect(useEditor.getState().past.at(-1)).toMatchObject({ label: 'Apply brand kit “Acme”', source: 'ai' })
    expect((await call('get_project')).json.brand).toMatchObject({ name: 'Acme' })

    // Applying it again reuses the embedded font.
    await call('apply_brand_kit')
    expect(Object.keys(getProject().fonts ?? {})).toHaveLength(1)

    // After that, styles keep the brand's type.
    await call('apply_style', { style_id: 'editorial' })
    expect(getProject().clips.t1.text!.font).toBe(`custom:${font.id}`)

    for (let i = 0; i < 3; i++) await call('undo')
    expect(JSON.stringify(getProject())).toBe(before)
  })

  it('say there is no kit to apply', async () => {
    expect((await call('apply_brand_kit')).json.error).toMatch(/no brand kit yet/)
    expect(dispatch('brand.set', { brand: null }).ok).toBe(true)
  })

  it('put the logo in its corner at its size', () => {
    const t = watermarkTransform({ width: 1920, height: 1080 }, { width: 400, height: 200 }, { logoId: 'l', corner: 'top-right', size: 0.1, opacity: 0.8 })
    // Fitted to the frame a 400×200 logo is 4.8× (the width limits it); a tenth of 1920 is 192 px wide.
    expect(t.scale).toBeCloseTo(192 / (400 * 4.8), 3)
    expect(t.x).toBe(Math.round(960 - 1080 * 0.045 - 96))
    expect(t.y).toBe(Math.round(-(540 - 1080 * 0.045 - 48)))
    expect(t.opacity).toBe(0.8)
  })
})
