import { dynamicTool, isStepCount, jsonSchema, streamText, type ModelMessage, type ToolSet } from 'ai'
import { COPILOT_INSTRUCTIONS, type AgentErrorCode, type AgentEvent, type AgentEventBody, type AgentRunRequest } from '../../../shared/ai'
import { IPC, type BridgeTool } from '../../../shared/integrations'
import { callEditorTool, editorTools, editorWindow } from '../editor-rpc'
import { deleteHistory, readHistory, writeHistory } from './chats'
import { effortSettings, geminiEfforts, openaiEfforts, type ModelApi } from './effort'
import { forgetLocalSession, runLocal, stopLocal } from './local-agents'
import { languageModel, MissingKeyError } from './providers'

/**
 * The Copilot's brain when it's a model the user brought a key for: an AI SDK
 * tool loop whose tools are the editor's own (the same ones Lumen serves over
 * MCP). Events stream to the editor as they happen.
 */

const histories = new Map<string, ModelMessage[]>()
const controllers = new Map<string, AbortController>()
const MAX_STEPS = 24
const MAX_HISTORY = 40

export function emitAgent(e: AgentEvent) {
  editorWindow()?.webContents.send(IPC.aiEvent, e)
}

export async function startAgentRun(req: AgentRunRequest) {
  if (req.target.kind === 'local') {
    void runLocal(req, emitAgent).catch((err) => emitAgent({ runId: req.runId, type: 'error', code: 'failed', message: message(err) }))
    return
  }
  void runModel(req)
}

export function stopAgentRun(runId: string) {
  controllers.get(runId)?.abort()
  stopLocal(runId)
}

export function forgetConversation(conversationId: string) {
  histories.delete(conversationId)
  deleteHistory(conversationId)
  forgetLocalSession(conversationId)
}

/** What a conversation remembers: this session's turns, or those saved before a restart. */
function historyOf(conversationId: string) {
  let h = histories.get(conversationId)
  if (!h) {
    h = readHistory(conversationId) ?? []
    histories.set(conversationId, h)
  }
  return h
}

/**
 * Asks reasoning models to show their thinking: OpenAI sends summaries of it
 * and Gemini its thoughts only when asked (Claude's thinking streams as is).
 */
function thinkingOptions(api: ModelApi, modelId: string): Record<string, Record<string, unknown>> {
  if (api === 'openai' && openaiEfforts(modelId).length) return { openai: { reasoningSummary: 'auto' } }
  if (api === 'google' && geminiEfforts(modelId).length) return { google: { thinkingConfig: { includeThoughts: true } } }
  return {}
}

type ProviderOptions = NonNullable<Parameters<typeof streamText>[0]['providerOptions']>

/** Merges provider options one provider deep (effort settings and thinking display both live there). */
function mergeOptions(...all: (Record<string, Record<string, unknown>> | undefined)[]) {
  const out: Record<string, Record<string, unknown>> = {}
  for (const opts of all) for (const [provider, values] of Object.entries(opts ?? {})) out[provider] = { ...out[provider], ...values }
  return out
}

/** Zod's JSON Schema output carries a $schema key some providers reject. */
function cleanSchema(schema: Record<string, unknown>) {
  const { $schema: _unused, ...rest } = schema
  void _unused
  return { type: 'object', properties: {}, ...rest } as Parameters<typeof jsonSchema>[0]
}

// ─── Pictures ────────────────────────────────────────────────────────────
//
// Tools like get_frame return images. Claude takes them inside the tool result;
// every other provider gets them as a message right after it (which all vision
// models accept). A model that turns out not to take images is remembered, and
// its tools' pictures become a short note instead.

interface Picture {
  data: string
  mimeType: string
}

interface ToolOutput {
  text: string
  pictures: number
}

const PICTURES_NOTE = 'The pictures from the tools you just called:'
const FOLLOWS_NOTE = '[The picture follows in the next message.]'
const DROPPED_NOTE = '[picture — not kept]'
/** "provider:model" pairs that rejected images. */
const textOnly = new Set<string>()
/** "provider:model" pairs that rejected an effort setting. */
const noEffort = new Set<string>()

