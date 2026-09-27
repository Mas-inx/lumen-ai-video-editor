/**
 * Export: renders every frame through the same compositor as the preview, with
 * frame-exact video decoding, mixes the audio with the same engine as playback,
 * encodes with WebCodecs (hardware when available) and streams the file to disk.
 */
import {
  AudioBufferSource,
  canEncodeAudio,
  canEncodeVideo,
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
import type { Project } from '@/editor/types'
import { desktop } from '@/lib/platform'
import { prepareAudio, renderMix, type MixOptions } from './audio-engine'
import { renderFrame } from './compositor'
import { LoudnessMeter } from './loudness'
import { setExportFrames } from './media'
import { FrameFeeder } from './stills'
import { encodeWav } from './wav'

export type ExportFormat = 'mp4' | 'mov' | 'webm' | 'gif' | 'wav' | 'm4a'
export type ExportVideoCodec = 'avc' | 'hevc' | 'av1' | 'vp9'

export interface ExportSettings {
  format: ExportFormat
  codec: ExportVideoCodec
  /** Output size (even numbers). */
  width: number
  height: number
  fps: number
  /** 10..100 */
  quality: number
  hardware: boolean
  /** Project frames [start, end) to export; defaults to the whole timeline. */
  range?: [number, number]
  /** Normalize the mix to this integrated loudness (LUFS), with peaks held under `peak` dBFS. */
  loudness?: { lufs: number; peak: number }
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

export const FORMAT_INFO: Record<ExportFormat, { label: string; extension: string; filter: string; video: boolean }> = {
  mp4: { label: 'MP4', extension: 'mp4', filter: 'MP4 video', video: true },
  mov: { label: 'MOV', extension: 'mov', filter: 'QuickTime movie', video: true },
  webm: { label: 'WebM', extension: 'webm', filter: 'WebM video', video: true },
  gif: { label: 'GIF', extension: 'gif', filter: 'Animated GIF', video: true },
  wav: { label: 'WAV', extension: 'wav', filter: 'WAV audio', video: false },
  m4a: { label: 'M4A', extension: 'm4a', filter: 'M4A audio', video: false },
}

/** Video codecs each container can carry, best first. */
export const CODECS_FOR: Record<'mp4' | 'mov' | 'webm', ExportVideoCodec[]> = {
  mp4: ['avc', 'hevc', 'av1'],
  mov: ['avc', 'hevc'],
  webm: ['vp9', 'av1'],
}

export const CODEC_LABEL: Record<ExportVideoCodec, string> = {
  avc: 'H.264 — plays everywhere',
  hevc: 'HEVC (H.265) — smaller files',
  av1: 'AV1 — best compression',
  vp9: 'VP9 — open, widely supported',
}

const EFFICIENCY: Record<ExportVideoCodec, number> = { avc: 1, hevc: 0.62, vp9: 0.68, av1: 0.5 }

/** Target bitrate (bits/s) for a size, frame rate, codec and quality (10..100). */
export function videoBitrate(width: number, height: number, fps: number, codec: ExportVideoCodec, quality: number) {
  const pixels = width * height
  const base = 12_000_000 * (pixels / 2_073_600) * Math.pow(fps / 30, 0.75)
  const q = 0.35 + (Math.max(10, Math.min(100, quality)) / 100) * 1.25
  return Math.round(base * EFFICIENCY[codec] * q)
}

export async function codecSupport(width: number, height: number, fps: number, hardware: boolean) {
  const out: Partial<Record<ExportVideoCodec, boolean>> = {}
  await Promise.all(
    (['avc', 'hevc', 'av1', 'vp9'] as const).map(async (c) => {
      out[c] = await canEncodeVideo(c as VideoCodec, {
        width,
        height,
        frameRate: fps,
        bitrate: videoBitrate(width, height, fps, c, 70),
        hardwareAcceleration: hardware ? 'prefer-hardware' : 'no-preference',
      }).catch(() => false)
    }),
  )
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
export async function runExport(project: Project, settings: ExportSettings, handle: ExportHandle, onProgress: (p: ExportProgress) => void, signal: AbortSignal) {
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

async function exportOnce(project: Project, settings: ExportSettings, handle: ExportHandle, onProgress: (p: ExportProgress) => void, signal: AbortSignal) {
  if (!desktop) throw new Error('Exporting needs the desktop app.')
  playback.pause()
  const api = desktop
  const range = settings.range ?? [0, projectDuration(project)]
  const seconds = (range[1] - range[0]) / project.settings.fps
  if (seconds <= 0) throw new Error('The timeline is empty — add some clips first.')
  const check = () => {
    if (signal.aborted) throw new ExportCancelled()
  }

  try {
    onProgress({ phase: 'preparing', done: 0, total: 1, speed: 0, eta: 0, message: 'Preparing audio…' })
    await document.fonts.ready
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
    setExportFrames(null)
    api.export.progress(null)
  }
}

async function exportMedia(
  project: Project,
  settings: ExportSettings,
  range: [number, number],
  handle: ExportHandle,
  onProgress: (p: ExportProgress) => void,
  check: () => void,
  mixOpts: MixOptions,
) {
  const api = desktop!
  const format = settings.format as 'mp4' | 'mov' | 'webm' | 'm4a'
  const video = format !== 'm4a'
  const projectFps = project.settings.fps
  const start = range[0] / projectFps
  const duration = (range[1] - range[0]) / projectFps

  // Chunks are copied out of the muxer's buffer before crossing to the main process.
  const writable = new WritableStream<StreamTargetChunk>({
    write: (chunk) => api.export.write(handle.id, chunk.position, chunk.data.slice()),
  })
  const output = new Output({
    format: format === 'webm' ? new WebMOutputFormat() : format === 'mov' ? new MovOutputFormat({ fastStart: false }) : new Mp4OutputFormat({ fastStart: false }),
    target: new StreamTarget(writable, { chunked: true, chunkSize: 8 * 1024 * 1024 }),
  })

  let canvas: HTMLCanvasElement | null = null
  let videoSource: CanvasSource | null = null
  if (video) {
    canvas = document.createElement('canvas')
    canvas.width = settings.width
    canvas.height = settings.height
    videoSource = new CanvasSource(canvas, {
      codec: settings.codec as VideoCodec,
      bitrate: videoBitrate(settings.width, settings.height, settings.fps, settings.codec, settings.quality),
      keyFrameInterval: 2,
      latencyMode: 'quality',
      hardwareAcceleration: settings.hardware ? 'prefer-hardware' : 'no-preference',
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

  const feeder = video ? new FrameFeeder(project, settings.width, settings.height) : null
  if (feeder) setExportFrames(feeder.frame)
  await output.start()
  try {
    const totalFrames = video ? Math.max(1, Math.round(duration * settings.fps)) : 0
    const block = 2
    const blocks = Math.ceil(duration / block)
    const progress = makeProgress(onProgress, video ? totalFrames : blocks, canvas)
    const ctx = canvas?.getContext('2d', { alpha: false, willReadFrequently: false }) ?? null
    let frame = 0
    for (let b = 0; b < blocks; b++) {
      check()
      const t0 = b * block
      const t1 = Math.min(duration, t0 + block)
      if (audioSource) await audioSource.add(await renderMix(project, start + t0, start + t1, mixOpts))
      if (!video) {
        progress(b + 1)
        continue
      }
      // Frames whose start time falls inside this block.
      for (; frame < totalFrames && frame / settings.fps < t1 - 1e-9; frame++) {
        check()
        const projectFrame = range[0] + (frame / settings.fps) * projectFps
        await feeder!.prepare(projectFrame)
        renderFrame(ctx!, project, projectFrame)
        await videoSource!.add(frame / settings.fps, 1 / settings.fps)
        progress(frame + 1)
      }
    }
    progress(video ? totalFrames : blocks, true)
    onProgress({ phase: 'finishing', done: 1, total: 1, speed: 0, eta: 0, message: 'Finishing file…' })
    videoSource?.close()
    audioSource?.close()
    await output.finalize()
    return await api.export.finish(handle.id)
  } catch (err) {
    await output.cancel().catch(() => {})
    throw err
  } finally {
    feeder?.dispose()
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
  setExportFrames(feeder.frame)
  const gif = GIFEncoder()
  const progress = makeProgress(onProgress, total, canvas)
  const delay = Math.round(1000 / fps)
  try {
    for (let i = 0; i < total; i++) {
      check()
      const projectFrame = range[0] + (i / fps) * projectFps
      await feeder.prepare(projectFrame)
      renderFrame(ctx, project, projectFrame)
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
