import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dialog, shell, type BrowserWindow } from 'electron'
import { fallbackDescription, parseSkill, skillSlug, writeSkill, type SkillDoc, type SkillInfo, type SkillSource } from '../../shared/skills'
import { ensureDir, userDir } from './paths'

/**
 * Skills on disk: yours in userData/skills (created, imported or edited in
 * Lumen) and Claude Code's in ~/.claude/skills (read only — the same format,
 * so skills you already have work in Lumen too). Built-in skills ship inside
 * the editor itself.
 */

const userRoot = () => ensureDir(path.join(userDir(), 'skills'))
const claudeRoot = () => path.join(os.homedir(), '.claude', 'skills')
const rootOf = (source: SkillSource) => (source === 'claude' ? claudeRoot() : userRoot())

const TEXT_FILE = /\.(md|txt|json|ya?ml|csv|tsv|html?|css|js|mjs|ts|py|xml|svg|cube)$/i
const MAX_FILE = 256 * 1024
const MAX_IMPORT = 32 * 1024 * 1024

/** A folder inside a source's root (no escaping it with ../). */
function skillDir(source: SkillSource, folder: string) {
  const root = rootOf(source)
  const dir = path.resolve(root, folder)
  if (!dir.startsWith(path.resolve(root) + path.sep)) throw new Error('That skill is outside the skills folder.')
  return dir
}

function filesIn(dir: string, base = dir, out: string[] = []) {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (out.length >= 60 || e.name.startsWith('.') || e.name === 'node_modules') continue
    const abs = path.join(dir, e.name)
    if (e.isDirectory()) filesIn(abs, base, out)
    else if (e.name !== 'SKILL.md') out.push(path.relative(base, abs).split(path.sep).join('/'))
  }
  return out
}

function info(source: SkillSource, folder: string): SkillDoc | null {
  const dir = path.join(rootOf(source), folder)
  let text: string
  try {
    text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')
  } catch {
    return null
  }
  const parsed = parseSkill(text)
  return {
    key: `${source}:${folder}`,
    source,
    folder,
    name: parsed.name ?? folder,
    description: parsed.description ?? fallbackDescription(parsed.body),
    files: filesIn(dir),
    body: parsed.body,
  }
}

function listFrom(source: SkillSource): SkillInfo[] {
  let names: string[]
  try {
    names = fs.readdirSync(rootOf(source))
  } catch {
    return []
  }
  return names
    .map((n) => info(source, n))
    .filter((s): s is SkillDoc => s !== null)
    .map(({ body: _body, ...rest }) => rest)
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function listSkills(): SkillInfo[] {
  return [...listFrom('user'), ...listFrom('claude')]
}

export function readSkill(source: SkillSource, folder: string): SkillDoc {
  if (source === 'builtin') throw new Error('Built-in skills live in the editor.')
  skillDir(source, folder)
  const doc = info(source, folder)
  if (!doc) throw new Error(`There’s no skill “${folder}”.`)
  return doc
}

/** A file a skill refers to (text files only, up to 256 KB). */
export function readSkillFile(source: SkillSource, folder: string, rel: string): string {
  if (source === 'builtin') throw new Error('Built-in skills have no extra files.')
  const dir = skillDir(source, folder)
  const abs = path.resolve(dir, rel)
  if (!abs.startsWith(dir + path.sep)) throw new Error('That file is outside the skill.')
  if (!TEXT_FILE.test(abs)) throw new Error('Only text files can be read.')
  const stat = fs.statSync(abs)
  if (stat.size > MAX_FILE) throw new Error('That file is too large to read here.')
  return fs.readFileSync(abs, 'utf8')
}

/** Creates or updates one of your skills; renaming moves its folder. */
export function saveSkill(input: { folder?: string; name: string; description: string; body: string }): SkillInfo {
  const name = input.name.trim()
  if (!name) throw new Error('Give the skill a name.')
  if (!input.description.trim()) throw new Error('Describe when the skill should be used — that’s how the Copilot finds it.')
  const slug = skillSlug(name)
  const root = userRoot()
  let dir = path.join(root, slug)
  if (input.folder && input.folder !== slug) {
    const old = skillDir('user', input.folder)
    if (fs.existsSync(dir)) throw new Error(`You already have a skill called “${name}”.`)
    if (fs.existsSync(old)) fs.renameSync(old, dir)
  } else if (!input.folder && fs.existsSync(dir)) {
    throw new Error(`You already have a skill called “${name}”.`)
  }
  dir = ensureDir(dir)
  fs.writeFileSync(path.join(dir, 'SKILL.md'), writeSkill(name, input.description, input.body))
  const { body: _body, ...rest } = info('user', slug)!
  return rest
}

export function deleteSkill(folder: string) {
  fs.rmSync(skillDir('user', folder), { recursive: true, force: true })
}

function sizeOf(dir: string): number {
  let total = 0
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name)
    total += e.isDirectory() ? sizeOf(abs) : fs.statSync(abs).size
    if (total > MAX_IMPORT) return total
  }
  return total
}

/** Copies a skill folder (one with a SKILL.md) into your skills. */
export async function importSkill(win: BrowserWindow | null): Promise<SkillInfo | null> {
  const opts: Electron.OpenDialogOptions = { title: 'Import a skill folder', buttonLabel: 'Import', properties: ['openDirectory'] }
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  const src = res.filePaths[0]
  if (res.canceled || !src) return null
  if (!fs.existsSync(path.join(src, 'SKILL.md'))) throw new Error('That folder has no SKILL.md, so it isn’t a skill.')
  if (sizeOf(src) > MAX_IMPORT) throw new Error('That skill folder is over 32 MB — too large to import.')
  const parsed = parseSkill(fs.readFileSync(path.join(src, 'SKILL.md'), 'utf8'))
  let slug = skillSlug(parsed.name ?? path.basename(src))
  for (let n = 2; fs.existsSync(path.join(userRoot(), slug)); n++) slug = `${skillSlug(parsed.name ?? path.basename(src))}-${n}`
  fs.cpSync(src, path.join(userRoot(), slug), { recursive: true, filter: (p) => !path.basename(p).startsWith('.') && !p.includes(`${path.sep}node_modules`) })
  const { body: _body, ...rest } = info('user', slug)!
  return rest
}

export async function openSkillsFolder() {
  await shell.openPath(userRoot())
}