function isPictureMessage(m: ModelMessage) {
  return m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'text' && m.content[0].text === PICTURES_NOTE
}

const isImageType = (mediaType: unknown) => typeof mediaType === 'string' && mediaType.startsWith('image')

/** Replaces images with a note — for the stored history, and for a model that can't see. */
function stripPictures(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return {
        ...m,
        content: m.content.map((part) => {
          if (part.type !== 'tool-result') return part
          // The picture message that followed isn't kept either.
          if (part.output.type === 'text') return part.output.value.includes(FOLLOWS_NOTE) ? { ...part, output: { ...part.output, value: part.output.value.replace(FOLLOWS_NOTE, DROPPED_NOTE) } } : part
          if (part.output.type !== 'content') return part
          const value = part.output.value.map((v) =>
            (v.type === 'file' || v.type === 'image-data' || v.type === 'file-data') && isImageType(v.mediaType) ? { type: 'text' as const, text: DROPPED_NOTE } : v,
          )
          return { ...part, output: { ...part.output, value } }
        }),
      }
    }
    if (m.role === 'user' && Array.isArray(m.content) && m.content.some((c) => c.type === 'image' || (c.type === 'file' && isImageType(c.mediaType)))) {
      return { ...m, content: m.content.filter((c) => c.type === 'text') }
    }
    return m
  })
}

/** What's kept between turns: no pictures, and very long tool results cut down so the conversation stays affordable. */
function forHistory(messages: ModelMessage[]): ModelMessage[] {
  const LIMIT = 6000
  return stripPictures(messages).map((m) => {
    if (m.role !== 'tool') return m
    return {
      ...m,
      content: m.content.map((part) =>
        part.type === 'tool-result' && part.output.type === 'text' && part.output.value.length > LIMIT
          ? { ...part, output: { ...part.output, value: `${part.output.value.slice(0, LIMIT)}\n…[cut for length — call the tool again for the rest]` } }
          : part,
      ),
    }
  })
}

/**
 * Claude binds each thinking block to the exact conversation before it, and the
 * stored history is edited (pictures dropped, long results cut), so earlier
 * turns' thinking can't be replayed — it would be rejected. It only matters
 * within the turn that produced it, so it's left out of later turns.
 */
function stripReasoning(messages: ModelMessage[]): ModelMessage[] {
  return messages.flatMap((m) => {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) return [m]
    const content = m.content.filter((part) => part.type !== 'reasoning')
    return content.length ? [{ ...m, content }] : []
  })
}

/** A 400-ish error that says the model doesn't take image input. */
function isPictureRejection(err: unknown) {
  const code = status(err)
  if (code !== undefined && code !== 400 && code !== 415 && code !== 422) return false
  return /image|vision|multi-?modal|modalit/i.test(message(err))
}

/** A 400-ish error about the effort / reasoning / thinking setting. */
function isEffortRejection(err: unknown) {
  const code = status(err)
  if (code !== undefined && code !== 400 && code !== 422) return false
  return /effort|reasoning|thinking|budget/i.test(message(err))
}

