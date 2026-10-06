/**
 * Export: renders every frame through the same compositor as the preview, with
 * frame-exact video decoding, mixes the audio with the same engine as playback,
 * encodes with WebCodecs (hardware when available) and streams the file to disk.
 */
import {
  AudioBufferSource,
  canEncodeAudio,
  CanvasSource,
  Mp4OutputFormat,
  MovOutputFormat,
  Output,
  StreamTarget,
  WebMOutputFormat,
  type AudioCodec,
  type StreamTargetChunk,
  type VideoCodec,
} from 'mediabunny'
import { GIFEncoder, applyPalette, quantize } from 'gifenc'
import type { ExportHandle } from '@shared/app'
import { projectDuration } from '@/editor/ops'
import { playback } from '@/editor/playback'
import { cuesInRange, formatCues, withoutCaptions, type SubtitleFormat } from '@/editor/subtitles'
import type { Project } from '@/editor/types'
import { desktop } from '@/lib/platform'
import { prepareAudio, renderMix, type MixOptions } from './audio-engine'
import { renderFrame } from './compositor'
import { collectHeld } from './decode'
import {
  chooseEncoder,
  clearEncoderTest,
  CODEC_NAME,
  describeEncoder,
  encoderSupport,
  fallbackNote,
  markEncoderFailed,
  type EncoderAttempt,
  type EncoderPlan,
  type EncoderRequest,
  type ExportVideoCodec,
} from './encoders'
import { LoudnessMeter } from './loudness'
import { withVideoFrames } from './media'
import { FrameFeeder } from './stills'
import { encodeWav } from './wav'

export { CODECS_FOR, encoderSupport, videoBitrate, type CodecAvailability, type ExportVideoCodec } from './encoders'

export type ExportFormat = 'mp4' | 'mov' | 'webm' | 'gif' | 'png' | 'wav' | 'm4a'

export interface ExportSettings {
  format: ExportFormat
  codec: ExportVideoCodec
  /** Output size (even numbers). */
  width: number
  height: number
  fps: number
  /** 10..100 */
  quality: number
  /** Try the graphics card's encoder first (the processor's is the fallback, and the other way round when off). */
  hardware: boolean
  /** Project frames [start, end) to export; defaults to the whole timeline. */
  range?: [number, number]
  /** Normalize the mix to this integrated loudness (LUFS), with peaks held under `peak` dBFS. */
  loudness?: { lufs: number; peak: number }
  /** A transparent background (PNG sequences, and WebM with VP9) instead of the project's background colour. */
  alpha?: boolean
  /** Draw the caption tracks into the picture (default true). */
  burnCaptions?: boolean
  /** Also save the captions as a subtitle file next to the export. */
  sidecar?: SubtitleFormat | null
}

export interface ExportResult {
  path: string
  size: number
  /** The subtitle file saved beside it. */
  sidecar?: string
  /** What encoded the picture. `note` says why when it isn't what was asked for. */
  encoder?: { codec: ExportVideoCodec; hardware: boolean; note?: string }
  /** What a viewer should know: footage that couldn't be decoded in places and shows a held picture there. */
  warnings?: string[]
}

/** Loudness targets people deliver to. */
export const LOUDNESS_TARGETS = [
  { id: 'streaming', label: '−14 LUFS · YouTube, Spotify, TikTok', lufs: -14, peak: -1 },
  { id: 'apple', label: '−16 LUFS · Apple, podcasts', lufs: -16, peak: -1 },
  { id: 'ebu', label: '−23 LUFS · EBU R128 broadcast', lufs: -23, peak: -1 },
  { id: 'atsc', label: '−24 LUFS · ATSC A/85 broadcast', lufs: -24, peak: -2 },
] as const

export interface ExportProgress {
  phase: 'preparing' | 'rendering' | 'finishing'
  done: number
  total: number
  /** Output frames rendered per second. */
  speed: number
  /** Seconds left (estimated). */
  eta: number
  message?: string
  /** JPEG data URL of a recent frame. */
  preview?: string
}

