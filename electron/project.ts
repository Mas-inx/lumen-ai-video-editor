import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, dialog } from 'electron'
import { APP_IPC, type CloseChoice, type OpenedProject, type RecentProject, type RecoveryInfo } from '../shared/app'
import { fileInfo, urlFor } from './files'
import { allowPath, ensureDir, mediaPath, readJson, userDir, writeJson } from './integrations/paths'

/**
 * Project files (.lumen): JSON documents that reference media by absolute path
 * plus a path relative to the project, so a project folder can be moved or
 * copied to another drive and still find its media.
 */

export const PROJECT_EXT = 'lumen'
const FORMAT = 'lumen-project'
const FORMAT_VERSION = 1
const RECENT_FILE = 'recent-projects.json'
const RECENT_LIMIT = 12

interface ProjectEnvelope {
  format: typeof FORMAT
  version: number
  app: string
  savedAt: string
  project: StoredProject
}

interface StoredSource {
  type: string
  url?: string
  path?: string
  relPath?: string
  base?: string
  dir?: string
  relDir?: string
  [key: string]: unknown
}

interface StoredProject {
  name?: string
  assets?: Record<string, { source?: StoredSource; [key: string]: unknown }>
  [key: string]: unknown
}

const posix = (p: string) => p.split(path.sep).join('/')

function atomicWrite(file: string, text: string) {
  ensureDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, file)
}

// ─── Serialization ───────────────────────────────────────────────────────

/** Adds absolute + project-relative paths to every media reference, and drops runtime URLs. */
function toStored(project: StoredProject, projectPath: string): StoredProject {
  const dir = path.dirname(projectPath)
  for (const asset of Object.values(project.assets ?? {})) {
    const src = asset.source
    if (!src) continue
    if (src.type === 'file') {
      const abs = src.path ?? (src.url ? mediaPath(src.url) : null)
      if (abs) {
        src.path = abs
        src.relPath = posix(path.relative(dir, abs))
        delete src.url
      }
    } else if (src.type === 'sequence') {
      const absDir = src.dir ?? (src.base ? mediaPath(src.base + '_') : null)
      if (absDir) {
        const d = src.dir ?? path.dirname(absDir)
        src.dir = d
        src.relDir = posix(path.relative(dir, d))
        if (typeof src.poster === 'string' && src.base && src.poster.startsWith(src.base)) {
          src.posterFile = src.poster.slice(src.base.length)
          delete src.poster
        }
        delete src.base
      }
    }
  }
  return project
}

/** Resolves every media reference against the disk, registers it for reading and restores URLs. */
function fromStored(project: StoredProject, projectPath: string | null): { project: StoredProject; missing: string[] } {
  const dir = projectPath ? path.dirname(projectPath) : null
  const missing: string[] = []
  for (const [id, asset] of Object.entries(project.assets ?? {})) {
    const src = asset.source
    if (!src) continue
    if (src.type === 'file') {
      const candidates = [src.path, dir && src.relPath ? path.resolve(dir, src.relPath) : null, src.url ? mediaPath(src.url) : null].filter((p): p is string => Boolean(p))
      const found = candidates.find((p) => fs.existsSync(p))
      if (found) {
        src.path = found
        src.url = urlFor(found)
        allowPath(found)
        const info = fileInfo(found)
        if (info) src.mtime = info.mtime
        delete src.missing
      } else {
        src.path = candidates[0]
        src.url = candidates[0] ? urlFor(candidates[0]) : (src.url ?? '')
        src.missing = true
        missing.push(id)
      }
    } else if (src.type === 'sequence') {
      const fromBase = src.base ? mediaPath(src.base + '_') : null
      const candidates = [src.dir, dir && src.relDir ? path.resolve(dir, src.relDir) : null, fromBase ? path.dirname(fromBase) : null].filter((p): p is string => Boolean(p))
      const found = candidates.find((p) => fs.existsSync(p))
      const use = found ?? candidates[0]
      if (use) {
        src.dir = use
        allowPath(use)
        const url = urlFor(path.join(use, '_'))
        src.base = url.slice(0, -1)
        if (typeof src.posterFile === 'string') {
          src.poster = src.base + src.posterFile
          delete src.posterFile
        }
      }
      if (!found) {
        src.missing = true
        missing.push(id)
      } else delete src.missing
    }
  }
  return { project, missing }
}

