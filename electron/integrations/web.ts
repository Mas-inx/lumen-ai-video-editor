import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { nativeImage, net, session } from 'electron'
import { exactOffscreenWindow } from '../offscreen'
import type { WebPage, WebPreview, WebSearchResult, WebShot } from '../../shared/integrations'
import { isPrivateHost } from '../../shared/integrations'

/**
 * The web for the Copilot: search, reading pages, and screenshots of pages —
 * so it can look things up (a font, a reference, a how-to) and show you what
 * it found. Everything runs here in the main process: no CORS, no cookies
 * from the editor, and nothing on the local network is reachable.
 */

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const MAX_BYTES = 4 * 1024 * 1024

// ─── Where requests may go ───────────────────────────────────────────────

function blockedIp(ip: string): boolean {
  const v = ip.toLowerCase()
  if (isIP(v) === 4) {
    const [a, b] = v.split('.').map(Number)
    // this network, loopback, private ranges, link-local (cloud metadata), carrier-grade NAT, multicast and up
    return a === 0 || a === 127 || a === 10 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
  }
  if (isIP(v) === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v)
    if (mapped) return blockedIp(mapped[1])
    // unspecified, loopback, unique-local (fc00::/7), link-local (fe80::/10)
    return v === '::' || v === '::1' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v)
  }
  return false
}

/** Hosts on this computer or the local network (by name or address) are off limits. */
export function blockedHost(hostname: string) {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (isPrivateHost(h) || h === 'localhost' || h.endsWith('.internal') || h.endsWith('.lan') || h.endsWith('.home')) return true
  if (isIP(h)) return blockedIp(h)
  // A bare name like "router" is an intranet host.
  return !h.includes('.')
}

export async function checkUrl(raw: string): Promise<URL> {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new Error(`“${raw}” isn’t a web address.`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only http and https pages can be opened.')
  if (blockedHost(url.hostname)) throw new Error('Addresses on this computer or the local network are off limits.')
  // A public name that points somewhere private is refused too.
  if (!isIP(url.hostname.replace(/^\[|\]$/g, ''))) {
    const addrs = await lookup(url.hostname, { all: true }).catch(() => [])
    if (addrs.some((a) => blockedIp(a.address))) throw new Error('That address points into the local network — it’s off limits.')
  }
  return url
}

/**
 * Where a redirect leads. Electron's net.fetch, told not to follow one, fails
 * with "Redirect was cancelled" without saying where it pointed; a request with
 * a listener is told. Nothing is followed here either: the caller checks the
 * address, then asks for it as a request of its own.
 */
export function redirectTarget(url: URL, headers: Record<string, string>, timeoutMs = 20_000): Promise<string | null> {
  return new Promise((resolve) => {
    const request = net.request({ url: url.href, method: 'GET', redirect: 'manual', credentials: 'omit' })
    for (const [name, value] of Object.entries(headers)) request.setHeader(name, value)
    const timer = setTimeout(() => {
      request.abort()
      resolve(null)
    }, timeoutMs)
    const done = (to: string | null) => {
      clearTimeout(timer)
      resolve(to)
    }
    request.on('redirect', (_status, _method, to) => done(to))
    request.on('response', () => {
      request.abort()
      done(null)
    })
    request.on('error', () => done(null))
    request.end()
  })
}

export const isCancelledRedirect = (err: unknown) => err instanceof Error && /redirect was cancelled/i.test(err.message)

/** Fetches a page (following redirects, each one checked), capped in size and time. No cookies go out or get kept. */
async function get(raw: string, accept = 'text/html,application/xhtml+xml,*/*;q=0.8') {
  let url = await checkUrl(raw)
  const headers = { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'en-US,en;q=0.9' }
  for (let hop = 0; hop < 6; hop++) {
    let res: Response
    try {
      res = await net.fetch(url.href, { redirect: 'manual', credentials: 'omit', headers, signal: AbortSignal.timeout(20_000) })
    } catch (err) {
      const to = isCancelledRedirect(err) ? await redirectTarget(url, headers) : null
      if (!to) throw err
      url = await checkUrl(new URL(to, url).href)
      continue
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = await checkUrl(new URL(res.headers.get('location')!, url).href)
      continue
    }
    if (!res.ok) throw new Error(`The page answered ${res.status} ${res.statusText}`.trim())
    const reader = res.body?.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    while (reader) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BYTES) {
        await reader.cancel()
        break
      }
      chunks.push(value)
    }
    const bytes = Buffer.concat(chunks)
    return { url, type: (res.headers.get('content-type') ?? '').toLowerCase(), bytes }
  }
  throw new Error('Too many redirects.')
}

// ─── HTML → text ─────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©' }

