import { describe, expect, it } from 'vitest'
import { activeKit, BRAND_LIMITS, newBrandKit, normalizeBrandKit, normalizeBrandStore } from './brand'

describe('brand kits', () => {
  it('fill in everything a kit leaves out', () => {
    const kit = normalizeBrandKit({ name: 'Acme' }, 'brand_1')
    expect(kit).toMatchObject({ id: 'brand_1', name: 'Acme', fonts: { heading: { builtin: 'display' }, body: { builtin: 'sans' } }, look: null, style: null, logos: [] })
    expect(kit.colors.length).toBeGreaterThan(0)
    expect(normalizeBrandKit(null, 'x')).toMatchObject({ id: 'x', name: 'My brand' })
  })

  it('keep values in range and drop what isn’t valid', () => {
    const kit = normalizeBrandKit(
      {
        id: '../../escape',
        colors: Array.from({ length: 40 }, (_, i) => ({ name: `C${i}`, hex: i % 2 ? '#abc' : 'blue' })),
        titles: { color: null, background: 'nope', weight: 1000, uppercase: 'yes', tracking: -3 },
        captions: { accent: null, uppercase: true },
        motion: { seconds: 99, transition: '' },
        watermark: { corner: 'middle', opacity: 0 },
      },
      'brand_2',
    )
    expect(kit.id).toBe('brand_2')
    expect(kit.colors).toHaveLength(Math.min(20, BRAND_LIMITS.colors))
    expect(kit.colors.every((c) => c.hex === '#abc')).toBe(true)
    expect(kit.titles).toEqual({ color: null, background: null, weight: 900, uppercase: false, tracking: -0.5 })
    expect(kit.captions).toMatchObject({ accent: null, uppercase: true })
    expect(kit.motion).toMatchObject({ seconds: 10, transition: null })
    expect(kit.watermark).toMatchObject({ corner: 'top-right', opacity: 0.05 })
  })

  it('keep a font file only when it is base64 and not too large', () => {
    const ok = normalizeBrandKit({ fonts: { heading: { name: 'Acme', fileName: 'acme.ttf', data: 'AAEAAA==' }, body: { data: 'not base64!' } } }, 'k')
    expect(ok.fonts.heading).toEqual({ name: 'Acme', fileName: 'acme.ttf', data: 'AAEAAA==' })
    expect(ok.fonts.body).toEqual({ builtin: 'sans' })
    const huge = normalizeBrandKit({ fonts: { heading: { name: 'Big', fileName: 'big.ttf', data: 'A'.repeat(BRAND_LIMITS.fontBytes * 2) } } }, 'k')
    expect(huge.fonts.heading).toEqual({ builtin: 'display' })
  })

  it('give every kit its own id and an active one that exists', () => {
    const store = normalizeBrandStore({ activeId: 'b', kits: [newBrandKit('a', 'A'), newBrandKit('a', 'A again'), newBrandKit('b', 'B')] })
    expect(store.kits.map((k) => k.id)).toEqual(['a', 'b'])
    expect(activeKit(store)?.name).toBe('B')
    expect(normalizeBrandStore({ activeId: 'zzz', kits: [newBrandKit('a')] }).activeId).toBe('a')
    expect(normalizeBrandStore('garbage')).toEqual({ activeId: null, kits: [] })
    expect(activeKit({ activeId: null, kits: [] })).toBeUndefined()
  })
})
