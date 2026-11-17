import { beforeEach, describe, expect, it, vi } from 'vitest'

/** Just enough of an AudioBuffer, counting how many decode.ts makes (the pieces below are made by the fake sink). */
class FakeAudioBuffer {
  static made = 0
  readonly length: number
  readonly numberOfChannels: number
  readonly sampleRate: number
  private data: Float32Array[]
  constructor(opts: { length: number; numberOfChannels: number; sampleRate: number }, piece = false) {
    if (!piece) FakeAudioBuffer.made++
    this.length = opts.length
    this.numberOfChannels = opts.numberOfChannels
    this.sampleRate = opts.sampleRate
    this.data = Array.from({ length: opts.numberOfChannels }, () => new Float32Array(opts.length))
  }
  get duration() {
    return this.length / this.sampleRate
  }
  getChannelData(c: number) {
    return this.data[c]
  }
  copyToChannel(src: Float32Array, c: number, at = 0) {
    this.data[c].set(src.subarray(0, Math.max(0, Math.min(src.length, this.length - at))), at)
  }
}
vi.stubGlobal('AudioBuffer', FakeAudioBuffer)

const RATE = 48000
const PIECE = 1024

// A file, faked: pieces of 1024 samples whose value is their index (+1), from `first` (negative: encoder priming).
const file = vi.hoisted(() => ({ pieces: 0, first: 0, duration: 0 as number | null, inputs: 0, disposed: 0 }))

vi.mock('mediabunny', () => {
  const piece = (i: number) => {
    const b = new FakeAudioBuffer({ length: PIECE, numberOfChannels: 2, sampleRate: RATE }, true)
    b.getChannelData(0).fill(i + 1)
    b.getChannelData(1).fill(-(i + 1))
    return { buffer: b, timestamp: (file.first + i * PIECE) / RATE, duration: PIECE / RATE }
  }
  const track = {
    sampleRate: RATE,
    numberOfChannels: 2,
    canDecode: async () => true,
    computeDuration: async () => {
      if (file.duration === null) throw new Error('no duration')
      return file.duration
    },
  }
  class AudioBufferSink {
    async *buffers(from = -Infinity, to = Infinity) {
      for (let i = 0; i < file.pieces; i++) {
        const p = piece(i)
        if (p.timestamp + p.duration > from && p.timestamp < to) yield p
      }
    }
  }
  class Input {
    constructor() {
      file.inputs++
    }
    getPrimaryAudioTrack = async () => track
    dispose() {
      file.disposed++
    }
  }
  return { ALL_FORMATS: [], AudioBufferSink, CanvasSink: class {}, EncodedPacketSink: class {}, Input, UrlSource: class {} }
})

const { decodeAudio, openAudioStream } = await import('./decode')

beforeEach(() => {
  FakeAudioBuffer.made = 0
  Object.assign(file, { pieces: 0, first: 0, duration: 0, inputs: 0, disposed: 0 })
})

describe('decoding a file whole', () => {
  it('fills one buffer as pieces arrive, leaving out the priming before 0', async () => {
    Object.assign(file, { pieces: 10, first: -PIECE, duration: (9 * PIECE) / RATE })
    const out = (await decodeAudio('lumen-media://file/a.m4a'))!
    expect(FakeAudioBuffer.made).toBe(1)
    expect(out.length).toBe(9 * PIECE)
    // Piece 1 (the first after the priming) starts the buffer; piece 9 ends it.
    expect(out.getChannelData(0)[0]).toBe(2)
    expect(out.getChannelData(1)[9 * PIECE - 1]).toBe(-10)
    expect(file.disposed).toBe(file.inputs)
  })

  it('grows when the file holds more than its track said, and ends up exactly as long as the sound', async () => {
    Object.assign(file, { pieces: 40, duration: (10 * PIECE) / RATE })
    const out = (await decodeAudio('lumen-media://file/b.wav'))!
    expect(out.length).toBe(40 * PIECE)
    expect(out.getChannelData(0)[40 * PIECE - 1]).toBe(40)
  })

  it('copes with a track that can’t say how long it is', async () => {
    Object.assign(file, { pieces: 600, duration: null })
    const out = (await decodeAudio('lumen-media://file/c.mp3'))!
    expect(out.length).toBe(600 * PIECE)
    expect(out.getChannelData(0)[300 * PIECE]).toBe(301)
  })

  it('cuts off more than a moment of silence when the track said too much, and keeps a moment', async () => {
    Object.assign(file, { pieces: 100, duration: (100 * PIECE) / RATE + 1 })
    expect((await decodeAudio('lumen-media://file/d.flac'))!.length).toBe(100 * PIECE)
    Object.assign(file, { duration: (100 * PIECE + 100) / RATE })
    expect((await decodeAudio('lumen-media://file/d.flac'))!.length).toBe(100 * PIECE + 100)
  })
})

describe('streaming a file', () => {
  it('lets go of its reader while it rests and opens it again to read, until it is closed', async () => {
    Object.assign(file, { pieces: 200, duration: (200 * PIECE) / RATE })
    const stream = (await openAudioStream('lumen-media://file/e.m4a'))!
    expect(stream.duration).toBeCloseTo((200 * PIECE) / RATE)
    const first = (await stream.read(PIECE / RATE, (3 * PIECE) / RATE))!
    expect(first.length).toBe(2 * PIECE)
    expect(first.getChannelData(0)[0]).toBe(2)
    expect(file.inputs).toBe(1)
    stream.rest()
    stream.rest()
    const again = (await stream.read((100 * PIECE) / RATE, (101 * PIECE) / RATE))!
    expect(again.getChannelData(1)[0]).toBe(-101)
    expect(file.inputs).toBe(2)
    expect(file.disposed).toBe(1)
    stream.close()
    expect(await stream.read(0, 1)).toBeNull()
    expect(file.disposed).toBe(2)
    expect(file.inputs).toBe(2)
  })
})
