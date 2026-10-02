import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import { app, BrowserWindow } from 'electron'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { IPC, type BridgeLogEntry, type BridgeState, type BridgeToolResult } from '../../shared/integrations'
import { askEditor, editorInstructions, editorTools, editorWindow, initEditorRpc } from './editor-rpc'
import { readJson, writeJson } from './paths'

/**
 * Lumen as an MCP server, so external agents (Claude Code, Claude Desktop,
 * any MCP client) can drive the editor. It listens on 127.0.0.1 only, needs
 * a bearer token, refuses browser origins, and forwards every request to the
 * editor window — which owns the tool definitions and runs them through the
 * same undoable command system as the UI.
 */

const SETTINGS = 'lumen-mcp.json'
const DEFAULT_PORT = 47910

interface Settings {
  enabled?: boolean
  port?: number
  token?: string
}

const INSTRUCTIONS = `Lumen is a desktop video editor. You are editing the user's open project.
- Time on the timeline is in integer frames at the project's fps; call get_project first to see fps, tracks, clips and media. Helper tools (add_title, get_frame, get_transcript…) take seconds.
- You can see and hear the project: get_contact_sheet (the whole edit in one image), get_frame (one exact frame, as the export renders it), get_media_frames (inside a media file), get_transcript, analyze_audio (loudness, peaks, silences) and get_editor_screenshot (the editor UI). Look before visual edits and verify after.
- list_catalog lists the valid ids for effects, transitions, looks and presets. batch_edit applies several commands as one all-or-nothing undo step.
- Edits are regular undoable actions, visible in the user's History.
- Blender and HyperFrames renders take a while: they return a job id; the finished clip lands in the project's media automatically. Use get_job to wait, then place_asset to put it on the timeline.
- Scripts that run code in Blender need the user's approval in Lumen.
- Lumen has skills — know-how for doing particular work well (motion design, Blender, grading, sound, short-form edits…). When a task matches one, call use_skill first and follow it; list_skills shows them, and tools name the skills that apply to them.`

let server: http.Server | null = null
/** Started for the Copilot's local agents only — not the user's "on" switch. */
let sessionOnly = false
let lastError: string | undefined
const log: BridgeLogEntry[] = []

function settings(): Settings & { token: string } {
  const s = readJson<Settings>(SETTINGS, {})
  if (!s.token) {
    s.token = randomBytes(24).toString('base64url')
    writeJson(SETTINGS, s)
  }
  return s as Settings & { token: string }
}

export function bridgeState(): BridgeState {
  const s = settings()
  const port = s.port ?? DEFAULT_PORT
  return {
    status: server && !sessionOnly ? { running: true, port, url: `http://127.0.0.1:${port}/mcp`, token: s.token } : { running: false, port, error: lastError },
    log: log.slice(0, 30),
  }
}

function emit() {
  editorWindow()?.webContents.send(IPC.bridgeEvent, bridgeState())
}

function buildServer(skills = '') {
  const mcp = new Server({ name: 'lumen', title: 'Lumen video editor', version: app.getVersion() }, { capabilities: { tools: {} }, instructions: skills ? `${INSTRUCTIONS}\n\n${skills}` : INSTRUCTIONS })
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await editorTools() }))
  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = req.params.name
    // Renders can take minutes; the editor enforces each tool's own wait limit.
    const res = await askEditor({ method: 'call', tool, args: req.params.arguments ?? {} }, 20 * 60_000)
    const result: BridgeToolResult = res.ok ? (res.result as BridgeToolResult) : { content: [{ type: 'text', text: res.error ?? 'Failed' }], isError: true }
    const first = result.content.find((c) => c.type === 'text')
    log.unshift({ id: randomUUID(), tool, at: Date.now(), ok: !result.isError, detail: first && 'text' in first ? first.text.slice(0, 120) : undefined })
    log.splice(60)
    emit()
    return result as CallToolResult
  })
  return mcp
}

// ─── HTTP ────────────────────────────────────────────────────────────────

