import { dynamicTool, isStepCount, jsonSchema, streamText, type ModelMessage, type SystemModelMessage, type ToolSet } from 'ai'
import { COPILOT_INSTRUCTIONS, type AgentErrorCode, type AgentEvent, type AgentEventBody, type AgentRunRequest, type AgentUsage } from '../../../shared/ai'
import { IPC, type BridgeTool } from '../../../shared/integrations'
import { callEditorTool, editorTools, editorWindow } from '../editor-rpc'
import { forgetAttachments, readAttachment } from './attachments'
import { deleteHistory, readHistory, writeHistory } from './chats'
import { claudeEfforts, effortSettings, geminiEfforts, openaiEfforts, type ModelApi } from './effort'
import { forgetLocalSession, runLocal, stopLocal } from './local-agents'
import { languageModel, MissingKeyError } from './providers'

/**
 * The Copilot's brain when it's a model the user brought a key for: an AI SDK
 * tool loop whose tools are the editor's own (the same ones Lumen serves over
 * MCP). Everything it does streams to the editor as it happens: each request
 * to the model, its thinking, the tool call it is writing, each tool's result.
 */

const histories = new Map<string, ModelMessage[]>()
const controllers = new Map<string, AbortController>()
const MAX_STEPS = 40
/** The conversation is cut back to KEEP messages once it passes MAX — in one go, so the cached prefix stays put between cuts. */
const MAX_HISTORY = 80
const KEEP_HISTORY = 40
/** Tries after the provider is busy or the connection drops, and how long to wait before each. */
const RETRY_WAITS = [2, 6, 15]

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
  forgetAttachments(conversationId)
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

type Options = Record<string, Record<string, unknown>>
type ProviderOptions = NonNullable<Parameters<typeof streamText>[0]['providerOptions']>

/**
 * Asks reasoning models to show their thinking. Claude 4.6 and later think
 * adaptively and send nothing of it unless a summary is asked for (a long,
 * silent wait otherwise); OpenAI sends summaries and Gemini its thoughts only
 * when asked.
 */
export function thinkingOptions(api: ModelApi, modelId: string): Options {
  if (api === 'anthropic' && claudeEfforts(modelId).includes('max')) return { anthropic: { thinking: { type: 'adaptive', display: 'summarized' } } }
  if (api === 'openai' && openaiEfforts(modelId).length) return { openai: { reasoningSummary: 'auto' } }
  if (api === 'google' && geminiEfforts(modelId).length) return { google: { thinkingConfig: { includeThoughts: true } } }
  return {}
}

/** Merges provider options one provider deep (effort, thinking display and caching all live there). */
function mergeOptions(...all: (Options | undefined)[]) {
  const out: Options = {}
  for (const opts of all) for (const [provider, values] of Object.entries(opts ?? {})) out[provider] = { ...out[provider], ...values }
  return out
}

/** Zod's JSON Schema output carries a $schema key some providers reject. */
function cleanSchema(schema: Record<string, unknown>) {
  const { $schema: _unused, ...rest } = schema
  void _unused
  return { type: 'object', properties: {}, ...rest } as Parameters<typeof jsonSchema>[0]
}

// ─── Prompt caching ──────────────────────────────────────────────────────
//
// Every step of a turn sends the tools, the instructions and the whole
// conversation again. Providers bill a cached prefix at a fraction, as long as
// it is byte for byte what was sent before — so the tools go in a fixed order,
// the instructions never change within a chat, and what changes each turn (the
// playhead, the selection) rides in the user's message, after everything cached.
//
// Claude caches only up to marked points: the end of the instructions (which
// covers the tools before them) and the end of the conversation so far. OpenAI
// and Gemini cache by themselves; OpenAI routes a chat's requests to the same
// cache when they share a key.

type CacheControl = { type: 'ephemeral'; ttl?: '1h' }

/**
 * How long the tools and instructions stay cached. People stop and think
 * between requests: an hour (written at twice the price, read many times) on
 * Anthropic's own API, the five-minute default through gateways.
 */
