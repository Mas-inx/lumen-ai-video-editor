import type { streamText } from 'ai'
import type { Effort } from '../../../shared/ai'

/**
 * Effort (reasoning depth) for API models. Lumen offers one scale — Low to
 * Max — and each model lists only the levels it takes. The AI SDK's `reasoning`
 * setting maps Low…Extra high onto every provider's own parameter (Claude's
 * effort and adaptive thinking or thinking budget, OpenAI's reasoning effort,
 * Gemini's thinking level, `reasoning_effort` for OpenAI-compatible servers);
 * Max has no portable form, so it goes through the provider's own options.
 */

/** Which API a model is called through — decides both the effort mapping and how pictures travel. */
export type ModelApi = 'anthropic' | 'openai' | 'google' | 'openrouter' | 'compatible'

const ALL: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const NO_XHIGH: Effort[] = ['low', 'medium', 'high', 'max']
const TO_XHIGH: Effort[] = ['low', 'medium', 'high', 'xhigh']
const BASIC: Effort[] = ['low', 'medium', 'high']

/**
 * Claude: 4.6 and later think adaptively and take effort (4.6 without Extra
 * high); Opus/Sonnet 4.5, 4.1, 4 and Sonnet 3.7 think with a token budget,
 * which the SDK sizes from the level; older models don't think.
 */
export function claudeEfforts(id: string): Effort[] {
  if (!id.includes('claude-')) return []
  if (/claude-(?:opus|sonnet)-4-6/.test(id)) return NO_XHIGH
  if (/claude-(?:opus|sonnet|haiku)-4-5|claude-opus-4-1|claude-(?:opus|sonnet)-4(?:-0|-\d{8}|@|$)|claude-3-7-sonnet/.test(id)) return BASIC
  if (/claude-(?:instant|v?2|3)(?=$|[-.:@])/.test(id)) return []
  return ALL
}

/** OpenAI: o-series and GPT-5 onwards reason; GPT-6 and 5.6 go up to Max, 5.2–5.5 to Extra high. */
export function openaiEfforts(id: string): Effort[] {
  if (/^o\d+(?:-|$)/.test(id)) return BASIC
  const gpt = /^gpt-(\d+)(?:\.(\d+))?(?:-(.+))?$/.exec(id)
  if (!gpt) return []
  const major = Number(gpt[1])
  const minor = Number(gpt[2] ?? 0)
  if (major < 5 || (gpt[3] ?? '').startsWith('chat')) return []
  if (major >= 6 || minor >= 6) return ALL
  return minor >= 2 ? TO_XHIGH : BASIC
}

/** Gemini 2.5 (thinking budget) and 3 onwards (thinking level). */
export function geminiEfforts(id: string): Effort[] {
  return /gemini-(?:2\.5|[3-9])/.test(id) && !/image|tts|live|embedding|audio/.test(id) ? BASIC : []
}

/** Open-model families whose servers don't take a reasoning effort (they think on their own terms). */
const OWN_THINKING = /deepseek-(?:chat|reasoner|r1|v3)|minimax|glm|kimi|qwen|big-pickle/i

/** Effort levels for a model reached through an OpenAI-compatible server. */
export function compatibleEfforts(id: string, reasons: boolean | undefined): Effort[] {
  return reasons === false || OWN_THINKING.test(id) ? [] : BASIC
}

export const OPENROUTER_EFFORTS = TO_XHIGH

/** Effort levels for a model, by the API it's called through. */
export function effortsFor(api: ModelApi, id: string, reasons?: boolean): Effort[] {
  switch (api) {
    case 'anthropic':
      return claudeEfforts(id)
    case 'openai':
      return openaiEfforts(id)
    case 'google':
      return geminiEfforts(id)
    case 'openrouter':
      return reasons ? OPENROUTER_EFFORTS : []
    case 'compatible':
      return compatibleEfforts(id, reasons)
  }
}

type CallSettings = Pick<Parameters<typeof streamText>[0], 'reasoning' | 'providerOptions'>

/** The streamText settings that ask a model for this effort (nothing for the model's default). */
export function effortSettings(api: ModelApi, effort: Effort | undefined): CallSettings {
  if (!effort) return {}
  // Ultra is Codex's own level; an API model's deepest is Max.
  const level = effort === 'ultra' ? 'max' : effort
  if (api === 'openrouter') return { providerOptions: { openrouter: { reasoning: { effort: level === 'max' ? 'xhigh' : level } } } }
  if (level === 'max') {
    if (api === 'anthropic') return { providerOptions: { anthropic: { effort: 'max', thinking: { type: 'adaptive' } } } }
    if (api === 'openai') return { providerOptions: { openai: { reasoningEffort: 'max' } } }
    return { reasoning: 'xhigh' }
  }
  return { reasoning: level }
}
