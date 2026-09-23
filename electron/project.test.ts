import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({ root: '' }))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => path.join(env.root, name),
    getVersion: () => '1.0.0',
    addRecentDocument: () => {},
  },
  dialog: {},
  BrowserWindow: class {},
  net: {},
  protocol: {},
  shell: {},
}))

env.root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-project-test-'))
const { forgetRecent, openProject, projectFromArgv, readRecovery, recentProjects, saveProject, writeRecovery } = await import('./project')
const { fileUrl } = await import('./integrations/paths')

afterAll(() => fs.rmSync(env.root, { recursive: true, force: true }))

let n = 0
/** A project folder with one media file, and the editor's JSON for a project that uses it. */
function scene() {
  const dir = path.join(env.root, `work-${++n}`, 'Show')
  const media = path.join(dir, 'media', 'voice.wav')
  fs.mkdirSync(path.dirname(media), { recursive: true })
  fs.writeFileSync(media, 'RIFF....WAVE')
  const project = {
    name: 'Show',
    settings: { width: 1920, height: 1080, fps: 30, background: '#000000' },
    tracks: [],
    clips: {},
    markers: [],
    assets: {
      a1: {
        id: 'a1',
        name: 'voice',
        kind: 'audio',
        source: { type: 'file', url: fileUrl(media), path: media, mime: 'audio/wav', fileName: 'voice.wav', size: 12 },
        addedAt: 0,
      },
    },
  }
  return { dir, media, file: path.join(dir, 'Show.lumen'), text: JSON.stringify(project) }
}

type Stored = { format: string; version: number; project: { assets: Record<string, { source: Record<string, unknown> }> } }

beforeEach(() => fs.rmSync(path.join(env.root, 'userData', 'recent-projects.json'), { force: true }))

describe('saving', () => {
  it('stores media by absolute and project-relative path, without runtime URLs', () => {
    const s = scene()
    expect(saveProject(s.file, s.text)).toEqual({ path: s.file })
    const stored = JSON.parse(fs.readFileSync(s.file, 'utf8')) as Stored
    expect(stored).toMatchObject({ format: 'lumen-project', version: 1 })
    const src = stored.project.assets.a1.source
    expect(src.path).toBe(s.media)
    expect(src.relPath).toBe('media/voice.wav')
    expect(src.url).toBeUndefined()
    expect(fs.readdirSync(s.dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })
})

describe('opening', () => {
  it('restores media URLs', async () => {
    const s = scene()
    saveProject(s.file, s.text)
    const opened = (await openProject(null, s.file))!
    expect(opened.missing).toEqual([])
    const src = JSON.parse(opened.text).assets.a1.source
    expect(src.path).toBe(s.media)
    expect(src.url).toBe(fileUrl(s.media))
    expect(src.missing).toBeUndefined()
  })

  it('finds media next to a project folder that was moved', async () => {
    const s = scene()
    saveProject(s.file, s.text)
    const moved = path.join(path.dirname(s.dir), 'Show (copy on another drive)')
    fs.renameSync(s.dir, moved)
    const opened = (await openProject(null, path.join(moved, 'Show.lumen')))!
    expect(opened.missing).toEqual([])
    const src = JSON.parse(opened.text).assets.a1.source
    expect(src.path).toBe(path.join(moved, 'media', 'voice.wav'))
  })

  it('flags media that can’t be found instead of failing', async () => {
    const s = scene()
    saveProject(s.file, s.text)
    fs.rmSync(s.media)
    const opened = (await openProject(null, s.file))!
    expect(opened.missing).toEqual(['a1'])
    expect(JSON.parse(opened.text).assets.a1.source.missing).toBe(true)
  })

  it('rejects files that aren’t Lumen projects, or are from a newer Lumen', async () => {
    const s = scene()
    fs.writeFileSync(s.file, 'not json')
    await expect(openProject(null, s.file)).rejects.toThrow(/isn’t a Lumen project/)
    fs.writeFileSync(s.file, JSON.stringify({ format: 'something-else', project: {} }))
    await expect(openProject(null, s.file)).rejects.toThrow(/isn’t a Lumen project/)
    fs.writeFileSync(s.file, JSON.stringify({ format: 'lumen-project', version: 99, project: {} }))
    await expect(openProject(null, s.file)).rejects.toThrow(/newer version/)
    await expect(openProject(null, path.join(s.dir, 'gone.lumen'))).rejects.toThrow(/can’t be found/)
  })
})

describe('recent projects', () => {
  it('lists opened projects newest first, and forgets them on request', async () => {
    const a = scene()
    const b = scene()
    saveProject(a.file, a.text)
    saveProject(b.file, b.text)
    await openProject(null, a.file)
    expect(recentProjects().map((r) => r.path)).toEqual([a.file, b.file])
    fs.rmSync(b.file)
    expect(recentProjects().map((r) => r.exists)).toEqual([true, false])
    expect(forgetRecent(b.file).map((r) => r.path)).toEqual([a.file])
  })
})

describe('crash recovery', () => {
  it('keeps the last snapshot until it is cleared', () => {
    const s = scene()
    writeRecovery({ text: s.text, path: null, name: 'Show' })
    const info = readRecovery()!
    expect(info.name).toBe('Show')
    expect(JSON.parse(info.text).assets.a1.source.url).toBe(fileUrl(s.media))
    writeRecovery(null)
    expect(readRecovery()).toBeNull()
  })
})

describe('projectFromArgv', () => {
  it('picks the project a double-click launched with', () => {
    const s = scene()
    saveProject(s.file, s.text)
    expect(projectFromArgv(['Lumen.exe', '--flag', s.file])).toBe(s.file)
    expect(projectFromArgv(['Lumen.exe', path.join(s.dir, 'missing.lumen')])).toBeNull()
    expect(projectFromArgv(['Lumen.exe'])).toBeNull()
  })
})
