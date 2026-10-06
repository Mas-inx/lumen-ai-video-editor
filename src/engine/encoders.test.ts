import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A stand-in graphics stack: which encoders say they take a config, and which
 * then really work. Real drivers lie in exactly this way.
 */
const gpu = {
  /** `${codec family}|${acceleration}` that isConfigSupported says yes to. */
  claims: new Set<string>(),
  /** Of those, the ones that fail once frames arrive. */
  broken: new Set<string>(),
  /** Ones that never answer. */
  hung: new Set<string>(),
  configured: [] as string[],
}

const family = (codec: string) => (codec.startsWith('avc') ? 'avc' : codec.startsWith('hev') ? 'hevc' : codec.startsWith('av01') ? 'av1' : 'vp9')
const id = (config: { codec: string; hardwareAcceleration?: string }) => `${family(config.codec)}|${config.hardwareAcceleration}`

class FakeEncoder {
  static isConfigSupported = async (config: { codec: string; hardwareAcceleration?: string }) => ({ supported: gpu.claims.has(id(config)) })
  state = 'unconfigured'
  private key = ''
  constructor(private init: { output: () => void; error: (e: Error) => void }) {}
  configure(config: { codec: string; hardwareAcceleration?: string }) {
    this.key = id(config)
    this.state = 'configured'
    gpu.configured.push(`${config.codec}|${config.hardwareAcceleration}`)
  }
  encode() {
    if (gpu.broken.has(this.key)) queueMicrotask(() => this.init.error(new Error('Encoder initialization failed')))
    else if (!gpu.hung.has(this.key)) this.init.output()
  }
  flush() {
    return gpu.hung.has(this.key) ? new Promise<void>(() => {}) : Promise.resolve()
  }
  close() {
    this.state = 'closed'
  }
}

vi.stubGlobal('VideoEncoder', FakeEncoder)
vi.stubGlobal(
  'VideoFrame',
  class {
    close() {}
  },
)
vi.stubGlobal(
  'OffscreenCanvas',
  class {
    getContext() {
      return { createLinearGradient: () => ({ addColorStop() {} }), fillRect() {}, fillStyle: '' }
    }
  },
)

const { chooseEncoder, encoderCandidates, encoderSupport, fallbackNote, forgetEncoderTests, markEncoderFailed, planFor, videoBitrate, workingEncoder } = await import('./encoders')

const UHD60 = { width: 3840, height: 2160, fps: 60, quality: 72 }

beforeEach(() => {
  gpu.claims = new Set(['avc|prefer-hardware', 'avc|prefer-software', 'hevc|prefer-hardware', 'av1|prefer-hardware', 'av1|prefer-software', 'vp9|prefer-hardware', 'vp9|prefer-software'])
  gpu.broken.clear()
  gpu.hung.clear()
  gpu.configured.length = 0
  forgetEncoderTests()
})

