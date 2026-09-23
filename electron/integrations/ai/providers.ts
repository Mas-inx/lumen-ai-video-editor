import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogle } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import type { LanguageModel } from 'ai'
import { PROVIDERS, type ModelInfo, type ProviderId, type ProviderSpec, type ProviderState } from '../../../shared/ai'
import { readJson, writeJson } from '../paths'
import { getSecret, secretHint, setSecret } from '../secrets'

/**
 * Model providers for the Copilot. Keys live in the encrypted secret store;
 * calls are made from the main process with the Vercel AI SDK.
 */

const SETTINGS = 'ai-providers.json'

interface ProviderSettings {
  baseURL?: string
  via?: 'key' | 'oauth'
}

const settings = () => readJson<Partial<Record<ProviderId, ProviderSettings>>>(SETTINGS, {})
const keyName = (id: ProviderId) => `ai:${id}`
export const spec = (id: ProviderId): ProviderSpec => {
  const s = PROVIDERS.find((p) => p.id === id)
  if (!s) throw new Error(`Unknown provider: ${id}`)
  return s
}

function baseURL(id: ProviderId) {
  return (settings()[id]?.baseURL || spec(id).defaultBaseURL || '').replace(/\/+$/, '')
}

/** A provider's stored key (main process only — never sent to the editor). */
export const providerKey = (id: ProviderId) => getSecret(keyName(id))
export const providerBaseURL = (id: ProviderId) => baseURL(id)

export function providerState(id: ProviderId): ProviderState {
  const s = spec(id)
  const key = getSecret(keyName(id))
  const url = baseURL(id)
  // Local servers count once the user has connected them (their default URL alone isn't a setup).
  const configured = s.local ? Boolean(settings()[id]?.baseURL) : s.needsBaseURL ? Boolean(url) : Boolean(key)
  return { id, configured, keyHint: secretHint(key), baseURL: url || undefined, via: key ? (settings()[id]?.via ?? 'key') : undefined }
}

export const providerStates = () => PROVIDERS.map((p) => providerState(p.id))

export function setProvider(id: ProviderId, patch: { key?: string | null; baseURL?: string | null; via?: 'key' | 'oauth' }): ProviderState {
  spec(id)
  if (patch.key !== undefined) setSecret(keyName(id), patch.key?.trim() || null)
  const all = settings()
  const next: ProviderSettings = { ...all[id] }
  if (patch.baseURL !== undefined) {
    const url = patch.baseURL?.trim()
    if (url && !/^https?:\/\//.test(url)) throw new Error('The base URL should start with http:// or https://')
    next.baseURL = url || undefined
  }
  if (patch.key !== undefined) next.via = patch.key ? (patch.via ?? 'key') : undefined
  writeJson(SETTINGS, { ...all, [id]: next })
  modelCache.delete(id)
  return providerState(id)
}

// ─── Models ──────────────────────────────────────────────────────────────

const modelCache = new Map<ProviderId, { at: number; models: ModelInfo[] }>()

async function getJson(url: string, headers: Record<string, string>, timeoutMs = 12_000) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
  if (res.status === 401 || res.status === 403) throw new Error('The key was rejected — check it and try again.')
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`)
  return (await res.json()) as Record<string, unknown>
}

const byName = (a: ModelInfo, b: ModelInfo) => a.name.localeCompare(b.name)

async function fetchModels(id: ProviderId): Promise<ModelInfo[]> {
  const key = getSecret(keyName(id))
  switch (id) {
    case 'anthropic': {
      const json = await getJson('https://api.anthropic.com/v1/models?limit=100', { 'x-api-key': key ?? '', 'anthropic-version': '2023-06-01' })
      return (json.data as { id: string; display_name?: string }[]).map((m) => ({ id: m.id, name: m.display_name ?? m.id }))
    }
    case 'openai': {
      const json = await getJson('https://api.openai.com/v1/models', { Authorization: `Bearer ${key}` })
      return (json.data as { id: string }[])
        .map((m) => m.id)
        .filter((m) => /^(gpt|o\d|chatgpt)/.test(m) && !/audio|realtime|transcribe|tts|image|embedding|moderation|search|instruct|dall-e/.test(m))
        .map((m) => ({ id: m, name: m }))
        .sort(byName)
    }
    case 'gemini': {
      const json = await getJson('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { 'x-goog-api-key': key ?? '' })
      return (json.models as { name: string; displayName?: string; supportedGenerationMethods?: string[]; inputTokenLimit?: number }[])
        .filter((m) => m.supportedGenerationMethods?.includes('generateContent') && /gemini/.test(m.name) && !/embedding|image|tts|audio/.test(m.name))
        .map((m) => ({ id: m.name.replace(/^models\//, ''), name: m.displayName ?? m.name, context: m.inputTokenLimit }))
    }
    case 'openrouter': {
      const json = await getJson('https://openrouter.ai/api/v1/models', key ? { Authorization: `Bearer ${key}` } : {})
      return (json.data as { id: string; name?: string; context_length?: number; supported_parameters?: string[] }[])
        .filter((m) => !m.supported_parameters || m.supported_parameters.includes('tools'))
        .map((m) => ({ id: m.id, name: m.name ?? m.id, context: m.context_length }))
    }
    default: {
      // OpenAI-compatible: OpenCode Zen, Ollama, LM Studio, custom.
      const url = baseURL(id)
      if (!url) throw new Error('Set the server’s base URL first.')
      const json = await getJson(`${url}/models`, key ? { Authorization: `Bearer ${key}` } : {}, spec(id).local ? 3_000 : 12_000)
      return ((json.data ?? []) as { id: string }[]).map((m) => ({ id: m.id, name: m.id })).sort(byName)
    }
  }
}

export async function listModels(id: ProviderId, refresh = false): Promise<{ models: ModelInfo[]; error?: string }> {
  const cached = modelCache.get(id)
  if (cached && !refresh && Date.now() - cached.at < 10 * 60_000) return { models: cached.models }
  const suggested = (spec(id).suggested ?? []).map((m) => ({ id: m, name: m }))
  const state = providerState(id)
  if (!state.configured) return { models: suggested }
  try {
    const models = await fetchModels(id)
    // Suggested models first, in their order.
    const rank = (m: ModelInfo) => {
      const i = spec(id).suggested?.indexOf(m.id) ?? -1
      return i < 0 ? 999 : i
    }
    models.sort((a, b) => rank(a) - rank(b))
    modelCache.set(id, { at: Date.now(), models })
    return { models }
  } catch (err) {
    return { models: suggested, error: err instanceof Error ? err.message : String(err) }
  }
}

// ─── Model instances ─────────────────────────────────────────────────────

export class MissingKeyError extends Error {}

export function languageModel(id: ProviderId, modelId: string): LanguageModel {
  const key = getSecret(keyName(id))
  const s = spec(id)
  if (!s.local && !s.needsBaseURL && !key) throw new MissingKeyError(`Add your ${s.name} API key in Integrations › AI models.`)
  switch (id) {
    case 'anthropic':
      return createAnthropic({ apiKey: key })(modelId)
    case 'openai':
      return createOpenAI({ apiKey: key })(modelId)
    case 'gemini':
      return createGoogle({ apiKey: key })(modelId)
    case 'openrouter':
      return createOpenRouter({ apiKey: key, headers: { 'X-Title': 'Lumen' } })(modelId)
    default: {
      const url = baseURL(id)
      if (!url) throw new MissingKeyError(`Set the ${s.name} base URL in Integrations › AI models.`)
      return createOpenAICompatible({ name: id, baseURL: url, apiKey: key })(modelId)
    }
  }
}
