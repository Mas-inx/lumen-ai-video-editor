import { beforeEach, describe, expect, it } from 'vitest'
import { createClip, createTrack } from './defaults'
import { createEmptyProject } from './new-project'
import { LOOKS } from './presets'
import { dispatch, getProject, useEditor } from './store'
import { applyStyle, brandStyle, cameraKeys, lightness, planStyle, STYLES, styleById, styleToApply, textOn, textWidth, titlePatch, type StyleSpec } from './styles'
import type { Asset, Clip, Project, ProjectBrand } from './types'

const media = (id: string, kind: 'video' | 'image', extra: Partial<Asset> = {}): Asset => ({
  id,
  name: id,
  kind,
  width: 1920,
  height: 1080,
  ...(kind === 'video' ? { duration: 20 } : {}),
  source: { type: 'file', url: `lumen-media://file/${id}`, mime: kind === 'video' ? 'video/mp4' : 'image/jpeg', fileName: id, size: 1 },
  addedAt: 1,
  ...extra,
})

const style = (id: string) => styleById(id)!
const clip = (id: string) => getProject().clips[id]

/**
 * A small edit: a headline and a lower third, three captions, three shots on the
 * main track (the last already dissolving in), a transparent overlay and a title
 * on a locked track.
 */
beforeEach(() => {
  const p = createEmptyProject('Styles')
  const track = (name: string) => p.tracks.find((t) => t.name === name)!.id
  const captions = createTrack('video', { name: 'Captions', role: 'captions' })
  const locked = createTrack('video', { name: 'Locked titles', locked: true })
  p.tracks.unshift(captions, locked)
  for (const a of [media('vid_a', 'video'), media('still_b', 'image'), media('vid_c', 'video'), media('overlay', 'video', { alpha: true })]) p.assets[a.id] = a
  const add = (c: Clip) => (p.clips[c.id] = c)
  add(createClip({ id: 'h1', kind: 'text', trackId: track('Titles'), start: 0, duration: 90, text: { content: 'The big idea', size: 150 } }))
  add(createClip({ id: 'l3', kind: 'text', trackId: track('Titles'), start: 120, duration: 90, text: { content: 'Ana Ruiz', size: 44, align: 'left' }, transform: { x: -520, y: 360 } }))
  add(createClip({ id: 'cap1', kind: 'text', trackId: captions.id, start: 0, duration: 30, text: { content: 'We built it' } }))
  add(createClip({ id: 'cap2', kind: 'text', trackId: captions.id, start: 30, duration: 30, text: { content: 'for everyone' } }))
  add(createClip({ id: 'cap3', kind: 'text', trackId: captions.id, start: 60, duration: 30, text: { content: 'everywhere.' } }))
  add(createClip({ id: 'v1', kind: 'video', trackId: track('Main'), start: 0, duration: 90, assetId: 'vid_a' }))
  add(createClip({ id: 'v2', kind: 'image', trackId: track('Main'), start: 90, duration: 90, assetId: 'still_b' }))
  add(createClip({ id: 'v3', kind: 'video', trackId: track('Main'), start: 180, duration: 90, assetId: 'vid_c', transitionIn: { kind: 'dissolve', duration: 12 } }))
  add(createClip({ id: 'ov', kind: 'video', trackId: track('Overlay'), start: 0, duration: 60, assetId: 'overlay' }))
  add(createClip({ id: 'lockedTitle', kind: 'text', trackId: locked.id, start: 0, duration: 60, text: { content: 'Untouchable' } }))
  useEditor.getState().loadProject(p)
})

describe('the built-in styles', () => {
  // How a style composes the frame, and how it moves — colour aside.
  const composition = (s: StyleSpec) => [s.headline.place, s.headline.size, s.headline.uppercase, s.headline.font, s.label.place, s.label.background ? 'box' : 'bare', s.captions?.style].join('|')
  const motion = (s: StyleSpec) => [s.headline.in?.preset, s.headline.in?.seconds, s.headline.out?.preset, s.transition ? `${s.transition.kind}/${s.transition.seconds}` : 'cut', s.camera ? `${s.camera.move}/${s.camera.on}` : 'still'].join('|')

  it('are the six asked for, each with every rule set', () => {
    expect(STYLES.map((s) => s.id)).toEqual(['editorial', 'commercial', 'kinetic', 'infographic', 'cinematic', 'documentary'])
    for (const s of STYLES) {
      for (const look of [s.headline, s.label]) expect(look, s.id).toMatchObject({ font: expect.any(String), weight: expect.any(Number), size: expect.any(Number), place: expect.any(String), in: expect.any(Object), out: expect.any(Object) })
      expect(s.captions, s.id).toBeDefined()
      expect(s.transition, s.id).not.toBeUndefined()
      expect(LOOKS.some((l) => l.id === s.look), s.id).toBe(true)
      expect(s.pacing.notes.length, s.id).toBeGreaterThan(40)
    }
  })

  it('differ from each other in composition and in motion, not only in colour', () => {
    for (const a of STYLES) {
      for (const b of STYLES) {
        if (a === b) continue
        expect(composition(a), `${a.id} vs ${b.id}`).not.toBe(composition(b))
        expect(motion(a), `${a.id} vs ${b.id}`).not.toBe(motion(b))
      }
    }
  })
})

