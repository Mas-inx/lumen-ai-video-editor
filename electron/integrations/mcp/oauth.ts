import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { safeStorage, shell } from 'electron'
import type { OAuthClientProvider, OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { ensureDir, userDir } from '../paths'

/**
 * OAuth for hosted MCP servers (Higgsfield and friends): the sign-in page
 * opens in the user's browser and comes back to a loopback redirect
 * (RFC 8252). Tokens and client registrations are encrypted with the OS
 * keychain (safeStorage) and never reach the renderer.
 */

export const REDIRECT_PORT = 47913
const REDIRECT_PATH = '/oauth/callback'
const REDIRECT_URL = `http://127.0.0.1:${REDIRECT_PORT}${REDIRECT_PATH}`

interface Stored {
  client?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  verifier?: string
  discovery?: OAuthDiscoveryState
}

const file = (serverId: string) => path.join(ensureDir(path.join(userDir(), 'mcp-auth')), `${serverId.replace(/[^\w-]/g, '_')}.bin`)

function read(serverId: string): Stored {
  try {
    const buf = fs.readFileSync(file(serverId))
    const json = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8')
    return JSON.parse(json) as Stored
  } catch {
    return {}
  }
}

function write(serverId: string, patch: Partial<Stored>) {
  const next = { ...read(serverId), ...patch }
  const json = JSON.stringify(next)
  fs.writeFileSync(file(serverId), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : Buffer.from(json, 'utf8'))
}

export function clearAuth(serverId: string) {
  fs.rmSync(file(serverId), { force: true })
}

export const hasTokens = (serverId: string) => Boolean(read(serverId).tokens?.access_token)

// ─── Loopback redirect ───────────────────────────────────────────────────

const pending = new Map<string, { resolve: (code: string) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>()
let server: http.Server | null = null

const PAGE = (title: string, body: string) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>html{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#080807;color:#eeeee9;font:15px/1.5 system-ui,sans-serif}
main{text-align:center;max-width:360px}h1{font-size:20px;margin:0 0 8px;background:linear-gradient(90deg,#d6ee00,#5ef2a6,#36d6f2);-webkit-background-clip:text;color:transparent}p{color:#a2a39b;margin:0}</style>
<main><h1>${title}</h1><p>${body}</p></main>`

function ensureServer() {
  if (server) return
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', REDIRECT_URL)
    if (url.pathname !== REDIRECT_PATH) {
      res.writeHead(404).end()
      return
    }
    const state = url.searchParams.get('state') ?? ''
    const code = url.searchParams.get('code')
    const error = url.searchParams.get('error_description') ?? url.searchParams.get('error')
    const waiter = pending.get(state)
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    if (!waiter) {
      res.end(PAGE('Nothing to finish', 'This sign-in link has expired. Start again from Lumen.'))
      return
    }
    pending.delete(state)
    clearTimeout(waiter.timer)
    if (code) {
      res.end(PAGE('Connected to Lumen', 'You can close this tab and head back to your edit.'))
      waiter.resolve(code)
    } else {
      res.end(PAGE('Sign-in didn’t finish', error ?? 'The service didn’t return an authorization code.'))
      waiter.reject(new Error(error ?? 'Authorization was cancelled.'))
    }
    if (!pending.size) closeServer()
  })
  server.on('error', (err) => {
    for (const [state, w] of pending) {
      pending.delete(state)
      w.reject(err)
    }
    closeServer()
  })
  server.listen(REDIRECT_PORT, '127.0.0.1')
}

function closeServer() {
  server?.close()
  server = null
}

// ─── Provider ────────────────────────────────────────────────────────────

export class LumenOAuthProvider implements OAuthClientProvider {
  private currentState: string | null = null
  /** Resolves with the authorization code once the browser comes back. */
  authorizationCode: Promise<string> | null = null

  constructor(private readonly serverId: string) {}

  get redirectUrl() {
    return REDIRECT_URL
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Lumen',
      redirect_uris: [REDIRECT_URL],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }
  }

  state() {
    this.currentState = randomUUID()
    return this.currentState
  }

  clientInformation() {
    return read(this.serverId).client
  }

  saveClientInformation(client: OAuthClientInformationMixed) {
    write(this.serverId, { client })
  }

  tokens() {
    return read(this.serverId).tokens
  }

  saveTokens(tokens: OAuthTokens) {
    write(this.serverId, { tokens })
  }

  saveCodeVerifier(verifier: string) {
    write(this.serverId, { verifier })
  }

  codeVerifier() {
    const verifier = read(this.serverId).verifier
    if (!verifier) throw new Error('No sign-in in progress.')
    return verifier
  }

  saveDiscoveryState(discovery: OAuthDiscoveryState) {
    write(this.serverId, { discovery })
  }

  discoveryState() {
    return read(this.serverId).discovery
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    if (scope === 'all') return clearAuth(this.serverId)
    const key = ({ client: 'client', tokens: 'tokens', verifier: 'verifier', discovery: 'discovery' } as const)[scope]
    write(this.serverId, { [key]: undefined })
  }

  async redirectToAuthorization(url: URL) {
    const state = url.searchParams.get('state') ?? this.currentState ?? randomUUID()
    ensureServer()
    this.authorizationCode = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(state)
        reject(new Error('Sign-in timed out.'))
        if (!pending.size) closeServer()
      }, 5 * 60_000)
      pending.set(state, { resolve, reject, timer })
    })
    // Only ever hand real web URLs to the OS.
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
      throw new Error(`Refusing to open a non-HTTPS sign-in page (${url.protocol})`)
    }
    await shell.openExternal(url.href)
  }
}