export function decodeEntities(s: string) {
  return s.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

export const meta = (html: string, name: string) => {
  const re = new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*>`, 'i')
  const tag = re.exec(html)?.[0]
  const content = tag && /content=["']([^"']*)["']/i.exec(tag)?.[1]
  return content ? decodeEntities(content).trim() : undefined
}

/** A page's readable text: the article (or main) part when there is one, without scripts, menus and footers. */
export function readable(html: string): string {
  let body = html.replace(/<!--[\s\S]*?-->/g, '')
  const main = /<article[\s\S]*?<\/article>/i.exec(body)?.[0] ?? /<main[\s\S]*?<\/main>/i.exec(body)?.[0]
  if (main && main.length > 400) body = main
  body = body
    .replace(/<(script|style|noscript|svg|template|iframe|form|nav|footer|header|aside)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/(p|div|section|h[1-6]|li|tr|blockquote|pre|table|ul|ol)>/gi, '\n')
    .replace(/<h([1-6])[^>]*>/gi, (_m, n: string) => `\n${'#'.repeat(Number(n))} `)
    .replace(/<[^>]+>/g, ' ')
  return decodeEntities(body)
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    // Bullets left empty by removed menus.
    .replace(/^•\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function absolute(href: string, base: URL) {
  try {
    const u = new URL(decodeEntities(href), base)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
  } catch {
    return null
  }
}

// ─── Pictures ────────────────────────────────────────────────────────────

/** An image file as a JPEG at most `max` wide, for the model to look at. */
function toJpeg(bytes: Buffer, max = 1280) {
  const img = nativeImage.createFromBuffer(bytes)
  if (img.isEmpty()) return null
  const { width } = img.getSize()
  const scaled = width > max ? img.resize({ width: max, quality: 'good' }) : img
  return scaled.toJPEG(82).toString('base64')
}

async function picture(url: string) {
  try {
    const { type, bytes } = await get(url, 'image/avif,image/webp,image/png,image/jpeg,*/*;q=0.5')
    if (!type.startsWith('image/')) return null
    return toJpeg(bytes)
  } catch {
    return null
  }
}

// ─── Search ──────────────────────────────────────────────────────────────

/** DuckDuckGo wraps result links in a redirect: unwrap it. */
function resultUrl(href: string) {
  const h = decodeEntities(href)
  const wrapped = /[?&]uddg=([^&]+)/.exec(h)
  const url = wrapped ? decodeURIComponent(wrapped[1]) : h.startsWith('//') ? `https:${h}` : h
  return /^https?:\/\//.test(url) && !/duckduckgo\.com\/y\.js/.test(url) ? url : null
}

export const strip = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()

export function parseSearch(html: string, max: number): WebSearchResult[] {
  const out: WebSearchResult[] = []
  const blocks = html.split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/i).slice(1)
  for (const b of blocks) {
    const a = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(b) ?? /<a[^>]+href="([^"]+)"[^>]+class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(b)
    if (!a) continue
    const url = resultUrl(a[1])
    if (!url || out.some((r) => r.url === url)) continue
    const snippet = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/i.exec(b)?.[1]
    out.push({ title: strip(a[2]), url, snippet: snippet ? strip(snippet) : '' })
    if (out.length >= max) break
  }
  return out
}

export async function webSearch(query: string, max = 8): Promise<WebSearchResult[]> {
  const q = query.trim()
  if (!q) throw new Error('What should I search for?')
  const n = Math.min(20, Math.max(1, Math.round(max)))
  const res = await net.fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    credentials: 'omit',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html' },
    body: new URLSearchParams({ q, kl: 'us-en' }).toString(),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`Search failed (${res.status}).`)
  const results = parseSearch(await res.text(), n)
  if (!results.length) throw new Error('The search came back empty — try other words, or read a page you know directly.')
  return results
}

// ─── Reading a page ──────────────────────────────────────────────────────

export async function readPage(raw: string, maxChars = 12000): Promise<WebPage> {
  const { url, type, bytes } = await get(raw)
  const limit = Math.min(60000, Math.max(1000, Math.round(maxChars)))
  if (type.startsWith('image/')) {
    const image = toJpeg(bytes)
    return { url: url.href, title: url.pathname.split('/').pop() || url.hostname, text: 'An image.', links: [], images: [url.href], ...(image ? { image } : {}) }
  }
  const raw8 = bytes.toString('utf8')
  if (!type.includes('html')) return { url: url.href, title: url.href, text: raw8.slice(0, limit), truncated: raw8.length > limit, links: [], images: [] }
  const html = raw8
  const title = meta(html, 'og:title') ?? strip(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '') ?? url.hostname
  const description = meta(html, 'og:description') ?? meta(html, 'description')
  const site = meta(html, 'og:site_name')
  const lead = meta(html, 'og:image') ?? meta(html, 'twitter:image')
  const text = readable(html)
  const links: { text: string; url: string }[] = []
  for (const m of html.matchAll(/<a[^>]+href="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = absolute(m[1], url)
    const label = strip(m[2])
    if (href && label && label.length > 2 && !links.some((l) => l.url === href)) links.push({ text: label.slice(0, 80), url: href })
    if (links.length >= 40) break
  }
  const images = [lead, ...[...html.matchAll(/<img[^>]+src="([^"]+)"/gi)].map((m) => m[1])]
    .map((src) => (src ? absolute(src, url) : null))
    .filter((src, i, all): src is string => Boolean(src) && all.indexOf(src) === i && !/\.svg(\?|$)/i.test(src!))
    .slice(0, 12)
  const image = lead ? await picture(absolute(lead, url) ?? '') : null
  return {
    url: url.href,
    title: title || url.hostname,
    ...(description ? { description } : {}),
    ...(site ? { site } : {}),
    text: text.slice(0, limit),
    ...(text.length > limit ? { truncated: true } : {}),
    links,
    images,
    ...(image ? { image } : {}),
  }
}

// ─── Link previews ───────────────────────────────────────────────────────

const previews = new Map<string, { at: number; value: WebPreview }>()

/** Title, description and picture of a page, for the cards under a Copilot reply. */
export async function linkPreview(raw: string): Promise<WebPreview> {
  const hit = previews.get(raw)
  if (hit && Date.now() - hit.at < 3600_000) return hit.value
  const { url, type, bytes } = await get(raw)
  let value: WebPreview
  if (type.startsWith('image/')) value = { url: url.href, title: url.pathname.split('/').pop() || url.hostname, site: url.hostname, image: url.href }
  else {
    const html = bytes.toString('utf8')
    const lead = meta(html, 'og:image') ?? meta(html, 'twitter:image')
    value = {
      url: url.href,
      title: meta(html, 'og:title') ?? strip(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '') ?? url.hostname,
      description: meta(html, 'og:description') ?? meta(html, 'description'),
      site: meta(html, 'og:site_name') ?? url.hostname.replace(/^www\./, ''),
      image: lead ? (absolute(lead, url) ?? undefined) : undefined,
    }
  }
  previews.set(raw, { at: Date.now(), value })
  if (previews.size > 300) previews.delete(previews.keys().next().value!)
  return value
}

// ─── Screenshots ─────────────────────────────────────────────────────────

let webSession: Electron.Session | null = null

/** A separate in-memory browser session for looking at pages: no editor cookies, no downloads, nothing local. */
function browsing() {
  if (webSession) return webSession
  const s = session.fromPartition('lumen-web')
  s.setUserAgent(UA)
  s.on('will-download', (e) => e.preventDefault())
  s.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  s.webRequest.onBeforeRequest((details, cb) => {
    try {
      const u = new URL(details.url)
      const ok = u.protocol === 'data:' || u.protocol === 'blob:' || ((u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'wss:') && !blockedHost(u.hostname))
      cb({ cancel: !ok })
    } catch {
      cb({ cancel: true })
    }
  })
  webSession = s
  return s
}

/** Tallest full-page capture (offscreen windows render at most 4× their size). */
const FULL_PAGE_MAX = 3600

export async function screenshotPage(raw: string, opts: { width?: number; height?: number; fullPage?: boolean } = {}): Promise<WebShot> {
  const url = await checkUrl(raw)
  const width = Math.round(Math.min(1920, Math.max(360, opts.width ?? 1280)))
  const height = Math.round(Math.min(2000, Math.max(360, opts.height ?? 800)))
  // The exact size on any display scaling, with room to grow for a full-page capture.
  const { win, resize } = exactOffscreenWindow(width, height, {
    maxHeight: opts.fullPage ? FULL_PAGE_MAX : undefined,
    webPreferences: { session: browsing(), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false },
  })
  try {
    win.webContents.setAudioMuted(true)
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    const loaded = win.loadURL(url.href).catch(() => {})
    await Promise.race([loaded, new Promise((r) => setTimeout(r, 20_000))])
    // Late images, fonts and animations settle.
    await new Promise((r) => setTimeout(r, 1500))
    let shotHeight = height
    if (opts.fullPage) {
      const full = Number(await win.webContents.executeJavaScript('Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0)').catch(() => height))
      shotHeight = Math.min(FULL_PAGE_MAX, Math.max(height, Number.isFinite(full) ? full : height))
      if (shotHeight > height) {
        resize(width, shotHeight)
        await new Promise((r) => setTimeout(r, 600))
      }
    }
    const image = await win.webContents.capturePage()
    if (image.isEmpty()) throw new Error('The page didn’t draw anything.')
    const scaled = image.getSize().width > 1280 ? image.resize({ width: 1280, quality: 'good' }) : image
    return { url: win.webContents.getURL() || url.href, title: win.webContents.getTitle(), width, height: shotHeight, image: scaled.toJPEG(80).toString('base64') }
  } finally {
    win.destroy()
  }
}
