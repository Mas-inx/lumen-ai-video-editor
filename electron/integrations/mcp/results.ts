import type { GeneratedAsset, McpCallResult, McpLink, Provenance } from '../../../shared/integrations'
import { kindOf, MEDIA_URL_RE, mimeFromName, saveBase64 } from '../media'

/**
 * Turns an MCP tool result into things an editor can use: inline images and
 * audio are saved as files right away; media URLs (how most generation
 * services hand back video) are collected so the user can pull them in.
 */

type Content =
  | { type: 'text'; text: string }
  | { type: 'image' | 'audio'; data: string; mimeType: string }
  | { type: 'resource_link'; uri: string; mimeType?: string; name?: string; title?: string }
  | { type: 'resource'; resource: { uri: string; mimeType?: string; text?: string; blob?: string } }
  | { type: string; [key: string]: unknown }

/** JSON keys that usually hold a result's media URL, even when it has no file extension. */
const MEDIA_KEY = /(^|_)(url|uri|href|src|image|video|audio|media|output|result|file|download)s?(_url)?$/i

export function convertResult(result: Record<string, unknown>, provenance: Provenance): McpCallResult {
  const text: string[] = []
  const media: GeneratedAsset[] = []
  const links = new Map<string, McpLink>()
  const addLink = (url: string, mime?: string, name?: string) => {
    if (!/^https?:\/\//i.test(url) || links.has(url)) return
    links.set(url, { url, mime: mime ?? mimeFromName(url), name })
  }
  const name = (i: number) => `${provenance.prompt?.slice(0, 40) || provenance.tool} ${i + 1}`

  const content = (Array.isArray(result.content) ? result.content : []) as Content[]
  for (const item of content) {
    if (item.type === 'text' && typeof item.text === 'string') text.push(item.text)
    else if ((item.type === 'image' || item.type === 'audio') && typeof item.data === 'string' && typeof item.mimeType === 'string') {
      if (kindOf(item.mimeType)) media.push(saveBase64(item.data, item.mimeType, name(media.length), provenance))
    } else if (item.type === 'resource_link' && typeof item.uri === 'string') {
      addLink(item.uri, item.mimeType as string | undefined, (item.title ?? item.name) as string | undefined)
    } else if (item.type === 'resource' && item.resource && typeof item.resource === 'object') {
      const r = item.resource as { uri: string; mimeType?: string; text?: string; blob?: string }
      if (r.blob && r.mimeType && kindOf(r.mimeType)) media.push(saveBase64(r.blob, r.mimeType, name(media.length), provenance))
      else if (typeof r.text === 'string') text.push(r.text)
      addLink(r.uri, r.mimeType)
    }
  }
  // Protocol-2024 servers put everything in `toolResult`.
  if (!content.length && result.toolResult !== undefined) text.push(typeof result.toolResult === 'string' ? result.toolResult : JSON.stringify(result.toolResult, null, 2))

  const structured = result.structuredContent
  for (const block of [...text, structured === undefined ? '' : JSON.stringify(structured)]) {
    for (const match of block.matchAll(MEDIA_URL_RE)) addLink(match[0])
    // Many services return JSON; pick up URLs under media-ish keys too.
    const trimmed = block.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        walk(JSON.parse(trimmed), (key, value) => {
          if (MEDIA_KEY.test(key) && /^https?:\/\//.test(value)) addLink(value)
        })
      } catch {
        /* not JSON */
      }
    }
  }

  return { isError: Boolean(result.isError), text, media, links: [...links.values()], structured }
}

function walk(value: unknown, visit: (key: string, value: string) => void, key = '', depth = 0) {
  if (depth > 8) return
  if (typeof value === 'string') visit(key, value)
  else if (Array.isArray(value)) value.forEach((v) => walk(v, visit, key, depth + 1))
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, visit, k, depth + 1)
}
