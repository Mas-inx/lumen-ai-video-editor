import { app } from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { IPC, isPrivateHost, type Job, type McpAgentResult, type McpLink, type McpServerConfig, type McpServerState, type McpTool } from '../../../shared/integrations'
import { broadcast, createJob, failJob, finishJob, getJob, isCancelled, setCanceller, updateJob } from '../jobs'
import { readJson, writeJson } from '../paths'
import { getSecret, setSecret } from '../secrets'
import { clearAuth, hasTokens, LumenOAuthProvider } from './oauth'
import { convertResult } from './results'

/**
 * Lumen as an MCP host: connections to any MCP server — local (stdio) or
 * hosted (Streamable HTTP / SSE, with OAuth) — live here in the main process.
 * The editor lists their tools, calls them, and turns results into media.
 */

const CONFIG = 'mcp-servers.json'

interface Entry {
  config: McpServerConfig
  status: McpServerState['status']
  error?: string
  tools: McpTool[]
  server?: { name: string; version: string }
  client?: Client
  transport?: Transport
  auth?: LumenOAuthProvider
  connecting?: Promise<void>
  stderr: string[]
}

const entries = new Map<string, Entry>()
let loaded = false

function load() {
  if (loaded) return
  loaded = true
  for (const config of readJson<McpServerConfig[]>(CONFIG, [])) {
    // Older configs kept headers in plain JSON: move them into the secret store.
    if (config.headers && Object.keys(config.headers).length) {
      setSecret(headerSecret(config.id), JSON.stringify(config.headers))
      delete config.headers
    }
    entries.set(config.id, { config, status: 'disconnected', tools: [], stderr: [] })
  }
}

/** Header values (API keys) live encrypted in the secret store, not in the JSON config. */
const headerSecret = (id: string) => `mcp-headers:${id}`

function secretHeaders(id: string): Record<string, string> {
  try {
    return JSON.parse(getSecret(headerSecret(id)) ?? '{}') as Record<string, string>
  } catch {
    return {}
  }
}

function persist() {
  writeJson(
    CONFIG,
    [...entries.values()].map((e) => ({ ...e.config, headers: undefined })),
  )
}

function snapshot(e: Entry): McpServerState {
  return {
    config: e.config,
    status: e.status,
    error: e.error,
    tools: e.tools,
    server: e.server,
    authorized: e.config.transport === 'http' ? hasTokens(e.config.id) : undefined,
  }
}

function emit(e: Entry) {
  broadcast(IPC.mcpEvent, snapshot(e))
}

function entry(id: string) {
  load()
  const e = entries.get(id)
  if (!e) throw new Error(`No MCP server “${id}”`)
  return e
}

export function listServers(): McpServerState[] {
  load()
  return [...entries.values()].map(snapshot)
}

export async function saveServer(config: McpServerConfig): Promise<McpServerState[]> {
  load()
  validate(config)
  if (config.headers) {
    if (Object.keys(config.headers).length) setSecret(headerSecret(config.id), JSON.stringify(config.headers))
    config = { ...config, headers: undefined }
  }
  const existing = entries.get(config.id)
  if (existing) {
    // switching agent access or the description needs no reconnect
    const connection = (c: McpServerConfig) => JSON.stringify({ ...c, agentTools: undefined, description: undefined })
    const changed = connection(existing.config) !== connection(config)
    existing.config = config
    if (changed && existing.client) await disconnectServer(config.id)
  } else {
    entries.set(config.id, { config, status: 'disconnected', tools: [], stderr: [] })
  }
  persist()
  return listServers()
}

export async function removeServer(id: string): Promise<McpServerState[]> {
  load()
  if (entries.has(id)) {
    await disconnectServer(id)
    entries.delete(id)
    clearAuth(id)
    setSecret(headerSecret(id), null)
    persist()
  }
  return listServers()
}

function validate(config: McpServerConfig) {
  if (!/^[\w-]{1,64}$/.test(config.id)) throw new Error('Server ids may only use letters, numbers, - and _.')
  if (config.transport === 'http') {
    const url = new URL(config.url ?? '')
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isPrivateHost(url.hostname)))
      throw new Error('Remote MCP servers must use https:// (plain http only on this computer or your local network)')
  } else if (!config.command?.trim()) {
    throw new Error('A local MCP server needs a command to run.')
  }
}

// ─── Connections ─────────────────────────────────────────────────────────

