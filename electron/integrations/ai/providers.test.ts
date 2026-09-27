import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateText } from 'ai'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Effort, ProviderId } from '../../../shared/ai'

const env = vi.hoisted(() => ({ root: '' }))

vi.mock('electron', () => ({
  app: { getPath: (name: string) => path.join(env.root, name), getVersion: () => '9.9.9' },
  safeStorage: { isEncryptionAvailable: () => false },
}))

env.root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-providers-test-'))
const { languageModel, listModels, setProvider } = await import('./providers')
const { effortSettings } = await import('./effort')
const { openCodeApi, extractCatalog } = await import('./catalog')
const { writeJson } = await import('../paths')

interface Call {
  url: string
  headers: Headers
  body: Record<string, any>
}
let calls: Call[] = []
let reply: (url: string) => Response = () => new Response(JSON.stringify({ error: { message: 'stop here', type: 'invalid_request_error' } }), { status: 400, headers: { 'content-type': 'application/json' } })

beforeAll(() => {
  // A catalog on disk (fresh), shaped like models.dev's, so nothing is fetched from it.
  writeJson('models-dev-opencode.json', {
    at: Date.now(),
    providers: extractCatalog({
      'opencode-go': {
        models: {
          'minimax-m3': { name: 'MiniMax-M3', reasoning: true, tool_call: true, modalities: { input: ['text', 'image'] }, provider: { npm: '@ai-sdk/anthropic' } },
          'gpt-6-luna': { name: 'GPT-6 Luna', reasoning: true, tool_call: true, modalities: { input: ['text', 'image'] }, provider: { npm: '@ai-sdk/openai' } },
          'glm-5.3': { name: 'GLM-5.3', reasoning: true, tool_call: true, modalities: { input: ['text'] }, limit: { context: 200000 } },
          'mimo-v2.6-pro': { name: 'MiMo-V2.6-Pro', reasoning: true, tool_call: true, modalities: { input: ['text', 'image'] } },
          'no-tools-model': { name: 'No Tools', tool_call: false },
        },
      },
      opencode: {
        models: {
          'claude-opus-5-5': { name: 'Claude Opus 5.5', reasoning: true, tool_call: true, provider: { npm: '@ai-sdk/anthropic' } },
          'gemini-3.8-flash': { name: 'Gemini 3.8 Flash', reasoning: true, tool_call: true, provider: { npm: '@ai-sdk/google' } },
        },
      },
    }),
  })
  setProvider('opencode-go', { key: 'sk-go-test' })
  setProvider('opencode', { key: 'sk-zen-test' })
  setProvider('anthropic', { key: 'sk-ant-test' })
  setProvider('openrouter', { key: 'sk-or-test' })
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    calls.push({ url, headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : {} })
    return reply(url)
  })
})

afterEach(() => {
  calls = []
})

afterAll(() => {
  vi.unstubAllGlobals()
  fs.rmSync(env.root, { recursive: true, force: true })
})

/** Sends one prompt the way the Copilot would and returns the request that went out. */
async function send(provider: ProviderId, model: string, effort?: Effort) {
  const handle = await languageModel(provider, model, 'conv_test')
  await generateText({ model: handle.model, prompt: 'Hello', maxRetries: 0, headers: handle.headers, ...effortSettings(handle.api, effort) }).catch(() => undefined)
  expect(calls).toHaveLength(1)
  return { ...calls[0], api: handle.api, vision: handle.vision }
}

