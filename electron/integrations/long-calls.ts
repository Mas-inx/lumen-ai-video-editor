import { randomBytes } from 'node:crypto'
import type { BridgeTool, BridgeToolResult } from '../../shared/integrations'

/**
 * Tool calls that outlast what an MCP client will wait for. Clients give up on
 * a call after a while — some after 25 seconds, many after 60 — and when they
 * do, the agent sees a network error although the work carries on. So a call
 * that is still running after a short while answers "running" with a call id,
 * the work continues, and the agent collects the result with get_tool_result.
 */

/** How long a call may run before it answers "running". Under the shortest client limits seen (about 25 s). */
export const EARLY_RETURN_MS = 20_000
/** How long get_tool_result waits by default, and at most. */
const RESULT_WAIT_MS = 20_000
const RESULT_WAIT_MAX_MS = 50_000
/** Results are kept this long after the work finishes. */
const KEEP_MS = 30 * 60_000
const KEEP_CALLS = 100

export const RESULT_TOOL = 'get_tool_result'

export const RESULT_TOOL_DEFINITION: BridgeTool = {
  name: RESULT_TOOL,
  description:
    'Collect the result of a tool call that answered {"status":"running","call_id":…} because it was taking a while (exports, renders, transcription, subject cut-outs). The work carries on in Lumen meanwhile. Waits up to wait_seconds for it; while it answers status running, call it again. Results are kept for 30 minutes.',
  inputSchema: {
    type: 'object',
    properties: {
      call_id: { type: 'string', description: 'The call_id from the running answer' },
      wait_seconds: { type: 'number', description: 'How long to wait for it this time (default 20, max 50)', minimum: 0, maximum: 50 },
    },
    required: ['call_id'],
    additionalProperties: false,
  },
}

interface Call {
  id: string
  tool: string
  startedAt: number
  promise: Promise<BridgeToolResult>
  result?: BridgeToolResult
  finishedAt?: number
}

const calls = new Map<string, Call>()

const sleep = (ms: number) =>
  new Promise<null>((resolve) => {
    const t = setTimeout(() => resolve(null), ms)
    t.unref?.()
  })

function running(call: Call): BridgeToolResult {
  const body = {
    status: 'running',
    call_id: call.id,
    tool: call.tool,
    elapsed_seconds: Math.round((Date.now() - call.startedAt) / 1000),
    next: `${call.tool} is still working in Lumen — nothing was lost. Call ${RESULT_TOOL} with this call_id to get its result (call it again while it answers running). Don’t call ${call.tool} again.`,
  }
  return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], structuredContent: body }
}

function prune() {
  const now = Date.now()
  for (const [id, call] of calls) if (call.finishedAt && now - call.finishedAt > KEEP_MS) calls.delete(id)
  // Never unbounded: the oldest finished calls go first.
  if (calls.size > KEEP_CALLS) {
    const finished = [...calls.values()].filter((c) => c.finishedAt).sort((a, b) => a.finishedAt! - b.finishedAt!)
    for (const call of finished.slice(0, calls.size - KEEP_CALLS)) calls.delete(call.id)
  }
}

/**
 * Runs a tool call, answering with its result if it finishes within `budgetMs`
 * and with a "running" answer (and a call id for {@link collect}) if not.
 */
export async function runWithin(tool: string, run: () => Promise<BridgeToolResult>, budgetMs = EARLY_RETURN_MS): Promise<BridgeToolResult> {
  const startedAt = Date.now()
  const promise = run().catch((err: unknown): BridgeToolResult => ({ content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true }))
  const first = await Promise.race([promise, sleep(budgetMs)])
  if (first) return first
  prune()
  const call: Call = { id: `call_${randomBytes(6).toString('hex')}`, tool, startedAt, promise }
  calls.set(call.id, call)
  void promise.then((result) => {
    call.result = result
    call.finishedAt = Date.now()
  })
  return running(call)
}

/** get_tool_result: the result of a call that answered "running", waiting for it a while. */
export async function collect(args: Record<string, unknown>): Promise<BridgeToolResult> {
  prune()
  const id = typeof args.call_id === 'string' ? args.call_id : ''
  const call = calls.get(id)
  if (!call) {
    return { content: [{ type: 'text', text: `There’s no call ${id || '(no call_id given)'} — results are kept for 30 minutes, and each Lumen session has its own.` }], isError: true }
  }
  if (call.result) return call.result
  const wait = typeof args.wait_seconds === 'number' && Number.isFinite(args.wait_seconds) ? Math.min(RESULT_WAIT_MAX_MS, Math.max(0, args.wait_seconds * 1000)) : RESULT_WAIT_MS
  return (await Promise.race([call.promise, sleep(wait)])) ?? running(call)
}

/** Calls still working, for a status line. */
export const pendingCalls = () => [...calls.values()].filter((c) => !c.finishedAt).map((c) => ({ id: c.id, tool: c.tool, startedAt: c.startedAt }))

export function forgetCalls() {
  calls.clear()
}
