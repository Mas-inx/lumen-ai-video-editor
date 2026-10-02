/**
 * Subject mattes: the shape of the person (or main subject) in a clip, frame
 * by frame, made on this computer. The matte is a small black-and-white video
 * (white = subject) kept with the project; a clip with a matte shows just its
 * subject — the top layer of "text behind subject" — or, inverted, everything
 * but it. The model downloads once (through Lumen's cache) and then works
 * offline: MODNet (people, ~25 MB) or BiRefNet-lite (any subject, needs WebGPU).
 */
import ortMjs from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url'
import ortWasm from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url'
import { BufferTarget, CanvasSource, Mp4OutputFormat, Output } from 'mediabunny'
import { dispatch, getProject } from '@/editor/store'
import type { Asset, Clip } from '@/editor/types'
import { AnalysisCancelled, scanFrames } from '@/engine/analysis'
import { clipSourceTime } from '@/engine/compositor'
import { uid } from '@/lib/id'
import { desktop } from '@/lib/platform'
import type { SegmentConfig, SegmentMessage, SegmentRequest } from './segment.worker'

export type Subject = 'person' | 'any'

export const SEGMENT_MODELS: Record<Subject, string> = {
  person: 'Xenova/modnet',
  any: 'onnx-community/BiRefNet_lite-ONNX',
}

/** Matte width: about what the models see; the compositor scales it to the picture. */
const MATTE_WIDTH = 768

// ─── The worker ──────────────────────────────────────────────────────────

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, { resolve: (a: Uint8Array) => void; reject: (e: Error) => void }>()
const progressListeners = new Set<(m: Extract<SegmentMessage, { type: 'progress' | 'ready' }>) => void>()

/** Model download and start-up progress. */
export function onSegmentProgress(fn: (m: Extract<SegmentMessage, { type: 'progress' | 'ready' }>) => void) {
  progressListeners.add(fn)
  return () => void progressListeners.delete(fn)
}

const absolute = (url: string) => new URL(url, location.href).href

function config(subject: Subject): SegmentConfig {
  return { model: SEGMENT_MODELS[subject], needsGpu: subject === 'any', remoteHost: 'lumen-media://models/', ortMjs: absolute(ortMjs), ortWasm: absolute(ortWasm) }
}

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./segment.worker.ts', import.meta.url), { type: 'module', name: 'segment' })
    worker.onmessage = (e: MessageEvent<SegmentMessage>) => {
      const m = e.data
      if (m.type === 'progress' || m.type === 'ready') progressListeners.forEach((fn) => fn(m))
      else if (m.type === 'result') {
        pending.get(m.id)?.resolve(m.alpha)
        pending.delete(m.id)
      } else if (m.type === 'error') {
        pending.get(m.id)?.reject(new Error(m.message))
        pending.delete(m.id)
      }
    }
    worker.onerror = (e) => {
      for (const p of pending.values()) p.reject(new Error(e.message || 'The segmentation model crashed.'))
      pending.clear()
      worker?.terminate()
      worker = null
    }
  }
  return worker
}

/** The subject's matte (0–255 per pixel) for one RGBA frame. */
export function segmentFrame(rgba: Uint8ClampedArray, width: number, height: number, subject: Subject): Promise<Uint8Array> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    // A copy goes to the worker (the decoder reuses its buffer).
    const copy = new Uint8ClampedArray(rgba)
    const req: SegmentRequest = { type: 'segment', id, rgba: copy, width, height, config: config(subject) }
    getWorker().postMessage(req, [copy.buffer])
  })
}

/**
 * Calms frame-to-frame flicker at the edges: where the matte barely changed it
 * blends with the previous frame; where it moved a lot (real motion) it doesn't.
 */
export function steady(alpha: Uint8Array, prev: Uint8Array | null) {
  if (!prev || prev.length !== alpha.length) return alpha
  for (let i = 0; i < alpha.length; i++) {
    const d = alpha[i] - prev[i]
    if (d > -48 && d < 48) alpha[i] = (alpha[i] + prev[i] + 1) >> 1
  }
  return alpha
}

