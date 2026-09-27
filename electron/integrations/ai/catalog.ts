import { readJson, writeJson } from '../paths'
import type { ModelApi } from './effort'

/**
 * What OpenCode Zen and OpenCode Go serve through which API. Both gateways put
 * each model behind the endpoint of its own family — Claude and MiniMax behind
 * Anthropic's /messages, GPT and Grok behind OpenAI's /responses, Gemini
 * behind Google's, the rest behind /chat/completions — and their /models list
 * doesn't say which. models.dev (the open catalog OpenCode itself routes by)
 * does, along with names, reasoning and image support. It's fetched at most
 * once a day and kept on disk; without it, the model's name decides.
 */

export type OpenCodeProvider = 'opencode' | 'opencode-go'

export interface CatalogModel {
  name?: string
  /** The AI SDK package models.dev routes the model through. */
  npm?: string
  reasoning?: boolean
  tools?: boolean
  vision?: boolean
  context?: number
}

export type Catalog = Partial<Record<OpenCodeProvider, Record<string, CatalogModel>>>

const URL = 'https://models.dev/api.json'
const FILE = 'models-dev-opencode.json'
const MAX_AGE = 24 * 60 * 60_000

let memo: { at: number; providers: Catalog } | null = null
let pending: Promise<Catalog> | null = null

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined)

/** Keeps just the OpenCode providers from the full models.dev catalog. */
export function extractCatalog(json: unknown): Catalog {
  const out: Catalog = {}
  for (const pid of ['opencode', 'opencode-go'] as const) {
    const models = (json as Record<string, { models?: Record<string, Record<string, any>> }> | null)?.[pid]?.models
    if (!models || typeof models !== 'object') continue
    const map: Record<string, CatalogModel> = {}
    for (const [id, m] of Object.entries(models)) {
      if (!m || typeof m !== 'object') continue
      const input = m.modalities?.input
      map[id] = {
        name: str(m.name),
        npm: str(m.provider?.npm),
        reasoning: bool(m.reasoning),
        tools: bool(m.tool_call),
        vision: Array.isArray(input) ? input.includes('image') : undefined,
        context: typeof m.limit?.context === 'number' ? m.limit.context : undefined,
      }
    }
    out[pid] = map
  }
  return out
}

function fromDisk() {
  if (!memo) {
    const saved = readJson<{ at?: number; providers?: Catalog }>(FILE, {})
    if (saved.at && saved.providers) memo = { at: saved.at, providers: saved.providers }
  }
  return memo
}

/** The catalog as it stands (memory or disk) — no network. */
export const catalogNow = (): Catalog => fromDisk()?.providers ?? {}

/** The catalog, refreshed from models.dev when it's more than a day old. Never throws. */
export async function loadCatalog(userAgent: string): Promise<Catalog> {
  const current = fromDisk()
  if (current && Date.now() - current.at < MAX_AGE) return current.providers
  pending ??= (async () => {
    try {
      const res = await fetch(URL, { headers: { 'User-Agent': userAgent }, signal: AbortSignal.timeout(20_000) })
      if (!res.ok) throw new Error(`models.dev answered ${res.status}`)
      const providers = extractCatalog(await res.json())
      if (!Object.keys(providers).length) throw new Error('models.dev has no OpenCode models')
      memo = { at: Date.now(), providers }
      writeJson(FILE, memo)
      return providers
    } catch {
      // Offline or changed: keep what we had (possibly nothing — names decide then).
      return current?.providers ?? {}
    } finally {
      pending = null
    }
  })()
  return pending
}

/** Which API an OpenCode model is called through. */
export function openCodeApi(provider: OpenCodeProvider, id: string, catalog: Catalog = catalogNow()): Exclude<ModelApi, 'openrouter'> {
  const entry = catalog[provider]?.[id]
  switch (entry?.npm) {
    case '@ai-sdk/anthropic':
      return 'anthropic'
    case '@ai-sdk/openai':
      return 'openai'
    case '@ai-sdk/google':
      return 'google'
  }
  if (entry) return 'compatible'
  // Not in the catalog (brand new, or no catalog yet): go by the family name.
  if (/^claude-/.test(id)) return 'anthropic'
  if (/^(?:gpt-|o\d|grok-|muse-spark)/.test(id)) return 'openai'
  if (/^gemini-/.test(id)) return 'google'
  if (provider === 'opencode-go' && /^(?:minimax-|qwen)/.test(id)) return 'anthropic'
  return 'compatible'
}
