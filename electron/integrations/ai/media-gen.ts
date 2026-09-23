import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { net } from 'electron'
import type { GeneratedAsset, ImageGenRequest, Job, MediaModels, VideoGenRequest } from '../../../shared/integrations'
import { createJob, failJob, finishJob, isCancelled, updateJob } from '../jobs'
import { ensureDir, mediaRoot, mediaUrl } from '../paths'
import { providerBaseURL, providerKey } from './providers'

/**
 * Image and video generation with the user's own OpenAI / Google keys.
 * Each generation is a job; the finished file lands in Lumen's media library.
 */

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function openaiBase() {
  return providerBaseURL('openai') || 'https://api.openai.com/v1'
}

function keyFor(provider: 'openai' | 'gemini') {
  const key = providerKey(provider)
  if (!key) throw new Error(`Add ${provider === 'openai' ? 'an OpenAI' : 'a Google Gemini'} API key in Integrations › AI models first.`)
  return key
}

async function apiError(res: Response, who: string) {
  let detail = ''
  try {
    const body = (await res.json()) as { error?: { message?: string } | string }
    detail = typeof body.error === 'string' ? body.error : (body.error?.message ?? '')
  } catch {
    /* not JSON */
  }
  if (res.status === 401 || res.status === 403) return new Error(`${who} rejected the API key${detail ? `: ${detail}` : '.'}`)
  if (res.status === 429) return new Error(`${who} is rate-limiting this key (or it's out of credit)${detail ? `: ${detail}` : '.'}`)
  return new Error(`${who} error ${res.status}${detail ? `: ${detail}` : ''}`)
}

const outDir = () => ensureDir(path.join(mediaRoot(), 'generated'))

function fileAsset(abs: string, kind: GeneratedAsset['kind'], mime: string, name: string, prompt: string, provider: string, model: string, extra: Partial<GeneratedAsset> = {}): GeneratedAsset {
  return {
    name,
    kind,
    source: { type: 'file', url: mediaUrl(abs), path: abs, mime, fileName: path.basename(abs), size: fs.statSync(abs).size },
    provenance: { integration: provider, tool: model, prompt },
    ...extra,
  }
}

const nameFrom = (prompt: string) =>
  prompt
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .join(' ')
    .replace(/^./, (c) => c.toUpperCase()) || 'Generated'

// ─── Model lists ─────────────────────────────────────────────────────────

const modelCache = new Map<string, { at: number; value: MediaModels }>()

