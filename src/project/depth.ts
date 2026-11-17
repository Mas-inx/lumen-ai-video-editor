/**
 * Depth maps: how near each point of a clip's picture is, frame by frame, made
 * on this computer with Depth Anything V2 (small, ~25 MB, downloaded once
 * through Lumen's cache). The map is a small grayscale video (white = near)
 * kept with the project as a hidden media item; Relight shapes its light with
 * it — surfaces turn toward or away from the light, near things catch more.
 *
 * Monocular depth comes out on a different scale every frame, so the range is
 * held steady across frames (percentiles, eased) instead of stretched per frame.
 */
import ortMjs from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url'
import ortWasm from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url'
import { BufferTarget, CanvasSource, Mp4OutputFormat, Output } from 'mediabunny'
import { EFFECTS } from '@/editor/presets'
import { dispatch, getProject, useEditor, type ActionSource } from '@/editor/store'
import type { Asset, Clip } from '@/editor/types'
import { AnalysisCancelled, scanFrames } from '@/engine/analysis'
import { clipSourceTime } from '@/engine/compositor'
import { uid } from '@/lib/id'
import { desktop } from '@/lib/platform'
import type { DepthConfig, DepthMessage, DepthRequest } from './depth.worker'

export const DEPTH_MODEL = 'onnx-community/depth-anything-v2-small'

/** Depth map width: plenty for light (depth is smooth), and quick to encode. */
const DEPTH_WIDTH = 640
/** Frames a second of depth: light follows movement well at this rate, and it halves the work for 60 fps footage. */
const MAX_RATE = 30

// ─── Steadying ───────────────────────────────────────────────────────────

/** The 2nd and 98th percentiles of raw depth, eased toward the frame before's (null starts fresh). */
export function depthRange(raw: Float32Array, prev: [number, number] | null, ease = 0.8): [number, number] {
  const step = Math.max(1, Math.floor(raw.length / 20000))
  const sample: number[] = []
  for (let i = 0; i < raw.length; i += step) if (Number.isFinite(raw[i])) sample.push(raw[i])
  if (!sample.length) return prev ?? [0, 1]
  sample.sort((a, b) => a - b)
  const lo = sample[Math.floor(sample.length * 0.02)]
  const hi = sample[Math.min(sample.length - 1, Math.floor(sample.length * 0.98))]
  if (!prev) return [lo, hi > lo ? hi : lo + 1]
  const next: [number, number] = [prev[0] * ease + lo * (1 - ease), prev[1] * ease + hi * (1 - ease)]
  if (next[1] <= next[0]) next[1] = next[0] + 1e-3
  return next
}

/** Raw depth → 0..255 over a range (nearer brighter). */
export function normalizeDepth(raw: Float32Array, [lo, hi]: [number, number]): Uint8Array {
  const out = new Uint8Array(raw.length)
  const k = 255 / Math.max(1e-6, hi - lo)
  for (let i = 0; i < raw.length; i++) out[i] = Math.max(0, Math.min(255, Math.round((raw[i] - lo) * k)))
  return out
}

/** Calms shimmer: where depth barely changed it blends with the frame before; where it moved (real motion) it doesn't. */
export function steadyDepth(d: Uint8Array, prev: Uint8Array | null) {
  if (!prev || prev.length !== d.length) return d
  for (let i = 0; i < d.length; i++) {
    const diff = d[i] - prev[i]
    if (diff > -24 && diff < 24) d[i] = (d[i] * 3 + prev[i] + 2) >> 2
  }
  return d
}

// ─── The worker ──────────────────────────────────────────────────────────

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, { resolve: (d: Float32Array) => void; reject: (e: Error) => void }>()
const progressListeners = new Set<(m: Extract<DepthMessage, { type: 'progress' | 'ready' }>) => void>()

/** Model download and start-up progress. */
export function onDepthProgress(fn: (m: Extract<DepthMessage, { type: 'progress' | 'ready' }>) => void) {
  progressListeners.add(fn)
  return () => void progressListeners.delete(fn)
}

