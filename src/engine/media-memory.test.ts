import { describe, expect, it, vi } from 'vitest'

// Pictures, faked: each URL decodes (on the next tick) to the size it's given here.
const sizes = new Map<string, [number, number]>()
const made: string[] = []
class FakeImage {
  naturalWidth = 0
  naturalHeight = 0
  crossOrigin = ''
  decoding = ''
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  set src(url: string) {
    made.push(url)
    setTimeout(() => {
      ;[this.naturalWidth, this.naturalHeight] = sizes.get(url) ?? [1, 1]
      this.onload?.()
    }, 0)
  }
}
vi.stubGlobal('Image', FakeImage)
vi.stubGlobal('HTMLImageElement', FakeImage)

const { getImage, holdPictures, playersToRelease } = await import('./media')

const settle = () => new Promise((r) => setTimeout(r, 0))

/** A still of 144 MB decoded: three fit the stills' budget, a fourth pushes one out. */
function big(name: string) {
  const url = `lumen-media://file/${name}.png`
  sizes.set(url, [6000, 6000])
  return url
}

async function load(url: string) {
  getImage(url)
  await settle()
  expect(getImage(url)).toBeInstanceOf(FakeImage)
}

describe('stills', () => {
  it('keep within their budget, letting the least recently drawn go and loading it again when needed', async () => {
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(big)
    await load(a)
    await load(b)
    await load(c)
    // Drawn again, so `b` is now the least recent.
    expect(getImage(a)).toBeInstanceOf(FakeImage)
    await load(d)
    expect(made.filter((u) => u === b)).toHaveLength(1)
    // Gone: asking again loads it afresh (null while it does).
    expect(getImage(b)).toBeNull()
    expect(made.filter((u) => u === b)).toHaveLength(2)
    await settle()
    expect(getImage(a)).toBeInstanceOf(FakeImage)
  })

  it('that an export frame holds stay loaded until it lets them go', async () => {
    const [e, f, g, h] = ['e', 'f', 'g', 'h'].map(big)
    const hold = holdPictures()
    hold.urls.add(e)
    for (const url of [e, f, g, h]) await load(url)
    // `e` is the least recent, but held: `f` went instead.
    expect(getImage(e)).toBeInstanceOf(FakeImage)
    expect(getImage(f)).toBeNull()
    await settle()
    hold.release()
    await load(big('i'))
    await load(big('j'))
    expect(getImage(e)).toBeNull()
  })
})

describe('video players', () => {
  it('lets go of players unused for a while, and of all but the most recent idle ones', () => {
    // Ages are in preview frames drawn.
    const now = 10_000
    const idle = Array.from({ length: 12 }, (_, k) => ({ key: `clip${k}`, used: now - k * 10 }))
    // Eight are kept, the most recently drawn; four older ones go.
    expect(playersToRelease(idle, now)).toEqual(['clip8', 'clip9', 'clip10', 'clip11'])
    // However few there are, one not drawn for 900 frames (half a minute of a 30 fps timeline) goes.
    expect(playersToRelease([{ key: 'recent', used: now - 120 }, { key: 'stale', used: now - 900 }], now)).toEqual(['stale'])
    expect(playersToRelease([], now)).toEqual([])
  })
})
