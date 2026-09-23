/**
 * On-device transcription: Whisper in a worker. The model downloads once
 * (through Lumen's cache, ~75 MB) and then works offline. Long recordings are
 * split at silences into ~30 s windows so no word is cut in half.
 */
import ortMjs from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url'
import ortWasm from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url'
import type { TranscriptSegment } from '@shared/integrations'
import { activeRegions } from '@/engine/audio-engine'
import { resample } from '@/engine/wav'
import type { WhisperConfig, WhisperMessage, WhisperRequest } from './whisper.worker'

export const WHISPER_MODEL = 'onnx-community/whisper-base'

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, { resolve: (c: TranscriptSegment[]) => void; reject: (e: Error) => void }>()
const progressListeners = new Set<(m: Extract<WhisperMessage, { type: 'progress' | 'ready' }>) => void>()

export function onWhisperProgress(fn: (m: Extract<WhisperMessage, { type: 'progress' | 'ready' }>) => void) {
  progressListeners.add(fn)
  return () => void progressListeners.delete(fn)
}

const absolute = (url: string) => new URL(url, location.href).href

function config(): WhisperConfig {
  return { model: WHISPER_MODEL, remoteHost: 'lumen-media://models/', ortMjs: absolute(ortMjs), ortWasm: absolute(ortWasm) }
}

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module', name: 'whisper' })
    worker.onmessage = (e: MessageEvent<WhisperMessage>) => {
      const m = e.data
      if (m.type === 'progress' || m.type === 'ready') progressListeners.forEach((fn) => fn(m))
      else if (m.type === 'result') {
        pending.get(m.id)?.resolve(m.chunks)
        pending.delete(m.id)
      } else if (m.type === 'error') {
        pending.get(m.id)?.reject(new Error(m.message))
        pending.delete(m.id)
      }
    }
    worker.onerror = (e) => {
      for (const p of pending.values()) p.reject(new Error(e.message || 'The speech model crashed.'))
      pending.clear()
      worker?.terminate()
      worker = null
    }
  }
  return worker
}

function run(audio: Float32Array, language?: string): Promise<TranscriptSegment[]> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    const req: WhisperRequest = { type: 'transcribe', id, audio, language, config: config() }
    getWorker().postMessage(req, [audio.buffer])
  })
}

/** Windows of at most ~30 s that start and end in silence where possible. */
function windows(buffer: AudioBuffer): [number, number][] {
  const regions = activeRegions(buffer, { minSilence: 0.25 })
  const out: [number, number][] = []
  let start = 0
  let lastGap: number | null = null
  for (let i = 0; i < regions.length; i++) {
    const [, end] = regions[i]
    const next = regions[i + 1]
    const gap = next ? (end + next[0]) / 2 : buffer.duration
    if (gap - start > 28) {
      const cut = lastGap && lastGap - start > 8 ? lastGap : Math.min(gap, start + 28)
      out.push([start, cut])
      start = cut
    }
    lastGap = gap
  }
  if (buffer.duration - start > 0.2) out.push([start, buffer.duration])
  return out.length ? out : [[0, buffer.duration]]
}

export async function transcribeLocally(buffer: AudioBuffer, opts: { language?: string; onProgress?: (p: number) => void }): Promise<TranscriptSegment[]> {
  const mono = await resample(buffer, 16000, 1)
  const pcm = mono.getChannelData(0)
  const parts = windows(mono)
  const total = parts.reduce((s, [a, b]) => s + (b - a), 0)
  const out: TranscriptSegment[] = []
  let done = 0
  for (const [a, b] of parts) {
    const slice = pcm.slice(Math.floor(a * 16000), Math.ceil(b * 16000))
    // Skip windows that are all silence.
    let peak = 0
    for (let i = 0; i < slice.length; i += 16) peak = Math.max(peak, Math.abs(slice[i]))
    if (peak > 0.01) {
      const segs = await run(slice, opts.language)
      for (const s of segs) out.push({ start: Math.round((s.start + a) * 1000) / 1000, end: Math.round((Math.min(s.end, b - a) + a) * 1000) / 1000, text: s.text })
    }
    done += b - a
    opts.onProgress?.(done / total)
  }
  return out
}