async function open(e: Entry) {
  const { config } = e
  const connect = async (transport: Transport) => {
    const client = new Client({ name: 'Lumen', version: app.getVersion() })
    e.transport = transport
    await client.connect(transport)
    return client
  }
  let client: Client
  if (config.transport === 'stdio') {
    const stdio = new StdioClientTransport({
      command: config.command!,
      args: config.args ?? [],
      env: { ...getDefaultEnvironment(), ...config.env },
      stderr: 'pipe',
    })
    e.stderr = []
    stdio.stderr?.on('data', (chunk: Buffer) => {
      e.stderr.push(...chunk.toString('utf8').split(/\r?\n/).filter(Boolean))
      e.stderr.splice(0, Math.max(0, e.stderr.length - 30))
    })
    client = await connect(stdio)
  } else {
    e.auth ??= new LumenOAuthProvider(config.id)
    const url = new URL(config.url!)
    const opts = { authProvider: e.auth, requestInit: { headers: secretHeaders(config.id) } }
    try {
      client = await connect(new StreamableHTTPClientTransport(url, opts))
    } catch (err) {
      // Older servers only speak the HTTP+SSE transport.
      if (!(err instanceof StreamableHTTPError) || ![400, 404, 405].includes(err.code ?? 0)) throw err
      client = await connect(new SSEClientTransport(url, opts))
    }
  }
  e.client = client
  const info = client.getServerVersion()
  e.server = info ? { name: info.name, version: info.version } : undefined
  client.onclose = () => {
    if (e.client !== client) return
    e.client = undefined
    e.transport = undefined
    if (e.status === 'connected') e.status = 'disconnected'
    emit(e)
  }
  e.tools = await listTools(client)
}

async function listTools(client: Client): Promise<McpTool[]> {
  if (!client.getServerCapabilities()?.tools) return []
  const tools: McpTool[] = []
  let cursor: string | undefined
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined)
    for (const t of page.tools)
      tools.push({
        name: t.name,
        title: t.title ?? t.annotations?.title,
        description: t.description,
        inputSchema: t.inputSchema as Record<string, unknown>,
        annotations: t.annotations ? { readOnlyHint: t.annotations.readOnlyHint, destructiveHint: t.annotations.destructiveHint } : undefined,
      })
    cursor = page.nextCursor
  } while (cursor && tools.length < 500)
  return tools
}

export async function connectServer(id: string): Promise<McpServerState> {
  const e = entry(id)
  if (e.client && e.status === 'connected') return snapshot(e)
  if (!e.connecting) {
    e.connecting = (async () => {
      e.status = 'connecting'
      e.error = undefined
      emit(e)
      try {
        await open(e)
        e.status = 'connected'
      } catch (err) {
        if (err instanceof UnauthorizedError && e.auth?.authorizationCode && e.transport instanceof StreamableHTTPClientTransport) {
          // The browser is open on the service's sign-in page; wait for it to come back.
          e.status = 'needs-auth'
          emit(e)
          try {
            const code = await e.auth.authorizationCode
            await e.transport.finishAuth(code)
            e.auth.authorizationCode = null
            await open(e)
            e.status = 'connected'
          } catch (authErr) {
            e.status = 'error'
            e.error = message(authErr)
          }
        } else {
          e.status = 'error'
          e.error = message(err) + (e.stderr.length ? `\n${e.stderr.slice(-4).join('\n')}` : '')
          await e.client?.close().catch(() => {})
          e.client = undefined
        }
      } finally {
        e.connecting = undefined
        emit(e)
      }
    })()
  }
  await e.connecting
  return snapshot(e)
}

export async function disconnectServer(id: string): Promise<McpServerState> {
  const e = entry(id)
  const client = e.client
  e.client = undefined
  e.transport = undefined
  e.status = 'disconnected'
  e.tools = []
  await client?.close().catch(() => {})
  emit(e)
  return snapshot(e)
}

export async function signOut(id: string): Promise<McpServerState> {
  await disconnectServer(id)
  clearAuth(id)
  const e = entry(id)
  e.auth = undefined
  emit(e)
  return snapshot(e)
}

export async function disconnectAll() {
  await Promise.all([...entries.keys()].map((id) => disconnectServer(id).catch(() => {})))
}

// ─── Tool calls ──────────────────────────────────────────────────────────

