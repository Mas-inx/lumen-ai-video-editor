import fs from 'node:fs'
import path from 'node:path'
import { BrowserWindow, dialog } from 'electron'
import { APP_IPC, type CollectResult } from '../shared/app'
import { mediaPath } from './integrations/paths'

/**
 * Collect project: copies the project and every media file it uses into one
 * folder (media under Media/), with the paths rewritten, so it can be archived
 * or taken to another computer whole. Proxies stay behind — they're remade.
 */

interface Source {
  type: string
  url?: string
  path?: string
  dir?: string
  base?: string
  fileName?: string
  [key: string]: unknown
}

interface StoredAsset {
  name?: string
  source?: Source
  proxy?: unknown
  [key: string]: unknown
}

const safeName = (s: string) => s.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ').trim() || 'Untitled'

function freePath(p: string) {
  if (!fs.existsSync(p)) return p
  const ext = path.extname(p)
  const base = p.slice(0, p.length - ext.length)
  for (let i = 2; ; i++) {
    const next = `${base} (${i})${ext}`
    if (!fs.existsSync(next)) return next
  }
}

function sizeOf(p: string): number {
  try {
    const st = fs.statSync(p)
    if (st.isFile()) return st.size
    return fs.readdirSync(p).reduce((sum, f) => sum + sizeOf(path.join(p, f)), 0)
  } catch {
    return 0
  }
}

/** Asks where, then copies. `save` writes the rewritten project to its new file. Null if cancelled. */
export async function collectProject(win: BrowserWindow | null, projectText: string, name: string, save: (file: string, text: string) => void): Promise<CollectResult | null> {
  // Automated tests collect into a fixed folder instead of asking.
  let parent = process.env.LUMEN_TEST_EXPORT_DIR
  if (!parent) {
    const opts: Electron.OpenDialogOptions = { title: 'Collect project — choose where', buttonLabel: 'Collect here', properties: ['openDirectory', 'createDirectory'] }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || !res.filePaths[0]) return null
    parent = res.filePaths[0]
  }
  const dest = freePath(path.join(parent, safeName(name)))
  const mediaDir = path.join(dest, 'Media')
  fs.mkdirSync(mediaDir, { recursive: true })

  const project = JSON.parse(projectText) as { assets?: Record<string, StoredAsset> }
  const jobs: { asset: StoredAsset; from: string; kind: 'file' | 'dir' }[] = []
  const missing: string[] = []
  for (const asset of Object.values(project.assets ?? {})) {
    delete asset.proxy
    const src = asset.source
    if (!src) continue
    const from = src.type === 'file' ? (src.path ?? (src.url ? mediaPath(src.url) : null)) : src.type === 'sequence' ? (src.dir ?? null) : null
    if (!from || !fs.existsSync(from)) {
      missing.push(asset.name ?? path.basename(from ?? 'media'))
      continue
    }
    jobs.push({ asset, from, kind: src.type === 'file' ? 'file' : 'dir' })
  }

  const total = jobs.reduce((sum, j) => sum + sizeOf(j.from), 0)
  let done = 0
  const report = (file: string) => win?.webContents.send(APP_IPC.collectProgress, { done, total, file })
  // Files shared by several assets are copied once.
  const copied = new Map<string, string>()
  for (const job of jobs) {
    const key = path.resolve(job.from).toLowerCase()
    let to = copied.get(key)
    if (!to) {
      to = freePath(path.join(mediaDir, path.basename(job.from)))
      report(path.basename(job.from))
      if (job.kind === 'file') await fs.promises.copyFile(job.from, to)
      else await fs.promises.cp(job.from, to, { recursive: true })
      copied.set(key, to)
      done += sizeOf(job.from)
    }
    const src = job.asset.source!
    if (job.kind === 'file') {
      src.path = to
      delete src.url
    } else {
      // The old base stays until saving, where it turns the poster into a file name in the new folder.
      src.dir = to
    }
  }
  report('')
  const file = path.join(dest, `${safeName(name)}.lumen`)
  save(file, JSON.stringify(project))
  return { path: file, folder: dest, files: copied.size, bytes: done, missing }
}