describe('applying a style', () => {
  it('sets titles’ typography, place and motion — headlines and lower thirds each their way', () => {
    applyStyle(style('editorial'))
    const h1 = clip('h1')
    expect(h1.text).toMatchObject({ font: 'fraunces', weight: 420, uppercase: false, letterSpacing: -0.02, align: 'left', color: '#f4f1ea' })
    expect(h1.text!.size).toBe(Math.round(1080 * 0.105))
    // Set off-centre: its left edge near the left margin.
    expect(h1.transform.x).toBeLessThan(-300)
    expect(h1.transform.x - textWidth(h1.text!, h1.text!.size) / 2).toBeCloseTo(-960 + 1080 * 0.07, -1)
    expect(h1.animation).toEqual({ in: { preset: 'rise', duration: 27 }, out: { preset: 'fade', duration: 18 } })
    const l3 = clip('l3')
    expect(l3.text).toMatchObject({ font: 'sans', uppercase: true, letterSpacing: 0.2, size: 28 })
    expect(l3.transform.y).toBe(Math.round(1080 * 0.29))
    expect(h1.style).toBe('editorial')
  })

  it('restyles captions in the style’s caption style, key words in its accent', () => {
    applyStyle(style('kinetic'))
    expect(clip('cap1').text).toMatchObject({ font: 'archivo', uppercase: true, size: Math.round(1080 * 0.095), color: '#ffffff' })
    expect(clip('cap1').transform.y).toBe(216)
    // “everywhere.” ends the phrase and is long: a key word.
    expect(clip('cap3').text!.color).toBe('#ff4b36')
    expect(clip('cap1').animation.in.preset).toBe('pop')
    // Back to clean captions: the accent colour goes.
    applyStyle(style('cinematic'))
    expect(clip('cap3').text).toMatchObject({ color: '#ffffff', background: 'rgba(0,0,0,0.55)', uppercase: false })
  })

  it('puts the transition on the cuts between shots, or makes them straight cuts', () => {
    applyStyle(style('commercial'))
    expect(clip('v2').transitionIn).toEqual({ kind: 'push', duration: 11, align: 'center' })
    expect(clip('v3').transitionIn).toEqual({ kind: 'push', duration: 11, align: 'center' })
    // The first shot has no cut before it; titles and captions aren't cuts.
    expect(clip('v1').transitionIn).toBeNull()
    expect(clip('cap2').transitionIn).toBeNull()
    applyStyle(style('documentary'))
    expect(clip('v2').transitionIn).toBeNull()
    expect(clip('v3').transitionIn).toBeNull()
  })

  it('gives footage the look, the finishing effects and the camera move — not the transparent overlay', () => {
    applyStyle(style('cinematic'))
    const v1 = clip('v1')
    expect(v1.color).toMatchObject(LOOKS.find((l) => l.id === 'cinematic')!.grade)
    expect(v1.look).toBe('cinematic')
    expect(v1.effects.map((e) => [e.kind, e.amount])).toEqual([['grain', 22]])
    expect(v1.keyframes.scale).toEqual([
      { frame: 0, value: 1, easing: 'sine-in-out' },
      { frame: 89, value: 1.06, easing: 'linear' },
    ])
    expect(v1.keyframes.x?.[0]).toEqual({ frame: 0, value: 0, easing: 'sine-in-out' })
    expect(Math.abs(v1.keyframes.x![1].value)).toBeCloseTo(1920 * 0.5 * 0.025, 3)
    expect(clip('ov')).toMatchObject({ effects: [], look: null, keyframes: {} })
    expect(clip('ov').style).toBeUndefined()
  })

  it('is one undo step, and undo takes all of it back', () => {
    const before = JSON.stringify(getProject())
    const steps = useEditor.getState().past.length
    const plan = applyStyle(style('cinematic'))
    expect(plan.counts).toEqual({ titles: 2, captions: 3, cuts: 2, footage: 3 })
    expect(useEditor.getState().past).toHaveLength(steps + 1)
    expect(useEditor.getState().past.at(-1)).toMatchObject({ label: 'Apply Cinematic style', source: 'user' })
    useEditor.getState().undo()
    expect(JSON.stringify(getProject())).toBe(before)
  })

  it('swaps the last style’s effects and camera move for the new one’s, keeping what was added by hand', () => {
    dispatch('effect.add', { ids: ['v1'], kind: 'vignette', amount: 30 })
    applyStyle(style('cinematic'))
    expect(clip('v1').effects.map((e) => e.kind).sort()).toEqual(['grain', 'vignette'])
    applyStyle(style('kinetic'))
    const v1 = clip('v1')
    expect(v1.effects.map((e) => e.kind).sort()).toEqual(['rgb', 'vignette'])
    // The camera move is gone and the shot sits exactly where it did.
    expect(v1.keyframes).toEqual({})
    expect(v1.transform).toMatchObject({ x: 0, y: 0, scale: 1 })
    expect(v1.style).toBe('kinetic')
  })

  it('changes nothing when the same style goes on again — no drifting camera', () => {
    applyStyle(style('editorial'))
    const once = JSON.stringify(getProject().clips)
    applyStyle(style('editorial'))
    expect(JSON.stringify(getProject().clips)).toBe(once)
    const again = planStyle(getProject(), style('editorial'))
    expect(again.steps.some((s) => s.name === 'keyframe.set' || s.name === 'keyframe.clear' || s.name === 'effect.remove')).toBe(false)
  })

  it('leaves motion animated by hand alone, and says so', () => {
    dispatch('keyframe.set', { clipId: 'v2', prop: 'scale', frame: 0, value: 1.4 })
    dispatch('keyframe.set', { clipId: 'v2', prop: 'scale', frame: 60, value: 1 })
    const plan = applyStyle(style('documentary'))
    expect(clip('v2').keyframes.scale!.map((k) => k.value)).toEqual([1.4, 1])
    expect(plan.skipped).toContain('A shot keeps the motion they were animated with by hand')
  })

  it('moves only stills when the style says so', () => {
    applyStyle(style('documentary'))
    expect(clip('v1').keyframes).toEqual({})
    expect(clip('v2').keyframes.scale?.map((k) => k.value)).toEqual([1, 1.096])
  })

  it('styles just a selection: its titles, its footage and the cuts into it', () => {
    applyStyle(style('commercial'), { clipIds: ['v2', 'h1'] })
    expect(clip('h1').text!.font).toBe('display')
    expect(clip('l3').text!.font).toBe('sans')
    expect(clip('l3').style).toBeUndefined()
    expect(clip('v2')).toMatchObject({ look: 'vivid', transitionIn: { kind: 'push' } })
    expect(clip('v1').look).toBeNull()
    expect(clip('v3').transitionIn).toEqual({ kind: 'dissolve', duration: 12 })
  })

  it('applies only the parts asked for', () => {
    applyStyle(style('cinematic'), { parts: ['transitions'] })
    expect(clip('v2').transitionIn?.kind).toBe('dissolve')
    expect(clip('h1').style).toBeUndefined()
    expect(clip('v1').effects).toEqual([])
  })

  it('skips locked tracks', () => {
    const plan = applyStyle(style('kinetic'))
    expect(plan.skipped).toContain('Locked titles is locked')
    expect(clip('lockedTitle').text!.font).toBe('sans')
  })

  it('shrinks a long title until it fits the frame', () => {
    const long = { ...clip('h1'), text: { ...clip('h1').text!, content: 'Everything you need to start your own studio' } }
    const patch = titlePatch(getProject(), long, style('kinetic').headline)
    expect(patch.text.size).toBeLessThan(Math.round(1080 * 0.17))
    expect(textWidth({ ...long.text, ...patch.text }, patch.text.size!)).toBeLessThanOrEqual(1920 * 0.88 + 1)
  })

  it('gives an extruded 3D title the type only', () => {
    const chrome = { ...clip('h1'), text: { ...clip('h1').text!, extrude: 0.3 } }
    const patch = titlePatch(getProject(), chrome, style('cinematic').headline)
    expect(patch).toEqual({ text: { font: 'sans', weight: 500, uppercase: true, italic: false, letterSpacing: 0.42 } })
  })

  it('works out camera moves from the shot’s own transform, starting there', () => {
    const c = { ...clip('v1'), transform: { ...clip('v1').transform, scale: 1.2, x: 40 } }
    const keys = cameraKeys(c, { move: 'push', on: 'all', intensity: 1, easing: 'cubic-out' }, { width: 1920 })
    expect(keys).toEqual({ scale: [{ frame: 0, value: 1.2, easing: 'cubic-out' }, { frame: 89, value: 1.296, easing: 'linear' }] })
  })
})