let thumb: HTMLCanvasElement | null = null
function previewOf(canvas: HTMLCanvasElement) {
  thumb ??= document.createElement('canvas')
  thumb.width = 480
  thumb.height = Math.max(1, Math.round((480 * canvas.height) / canvas.width))
  thumb.getContext('2d')!.drawImage(canvas, 0, 0, thumb.width, thumb.height)
  return thumb.toDataURL('image/jpeg', 0.7)
}

export class ExportCancelled extends Error {
  constructor() {
    super('Export cancelled')
  }
}

export const FORMAT_INFO: Record<ExportFormat, { label: string; extension: string; filter: string; video: boolean; folder?: boolean }> = {
  mp4: { label: 'MP4', extension: 'mp4', filter: 'MP4 video', video: true },
  mov: { label: 'MOV', extension: 'mov', filter: 'QuickTime movie', video: true },
  webm: { label: 'WebM', extension: 'webm', filter: 'WebM video', video: true },
  gif: { label: 'GIF', extension: 'gif', filter: 'Animated GIF', video: true },
  png: { label: 'PNG', extension: 'png', filter: 'PNG frames', video: true, folder: true },
  wav: { label: 'WAV', extension: 'wav', filter: 'WAV audio', video: false },
  m4a: { label: 'M4A', extension: 'm4a', filter: 'M4A audio', video: false },
}

/** Formats that can keep a transparent background. */
export const canAlpha = (format: ExportFormat, codec: ExportVideoCodec) => format === 'png' || (format === 'webm' && codec === 'vp9')

export const CODEC_LABEL: Record<ExportVideoCodec, string> = {
  avc: 'H.264 — plays everywhere',
  hevc: 'HEVC (H.265) — smaller files',
  av1: 'AV1 — best compression',
  vp9: 'VP9 — open, widely supported',
}

/**
 * Which codecs this computer can encode at a size: true when the graphics card
 * or the processor has an encoder for it (the export tries them for real and
 * falls back by itself, so either is enough).
 */
export async function codecSupport(width: number, height: number, fps: number) {
  const support = await encoderSupport(width, height, fps)
  const out: Partial<Record<ExportVideoCodec, boolean>> = {}
  for (const codec of Object.keys(support) as ExportVideoCodec[]) out[codec] = support[codec].hardware || support[codec].software
  return out
}

async function audioCodecFor(format: 'mp4' | 'mov' | 'webm' | 'm4a'): Promise<AudioCodec> {
  if (format === 'webm') return 'opus'
  if (await canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: 48000, bitrate: 192_000 }).catch(() => false)) return 'aac'
  // No AAC encoder on this system: MOV takes uncompressed PCM, MP4 / M4A take Opus.
  return format === 'mov' ? 'pcm-s16' : 'opus'
}

/**
 * Loudness normalization, pass one: renders the mix once to measure its integrated
 * loudness (BS.1770), then returns the gain that lands it on the target, with a
 * limiter holding the peaks under the ceiling.
 */
async function normalization(project: Project, range: [number, number], target: { lufs: number; peak: number }, onProgress: (p: ExportProgress) => void, check: () => void): Promise<MixOptions> {
  const fps = project.settings.fps
  const meter = new LoudnessMeter(48000)
  const step = 10
  const total = Math.max(1, Math.ceil((range[1] - range[0]) / fps / step))
  for (let i = 0; i < total; i++) {
    check()
    const t0 = range[0] / fps + i * step
    const t1 = Math.min(range[1] / fps, t0 + step)
    const buf = await renderMix(project, t0, t1)
    meter.push([buf.getChannelData(0), buf.getChannelData(1)])
    onProgress({ phase: 'preparing', done: i + 1, total, speed: 0, eta: 0, message: `Measuring loudness (${Math.round(((i + 1) / total) * 100)}%)…` })
  }
  const measured = meter.result().lufs
  if (measured === null) return {}
  const gainDb = Math.max(-40, Math.min(30, target.lufs - measured))
  onProgress({ phase: 'preparing', done: 1, total: 1, speed: 0, eta: 0, message: `Loudness ${measured.toFixed(1)} LUFS → ${target.lufs} LUFS (${gainDb >= 0 ? '+' : ''}${gainDb.toFixed(1)} dB)` })
  return { gainDb, ceiling: target.peak }
}

