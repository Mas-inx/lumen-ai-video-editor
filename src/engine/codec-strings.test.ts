import { describe, expect, it } from 'vitest'
import { av1Level, avcLevel, codecString, hevcLevel } from './codec-strings'

describe('codec strings', () => {
  it('give H.264 the level the frame rate needs, not just the size', () => {
    expect(avcLevel(1280, 720, 30, 5e6)).toBe(31)
    expect(avcLevel(1920, 1080, 30, 12e6)).toBe(40)
    expect(avcLevel(1920, 1080, 60, 20e6)).toBe(42)
    expect(avcLevel(2560, 1440, 30, 25e6)).toBe(50)
    expect(avcLevel(3840, 2160, 30, 45e6)).toBe(51)
    // 4K at 60 is past level 5.1's macroblock rate.
    expect(avcLevel(3840, 2160, 60, 80e6)).toBe(52)
    expect(avcLevel(7680, 4320, 30, 200e6)).toBe(60)
    expect(codecString('avc', 3840, 2160, 60, 80e6)).toBe('avc1.640034')
    expect(codecString('avc', 1920, 1080, 30, 12e6)).toBe('avc1.640028')
  })

  it('raise the level when the bitrate is past what a level carries', () => {
    // 1080p30 fits level 4, but 40 Mbit/s needs 4.1 (High carries 1.25× the Main limit).
    expect(avcLevel(1920, 1080, 30, 40e6)).toBe(41)
  })

  it('pick the HEVC level and tier', () => {
    expect(hevcLevel(1920, 1080, 30, 8e6)).toEqual({ level: 120, tier: 'L' })
    expect(hevcLevel(1920, 1080, 60, 12e6)).toEqual({ level: 123, tier: 'L' })
    expect(hevcLevel(3840, 2160, 30, 20e6)).toEqual({ level: 150, tier: 'L' })
    expect(hevcLevel(3840, 2160, 60, 35e6)).toEqual({ level: 153, tier: 'L' })
    // More bits than the Main tier takes at 5.1: the High tier.
    expect(hevcLevel(3840, 2160, 60, 62e6)).toEqual({ level: 153, tier: 'H' })
    expect(codecString('hevc', 3840, 2160, 60, 35e6)).toBe('hev1.1.6.L153.B0')
    expect(codecString('hevc', 3840, 2160, 60, 62e6)).toBe('hev1.1.6.H153.B0')
  })

  it('pick the AV1 and VP9 levels', () => {
    expect(av1Level(1920, 1080, 30, 6e6)).toEqual({ level: 8, tier: 'M' })
    expect(av1Level(3840, 2160, 30, 20e6)).toEqual({ level: 12, tier: 'M' })
    expect(av1Level(3840, 2160, 60, 35e6)).toEqual({ level: 13, tier: 'M' })
    expect(av1Level(3840, 2160, 60, 50e6)).toEqual({ level: 13, tier: 'H' })
    expect(codecString('av1', 3840, 2160, 60, 35e6)).toBe('av01.0.13M.08')
    expect(codecString('vp9', 3840, 2160, 60, 60e6)).toBe('vp09.00.51.08')
    expect(codecString('vp9', 1920, 1080, 30, 10e6)).toBe('vp09.00.40.08')
  })
})
