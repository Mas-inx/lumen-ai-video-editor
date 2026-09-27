import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogle } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import type { LanguageModel } from 'ai'
import { app } from 'electron'
import { PROVIDERS, type ModelInfo, type ProviderId, type ProviderSpec, type ProviderState } from '../../../shared/ai'
import { readJson, writeJson } from '../paths'
import { getSecret, secretHint, setSecret } from '../secrets'
import { loadCatalog, openCodeApi } from './catalog'
import { claudeEfforts, compatibleEfforts, effortsFor, geminiEfforts, openaiEfforts, OPENROUTER_EFFORTS, type ModelApi } from './effort'

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

/** OpenCode's gateways ask every client to name itself rather than go by its HTTP library's name. */
export const userAgent = () => `Lumen/${app.getVersion()}`

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
const withEfforts = (m: ModelInfo, efforts: ModelInfo['efforts']): ModelInfo => (efforts?.length ? { ...m, efforts } : m)

async function fetchModels(id: ProviderId): Promise<ModelInfo[]> {
  const key = getSecret(keyName(id))
  switch (id) {
    case 'anthropic': {
      const json = await getJson('https://api.anthropic.com/v1/models?limit=100', { 'x-api-key': key ?? '', 'anthropic-version': '2023-06-01' })
      return (json.data as { id: string; display_name?: string }[]).map((m) => withEfforts({ id: m.id, name: m.display_name ?? m.id }, claudeEfforts(m.id)))
    }
    case 'openai': {
      const json = await getJson('https://api.openai.com/v1/models', { Authorization: `Bearer ${key}` })
      return (json.data as { id: string }[])
        .map((m) => m.id)
        .filter((m) => /^(gpt|o\d|chatgpt)/.test(m) && !/audio|realtime|transcribe|tts|image|embedding|moderation|search|instruct|dall-e/.test(m))
        .map((m) => withEfforts({ id: m, name: m }, openaiEfforts(m)))
        .sort(byName)
    }
    case 'gemini': {
      const json = await getJson('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { 'x-goog-api-key': key ?? '' })
      return (json.models as { name: string; displayName?: string; supportedGenerationMethods?: string[]; inputTokenLimit?: number }[])
        .filter((m) => m.supportedGenerationMethods?.includes('generateContent') && /gemini/.test(m.name) && !/embedding|image|tts|audio/.test(m.name))
        .map((m) => {
          const id = m.name.replace(/^models\//, '')
          return withEfforts({ id, name: m.displayName ?? m.name, context: m.inputTokenLimit }, geminiEfforts(id))
        })
    }
    case 'openrouter': {
      const json = await getJson('https://openrouter.ai/api/v1/models', key ? { Authorization: `Bearer ${key}` } : {})
      return (json.data as { id: string; name?: string; context_length?: number; supported_parameters?: string[] }[])
        .filter((m) => !m.supported_parameters || m.supported_parameters.includes('tools'))
        .map((m) => withEfforts({ id: m.id, name: m.name ?? m.id, context: m.context_length }, m.supported_parameters?.includes('reasoning') ? OPENROUTER_EFFORTS : []))
    }
    case 'opencode':
    case 'opencode-go': {
      // The gateway lists ids; the catalog knows names, routing, tool use and image support.
      const headers: Record<string, string> = { 'User-Agent': userAgent(), ...(key ? { Authorization: `Bearer ${key}` } : {}) }
      const [json, catalog] = await Promise.all([getJson(`${baseURL(id)}/models`, headers), loadCatalog(userAgent())])
      const known = catalog[id] ?? {}
      return ((json.data ?? []) as { id: string }[])
        .filter((m) => known[m.id]?.tools !== false)
        .map((m) => {
          const info = known[m.id]
          const model: ModelInfo = { id: m.id, name: info?.name ?? m.id, context: info?.context, vision: info?.vision }
          return withEfforts(model, effortsFor(openCodeApi(id, m.id, catalog), m.id, info?.reasoning))
        })
        .sort(byName)
    }
    default: {
      // OpenAI-compatible: Ollama, LM Studio, custom.
      const url = baseURL(id)
      if (!url) throw new Error('Set the server’s base URL first.')
      const json = await getJson(`${url}/models`, key ? { Authorization: `Bearer ${key}` } : {}, spec(id).local ? 3_000 : 12_000)
      return ((json.data ?? []) as { id: string }[]).map((m) => withEfforts({ id: m.id, name: m.id }, compatibleEfforts(m.id, undefined))).sort(byName)
    }
  }
}

export async function listModels(id: ProviderId, refresh = false): Promise<{ models: ModelInfo[]; error?: string }> {
  const cached = modelCache.get(id)
  if (cached && !refresh && Date.now() - cached.at < 10 * 60_000) return { models: cached.models }
  const suggested = (spec(id).suggested ?? []).map((m) => withEfforts({ id: m, name: m }, id === 'anthropic' ? claudeEfforts(m) : undefined))
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

export interface ModelHandle {
  model: LanguageModel
  /** The API the model is called through (decides effort settings and how pictures travel). */
  api: ModelApi
  /** false when the model is known not to take images. */
  vision?: boolean
  /** Headers for each call. The User-Agent goes here: the SDK sets its own at call level, over the provider's. */
  headers?: Record<string, string>
}

/**
 * A model to run a Copilot turn with. `session` is the Copilot conversation,
 * which OpenCode's gateways use to route a conversation's requests together.
 */
export async function languageModel(id: ProviderId, modelId: string, session?: string): Promise<ModelHandle> {
  const key = getSecret(keyName(id))
  const s = spec(id)
  if (!s.local && !s.needsBaseURL && !key) throw new MissingKeyError(`Add your ${s.name} API key in Integrations › AI models.`)
  switch (id) {
    case 'anthropic':
      return { model: createAnthropic({ apiKey: key })(modelId), api: 'anthropic' }
    case 'openai':
      return { model: createOpenAI({ apiKey: key })(modelId), api: 'openai' }
    case 'gemini':
      return { model: createGoogle({ apiKey: key })(modelId), api: 'google' }
    case 'openrouter':
      return { model: createOpenRouter({ apiKey: key, headers: { 'X-Title': 'Lumen' } })(modelId), api: 'openrouter' }
    case 'opencode':
    case 'opencode-go': {
      const catalog = await loadCatalog(userAgent())
      const url = baseURL(id)
      const headers = session ? { 'x-opencode-session': session } : undefined
      const call = { api: openCodeApi(id, modelId, catalog), vision: catalog[id]?.[modelId]?.vision, headers: { 'User-Agent': userAgent() } }
      switch (call.api) {
        case 'anthropic':
          return { ...call, model: createAnthropic({ baseURL: url, apiKey: key, headers })(modelId) }
        case 'openai':
          return { ...call, model: createOpenAI({ baseURL: url, apiKey: key, headers, name: id })(modelId) }
        case 'google':
          return { ...call, model: createGoogle({ baseURL: url, apiKey: key, headers })(modelId) }
        default:
          return { ...call, model: createOpenAICompatible({ name: id, baseURL: url, apiKey: key, headers })(modelId) }
      }
    }
    default: {
      const url = baseURL(id)
      if (!url) throw new MissingKeyError(`Set the ${s.name} base URL in Integrations › AI models.`)
      return { model: createOpenAICompatible({ name: id, baseURL: url, apiKey: key })(modelId), api: 'compatible' }
    }
  }
}
