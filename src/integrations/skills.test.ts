import { beforeEach, describe, expect, it } from 'vitest'
import { BUILTIN_SKILLS, describeTool, findSkill, setSkillEnabled, skillsPrompt, useSkills } from './skills'

describe('skills', () => {
  beforeEach(() => useSkills.setState({ disk: [], off: [], on: [], loaded: true }))

  it('ships the built-in craft skills, each with a description', () => {
    const names = BUILTIN_SKILLS.map((k) => k.name)
    for (const n of ['motion-design-craft', 'hyperframes-compositions', 'blender-3d', 'color-grading', 'short-form-editing', 'sound-and-music', 'generation-prompts', 'text-behind-subject']) expect(names).toContain(n)
    for (const k of BUILTIN_SKILLS) {
      expect(k.description.length).toBeGreaterThan(40)
      expect(k.body.length).toBeGreaterThan(200)
    }
  })

  it('lists the skills that are on in the instructions and in use_skill', () => {
    expect(skillsPrompt()).toContain('- motion-design-craft:')
    expect(describeTool('use_skill', 'Load a skill.')).toContain('- blender-3d:')
    setSkillEnabled('builtin:blender-3d', false)
    expect(skillsPrompt()).not.toContain('blender-3d')
    expect(findSkill('blender-3d')).toBeUndefined()
    expect(findSkill('MOTION-DESIGN-CRAFT')?.name).toBe('motion-design-craft')
  })

  it('points tools at the skills that apply to them, while those are on', () => {
    expect(describeTool('render_3d_title', 'Render a 3D title.')).toContain('use_skill("blender-3d")')
    expect(describeTool('render_3d_title', 'Render a 3D title.')).toContain('use_skill("motion-design-craft")')
    expect(describeTool('render_hyperframes_html', 'Render HTML.')).toContain('use_skill("hyperframes-compositions")')
    setSkillEnabled('builtin:blender-3d', false)
    expect(describeTool('render_3d_title', 'Render a 3D title.')).not.toContain('blender-3d')
    expect(describeTool('get_project', 'Read the project.')).toBe('Read the project.')
  })

  it('keeps Claude Code’s skills off until switched on', () => {
    useSkills.setState({ disk: [{ key: 'claude:pdf', source: 'claude', folder: 'pdf', name: 'pdf', description: 'Work with PDFs.', files: [] }] })
    expect(findSkill('pdf')).toBeUndefined()
    setSkillEnabled('claude:pdf', true)
    expect(findSkill('pdf')?.source).toBe('claude')
  })
})
