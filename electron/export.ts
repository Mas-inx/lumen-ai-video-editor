import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { app, BrowserWindow, dialog } from 'electron'
import type { ExportHandle, ExportTarget } from '../shared/app'
import { ensureDir } from './integrations/paths'

/**
 * Export files: the editor encodes (WebCodecs) and streams the container bytes
 * here in positioned chunks, so multi-gigabyte renders never sit in memory.
 * Image sequences write one numbered PNG per frame into a folder of their own.
 * A destination can be chosen now and opened later — the render queue picks
 * every file up front and renders them one after another.
 */

interface OpenFile {
  kind: 'file'
  path: string
  partial: string
  fd: number
  size: number
}

interface OpenFolder {
  kind: 'folder'
  path: string
  base: string
  written: Set<string>
  size: number
  created: boolean
}

interface Picked {
  path: string
  folder: boolean
}

const open = new Map<string, OpenFile | OpenFolder>()
const picked = new Map<string, Picked>()
/** Exports finished this session: the only places captions may be written next to. */
const finished = new Set<string>()
let lastExportDir: string | undefined

export interface ExportRequest {
  defaultName: string
  extension: string
  filterName: string
  /** An image sequence: a folder of numbered frames instead of one file. */
  folder?: boolean
}

const cleanBase = (name: string) => String(name).replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ').trim() || 'Untitled'

/** Asks where an export goes (a Save dialog, or a folder for image sequences). Nothing is written yet. */
export async function pickExport(win: BrowserWindow | null, opts: ExportRequest): Promise<ExportTarget | null> {
  const ext = String(opts.extension).replace(/[^a-z0-9]/gi, '').toLowerCase() || 'mp4'
  const base = cleanBase(opts.defaultName)
  const dir = lastExportDir ?? ensureDir(app.getPath('videos'))
  // Automated tests export into a fixed folder instead of asking where to save.
  const testDir = process.env.LUMEN_TEST_EXPORT_DIR
  let target: string
  if (opts.folder) {
    let parent: string
    if (testDir) parent = ensureDir(testDir)
    else {
      const dialogOpts: Electron.OpenDialogOptions = {
        title: `Choose where the ${String(opts.filterName || 'frames')} go`,
        buttonLabel: 'Export here',
        defaultPath: dir,
        properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
      }
      const res = win ? await dialog.showOpenDialog(win, dialogOpts) : await dialog.showOpenDialog(dialogOpts)
      if (res.canceled || !res.filePaths[0]) return null
      parent = res.filePaths[0]
    }
    lastExportDir = parent
    // The frames get a folder of their own, named after the export.
    target = path.join(parent, base)
  } else {
    if (testDir) target = path.join(ensureDir(testDir), `${base}.${ext}`)
    else {
      const dialogOpts: Electron.SaveDialogOptions = {
        title: 'Export',
        buttonLabel: 'Export',
        defaultPath: path.join(dir, `${base}.${ext}`),
        filters: [{ name: String(opts.filterName || ext.toUpperCase()), extensions: [ext] }],
      }
      const res = win ? await dialog.showSaveDialog(win, dialogOpts) : await dialog.showSaveDialog(dialogOpts)
      if (res.canceled || !res.filePath) return null
      target = res.filePath
    }
    if (!target.toLowerCase().endsWith(`.${ext}`)) target += `.${ext}`
    lastExportDir = path.dirname(target)
  }
  const token = randomUUID()
  picked.set(token, { path: target, folder: Boolean(opts.folder) })
  return { token, path: target, folder: Boolean(opts.folder) }
}

/** A folder that doesn't exist yet (or is empty): `name`, else `name 2`, `name 3`… */
function freeFolder(target: string) {
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? target : `${target} ${n}`
    if (!fs.existsSync(candidate)) return { dir: candidate, created: true }
    try {
      if (fs.statSync(candidate).isDirectory() && !fs.readdirSync(candidate).length) return { dir: candidate, created: false }
    } catch {
      /* not usable — try the next name */
    }
  }
  throw new Error('Couldn’t find a free folder name for the frames.')
}

