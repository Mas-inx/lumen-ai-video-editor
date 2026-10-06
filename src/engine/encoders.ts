/**
 * Choosing a video encoder that really works on this computer.
 *
 * Graphics cards differ: an integrated Intel chip, an NVIDIA card and an AMD
 * card each bring their own encoders, with their own limits on size, frame
 * rate and codec — and a driver can say yes to settings and then fail on the
 * first frame. So before an export, the encoder is tried for real with a few
 * frames at the export's size, and there is always somewhere to go next: the
 * same codec on the processor, then another codec the file type can carry.
 * An encoder that fails mid-export is remembered and the export starts again
 * on the next one.
 */
import { codecString } from './codec-strings'

export type ExportVideoCodec = 'avc' | 'hevc' | 'av1' | 'vp9'
export type VideoContainer = 'mp4' | 'mov' | 'webm'
export type Acceleration = 'prefer-hardware' | 'prefer-software'

/** Video codecs each container can carry, best first. */
export const CODECS_FOR: Record<VideoContainer, ExportVideoCodec[]> = {
  mp4: ['avc', 'hevc', 'av1'],
  mov: ['avc', 'hevc'],
  webm: ['vp9', 'av1'],
}

/** Codecs Chromium can encode on the processor. HEVC only exists on graphics cards. */
export const HAS_SOFTWARE: Record<ExportVideoCodec, boolean> = { avc: true, vp9: true, av1: true, hevc: false }

export const CODEC_NAME: Record<ExportVideoCodec, string> = { avc: 'H.264', hevc: 'HEVC', av1: 'AV1', vp9: 'VP9' }

const EFFICIENCY: Record<ExportVideoCodec, number> = { avc: 1, hevc: 0.62, vp9: 0.68, av1: 0.5 }

/** Target bitrate (bits/s) for a size, frame rate, codec and quality (10..100). */
export function videoBitrate(width: number, height: number, fps: number, codec: ExportVideoCodec, quality: number) {
  const pixels = width * height
  const base = 12_000_000 * (pixels / 2_073_600) * Math.pow(fps / 30, 0.75)
  const q = 0.35 + (Math.max(10, Math.min(100, quality)) / 100) * 1.25
  return Math.round(base * EFFICIENCY[codec] * q)
}

export interface EncoderPlan {
  codec: ExportVideoCodec
  acceleration: Acceleration
  /** The full codec string, at the level this size and frame rate need. */
  codecString: string
  bitrate: number
}

export interface EncoderAttempt {
  codec: ExportVideoCodec
  acceleration: Acceleration
  ok: boolean
  error?: string
}

export interface EncoderRequest {
  codec: ExportVideoCodec
  container: VideoContainer
  width: number
  height: number
  fps: number
  /** 10..100 */
  quality: number
  /** Try the graphics card's encoder first. */
  hardware: boolean
  /** Only this codec will do (transparency needs VP9). */
  lockCodec?: boolean
}

export const describeEncoder = (p: Pick<EncoderPlan, 'codec' | 'acceleration'>) => `${CODEC_NAME[p.codec]} on the ${p.acceleration === 'prefer-hardware' ? 'graphics card' : 'processor'}`

/**
 * Encoders to try, in order: the codec asked for (on the graphics card first if
 * wanted, else the processor first), then the other codecs the container
 * carries — H.264 before the rest, since everything plays it.
 */
export function encoderCandidates(req: Pick<EncoderRequest, 'codec' | 'container' | 'hardware' | 'lockCodec'>): { codec: ExportVideoCodec; acceleration: Acceleration }[] {
  const out: { codec: ExportVideoCodec; acceleration: Acceleration }[] = []
  const add = (codec: ExportVideoCodec, hardwareFirst: boolean) => {
    const order: Acceleration[] = hardwareFirst ? ['prefer-hardware', 'prefer-software'] : ['prefer-software', 'prefer-hardware']
    for (const acceleration of order) if (acceleration === 'prefer-hardware' || HAS_SOFTWARE[codec]) out.push({ codec, acceleration })
  }
  add(req.codec, req.hardware)
  if (!req.lockCodec) for (const other of CODECS_FOR[req.container]) if (other !== req.codec) add(other, req.hardware)
  return out
}