const hasAudio = (project: Project) => Object.values(project.clips).some((c) => c.kind === 'audio' || c.kind === 'video')

/** Everything a frame needs is decoded before it's drawn: video frames, sequence frames, stills. */
function makeProgress(onProgress: (p: ExportProgress) => void, total: number, canvas?: HTMLCanvasElement | null) {
  const started = performance.now()
  let last = 0
  let lastPreview = 0
  return (done: number, force = false) => {
    const now = performance.now()
    if (!force && now - last < 120) return
    last = now
    const secs = (now - started) / 1000
    const speed = secs > 0 ? done / secs : 0
    let preview: string | undefined
    if (canvas && (force || now - lastPreview > 1000)) {
      lastPreview = now
      preview = previewOf(canvas)
    }
    onProgress({ phase: 'rendering', done, total, speed, eta: speed > 0 ? (total - done) / speed : 0, preview })
    desktop?.export.progress(total ? done / total : null)
  }
}

let running = false

/** An export is in progress (from the dialog or an agent) — only one at a time. */
export const exportRunning = () => running

/** Renders the project to the file behind `handle`. Resolves with the finished file. */
export async function runExport(project: Project, settings: ExportSettings, handle: ExportHandle, onProgress: (p: ExportProgress) => void, signal: AbortSignal): Promise<ExportResult> {
  if (running) {
    await desktop?.export.abort(handle.id).catch(() => {})
    throw new Error('Another export is already running — wait for it to finish.')
  }
  running = true
  try {
    return await exportOnce(project, settings, handle, onProgress, signal)
  } finally {
    running = false
  }
}

/** The stretches of footage this export couldn't decode and showed a held picture for. */
function damageWarnings(project: Project): string[] {
  return collectHeld().map(({ url, damage: d }) => {
    const name = Object.values(project.assets).find((a) => a.source.type === 'file' && a.source.url === url)?.name ?? 'A video'
    const length = Number.isFinite(d.to) ? `${(d.to - d.from).toFixed(2)} s` : 'the rest of it'
    return `“${name}” can’t be decoded for ${length} from ${d.from.toFixed(2)} s in (the file is damaged there). The picture before it is held.`
  })
}

async function exportOnce(source: Project, settings: ExportSettings, handle: ExportHandle, onProgress: (p: ExportProgress) => void, signal: AbortSignal): Promise<ExportResult> {
  collectHeld()
  const rendered = await renderTo(source, settings, handle, onProgress, signal)
  const warnings = damageWarnings(source)
  const res: ExportResult = warnings.length ? { ...rendered, warnings } : rendered
  const range = settings.range ?? [0, projectDuration(source)]
  if (settings.sidecar && desktop) {
    const cues = cuesInRange(source, range)
    if (cues.length) return { ...res, sidecar: await desktop.export.sidecar(res.path, settings.sidecar, formatCues(cues, settings.sidecar)) }
  }
  return res
}

async function renderTo(source: Project, settings: ExportSettings, handle: ExportHandle, onProgress: (p: ExportProgress) => void, signal: AbortSignal): Promise<ExportResult> {
  if (!desktop) throw new Error('Exporting needs the desktop app.')
  playback.pause()
  const api = desktop
  const project = settings.burnCaptions === false ? withoutCaptions(source) : source
  const range = settings.range ?? [0, projectDuration(project)]
  const seconds = (range[1] - range[0]) / project.settings.fps
  if (seconds <= 0) throw new Error('The timeline is empty — add some clips first.')
  const check = () => {
    if (signal.aborted) throw new ExportCancelled()
  }

  try {
    onProgress({ phase: 'preparing', done: 0, total: 1, speed: 0, eta: 0, message: settings.format === 'png' ? 'Preparing…' : 'Preparing audio…' })
    await document.fonts.ready
    if (settings.format === 'png') return await exportFrames(project, settings, range, handle, onProgress, check)
    await prepareAudio(project, (done, total) => onProgress({ phase: 'preparing', done, total, speed: 0, eta: 0, message: `Preparing audio (${done}/${total})…` }))
    check()
    const mixOpts = settings.loudness && settings.format !== 'gif' && hasAudio(project) ? await normalization(project, range, settings.loudness, onProgress, check) : {}

    if (settings.format === 'wav') {
      const mix = await renderMix(project, range[0] / project.settings.fps, range[1] / project.settings.fps, mixOpts)
      check()
      await api.export.write(handle.id, 0, encodeWav(mix))
      return await api.export.finish(handle.id)
    }
    if (settings.format === 'gif') return await exportGif(project, settings, range, handle, onProgress, check)
    return await exportMedia(project, settings, range, handle, onProgress, check, mixOpts)
  } catch (err) {
    await api.export.abort(handle.id).catch(() => {})
    throw err
  } finally {
    api.export.progress(null)
  }
}

