/**
 * Skills as tools: what skills there are, a skill's instructions, and the
 * files it refers to. Every brain (models, Claude Code, Codex, MCP clients)
 * gets the same skills this way.
 */
import { api } from '@/integrations/store'
import { enabledSkills, findSkill, loadSkill, refreshSkills } from '@/integrations/skills'
import { obj, str, text, type AgentTool } from './kit'

export const SKILL_TOOLS: AgentTool[] = [
  {
    name: 'list_skills',
    description: 'The skills that are switched on: know-how for particular kinds of work (motion design, grading, short-form edits…). use_skill loads one.',
    inputSchema: obj({}),
    run: async () => {
      await refreshSkills()
      return { skills: enabledSkills().map((k) => ({ name: k.name, description: k.description, source: k.source })) }
    },
  },
  {
    name: 'use_skill',
    description: 'Load a skill’s instructions before doing the work it covers, then follow them. Takes the skill’s name (from your instructions or list_skills).',
    inputSchema: obj({ name: str('The skill’s name') }, ['name']),
    run: async (a) => {
      const name = text(a, 'name') ?? ''
      let skill = findSkill(name)
      if (!skill) {
        await refreshSkills()
        skill = findSkill(name)
      }
      if (!skill) throw new Error(`There’s no skill “${name}” switched on. Skills: ${enabledSkills().map((k) => k.name).join(', ') || 'none'}.`)
      const doc = await loadSkill(skill)
      return { name: doc.name, instructions: doc.body, ...(doc.files.length ? { files: doc.files, note: 'read_skill_file reads these.' } : {}) }
    },
  },
  {
    name: 'read_skill_file',
    description: 'Read one of the files a skill refers to (a reference, template or example in its folder).',
    inputSchema: obj({ name: str('The skill’s name'), path: str('The file, relative to the skill’s folder (from use_skill’s files)') }, ['name', 'path']),
    run: async (a) => {
      const skill = findSkill(text(a, 'name') ?? '')
      if (!skill) throw new Error(`There’s no skill “${text(a, 'name')}” switched on.`)
      if (skill.source === 'builtin' || !api) throw new Error(`“${skill.name}” has no files to read.`)
      const path = text(a, 'path') ?? ''
      return { path, content: await api.skills.readFile(skill.source, skill.folder, path) }
    },
  },
]