function encoderConfig(plan: EncoderPlan, width: number, height: number, fps: number): VideoEncoderConfig {
  return {
    codec: plan.codecString,
    width,
    height,
    bitrate: plan.bitrate,
    bitrateMode: 'variable',
    framerate: fps,
    latencyMode: 'quality',
    hardwareAcceleration: plan.acceleration,
    ...(plan.codec === 'avc' ? { avc: { format: 'avc' as const } } : {}),
    ...(plan.codec === 'hevc' ? { hevc: { format: 'hevc' } } : {}),
  } as VideoEncoderConfig
}

interface TestResult {
  ok: boolean
  error?: string
  at: number
}

/** What each encoder did when last tried this session. */
const tested = new Map<string, TestResult | Promise<TestResult>>()
/** A pass is trusted this long; drivers can be reset while the app runs. */
const TRUST_MS = 10 * 60_000

const key = (p: Pick<EncoderPlan, 'codec' | 'acceleration'>, width: number, height: number, fps: number) => `${p.codec}|${p.acceleration}|${width}x${height}@${fps}`

const TEST_FRAMES = 3

/** Encodes a few real frames at the real size. Drivers that accept settings and then fail are caught here. */
async function tryEncoder(plan: EncoderPlan, width: number, height: number, fps: number): Promise<TestResult> {
  const fail = (error: string): TestResult => ({ ok: false, error, at: Date.now() })
  if (typeof VideoEncoder === 'undefined') return fail('This build has no video encoder.')
  const config = encoderConfig(plan, width, height, fps)
  const support = await VideoEncoder.isConfigSupported(config).catch(() => null)
  if (!support?.supported) return fail(plan.acceleration === 'prefer-hardware' ? 'No graphics-card encoder takes these settings.' : 'Not available at this size.')
  let chunks = 0
  let error: string | null = null
  const encoder = new VideoEncoder({ output: () => void chunks++, error: (e) => void (error ??= e.message || 'The encoder failed.') })
  try {
    encoder.configure(config)
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')!
    for (let i = 0; i < TEST_FRAMES && !error; i++) {
      // Something that moves, so every kind of frame gets encoded.
      const gradient = ctx.createLinearGradient(0, 0, width, height)
      gradient.addColorStop(0, `hsl(${i * 70} 70% 45%)`)
      gradient.addColorStop(1, `hsl(${i * 70 + 140} 60% 20%)`)
      ctx.fillStyle = gradient
      ctx.fillRect(0, 0, width, height)
      ctx.fillStyle = '#fff'
      ctx.fillRect((width * (i + 1)) / 6, height / 3, width / 5, height / 4)
      const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) })
      try {
        encoder.encode(frame, { keyFrame: i === 0 })
      } finally {
        frame.close()
      }
    }
    // An encoder that never answers is as useless as one that fails.
    const flushed = await Promise.race([encoder.flush().then(() => true), new Promise<false>((resolve) => setTimeout(() => resolve(false), 15_000))])
    if (!flushed) error ??= 'The encoder never finished a frame.'
  } catch (err) {
    error ??= err instanceof Error ? err.message : String(err)
  } finally {
    try {
      if (encoder.state !== 'closed') encoder.close()
    } catch {
      /* closed by its own error */
    }
  }
  if (error) return fail(error)
  if (!chunks) return fail('The encoder produced nothing.')
  return { ok: true, at: Date.now() }
}

export function planFor(codec: ExportVideoCodec, acceleration: Acceleration, width: number, height: number, fps: number, quality: number): EncoderPlan {
  const bitrate = videoBitrate(width, height, fps, codec, quality)
  return { codec, acceleration, bitrate, codecString: codecString(codec, width, height, fps, bitrate) }
}

/** Whether an encoder works here at this size (tried for real; remembered for the session). */
export async function testEncoder(plan: EncoderPlan, width: number, height: number, fps: number): Promise<{ ok: boolean; error?: string }> {
  const k = key(plan, width, height, fps)
  const hit = tested.get(k)
  if (hit) {
    const known = await hit
    // Failures stay failed for the session; passes are checked again now and then.
    if (!known.ok || Date.now() - known.at < TRUST_MS) return known
  }
  const run = tryEncoder(plan, width, height, fps)
  tested.set(k, run)
  const result = await run
  tested.set(k, result)
  return result
}