describe('choosing an encoder', () => {
  it('tries the codec asked for first, then what else the file can carry', () => {
    const order = (req: Parameters<typeof encoderCandidates>[0]) => encoderCandidates(req).map((c) => `${c.codec} ${c.acceleration === 'prefer-hardware' ? 'gpu' : 'cpu'}`)
    expect(order({ codec: 'avc', container: 'mp4', hardware: true })).toEqual(['avc gpu', 'avc cpu', 'hevc gpu', 'av1 gpu', 'av1 cpu'])
    expect(order({ codec: 'hevc', container: 'mp4', hardware: true })).toEqual(['hevc gpu', 'avc gpu', 'avc cpu', 'av1 gpu', 'av1 cpu'])
    // Asked for the processor: it goes first, and HEVC (graphics cards only) still gets its one encoder.
    expect(order({ codec: 'avc', container: 'mov', hardware: false })).toEqual(['avc cpu', 'avc gpu', 'hevc gpu'])
    expect(order({ codec: 'hevc', container: 'mov', hardware: false })).toEqual(['hevc gpu', 'avc cpu', 'avc gpu'])
    // Transparency needs VP9: nothing else will do.
    expect(order({ codec: 'vp9', container: 'webm', hardware: true, lockCodec: true })).toEqual(['vp9 gpu', 'vp9 cpu'])
  })

  it('uses the graphics card when it works, with the level 4K at 60 needs', async () => {
    const { plan, attempts } = await chooseEncoder({ codec: 'avc', container: 'mp4', hardware: true, ...UHD60 })
    expect(plan).toMatchObject({ codec: 'avc', acceleration: 'prefer-hardware', codecString: 'avc1.640034' })
    expect(attempts).toEqual([{ codec: 'avc', acceleration: 'prefer-hardware', ok: true, error: undefined }])
    expect(fallbackNote({ codec: 'avc', hardware: true }, plan!)).toBeUndefined()
  })

  it('falls back to the processor when the card says yes and then fails', async () => {
    gpu.broken.add('avc|prefer-hardware')
    const req = { codec: 'avc' as const, container: 'mp4' as const, hardware: true, ...UHD60 }
    const { plan, attempts } = await chooseEncoder(req)
    expect(plan).toMatchObject({ codec: 'avc', acceleration: 'prefer-software' })
    expect(attempts.map((a) => a.ok)).toEqual([false, true])
    expect(attempts[0].error).toBe('Encoder initialization failed')
    expect(fallbackNote(req, plan!)).toContain('processor')

    // The failure is remembered: the broken encoder isn't set up again.
    gpu.configured.length = 0
    await chooseEncoder(req)
    expect(gpu.configured).toEqual([])
  })

  it('falls back to the processor when there is no card encoder at all (an old or blocked driver)', async () => {
    gpu.claims = new Set(['avc|prefer-software', 'vp9|prefer-software', 'av1|prefer-software'])
    const { plan } = await chooseEncoder({ codec: 'avc', container: 'mp4', hardware: true, ...UHD60 })
    expect(plan).toMatchObject({ codec: 'avc', acceleration: 'prefer-software' })
  })

  it('moves to H.264 when HEVC has no working encoder', async () => {
    gpu.broken.add('hevc|prefer-hardware')
    const req = { codec: 'hevc' as const, container: 'mp4' as const, hardware: true, ...UHD60 }
    const { plan } = await chooseEncoder(req)
    expect(plan).toMatchObject({ codec: 'avc', acceleration: 'prefer-hardware' })
    expect(fallbackNote(req, plan!)).toContain('HEVC')
  })

  it('gives up on an encoder that never answers', async () => {
    vi.useFakeTimers()
    try {
      gpu.hung.add('avc|prefer-hardware')
      const choosing = chooseEncoder({ codec: 'avc', container: 'mp4', hardware: true, ...UHD60 })
      await vi.advanceTimersByTimeAsync(16_000)
      const { plan, attempts } = await choosing
      expect(attempts[0]).toMatchObject({ ok: false, error: 'The encoder never finished a frame.' })
      expect(plan).toMatchObject({ acceleration: 'prefer-software' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('says so when nothing can encode it', async () => {
    gpu.claims.clear()
    const { plan, attempts } = await chooseEncoder({ codec: 'avc', container: 'mp4', hardware: true, ...UHD60 })
    expect(plan).toBeNull()
    expect(attempts).toHaveLength(5)
    expect(attempts.every((a) => !a.ok && a.error)).toBe(true)
  })

  it('stops offering an encoder that failed in a real export', async () => {
    const req = { codec: 'avc' as const, container: 'mp4' as const, hardware: true, ...UHD60 }
    const first = (await chooseEncoder(req)).plan!
    expect(first.acceleration).toBe('prefer-hardware')
    markEncoderFailed(first, 3840, 2160, 60, 'Device lost')
    expect((await chooseEncoder(req)).plan).toMatchObject({ acceleration: 'prefer-software' })
    expect((await encoderSupport(3840, 2160, 60)).avc).toEqual({ hardware: false, software: true })
    // At another size it is still worth trying.
    expect((await chooseEncoder({ ...req, width: 1920, height: 1080 })).plan).toMatchObject({ acceleration: 'prefer-hardware' })
  })

  it('picks a working encoder for previews and proxies, skipping one on request', async () => {
    expect(await workingEncoder('avc', 1920, 1080, 30, 20e6)).toMatchObject({ acceleration: 'prefer-hardware', bitrate: 20e6, codecString: 'avc1.640028' })
    expect(await workingEncoder('avc', 1920, 1080, 30, 20e6, 'prefer-hardware')).toMatchObject({ acceleration: 'prefer-software' })
    // Another computer, with no H.264 encoder at all.
    forgetEncoderTests()
    gpu.claims = new Set(['hevc|prefer-hardware'])
    expect(await workingEncoder('avc', 1920, 1080, 30, 20e6)).toBeNull()
  })

  it('reports what each codec has without encoding anything', async () => {
    gpu.claims = new Set(['avc|prefer-software', 'hevc|prefer-hardware'])
    const support = await encoderSupport(1920, 1080, 30)
    expect(support).toEqual({ avc: { hardware: false, software: true }, hevc: { hardware: true, software: false }, av1: { hardware: false, software: false }, vp9: { hardware: false, software: false } })
    expect(gpu.configured).toEqual([])
  })

  it('asks for more bits for bigger, faster, better video', () => {
    const base = videoBitrate(1920, 1080, 30, 'avc', 72)
    expect(videoBitrate(3840, 2160, 30, 'avc', 72)).toBeGreaterThan(base * 3)
    expect(videoBitrate(1920, 1080, 60, 'avc', 72)).toBeGreaterThan(base)
    expect(videoBitrate(1920, 1080, 30, 'avc', 95)).toBeGreaterThan(base)
    expect(videoBitrate(1920, 1080, 30, 'hevc', 72)).toBeLessThan(base)
    expect(planFor('hevc', 'prefer-hardware', 3840, 2160, 60, 72).codecString).toMatch(/^hev1\.1\.6\.[LH]153\.B0$/)
  })
})
