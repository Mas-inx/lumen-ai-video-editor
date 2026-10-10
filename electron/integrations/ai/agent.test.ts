import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { COPILOT_INSTRUCTIONS, type AgentEvent, type AgentRunRequest } from '../../../shared/ai'

// The whole turn against a stand-in for Anthropic's API: what Lumen sends (cache marks, tool order,
// thinking, attached files) and what the chat is told as it happens.

const env = vi.hoisted(() => ({ root: '', events: [] as unknown[], requests: [] as Record<string, any>[], replies: [] as string[], toolCalls: [] as { tool: string; runId?: string }[] }))

vi.mock('electron', () => ({ app: { getPath: (name: string) => path.join(env.root, name), getVersion: () => '9.9.9' } }))

vi.mock('../editor-rpc', () => ({
  editorWindow: () => ({ webContents: { send: (_channel: string, e: unknown) => void env.events.push(e) } }),
  // Out of order on purpose: what is sent has to be sorted.
  editorTools: async () =>
    ['zeta_tool', 'get_project', 'add_title'].map((name) => ({ name, description: `The ${name} tool.`, inputSchema: { type: 'object', properties: { text: { type: 'string' } } } })),
  callEditorTool: async (tool: string, _args: unknown, _timeout: unknown, runId?: string) => {
    env.toolCalls.push({ tool, runId })
    return { content: [{ type: 'text', text: '{"fps":30,"clips":2}' }] }
  },
}))

vi.mock('./local-agents', () => ({ runLocal: vi.fn(), stopLocal: vi.fn(), forgetLocalSession: vi.fn() }))

vi.mock('./providers', async () => {
  const { createAnthropic } = await import('@ai-sdk/anthropic')
  const fetch = async (_url: unknown, init?: { body?: unknown }) => {
    env.requests.push(JSON.parse(String(init?.body)))
    return new Response(env.replies.shift() ?? '', { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  return {
    MissingKeyError: class extends Error {},
    languageModel: async (_provider: string, modelId: string) => ({ model: createAnthropic({ apiKey: 'test', fetch: fetch as typeof globalThis.fetch })(modelId), api: 'anthropic' }),
  }
})

env.root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-agent-test-'))
const { startAgentRun, cacheMarks, trim, isRetryable, userTurn } = await import('./agent')
const { saveAttachment } = await import('./attachments')

afterAll(() => fs.rmSync(env.root, { recursive: true, force: true }))

beforeEach(() => {
  env.events.length = 0
  env.requests.length = 0
  env.replies.length = 0
  env.toolCalls.length = 0
})

// ─── A scripted Anthropic stream ─────────────────────────────────────────

type Block = { thinking: string } | { text: string } | { tool: string; id: string; input: unknown }

function stream(blocks: Block[], stop: 'tool_use' | 'end_turn', usage: { input: number; written?: number; read?: number; output: number }) {
  const events: unknown[] = [
    { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input, cache_creation_input_tokens: usage.written ?? 0, cache_read_input_tokens: usage.read ?? 0, output_tokens: 1 } } },
  ]
  blocks.forEach((b, index) => {
    if ('thinking' in b) {
      events.push({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } })
      events.push({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: b.thinking } })
      events.push({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'sig' } })
    } else if ('text' in b) {
      events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
      events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } })
    } else {
      events.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.tool, input: {} } })
      events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } })
    }
    events.push({ type: 'content_block_stop', index })
  })
  events.push({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output } })
  events.push({ type: 'message_stop' })
  return events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
}

