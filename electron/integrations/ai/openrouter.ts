import { createHash, randomBytes } from 'node:crypto'
import http from 'node:http'
import { shell } from 'electron'
import type { ProviderState } from '../../../shared/ai'
import { setProvider } from './providers'

/**
 * "Sign in with OpenRouter": OAuth PKCE with a loopback callback (OpenRouter
 * accepts localhost on any port). The user approves in their browser and
 * OpenRouter hands back a key they control — billed to their account.
 */

const PAGE = (title: string, body: string) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>html{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#080807;color:#eeeee9;font:15px/1.5 system-ui,sans-serif}
main{text-align:center;max-width:360px}h1{font-size:20px;margin:0 0 8px;background:linear-gradient(90deg,#d6ee00,#5ef2a6,#36d6f2);-webkit-background-clip:text;color:transparent}p{color:#a2a39b;margin:0}</style>
<main><h1>${title}</h1><p>${body}</p></main>`

let inFlight: Promise<ProviderState> | null = null

export function signInOpenRouter(): Promise<ProviderState> {
  inFlight ??= run().finally(() => {
    inFlight = null
  })
  return inFlight
}

async function run(): Promise<ProviderState> {
  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const nonce = randomBytes(12).toString('hex')

  const server = http.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const { port } = server.address() as { port: number }
  const callback = `http://localhost:${port}/openrouter/${nonce}`

  const code = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Sign-in timed out.')), 5 * 60_000)
    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', callback)
      if (url.pathname !== `/openrouter/${nonce}`) return void res.writeHead(404).end()
      const got = url.searchParams.get('code')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(got ? PAGE('Connected to Lumen', 'OpenRouter is set up. You can close this tab.') : PAGE('Sign-in didn’t finish', 'No authorization code came back. Try again from Lumen.'))
      clearTimeout(timer)
      if (got) resolve(got)
      else reject(new Error('OpenRouter didn’t return an authorization code.'))
    })
  })

  try {
    const auth = new URL('https://openrouter.ai/auth')
    auth.searchParams.set('callback_url', callback)
    auth.searchParams.set('code_challenge', challenge)
    auth.searchParams.set('code_challenge_method', 'S256')
    auth.searchParams.set('key_label', 'Lumen')
    await shell.openExternal(auth.href)

    const res = await fetch('https://openrouter.ai/api/v1/auth/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: await code, code_verifier: verifier, code_challenge_method: 'S256' }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) throw new Error(`OpenRouter refused the sign-in (${res.status}).`)
    const { key } = (await res.json()) as { key?: string }
    if (!key) throw new Error('OpenRouter didn’t return a key.')
    return setProvider('openrouter', { key, via: 'oauth' })
  } finally {
    server.close()
  }
}
