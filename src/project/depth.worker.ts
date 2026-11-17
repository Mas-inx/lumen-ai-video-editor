/**
 * Depth estimation on this computer (transformers.js / ONNX Runtime), off the
 * UI thread: for each frame, how near each point of the picture is (Depth
 * Anything V2, small). On the graphics card (WebGPU) when it can run the
 * model, on the processor (WebAssembly) otherwise. The raw prediction comes
 * back (relative inverse depth: bigger is nearer), not the per-frame
 * normalized picture, so the editor can keep the range steady across frames.
 */
import { env, pipeline, RawImage } from '@huggingface/transformers'

export interface DepthConfig {
  model: string
  remoteHost: string
  ortMjs: string
  ortWasm: string
}

export type DepthRequest = { type: 'depth'; id: number; rgba: Uint8ClampedArray; width: number; height: number; config: DepthConfig }

export type DepthMessage =
  | { type: 'progress'; status: string; file?: string; loaded?: number; total?: number; progress?: number }
  | { type: 'ready'; device: string }
  | { type: 'result'; id: number; depth: Float32Array }
  | { type: 'error'; id: number; message: string }

const post = (m: DepthMessage, transfer: Transferable[] = []) => (self as unknown as { postMessage(message: unknown, transfer: Transferable[]): void }).postMessage(m, transfer)

type Device = 'webgpu' | 'wasm'
type Estimator = (image: RawImage) => Promise<{ predicted_depth: { data: ArrayLike<number>; dims: number[] } }>
let loaded: { model: string; device: Device; run: Promise<Estimator> } | null = null

/** Models this graphics card turned out not to run: on the processor for the rest of the session. */
const offGpu = new Set<string>()
let gpu: Promise<boolean> | null = null

function gpuAvailable() {
  gpu ??= (async () => {
    const api = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
    if (!api) return false
    try {
      return Boolean(await api.requestAdapter())
    } catch {
      return false
    }
  })()
  return gpu
}

function load(config: DepthConfig, device: Device) {
  if (loaded?.model === config.model && loaded.device === device) return loaded.run
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
    const estimator = (await pipeline('depth-estimation', config.model, {
      device,
      // Full precision runs on every card; the processor runs the quantized file much faster.
      dtype: device === 'webgpu' ? 'fp32' : 'q8',
      progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number; progress?: number }) =>
        post({ type: 'progress', status: p.status, file: p.file, loaded: p.loaded, total: p.total, progress: p.progress }),
    })) as unknown as Estimator
    post({ type: 'ready', device })
    return estimator
  })()
  loaded = { model: config.model, device, run }
  run.catch(() => {
    if (loaded?.run === run) loaded = null
  })
  return run
}

/** What a failure deep in the model runtime comes down to, without its file paths and codes. */
function plain(err: unknown) {
  const text = err instanceof Error ? err.message : String(err)
  const runtime = /ERROR_MESSAGE:\s*(.*)$/s.exec(text)?.[1]
  if (runtime === undefined) return text
  const tail = /\bwas false\.\s*(.+)$/s.exec(runtime)?.[1] ?? runtime.replace(/^\S*\.(?:cc|h):\d+\s+/, '')
  return tail.replace(/\s+/g, ' ').trim().slice(0, 240)
}

async function estimate(msg: DepthRequest) {
  const { config } = msg
  const image = () => new RawImage(msg.rgba, msg.width, msg.height, 4)
  if (!offGpu.has(config.model) && (await gpuAvailable())) {
    try {
      return await (await load(config, 'webgpu'))(image())
    } catch {
      // Not every card runs every model. The processor does, so it takes over.
      offGpu.add(config.model)
      loaded = null
    }
  }
  return (await load(config, 'wasm'))(image())
}

self.onmessage = async (e: MessageEvent<DepthRequest>) => {
  const msg = e.data
  if (msg.type !== 'depth') return
  try {
    const out = await estimate(msg)
    const data = out.predicted_depth.data
    const depth = new Float32Array(msg.width * msg.height)
    // The pipeline already scaled the prediction to the input's size.
    for (let i = 0; i < depth.length; i++) depth[i] = Number(data[i] ?? 0)
    post({ type: 'result', id: msg.id, depth }, [depth.buffer])
  } catch (err) {
    post({ type: 'error', id: msg.id, message: plain(err) })
  }
}