async function turn(req: Partial<AgentRunRequest> & { runId: string; prompt: string }) {
  await startAgentRun({ conversationId: 'conv_test', target: { kind: 'model', provider: 'anthropic', model: 'claude-opus-5-5' }, ...req })
  for (let i = 0; i < 400; i++) {
    const end = (env.events as AgentEvent[]).find((e) => e.runId === req.runId && (e.type === 'done' || e.type === 'error'))
    if (end) return (env.events as AgentEvent[]).filter((e) => e.runId === req.runId)
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('The turn never finished.')
}

/** Every cache mark in a request's conversation, as "message index:block index". */
const marksIn = (messages: { content: unknown }[]) =>
  messages.flatMap((m, i) => (Array.isArray(m.content) ? m.content.flatMap((b: { cache_control?: unknown }, j: number) => (b.cache_control ? [`${i}:${j}`] : [])) : []))

describe('a Copilot turn on Claude', () => {
  it('caches the tools, the instructions and the conversation, and tells the chat every step', async () => {
    const picture = saveAttachment('conv_test', { name: 'ref.png', mime: 'image/png', data: new Uint8Array([137, 80, 78, 71, 1, 2, 3]) })
    const notes = saveAttachment('conv_test', { name: 'notes.txt', data: new TextEncoder().encode('Open on the valet.') })
    env.replies.push(
      stream([{ thinking: 'Read the project first.' }, { text: 'Looking.' }, { tool: 'get_project', id: 'toolu_1', input: {} }], 'tool_use', { input: 100, written: 9000, output: 50 }),
      stream([{ text: 'Done.' }], 'end_turn', { input: 120, read: 9100, output: 20 }),
    )
    const events = await turn({ runId: 'run_1', prompt: 'Add a title', context: '[Lumen] Playhead at frame 0.', instructions: 'Skill notes.', attachments: [picture, notes] })

    // ── What went out ──
    const [first, second] = env.requests
    expect(first.tools.map((t: { name: string }) => t.name)).toEqual(['add_title', 'get_project', 'zeta_tool'])
    // The instructions end the cached prefix (tools come before them), kept for an hour on Anthropic's own API.
    expect(first.system).toEqual([{ type: 'text', text: `${COPILOT_INSTRUCTIONS}\n\nSkill notes.`, cache_control: { type: 'ephemeral', ttl: '1h' } }])
    // Thinking is asked for in a form that streams something to show.
    expect(first.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    // The attached files travel with the message, the request itself last — and that is where the conversation's cache mark is.
    const sent = first.messages[0].content
    expect(sent.map((b: { type: string }) => b.type)).toEqual(['text', 'image', 'text', 'text'])
    expect(sent[1].source).toMatchObject({ type: 'base64', media_type: 'image/png' })
    expect(sent[2].text).toContain('Open on the valet.')
    expect(sent[3]).toEqual({ type: 'text', text: '[Lumen] Playhead at frame 0.\n\nAdd a title', cache_control: { type: 'ephemeral' } })
    expect(marksIn(first.messages)).toEqual(['0:3'])
    // The next step marks the end of what it adds: everything before is read from the cache.
    expect(second.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(marksIn(second.messages)).toEqual(['2:0'])
    expect(JSON.stringify([second.tools, second.system])).toBe(JSON.stringify([first.tools, first.system]))
    expect(env.toolCalls).toEqual([{ tool: 'get_project', runId: 'run_1' }])

    // ── What the chat was told, in order ──
    const told = events.map((e) => (e.type === 'tool-input' ? `tool-input:${e.tool}` : e.type === 'tool-start' || e.type === 'tool-end' ? `${e.type}:${e.tool}` : e.type === 'step' ? `step:${e.index}` : e.type))
    expect(told.filter((t, i) => t !== told[i - 1])).toEqual(['status', 'step:1', 'reasoning', 'reasoning-end', 'text', 'tool-input:get_project', 'tool-start:get_project', 'tool-end:get_project', 'step:2', 'text', 'done'])
    expect(events.find((e) => e.type === 'tool-end')).toMatchObject({ ok: true, output: '{"fps":30,"clips":2}' })
    // Cached tokens are counted as input, and shown apart.
    expect(events.at(-1)).toEqual({ runId: 'run_1', type: 'done', usage: { inputTokens: 18320, outputTokens: 70, cachedTokens: 9100, cacheWriteTokens: 9000, steps: 2 } })
  })

  it('sends the next turn the same bytes, so the earlier conversation is read from the cache', async () => {
    env.replies.push(stream([{ text: 'Made it bigger.' }], 'end_turn', { input: 80, read: 9300, output: 12 }))
    const before = JSON.parse(JSON.stringify(env.requests)) as never[]
    expect(before).toHaveLength(0)
    await turn({ runId: 'run_2', prompt: 'Make it bigger', context: '[Lumen] Playhead at frame 40.', instructions: 'Skill notes.' })
    const [third] = env.requests
    expect(third.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user'])
    // The first turn's message, files and all, exactly as it was sent then (but for where the marks are).
    const firstTurn = third.messages[0].content.map(({ cache_control: _mark, ...block }: { cache_control?: unknown }) => block)
    expect(firstTurn.map((b: { type: string }) => b.type)).toEqual(['text', 'image', 'text', 'text'])
    expect(firstTurn[3]).toEqual({ type: 'text', text: '[Lumen] Playhead at frame 0.\n\nAdd a title' })
    // Earlier turns keep what was said and done, without the thinking (it can't be replayed).
    expect(third.messages[1].content.map((b: { type: string }) => b.type)).toEqual(['text', 'tool_use'])
    // Two marks: the end of the earlier turns, and the end of this request.
    expect(marksIn(third.messages)).toEqual(['3:0', '4:0'])
    expect(third.messages[4].content[0].text).toBe('[Lumen] Playhead at frame 40.\n\nMake it bigger')
  })
})

describe('the pieces', () => {
  it('marks the last message and the end of earlier turns', () => {
    const m = (role: 'user' | 'assistant', text: string) => ({ role, content: text })
    const has = (list: ReturnType<typeof cacheMarks>) => list.map((x) => Boolean((x.providerOptions?.anthropic as { cacheControl?: unknown } | undefined)?.cacheControl))
    expect(has(cacheMarks([m('user', 'a')], 0))).toEqual([true])
    expect(has(cacheMarks([m('user', 'a'), m('assistant', 'b'), m('user', 'c')], 2))).toEqual([false, true, true])
    expect(has(cacheMarks([m('user', 'a'), m('assistant', 'b'), m('user', 'c'), m('assistant', 'd'), m('user', 'e')], 2))).toEqual([false, true, false, false, true])
    // A step builds on the last step's messages: the mark moves on, it doesn't pile up (Claude takes four).
    const step1 = cacheMarks([m('user', 'a'), m('assistant', 'b'), m('user', 'c')], 2)
    expect(has(cacheMarks([...step1, m('assistant', 'd'), m('user', 'e')], 2))).toEqual([false, true, false, false, true])
  })

  it('cuts a long conversation back in one go, at a request', () => {
    const history = Array.from({ length: 81 }, (_, i) => ({ role: i % 2 ? ('assistant' as const) : ('user' as const), content: `m${i}` }))
    expect(trim(history.slice(0, 80))).toHaveLength(80)
    const cut = trim(history)
    expect(cut.length).toBeLessThanOrEqual(40)
    expect(cut[0].role).toBe('user')
    expect(cut.at(-1)).toBe(history.at(-1))
  })

  it('knows what is worth another try', () => {
    expect([429, 500, 503, 529].map((statusCode) => isRetryable({ statusCode }))).toEqual([true, true, true, true])
    expect([400, 401, 404, 422].map((statusCode) => isRetryable({ statusCode }))).toEqual([false, false, false, false])
    expect(isRetryable(new Error('fetch failed'))).toBe(true)
    expect(isRetryable(new Error('Unknown model'))).toBe(false)
  })

  it('stores a request with its files as markers', () => {
    expect(userTurn({ prompt: 'Hi' })).toEqual({ role: 'user', content: 'Hi' })
    expect(userTurn({ prompt: 'Look', attachments: [{ id: 'att_0123456789ab', name: 'a.png', mime: 'image/png', size: 3, kind: 'image' }] })).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: '[[lumen-attachment:att_0123456789ab]]' },
        { type: 'text', text: 'Look' },
      ],
    })
  })
})