/**
 * One codec at a bitrate of the caller's choosing (render previews, proxies):
 * the graphics card's encoder if it works at this size, else the processor's, else null.
 */
export async function workingEncoder(codec: ExportVideoCodec, width: number, height: number, fps: number, bitrate: number, skip?: Acceleration): Promise<EncoderPlan | null> {
  for (const acceleration of ['prefer-hardware', 'prefer-software'] as const) {
    if (acceleration === skip || (acceleration === 'prefer-software' && !HAS_SOFTWARE[codec])) continue
    const plan: EncoderPlan = { codec, acceleration, bitrate, codecString: codecString(codec, width, height, fps, bitrate) }
    if ((await testEncoder(plan, width, height, fps)).ok) return plan
  }
  return null
}

/** An encoder that passed its test failed in a real export: don't choose it again this session. */
export function markEncoderFailed(plan: Pick<EncoderPlan, 'codec' | 'acceleration'>, width: number, height: number, fps: number, error: string) {
  tested.set(key(plan, width, height, fps), { ok: false, error, at: Date.now() })
}

/** Takes back a failure mark: what went wrong turned out not to be this encoder's doing. */
export function clearEncoderTest(plan: Pick<EncoderPlan, 'codec' | 'acceleration'>, width: number, height: number, fps: number) {
  tested.delete(key(plan, width, height, fps))
}

export function forgetEncoderTests() {
  tested.clear()
}

export interface EncoderChoice {
  /** The first encoder that works, or null when none does. */
  plan: EncoderPlan | null
  attempts: EncoderAttempt[]
}

/** The first working encoder for a request, with what was tried on the way. */
export async function chooseEncoder(req: EncoderRequest): Promise<EncoderChoice> {
  const attempts: EncoderAttempt[] = []
  for (const candidate of encoderCandidates(req)) {
    const plan = planFor(candidate.codec, candidate.acceleration, req.width, req.height, req.fps, req.quality)
    const result = await testEncoder(plan, req.width, req.height, req.fps)
    attempts.push({ ...candidate, ok: result.ok, error: result.error })
    if (result.ok) return { plan, attempts }
  }
  return { plan: null, attempts }
}

/** Why the encoder that was asked for isn't the one being used, in a sentence — or undefined when it is. */
export function fallbackNote(req: Pick<EncoderRequest, 'codec' | 'hardware'>, plan: EncoderPlan): string | undefined {
  if (plan.codec !== req.codec) return `${CODEC_NAME[req.codec]} couldn’t be encoded on this computer at this size, so this is ${describeEncoder(plan)}.`
  if (req.hardware && plan.acceleration === 'prefer-software') return `The graphics card couldn’t encode this, so the processor did (${CODEC_NAME[plan.codec]}).`
  if (!req.hardware && plan.acceleration === 'prefer-hardware') return `${CODEC_NAME[plan.codec]} is only encoded by graphics cards, so the graphics card did it.`
  return undefined
}

export interface CodecAvailability {
  hardware: boolean
  software: boolean
}

/** A quick look (no test encode) at which encoders say they take a size: for showing choices, not for trusting them. */
export async function encoderSupport(width: number, height: number, fps: number, quality = 70): Promise<Record<ExportVideoCodec, CodecAvailability>> {
  const out = {} as Record<ExportVideoCodec, CodecAvailability>
  await Promise.all(
    (['avc', 'hevc', 'av1', 'vp9'] as const).map(async (codec) => {
      const check = async (acceleration: Acceleration) => {
        if (typeof VideoEncoder === 'undefined') return false
        if (acceleration === 'prefer-software' && !HAS_SOFTWARE[codec]) return false
        const plan = planFor(codec, acceleration, width, height, fps, quality)
        const known = tested.get(key(plan, width, height, fps))
        // An encoder already seen failing here isn't offered.
        if (known && !(known instanceof Promise) && !known.ok) return false
        return (await VideoEncoder.isConfigSupported(encoderConfig(plan, width, height, fps)).catch(() => null))?.supported === true
      }
      const [hardware, software] = await Promise.all([check('prefer-hardware'), check('prefer-software')])
      out[codec] = { hardware, software }
    }),
  )
  return out
}
