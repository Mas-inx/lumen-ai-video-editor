import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { app } from 'electron'

/**
 * Everything Lumen renders or downloads lives under userData/media and is
 * served to the editor through the `lumen-media://` protocol, so project files
 * keep working across restarts (unlike blob: URLs).
 */
export const MEDIA_SCHEME = 'lumen-media'
const MEDIA_HOST = 'local'
/** User files (imports, project media) are served from their own location as lumen-media://file/<encoded path>. */
const FILE_HOST = 'file'

export const userDir = () => app.getPath('userData')
export const mediaRoot = () => path.join(userDir(), 'media')

export function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** A fresh folder for one job's output, e.g. media/blender/<jobId>. */
export const jobDir = (integration: string, jobId: string) => ensureDir(path.join(mediaRoot(), integration, jobId))

/** Scratch space for scripts and compositions (not served). */
export const workDir = (integration: string, jobId: string) => ensureDir(path.join(app.getPath('temp'), 'lumen', integration, jobId))

export function mediaUrl(absPath: string) {
  const rel = path.relative(mediaRoot(), absPath)
  return `${MEDIA_SCHEME}://${MEDIA_HOST}/${rel.split(path.sep).map(encodeURIComponent).join('/')}`
}

/** URL for any file on disk (the protocol only serves it once it's been allowed). */
export const fileUrl = (absPath: string) => `${MEDIA_SCHEME}://${FILE_HOST}/${encodeURIComponent(path.resolve(absPath))}`

// Paths the editor may read: files the user imported or that an opened project references.
const allowed = new Set<string>()
const key = (abs: string) => (process.platform === 'win32' ? path.resolve(abs).toLowerCase() : path.resolve(abs))

export function allowPath(abs: string) {
  allowed.add(key(abs))
}

export function isInside(abs: string, root: string) {
  const a = key(abs)
  const r = key(root)
  return a === r || a.startsWith(r.endsWith(path.sep) ? r : r + path.sep)
}

/** Maps a lumen-media URL back to a file: library files, or user files the editor was given. */
export function mediaPath(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${MEDIA_SCHEME}:`) return null
  if (parsed.hostname === MEDIA_HOST) {
    const rel = decodeURIComponent(parsed.pathname).replace(/^\/+/, '')
    const root = mediaRoot()
    const abs = path.resolve(root, rel)
    return abs.startsWith(root + path.sep) ? abs : null
  }
  if (parsed.hostname === FILE_HOST) {
    const abs = path.resolve(decodeURIComponent(parsed.pathname.replace(/^\/+/, '')))
    if (allowed.has(key(abs)) || isInside(abs, mediaRoot())) return abs
    // Frames of an allowed image sequence live in an allowed folder.
    if (allowed.has(key(path.dirname(abs)))) return abs
    return null
  }
  return null
}

/** JSON settings file in userData (integration paths, MCP servers…). */
export function readJson<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(path.join(userDir(), name), 'utf8')) as T
  } catch {
    return fallback
  }
}

export function writeJson(name: string, value: unknown) {
  ensureDir(userDir())
  fs.writeFileSync(path.join(userDir(), name), JSON.stringify(value, null, 2))
}

const require = createRequire(import.meta.url)

/** Absolute path of a file inside an installed package (works in dev and packaged builds). */
export function packageFile(pkg: string, file: string) {
  const root = path.dirname(require.resolve(`${pkg}/package.json`))
  return path.join(root, file)
}