/** The picture's encoder failed (as opposed to the disk, the decoder or the compositor). */
class EncoderFailure extends Error {}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** A hung hardware encoder never answers: after this long without a frame going in, it counts as failed. */
const ENCODER_STALL_MS = 60_000

function noEncoderMessage(req: EncoderRequest, attempts: EncoderAttempt[]) {
  const tried = attempts.map((a) => `${describeEncoder(a)}: ${a.error ?? 'failed'}`).join(' · ')
  return `This computer can’t encode ${CODEC_NAME[req.codec]} at ${req.width}×${req.height}, ${req.fps} fps — try a smaller size, a lower frame rate or another format. (${tried})`
}

async function exportMedia(
  project: Project,
  settings: ExportSettings,
  range: [number, number],
  handle: ExportHandle,
  onProgress: (p: ExportProgress) => void,
  check: () => void,
  mixOpts: MixOptions,
): Promise<ExportResult> {
  const api = desktop!
  const format = settings.format as 'mp4' | 'mov' | 'webm' | 'm4a'
  // Transparency rides along as a second VP9 stream in the WebM.
  const alpha = format !== 'm4a' && Boolean(settings.alpha) && canAlpha(settings.format, settings.codec)
  const request: EncoderRequest | null =
    format === 'm4a' ? null : { codec: settings.codec, container: format, width: settings.width, height: settings.height, fps: settings.fps, quality: settings.quality, hardware: settings.hardware, lockCodec: alpha }
  let plan: EncoderPlan | null = null
  if (request) {
    // Tried for real, with a few frames at this size: some drivers accept settings and then fail.
    onProgress({ phase: 'preparing', done: 0, total: 1, speed: 0, eta: 0, message: 'Checking the encoder…' })
    const choice = await chooseEncoder(request)
    if (!choice.plan) throw new Error(noEncoderMessage(request, choice.attempts))
    plan = choice.plan
    check()
  }
  // Encoders given up on during this export. If none of them gets through, the encoders weren't the problem.
  const gaveUpOn: EncoderPlan[] = []
  const forgive = () => gaveUpOn.forEach((p) => clearEncoderTest(p, settings.width, settings.height, settings.fps))
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await encodeMedia(project, settings, range, handle, onProgress, check, mixOpts, plan, alpha)
      return plan && request ? { ...res, encoder: { codec: plan.codec, hardware: plan.acceleration === 'prefer-hardware', note: fallbackNote(request, plan) } } : res
    } catch (err) {
      if (!(err instanceof EncoderFailure) || !plan || !request || attempt >= 3) {
        forgive()
        throw err
      }
      // The encoder passed its test and then failed on the real thing: start again on the next one.
      markEncoderFailed(plan, settings.width, settings.height, settings.fps, errorText(err))
      gaveUpOn.push(plan)
      const next = await chooseEncoder(request)
      if (!next.plan) {
        forgive()
        throw new Error(`${describeEncoder(plan)} stopped working (${errorText(err)}), and this computer has no other encoder for this export.`)
      }
      onProgress({ phase: 'preparing', done: 0, total: 1, speed: 0, eta: 0, message: `${describeEncoder(plan)} stopped working — starting again with ${describeEncoder(next.plan)}…` })
      await api.export.restart(handle.id)
      plan = next.plan
    }
  }
}

