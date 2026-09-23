/**
 * Whisper speech recognition on this computer (transformers.js / ONNX Runtime),
 * off the UI thread. WebGPU when the GPU supports it, WebAssembly otherwise.
 */
import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers'

export interface WhisperConfig {
  model: string
  remoteHost: string
  ortMjs: string
  ortWasm: string
}

export type WhisperRequest = { type: 'transcribe'; id: number; audio: Float32Array; language?: string; config: WhisperConfig }

export type WhisperMessage =
  | { type: 'progress'; status: string; file?: string; loaded?: number; total?: number; progress?: number }
  | { type: 'ready'; device: string }
  | { type: 'result'; id: number; chunks: { start: number; end: number; text: string }[] }
  | { type: 'error'; id: number; message: string }

const post = (m: WhisperMessage) => (self as unknown as { postMessage(message: unknown): void }).postMessage(m)

let asr: Promise<AutomaticSpeechRecognitionPipeline> | null = null

async function gpuAvailable() {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
  if (!gpu) return false
  try {
    return Boolean(await gpu.requestAdapter())
  } catch {
    return false
  }
}

function load(config: WhisperConfig) {
  if (!asr) {
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
    asr = (async () => {
      const device = (await gpuAvailable()) ? 'webgpu' : 'wasm'
      const model = (await pipeline('automatic-speech-recognition', config.model, {
        device,
        dtype: device === 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8',
        progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number; progress?: number }) =>
          post({ type: 'progress', status: p.status, file: p.file, loaded: p.loaded, total: p.total, progress: p.progress }),
      })) as AutomaticSpeechRecognitionPipeline
      post({ type: 'ready', device })
      return model
    })()
    asr.catch(() => {
      asr = null
    })
  }
  return asr
}

self.onmessage = async (e: MessageEvent<WhisperRequest>) => {
  const msg = e.data
  if (msg.type !== 'transcribe') return
  try {
    const run = await load(msg.config)
    const duration = msg.audio.length / 16000
    const out = (await run(msg.audio, {
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5,
      ...(msg.language ? { language: msg.language } : {}),
      task: 'transcribe',
    })) as { text: string; chunks?: { timestamp: [number, number | null]; text: string }[] }
    const chunks = (out.chunks?.length ? out.chunks : [{ timestamp: [0, duration] as [number, number | null], text: out.text }])
      .map((c) => ({ start: c.timestamp[0] ?? 0, end: c.timestamp[1] ?? duration, text: c.text.trim() }))
      .filter((c) => c.text && !/^\[(blank_audio|music|silence)\]$/i.test(c.text))
    post({ type: 'result', id: msg.id, chunks })
  } catch (err) {
    post({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) })
  }
}