/** Opens a picked destination for writing. */
export function openPicked(token: string): ExportHandle {
  const p = picked.get(String(token))
  if (!p) throw new Error('That export destination is no longer available — choose it again.')
  picked.delete(String(token))
  const id = randomUUID()
  if (p.folder) {
    const { dir, created } = freeFolder(p.path)
    fs.mkdirSync(dir, { recursive: true })
    open.set(id, { kind: 'folder', path: dir, base: path.basename(p.path), written: new Set(), size: 0, created })
    return { id, path: dir }
  }
  ensureDir(path.dirname(p.path))
  // Write next to the destination and move into place at the end, so a failed
  // or cancelled export never leaves a broken file where the user expects one.
  const partial = `${p.path}.partial`
  const fd = fs.openSync(partial, 'w')
  open.set(id, { kind: 'file', path: p.path, partial, fd, size: 0 })
  return { id, path: p.path }
}

/** A destination the queue won't render after all. */
export function forgetPicked(token: string) {
  picked.delete(String(token))
}

export async function beginExport(win: BrowserWindow | null, opts: ExportRequest): Promise<ExportHandle | null> {
  const target = await pickExport(win, opts)
  return target ? openPicked(target.token) : null
}

/** Opens a file Lumen names itself (a proxy, say) for the same streamed writes — no dialog. */
export function beginFile(target: string): ExportHandle {
  ensureDir(path.dirname(target))
  const partial = `${target}.partial`
  const fd = fs.openSync(partial, 'w')
  const id = randomUUID()
  open.set(id, { kind: 'file', path: target, partial, fd, size: 0 })
  return { id, path: target }
}

function get(id: string) {
  const e = open.get(String(id))
  if (!e) throw new Error('That export is no longer open.')
  return e
}

export async function writeExport(id: string, position: number, data: Uint8Array) {
  const e = get(id)
  if (e.kind !== 'file') throw new Error('That export is an image sequence — write frames instead.')
  if (!(data instanceof Uint8Array)) throw new Error('Bad export chunk')
  const pos = Math.max(0, Math.floor(Number(position) || 0))
  await new Promise<void>((resolve, reject) => fs.write(e.fd, data, 0, data.byteLength, pos, (err) => (err ? reject(err) : resolve())))
  e.size = Math.max(e.size, pos + data.byteLength)
}

/** One numbered frame of an image sequence (`<name>_00001.png`, counting from 1). */
export async function writeFrame(id: string, index: number, data: Uint8Array) {
  const e = get(id)
  if (e.kind !== 'folder') throw new Error('That export is a single file.')
  if (!(data instanceof Uint8Array)) throw new Error('Bad frame')
  const n = Math.max(0, Math.floor(Number(index) || 0))
  const name = `${e.base}_${String(n + 1).padStart(5, '0')}.png`
  await fs.promises.writeFile(path.join(e.path, name), data)
  if (!e.written.has(name)) e.written.add(name)
  e.size += data.byteLength
}

export function finishExport(id: string) {
  const e = get(id)
  open.delete(String(id))
  if (e.kind === 'folder') {
    finished.add(path.resolve(e.path))
    return { path: e.path, size: e.size }
  }
  fs.closeSync(e.fd)
  fs.rmSync(e.path, { force: true })
  fs.renameSync(e.partial, e.path)
  finished.add(path.resolve(e.path))
  return { path: e.path, size: fs.statSync(e.path).size }
}

export function abortExport(id: string) {
  const e = open.get(String(id))
  if (!e) return
  open.delete(String(id))
  if (e.kind === 'folder') {
    // Only the frames this export wrote, then the folder if it made it and it's empty.
    for (const name of e.written) fs.rmSync(path.join(e.path, name), { force: true })
    try {
      if (e.created && !fs.readdirSync(e.path).length) fs.rmdirSync(e.path)
    } catch {
      /* already gone */
    }
    return
  }
  try {
    fs.closeSync(e.fd)
  } catch {
    /* already closed */
  }
  fs.rmSync(e.partial, { force: true })
}

export function abortAllExports() {
  for (const id of [...open.keys()]) abortExport(id)
}

/** Captions saved beside a finished export: `Video.mp4` → `Video.srt` (inside the folder for an image sequence). */
export function writeSidecar(exportPath: string, extension: string, text: string) {
  const abs = path.resolve(String(exportPath))
  if (!finished.has(abs)) throw new Error('Captions can only be saved next to a video exported in this session.')
  const ext = extension === 'vtt' ? 'vtt' : 'srt'
  const isDir = fs.existsSync(abs) && fs.statSync(abs).isDirectory()
  const target = isDir ? path.join(abs, `${path.basename(abs)}.${ext}`) : `${abs.slice(0, abs.length - path.extname(abs).length)}.${ext}`
  fs.writeFileSync(target, String(text), 'utf8')
  return target
}