/** The subject's bounding box in a matte (0..1 of the frame), or null when there's no subject. */
export function subjectBox(alpha: Uint8Array, width: number, height: number) {
  let x0 = width
  let y0 = height
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < height; y += 2)
    for (let x = 0; x < width; x += 2)
      if (alpha[y * width + x] > 128) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
  if (x1 < 0) return null
  return { x: x0 / width, y: y0 / height, w: (x1 - x0 + 1) / width, h: (y1 - y0 + 1) / height }
}

/** The median box of many (robust to a few odd frames). */
function medianBox(boxes: { x: number; y: number; w: number; h: number }[]) {
  if (!boxes.length) return undefined
  const mid = (k: 'x' | 'y' | 'w' | 'h') => {
    const v = boxes.map((b) => b[k]).sort((a, b) => a - b)
    return Math.round(v[Math.floor(v.length / 2)] * 1000) / 1000
  }
  return { x: mid('x'), y: mid('y'), w: mid('w'), h: mid('h') }
}

// ─── Mattes for clips ────────────────────────────────────────────────────

export interface MatteProgress {
  /** Frames done and to do (0 of 0 while the model loads). */
  done: number
  total: number
}

/** The stretch of the media a clip shows, in source seconds, with a little to spare for trims. */
function stretchOf(clip: Clip, asset: Asset, fps: number): [number, number] {
  const a = clipSourceTime(clip, 0, fps)
  const b = clipSourceTime(clip, clip.duration, fps)
  return [Math.max(0, Math.min(a, b) - 0.5), Math.min(asset.duration ?? Infinity, Math.max(a, b) + 0.5)]
}

/** A matte already made for this media that covers the stretch (mattes are reused, never remade). */
function existingMatte(asset: Asset, subject: Subject, from: number, to: number) {
  return Object.values(getProject().assets).find((m) => m.matteOf?.assetId === asset.id && m.matteOf.subject === subject && m.matteOf.from <= from + 1e-3 && m.matteOf.to >= to - 1e-3)
}