function authorized(header: string | undefined, token: string) {
  const given = Buffer.from(header?.replace(/^Bearer\s+/i, '') ?? '')
  const want = Buffer.from(token)
  return given.length === want.length && timingSafeEqual(given, want)
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > 8 * 1024 * 1024) {
        reject(new Error('Request too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

async function onRequest(req: http.IncomingMessage, res: http.ServerResponse, port: number) {
  const s = settings()
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
  const json = (status: number, body: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
  if (url.pathname !== '/mcp') return json(404, { error: 'Not found' })
  // Local clients only — never a web page (blocks DNS rebinding and cross-site requests).
  if (req.headers.origin || !['127.0.0.1', 'localhost'].includes((req.headers.host ?? '').replace(/:\d+$/, ''))) return json(403, { error: 'Forbidden' })
  if (!authorized(req.headers.authorization, s.token)) return json(401, { error: 'Missing or invalid token — copy it from Lumen › Integrations › Lumen MCP server.' })
  if (req.method !== 'POST') return res.writeHead(405, { Allow: 'POST' }).end()

  let body: unknown
  try {
    body = await readBody(req)
  } catch {
    return json(400, { error: 'Invalid JSON' })
  }
  // A client connecting gets the skills that are on now in the server's instructions.
  const messages = Array.isArray(body) ? body : [body]
  const connecting = messages.some((m) => (m as { method?: unknown } | null)?.method === 'initialize')
  const skills = connecting ? await editorInstructions().catch(() => '') : ''
  const mcp = buildServer(skills)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  res.on('close', () => {
    void transport.close()
    void mcp.close()
  })
  await mcp.connect(transport)
  await transport.handleRequest(req, res, body)
}

export async function startBridge(): Promise<BridgeState> {
  if (server) {
    if (sessionOnly) {
      sessionOnly = false
      writeJson(SETTINGS, { ...settings(), enabled: true })
      emit()
    }
    return bridgeState()
  }
  const s = settings()
  const port = s.port ?? DEFAULT_PORT
  const srv = http.createServer((req, res) => {
    onRequest(req, res, port).catch((err) => {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: String(err) }))
    })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      srv.once('error', reject)
      srv.listen(port, '127.0.0.1', () => resolve())
    })
  } catch (err) {
    lastError = (err as NodeJS.ErrnoException).code === 'EADDRINUSE' ? `Port ${port} is already in use.` : String(err)
    emit()
    return bridgeState()
  }
  server = srv
  lastError = undefined
  sessionOnly = false
  writeJson(SETTINGS, { ...s, enabled: true })
  emit()
  return bridgeState()
}

/**
 * The endpoint the Copilot's local agents (Claude Code, Codex) connect to.
 * Starts the server for this session if the user hasn't switched it on.
 */
export async function bridgeEndpoint(): Promise<{ url: string; token: string }> {
  const s = settings()
  const port = s.port ?? DEFAULT_PORT
  if (!server) {
    const wasEnabled = Boolean(s.enabled)
    await startBridge()
    if (!server) throw new Error(lastError ?? 'Couldn’t start Lumen’s MCP server.')
    // Don't flip the user's switch just because a local agent needed the endpoint.
    if (!wasEnabled) {
      sessionOnly = true
      writeJson(SETTINGS, { ...settings(), enabled: false })
      emit()
    }
  }
  return { url: `http://127.0.0.1:${port}/mcp`, token: settings().token }
}

export async function stopBridge(persist = true): Promise<BridgeState> {
  const srv = server
  server = null
  sessionOnly = false
  if (srv) await new Promise<void>((resolve) => srv.close(() => resolve()))
  if (persist) writeJson(SETTINGS, { ...settings(), enabled: false })
  emit()
  return bridgeState()
}

export async function regenerateToken(): Promise<BridgeState> {
  writeJson(SETTINGS, { ...settings(), token: randomBytes(24).toString('base64url') })
  emit()
  return bridgeState()
}

/** Wires the bridge to the editor window; restarts it if it was on last time. */
export function initBridge(win: BrowserWindow, isTrustedUrl: (url: string) => boolean) {
  initEditorRpc(win, isTrustedUrl)
  if (settings().enabled) void startBridge()
}