describe('a brand on a style', () => {
  const brand: ProjectBrand = {
    name: 'Acme',
    colors: [{ name: 'Orange', hex: '#ff5a36' }],
    fonts: { heading: 'syne', body: 'mono' },
    logoAssetIds: [],
    titles: { color: '#ffcc00', background: '#ff5a36', weight: 700, uppercase: true, tracking: 0.05 },
    captions: { style: 'bold', accent: '#ff5a36', uppercase: null },
    look: 'golden',
    motion: { titleIn: 'drop', titleOut: 'fade', seconds: 0.4, easing: 'back-out', transition: 'cut', transitionSeconds: 0.5 },
    style: 'cinematic',
  }

  it('keeps the style’s composition and motion and puts in the brand’s type and colours', () => {
    const s = brandStyle(brand, style('infographic'), 'identity')
    expect(s.id).toBe('infographic')
    expect(s.headline).toMatchObject({ font: 'syne', place: 'top-left', background: '#ff5a36', in: { preset: 'wipe' } })
    // Yellow wouldn't read on orange: white does.
    expect(s.headline.color).toBe('#ffffff')
    expect(s.label.font).toBe('mono')
    expect(s.captions).toMatchObject({ style: 'boxed', font: 'mono', accent: '#ff5a36' })
    expect(s.transition).toEqual(style('infographic').transition)
    expect(s.look).toBe('natural')
  })

  it('takes the brand kit’s house style as well when the kit is applied', () => {
    const s = brandStyle(brand, style('cinematic'), 'all')
    expect(s.id).toBe('brand')
    expect(s.headline).toMatchObject({ font: 'syne', color: '#ffcc00', weight: 700, uppercase: true, tracking: 0.05, in: { preset: 'drop', seconds: 0.4 }, place: 'center' })
    expect(s.label).toMatchObject({ background: '#ff5a36', color: '#ffffff' })
    expect(s.captions).toMatchObject({ style: 'bold' })
    expect(s.look).toBe('golden')
    expect(s.transition).toBeNull()
    expect(s.camera).toMatchObject({ move: 'ken-burns', easing: 'back-out' })
  })

  it('without a style of its own, sets only what the brand sets', () => {
    const s = brandStyle({ ...brand, style: null, look: null, motion: { ...brand.motion, transition: null } }, undefined, 'all')
    expect(s.headline.place).toBeUndefined()
    expect(s.headline.size).toBeUndefined()
    expect(s.transition).toBeUndefined()
    expect(s.camera).toBeUndefined()
    expect(s.look).toBeUndefined()
    const before = clip('h1').transform
    dispatch('brand.set', { brand: { ...brand, style: null } })
    applyStyle(s)
    expect(clip('h1').transform).toEqual(before)
    expect(clip('h1').text).toMatchObject({ font: 'syne', color: '#ffcc00' })
  })

  it('leaves the last style’s effects and camera move its own when it doesn’t set them', () => {
    applyStyle(style('cinematic'))
    const neutral = brandStyle({ ...brand, style: null, look: null, motion: { ...brand.motion, transition: null } }, undefined, 'all')
    const plan = applyStyle(neutral)
    expect(plan.counts.footage).toBe(0)
    expect(clip('v1').style).toBe('cinematic')
    // So the next style still knows the grain and the move are Cinematic's, and swaps them.
    applyStyle(style('kinetic'))
    expect(clip('v1').effects.map((e) => e.kind)).toEqual(['rgb'])
    expect(clip('v1').keyframes).toEqual({})
  })

  it('stays on a branded project unless asked not to', () => {
    dispatch('brand.set', { brand })
    expect(styleToApply(getProject(), 'kinetic')!.headline.font).toBe('syne')
    expect(styleToApply(getProject(), 'kinetic', false)!.headline.font).toBe('archivo')
    expect(styleToApply(getProject(), 'brand')!.id).toBe('brand')
    expect(styleToApply({ brand: undefined } as Project, 'brand')).toBeUndefined()
  })
})

describe('colour', () => {
  it('picks text that reads on a background', () => {
    expect(lightness('#ffffff')).toBeCloseTo(255, 0)
    expect(lightness('rgba(12,14,20,0.82)')).toBeLessThan(20)
    expect(textOn('#ffffff')).toBe('#111111')
    expect(textOn('#123')).toBe('#ffffff')
  })
})
