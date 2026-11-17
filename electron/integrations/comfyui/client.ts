import fs from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ComfyFileRef } from '../../../shared/comfyui'
import { promptError, type ApiPrompt, type HistoryEntry, type NodeDef } from './workflow'

/**
 * One ComfyUI server, over its HTTP API and its websocket — at the address the
 * user set and nowhere else: redirects aren't followed, and every request
 * carries the user's auth header when there is one.
 */

export class ComfyError extends Error {}

export interface SystemStats {
  system?: { comfyui_version?: string; python_version?: string; pytorch_version?: string }
  devices?: { name?: string; type?: string; vram_total?: number; vram_free?: number }[]
}

/** [number, prompt id, prompt, extra data, outputs to execute] */
type QueueItem = [number, string, ...unknown[]]

export interface QueueState {
  queue_running?: QueueItem[]
  queue_pending?: QueueItem[]
}

export interface ComfyMessage {
  type: string
  data: Record<string, unknown>
}

export interface ComfySocket {
  close(): void
  isOpen(): boolean
}

type RequestOptions = RequestInit & { query?: Record<string, string>; timeoutMs?: number }

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

export class ComfyClient {
  constructor(
    readonly base: string,
    private readonly headers: Record<string, string> = {},
  ) {}

  private url(pathname: string, query?: Record<string, string>) {
    const url = new URL(this.base + pathname)
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v)
    return url
  }

  async request(pathname: string, { query, timeoutMs = 15_000, signal, headers, ...init }: RequestOptions = {}): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs)
    let res: Response
    try {
      res = await fetch(this.url(pathname, query), {
        ...init,
        headers: { ...this.headers, ...(headers as Record<string, string> | undefined) },
        redirect: 'manual',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
    } catch (err) {
      if (signal?.aborted) throw err
      throw this.unreachable(err, timeout.aborted)
    }
    if (res.status >= 300 && res.status < 400) {
      const to = res.headers.get('location')
      throw new ComfyError(`ComfyUI at ${this.base} answered with a redirect${to ? ` to ${to}` : ''}. Lumen only talks to the address you set — put the one it redirects to in Integrations › ComfyUI.`)
    }
    if (res.status === 401 || res.status === 403) {
      throw new ComfyError(`ComfyUI at ${this.base} refused Lumen (${res.status}). ${Object.keys(this.headers).length ? 'Check the auth header in Integrations › ComfyUI.' : 'If it’s behind a login, add its auth header in Integrations › ComfyUI.'}`)
    }
    return res
  }

  private unreachable(err: unknown, timedOut: boolean) {
    const cause = (err as { cause?: { code?: string; errors?: { code?: string }[] } } | null)?.cause
    const code = cause?.code ?? cause?.errors?.[0]?.code
    const host = new URL(this.base).hostname
    if (timedOut) return new ComfyError(`ComfyUI at ${this.base} didn’t answer in time.`)
    if (code === 'ECONNREFUSED')
      return new ComfyError(
        `Nothing is answering at ${this.base}. Start ComfyUI (it listens on port 8188 unless you changed it)${LOOPBACK.has(host) ? '' : ' with --listen, so other computers can reach it'}, or set its address in Integrations › ComfyUI.`,
      )
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new ComfyError(`Lumen can’t find ${host} on the network — check ComfyUI’s address in Integrations › ComfyUI.`)
    if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return new ComfyError(`Lumen can’t reach ${host} — is that computer on, and ComfyUI running?`)
    if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return new ComfyError(`ComfyUI at ${this.base} closed the connection.`)
    return new ComfyError(`Couldn’t reach ComfyUI at ${this.base}: ${err instanceof Error ? err.message : String(err)}`)
  }

  async json<T>(pathname: string, init?: RequestOptions): Promise<T> {
    const res = await this.request(pathname, init)
    const text = await res.text()
    if (!res.ok) throw new ComfyError(`ComfyUI answered ${res.status} to ${pathname}${text ? `: ${text.slice(0, 200)}` : '.'}`)
    try {
      return JSON.parse(text) as T
    } catch {
      throw new ComfyError(`Something answered at ${this.base}, but it isn’t ComfyUI.`)
    }
  }

  systemStats = () => this.json<SystemStats>('/system_stats', { timeoutMs: 5000 })

  queue = () => this.json<QueueState>('/queue', { timeoutMs: 5000 })

  /** A node type's definition: null when ComfyUI doesn't have it, undefined when it couldn't say. Connection problems throw. */
  async nodeDef(type: string): Promise<NodeDef | null | undefined> {
    const res = await this.request(`/object_info/${encodeURIComponent(type)}`, { timeoutMs: 15_000 })
    if (!res.ok) return undefined
    try {
      const body = (await res.json()) as Record<string, NodeDef> | null
      return body && typeof body === 'object' ? (body[type] ?? null) : undefined
    } catch {
      return undefined
    }
  }

  /** Queues a workflow. Outputs that didn't validate are left out of a run that still goes ahead: they come back as warnings. */
  async submit(prompt: ApiPrompt, clientId: string): Promise<{ id: string; warnings: string[] }> {
    const res = await this.request('/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, client_id: clientId }), timeoutMs: 60_000 })
    const text = await res.text()
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      body = undefined
    }
    if (!res.ok) throw new ComfyError(body ? promptError(body) : `ComfyUI answered ${res.status}: ${text.slice(0, 300)}`)
    const answer = (body ?? {}) as { prompt_id?: unknown; node_errors?: unknown }
    if (typeof answer.prompt_id !== 'string') throw new ComfyError('ComfyUI took the workflow but didn’t say which run it is.')
    const skipped = answer.node_errors && typeof answer.node_errors === 'object' && Object.keys(answer.node_errors).length ? promptError({ error: { message: 'some outputs didn’t validate and won’t run' }, node_errors: answer.node_errors }) : ''
    return { id: answer.prompt_id, warnings: skipped ? [skipped.replace(/^ComfyUI won’t run this workflow: /, 'ComfyUI is running the workflow, but ')] : [] }
  }

  async history(promptId: string): Promise<HistoryEntry | undefined> {
    const body = await this.json<Record<string, HistoryEntry> | null>(`/history/${encodeURIComponent(promptId)}`)
    return body?.[promptId]
  }

  /** Stops a run that is executing (ComfyUI only interrupts it if it is still the one running). */
  interrupt = (promptId: string) => this.request('/interrupt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt_id: promptId }), timeoutMs: 5000 })

  /** Takes a run that hasn't started out of the queue. */
  dequeue = (promptId: string) => this.request('/queue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delete: [promptId] }), timeoutMs: 5000 })

  /** Puts a file in ComfyUI's input folder (any file: loaders of video and audio upload through the same endpoint). */
  async upload(file: Blob, name: string, subfolder: string): Promise<ComfyFileRef> {
    const form = new FormData()
    form.set('image', file, name)
    form.set('overwrite', 'true')
    form.set('type', 'input')
    form.set('subfolder', subfolder)
    const res = await this.request('/upload/image', { method: 'POST', body: form, timeoutMs: 15 * 60_000 })
    if (res.status === 413) throw new ComfyError(`That file is larger than ComfyUI takes (100 MB unless it is started with --max-upload-size). Start ComfyUI with e.g. --max-upload-size 4096, or use a shorter clip.`)
    const text = await res.text()
    if (!res.ok) throw new ComfyError(`ComfyUI didn’t take the file (${res.status}${text ? `: ${text.slice(0, 200)}` : ''}).`)
    let body: { name?: unknown; subfolder?: unknown; type?: unknown }
    try {
      body = JSON.parse(text)
    } catch {
      throw new ComfyError(`Something answered at ${this.base}, but it isn’t ComfyUI.`)
    }
    if (typeof body.name !== 'string') throw new ComfyError('ComfyUI didn’t say what it called the file.')
    return { filename: body.name, subfolder: typeof body.subfolder === 'string' ? body.subfolder : subfolder, type: typeof body.type === 'string' ? body.type : 'input' }
  }

  /** Streams one of a run's files to disk; answers the type ComfyUI gave it. */
  async download(file: ComfyFileRef, dest: string, signal?: AbortSignal): Promise<string | undefined> {
    const res = await this.request('/view', { query: { filename: file.filename, subfolder: file.subfolder, type: file.type }, timeoutMs: 60 * 60_000, signal })
    if (!res.ok || !res.body) throw new ComfyError(`ComfyUI couldn’t hand over ${file.filename} (${res.status}).`)
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), fs.createWriteStream(dest), { signal })
    return res.headers.get('content-type')?.split(';')[0].trim().toLowerCase() || undefined
  }

  /** Opens the websocket that tells this client about its runs; null when it can't (runs are then followed by polling). */
  watch(clientId: string, onMessage: (m: ComfyMessage) => void, timeoutMs = 4000): Promise<ComfySocket | null> {
    const Socket = globalThis.WebSocket
    if (typeof Socket !== 'function') return Promise.resolve(null)
    const url = this.url('/ws', { clientId })
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    return new Promise((resolve) => {
      let ws: WebSocket
      try {
        ws = new Socket(url, { headers: this.headers })
      } catch {
        return resolve(null)
      }
      let settled = false
      const settle = (socket: ComfySocket | null) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (!socket) ws.close()
        resolve(socket)
      }
      const timer = setTimeout(() => settle(null), timeoutMs)
      ws.addEventListener('open', () => settle({ close: () => ws.close(), isOpen: () => ws.readyState === ws.OPEN }))
      ws.addEventListener('error', () => settle(null))
      ws.addEventListener('close', () => settle(null))
      ws.addEventListener('message', (e: MessageEvent) => {
        // Previews arrive as binary frames; only the JSON ones matter here.
        if (typeof e.data !== 'string') return
        try {
          const m = JSON.parse(e.data) as { type?: unknown; data?: unknown }
          if (typeof m.type === 'string') onMessage({ type: m.type, data: m.data && typeof m.data === 'object' ? (m.data as Record<string, unknown>) : {} })
        } catch {
          /* not JSON */
        }
      })
    })
  }
}
