import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { BrowserWindow, dialog, net, protocol, shell } from 'electron'
import type { MediaFileInfo, MediaFolder } from '../shared/app'
import { serveIngest } from './ingest'
import { allowPath, ensureDir, fileUrl, isInside, MEDIA_SCHEME, mediaPath, mediaRoot, mediaUrl, userDir } from './integrations/paths'

/**
 * Media on disk: the lumen-media:// protocol (with byte ranges, so video can
 * seek and large files stream), plus the dialogs and bookkeeping for files the
 * user brings into a project.
 */

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.weba': 'audio/webm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.onnx': 'application/octet-stream',
  '.txt': 'text/plain',
}

export const VIDEO_EXT = ['mp4', 'm4v', 'mov', 'webm', 'mkv']
export const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'weba']
export const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp', 'svg']

export const mimeOf = (file: string) => MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
const isMedia = (file: string) => /^(video|audio|image)\//.test(mimeOf(file))

/** The URL the editor loads a file from: the library host for Lumen's own media, the file host otherwise. */
export function urlFor(abs: string) {
  return isInside(abs, mediaRoot()) ? mediaUrl(abs) : fileUrl(abs)
}

export function fileInfo(abs: string): MediaFileInfo | null {
  try {
    const stat = fs.statSync(abs)
    if (!stat.isFile()) return null
    allowPath(abs)
    return { path: abs, url: urlFor(abs), name: path.basename(abs), size: stat.size, mime: mimeOf(abs), mtime: Math.round(stat.mtimeMs) }
  } catch {
    return null
  }
}

// ─── Protocol ────────────────────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Range',
  'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
}

// ─── On-device models ────────────────────────────────────────────────────
// lumen-media://models/<repo>/resolve/<revision>/<file> proxies Hugging Face and keeps
// a copy in userData/models, so models download once and then work offline.

const MODEL_HOST = 'huggingface.co'
const modelsRoot = () => path.join(userDir(), 'models')

async function serveModel(req: Request): Promise<Response> {
  const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '')
  if (!/^[\w.-]+\/[\w.-]+\/resolve\/[\w.-]+\/[\w./-]+$/.test(rel) || rel.split('/').includes('..')) {
    return new Response('Bad model path', { status: 400, headers: CORS })
  }
  const file = path.join(modelsRoot(), ...rel.replace('/resolve/', '/').split('/'))
  const headers = new Headers({ ...CORS, 'Content-Type': mimeOf(file), 'Accept-Ranges': 'bytes' })
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.get('range')?.trim() ?? '')
  try {
    const stat = await fs.promises.stat(file)
    if (range) {
      const start = Number(range[1])
      const end = Math.min(range[2] ? Number(range[2]) : stat.size - 1, stat.size - 1)
      headers.set('Content-Range', `bytes ${start}-${end}/${stat.size}`)
      headers.set('Content-Length', String(Math.max(0, end - start + 1)))
      return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream, { status: 206, headers })
    }
    headers.set('Content-Length', String(stat.size))
    if (req.method === 'HEAD') return new Response(null, { status: 200, headers })
    return new Response(Readable.toWeb(fs.createReadStream(file)) as ReadableStream, { status: 200, headers })
  } catch {
    /* not cached yet */
  }
  if (range) {
    // Existence / size checks: ask upstream for just those bytes, don't download the file.
    const probe = await net.fetch(`https://${MODEL_HOST}/${rel}`, { headers: { Range: req.headers.get('range')! } })
    const h = new Headers({ ...CORS, 'Content-Type': probe.headers.get('content-type') ?? mimeOf(file) })
    for (const k of ['content-range', 'content-length']) if (probe.headers.get(k)) h.set(k, probe.headers.get(k)!)
    return new Response(probe.body, { status: probe.status, headers: h })
  }
  const upstream = await net.fetch(`https://${MODEL_HOST}/${rel}`, { method: req.method === 'HEAD' ? 'HEAD' : 'GET' })
  if (!upstream.ok || !upstream.body) return new Response(upstream.statusText || 'Download failed', { status: upstream.status || 502, headers: CORS })
  const length = upstream.headers.get('content-length')
  if (length) headers.set('Content-Length', length)
  if (req.method === 'HEAD') return new Response(null, { status: 200, headers })
  // Stream to the editor while saving a copy; the copy only lands once complete.
  const [toEditor, toDisk] = upstream.body.tee()
  ensureDir(path.dirname(file))
  const partial = `${file}.${process.pid}.part`
  void pipeline(Readable.fromWeb(toDisk as import('node:stream/web').ReadableStream), fs.createWriteStream(partial))
    .then(() => fs.promises.rename(partial, file))
    .catch(() => fs.promises.rm(partial, { force: true }))
  return new Response(toEditor, { status: 200, headers })
}

