import { describe, expect, it } from 'vitest'
import { cleanTarget } from './ai'

describe('cleanTarget', () => {
  it('keeps valid model and agent targets, with their effort', () => {
    expect(cleanTarget({ kind: 'model', provider: 'opencode-go', model: 'glm-5.3', effort: 'high' })).toEqual({ kind: 'model', provider: 'opencode-go', model: 'glm-5.3', effort: 'high' })
    expect(cleanTarget({ kind: 'model', provider: 'openrouter', model: 'anthropic/claude-opus-5.5' })).toEqual({ kind: 'model', provider: 'openrouter', model: 'anthropic/claude-opus-5.5', effort: undefined })
    expect(cleanTarget({ kind: 'model', provider: 'ollama', model: 'hf.co/bartowski/Llama-3.2-3B-GGUF:Q4_K_M' })?.kind).toBe('model')
    expect(cleanTarget({ kind: 'local', agent: 'codex', model: 'gpt-6-sol', effort: 'ultra' })).toEqual({ kind: 'local', agent: 'codex', model: 'gpt-6-sol', effort: 'ultra' })
    expect(cleanTarget({ kind: 'local', agent: 'claude-code' })).toEqual({ kind: 'local', agent: 'claude-code', model: undefined, effort: undefined })
  })

  it('drops an unknown effort but keeps the target', () => {
    expect(cleanTarget({ kind: 'local', agent: 'claude-code', model: 'opus', effort: 'ludicrous' })).toEqual({ kind: 'local', agent: 'claude-code', model: 'opus', effort: undefined })
  })

  it('refuses unknown brains, and model ids that could pass for flags', () => {
    expect(cleanTarget(null)).toBeNull()
    expect(cleanTarget('codex')).toBeNull()
    expect(cleanTarget({ kind: 'model', provider: 'nope', model: 'x' })).toBeNull()
    expect(cleanTarget({ kind: 'model', provider: 'openai' })).toBeNull()
    expect(cleanTarget({ kind: 'local', agent: 'gemini-cli' })).toBeNull()
    expect(cleanTarget({ kind: 'local', agent: 'claude-code', model: '--dangerously-skip-permissions' })).toBeNull()
    expect(cleanTarget({ kind: 'local', agent: 'codex', model: 'gpt 6; rm -rf' })).toBeNull()
  })
})