/** Starts a tool call and returns its job right away; progress and the result follow as job events. */
export async function startToolCall(serverId: string, tool: string, args: Record<string, unknown>): Promise<{ job: Job; done: Promise<Job> }> {
  const e = entry(serverId)
  if (!e.client) await connectServer(serverId)
  if (!e.client) throw new Error(e.error ?? `${e.config.name} isn’t connected.`)
  const client = e.client
  const job = createJob('mcp', `${e.config.name} · ${e.tools.find((t) => t.name === tool)?.title ?? tool}`)
  const controller = new AbortController()
  setCanceller(job.id, () => controller.abort())
  const done = runToolCall(job.id, client, e, tool, args, controller)
  return { job, done }
}

async function runToolCall(jobId: string, client: Client, e: Entry, tool: string, args: Record<string, unknown>, controller: AbortController): Promise<Job> {
  try {
    const result = await client.callTool({ name: tool, arguments: args }, undefined, {
      signal: controller.signal,
      // Video generations can take minutes; progress notifications keep it alive.
      timeout: 20 * 60_000,
      resetTimeoutOnProgress: true,
      onprogress: (p) => updateJob(jobId, { progress: p.total ? Math.min(0.99, p.progress / p.total) : -1, message: p.message }),
    })
    const prompt = typeof args.prompt === 'string' ? args.prompt : undefined
    const converted = convertResult(result, { integration: e.config.preset ?? e.config.id, tool, prompt, params: args })
    updateJob(jobId, { result: converted, assets: converted.media })
    if (converted.isError) failJob(jobId, converted.text.join('\n') || 'The tool reported an error.')
    else finishJob(jobId, { message: summary(converted) })
  } catch (err) {
    if (!isCancelled(jobId)) failJob(jobId, err)
  }
  return getJob(jobId)!
}

/** Calls a tool and waits for the result (used by Lumen's own agents). */
export async function callTool(serverId: string, tool: string, args: Record<string, unknown>) {
  return (await startToolCall(serverId, tool, args)).done
}

const AGENT_IMAGE = /^image\/(png|jpeg|webp|gif)$/

/**
 * Calls a tool for an AI agent (Copilot, Claude Code, Codex): the answer goes back to the
 * model as-is — text, pictures it can look at, links — with nothing saved or imported.
 */
export async function callToolForAgent(serverId: string, tool: string, args: Record<string, unknown>): Promise<McpAgentResult> {
  const e = entry(serverId)
  if (!e.client) await connectServer(serverId)
  if (!e.client) throw new Error(e.error ?? `${e.config.name} isn’t connected.`)
  const result = (await e.client.callTool({ name: tool, arguments: args }, undefined, { timeout: 20 * 60_000, resetTimeoutOnProgress: true })) as Record<string, unknown>
  const text: string[] = []
  const images: McpAgentResult['images'] = []
  const links: McpLink[] = []
  const content = Array.isArray(result.content) ? (result.content as Record<string, unknown>[]) : []
  for (const item of content) {
    if (item.type === 'text' && typeof item.text === 'string') text.push(item.text)
    else if (item.type === 'image' && typeof item.data === 'string' && typeof item.mimeType === 'string' && AGENT_IMAGE.test(item.mimeType)) {
      // a model looks at a few pictures per answer; huge ones would only cost tokens
      if (images.length < 6 && item.data.length < 8_000_000) images.push({ data: item.data, mimeType: item.mimeType })
    } else if (item.type === 'resource_link' && typeof item.uri === 'string') {
      links.push({ url: item.uri, mime: typeof item.mimeType === 'string' ? item.mimeType : undefined, name: typeof item.name === 'string' ? item.name : undefined })
    } else if (item.type === 'resource' && item.resource && typeof item.resource === 'object') {
      const r = item.resource as { uri?: string; text?: string; mimeType?: string }
      if (typeof r.text === 'string') text.push(r.text)
      if (typeof r.uri === 'string') links.push({ url: r.uri, mime: r.mimeType })
    }
  }
  if (!content.length && result.toolResult !== undefined) text.push(typeof result.toolResult === 'string' ? result.toolResult : JSON.stringify(result.toolResult))
  return { isError: result.isError === true, text, images, links, structured: result.structuredContent }
}

function summary(r: ReturnType<typeof convertResult>) {
  const parts = []
  if (r.media.length) parts.push(`${r.media.length} file${r.media.length > 1 ? 's' : ''}`)
  if (r.links.length) parts.push(`${r.links.length} link${r.links.length > 1 ? 's' : ''}`)
  return parts.join(' · ') || 'Done'
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))