async function encodeMedia(
  project: Project,
  settings: ExportSettings,
  range: [number, number],
  handle: ExportHandle,
  onProgress: (p: ExportProgress) => void,
  check: () => void,
  mixOpts: MixOptions,
  plan: EncoderPlan | null,
  alpha: boolean,
) {
  const api = desktop!
  const format = settings.format as 'mp4' | 'mov' | 'webm' | 'm4a'
  const projectFps = project.settings.fps
  const start = range[0] / projectFps
  const duration = (range[1] - range[0]) / projectFps

  // A full disk is not the encoder's fault: remembered, so it isn't retried on another encoder.
  let writeError: unknown = null
  // Chunks are copied out of the muxer's buffer before crossing to the main process.
  const writable = new WritableStream<StreamTargetChunk>({
    write: (chunk) =>
      api.export.write(handle.id, chunk.position, chunk.data.slice()).catch((err: unknown) => {
        writeError ??= err
        throw err
      }),
  })
  const output = new Output({
    format: format === 'webm' ? new WebMOutputFormat() : format === 'mov' ? new MovOutputFormat({ fastStart: false }) : new Mp4OutputFormat({ fastStart: false }),
    target: new StreamTarget(writable, { chunked: true, chunkSize: 8 * 1024 * 1024 }),
  })

  let canvas: HTMLCanvasElement | null = null
  let videoSource: CanvasSource | null = null
  if (plan) {
    canvas = document.createElement('canvas')
    canvas.width = settings.width
    canvas.height = settings.height
    videoSource = new CanvasSource(canvas, {
      codec: plan.codec as VideoCodec,
      bitrate: plan.bitrate,
      // The level this size and frame rate really need (4K at 60 is past what 4K at 30 gets).
      fullCodecString: plan.codecString,
      keyFrameInterval: 2,
      latencyMode: 'quality',
      hardwareAcceleration: plan.acceleration,
      ...(alpha ? { alpha: 'keep' as const } : {}),
    })
    output.addVideoTrack(videoSource, { frameRate: settings.fps })
  }
  let audioSource: AudioBufferSource | null = null
  if (hasAudio(project)) {
    const codec = await audioCodecFor(format)
    audioSource = new AudioBufferSource({ codec, bitrate: codec.startsWith('pcm') ? undefined : 192_000 })
    output.addAudioTrack(audioSource)
  }
  if (!videoSource && !audioSource) throw new Error('There’s no audio to export.')

  /** What the encoder and the file writer throw, told apart. */
  const encoding = async <T>(work: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new EncoderFailure('The encoder stopped answering.')), ENCODER_STALL_MS)
        }),
      ])
    } catch (err) {
      if (writeError) throw writeError
      throw err instanceof EncoderFailure ? err : new EncoderFailure(errorText(err))
    } finally {
      clearTimeout(timer)
    }
  }

  // Frame-exact frames only while each export frame is drawn — the preview keeps its live players meanwhile.
  const feeder = plan ? new FrameFeeder(project, settings.width, settings.height) : null
  await output.start()
  try {
    const totalFrames = plan ? Math.max(1, Math.round(duration * settings.fps)) : 0
    const block = 2
    const blocks = Math.ceil(duration / block)
    const progress = makeProgress(onProgress, plan ? totalFrames : blocks, canvas)
    const ctx = canvas?.getContext('2d', { alpha, willReadFrequently: false }) ?? null
    let frame = 0
    for (let b = 0; b < blocks; b++) {
      check()
      const t0 = b * block
      const t1 = Math.min(duration, t0 + block)
      if (audioSource) await audioSource.add(await renderMix(project, start + t0, start + t1, mixOpts))
      if (!plan) {
        progress(b + 1)
        continue
      }
      // Frames whose start time falls inside this block.
      for (; frame < totalFrames && frame / settings.fps < t1 - 1e-9; frame++) {
        check()
        const projectFrame = range[0] + (frame / settings.fps) * projectFps
        await feeder!.prepare(projectFrame)
        withVideoFrames(feeder!.frame, () => renderFrame(ctx!, project, projectFrame, { transparent: alpha }))
        await encoding(videoSource!.add(frame / settings.fps, 1 / settings.fps))
        progress(frame + 1)
      }
    }
    progress(plan ? totalFrames : blocks, true)
    onProgress({ phase: 'finishing', done: 1, total: 1, speed: 0, eta: 0, message: 'Finishing file…' })
    videoSource?.close()
    audioSource?.close()
    // The encoder's last frames come out here.
    if (plan) await encoding(output.finalize())
    else await output.finalize()
    return await api.export.finish(handle.id)
  } catch (err) {
    await output.cancel().catch(() => {})
    throw err
  } finally {
    feeder?.dispose()
  }
}

