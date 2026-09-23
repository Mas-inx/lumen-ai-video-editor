import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { app, BrowserWindow, dialog } from 'electron'
import type { ExportHandle } from '../shared/app'
import { ensureDir } from './integrations/paths'

/**
 * Export files: the editor encodes (WebCodecs) and streams the container bytes
 * here in positioned chunks, so multi-gigabyte renders never sit in memory.
 */

interface OpenExport {
  path: string
  partial: string
  fd: number
  size: number
}

const open = new Map<string, OpenExport>()
let lastExportDir: string | undefined

export async function beginExport(win: BrowserWindow | null, opts: { defaultName: string; extension: string; filterName: string }): Promise<ExportHandle | null> {
  const ext = String(opts.extension).replace(/[^a-z0-9]/gi, '').toLowerCase() || 'mp4'
  const base = String(opts.defaultName).replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ').trim() || 'Untitled'
  const dir = lastExportDir ?? ensureDir(app.getPath('videos'))
  let target: string
  // Automated tests export into a fixed folder instead of asking where to save.
  const testDir = process.env.LUMEN_TEST_EXPORT_DIR
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
  // Write next to the destination and move into place at the end, so a failed
  // or cancelled export never leaves a broken file where the user expects one.
  const partial = `${target}.partial`
  const fd = fs.openSync(partial, 'w')
  const id = randomUUID()
  open.set(id, { path: target, partial, fd, size: 0 })
  return { id, path: target }
}

function get(id: string) {
  const e = open.get(String(id))
  if (!e) throw new Error('That export is no longer open.')
  return e
}

export async function writeExport(id: string, position: number, data: Uint8Array) {
  const e = get(id)
  if (!(data instanceof Uint8Array)) throw new Error('Bad export chunk')
  const pos = Math.max(0, Math.floor(Number(position) || 0))
  await new Promise<void>((resolve, reject) =>
    fs.write(e.fd, data, 0, data.byteLength, pos, (err) => (err ? reject(err) : resolve())),
  )
  e.size = Math.max(e.size, pos + data.byteLength)
}

export function finishExport(id: string) {
  const e = get(id)
  fs.closeSync(e.fd)
  open.delete(String(id))
  fs.rmSync(e.path, { force: true })
  fs.renameSync(e.partial, e.path)
  return { path: e.path, size: fs.statSync(e.path).size }
}

export function abortExport(id: string) {
  const e = open.get(String(id))
  if (!e) return
  open.delete(String(id))
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