const prefixCache = (provider: string): CacheControl => (provider === 'anthropic' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' })

/** The standing instructions, marked as the end of the cached prefix for Claude. */
export function systemPrompt(api: ModelApi, provider: string, instructions: string | undefined): string | SystemModelMessage[] {
  const text = instructions ? `${COPILOT_INSTRUCTIONS}\n\n${instructions}` : COPILOT_INSTRUCTIONS
  if (api !== 'anthropic') return text
  return [{ role: 'system', content: text, providerOptions: { anthropic: { cacheControl: prefixCache(provider) } } }]
}

function marked(m: ModelMessage): ModelMessage {
  return { ...m, providerOptions: { ...m.providerOptions, anthropic: { ...m.providerOptions?.anthropic, cacheControl: { type: 'ephemeral' } } } } as ModelMessage
}

/** A message without a cache mark from an earlier step (each step's messages build on the last step's). */
function unmarked(m: ModelMessage): ModelMessage {
  const anthropic = m.providerOptions?.anthropic as Record<string, unknown> | undefined
  if (!anthropic?.cacheControl) return m
  const { cacheControl: _mark, ...rest } = anthropic
  void _mark
  return { ...m, providerOptions: { ...m.providerOptions, anthropic: rest } } as ModelMessage
}

/**
 * Marks where Claude caches the conversation: the last message (each step then
 * reads everything before it from the cache) and the last message of earlier
 * turns (their stored form differs from what the turn itself sent, so it is
 * written once at the start of a turn and read by every step after). Only
 * those two: Claude takes four marks a request, and the instructions hold one.
 */
export function cacheMarks(messages: ModelMessage[], earlier: number): ModelMessage[] {
  const last = messages.length - 1
  return messages.map((m, i) => (i === last || (earlier > 0 && i === earlier - 1) ? marked(m) : unmarked(m)))
}

/** Cache settings on the request itself, per provider. */
function cacheOptions(api: ModelApi, modelId: string, conversationId: string): Options {
  if (api === 'openai') return { openai: { promptCacheKey: conversationId.slice(0, 64) } }
  // OpenRouter passes this through to Claude models, which cache automatically with it.
  if (api === 'openrouter' && modelId.startsWith('anthropic/')) return { openrouter: { cache_control: { type: 'ephemeral' } } }
  return {}
}

// ─── Attached files ──────────────────────────────────────────────────────
//
// A message's attachments are stored as markers and put back from disk for
// every request, so the history stays small and each turn sends the same bytes
// (which is what lets them be read from the cache).

const MARKER = /^\[\[lumen-attachment:(att_[0-9a-f]{12})\]\]$/
const marker = (id: string) => `[[lumen-attachment:${id}]]`

/** The user's turn as it's stored. */
export function userTurn(req: Pick<AgentRunRequest, 'prompt' | 'context' | 'attachments'>): ModelMessage {
  const text = req.context ? `${req.context}\n\n${req.prompt}` : req.prompt
  if (!req.attachments?.length) return { role: 'user', content: text }
  return { role: 'user', content: [...req.attachments.map((a) => ({ type: 'text' as const, text: marker(a.id) })), { type: 'text', text }] }
}

type UserPart = Exclude<Extract<ModelMessage, { role: 'user' }>['content'], string>[number]

function attachmentParts(conversationId: string, id: string, can: { vision: boolean; pdf: boolean }): UserPart[] {
  const found = readAttachment(conversationId, id)
  if (!found) return [{ type: 'text', text: '[An attached file that is no longer kept.]' }]
  const { meta, bytes } = found
  const label = `Attached file “${meta.name}” (${id})`
  if (meta.kind === 'text') return [{ type: 'text', text: `${label}:\n<file>\n${bytes.toString('utf8')}\n</file>` }]
  if (meta.kind === 'image') {
    if (!can.vision) return [{ type: 'text', text: `[${label}: a picture, which this model can’t see.]` }]
    return [{ type: 'text', text: `${label}:` }, { type: 'file', data: bytes, mediaType: meta.mime }]
  }
  if (!can.pdf) return [{ type: 'text', text: `[${label}: a PDF, which this model can’t open. Tell the user, and suggest a Claude, GPT or Gemini model, or pasting the text.]` }]
  return [{ type: 'text', text: `${label}:` }, { type: 'file', data: bytes, mediaType: 'application/pdf', filename: meta.name }]
}

/** Puts attached files back where their markers are, in the form this model takes. */
export function withAttachments(messages: ModelMessage[], conversationId: string, can: { vision: boolean; pdf: boolean }): ModelMessage[] {
  return messages.map((m) => {
    if (m.role !== 'user' || !Array.isArray(m.content) || !m.content.some((p) => p.type === 'text' && MARKER.test(p.text))) return m
    return {
      ...m,
      content: m.content.flatMap((part) => {
        const id = part.type === 'text' ? MARKER.exec(part.text)?.[1] : undefined
        return id ? attachmentParts(conversationId, id, can) : [part]
      }),
    }
  })
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

/** Replaces tool pictures with a note — for the stored history, and for a model that can't see. */
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
    if (m.role === 'user' && Array.isArray(m.content) && isPictureMessage(m)) return { ...m, content: m.content.filter((c) => c.type === 'text') }
    return m
  })
}