/** An image sequence: one PNG per frame, transparent unless `alpha` is false. */
async function exportFrames(project: Project, settings: ExportSettings, range: [number, number], handle: ExportHandle, onProgress: (p: ExportProgress) => void, check: () => void) {
  const api = desktop!
  const projectFps = project.settings.fps
  const duration = (range[1] - range[0]) / projectFps
  const total = Math.max(1, Math.round(duration * settings.fps))
  const canvas = document.createElement('canvas')
  canvas.width = settings.width
  canvas.height = settings.height
  const ctx = canvas.getContext('2d', { alpha: true })!
  const feeder = new FrameFeeder(project, settings.width, settings.height)
  const progress = makeProgress(onProgress, total, canvas)
  const transparent = settings.alpha !== false
  // Encoding one PNG overlaps with drawing the next.
  let pending: Promise<void> = Promise.resolve()
  try {
    for (let i = 0; i < total; i++) {
      check()
      const projectFrame = range[0] + (i / settings.fps) * projectFps
      await feeder.prepare(projectFrame)
      withVideoFrames(feeder.frame, () => renderFrame(ctx, project, projectFrame, { transparent }))
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
      if (!blob) throw new Error('Couldn’t encode a PNG frame.')
      await pending
      pending = blob.arrayBuffer().then((buf) => api.export.writeFrame(handle.id, i, new Uint8Array(buf)))
      progress(i + 1)
    }
    await pending
    progress(total, true)
    onProgress({ phase: 'finishing', done: 1, total: 1, speed: 0, eta: 0, message: 'Finishing…' })
    return await api.export.finish(handle.id)
  } finally {
    feeder.dispose()
  }
}

async function exportGif(project: Project, settings: ExportSettings, range: [number, number], handle: ExportHandle, onProgress: (p: ExportProgress) => void, check: () => void) {
  const api = desktop!
  const fps = Math.min(settings.fps, 20)
  const projectFps = project.settings.fps
  const duration = (range[1] - range[0]) / projectFps
  const total = Math.max(1, Math.round(duration * fps))
  const canvas = document.createElement('canvas')
  canvas.width = settings.width
  canvas.height = settings.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  const feeder = new FrameFeeder(project, settings.width, settings.height)
  const gif = GIFEncoder()
  const progress = makeProgress(onProgress, total, canvas)
  const delay = Math.round(1000 / fps)
  try {
    for (let i = 0; i < total; i++) {
      check()
      const projectFrame = range[0] + (i / fps) * projectFps
      await feeder.prepare(projectFrame)
      withVideoFrames(feeder.frame, () => renderFrame(ctx, project, projectFrame))
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const palette = quantize(data, 256)
      gif.writeFrame(applyPalette(data, palette), canvas.width, canvas.height, { palette, delay })
      progress(i + 1)
      // Quantizing is CPU-bound: let the UI breathe.
      if (i % 4 === 3) await new Promise((r) => setTimeout(r, 0))
    }
    gif.finish()
    onProgress({ phase: 'finishing', done: 1, total: 1, speed: 0, eta: 0, message: 'Writing file…' })
    await api.export.write(handle.id, 0, gif.bytes())
    return await api.export.finish(handle.id)
  } finally {
    feeder.dispose()
  }
}
