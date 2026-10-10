/**
 * Tool calls in flight, so stopping a Copilot turn stops the work its tools
 * started (an export, waiting on a render, a cut-out) and not just the model.
 */
interface Call {
  /** The Copilot turn that asked (API models say; agents on the MCP server don't). */
  runId?: string
  startedAt: number
  controller: AbortController
}

const calls = new Set<Call>()

/** Registers a call. `done` must be called when it ends. */
export function trackCall(runId?: string) {
  const call: Call = { runId, startedAt: Date.now(), controller: new AbortController() }
  calls.add(call)
  return { signal: call.controller.signal, done: () => void calls.delete(call) }
}

/**
 * Stops the tool work of a turn: the calls made for it, and — for a local
 * agent, whose calls come in through the MCP server unnamed — any call that
 * started since the turn did.
 */
export function abortCalls(runId: string, unnamedSince?: number) {
  for (const call of calls) {
    if (call.runId === runId || (unnamedSince !== undefined && !call.runId && call.startedAt >= unnamedSince)) call.controller.abort()
  }
}

/** Thrown by a tool that was stopped. */
export class ToolStopped extends Error {
  constructor() {
    super('Stopped by the user.')
  }
}
