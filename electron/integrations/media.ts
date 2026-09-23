import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { net, shell } from 'electron'
import type { GeneratedAsset, Provenance } from '../../shared/integrations'
import { ensureDir, mediaPath, mediaRoot, mediaUrl } from './paths'

/** Saving generated media (inline tool results, downloads) into Lumen's library folder. */

const EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/ogg': '.ogg',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/flac': '.flac',
}

const MIME_BY_EXT: Record<string, string> = Object.fromEntries(Object.entries(EXT).map(([mime, ext]) => [ext, mime]))
Object.assign(MIME_BY_EXT, { '.jpeg': 'image/jpeg', '.m4v': 'video/mp4' })

export const MEDIA_URL_RE = /https?:\/\/[^\s"'<>()]+?\.(?:png|jpe?g|webp|gif|avif|mp4|webm|mov|m4v|mp3|wav|ogg|m4a|aac|flac)(?:\?[^\s"'<>()]*)?(?=[\s"'<>(),]|$)/gi

export function kindOf(mime: string): GeneratedAsset['kind'] | null {
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  return null
}

export function mimeFromName(name: string) {
  return MIME_BY_EXT[path.extname(name.split('?')[0]).toLowerCase()]
}

const cleanName = (name: string) => name.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_-]+/g, ' ').trim().slice(0, 60) || 'Generated media'

function fileAsset(abs: string, mime: string, name: string, provenance: Provenance): GeneratedAsset {
  const kind = kindOf(mime)
  if (!kind) throw new Error(`Unsupported media type: ${mime}`)
  return {
    name: cleanName(name),
    kind,
    source: { type: 'file', url: mediaUrl(abs), path: abs, mime, fileName: path.basename(abs), size: fs.statSync(abs).size },
    provenance,
  }
}

/** Writes base64 media from a tool result to disk. */
export function saveBase64(data: string, mime: string, name: string, provenance: Provenance): GeneratedAsset {
  const dir = ensureDir(path.join(mediaRoot(), 'mcp'))
  const abs = path.join(dir, `${randomUUID()}${EXT[mime] ?? ''}`)
  fs.writeFileSync(abs, Buffer.from(data, 'base64'))
  return fileAsset(abs, mime, name, provenance)
}

/** Downloads remote media (e.g. a video URL a generation service returned). */
export async function importUrl(url: string, name: string | undefined, provenance: Provenance): Promise<GeneratedAsset> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('Only web URLs can be imported.')
  const res = await net.fetch(url)
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`)
  const headerMime = res.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
  const mime = headerMime && kindOf(headerMime) ? headerMime : mimeFromName(parsed.pathname)
  if (!mime || !kindOf(mime)) throw new Error('That link isn’t an image, video or audio file.')
  const dir = ensureDir(path.join(mediaRoot(), 'imports'))
  const abs = path.join(dir, `${randomUUID()}${EXT[mime] ?? path.extname(parsed.pathname)}`)
  await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), fs.createWriteStream(abs))
  return fileAsset(abs, mime, name ?? decodeURIComponent(path.basename(parsed.pathname)), provenance)
}

export function reveal(url: string) {
  const abs = mediaPath(url)
  if (abs) shell.showItemInFolder(abs)
}