function buildTools(defs: BridgeTool[], pictures: Map<string, Picture[]>, modes: () => { native: boolean; vision: boolean }): ToolSet {
  const tools: ToolSet = {}
  for (const def of defs) {
    tools[def.name] = dynamicTool({
      description: def.description,
      inputSchema: jsonSchema(cleanSchema(def.inputSchema)),
      execute: async (input, { toolCallId }): Promise<ToolOutput> => {
        const res = await callEditorTool(def.name, (input ?? {}) as Record<string, unknown>)
        const text = res.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n')
        if (res.isError) throw new Error(text || 'The tool failed.')
        const pics = res.content.flatMap((c) => (c.type === 'image' ? [{ data: c.data, mimeType: c.mimeType }] : []))
        if (pics.length) pictures.set(toolCallId, pics)
        return { text, pictures: pics.length }
      },
      toModelOutput: ({ toolCallId, output }) => {
        const out = output as ToolOutput
        const pics = pictures.get(toolCallId) ?? []
        if (!pics.length) return { type: 'text', value: out.text }
        const { native, vision } = modes()
        if (!vision) return { type: 'text', value: `${out.text}\n\n[${pics.length} picture${pics.length > 1 ? 's' : ''} not shown — this model can’t see images.]` }
        if (!native) return { type: 'text', value: `${out.text}\n\n${FOLLOWS_NOTE}` }
        return {
          type: 'content',
          value: [{ type: 'text', text: out.text }, ...pics.map((p) => ({ type: 'file' as const, mediaType: p.mimeType, data: { type: 'data' as const, data: p.data } }))],
        }
      },
    })
  }
  return tools
}

/** For providers without pictures in tool results: show the latest tool pictures as a message, dropping older ones. */
function withPictures(messages: ModelMessage[], pictures: Map<string, Picture[]>): ModelMessage[] | undefined {
  const last = messages[messages.length - 1]
  if (last?.role !== 'tool') return undefined
  const pics = last.content.flatMap((part) => (part.type === 'tool-result' ? (pictures.get(part.toolCallId) ?? []) : []))
  if (!pics.length) return undefined
  const earlier = messages.map((m) => (isPictureMessage(m) ? { role: 'user' as const, content: [{ type: 'text' as const, text: '[Earlier pictures — no longer attached.]' }] } : m))
  return [...earlier, { role: 'user', content: [{ type: 'text', text: PICTURES_NOTE }, ...pics.map((p) => ({ type: 'image' as const, image: p.data, mediaType: p.mimeType }))] }]
}

/** Keeps the conversation bounded, cutting only at a user turn so tool calls stay paired. */
function trim(history: ModelMessage[]) {
  if (history.length <= MAX_HISTORY) return history
  let start = history.length - MAX_HISTORY
  while (start < history.length && history[start].role !== 'user') start++
  return history.slice(start)
}