function parseEnvelope(text: string): ProjectEnvelope {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('This file isn’t a Lumen project (it isn’t valid JSON).')
  }
  const env = data as Partial<ProjectEnvelope>
  if (env?.format !== FORMAT || typeof env.project !== 'object' || !env.project) throw new Error('This file isn’t a Lumen project.')
  if ((env.version ?? 1) > FORMAT_VERSION) throw new Error('This project was saved by a newer version of Lumen. Update Lumen to open it.')
  return env as ProjectEnvelope
}

function envelope(projectText: string, projectPath: string): string {
  const project = toStored(JSON.parse(projectText) as StoredProject, projectPath)
  const env: ProjectEnvelope = { format: FORMAT, version: FORMAT_VERSION, app: `Lumen ${app.getVersion()}`, savedAt: new Date().toISOString(), project }
  return JSON.stringify(env)
}

// ─── Recent projects ─────────────────────────────────────────────────────

type RecentEntry = Omit<RecentProject, 'exists'>

function readRecent(): RecentEntry[] {
  const list = readJson<RecentEntry[]>(RECENT_FILE, [])
  return Array.isArray(list) ? list.filter((r) => r && typeof r.path === 'string') : []
}

export function recentProjects(): RecentProject[] {
  return readRecent().map((r) => ({ ...r, exists: fs.existsSync(r.path) }))
}

function touchRecent(file: string, name: string) {
  const list = readRecent().filter((r) => path.resolve(r.path).toLowerCase() !== path.resolve(file).toLowerCase())
  list.unshift({ path: file, name, openedAt: Date.now() })
  writeJson(RECENT_FILE, list.slice(0, RECENT_LIMIT))
  app.addRecentDocument(file)
}

export function forgetRecent(file: string): RecentProject[] {
  writeJson(
    RECENT_FILE,
    readRecent().filter((r) => path.resolve(r.path).toLowerCase() !== path.resolve(file).toLowerCase()),
  )
  return recentProjects()
}

// ─── Open / save ─────────────────────────────────────────────────────────

const FILTERS = [{ name: 'Lumen project', extensions: [PROJECT_EXT] }]

export async function openProject(win: BrowserWindow | null, file?: string): Promise<OpenedProject | null> {
  let target = file
  if (!target) {
    const opts: Electron.OpenDialogOptions = { title: 'Open project', properties: ['openFile'], filters: FILTERS, defaultPath: lastProjectDir() }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || !res.filePaths[0]) return null
    target = res.filePaths[0]
  }
  const abs = path.resolve(target)
  if (!fs.existsSync(abs)) throw new Error(`“${path.basename(abs)}” can’t be found. It may have been moved or deleted.`)
  const env = parseEnvelope(fs.readFileSync(abs, 'utf8'))
  const { project, missing } = fromStored(env.project, abs)
  touchRecent(abs, typeof project.name === 'string' ? project.name : path.basename(abs, `.${PROJECT_EXT}`))
  return { path: abs, text: JSON.stringify(project), missing }
}

export function saveProject(file: string, projectText: string) {
  const abs = path.resolve(file)
  atomicWrite(abs, envelope(projectText, abs))
  const name = (JSON.parse(projectText) as StoredProject).name
  touchRecent(abs, typeof name === 'string' ? name : path.basename(abs, `.${PROJECT_EXT}`))
  return { path: abs }
}

