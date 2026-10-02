import { describe, expect, it } from 'vitest'
import { fallbackDescription, parseSkill, skillSlug, writeSkill } from './skills'

describe('SKILL.md', () => {
  it('reads the name, description and body', () => {
    const s = parseSkill('---\nname: brand-titles\ndescription: Use when adding titles for Acme.\n---\n\n# Titles\n\nUse Fraunces.\n')
    expect(s).toEqual({ name: 'brand-titles', description: 'Use when adding titles for Acme.', body: '# Titles\n\nUse Fraunces.' })
  })

  it('tolerates quotes, CRLF, a BOM, folded lines and no frontmatter', () => {
    const s = parseSkill('﻿---\r\nname: "Quoted Name"\r\ndescription: >\r\n  Folded across\r\n  two lines\r\n---\r\nBody\r\n')
    expect(s.name).toBe('Quoted Name')
    expect(s.description).toBe('Folded across two lines')
    expect(s.body).toBe('Body')
    expect(parseSkill('Just text').body).toBe('Just text')
  })

  it('writes what it reads', () => {
    const text = writeSkill('my skill', 'Use for tests\nand more', 'Do the thing.')
    expect(parseSkill(text)).toEqual({ name: 'my skill', description: 'Use for tests and more', body: 'Do the thing.' })
  })

  it('makes folder names and fallback descriptions', () => {
    expect(skillSlug('Brand Titles — Acme!')).toBe('brand-titles-acme')
    expect(skillSlug('***')).toBe('skill')
    expect(fallbackDescription('# Heading\n\nFirst   real\nparagraph.\n\nSecond.')).toBe('First real paragraph.')
  })
})