async function runModel(req: AgentRunRequest) {
  if (req.target.kind !== 'model') return
  const { runId } = req
  const controller = new AbortController()
  controllers.set(runId, controller)
  const emit = (e: AgentEventBody) => emitAgent({ runId, ...e })
  try {
    const { provider, model: modelId } = req.target
    const { model, api, vision: canSee, headers } = await languageModel(provider, modelId, req.conversationId)
    const key = `${provider}:${modelId}`
    // Claude-style APIs take pictures inside tool results; the rest get them in a message after.
    const native = api === 'anthropic'
    let vision = canSee !== false && !textOnly.has(key)
    let effort = req.target.effort && !noEffort.has(key) ? req.target.effort : undefined
    const pictures = new Map<string, Picture[]>()
    const tools = buildTools(await editorTools(), pictures, () => ({ native, vision }))

    const stored = historyOf(req.conversationId)
    const history = native ? stripReasoning(stored) : stored
    const user: ModelMessage = { role: 'user', content: req.context ? `${req.context}\n\n${req.prompt}` : req.prompt }
    // Steps already completed, carried into a retry so no tool runs twice.
    let carried: ModelMessage[] = []
    let completed: ModelMessage[] = []
    let wroteText = false
    let afterTool = false
    let usage: { inputTokens?: number; outputTokens?: number } | undefined
    const retried = { pictures: false, effort: false }
    const carry = (steps: ModelMessage[]) => {
      const kept = stripPictures(steps)
      return native ? stripReasoning(kept) : kept
    }

    for (;;) {
      try {
        const effortOpts = effortSettings(api, effort)
        const result = streamText({
          model,
          system: req.instructions ? `${COPILOT_INSTRUCTIONS}\n\n${req.instructions}` : COPILOT_INSTRUCTIONS,
          messages: [...history, user, ...carried],
          tools,
          headers,
          ...effortOpts,
          providerOptions: mergeOptions(effortOpts.providerOptions, thinkingOptions(api, modelId)) as ProviderOptions,
          stopWhen: isStepCount(MAX_STEPS),
          abortSignal: controller.signal,
          prepareStep: ({ messages, responseMessages }) => {
            completed = responseMessages as ModelMessage[]
            if (native || !vision) return undefined
            const next = withPictures(messages, pictures)
            return next ? { messages: next } : undefined
          },
        })
        for await (const part of result.fullStream) {
          switch (part.type) {
            case 'text-delta':
              if (!part.text) break
              emit({ type: 'text', delta: afterTool && wroteText ? `\n\n${part.text}` : part.text })
              wroteText = true
              afterTool = false
              break
            case 'reasoning-delta':
              if (part.text) emit({ type: 'reasoning', delta: part.text })
              break
            case 'tool-call':
              afterTool = true
              emit({ type: 'tool-start', callId: part.toolCallId, tool: part.toolName, input: part.input })
              break
            case 'tool-result':
              emit({ type: 'tool-end', callId: part.toolCallId, tool: part.toolName, ok: true, summary: brief((part.output as ToolOutput | undefined)?.text ?? part.output) })
              break
            case 'tool-error':
              emit({ type: 'tool-end', callId: part.toolCallId, tool: part.toolName, ok: false, summary: brief(message(part.error)) })
              break
            case 'error':
              throw part.error
            case 'finish':
              usage = { inputTokens: part.totalUsage.inputTokens, outputTokens: part.totalUsage.outputTokens }
              break
          }
        }
        // Every step's messages — tool calls and results included — so later turns remember what was looked up.
        const steps = (await result.responseMessages) as ModelMessage[]
        const next = trim(forHistory([...stored, user, ...carried, ...steps]))
        histories.set(req.conversationId, next)
        writeHistory(req.conversationId, next)
        emit({ type: 'done', usage })
        return
      } catch (err) {
        if (controller.signal.aborted) throw err
        if (vision && !retried.pictures && isPictureRejection(err)) {
          // The model can't take images: remember that and carry on from the steps already done.
          retried.pictures = true
          textOnly.add(key)
          vision = false
          carried = carry([...carried, ...completed])
          emit({ type: 'status', message: 'This model can’t look at images — carrying on without them.' })
          continue
        }
        if (effort && !retried.effort && isEffortRejection(err)) {
          // The model turned the effort setting down: remember that and carry on at its default.
          retried.effort = true
          noEffort.add(key)
          effort = undefined
          carried = carry([...carried, ...completed])
          emit({ type: 'status', message: 'This model doesn’t take that effort setting — carrying on with its default.' })
          continue
        }
        throw err
      }
    }
  } catch (err) {
    if (controller.signal.aborted) emit({ type: 'error', code: 'cancelled', message: 'Stopped.' })
    else emit({ type: 'error', code: classify(err), message: friendly(err) })
  } finally {
    controllers.delete(runId)
  }
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

function brief(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return (text ?? '').replace(/\s+/g, ' ').trim().slice(0, 160)
}

function status(err: unknown): number | undefined {
  const e = err as { statusCode?: number; status?: number; cause?: { statusCode?: number } }
  return e?.statusCode ?? e?.status ?? e?.cause?.statusCode
}

function classify(err: unknown): AgentErrorCode {
  if (err instanceof MissingKeyError) return 'no-key'
  const code = status(err)
  if (code === 401 || code === 403) return 'auth'
  if (code === 429) return 'rate-limit'
  return 'failed'
}

function friendly(err: unknown) {
  const code = status(err)
  if (code === 401 || code === 403) return 'The provider rejected the API key. Update it in Integrations › AI models.'
  if (code === 429) return 'The provider is rate-limiting requests right now — try again in a moment.'
  if (code === 404) return `The provider doesn’t know that model. Pick another one. (${message(err)})`
  return message(err)
}