export async function saveProjectAs(win: BrowserWindow | null, suggestedName: string, projectText: string) {
  const base = suggestedName.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ').trim() || 'Untitled'
  const opts: Electron.SaveDialogOptions = {
    title: 'Save project',
    defaultPath: path.join(lastProjectDir(), `${base}.${PROJECT_EXT}`),
    filters: FILTERS,
  }
  const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
  if (res.canceled || !res.filePath) return null
  let target = res.filePath
  if (!target.toLowerCase().endsWith(`.${PROJECT_EXT}`)) target += `.${PROJECT_EXT}`
  return saveProject(target, projectText)
}

function lastProjectDir() {
  const recent = readRecent()[0]
  if (recent) return path.dirname(recent.path)
  const docs = path.join(app.getPath('documents'), 'Lumen')
  return ensureDir(docs)
}

// ─── Recovery ────────────────────────────────────────────────────────────

const recoveryFile = () => path.join(userDir(), 'recovery', 'autosave.json')

export function writeRecovery(snapshot: { text: string; path: string | null; name: string } | null) {
  const file = recoveryFile()
  if (!snapshot) {
    fs.rmSync(file, { force: true })
    return
  }
  // Media references stay absolute here: recovery is only ever reopened on this machine.
  const info: RecoveryInfo = { text: snapshot.text, path: snapshot.path, name: snapshot.name, savedAt: Date.now() }
  atomicWrite(file, JSON.stringify(info))
}

export function readRecovery(): RecoveryInfo | null {
  try {
    const info = JSON.parse(fs.readFileSync(recoveryFile(), 'utf8')) as RecoveryInfo
    if (typeof info?.text !== 'string') return null
    const { project } = fromStored(JSON.parse(info.text) as StoredProject, info.path)
    return { ...info, text: JSON.stringify(project) }
  } catch {
    return null
  }
}

// ─── Window state & closing ──────────────────────────────────────────────

const state = { name: 'Untitled', path: null as string | null, dirty: false }
let forceClose = false

export function setProjectState(win: BrowserWindow, next: { name?: unknown; path?: unknown; dirty?: unknown }) {
  if (typeof next.name === 'string') state.name = next.name
  if (typeof next.path === 'string' || next.path === null) state.path = next.path as string | null
  if (typeof next.dirty === 'boolean') state.dirty = next.dirty
  if (!win.isDestroyed()) {
    win.setTitle(`${state.dirty ? '• ' : ''}${state.name} — Lumen`)
    win.setDocumentEdited(state.dirty)
    if (state.path) win.setRepresentedFilename(state.path)
  }
}

export async function confirmDiscard(win: BrowserWindow | null, name: string): Promise<CloseChoice> {
  const opts: Electron.MessageBoxOptions = {
    type: 'warning',
    buttons: ['Save', 'Don’t save', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
    title: 'Lumen',
    message: `Save changes to “${name}”?`,
    detail: 'Your changes will be lost if you don’t save them.',
  }
  const { response } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
  return response === 0 ? 'save' : response === 1 ? 'discard' : 'cancel'
}

/** Asks before closing a window with unsaved changes. */
export function guardClose(win: BrowserWindow) {
  win.on('close', (e) => {
    if (forceClose || !state.dirty) return
    e.preventDefault()
    void confirmDiscard(win, state.name).then((choice) => {
      if (choice === 'discard') {
        writeRecovery(null)
        closeNow(win)
      } else if (choice === 'save') win.webContents.send(APP_IPC.saveBeforeClose)
    })
  })
}

export function closeNow(win: BrowserWindow) {
  forceClose = true
  if (!win.isDestroyed()) win.close()
}

// ─── Launch with a file ──────────────────────────────────────────────────

export function projectFromArgv(argv: string[]): string | null {
  for (const arg of argv.slice(1)) {
    if (arg.startsWith('-')) continue
    if (arg.toLowerCase().endsWith(`.${PROJECT_EXT}`) && fs.existsSync(arg)) return path.resolve(arg)
  }
  return null
}