/** Image and video models this key can use (read from the provider, so new models just appear). */
export async function mediaModels(provider: 'openai' | 'gemini', refresh = false): Promise<MediaModels> {
  const hit = modelCache.get(provider)
  if (hit && !refresh && Date.now() - hit.at < 10 * 60_000) return hit.value
  const key = keyFor(provider)
  let value: MediaModels
  if (provider === 'openai') {
    const res = await net.fetch(`${openaiBase()}/models`, { headers: { Authorization: `Bearer ${key}` } })
    if (!res.ok) throw await apiError(res, 'OpenAI')
    const ids = ((await res.json()) as { data: { id: string }[] }).data.map((m) => m.id).sort().reverse()
    value = { image: ids.filter((id) => /^(gpt-image|dall-e-3)/.test(id)), video: ids.filter((id) => /^sora/.test(id)) }
  } else {
    const res = await net.fetch(`${GEMINI}/models?pageSize=1000`, { headers: { 'x-goog-api-key': key } })
    if (!res.ok) throw await apiError(res, 'Google')
    const models = ((await res.json()) as { models: { name: string; supportedGenerationMethods?: string[] }[] }).models
    const id = (m: { name: string }) => m.name.replace(/^models\//, '')
    value = {
      image: models.filter((m) => /image/.test(id(m)) && !/imagen/.test(id(m)) && m.supportedGenerationMethods?.includes('generateContent')).map(id).sort().reverse(),
      video: models.filter((m) => /^veo/.test(id(m))).map(id).sort().reverse(),
    }
  }
  modelCache.set(provider, { at: Date.now(), value })
  return value
}

// ─── Images ──────────────────────────────────────────────────────────────

const openaiSize = (aspect: ImageGenRequest['aspect'], model: string) => {
  if (model.startsWith('dall-e')) return aspect === '16:9' ? '1792x1024' : aspect === '9:16' ? '1024x1792' : '1024x1024'
  return aspect === '16:9' ? '1536x1024' : aspect === '9:16' ? '1024x1536' : '1024x1024'
}

interface ImageOut {
  abs: string
  mime: string
  width?: number
  height?: number
}

async function imageWithOpenAI(req: ImageGenRequest, signal: AbortSignal): Promise<ImageOut> {
  const key = keyFor('openai')
  const size = openaiSize(req.aspect, req.model)
  const body: Record<string, unknown> = { model: req.model, prompt: req.prompt, size, n: 1 }
  if (req.model.startsWith('dall-e')) Object.assign(body, { response_format: 'b64_json', quality: 'hd' })
  else body.quality = req.quality ?? 'high'
  const res = await net.fetch(`${openaiBase()}/images/generations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) throw await apiError(res, 'OpenAI')
  const item = ((await res.json()) as { data: { b64_json?: string; url?: string }[] }).data[0]
  const abs = path.join(outDir(), `${randomUUID()}.png`)
  if (item?.b64_json) fs.writeFileSync(abs, Buffer.from(item.b64_json, 'base64'))
  else if (item?.url) await download(item.url, abs, {}, signal)
  else throw new Error('OpenAI returned no image.')
  const [w, h] = size.split('x').map(Number)
  return { abs, mime: 'image/png', width: w, height: h }
}

async function imageWithGemini(req: ImageGenRequest, signal: AbortSignal): Promise<ImageOut> {
  const key = keyFor('gemini')
  const call = (withAspect: boolean) =>
    net.fetch(`${GEMINI}/models/${encodeURIComponent(req.model)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'], ...(withAspect ? { imageConfig: { aspectRatio: req.aspect } } : {}) },
      }),
      signal,
    })
  let res = await call(true)
  // Older image models don't take an aspect ratio.
  if (res.status === 400) res = await call(false)
  if (!res.ok) throw await apiError(res, 'Google')
  type Part = { text?: string; inlineData?: { mimeType: string; data: string }; inline_data?: { mime_type: string; data: string } }
  const json = (await res.json()) as { candidates?: { content?: { parts?: Part[] }; finishReason?: string }[]; promptFeedback?: { blockReason?: string } }
  if (json.promptFeedback?.blockReason) throw new Error(`Google declined this prompt (${json.promptFeedback.blockReason}).`)
  const parts = json.candidates?.[0]?.content?.parts ?? []
  const img = parts.map((p) => p.inlineData ?? (p.inline_data ? { mimeType: p.inline_data.mime_type, data: p.inline_data.data } : undefined)).find(Boolean)
  if (!img) throw new Error(parts.find((p) => p.text)?.text?.slice(0, 200) ?? 'Google returned no image.')
  const ext = img.mimeType === 'image/jpeg' ? '.jpg' : img.mimeType === 'image/webp' ? '.webp' : '.png'
  const abs = path.join(outDir(), `${randomUUID()}${ext}`)
  fs.writeFileSync(abs, Buffer.from(img.data, 'base64'))
  return { abs, mime: img.mimeType }
}

export function generateImage(req: ImageGenRequest): Job {
  const controller = new AbortController()
  const job = createJob('ai', `Image · ${nameFrom(req.prompt)}`, () => controller.abort())
  void (async () => {
    updateJob(job.id, { message: `Generating with ${req.model}…` })
    const out = req.provider === 'openai' ? await imageWithOpenAI(req, controller.signal) : await imageWithGemini(req, controller.signal)
    if (isCancelled(job.id)) return
    finishJob(job.id, { message: 'Done', assets: [fileAsset(out.abs, 'image', out.mime, nameFrom(req.prompt), req.prompt, req.provider, req.model, { width: out.width, height: out.height })] })
  })().catch((err) => !isCancelled(job.id) && failJob(job.id, err))
  return job
}

// ─── Video ───────────────────────────────────────────────────────────────

