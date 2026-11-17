import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClip } from '@/editor/defaults'
import { createEmptyProject } from '@/editor/new-project'
import type { Asset } from '@/editor/types'

// Web Audio, faked: nodes remember their connections, sources when they were started.
class FakeParam {
  value = 1
  setValueAtTime(v: number) {
    this.value = v
  }
  setValueCurveAtTime() {}
  setTargetAtTime() {}
}
class FakeNode {
  connected = 0
  disconnected = false
  connect<T>(n: T) {
    this.connected++
    return n
  }
  disconnect() {
    this.disconnected = true
  }
}
class FakeSource extends FakeNode {
  buffer: unknown = null
  playbackRate = new FakeParam()
  onended: (() => void) | null = null
  started: number[] | null = null
  start(...args: number[]) {
    this.started = args
  }
  stop() {}
}
const param = () => new FakeParam()
class FakeContext {
  static last: FakeContext
  currentTime = 0
  state = 'running'
  destination = new FakeNode()
  sources: FakeSource[] = []
  constructor() {
    FakeContext.last = this
  }
  resume = async () => {}
  createGain = () => Object.assign(new FakeNode(), { gain: param(), channelCount: 2, channelCountMode: '', channelInterpretation: '' })
  createBufferSource = () => {
    const s = new FakeSource()
    this.sources.push(s)
    return s
  }
  createBiquadFilter = () => Object.assign(new FakeNode(), { type: '', frequency: param(), Q: param(), gain: param() })
  createDynamicsCompressor = () => Object.assign(new FakeNode(), { threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(), reduction: 0 })
  createChannelSplitter = () => new FakeNode()
  createChannelMerger = () => new FakeNode()
  createAnalyser = () => Object.assign(new FakeNode(), { fftSize: 0, smoothingTimeConstant: 0, getFloatTimeDomainData() {} })
}
class FakeAudioBuffer {
  constructor(readonly length: number) {}
  readonly sampleRate = 48000
  readonly numberOfChannels = 2
  get duration() {
    return this.length / 48000
  }
  getChannelData() {
    return new Float32Array(0)
  }
}
vi.stubGlobal('AudioContext', FakeContext)
vi.stubGlobal('AudioBuffer', FakeAudioBuffer)

// The decoder, faked: whole files and streamed stretches come back at once (as silence of the right length).
const reads = vi.hoisted(() => ({ list: [] as [number, number][] }))
vi.mock('./decode', () => ({
  decodeAudio: async (url: string) => new (globalThis as unknown as { AudioBuffer: typeof FakeAudioBuffer }).AudioBuffer(Number(/(\d+)s/.exec(url)![1]) * 48000),
  openAudioStream: async () => ({
    sampleRate: 48000,
    channels: 2,
    duration: 300,
    read: async (from: number, to: number) => {
      reads.list.push([from, to])
      return new (globalThis as unknown as { AudioBuffer: typeof FakeAudioBuffer }).AudioBuffer(Math.round((to - from) * 48000))
    },
    rest: () => {},
    close: () => {},
  }),
  bufferStream: () => null,
}))

const { audioEngine, loadAudio } = await import('./audio-engine')

let n = 0
function audioAsset(seconds: number): Asset {
  const id = `asset_${++n}`
  return { id, name: id, kind: 'audio', duration: seconds, hasAudio: true, source: { type: 'file', url: `lumen-media://file/${id}-${seconds}s.wav`, mime: 'audio/wav', fileName: `${id}.wav`, size: 1 }, addedAt: 0 }
}

function project(clips: { asset: Asset; start: number; seconds: number }[]) {
  const p = createEmptyProject('Playback')
  const voice = p.tracks.find((t) => t.name === 'Voice')!.id
  const music = p.tracks.find((t) => t.name === 'Music')!.id
  for (const { asset, start, seconds } of clips) {
    p.assets[asset.id] = asset
    const c = createClip({ kind: 'audio', trackId: (asset.duration ?? 0) > 60 ? music : voice, start: start * 30, duration: seconds * 30, assetId: asset.id })
    p.clips[c.id] = c
  }
  return p
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers()
  reads.list = []
})
afterEach(() => {
  audioEngine.stop()
  vi.useRealTimers()
})

describe('live playback', () => {
  it('only gives sound about to play its nodes, schedules the rest as the playhead nears, and lets finished sources go', async () => {
    const assets = Array.from({ length: 30 }, () => audioAsset(5))
    const p = project(assets.map((asset, i) => ({ asset, start: i * 5, seconds: 5 })))
    await Promise.all(assets.map((a) => loadAudio(a)))
    audioEngine.start(p, 0)
    const ctx = FakeContext.last
    // Within twelve seconds of the playhead: the clips at 0, 5 and 10 s.
    expect(ctx.sources).toHaveLength(3)
    expect(ctx.sources.map((s) => s.started![0])).toEqual([0.04, 5.04, 10.04])
    ctx.currentTime = 20
    await vi.advanceTimersByTimeAsync(500)
    expect(ctx.sources).toHaveLength(7)
    // Placed exactly on the clock they were scheduled against.
    expect(ctx.sources[6].started![0]).toBeCloseTo(30.04, 9)
    const [first] = ctx.sources
    first.onended!()
    expect(first.disconnected).toBe(false)
    await vi.advanceTimersByTimeAsync(300)
    expect(first.disconnected).toBe(true)
  })

  it('reads long recordings a chunk at a time, lets played chunks go, and starts on a cued chunk without reading it again', async () => {
    const song = audioAsset(300)
    const p = project([{ asset: song, start: 0, seconds: 300 }])
    audioEngine.start(p, 0)
    await flush()
    const ctx = FakeContext.last
    const firstReads = reads.list.length
    expect(firstReads).toBe(2)
    const chunk = ctx.sources.at(-2)!
    chunk.onended!()
    await vi.advanceTimersByTimeAsync(300)
    expect(chunk.disconnected).toBe(true)
    audioEngine.stop()
    // Resting at 30 s: its first stretch is decoded now…
    audioEngine.cue(p, 30)
    await flush()
    expect(reads.list).toHaveLength(firstReads + 1)
    const cued = reads.list.at(-1)!
    // …and pressing play there uses it.
    audioEngine.start(p, 30)
    await flush()
    const after = reads.list.slice(firstReads + 1)
    expect(after.some(([a, b]) => a === cued[0] && b === cued[1])).toBe(false)
    expect(ctx.sources.at(-1)!.started).not.toBeNull()
  })
})
