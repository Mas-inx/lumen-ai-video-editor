/**
 * Subject segmentation on this computer (transformers.js / ONNX Runtime), off
 * the UI thread: for each frame, a matte of the person (MODNet) or the main
 * subject (IS-Net). On the graphics card (WebGPU) when it can run the model,
 * on the processor (WebAssembly) otherwise.
 */
import { env, pipeline, RawImage } from '@huggingface/transformers'

export interface SegmentConfig {
  model: string
  /** Too slow on the processor to be worth starting (seconds a frame): without a graphics card that takes it, say so instead. */
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

type Device = 'webgpu' | 'wasm'
type Remover = (image: RawImage) => Promise<RawImage>
let loaded: { model: string; device: Device; run: Promise<Remover> } | null = null

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

function load(config: SegmentConfig, device: Device) {
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
    const remover = (await pipeline('background-removal', config.model, {
      device,
      // The full-precision file is the one every model has; the small model also comes quantized, which the processor runs faster.
      dtype: device === 'webgpu' || config.needsGpu ? 'fp32' : 'q8',
      progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number; progress?: number }) =>
        post({ type: 'progress', status: p.status, file: p.file, loaded: p.loaded, total: p.total, progress: p.progress }),
    })) as unknown as Remover
    post({ type: 'ready', device })
    return remover
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
  // "…/shader_helper.cc:308 Type Class::Method(args) condition was false. The actual problem" → the actual problem.
  const tail = /\bwas false\.\s*(.+)$/s.exec(runtime)?.[1] ?? runtime.replace(/^\S*\.(?:cc|h):\d+\s+/, '')
  return tail.replace(/\s+/g, ' ').trim().slice(0, 240)
}

async function segment(msg: SegmentRequest): Promise<RawImage> {
  const { config } = msg
  const image = () => new RawImage(msg.rgba, msg.width, msg.height, 4)
  const onGpu = !offGpu.has(config.model) && (await gpuAvailable())
  if (onGpu) {
    try {
      return await (await load(config, 'webgpu'))(image())
    } catch (err) {
      // Not every card runs every model. The processor does, so it takes over for this one.
      offGpu.add(config.model)
      loaded = null
      if (config.needsGpu) throw new Error(`This computer’s graphics card couldn’t run the any-subject model (${plain(err)}). Cut out a person instead — that runs on any computer.`)
    }
  } else if (config.needsGpu) {
    throw new Error(
      offGpu.has(config.model)
        ? 'This computer’s graphics card can’t run the any-subject model. Cut out a person instead — that runs on any computer.'
        : 'Cutting out any subject needs a graphics card with WebGPU. Cut out a person instead — that runs on any computer.',
    )
  }
  return (await load(config, 'wasm'))(image())
}

self.onmessage = async (e: MessageEvent<SegmentRequest>) => {
  const msg = e.data
  if (msg.type !== 'segment') return
  try {
    const out = await segment(msg)
    // The cut-out comes back as RGBA at the input size: its alpha is the matte.
    const rgba = out.data as Uint8ClampedArray | Uint8Array
    const alpha = new Uint8Array(msg.width * msg.height)
    const channels = out.channels
    for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * channels + (channels - 1)]
    post({ type: 'result', id: msg.id, alpha }, [alpha.buffer])
  } catch (err) {
    post({ type: 'error', id: msg.id, message: plain(err) })
  }
}