const absolute = (url: string) => new URL(url, location.href).href
const config = (): DepthConfig => ({ model: DEPTH_MODEL, remoteHost: 'lumen-media://models/', ortMjs: absolute(ortMjs), ortWasm: absolute(ortWasm) })

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./depth.worker.ts', import.meta.url), { type: 'module', name: 'depth' })
    worker.onmessage = (e: MessageEvent<DepthMessage>) => {
      const m = e.data
      if (m.type === 'progress' || m.type === 'ready') progressListeners.forEach((fn) => fn(m))
      else if (m.type === 'result') {
        pending.get(m.id)?.resolve(m.depth)
        pending.delete(m.id)
      } else if (m.type === 'error') {
        pending.get(m.id)?.reject(new Error(m.message))
        pending.delete(m.id)
      }
    }
    worker.onerror = (e) => {
      for (const p of pending.values()) p.reject(new Error(e.message || 'The depth model crashed.'))
      pending.clear()
      worker?.terminate()
      worker = null
    }
  }
  return worker
}

/** Raw depth (bigger = nearer) for one RGBA frame. */
export function estimateDepth(rgba: Uint8ClampedArray, width: number, height: number): Promise<Float32Array> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    const copy = new Uint8ClampedArray(rgba)
    const req: DepthRequest = { type: 'depth', id, rgba: copy, width, height, config: config() }
    getWorker().postMessage(req, [copy.buffer])
  })
}

// ─── Depth maps for clips ────────────────────────────────────────────────

export interface DepthProgress {
  done: number
  total: number
}

function stretchOf(clip: Clip, asset: Asset, fps: number): [number, number] {
  const a = clipSourceTime(clip, 0, fps)
  const b = clipSourceTime(clip, clip.duration, fps)
  return [Math.max(0, Math.min(a, b) - 0.5), Math.min(asset.duration ?? Infinity, Math.max(a, b) + 0.5)]
}

