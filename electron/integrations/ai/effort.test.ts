import { describe, expect, it } from 'vitest'
import { claudeEfforts, compatibleEfforts, effortSettings, effortsFor, geminiEfforts, openaiEfforts } from './effort'

describe('effort levels per model', () => {
  it('Claude: adaptive models take every level, 4.6 skips Extra high, budget models three, old ones none', () => {
    for (const id of ['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-fable-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-5', 'claude-opus-6'])
      expect(claudeEfforts(id), id).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(claudeEfforts('claude-sonnet-4-6')).toEqual(['low', 'medium', 'high', 'max'])
    expect(claudeEfforts('claude-opus-4-6')).toEqual(['low', 'medium', 'high', 'max'])
    for (const id of ['claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-5', 'claude-opus-4-5', 'claude-opus-4-1', 'claude-sonnet-4-20250514', 'claude-sonnet-4', 'claude-3-7-sonnet-20250219'])
      expect(claudeEfforts(id), id).toEqual(['low', 'medium', 'high'])
    for (const id of ['claude-3-5-haiku', 'claude-3-haiku-20240307', 'minimax-m3', 'qwen3.8-flash']) expect(claudeEfforts(id), id).toEqual([])
  })

  it('OpenAI: GPT-6 and 5.6 up to Max, 5.2–5.5 to Extra high, older reasoning models three, chat models none', () => {
    expect(openaiEfforts('gpt-6-astra')).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(openaiEfforts('gpt-5.6-sol')).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(openaiEfforts('gpt-5.5')).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(openaiEfforts('gpt-5.2-codex')).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(openaiEfforts('gpt-5.1')).toEqual(['low', 'medium', 'high'])
    expect(openaiEfforts('gpt-5')).toEqual(['low', 'medium', 'high'])
    expect(openaiEfforts('o3')).toEqual(['low', 'medium', 'high'])
    expect(openaiEfforts('o4-mini')).toEqual(['low', 'medium', 'high'])
    for (const id of ['gpt-5-chat-latest', 'gpt-4.1', 'gpt-4o', 'chatgpt-4o-latest', 'grok-4.7', 'muse-spark-1.3']) expect(openaiEfforts(id), id).toEqual([])
  })

  it('Gemini: 2.5 and 3 onwards think; other Gemini models don’t', () => {
    expect(geminiEfforts('gemini-3.8-flash')).toEqual(['low', 'medium', 'high'])
    expect(geminiEfforts('gemini-2.5-pro')).toEqual(['low', 'medium', 'high'])
    expect(geminiEfforts('gemini-2.0-flash')).toEqual([])
    expect(geminiEfforts('gemini-3-pro-image-preview')).toEqual([])
  })

  it('OpenAI-compatible: reasoning models take three levels, except families that think on their own terms', () => {
    expect(compatibleEfforts('mimo-v2.6-pro', true)).toEqual(['low', 'medium', 'high'])
    expect(compatibleEfforts('gpt-oss:20b', undefined)).toEqual(['low', 'medium', 'high'])
    for (const id of ['glm-5.3', 'kimi-k3', 'qwen3.7-max', 'minimax-m2.5', 'deepseek-v3.2', 'big-pickle']) expect(compatibleEfforts(id, true), id).toEqual([])
    expect(compatibleEfforts('trinity-large-preview-free', false)).toEqual([])
  })

  it('OpenRouter models take effort only when they reason', () => {
    expect(effortsFor('openrouter', 'anthropic/claude-opus-5.5', true)).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(effortsFor('openrouter', 'meta-llama/llama-4', false)).toEqual([])
  })
})

describe('effort settings', () => {
  it('Default sends nothing', () => {
    expect(effortSettings('anthropic', undefined)).toEqual({})
  })

  it('Low to Extra high use the SDK’s portable reasoning setting', () => {
    expect(effortSettings('anthropic', 'high')).toEqual({ reasoning: 'high' })
    expect(effortSettings('openai', 'xhigh')).toEqual({ reasoning: 'xhigh' })
    expect(effortSettings('google', 'low')).toEqual({ reasoning: 'low' })
    expect(effortSettings('compatible', 'medium')).toEqual({ reasoning: 'medium' })
  })

  it('Max goes through the provider’s own options, and caps at Extra high where there is no Max', () => {
    expect(effortSettings('anthropic', 'max')).toEqual({ providerOptions: { anthropic: { effort: 'max', thinking: { type: 'adaptive' } } } })
    expect(effortSettings('openai', 'max')).toEqual({ providerOptions: { openai: { reasoningEffort: 'max' } } })
    expect(effortSettings('google', 'max')).toEqual({ reasoning: 'xhigh' })
    expect(effortSettings('openai', 'ultra')).toEqual({ providerOptions: { openai: { reasoningEffort: 'max' } } })
  })

  it('OpenRouter takes its own reasoning option', () => {
    expect(effortSettings('openrouter', 'high')).toEqual({ providerOptions: { openrouter: { reasoning: { effort: 'high' } } } })
    expect(effortSettings('openrouter', 'max')).toEqual({ providerOptions: { openrouter: { reasoning: { effort: 'xhigh' } } } })
  })
})
