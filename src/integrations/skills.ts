/**
 * Skills for the Copilot: built-in ones shipped in the editor (markdown files
 * next to this module), yours, and Claude Code's. Each can be switched on or
 * off; the Copilot sees the names and descriptions of the ones that are on,
 * and loads a skill's full instructions (use_skill) when a task calls for it.
 */
import { create } from 'zustand'
import { fallbackDescription, parseSkill, type SkillDoc, type SkillInfo } from '@shared/skills'
import { api } from './store'

const FILES = import.meta.glob('./skills/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

/** Skills that ship with Lumen. */
export const BUILTIN_SKILLS: SkillDoc[] = Object.entries(FILES)
  .map(([file, text]) => {
    const folder = file.split('/').pop()!.replace(/\.md$/, '')
    const parsed = parseSkill(text)
    return {
      key: `builtin:${folder}`,
      source: 'builtin' as const,
      folder,
      name: parsed.name ?? folder,
      description: parsed.description ?? fallbackDescription(parsed.body),
      files: [],
      body: parsed.body,
    }
  })
  .sort((a, b) => a.name.localeCompare(b.name))

const STORE_KEY = 'lumen.skills.v1'

interface SkillsState {
  /** Your skills and Claude Code's, as last read from disk. */
  disk: SkillInfo[]
  loaded: boolean
  /** Built-in and your skills that are switched off. */
  off: string[]
  /** Claude Code's skills that are switched on (they're off unless you turn them on: most are about other work). */
  on: string[]
}

function saved(): Pick<SkillsState, 'off' | 'on'> {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as Partial<SkillsState>
    return { off: Array.isArray(v.off) ? v.off.map(String) : [], on: Array.isArray(v.on) ? v.on.map(String) : [] }
  } catch {
    return { off: [], on: [] }
  }
}

export const useSkills = create<SkillsState>(() => ({ disk: [], loaded: false, ...saved() }))

useSkills.subscribe((s, prev) => {
  if (s.off === prev.off && s.on === prev.on) return
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ off: s.off, on: s.on }))
  } catch {
    // Storage unavailable: the choice lasts this session.
  }
})

export async function refreshSkills() {
  if (!api) return useSkills.setState({ loaded: true })
  try {
    useSkills.setState({ disk: await api.skills.list(), loaded: true })
  } catch {
    useSkills.setState({ loaded: true })
  }
}

export interface SkillEntry extends SkillInfo {
  enabled: boolean
}

/** Every skill with whether it's on, built-in first, given the store's state (pure, for rendering). */
export function skillEntries(s: Pick<SkillsState, 'disk' | 'off' | 'on'>): SkillEntry[] {
  const list: SkillInfo[] = [...BUILTIN_SKILLS.map(({ body: _body, ...rest }) => rest), ...s.disk]
  return list.map((k) => ({ ...k, enabled: k.source === 'claude' ? s.on.includes(k.key) : !s.off.includes(k.key) }))
}

export const enabledSkills = () => skillEntries(useSkills.getState()).filter((k) => k.enabled)

export function setSkillEnabled(key: string, enabled: boolean) {
  const s = useSkills.getState()
  if (key.startsWith('claude:')) useSkills.setState({ on: enabled ? [...new Set([...s.on, key])] : s.on.filter((k) => k !== key) })
  else useSkills.setState({ off: enabled ? s.off.filter((k) => k !== key) : [...new Set([...s.off, key])] })
}

/** Finds a skill by name, folder or key (case-insensitive), among those switched on. */
export function findSkill(query: string): SkillEntry | undefined {
  const q = query.trim().toLowerCase()
  const list = enabledSkills()
  return list.find((k) => k.key.toLowerCase() === q) ?? list.find((k) => k.name.toLowerCase() === q) ?? list.find((k) => k.folder.toLowerCase() === q)
}

/** A skill's full instructions. */
export async function loadSkill(skill: SkillInfo): Promise<SkillDoc> {
  if (skill.source === 'builtin') {
    const doc = BUILTIN_SKILLS.find((k) => k.key === skill.key)
    if (!doc) throw new Error(`There’s no built-in skill “${skill.name}”.`)
    return doc
  }
  if (!api) throw new Error('Skills from disk need Lumen’s desktop app.')
  return api.skills.read(skill.source, skill.folder)
}

/**
 * The tools each built-in skill is for. Their descriptions point at the skill
 * (when it's on), so every agent applies it — the Copilot, Claude Code and
 * Codex inside Lumen, and any client using Lumen's MCP server.
 */
const SKILL_TOOLS: Record<string, string[]> = {
  'motion-design-craft': ['render_motion_graphic', 'render_hyperframes_html', 'add_title', 'render_3d_title'],
  'hyperframes-compositions': ['render_hyperframes_html'],
  // Its "textured" half is loaded from it, so the tool points at one styles skill, not two.
  'motion-graphic-styles': ['render_hyperframes_html'],
  'blender-3d': ['render_3d_title', 'render_3d_background', 'render_blender_script', 'blender_live'],
  'generation-prompts': ['generate_image', 'generate_video', 'render_3d_background'],
  'sound-and-music': ['generate_music', 'generate_sound_effect', 'generate_voiceover', 'add_sound_effect', 'duck_music'],
  'short-form-editing': ['reframe', 'add_captions', 'remove_pauses', 'cut_to_beats'],
  'color-grading': ['lut_add'],
  'text-behind-subject': ['cut_out_subject'],
}

/** A tool's description, with the skills that apply to it (and, for use_skill, every skill that's on). */
export function describeTool(name: string, description: string) {
  const on = enabledSkills()
  if (name === 'use_skill') {
    if (!on.length) return `${description}\n\nNo skills are switched on right now.`
    return `${description}\n\nSkills switched on:\n${on.map((k) => `- ${k.name}: ${k.description}`).join('\n')}`
  }
  const names = on.filter((k) => k.source === 'builtin' && SKILL_TOOLS[k.folder]?.includes(name)).map((k) => k.name)
  if (!names.length) return description
  return `${description}\n\nFirst load ${names.length > 1 ? 'these skills' : 'this skill'} and follow ${names.length > 1 ? 'them' : 'it'}: ${names.map((n) => `use_skill("${n}")`).join(', ')}.`
}

/** What the Copilot is told about its skills (names and when to use them), or nothing when none are on. */
export function skillsPrompt(): string {
  const list = enabledSkills()
  if (!list.length) return ''
  return [
    'Skills — instructions for doing particular kinds of work really well. When a request involves one, call use_skill with its name before you start, and follow it:',
    ...list.map((k) => `- ${k.name}: ${k.description}`),
  ].join('\n')
}

if (api) void refreshSkills()