async function download(url: string, abs: string, headers: Record<string, string>, signal: AbortSignal) {
  const res = await net.fetch(url, { headers, signal })
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`)
  await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), fs.createWriteStream(abs))
}

async function videoWithOpenAI(req: VideoGenRequest, jobId: string, signal: AbortSignal) {
  const key = keyFor('openai')
  const form = new FormData()
  form.append('model', req.model)
  form.append('prompt', req.prompt)
  form.append('size', req.aspect === '9:16' ? '720x1280' : '1280x720')
  form.append('seconds', String(req.seconds))
  const auth = { Authorization: `Bearer ${key}` }
  const res = await net.fetch(`${openaiBase()}/videos`, { method: 'POST', headers: auth, body: form, signal })
  if (!res.ok) throw await apiError(res, 'OpenAI')
  const { id } = (await res.json()) as { id: string }
  for (;;) {
    await sleep(4000)
    if (signal.aborted) throw new Error('Cancelled')
    const s = await net.fetch(`${openaiBase()}/videos/${id}`, { headers: auth, signal })
    if (!s.ok) throw await apiError(s, 'OpenAI')
    const v = (await s.json()) as { status: string; progress?: number; error?: { message?: string } }
    if (v.status === 'failed') throw new Error(v.error?.message ?? 'OpenAI couldn’t generate this video.')
    updateJob(jobId, { progress: typeof v.progress === 'number' ? Math.min(0.95, v.progress / 100) : -1, message: v.status === 'queued' ? 'Queued…' : 'Generating…' })
    if (v.status === 'completed') break
  }
  const abs = path.join(outDir(), `${randomUUID()}.mp4`)
  updateJob(jobId, { message: 'Downloading…' })
  await download(`${openaiBase()}/videos/${id}/content`, abs, auth, signal)
  return abs
}

async function videoWithVeo(req: VideoGenRequest, jobId: string, signal: AbortSignal) {
  const key = keyFor('gemini')
  const headers = { 'x-goog-api-key': key, 'Content-Type': 'application/json' }
  const res = await net.fetch(`${GEMINI}/models/${encodeURIComponent(req.model)}:predictLongRunning`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      instances: [{ prompt: req.prompt }],
      parameters: { aspectRatio: req.aspect, durationSeconds: req.seconds, ...(req.resolution ? { resolution: req.resolution } : {}) },
    }),
    signal,
  })
  if (!res.ok) throw await apiError(res, 'Google')
  const { name } = (await res.json()) as { name: string }
  const started = Date.now()
  let uri: string | undefined
  for (;;) {
    await sleep(6000)
    if (signal.aborted) throw new Error('Cancelled')
    const s = await net.fetch(`${GEMINI}/${name}`, { headers, signal })
    if (!s.ok) throw await apiError(s, 'Google')
    type Op = { done?: boolean; error?: { message?: string }; response?: { generateVideoResponse?: { generatedSamples?: { video?: { uri?: string } }[]; raiMediaFilteredReasons?: string[] } } }
    const op = (await s.json()) as Op
    if (op.error) throw new Error(op.error.message ?? 'Google couldn’t generate this video.')
    // Veo takes roughly a minute or two: show time-based progress while we wait.
    updateJob(jobId, { progress: Math.min(0.9, (Date.now() - started) / 120_000), message: 'Generating…' })
    if (op.done) {
      const r = op.response?.generateVideoResponse
      uri = r?.generatedSamples?.[0]?.video?.uri
      if (!uri) throw new Error(r?.raiMediaFilteredReasons?.[0] ?? 'Google returned no video (the prompt may have been filtered).')
      break
    }
  }
  const abs = path.join(outDir(), `${randomUUID()}.mp4`)
  updateJob(jobId, { message: 'Downloading…' })
  await download(uri, abs, { 'x-goog-api-key': key }, signal)
  return abs
}

export function generateVideo(req: VideoGenRequest): Job {
  const controller = new AbortController()
  const job = createJob('ai', `Video · ${nameFrom(req.prompt)}`, () => controller.abort())
  void (async () => {
    updateJob(job.id, { message: `Starting ${req.model}…` })
    const abs = req.provider === 'openai' ? await videoWithOpenAI(req, job.id, controller.signal) : await videoWithVeo(req, job.id, controller.signal)
    if (isCancelled(job.id)) return
    finishJob(job.id, { message: 'Done', assets: [fileAsset(abs, 'video', 'video/mp4', nameFrom(req.prompt), req.prompt, req.provider, req.model)] })
  })().catch((err) => !isCancelled(job.id) && failJob(job.id, err))
  return job
}