/** What's kept between turns: no tool pictures, and very long tool results cut down so the conversation stays affordable. */
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

/** The provider is busy, or the connection dropped: worth another try. */
export function isRetryable(err: unknown) {
  const code = status(err)
  if (code !== undefined) return code === 408 || code === 409 || code === 429 || code >= 500
  return /fetch failed|network|socket|ECONNRESET|ETIMEDOUT|EAI_AGAIN|terminated|overloaded/i.test(message(err))
}

/** Rejects as soon as the run is stopped, whatever the work underneath is doing. */
function abortable<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work
  if (signal.aborted) return Promise.reject(new DOMException('Stopped.', 'AbortError'))
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new DOMException('Stopped.', 'AbortError'))
    signal.addEventListener('abort', stop, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop))
  })
}

function buildTools(defs: BridgeTool[], runId: string, pictures: Map<string, Picture[]>, modes: () => { native: boolean; vision: boolean }): ToolSet {
  const tools: ToolSet = {}
  // In name order whatever order they were registered or connected in: the tool list opens every request, and a cached prefix has to match exactly.
  for (const def of [...defs].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    tools[def.name] = dynamicTool({
      description: def.description,
      inputSchema: jsonSchema(cleanSchema(def.inputSchema)),
      execute: async (input, { toolCallId, abortSignal }): Promise<ToolOutput> => {
        const res = await abortable(callEditorTool(def.name, (input ?? {}) as Record<string, unknown>, undefined, runId), abortSignal)
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
  return [...earlier, { role: 'user', content: [{ type: 'text', text: PICTURES_NOTE }, ...pics.map((p) => ({ type: 'file' as const, data: p.data, mediaType: p.mimeType }))] }]
}

/** Keeps the conversation bounded, cutting only at a user turn so tool calls stay paired. */
export function trim(history: ModelMessage[]) {
  if (history.length <= MAX_HISTORY) return history
  let start = history.length - KEEP_HISTORY
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
    const pdf = api !== 'compatible'
    let vision = canSee !== false && !textOnly.has(key)
    let effort = req.target.effort && !noEffort.has(key) ? req.target.effort : undefined
    const pictures = new Map<string, Picture[]>()
    emit({ type: 'status', message: 'Getting the tools ready…' })
    const tools = buildTools(await editorTools(), runId, pictures, () => ({ native, vision }))
    const system = systemPrompt(api, provider, req.instructions)

    const stored = historyOf(req.conversationId)
    const earlier = native ? stripReasoning(stored) : stored
    const user = userTurn(req)
    // Steps already completed, carried into a retry so no tool runs twice.
    let carried: ModelMessage[] = []
    let completed: ModelMessage[] = []
    let wroteText = false
    let afterTool = false
    let lastFinish = ''
    const usage: Required<Pick<AgentUsage, 'inputTokens' | 'outputTokens' | 'cachedTokens' | 'cacheWriteTokens' | 'steps'>> = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, steps: 0 }
    const retried = { pictures: false, effort: false, busy: 0 }
    const carry = (steps: ModelMessage[]) => {
      const kept = stripPictures(steps)
      return native ? stripReasoning(kept) : kept
    }
    // A tool call's input as the model writes it: who it is for and how much has arrived.
    const writing = new Map<string, { tool: string; chars: number; told: number }>()

    for (;;) {
      try {
        const effortOpts = effortSettings(api, effort)
        const can = { vision, pdf }
        const result = streamText({
          model,
          system,
          messages: withAttachments([...earlier, user, ...carried], req.conversationId, can),
          tools,
          headers,
          ...effortOpts,
          providerOptions: mergeOptions(effortOpts.providerOptions as Options | undefined, thinkingOptions(api, modelId), cacheOptions(api, modelId, req.conversationId)) as ProviderOptions,
          stopWhen: isStepCount(MAX_STEPS),
          // Retries are done here, where the chat can be told about them.
          maxRetries: 0,
          abortSignal: controller.signal,
          prepareStep: ({ messages, responseMessages }) => {
            completed = responseMessages as ModelMessage[]
            // Said before the request goes out: until the first word comes back, this is all there is to show.
            usage.steps++
            emit({ type: 'step', index: usage.steps })
            const next = native || !vision ? undefined : withPictures(messages, pictures)
            if (!native) return next ? { messages: next } : undefined
            return { messages: cacheMarks(messages, earlier.length) }
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
            case 'reasoning-end':
              emit({ type: 'reasoning-end' })
              break
            case 'tool-input-start':
              writing.set(part.id, { tool: part.toolName, chars: 0, told: Date.now() })
              emit({ type: 'tool-input', callId: part.id, tool: part.toolName, chars: 0 })
              break
            case 'tool-input-delta': {
              const w = writing.get(part.id)
              if (!w) break
              w.chars += part.delta.length
              // A long composition arrives in hundreds of pieces: a few updates a second is plenty.
              if (Date.now() - w.told > 300) {
                w.told = Date.now()
                emit({ type: 'tool-input', callId: part.id, tool: w.tool, chars: w.chars })
              }
              break
            }
            case 'tool-call':
              afterTool = true
              writing.delete(part.toolCallId)
              emit({ type: 'tool-start', callId: part.toolCallId, tool: part.toolName, input: part.input })
              break
            case 'tool-result': {
              const text = (part.output as ToolOutput | undefined)?.text ?? (typeof part.output === 'string' ? part.output : JSON.stringify(part.output))
              emit({ type: 'tool-end', callId: part.toolCallId, tool: part.toolName, ok: true, summary: brief(text), output: clip(text) })
              break
            }
            case 'tool-error':
              emit({ type: 'tool-end', callId: part.toolCallId, tool: part.toolName, ok: false, summary: brief(message(part.error)), output: clip(message(part.error)) })
              break
            case 'finish-step':
              usage.inputTokens += part.usage.inputTokens ?? 0
              usage.outputTokens += part.usage.outputTokens ?? 0
              usage.cachedTokens += part.usage.inputTokenDetails?.cacheReadTokens ?? 0
              usage.cacheWriteTokens += part.usage.inputTokenDetails?.cacheWriteTokens ?? 0
              lastFinish = part.finishReason
              break
            case 'abort':
              throw new DOMException('Stopped.', 'AbortError')
            case 'error':
              throw part.error
          }
        }
        // Every step's messages — tool calls and results included — so later turns remember what was looked up.
        const steps = (await result.responseMessages) as ModelMessage[]
        const next = trim(forHistory([...stored, user, ...carried, ...steps]))
        histories.set(req.conversationId, next)
        writeHistory(req.conversationId, next)
        if (lastFinish === 'tool-calls') emit({ type: 'note', message: `Stopped after ${MAX_STEPS} steps in one go. Say “continue” and it carries on from here.` })
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
          completed = []
          emit({ type: 'note', message: 'This model can’t look at images — carrying on without them.' })
          continue
        }
        if (effort && !retried.effort && isEffortRejection(err)) {
          // The model turned the effort setting down: remember that and carry on at its default.
          retried.effort = true
          noEffort.add(key)
          effort = undefined
          carried = carry([...carried, ...completed])
          completed = []
          emit({ type: 'note', message: 'This model doesn’t take that effort setting — carrying on with its default.' })
          continue
        }
        if (retried.busy < RETRY_WAITS.length && isRetryable(err)) {
          // Busy or cut off: wait, then carry on from the steps already done (no tool runs twice).
          const wait = RETRY_WAITS[retried.busy++]
          carried = carry([...carried, ...completed])
          completed = []
          emit({ type: 'note', message: `${status(err) === 429 ? 'The provider is rate-limiting requests' : 'The provider didn’t answer'} (${brief(friendly(err)).slice(0, 90)}). Trying again in ${wait} s — try ${retried.busy} of ${RETRY_WAITS.length}.` })
          await abortable(new Promise((r) => setTimeout(r, wait * 1000)), controller.signal)
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

/** A tool's result as the chat shows it when a step is opened: enough to follow, not megabytes. */
function clip(text: string) {
  const LIMIT = 4000
  return text.length > LIMIT ? `${text.slice(0, LIMIT)}\n… (${text.length - LIMIT} more characters)` : text
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
