/**
 * docs/AI-TOOLS.md is generated from the tool registry. This test keeps the
 * page and the registry in step: it fails when a tool was added, removed or
 * changed without the page. To rewrite the page:
 *
 *   LUMEN_WRITE_DOCS=1 npx vitest run src/integrations/tools/docs.test.ts
 *
 * Sections, their introductions and the page's header are kept from the page;
 * a new tool goes in the section `SECTION_OF` names (editor commands always go
 * in "Editor commands").
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/engine/stills', () => ({ timelineStills: async () => [], mediaStills: async () => [], contactSheet: () => ({}), canvasBase64: () => '' }))

const { agentTools } = await import('../agent-tools')
const { toolDefinitions } = await import('@/editor/commands')

const PAGE = fileURLToPath(new URL('../../../docs/AI-TOOLS.md', import.meta.url))
const COMMANDS_SECTION = 'Editor commands'

/** Where tools that the page doesn't list yet belong (by name, or by a name's start). */
const SECTION_OF: [RegExp, string][] = [
  [/^(auto_color|match_color|relight_clip)$/, 'Smart edits'],
  [/^(smart_transition|auto_transitions)$/, 'Smart edits'],
  [/^(find_repeated_takes|remove_speech|check_quality)$/, 'Smart edits'],
  [/^(get_storyboard|list_styles|apply_style|suggest_broll|get_brand_kit|apply_brand_kit)$/, 'Plan and style'],
  [/^comfyui_/, 'Generate and import'],
]

type Schema = {
  type?: string | string[]
  enum?: unknown[]
  items?: Schema
  anyOf?: Schema[]
  oneOf?: Schema[]
  const?: unknown
  description?: string
  default?: unknown
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number
  exclusiveMaximum?: number
  properties?: Record<string, Schema>
  required?: string[]
}

function typeOf(s: Schema | undefined): string {
  if (!s) return 'any'
  if (s.enum) return s.enum.map((v) => `\`${String(v)}\``).join(' · ')
  if (s.const !== undefined) return `\`${String(s.const)}\``
  const union = s.anyOf ?? s.oneOf
  if (union) return union.map(typeOf).join(' or ')
  if (s.type === 'array') return `${typeOf(s.items)}[]`
  if (Array.isArray(s.type)) return s.type.join(' | ')
  return s.type ?? 'any'
}

const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim()

/**
 * A parameter's description; for editor commands (whose schemas come from Zod), also its limits and
 * default, which their descriptions don't repeat. Integers' "safe" bounds aren't limits worth a word.
 */
function about(p: Schema, command: boolean) {
  if (!command) return p.description ?? ''
  const real = (v: number | undefined) => v !== undefined && Math.abs(v) < Number.MAX_SAFE_INTEGER
  const limits = [
    real(p.minimum) && `≥ ${p.minimum}`,
    real(p.exclusiveMinimum) && `> ${p.exclusiveMinimum}`,
    real(p.maximum) && `≤ ${p.maximum}`,
    real(p.exclusiveMaximum) && `< ${p.exclusiveMaximum}`,
  ].filter(Boolean)
  return [p.description, limits.length ? `(${limits.join(', ')})` : '', p.default !== undefined ? `Default \`${JSON.stringify(p.default)}\`.` : ''].filter(Boolean).join(' ')
}

function entry(tool: { name: string; description: string; inputSchema: unknown }, command: boolean) {
  const schema = tool.inputSchema as Schema
  const props = Object.entries(schema?.properties ?? {})
  const required = new Set(schema?.required ?? [])
  const lines = [`### \`${tool.name}\``, '', tool.description.trim(), '']
  if (!props.length) lines.push('_No parameters._', '')
  else {
    lines.push('| Parameter | Type | Description |', '| --- | --- | --- |')
    for (const [key, p] of props) lines.push(`| \`${key}\`${required.has(key) ? ' **(required)**' : ''} | ${cell(typeOf(p))} | ${cell(about(p, command))} |`)
    lines.push('')
  }
  return lines.join('\n')
}

interface Section {
  title: string
  intro: string
  tools: string[]
}

/** The page as it stands: its header and footer, and each section's title, introduction and tools in order. */
function readPage(page: string) {
  const footerAt = page.lastIndexOf('\n---\n')
  const footer = footerAt >= 0 ? page.slice(footerAt + 1).trim() : ''
  const text = footerAt >= 0 ? page.slice(0, footerAt) : page
  const [head, ...rest] = text.split(/\n## /)
  const header = head.replace(/\n## Contents[\s\S]*$/, '')
  const sections: Section[] = []
  for (const chunk of rest) {
    const title = chunk.slice(0, chunk.indexOf('\n')).trim()
    if (title === 'Contents') continue
    const body = chunk.slice(chunk.indexOf('\n') + 1)
    const intro = body.split(/\n### /)[0].trim()
    const tools = [...body.matchAll(/^### `([^`]+)`/gm)].map((m) => m[1])
    sections.push({ title, intro, tools })
  }
  return { header, footer, sections }
}

function generate(current: string) {
  const { header, footer, sections } = readPage(current)
  const tools = agentTools({})
  const commandNames = new Set(toolDefinitions().map((d) => d.name))
  const byName = new Map(tools.map((t) => [t.name, t]))
  const placed = new Set<string>()
  const out = sections.map((s) => ({ ...s, tools: s.tools.filter((n) => byName.has(n)) }))
  for (const s of out) s.tools.forEach((n) => placed.add(n))
  const sectionNamed = (title: string) => out.find((s) => s.title === title)!
  for (const t of tools) {
    if (placed.has(t.name)) continue
    const title = commandNames.has(t.name) ? COMMANDS_SECTION : (SECTION_OF.find(([re]) => re.test(t.name))?.[1] ?? 'Act')
    sectionNamed(title).tools.push(t.name)
    placed.add(t.name)
  }
  // Commands keep the registry's order, so related ones stay together.
  const commands = sectionNamed(COMMANDS_SECTION)
  commands.tools = tools.filter((t) => commandNames.has(t.name)).map((t) => t.name)
  const total = out.reduce((n, s) => n + s.tools.length, 0)
  const anchor = (title: string) => title.toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-')
  const parts = [
    header.replace(/\*\*\d+ tools\*\*/, `**${total} tools**`).trimEnd(),
    '',
    '## Contents',
    '',
    ...out.map((s) => `- [${s.title}](#${anchor(s.title)}) — ${s.tools.length} tools`),
    '',
  ]
  for (const s of out) parts.push(`## ${s.title}`, '', s.intro, '', ...s.tools.map((n) => entry(byName.get(n)!, commandNames.has(n))))
  if (footer) parts.push(footer)
  return { text: `${parts.join('\n').trimEnd()}\n`, total }
}

describe('docs/AI-TOOLS.md', () => {
  it('lists every tool in the registry, as the registry describes it', () => {
    const current = readFileSync(PAGE, 'utf8').replace(/\r\n/g, '\n')
    const { text, total } = generate(current)
    if (process.env.LUMEN_WRITE_DOCS) writeFileSync(PAGE, text)
    else expect(text, 'docs/AI-TOOLS.md is out of date: run LUMEN_WRITE_DOCS=1 npx vitest run src/integrations/tools/docs.test.ts').toBe(current)
    expect(total).toBe(agentTools({}).length)
  })
})
