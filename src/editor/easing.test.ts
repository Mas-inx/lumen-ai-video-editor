import { describe, expect, it } from 'vitest'
import { bezier, easeAt, EASING_NAMES, isEasing } from './easing'

describe('easing curves', () => {
  it('start at 0 and end at 1 (hold jumps at the next key)', () => {
    for (const name of EASING_NAMES) {
      if (name === 'hold') continue
      expect(easeAt(name, 0)).toBeCloseTo(0, 5)
      expect(easeAt(name, 1)).toBeCloseTo(1, 5)
    }
    expect(easeAt('hold', 0.99)).toBe(0)
  })

  it('have the right character', () => {
    expect(easeAt('expo-out', 0.2)).toBeGreaterThan(0.7) // arrives fast
    expect(easeAt('expo-in', 0.5)).toBeLessThan(0.05) // leaves slowly
    expect(easeAt('sine-in-out', 0.5)).toBeCloseTo(0.5, 5)
    const overshoot = Math.max(...Array.from({ length: 50 }, (_, i) => easeAt('back-out', i / 49)))
    expect(overshoot).toBeGreaterThan(1.05)
    expect(Math.min(...Array.from({ length: 50 }, (_, i) => easeAt('back-in', i / 49)))).toBeLessThan(-0.05)
  })

  it('solves cubic-bezier like CSS', () => {
    expect(bezier(0, 0, 1, 1)(0.3)).toBeCloseTo(0.3, 4)
    expect(bezier(0.42, 0, 0.58, 1)(0.5)).toBeCloseTo(0.5, 4)
    // CSS "ease": about 0.8 at the halfway point.
    expect(bezier(0.25, 0.1, 0.25, 1)(0.5)).toBeCloseTo(0.8024, 3)
    expect(easeAt('cubic-bezier(0.25, 0.1, 0.25, 1)', 0.5)).toBeCloseTo(0.8024, 3)
  })

  it('knows its names', () => {
    expect(isEasing('quart-out')).toBe(true)
    expect(isEasing('cubic-bezier(0.2, 0.8, 0.2, 1)')).toBe(true)
    expect(isEasing('wobbly')).toBe(false)
    // Unknown curves fall back to the default rather than breaking playback.
    expect(easeAt('wobbly', 0.5)).toBeCloseTo(0.5, 5)
  })
})