function grayscale(ctx: CanvasRenderingContext2D, alpha: Uint8Array, width: number, height: number) {
  const img = ctx.createImageData(width, height)
  for (let i = 0; i < alpha.length; i++) {
    const v = alpha[i]
    img.data[i * 4] = v
    img.data[i * 4 + 1] = v
    img.data[i * 4 + 2] = v
    img.data[i * 4 + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
}

/**
 * Makes (or reuses) the subject matte for a clip and returns what goes in its
 * `matte`. Video clips get a matte video over the stretch they show; stills a
 * matte image.
 */
export async function subjectMatte(clip: Clip, subject: Subject, opts: { onProgress?: (p: MatteProgress) => void; signal?: AbortSignal } = {}): Promise<{ assetId: string; from: number }> {
  if (!desktop) throw new Error('Cutting out subjects needs Lumen’s desktop app.')
  const project = getProject()
  const asset = clip.assetId ? project.assets[clip.assetId] : undefined
  if (!asset || asset.kind === 'audio') throw new Error('Pick a video or image clip — there’s no picture to cut out of this one.')
  if (asset.source.type !== 'file' || asset.source.missing) throw new Error(`“${asset.name}” is offline or isn’t a single file.`)
  const fps = project.settings.fps
  const [from, to] = asset.kind === 'image' ? [0, 0] : stretchOf(clip, asset, fps)
  const reuse = existingMatte(asset, subject, from, to)
  if (reuse) return { assetId: reuse.id, from: reuse.matteOf!.from }
  const name = `${asset.name.replace(/\.[^.]+$/, '')} — ${subject === 'person' ? 'person' : 'subject'} matte`

  if (asset.kind === 'image') {
    const img = await loadImage(asset.source.url)
    const width = Math.min(MATTE_WIDTH * 2, img.naturalWidth)
    const height = Math.max(2, Math.round((width * img.naturalHeight) / img.naturalWidth))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    ctx.drawImage(img, 0, 0, width, height)
    opts.onProgress?.({ done: 0, total: 1 })
    const alpha = await segmentFrame(ctx.getImageData(0, 0, width, height).data, width, height, subject)
    const box = subjectBox(alpha, width, height) ?? undefined
    grayscale(ctx, alpha, width, height)
    const blob = await new Promise<Blob>((r, x) => canvas.toBlob((b) => (b ? r(b) : x(new Error('Couldn’t save the matte'))), 'image/png'))
    const info = await desktop.files.saveMedia('generated', `${name}.png`, new Uint8Array(await blob.arrayBuffer()))
    opts.onProgress?.({ done: 1, total: 1 })
    return { assetId: addMatte(asset, subject, name, info, { kind: 'image', width, height }, 0, 0, box), from: 0 }
  }

  const rate = asset.fps ?? fps
  const total = Math.max(1, Math.round((to - from) * rate))
  let canvas: HTMLCanvasElement | null = null
  let ctx: CanvasRenderingContext2D | null = null
  let output: Output | null = null
  let source: CanvasSource | null = null
  const target = new BufferTarget()
  let prev: Uint8Array | null = null
  const boxes: { x: number; y: number; w: number; h: number }[] = []
  let done = 0
  let last = -1
  let size = { width: 0, height: 0 }
  opts.onProgress?.({ done: 0, total })
  try {
    size = await scanFrames(
      asset.source.url,
      from,
      to,
      MATTE_WIDTH,
      async (f) => {
        if (!output) {
          canvas = document.createElement('canvas')
          canvas.width = f.width
          canvas.height = f.height
          ctx = canvas.getContext('2d', { willReadFrequently: true })!
          output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target })
          source = new CanvasSource(canvas, { codec: 'avc', bitrate: 2_500_000 * ((f.width * f.height) / (768 * 432)), keyFrameInterval: 1, latencyMode: 'quality' })
          output.addVideoTrack(source, { frameRate: rate })
          await output.start()
        }
        const alpha = steady(await segmentFrame(f.rgba, f.width, f.height, subject), prev)
        prev = alpha
        if (done % 3 === 0) {
          const box = subjectBox(alpha, f.width, f.height)
          if (box) boxes.push(box)
        }
        grayscale(ctx!, alpha, f.width, f.height)
        // Matte time is source time from `from`; keep timestamps rising.
        const t = Math.max(last + 1 / (rate * 4), f.t - from, 0)
        last = t
        await source!.add(t, 1 / rate)
        done++
        opts.onProgress?.({ done, total })
      },
      opts.signal,
    )
    if (!output || !source) throw new Error('No frames came out of that clip.')
    ;(source as CanvasSource).close()
    await (output as Output).finalize()
  } catch (err) {
    await (output as Output | null)?.cancel().catch(() => {})
    throw err
  }
  const info = await desktop.files.saveMedia('generated', `${name}.mp4`, new Uint8Array(target.buffer!))
  return { assetId: addMatte(asset, subject, name, info, { kind: 'video', width: size.width, height: size.height, fps: rate, duration: done / rate }, from, to, medianBox(boxes)), from }
}

function addMatte(
  asset: Asset,
  subject: Subject,
  name: string,
  info: { path: string; url: string; name: string; size: number; mime: string; mtime: number },
  media: { kind: 'video' | 'image'; width: number; height: number; fps?: number; duration?: number },
  from: number,
  to: number,
  box?: { x: number; y: number; w: number; h: number },
) {
  const id = uid('asset')
  const matte: Asset = {
    id,
    name,
    kind: media.kind,
    width: media.width,
    height: media.height,
    ...(media.fps ? { fps: media.fps } : {}),
    ...(media.duration ? { duration: media.duration } : {}),
    hasAudio: false,
    source: { type: 'file', url: info.url, path: info.path, fileName: info.name, mime: info.mime, size: info.size, mtime: info.mtime },
    generated: true,
    matteOf: { assetId: asset.id, subject, from, to, ...(box ? { box } : {}) },
    addedAt: Date.now(),
  }
  dispatch('asset.add', { asset: matte }, { history: false })
  return id
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Couldn’t load the image'))
    img.src = url
  })
}

export { AnalysisCancelled }
