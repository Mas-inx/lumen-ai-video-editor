import { describe, expect, it } from 'vitest'
import { buildCursorTrack, captureFrame, cleanRecordingName, cursorAt, fitRegion, pausedAt, recordingName, recordingSeconds, resolutionLabel, type CursorEvent, type RecordingClock } from './capture'

describe('what a recording’s picture is', () => {
  it('records the source as it is at native size, on even pixels', () => {
    expect(captureFrame(3120, 2080, null, 'native')).toEqual({ crop: { x: 0, y: 0, width: 3120, height: 2080 }, width: 3120, height: 2080, scaled: false })
    // A window one pixel off even loses that pixel, not the whole picture.
    expect(captureFrame(2563, 1441, null, 'native')).toMatchObject({ crop: { x: 0, y: 0, width: 2562, height: 1440 }, width: 2562, height: 1440 })
  })

  it('names a resolution by the short side and keeps the source’s shape', () => {
    expect(captureFrame(1920, 1080, null, 2160)).toMatchObject({ width: 3840, height: 2160, scaled: true })
    expect(captureFrame(3840, 2160, null, 1080)).toMatchObject({ width: 1920, height: 1080, scaled: true })
    // A 3:2 laptop screen at "4K" is 2160 high, not stretched to 16:9.
    expect(captureFrame(3120, 2080, null, 2160)).toMatchObject({ width: 3240, height: 2160 })
    // Portrait: the short side is the width.
    expect(captureFrame(1080, 1920, null, 720)).toMatchObject({ width: 720, height: 1280 })
  })

  it('never lets a side pass 3840', () => {
    // An ultrawide scaled to "4K" by its short side would be 5160 wide.
    const f = captureFrame(3440, 1440, null, 2160)
    expect(f.width).toBe(3840)
    expect(f.height).toBe(1608)
    expect(captureFrame(5120, 1440, null, 'native')).toMatchObject({ width: 3840, height: 1080, scaled: true })
  })

  it('fits a region to its source and to even pixels', () => {
    expect(fitRegion({ x: 401, y: 299, width: 1601, height: 901 }, 3120, 2080)).toEqual({ x: 400, y: 298, width: 1600, height: 900 })
    expect(fitRegion({ x: 3000, y: 2000, width: 800, height: 800 }, 3120, 2080)).toEqual({ x: 3000, y: 2000, width: 120, height: 80 })
    // The whole source, or something too small to be a picture, is no region.
    expect(fitRegion({ x: 0, y: 0, width: 3120, height: 2080 }, 3120, 2080)).toBeNull()
    expect(fitRegion({ x: 10, y: 10, width: 8, height: 400 }, 3120, 2080)).toBeNull()
    expect(fitRegion(null, 3120, 2080)).toBeNull()
  })

  it('scales a region like a source of its own', () => {
    expect(captureFrame(3120, 2080, { x: 400, y: 300, width: 1600, height: 900 }, 1080)).toEqual({ crop: { x: 400, y: 300, width: 1600, height: 900 }, width: 1920, height: 1080, scaled: true })
    expect(resolutionLabel(2160, 1920, 1080)).toBe('4K · 3840×2160')
    expect(resolutionLabel('native', 2562, 1440)).toBe('Native · 2562×1440')
  })
})

describe('naming a recording', () => {
  it('sorts by time and is a legal file name', () => {
    expect(recordingName(new Date(2026, 9, 13, 21, 5, 9))).toBe('Recording 2026-10-13 21.05.09')
    expect(recordingName(new Date(2026, 0, 2, 3, 4, 5), 'Take')).toBe('Take 2026-01-02 03.04.05')
  })

  it('cleans a name someone typed', () => {
    expect(cleanRecordingName('  Boss fight: take 2/3?  ')).toBe('Boss fight take 2 3')
    expect(cleanRecordingName('ends with dots...')).toBe('ends with dots')
    expect(cleanRecordingName('<>|')).toBe('')
    expect(cleanRecordingName('x'.repeat(200))).toHaveLength(80)
  })
})

describe('a recording’s own time', () => {
  const clock: RecordingClock = { startAt: 10_000, pauses: [{ from: 12_000, to: 15_000 }, { from: 20_000, to: Infinity }] }

  it('leaves paused time out', () => {
    expect(recordingSeconds(clock, 10_000)).toBe(0)
    expect(recordingSeconds(clock, 11_500)).toBe(1.5)
    // Inside a pause the clock stands still.
    expect(recordingSeconds(clock, 13_000)).toBe(2)
    expect(recordingSeconds(clock, 15_000)).toBe(2)
    expect(recordingSeconds(clock, 18_000)).toBe(5)
    // An open pause holds it for good.
    expect(recordingSeconds(clock, 60_000)).toBe(7)
  })

  it('knows when it was paused', () => {
    expect(pausedAt(clock, 11_999)).toBe(false)
    expect(pausedAt(clock, 12_000)).toBe(true)
    expect(pausedAt(clock, 15_000)).toBe(false)
    expect(pausedAt(clock, 1e12)).toBe(true)
  })
})

