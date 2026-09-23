import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { GeneratedAsset, Job, TranscriptSegment } from '../../shared/integrations'
import { createJob, failJob, finishJob, setCanceller, updateJob } from './jobs'
import { ensureDir, mediaRoot, mediaUrl } from './paths'
import { getSecret, secretHint, setSecret } from './secrets'

/**
 * ElevenLabs, natively: voiceovers with character timings (so captions come
 * for free), Scribe transcription of real recordings, sound effects and
 * music. The API key lives in the encrypted secret store.
 */

const API = 'https://api.elevenlabs.io'
const KEY = 'elevenlabs'

export interface ElevenLabsVoice {
  id: string
  name: string
  category?: string
  labels?: Record<string, string>
  previewUrl?: string | null
}

export const elevenLabsState = () => {
  const key = getSecret(KEY)
  return { configured: Boolean(key), keyHint: secretHint(key) }
}

function key() {
  const k = getSecret(KEY)
  if (!k) throw new Error('Add your ElevenLabs API key in Integrations › ElevenLabs.')
  return k
}

/** ElevenLabs errors come as {detail:{message}}, {detail:[{msg}]} or {detail:"…"}. */
async function failure(res: Response) {
  let text = ''
  try {
    const json = (await res.json()) as { detail?: unknown }
    const d = json.detail
    text = typeof d === 'string' ? d : Array.isArray(d) ? d.map((x) => (x as { msg?: string }).msg).join('; ') : ((d as { message?: string })?.message ?? '')
  } catch {
    /* not JSON */
  }
  if (res.status === 401) return new Error('ElevenLabs rejected the API key.')
  if (res.status === 402) return new Error(text || 'This needs a paid ElevenLabs plan.')
  if (res.status === 429) return new Error('ElevenLabs is rate-limiting requests — try again in a moment.')
  return new Error(text || `ElevenLabs answered ${res.status}`)
}

async function call(pathname: string, init: RequestInit & { signal?: AbortSignal } = {}) {
  const res = await fetch(API + pathname, { ...init, headers: { 'xi-api-key': key(), ...(init.headers ?? {}) } })
  if (!res.ok) throw await failure(res)
  return res
}