describe('OpenCode Go and Zen', () => {
  it('routes each model to the endpoint of its family', () => {
    expect(openCodeApi('opencode-go', 'minimax-m3')).toBe('anthropic')
    expect(openCodeApi('opencode-go', 'gpt-6-luna')).toBe('openai')
    expect(openCodeApi('opencode-go', 'glm-5.3')).toBe('compatible')
    expect(openCodeApi('opencode', 'claude-opus-5-5')).toBe('anthropic')
    expect(openCodeApi('opencode', 'gemini-3.8-flash')).toBe('google')
    // Not in the catalog: the family name decides.
    expect(openCodeApi('opencode-go', 'qwen3.9-max', {})).toBe('anthropic')
    expect(openCodeApi('opencode-go', 'grok-5', {})).toBe('openai')
    expect(openCodeApi('opencode', 'claude-sonnet-6', {})).toBe('anthropic')
    expect(openCodeApi('opencode', 'gemini-4-pro', {})).toBe('google')
    expect(openCodeApi('opencode', 'kimi-k4', {})).toBe('compatible')
  })

  it('sends MiniMax to /messages, naming Lumen and the conversation', async () => {
    const call = await send('opencode-go', 'minimax-m3')
    expect(call.url).toBe('https://opencode.ai/zen/go/v1/messages')
    expect(call.headers.get('x-api-key')).toBe('sk-go-test')
    expect(call.headers.get('user-agent')).toMatch(/^Lumen\/9\.9\.9/)
    expect(call.headers.get('x-opencode-session')).toBe('conv_test')
    expect(call.body.model).toBe('minimax-m3')
    expect(call.api).toBe('anthropic')
  })

  it('sends GPT to /responses with its reasoning effort', async () => {
    const call = await send('opencode-go', 'gpt-6-luna', 'high')
    expect(call.url).toBe('https://opencode.ai/zen/go/v1/responses')
    expect(call.headers.get('authorization')).toBe('Bearer sk-go-test')
    expect(call.headers.get('x-opencode-session')).toBe('conv_test')
    expect(call.body.reasoning?.effort).toBe('high')
  })

  it('sends GPT Max through OpenAI’s own option', async () => {
    const call = await send('opencode-go', 'gpt-6-luna', 'max')
    expect(call.body.reasoning?.effort).toBe('max')
  })

  it('sends open models to /chat/completions, with reasoning_effort when chosen', async () => {
    const glm = await send('opencode-go', 'glm-5.3')
    expect(glm.url).toBe('https://opencode.ai/zen/go/v1/chat/completions')
    expect(glm.body.reasoning_effort).toBeUndefined()
    expect(glm.vision).toBe(false)
    calls = []
    const mimo = await send('opencode-go', 'mimo-v2.6-pro', 'medium')
    expect(mimo.body.reasoning_effort).toBe('medium')
    expect(mimo.headers.get('user-agent')).toMatch(/^Lumen\//)
  })

  it('sends Zen’s Claude to /messages with adaptive thinking at the chosen effort', async () => {
    const call = await send('opencode', 'claude-opus-5-5', 'max')
    expect(call.url).toBe('https://opencode.ai/zen/v1/messages')
    expect(call.headers.get('x-api-key')).toBe('sk-zen-test')
    expect(call.body.thinking?.type).toBe('adaptive')
    expect(call.body.output_config?.effort).toBe('max')
  })

  it('sends Zen’s Gemini to Google’s endpoint with a thinking level', async () => {
    const call = await send('opencode', 'gemini-3.8-flash', 'high')
    expect(call.url).toMatch(/^https:\/\/opencode\.ai\/zen\/v1\/models\/gemini-3\.8-flash:generateContent/)
    expect(call.headers.get('x-goog-api-key')).toBe('sk-zen-test')
    expect(call.body.generationConfig?.thinkingConfig?.thinkingLevel).toBe('high')
  })

  it('lists Go’s models with catalog names, effort levels and image support — tool-less ones left out', async () => {
    reply = (url) =>
      url.endsWith('/models')
        ? Response.json({ object: 'list', data: ['minimax-m3', 'gpt-6-luna', 'glm-5.3', 'mimo-v2.6-pro', 'no-tools-model', 'brand-new-model'].map((id) => ({ id, object: 'model' })) })
        : new Response('{}', { status: 400 })
    const { models, error } = await listModels('opencode-go', true)
    expect(error).toBeUndefined()
    expect(calls[0].url).toBe('https://opencode.ai/zen/go/v1/models')
    expect(calls[0].headers.get('user-agent')).toMatch(/^Lumen\//)
    const byId = Object.fromEntries(models.map((m) => [m.id, m]))
    expect(Object.keys(byId).sort()).toEqual(['brand-new-model', 'glm-5.3', 'gpt-6-luna', 'mimo-v2.6-pro', 'minimax-m3'])
    expect(byId['glm-5.3']).toMatchObject({ name: 'GLM-5.3', context: 200000, vision: false })
    expect(byId['glm-5.3'].efforts).toBeUndefined()
    expect(byId['gpt-6-luna'].efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(byId['mimo-v2.6-pro'].efforts).toEqual(['low', 'medium', 'high'])
    expect(byId['minimax-m3'].efforts).toBeUndefined()
  })
})

describe('Anthropic and OpenRouter effort on the wire', () => {
  it('Claude Opus 5.5: adaptive thinking at the chosen effort', async () => {
    reply = () => new Response(JSON.stringify({ error: { message: 'stop here' } }), { status: 400, headers: { 'content-type': 'application/json' } })
    const call = await send('anthropic', 'claude-opus-5-5', 'high')
    expect(call.url).toBe('https://api.anthropic.com/v1/messages')
    expect(call.body.thinking?.type).toBe('adaptive')
    expect(call.body.output_config?.effort).toBe('high')
    // Only OpenCode's gateways get the session header.
    expect(call.headers.get('x-opencode-session')).toBeNull()
  })

  it('Claude Haiku 4.5: a thinking budget sized from the level', async () => {
    const call = await send('anthropic', 'claude-haiku-4-5', 'medium')
    expect(call.body.thinking?.type).toBe('enabled')
    expect(call.body.thinking?.budget_tokens).toBeGreaterThan(1000)
  })

  it('Default sends no effort or thinking settings', async () => {
    const call = await send('anthropic', 'claude-opus-5-5')
    expect(call.body.thinking).toBeUndefined()
    expect(call.body.output_config?.effort).toBeUndefined()
  })

  it('OpenRouter: reasoning.effort', async () => {
    const call = await send('openrouter', 'anthropic/claude-opus-5.5', 'high')
    expect(call.url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(call.body.reasoning?.effort).toBe('high')
  })
})
