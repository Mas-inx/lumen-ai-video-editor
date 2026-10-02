import fs from 'node:fs'
import path from 'node:path'
import type { RenderCacheUsage, RenderFile } from '../shared/app'
import { ensureDir, mediaRoot, mediaUrl } from './integrations/paths'

/**
 * Render previews on disk: media/render-cache/<project id>/<chunk key>.mp4.
 * The editor names each file after a hash of what it shows, so a file is never
 * stale, only unused; the cache keeps itself under a size cap by deleting the
 * files used least recently (opening a project counts as using its renders).
 */

const CAP_BYTES = 8 * 1024 ** 3
const root = () => path.join(mediaRoot(), 'render-cache')
const safe = (s: string) => s.replace(/[^\w-]/g, '').slice(0, 120)

function projectDir(projectId: string) {
  const id = safe(projectId)
  if (!id) throw new Error('Bad project id')
  return path.join(root(), id)
}

/** Stores one rendered chunk and returns the URL the editor plays it from. */
export function writeRender(projectId: string, key: string, data: Uint8Array): string {
  const name = safe(key)
  if (!name) throw new Error('Bad render name')
  if (!(data instanceof Uint8Array) || !data.byteLength) throw new Error('Expected the rendered file')
  const abs = path.join(ensureDir(projectDir(projectId)), `${name}.mp4`)
  const partial = `${abs}.${process.pid}.part`
  fs.writeFileSync(partial, data)
  fs.renameSync(partial, abs)
  scheduleTrim()
  return mediaUrl(abs)
}

/** A project's rendered chunks. Listing them marks them used, so the project's renders outlive older ones. */
export function listRenders(projectId: string): RenderFile[] {
  const dir = projectDir(projectId)
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const now = new Date()
  const out: RenderFile[] = []
  for (const n of names) {
    if (!n.endsWith('.mp4')) continue
    const abs = path.join(dir, n)
    try {
      fs.utimesSync(abs, now, now)
      out.push({ key: n.slice(0, -4), url: mediaUrl(abs) })
    } catch {
      // Gone meanwhile.
    }
  }
  return out
}

/** Deletes some of a project's renders, or all of them (`keys` null). */
export function removeRenders(projectId: string, keys: string[] | null) {
  const dir = projectDir(projectId)
  if (keys === null) {
    fs.rmSync(dir, { recursive: true, force: true })
    return
  }
  for (const k of keys) {
    const name = safe(k)
    if (name) fs.rmSync(path.join(dir, `${name}.mp4`), { force: true })
  }
}

interface Entry {
  abs: string
  size: number
  time: number
}

function entries(): Entry[] {
  const out: Entry[] = []
  let projects: string[]
  try {
    projects = fs.readdirSync(root())
  } catch {
    return out
  }
  for (const p of projects) {
    const dir = path.join(root(), p)
    let names: string[]
    try {
      names = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const n of names) {
      const abs = path.join(dir, n)
      try {
        const st = fs.statSync(abs)
        if (st.isFile()) out.push({ abs, size: st.size, time: st.mtimeMs })
      } catch {
        // Gone meanwhile.
      }
    }
  }
  return out
}

export function renderUsage(): RenderCacheUsage {
  const all = entries()
  return { bytes: all.reduce((n, e) => n + e.size, 0), files: all.length, cap: CAP_BYTES }
}

/** Deletes the least recently used renders until the cache is comfortably under its cap. */
export function trimRenders(cap = CAP_BYTES) {
  const all = entries()
  let total = all.reduce((n, e) => n + e.size, 0)
  if (total <= cap) return
  all.sort((a, b) => a.time - b.time)
  for (const e of all) {
    if (total <= cap * 0.9) break
    try {
      fs.rmSync(e.abs, { force: true })
      total -= e.size
    } catch {
      // In use or gone; try the next one.
    }
  }
}

let trimTimer: ReturnType<typeof setTimeout> | undefined
function scheduleTrim() {
  if (trimTimer) return
  trimTimer = setTimeout(() => {
    trimTimer = undefined
    trimRenders()
  }, 5000)
}