export async function setElevenLabsKey(value: string | null) {
  if (!value) {
    setSecret(KEY, null)
    return elevenLabsState()
  }
  // Check it before keeping it.
  const res = await fetch(`${API}/v2/voices?page_size=1`, { headers: { 'xi-api-key': value.trim() }, signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw await failure(res)
  setSecret(KEY, value.trim())
  return elevenLabsState()
}

export async function listVoices(search?: string): Promise<ElevenLabsVoice[]> {
  const q = new URLSearchParams({ page_size: '100', sort: 'name' })
  if (search) q.set('search', search)
  const res = await call(`/v2/voices?${q}`, { signal: AbortSignal.timeout(15_000) })
  const json = (await res.json()) as { voices: { voice_id: string; name: string; category?: string; labels?: Record<string, string>; preview_url?: string | null }[] }
  return json.voices.map((v) => ({ id: v.voice_id, name: v.name, category: v.category, labels: v.labels, previewUrl: v.preview_url }))
}

// ─── Transcript shaping ──────────────────────────────────────────────────

interface Word {
  text: string
  start: number
  end: number
}

/** Groups words into caption-sized phrases: sentence ends, long pauses, or ~10 words. */
export function phrases(words: Word[]): TranscriptSegment[] {
  const out: TranscriptSegment[] = []
  let cur: Word[] = []
  const flush = () => {
    if (!cur.length) return
    out.push({ start: cur[0].start, end: cur[cur.length - 1].end, text: cur.map((w) => w.text).join(' ') })
    cur = []
  }
  words.forEach((w, i) => {
    const prev = words[i - 1]
    if (prev && cur.length && w.start - prev.end > 0.6) flush()
    cur.push(w)
    if (/[.!?…]["”')\]]*$/.test(w.text) || cur.length >= 10) flush()
  })
  flush()
  return out
}

/** Character alignment (TTS) → words. */
function wordsFromAlignment(a: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] }): Word[] {
  const words: Word[] = []
  let text = ''
  let start = 0
  let end = 0
  a.characters.forEach((ch, i) => {
    if (/\s/.test(ch)) {
      if (text) words.push({ text, start, end })
      text = ''
      return
    }
    if (!text) start = a.character_start_times_seconds[i]
    text += ch
    end = a.character_end_times_seconds[i]
  })
  if (text) words.push({ text, start, end })
  return words
}

// ─── Jobs ────────────────────────────────────────────────────────────────

const dir = () => ensureDir(path.join(mediaRoot(), 'elevenlabs'))
const slug = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 48)

function audioAsset(file: string, name: string, duration: number | undefined, tool: string, prompt: string, params: Record<string, unknown>, transcript?: TranscriptSegment[]): GeneratedAsset {
  return {
    name,
    kind: 'audio',
    source: { type: 'file', url: mediaUrl(file), path: file, mime: 'audio/mpeg', fileName: path.basename(file), size: fs.statSync(file).size },
    duration,
    transcript,
    provenance: { integration: 'elevenlabs', tool, prompt, params },
  }
}

function track<T>(title: string, work: (job: Job, signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController()
  const job = createJob('elevenlabs', title, () => controller.abort())
  setCanceller(job.id, () => controller.abort())
  updateJob(job.id, { message: 'Working…' })
  void work(job, controller.signal).catch((err) => {
    if (!controller.signal.aborted) failJob(job.id, err)
  })
  return job
}

export function speak(req: { text: string; voiceId: string; voiceName?: string; modelId?: string }): Job {
  const text = req.text.slice(0, 10_000)
  return track(`Voiceover — ${slug(text)}`, async (job, signal) => {
    const model = req.modelId ?? 'eleven_multilingual_v2'
    const res = await call(`/v1/text-to-speech/${encodeURIComponent(req.voiceId)}/with-timestamps?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model_id: model }),
      signal,
    })
    const json = (await res.json()) as {
      audio_base64: string
      alignment?: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] }
      normalized_alignment?: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] }
    }
    const file = path.join(dir(), `${randomUUID()}.mp3`)
    fs.writeFileSync(file, Buffer.from(json.audio_base64, 'base64'))
    const align = json.alignment ?? json.normalized_alignment
    const words = align ? wordsFromAlignment(align) : []
    const duration = align?.character_end_times_seconds.at(-1)
    const name = `Voice — ${req.voiceName ?? 'ElevenLabs'} · ${slug(text).slice(0, 28)}`
    finishJob(job.id, { assets: [audioAsset(file, name, duration, 'text-to-speech', text, { voiceId: req.voiceId, model }, phrases(words))], message: `${words.length} words` })
  })
}

export function soundEffect(req: { prompt: string; durationSeconds?: number; loop?: boolean }): Job {
  return track(`Sound — ${slug(req.prompt)}`, async (job, signal) => {
    const body: Record<string, unknown> = { text: req.prompt, model_id: 'eleven_text_to_sound_v2', loop: Boolean(req.loop) }
    if (req.durationSeconds) body.duration_seconds = Math.min(30, Math.max(0.5, req.durationSeconds))
    const res = await call('/v1/sound-generation?output_format=mp3_44100_128', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal })
    const file = path.join(dir(), `${randomUUID()}.mp3`)
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()))
    finishJob(job.id, { assets: [audioAsset(file, `SFX — ${slug(req.prompt)}`, undefined, 'sound-effect', req.prompt, body)] })
  })
}

export function music(req: { prompt: string; lengthSeconds: number; instrumental?: boolean }): Job {
  return track(`Music — ${slug(req.prompt)}`, async (job, signal) => {
    updateJob(job.id, { message: 'Composing…' })
    const body = { prompt: req.prompt, music_length_ms: Math.round(Math.min(600, Math.max(3, req.lengthSeconds)) * 1000), force_instrumental: Boolean(req.instrumental), model_id: 'music_v2_5' }
    const res = await call('/v1/music?output_format=mp3_44100_128', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal })
    const file = path.join(dir(), `${randomUUID()}.mp3`)
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()))
    finishJob(job.id, { assets: [audioAsset(file, `Music — ${slug(req.prompt)}`, body.music_length_ms / 1000, 'music', req.prompt, body)] })
  })
}

/** Scribe v2 over a WAV the editor extracted from the asset; resolves with phrase timings. */
export function transcribe(req: { wav: ArrayBuffer; name: string; languageCode?: string }): Job {
  return track(`Transcribe — ${slug(req.name)}`, async (job, signal) => {
    updateJob(job.id, { message: 'Transcribing…' })
    const form = new FormData()
    form.set('model_id', 'scribe_v2')
    form.set('timestamps_granularity', 'word')
    form.set('tag_audio_events', 'false')
    if (req.languageCode) form.set('language_code', req.languageCode)
    form.set('file', new Blob([req.wav], { type: 'audio/wav' }), 'audio.wav')
    const res = await call('/v1/speech-to-text', { method: 'POST', body: form, signal })
    const json = (await res.json()) as { text: string; language_code?: string; words?: { text: string; start: number; end: number; type: string }[] }
    const words = (json.words ?? []).filter((w) => w.type === 'word').map((w) => ({ text: w.text.trim(), start: w.start, end: w.end }))
    const segments = phrases(words)
    finishJob(job.id, { transcript: segments, message: `${segments.length} phrases · ${json.language_code ?? 'auto'}` })
  })
}
