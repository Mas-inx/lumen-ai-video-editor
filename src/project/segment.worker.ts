/**
 * Subject segmentation on this computer (transformers.js / ONNX Runtime), off
 * the UI thread: for each frame, a matte of the person (MODNet) or the main
 * subject (BiRefNet). WebGPU when the GPU supports it, WebAssembly otherwise.
 */
import { env, pipeline, RawImage } from '@huggingface/transformers'

export interface SegmentConfig {
  model: string
  /** Prefer WebGPU (BiRefNet needs it to be usable). */
  needsGpu: boolean
  remoteHost: string
  ortMjs: string
  ortWasm: string
}

export type SegmentRequest = { type: 'segment'; id: number; rgba: Uint8ClampedArray; width: number; height: number; config: SegmentConfig }

export type SegmentMessage =
  | { type: 'progress'; status: string; file?: string; loaded?: number; total?: number; progress?: number }
  | { type: 'ready'; device: string }
  | { type: 'result'; id: number; alpha: Uint8Array }
  | { type: 'error'; id: number; message: string }

const post = (m: SegmentMessage, transfer: Transferable[] = []) => (self as unknown as { postMessage(message: unknown, transfer: Transferable[]): void }).postMessage(m, transfer)

type Remover = (image: RawImage) => Promise<RawImage>
let loaded: { model: string; run: Promise<Remover> } | null = null

async function gpuAvailable() {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
  if (!gpu) return false
  try {
    return Boolean(await gpu.requestAdapter())
  } catch {
    return false
  }
}

function load(config: SegmentConfig) {
  if (loaded?.model === config.model) return loaded.run
  env.allowLocalModels = false
  env.useBrowserCache = false
  env.useWasmCache = false
  // Model files come through Lumen's proxy, which keeps a copy on disk (download once, then offline).
  env.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    return fetch(url.replace(/^https:\/\/huggingface\.co\//, config.remoteHost), init)
  }) as typeof fetch
  const onnx = env.backends.onnx as { wasm?: { wasmPaths?: unknown } }
  if (onnx.wasm) onnx.wasm.wasmPaths = { mjs: config.ortMjs, wasm: config.ortWasm }
  const run = (async () => {
    const gpu = await gpuAvailable()
    if (config.needsGpu && !gpu) throw new Error('Cutting out any subject needs a GPU with WebGPU. Cut out a person instead — that runs anywhere.')
    const device = gpu ? 'webgpu' : 'wasm'
    const remover = (await pipeline('background-removal', config.model, {
      device,
      dtype: gpu ? 'fp32' : 'q8',
      progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number; progress?: number }) =>
        post({ type: 'progress', status: p.status, file: p.file, loaded: p.loaded, total: p.total, progress: p.progress }),
    })) as unknown as Remover
    post({ type: 'ready', device })
    return remover
  })()
  loaded = { model: config.model, run }
  run.catch(() => {
    if (loaded?.run === run) loaded = null
  })
  return run
}

self.onmessage = async (e: MessageEvent<SegmentRequest>) => {
  const msg = e.data
  if (msg.type !== 'segment') return
  try {
    const remove = await load(msg.config)
    const out = await remove(new RawImage(msg.rgba, msg.width, msg.height, 4))
    // The cut-out comes back as RGBA at the input size: its alpha is the matte.
    const rgba = out.data as Uint8ClampedArray | Uint8Array
    const alpha = new Uint8Array(msg.width * msg.height)
    const channels = out.channels
    for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * channels + (channels - 1)]
    post({ type: 'result', id: msg.id, alpha }, [alpha.buffer])
  } catch (err) {
    post({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) })
  }
}
