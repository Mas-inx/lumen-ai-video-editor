/**
 * Skills: folders of know-how the Copilot loads when a task calls for it — the
 * same SKILL.md format Claude uses. A skill is a SKILL.md with a little YAML
 * frontmatter (name, description) and markdown instructions, plus any files
 * it refers to. Only names and descriptions sit in the Copilot's instructions;
 * the body loads when the Copilot decides the skill applies (use_skill).
 */

export type SkillSource = 'builtin' | 'user' | 'claude'

export interface SkillInfo {
  /** Unique across sources: "builtin:motion-craft", "user:my-skill", "claude:pdf". */
  key: string
  source: SkillSource
  /** The folder name (user / Claude skills) or built-in id. */
  folder: string
  name: string
  description: string
  /** Other files in the skill's folder, relative paths. */
  files: string[]
}

export interface SkillDoc extends SkillInfo {
  /** The instructions: SKILL.md without its frontmatter. */
  body: string
}

/** Splits SKILL.md into its frontmatter fields and body. Tolerates missing or sloppy frontmatter. */
export function parseSkill(text: string): { name?: string; description?: string; body: string } {
  const src = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(src)
  if (!m) return { body: src.trim() }
  const fields: Record<string, string> = {}
  let key: string | null = null
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (kv) {
      key = kv[1].toLowerCase()
      fields[key] = unquote(kv[2])
    } else if (key && /^\s+\S/.test(line)) {
      // A folded continuation line.
      fields[key] = `${fields[key]} ${line.trim()}`.trim()
    }
  }
  const body = src.slice(m[0].length).trim()
  return { name: fields.name || undefined, description: fields.description?.replace(/^[>|]-?\s*/, '') || undefined, body }
}

function unquote(v: string) {
  const t = v.trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1)
  return t
}

/** A skill's description when its frontmatter has none: the first real paragraph. */
export function fallbackDescription(body: string) {
  const para = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p && !p.startsWith('#'))
  return (para ?? '').replace(/\s+/g, ' ').slice(0, 240)
}

/** SKILL.md text for a name, description and instructions. */
export function writeSkill(name: string, description: string, body: string) {
  const line = (s: string) => s.replace(/\s+/g, ' ').trim()
  return `---\nname: ${line(name)}\ndescription: ${line(description)}\n---\n\n${body.trim()}\n`
}

/** A folder name for a skill: lowercase words joined by hyphens. */
export function skillSlug(name: string) {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 64) || 'skill'
  )
}