describe('the pointer as data', () => {
  // A window 1000 × 500 at (200, 100) that moves to (300, 100) two seconds in.
  const area = (t: number) => (t < 2000 ? { x: 200, y: 100, width: 1000, height: 500 } : { x: 300, y: 100, width: 1000, height: 500 })
  const toClip = (t: number) => (t >= 0 && t <= 10_000 ? t / 1000 : null)

  it('places positions as fractions of the recorded picture', () => {
    const events: CursorEvent[] = [
      { e: 'start', t: 0, hz: 120, screen: { x: 0, y: 0, width: 3000, height: 2000 } },
      { e: 'move', t: 100, x: 700, y: 350 },
      { e: 'move', t: 500, x: 1200, y: 600 },
      // After the window moved, the same screen point is somewhere else on the picture.
      { e: 'move', t: 2500, x: 1200, y: 600 },
      // Off the window: kept, so a zoom knows the pointer had left.
      { e: 'move', t: 3000, x: 100, y: 50 },
    ]
    const track = buildCursorTrack(events, area, toClip)
    expect(track.moves).toEqual([0.1, 0.5, 0.5, 0.5, 1, 1, 2.5, 0.9, 1, 3, -0.2, -0.1])
    expect(track.rate).toBe(30)
    expect(cursorAt(track, 0.05)).toBeNull()
    expect(cursorAt(track, 0.3)).toEqual({ x: 0.5, y: 0.5 })
    expect(cursorAt(track, 2.9)).toEqual({ x: 0.9, y: 1 })
    expect(cursorAt(track, 99)).toEqual({ x: -0.2, y: -0.1 })
  })

  it('keeps clicks with how long the button was held, and thins the path between them', () => {
    const events: CursorEvent[] = []
    // A second of movement sampled 120 times: far more than a zoom needs.
    for (let i = 0; i < 120; i++) events.push({ e: 'move', t: 1000 + (i * 1000) / 120, x: 200 + i * 5, y: 350 })
    events.push({ e: 'down', t: 2100, x: 700, y: 350, button: 'left' }, { e: 'up', t: 2180, x: 700, y: 350, button: 'left' })
    // A drag.
    events.push({ e: 'down', t: 4000, x: 400, y: 200, button: 'left' }, { e: 'move', t: 4500, x: 900, y: 400 }, { e: 'up', t: 5200, x: 900, y: 400, button: 'left' })
    events.push({ e: 'down', t: 6000, x: 800, y: 300, button: 'right' }, { e: 'up', t: 6050, x: 800, y: 300, button: 'right' })
    const track = buildCursorTrack(events, () => ({ x: 200, y: 100, width: 1000, height: 500 }), toClip)
    expect(track.clicks).toEqual([
      { t: 2.1, x: 0.5, y: 0.5, button: 'left', held: 0.08 },
      { t: 4, x: 0.2, y: 0.2, button: 'left', held: 1.2 },
      { t: 6, x: 0.6, y: 0.4, button: 'right', held: 0.05 },
    ])
    // Thirty samples a second at most.
    const moved = track.moves.length / 3
    expect(moved).toBeGreaterThan(25)
    expect(moved).toBeLessThan(45)
    // Times only go forward.
    for (let i = 3; i < track.moves.length; i += 3) expect(track.moves[i]).toBeGreaterThanOrEqual(track.moves[i - 3])
  })

  it('leaves out what happened while paused or before the start', () => {
    const events: CursorEvent[] = [
      { e: 'move', t: -50, x: 700, y: 350 },
      { e: 'down', t: -20, x: 700, y: 350, button: 'left' },
      { e: 'move', t: 500, x: 700, y: 350 },
      { e: 'down', t: 20_000, x: 700, y: 350, button: 'left' },
    ]
    const track = buildCursorTrack(events, area, toClip)
    expect(track.clicks).toEqual([])
    expect(track.moves).toEqual([0.5, 0.5, 0.5])
    // Nowhere to place it (the window was gone): nothing is kept.
    expect(buildCursorTrack(events, () => null, toClip).moves).toEqual([])
  })
})
