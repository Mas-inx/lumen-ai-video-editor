import { execFile, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { COPILOT_INSTRUCTIONS, type AgentEvent, type AgentRunRequest, type LocalAgentId, type LocalAgentState } from '../../../shared/ai'
import { ensureDir, userDir } from '../paths'
import { bridgeEndpoint } from '../server'

/**
 * The user's own Claude Code and Codex installs as Copilot brains.
 *
 * Lumen launches the unmodified CLI in its headless mode, signed in with the
 * user's own account through the CLI's own login flow, and wires Lumen's MCP
 * server into that run so the agent edits through the same tools as anyone
 * else. Lumen never reads, stores or relays the agents' credentials; usage is
 * billed to the user's own plan by the tool itself.
 */

type Emit = (e: AgentEvent) => void

const isWin = process.platform === 'win32'
const home = os.homedir()

// ─── Finding the binaries ────────────────────────────────────────────────

function exists(p: string) {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

function onPath(names: string[]) {
  const out: string[] = []
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) if (dir) for (const n of names) out.push(path.join(dir, n))
  return out
}

/** Versioned install folders (newest first), e.g. Claude desktop's bundled claude-code/<version>/. */
function versioned(root: string, file: string) {
  try {
    return fs
      .readdirSync(root)
      .map((d) => path.join(root, d, file))
      .filter(exists)
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  } catch {
    return []
  }
}

function candidates(id: LocalAgentId): string[] {
  const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming')
  const localAppData = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local')
  if (id === 'claude-code') {
    return isWin
      ? [...onPath(['claude.exe', 'claude.cmd']), path.join(home, '.local', 'bin', 'claude.exe'), path.join(appData, 'npm', 'claude.cmd'), ...versioned(path.join(appData, 'Claude', 'claude-code'), 'claude.exe')]
      : [
          ...onPath(['claude']),
          path.join(home, '.local', 'bin', 'claude'),
          '/opt/homebrew/bin/claude',
          '/usr/local/bin/claude',
          ...versioned(path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code'), 'claude'),
        ]
  }
  return isWin
    ? [...onPath(['codex.exe', 'codex.cmd']), path.join(appData, 'npm', 'codex.cmd'), ...versioned(path.join(localAppData, 'OpenAI', 'Codex', 'bin'), 'codex.exe')]
    : [...onPath(['codex']), '/opt/homebrew/bin/codex', '/usr/local/bin/codex', path.join(home, '.local', 'bin', 'codex')]
}

/**
 * npm installs a .cmd shim on Windows, which can't be spawned without a shell.
 * Run the package's JS entry with Electron-as-Node instead (no shell quoting).
 */
function launcher(bin: string, args: string[]): { command: string; args: string[]; env?: Record<string, string> } {
  if (isWin && bin.toLowerCase().endsWith('.cmd')) {
    const src = fs.readFileSync(bin, 'utf8')
    const rel = src.match(/%~?dp0%?\\?([^"\s]+\.(?:c?js|mjs))/i)?.[1]
    if (rel) return { command: process.execPath, args: [path.join(path.dirname(bin), rel), ...args], env: { ELECTRON_RUN_AS_NODE: '1' } }
  }
  return { command: bin, args }
}

function run(bin: string, args: string[], timeoutMs = 20_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const l = launcher(bin, args)
  return new Promise((resolve) => {
    execFile(l.command, l.args, { timeout: timeoutMs, windowsHide: true, env: { ...process.env, ...l.env } }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

const found = new Map<LocalAgentId, string | null>()

async function locate(id: LocalAgentId, refresh: boolean) {
  if (!refresh && found.has(id)) return found.get(id) ?? null
  for (const bin of [...new Set(candidates(id))]) {
    if (!exists(bin)) continue
    const { stdout } = await run(bin, ['--version'])
    if (/\d+\.\d+/.test(stdout)) {
      found.set(id, bin)
      return bin
    }
  }
  found.set(id, null)
  return null
}

// ─── State ───────────────────────────────────────────────────────────────

async function stateOf(id: LocalAgentId, refresh = false): Promise<LocalAgentState> {
  const bin = await locate(id, refresh)
  if (!bin) return { id, found: false, signedIn: false }
  const version = (await run(bin, ['--version'])).stdout.match(/\d+\.\d+\.\d+[\w.-]*/)?.[0]
  if (id === 'claude-code') {
    const { stdout } = await run(bin, ['auth', 'status', '--json'])
    try {
      const s = JSON.parse(stdout) as { loggedIn?: boolean; authMethod?: string; subscriptionType?: string }
      const account = s.authMethod === 'claude.ai' || s.subscriptionType ? 'Claude subscription' : s.authMethod && s.authMethod !== 'none' ? 'Anthropic API' : undefined
      return { id, found: true, path: bin, version, signedIn: Boolean(s.loggedIn), account }
    } catch {
      return { id, found: true, path: bin, version, signedIn: false, error: 'Couldn’t read Claude Code’s sign-in status.' }
    }
  }
  // Only the method is kept — the rest of the line can include a masked key.
  const { stdout, stderr } = await run(bin, ['login', 'status'])
  const text = `${stdout}\n${stderr}`
  const signedIn = /logged in/i.test(text) && !/not logged in/i.test(text)
  const account = /chatgpt/i.test(text) ? 'ChatGPT' : /api key/i.test(text) ? 'OpenAI API key' : undefined
  return { id, found: true, path: bin, version, signedIn, account }
}

export async function localAgentStates(refresh = false): Promise<LocalAgentState[]> {
  return Promise.all((['claude-code', 'codex'] as const).map((id) => stateOf(id, refresh)))
}

/**
 * Opens the agent's own sign-in in a terminal window (the flow completes in
 * the browser with Anthropic / OpenAI), then waits until it reports signed in.
 */
export async function signInLocal(id: LocalAgentId): Promise<LocalAgentState> {
  const bin = await locate(id, true)
  if (!bin) throw new Error(`${id === 'claude-code' ? 'Claude Code' : 'Codex'} isn’t installed.`)
  const args = id === 'claude-code' ? ['auth', 'login'] : ['login']
  const l = launcher(bin, args)
  if (isWin) {
    const quoted = [l.command, ...l.args].map((a) => `"${a}"`).join(' ')
    spawn('cmd.exe', ['/d', '/s', '/c', `start "Sign in" ${quoted}`], { detached: true, windowsVerbatimArguments: true, stdio: 'ignore', env: { ...process.env, ...l.env } }).unref()
  } else if (process.platform === 'darwin') {
    const cmd = [l.command, ...l.args].map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ')
    spawn('osascript', ['-e', `tell application "Terminal" to do script "${cmd.replace(/"/g, '\\"')}"`, '-e', 'tell application "Terminal" to activate'], { detached: true, stdio: 'ignore' }).unref()
  } else {
    spawn('x-terminal-emulator', ['-e', l.command, ...l.args], { detached: true, stdio: 'ignore' }).on('error', () => {
      spawn(l.command, l.args, { detached: true, stdio: 'ignore' }).unref()
    })
  }
  const deadline = Date.now() + 5 * 60_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2500))
    const s = await stateOf(id)
    if (s.signedIn) return s
  }
  return stateOf(id)
}

// ─── Runs ────────────────────────────────────────────────────────────────

const sessions = new Map<string, string>()
const children = new Map<string, ChildProcess>()
const stopped = new Set<string>()

export const forgetLocalSession = (conversationId: string) => {
  for (const key of [...sessions.keys()]) if (key.endsWith(`:${conversationId}`)) sessions.delete(key)
}

export function stopLocal(runId: string) {
  const child = children.get(runId)
  if (!child?.pid) return false
  stopped.add(runId)
  // Take the whole tree down (agents spawn helpers).
  if (isWin) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  else child.kill('SIGTERM')
  return true
}

const agentDir = () => ensureDir(path.join(userDir(), 'agents'))

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return content
      .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : ''))
      .filter(Boolean)
      .join('\n')
  return ''
}

const brief = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 160)
const NOT_SIGNED_IN = /not logged in|please run \/login|invalid api key|oauth token|authentication|unauthori[sz]ed|\blogin\b/i

export async function runLocal(req: AgentRunRequest, emit: Emit): Promise<void> {
  if (req.target.kind !== 'local') return
  const id = req.target.agent
  const state = await stateOf(id)
  if (!state.found || !state.path) return emit({ runId: req.runId, type: 'error', code: 'not-installed', message: `${id === 'claude-code' ? 'Claude Code' : 'Codex'} isn’t installed on this computer.` })
  if (!state.signedIn) return emit({ runId: req.runId, type: 'error', code: 'not-signed-in', message: `Sign in to ${id === 'claude-code' ? 'Claude Code' : 'Codex'} first — it uses your own account.` })
  const { url, token } = await bridgeEndpoint()
  const prompt = req.context ? `${req.context}\n\n${req.prompt}` : req.prompt
  if (id === 'claude-code') await runClaude(req, state.path, url, token, prompt, emit)
  else await runCodex(req, state.path, url, token, prompt, emit)
}

function start(req: AgentRunRequest, bin: string, args: string[], env: Record<string, string>, cwd: string) {
  const l = launcher(bin, args)
  const child = spawn(l.command, l.args, { cwd, windowsHide: true, env: { ...process.env, ...env, ...l.env }, stdio: ['pipe', 'pipe', 'pipe'] })
  children.set(req.runId, child)
  const stderr: string[] = []
  readline.createInterface({ input: child.stderr! }).on('line', (line) => {
    stderr.push(line)
    if (stderr.length > 40) stderr.shift()
  })
  const exited = new Promise<number | null>((resolve) => {
    child.on('error', () => resolve(-1))
    child.on('close', (code) => resolve(code))
  })
  return { child, stderr, exited }
}

// Claude Code: `claude -p --output-format stream-json`, only Lumen's tools.
async function runClaude(req: AgentRunRequest, bin: string, url: string, token: string, prompt: string, emit: Emit) {
  const dir = agentDir()
  const config = path.join(dir, 'claude-mcp.json')
  fs.writeFileSync(config, JSON.stringify({ mcpServers: { lumen: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }), { mode: 0o600 })
  const instructions = path.join(dir, 'copilot-instructions.md')
  fs.writeFileSync(instructions, `${COPILOT_INSTRUCTIONS}\n- The Lumen tools are the MCP server named "lumen".`)
  const key = `claude-code:${req.conversationId}`
  const session = sessions.get(key)
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--mcp-config',
    config,
    '--strict-mcp-config',
    // No shell, file or web tools: in Lumen, Claude Code only edits the project.
    '--tools',
    '',
    '--allowedTools',
    'mcp__lumen',
    '--permission-mode',
    'dontAsk',
    '--append-system-prompt-file',
    instructions,
    ...(req.target.kind === 'local' && req.target.model ? ['--model', req.target.model] : []),
    ...(session ? ['--resume', session] : []),
  ]
  const { child, stderr, exited } = start(req, bin, args, {}, ensureDir(path.join(dir, 'workspace')))
  child.stdin!.end(prompt)
  emit({ runId: req.runId, type: 'status', message: 'Claude Code is working…' })

  let finished = false
  let streamedText = false
  let afterTool = false
  const text = (delta: string) => {
    if (!delta) return
    emit({ runId: req.runId, type: 'text', delta: afterTool && streamedText ? `\n\n${delta}` : delta })
    streamedText = true
    afterTool = false
  }

  for await (const line of readline.createInterface({ input: child.stdout! })) {
    let msg: Record<string, any>
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    if (msg.session_id) sessions.set(key, msg.session_id)
    if (msg.type === 'system' && msg.subtype === 'init') {
      const lumen = (msg.mcp_servers as { name: string; status: string }[] | undefined)?.find((s) => s.name === 'lumen')
      if (lumen && lumen.status !== 'connected') emit({ runId: req.runId, type: 'status', message: `Lumen tools: ${lumen.status}` })
    } else if (msg.type === 'stream_event') {
      const ev = msg.event
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') text(ev.delta.text)
    } else if (msg.type === 'assistant') {
      for (const block of msg.message?.content ?? []) {
        if (block.type === 'tool_use') {
          afterTool = true
          emit({ runId: req.runId, type: 'tool-start', callId: block.id, tool: String(block.name).replace(/^mcp__lumen__/, ''), input: block.input })
        } else if (block.type === 'text' && !streamedText) text(block.text)
      }
    } else if (msg.type === 'user') {
      for (const block of msg.message?.content ?? []) {
        if (block.type === 'tool_result') emit({ runId: req.runId, type: 'tool-end', callId: block.tool_use_id, tool: '', ok: !block.is_error, summary: brief(textOf(block.content)) })
      }
    } else if (msg.type === 'result') {
      finished = true
      const result = String(msg.result ?? '')
      if (msg.is_error || msg.subtype !== 'success') {
        emit({ runId: req.runId, type: 'error', code: NOT_SIGNED_IN.test(result) ? 'not-signed-in' : 'failed', message: result || `Claude Code stopped (${msg.subtype}).` })
      } else {
        if (!streamedText && result) text(result)
        emit({ runId: req.runId, type: 'done', usage: { inputTokens: msg.usage?.input_tokens, outputTokens: msg.usage?.output_tokens, costUsd: msg.total_cost_usd } })
      }
    }
  }
  const code = await exited
  children.delete(req.runId)
  const cancelled = stopped.delete(req.runId)
  if (!finished) {
    const tail = stderr.slice(-4).join('\n')
    emit({ runId: req.runId, type: 'error', code: cancelled ? 'cancelled' : NOT_SIGNED_IN.test(tail) ? 'not-signed-in' : 'failed', message: cancelled ? 'Stopped.' : tail || `Claude Code exited with code ${code}.` })
  }
}

// Codex: `codex exec --json`, read-only sandbox, Lumen wired in as an MCP server.
async function runCodex(req: AgentRunRequest, bin: string, url: string, token: string, prompt: string, emit: Emit) {
  const key = `codex:${req.conversationId}`
  const thread = sessions.get(key)
  const workspace = ensureDir(path.join(agentDir(), 'workspace'))
  // exec runs with approval_policy "never": Lumen's own tools are pre-approved (code-running ones
  // still ask the user inside Lumen); anything else Codex wants still needs approval, so it's refused.
  const mcp = [
    '-c',
    `mcp_servers.lumen.url="${url}"`,
    '-c',
    'mcp_servers.lumen.bearer_token_env_var="LUMEN_MCP_TOKEN"',
    '-c',
    'mcp_servers.lumen.default_tools_approval_mode="approve"',
  ]
  const model = req.target.kind === 'local' && req.target.model ? ['-m', req.target.model] : []
  const args = thread
    ? ['exec', 'resume', thread, '--json', '--skip-git-repo-check', ...mcp, ...model, '-']
    : ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '-C', workspace, ...mcp, ...model, '-']
  const { child, stderr, exited } = start(req, bin, args, { LUMEN_MCP_TOKEN: token }, workspace)
  // Codex has no system-prompt flag in exec mode: brief it at the start of a thread.
  child.stdin!.end(thread ? prompt : `${COPILOT_INSTRUCTIONS}\n- The Lumen tools are the MCP server named "lumen".\n\n${prompt}`)
  emit({ runId: req.runId, type: 'status', message: 'Codex is working…' })

  let finished = false
  let wroteText = false
  let afterTool = false
  for await (const line of readline.createInterface({ input: child.stdout! })) {
    let ev: Record<string, any>
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    if (ev.type === 'thread.started' && ev.thread_id) sessions.set(key, ev.thread_id)
    else if (ev.type === 'item.started' || ev.type === 'item.completed') {
      const item = ev.item ?? {}
      const done = ev.type === 'item.completed'
      if (item.type === 'agent_message' && done && item.text) {
        emit({ runId: req.runId, type: 'text', delta: wroteText || afterTool ? `\n\n${item.text}` : item.text })
        wroteText = true
        afterTool = false
      } else if (item.type === 'mcp_tool_call') {
        afterTool = true
        if (!done) emit({ runId: req.runId, type: 'tool-start', callId: item.id, tool: String(item.tool ?? 'tool'), input: item.arguments })
        else {
          const errorText = item.error?.message ?? (typeof item.error === 'string' ? item.error : '')
          emit({ runId: req.runId, type: 'tool-end', callId: item.id, tool: String(item.tool ?? ''), ok: item.status !== 'failed' && !errorText, summary: brief(errorText || textOf(item.result?.content)) })
        }
      } else if (item.type === 'command_execution') {
        afterTool = true
        if (!done) emit({ runId: req.runId, type: 'tool-start', callId: item.id, tool: 'shell', input: { command: item.command } })
        else emit({ runId: req.runId, type: 'tool-end', callId: item.id, tool: 'shell', ok: item.exit_code === 0, summary: brief(String(item.command ?? '')) })
      } else if (item.type === 'error' && item.message) {
        emit({ runId: req.runId, type: 'status', message: String(item.message) })
      }
    } else if (ev.type === 'turn.completed') {
      finished = true
      emit({ runId: req.runId, type: 'done', usage: { inputTokens: ev.usage?.input_tokens, outputTokens: ev.usage?.output_tokens } })
    } else if (ev.type === 'turn.failed' || ev.type === 'error') {
      finished = true
      const message = String(ev.error?.message ?? ev.message ?? 'Codex failed.')
      emit({ runId: req.runId, type: 'error', code: NOT_SIGNED_IN.test(message) ? 'not-signed-in' : /rate limit|usage limit/i.test(message) ? 'rate-limit' : 'failed', message })
    }
  }
  const code = await exited
  children.delete(req.runId)
  const cancelled = stopped.delete(req.runId)
  if (!finished) {
    const tail = stderr.slice(-4).join('\n')
    emit({ runId: req.runId, type: 'error', code: cancelled ? 'cancelled' : NOT_SIGNED_IN.test(tail) ? 'not-signed-in' : 'failed', message: cancelled ? 'Stopped.' : tail || `Codex exited with code ${code}.` })
  }
}
