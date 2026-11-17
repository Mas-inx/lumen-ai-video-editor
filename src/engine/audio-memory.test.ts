import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createClip } from '@/editor/defaults'
import { createEmptyProject, defaultTracks } from '@/editor/new-project'
import type { Asset, Clip } from '@/editor/types'

// The decoder, faked: whole-file decodes finish when a test says (or at once with `auto`); streams open straight away.
const fake = vi.hoisted(() => ({
  pending: new Map<string, () => void>(),
  started: [] as string[],
  running: 0,
  most: 0,
  opened: [] as string[],
  auto: false,
  seconds: new Map<string, number>(),
}))

vi.mock('./decode', () => {
  /** Just enough of an AudioBuffer: its size is what the budget counts. */
  const buffer = (seconds: number) => ({ sampleRate: 48000, numberOfChannels: 2, length: Math.round(seconds * 48000), duration: seconds, getChannelData: () => new Float32Array(0) })
  return {
    decodeAudio: (url: string) => {
      fake.started.push(url)
      fake.running++
      fake.most = Math.max(fake.most, fake.running)
      return new Promise((resolve) => {
        const done = () => {
          fake.running--
          resolve(buffer(fake.seconds.get(url) ?? 1))
        }
        if (fake.auto) queueMicrotask(done)
        else fake.pending.set(url, done)
      })
    },
    openAudioStream: async (url: string) => {
      fake.opened.push(url)
      return { sampleRate: 48000, channels: 2, duration: fake.seconds.get(url) ?? 1, read: async () => null, rest: () => {}, close: () => {} }
    },
    bufferStream: () => null,
  }
})

const { STREAM_OVER_SECONDS, audioSpans, isLongAudio, prefetchAudio, prepareAudio, streamsAudio } = await import('./audio-engine')

let n = 0
function audioAsset(seconds: number): Asset {
  const id = `asset_${++n}`
  const url = `lumen-media://file/${id}.wav`
  fake.seconds.set(url, seconds)
  return { id, name: id, kind: 'audio', duration: seconds, hasAudio: true, source: { type: 'file', url, mime: 'audio/wav', fileName: `${id}.wav`, size: 1 }, addedAt: 0 }
}

const url = (a: Asset) => (a.source.type === 'file' ? a.source.url : '')

function setup() {
  const p = createEmptyProject('Memory')
  const voice = p.tracks.find((t) => t.name === 'Voice')!.id
  /** An audio clip playing `asset` from `start` seconds for `seconds`. */
  const add = (asset: Asset, start: number, seconds = asset.duration ?? 1, extra: Partial<Clip> = {}) => {
    p.assets[asset.id] = asset
    const c = createClip({ kind: 'audio', trackId: voice, start: Math.round(start * 30), duration: Math.round(seconds * 30), assetId: asset.id, ...extra })
    p.clips[c.id] = c
    return c
  }
  return { p, add }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  fake.pending.clear()
  fake.started = []
  fake.opened = []
  fake.running = 0
  fake.most = 0
  fake.auto = false
})

describe('which audio streams', () => {
  it('streams anything longer than a minute, and decodes the rest whole', () => {
    expect(STREAM_OVER_SECONDS).toBe(60)
    expect(streamsAudio(undefined)).toBe(false)
    expect(streamsAudio(12)).toBe(false)
    expect(streamsAudio(60)).toBe(false)
    expect(streamsAudio(60.5)).toBe(true)
    // A four-minute song used to be decoded whole (230 MB at ten minutes); now it streams.
    expect(isLongAudio(audioAsset(4 * 60))).toBe(true)
    expect(isLongAudio(audioAsset(45))).toBe(false)
    expect(isLongAudio(undefined)).toBe(false)
  })
})

describe('getting sound ready', () => {
  it('decodes short files nearest the playhead first, never more than three at once, and only opens long ones nearby', async () => {
    const { p, add } = setup()
    const short = Array.from({ length: 8 }, (_, i) => {
      const a = audioAsset(30)
      add(a, i * 40)
      return a
    })
    const near = audioAsset(5 * 60)
    add(near, 10)
    const far = audioAsset(5 * 60)
    add(far, 400)
    // The playhead at 85 s: inside the clip at 80 s, then the ones at 40, 120, 0, 160…
    prefetchAudio(p, 85)
    expect(fake.started).toEqual([url(short[2]), url(short[1]), url(short[3])])
    await settle()
    expect(fake.opened).toEqual([url(near)])
    while (fake.pending.size) {
      const [first] = fake.pending.keys()
      fake.pending.get(first)!()
      fake.pending.delete(first)
      await settle()
    }
    expect(fake.started).toEqual([2, 1, 3, 0, 4, 5, 6, 7].map((i) => url(short[i])))
    expect(fake.most).toBe(3)
    // Long files are never decoded whole.
    expect(fake.started).not.toContain(url(near))
    expect(fake.started).not.toContain(url(far))
  })

  it('prepares an export’s short files in timeline order as far as the budget goes, and never decodes long ones', async () => {
    fake.auto = true
    const { p, add } = setup()
    // Twenty minute-long files: 23 MB each decoded, three quarters of the budget holds 17 of them.
    const files = Array.from({ length: 20 }, () => audioAsset(60))
    files.forEach((a, i) => add(a, (19 - i) * 61))
    const long = audioAsset(20 * 60)
    add(long, 0)
    const progress: [number, number][] = []
    await prepareAudio(p, (done, total) => progress.push([done, total]))
    const inOrder = [...files].reverse()
    expect(fake.started).toEqual(inOrder.slice(0, 17).map(url))
    expect(progress.at(-1)).toEqual([17, 17])
    expect(fake.started).not.toContain(url(long))
  })
})

describe('audioSpans', () => {
  it('maps clips inside a nested timeline onto the timeline being played', () => {
    const { p, add } = setup()
    const top = add(audioAsset(10), 0, 2)
    const inner = defaultTracks()
    const voice = inner.find((t) => t.name === 'Voice')!.id
    const a = audioAsset(30)
    p.assets[a.id] = a
    const leaf = createClip({ kind: 'audio', trackId: voice, start: 0, duration: 90, assetId: a.id })
    p.sequences = { seq_b: { id: 'seq_b', name: 'B', settings: p.settings, tracks: inner, clips: { [leaf.id]: leaf }, markers: [], createdAt: 0 } }
    const main = p.tracks.find((t) => t.name === 'Main')!.id
    // Plays the nested timeline from its second 1, starting at 100 frames, for two seconds.
    const nest = createClip({ kind: 'video', trackId: main, start: 100, duration: 60, inPoint: 30, sequenceId: 'seq_b' })
    p.clips[nest.id] = nest
    const spans = audioSpans(p)
    expect(spans.map((s) => s.clip.id).sort()).toEqual([leaf.id, top.id].sort())
    const s = spans.find((x) => x.clip.id === leaf.id)!
    // The leaf's 0–3 s lands at (100 - 30) / 30 = 2.33 s on, cut to where the nested clip plays (3.33–5.33 s).
    expect(s.offset).toBeCloseTo(70 / 30, 6)
    expect(s.from).toBeCloseTo(100 / 30, 6)
    expect(s.to).toBeCloseTo(160 / 30, 6)
  })
})