function grayscale(ctx: CanvasRenderingContext2D, v: Uint8Array, width: number, height: number) {
  const img = ctx.createImageData(width, height)
  for (let i = 0; i < v.length; i++) {
    img.data[i * 4] = v[i]
    img.data[i * 4 + 1] = v[i]
    img.data[i * 4 + 2] = v[i]
    img.data[i * 4 + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
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

function addDepthAsset(asset: Asset, name: string, info: { path: string; url: string; name: string; size: number; mime: string; mtime: number }, media: { kind: 'video' | 'image'; width: number; height: number; fps?: number; duration?: number }, from: number, to: number) {
  const id = uid('asset')
  const depth: Asset = {
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
    depthOf: { assetId: asset.id, from, to },
    addedAt: Date.now(),
  }
  dispatch('asset.add', { asset: depth }, { history: false })
  return id
}

/**
 * Makes (or reuses) the depth map for a clip and returns what goes in its
 * `depth`. Video clips get a depth video over the stretch they show; stills a
 * depth image.
 */
export async function depthMap(clip: Clip, opts: { onProgress?: (p: DepthProgress) => void; signal?: AbortSignal } = {}): Promise<{ assetId: string; from: number }> {
  if (!desktop) throw new Error('Depth maps need Lumen’s desktop app.')
  const project = getProject()
  const asset = clip.assetId ? project.assets[clip.assetId] : undefined
  if (!asset || asset.kind === 'audio') throw new Error('Pick a video or image clip — there’s no picture to measure in this one.')
  if (asset.source.type !== 'file' || asset.source.missing) throw new Error(`“${asset.name}” is offline or isn’t a single file.`)
  const fps = project.settings.fps
  const [from, to] = asset.kind === 'image' ? [0, 0] : stretchOf(clip, asset, fps)
  const reuse = Object.values(project.assets).find((m) => m.depthOf?.assetId === asset.id && m.depthOf.from <= from + 1e-3 && m.depthOf.to >= to - 1e-3)
  if (reuse) return { assetId: reuse.id, from: reuse.depthOf!.from }
  const name = `${asset.name.replace(/\.[^.]+$/, '')} — depth map`

  if (asset.kind === 'image') {
    const img = await loadImage(asset.source.url)
    const width = Math.min(DEPTH_WIDTH * 2, img.naturalWidth)
    const height = Math.max(2, Math.round((width * img.naturalHeight) / img.naturalWidth))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    ctx.drawImage(img, 0, 0, width, height)
    opts.onProgress?.({ done: 0, total: 1 })
    const raw = await estimateDepth(ctx.getImageData(0, 0, width, height).data, width, height)
    grayscale(ctx, normalizeDepth(raw, depthRange(raw, null)), width, height)
    const blob = await new Promise<Blob>((r, x) => canvas.toBlob((b) => (b ? r(b) : x(new Error('Couldn’t save the depth map'))), 'image/png'))
    const info = await desktop.files.saveMedia('generated', `${name}.png`, new Uint8Array(await blob.arrayBuffer()))
    opts.onProgress?.({ done: 1, total: 1 })
    return { assetId: addDepthAsset(asset, name, info, { kind: 'image', width, height }, 0, 0), from: 0 }
  }

  const rate = Math.min(MAX_RATE, asset.fps ?? fps)
  const total = Math.max(1, Math.round((to - from) * rate))
  let canvas: HTMLCanvasElement | null = null
  let ctx: CanvasRenderingContext2D | null = null
  let output: Output | null = null
  let source: CanvasSource | null = null
  const target = new BufferTarget()
  let range: [number, number] | null = null
  let prev: Uint8Array | null = null
  let done = 0
  let last = -1
  let next = from
  let size = { width: 0, height: 0 }
  opts.onProgress?.({ done: 0, total })
  try {
    size = await scanFrames(
      asset.source.url,
      from,
      to,
      DEPTH_WIDTH,
      async (f) => {
        // Every frame is decoded; depth is measured at `rate`.
        if (f.t + 1e-4 < next) return
        next = f.t + 1 / rate
        if (!output) {
          canvas = document.createElement('canvas')
          canvas.width = f.width
          canvas.height = f.height
          ctx = canvas.getContext('2d', { willReadFrequently: true })!
          output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target })
          source = new CanvasSource(canvas, { codec: 'avc', bitrate: 2_000_000 * ((f.width * f.height) / (640 * 360)), keyFrameInterval: 1, latencyMode: 'quality' })
          output.addVideoTrack(source, { frameRate: rate })
          await output.start()
        }
        const raw = await estimateDepth(f.rgba, f.width, f.height)
        range = depthRange(raw, range)
        const depth = steadyDepth(normalizeDepth(raw, range), prev)
        prev = depth
        grayscale(ctx!, depth, f.width, f.height)
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
  return { assetId: addDepthAsset(asset, name, info, { kind: 'video', width: size.width, height: size.height, fps: rate, duration: done / rate }, from, to), from }
}

export interface RelightOptions {
  /** Light position (fractions of the frame), height, colour… — Relight's params; leave any out for its default. */
  params?: Record<string, number | string>
  /** Strength of the new light, 0–100. */
  amount?: number
  /** Make (or reuse) a depth map so the light follows the shapes in the shot (default true). */
  depth?: boolean
  onProgress?: (p: DepthProgress) => void
  signal?: AbortSignal
  source?: ActionSource
}

/**
 * Relights a clip: makes its depth map (unless asked not to), then adds the
 * Relight effect with it — one undo step.
 */
export async function relightClip(clipId: string, opts: RelightOptions = {}) {
  const clip = getProject().clips[clipId]
  if (!clip) throw new Error(`There’s no clip ${clipId}.`)
  if (clip.kind !== 'video' && clip.kind !== 'image' && clip.kind !== 'adjustment') throw new Error('Relight works on video, image and adjustment clips.')
  const depth = opts.depth !== false && clip.kind !== 'adjustment' && !clip.sequenceId ? await depthMap(clip, opts) : null
  const preset = EFFECTS.find((e) => e.kind === 'relight')!
  let error: string | null = null
  useEditor.getState().transaction('Relight', opts.source ?? 'user', () => {
    if (depth) {
      const res = dispatch('clip.update', { ids: [clipId], patch: { depth } })
      if (!res.ok) error = res.error
    }
    const res = dispatch('effect.add', { ids: [clipId], kind: 'relight', amount: opts.amount ?? preset.amount, params: { ...preset.params, ...opts.params } })
    if (!res.ok) error ??= res.error
  })
  if (error) throw new Error(error)
  return { depth: Boolean(depth) }
}

export { AnalysisCancelled }