async function serve(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  const host = new URL(req.url).hostname
  if (host === 'models') return serveModel(req)
  // Frames on their way from the ingest receiver to the editor's encoder.
  if (host === 'ingest') return serveIngest(req)
  const abs = mediaPath(req.url)
  if (!abs) return new Response('Not found', { status: 404, headers: CORS })
  let size: number
  try {
    const stat = await fs.promises.stat(abs)
    if (!stat.isFile()) throw new Error('not a file')
    size = stat.size
  } catch {
    return new Response('Not found', { status: 404, headers: CORS })
  }
  const headers = new Headers({ ...CORS, 'Content-Type': mimeOf(abs), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' })
  const head = req.method === 'HEAD'
  const range = req.headers.get('range')
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null
  if (m && (m[1] || m[2])) {
    let start: number
    let end: number
    if (!m[1]) {
      // suffix range: the last N bytes
      start = Math.max(0, size - Number(m[2]))
      end = size - 1
    } else {
      start = Number(m[1])
      end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
    }
    if (start >= size || start > end) {
      headers.set('Content-Range', `bytes */${size}`)
      return new Response(null, { status: 416, headers })
    }
    headers.set('Content-Range', `bytes ${start}-${end}/${size}`)
    headers.set('Content-Length', String(end - start + 1))
    if (head) return new Response(null, { status: 206, headers })
    return new Response(Readable.toWeb(fs.createReadStream(abs, { start, end })) as ReadableStream, { status: 206, headers })
  }
  headers.set('Content-Length', String(size))
  if (head || size === 0) return new Response(null, { status: 200, headers })
  return new Response(Readable.toWeb(fs.createReadStream(abs)) as ReadableStream, { status: 200, headers })
}

export function registerMediaProtocol() {
  protocol.handle(MEDIA_SCHEME, serve)
}

// ─── Dialogs & files ─────────────────────────────────────────────────────

const MEDIA_FILTERS = [
  { name: 'Media', extensions: [...VIDEO_EXT, ...AUDIO_EXT, ...IMAGE_EXT] },
  { name: 'Video', extensions: VIDEO_EXT },
  { name: 'Audio', extensions: AUDIO_EXT },
  { name: 'Images', extensions: IMAGE_EXT },
]

let lastImportDir: string | undefined

export async function pickMedia(win: BrowserWindow | null): Promise<MediaFileInfo[]> {
  const opts: Electron.OpenDialogOptions = {
    title: 'Import media',
    buttonLabel: 'Import',
    defaultPath: lastImportDir,
    properties: ['openFile', 'multiSelections'],
    filters: MEDIA_FILTERS,
  }
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  if (res.canceled || !res.filePaths.length) return []
  lastImportDir = path.dirname(res.filePaths[0])
  return register(res.filePaths)
}

/** Files dropped onto the editor (by path). Folders are expanded one level. */
export function register(paths: string[]): MediaFileInfo[] {
  const out: MediaFileInfo[] = []
  for (const p of paths) {
    if (typeof p !== 'string' || !p) continue
    const abs = path.resolve(p)
    let stat: fs.Stats
    try {
      stat = fs.statSync(abs)
    } catch {
      continue
    }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(abs).sort()) {
        const child = path.join(abs, name)
        if (isMedia(child)) {
          const info = fileInfo(child)
          if (info) out.push(info)
        }
      }
    } else if (isMedia(abs)) {
      const info = fileInfo(abs)
      if (info) out.push(info)
    }
  }
  return out
}

export async function relink(win: BrowserWindow | null, name: string): Promise<MediaFileInfo | null> {
  const ext = path.extname(name).replace('.', '').toLowerCase()
  const opts: Electron.OpenDialogOptions = {
    title: `Locate “${name}”`,
    buttonLabel: 'Relink',
    defaultPath: lastImportDir,
    properties: ['openFile'],
    filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }, ...MEDIA_FILTERS] : MEDIA_FILTERS,
  }
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  if (res.canceled || !res.filePaths[0]) return null
  lastImportDir = path.dirname(res.filePaths[0])
  return fileInfo(res.filePaths[0])
}

/** Reveals a file (path or lumen-media URL) in Explorer / Finder. */
export function reveal(target: string) {
  const abs = target.includes('://') ? mediaPath(target) : path.resolve(target)
  if (abs && fs.existsSync(abs)) shell.showItemInFolder(abs)
}

export async function openPath(target: string) {
  const abs = path.resolve(target)
  if (fs.existsSync(abs)) await shell.openPath(abs)
}

const safeName = (name: string) => name.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'media'

/** Writes bytes the editor produced (snapshots, recordings, synthesized sounds) into the media library. */
export function saveMedia(folder: MediaFolder, fileName: string, data: Uint8Array): MediaFileInfo {
  const dir = ensureDir(path.join(mediaRoot(), folder))
  const ext = path.extname(fileName).toLowerCase()
  const base = safeName(path.basename(fileName, ext))
  const abs = path.join(dir, `${base}-${randomUUID().slice(0, 8)}${ext}`)
  fs.writeFileSync(abs, data)
  const info = fileInfo(abs)
  if (!info) throw new Error('Could not save the file')
  return info
}

export function urlForPath(p: string): MediaFileInfo | null {
  return fileInfo(path.resolve(p))
}
