import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: (name: string) => path.join(os.tmpdir(), 'lumen-agents-test', name), getVersion: () => '9.9.9' } }))
vi.mock('../server', () => ({ bridgeEndpoint: async () => ({ url: 'http://127.0.0.1:0/mcp', token: 't' }) }))

const { CLAUDE_CODE_MODELS, claudeTurnFlags, codexTurnFlags, parseCodexCatalog, parseCodexConfig } = await import('./local-agents')

// Shaped like `codex debug models` (trimmed).
const catalog = {
  models: [
    {
      slug: 'gpt-6-sol',
      display_name: 'GPT-6-Sol',
      description: 'Workhorse model for coding and everyday work.',
      default_reasoning_level: 'medium',
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }, { effort: 'max' }, { effort: 'ultra' }],
      visibility: 'list',
      priority: 2,
      context_window: 272000,
      base_instructions: '…',
    },
    {
      slug: 'gpt-6-astra',
      display_name: 'GPT-6-Astra',
      description: 'Frontier intelligence for the most demanding work.',
      default_reasoning_level: 'medium',
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }, { effort: 'turbo' }],
      visibility: 'list',
      priority: 1,
    },
    { slug: 'codex-auto-review', display_name: 'Codex Auto Review', visibility: 'hide', priority: 43, supported_reasoning_levels: [] },
    { slug: 'gpt-5.5', display_name: 'GPT-5.5', default_reasoning_level: 'nonsense', visibility: 'list', priority: 12 },
  ],
}

describe('Codex', () => {
  it('lists the catalog’s visible models in its order, with their effort levels', () => {
    const models = parseCodexCatalog(catalog)
    expect(models.map((m) => m.id)).toEqual(['gpt-6-astra', 'gpt-6-sol', 'gpt-5.5'])
    expect(models[1]).toMatchObject({ name: 'GPT-6-Sol', description: 'Workhorse model for coding and everyday work.', context: 272000, defaultEffort: 'medium' })
    expect(models[1].efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    // Unknown levels are dropped; a model without levels has no effort setting.
    expect(models[0].efforts).toEqual(['low', 'high'])
    expect(models[2].efforts).toBeUndefined()
    expect(models[2].defaultEffort).toBeUndefined()
  })

  it('shrugs off output that isn’t a catalog', () => {
    expect(parseCodexCatalog(null)).toEqual([])
    expect(parseCodexCatalog({ models: 'nope' })).toEqual([])
    expect(parseCodexCatalog({ models: [null, 3, { display_name: 'no slug' }] })).toEqual([])
  })

  it('reads the default model and effort from config.toml’s top level only', () => {
    const toml = ['# comment', 'model = "gpt-6-astra"', "model_reasoning_effort = 'high'", '', '[profiles.fast]', 'model = "gpt-6-luna"', 'model_reasoning_effort = "low"'].join('\n')
    expect(parseCodexConfig(toml)).toEqual({ model: 'gpt-6-astra', effort: 'high' })
    expect(parseCodexConfig('model_reasoning_effort = "sideways"\n')).toEqual({ model: undefined, effort: undefined })
    expect(parseCodexConfig('')).toEqual({ model: undefined, effort: undefined })
  })

  it('passes the model with -m and the effort as model_reasoning_effort', () => {
    expect(codexTurnFlags({ kind: 'local', agent: 'codex' })).toEqual([])
    expect(codexTurnFlags({ kind: 'local', agent: 'codex', model: 'gpt-6-sol', effort: 'ultra' })).toEqual(['-m', 'gpt-6-sol', '-c', 'model_reasoning_effort="ultra"'])
    expect(codexTurnFlags({ kind: 'local', agent: 'codex', effort: 'low' })).toEqual(['-c', 'model_reasoning_effort="low"'])
  })
})

describe('Claude Code', () => {
  it('offers its model aliases, Haiku without an effort setting', () => {
    expect(CLAUDE_CODE_MODELS.map((m) => m.id)).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
    expect(CLAUDE_CODE_MODELS.find((m) => m.id === 'opus')?.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(CLAUDE_CODE_MODELS.find((m) => m.id === 'haiku')?.efforts).toBeUndefined()
  })

  it('passes --model and --effort (Ultra is Codex’s alone)', () => {
    expect(claudeTurnFlags({ kind: 'local', agent: 'claude-code' })).toEqual([])
    expect(claudeTurnFlags({ kind: 'local', agent: 'claude-code', model: 'opus', effort: 'xhigh' })).toEqual(['--model', 'opus', '--effort', 'xhigh'])
    expect(claudeTurnFlags({ kind: 'local', agent: 'claude-code', effort: 'ultra' })).toEqual([])
  })
})
