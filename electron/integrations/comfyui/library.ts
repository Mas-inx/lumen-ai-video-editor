import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ensureDir, userDir } from '../paths'
import type { ApiPrompt } from './workflow'

/**
 * The workflows the user keeps in Lumen: a JSON file each — the API-format
 * prompt, what it's called and where it came from — in userData/comfyui/workflows.
 */

export interface Stored {
  id: string
  name: string
  importedAt: number
  source?: string
  format: 'api' | 'png' | 'ui'
  /** Of the prompt, so the same workflow imported twice is kept once. */
  hash: string
  prompt: ApiPrompt
}

const ID = /^wf_[0-9a-f]{8}$/
const folder = () => ensureDir(path.join(userDir(), 'comfyui', 'workflows'))

function fileOf(id: string) {
  if (!ID.test(id)) throw new Error(`“${id}” isn’t a workflow id.`)
  return path.join(folder(), `${id}.json`)
}

export const cleanName = (name: string) =>
  name
    .replace(/[\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'Workflow'

const hashOf = (prompt: ApiPrompt) => createHash('sha1').update(JSON.stringify(prompt)).digest('hex')

/** Newest first. */
export function storedWorkflows(): Stored[] {
  const out: Stored[] = []
  for (const file of fs.readdirSync(folder())) {
    if (!/^wf_[0-9a-f]{8}\.json$/.test(file)) continue
    try {
      const w = JSON.parse(fs.readFileSync(path.join(folder(), file), 'utf8')) as Stored
      if (w && ID.test(w.id) && w.prompt && typeof w.prompt === 'object') out.push(w)
    } catch {
      /* a damaged file stays out of the list */
    }
  }
  return out.sort((a, b) => b.importedAt - a.importedAt)
}

export function storedWorkflow(id: string): Stored | undefined {
  if (!ID.test(id)) return undefined
  try {
    return JSON.parse(fs.readFileSync(fileOf(id), 'utf8')) as Stored
  } catch {
    return undefined
  }
}

/** Keeps a workflow — or, when the same one is already kept, answers that one. */
export function saveStored(w: { name: string; source?: string; format: Stored['format']; prompt: ApiPrompt }): Stored {
  const hash = hashOf(w.prompt)
  const same = storedWorkflows().find((x) => x.hash === hash)
  if (same) return same
  let id: string
  do id = `wf_${randomBytes(4).toString('hex')}`
  while (fs.existsSync(path.join(folder(), `${id}.json`)))
  const stored: Stored = { id, name: cleanName(w.name), importedAt: Date.now(), ...(w.source ? { source: w.source } : {}), format: w.format, hash, prompt: w.prompt }
  fs.writeFileSync(fileOf(id), JSON.stringify(stored, null, 2))
  return stored
}

export function renameStored(id: string, name: string) {
  const w = storedWorkflow(id)
  if (!w) throw new Error(`There’s no workflow “${id}” in the library.`)
  fs.writeFileSync(fileOf(id), JSON.stringify({ ...w, name: cleanName(name) }, null, 2))
}

export function removeStored(id: string) {
  fs.rmSync(fileOf(id), { force: true })
}
