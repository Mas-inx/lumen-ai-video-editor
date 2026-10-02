import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({ root: '', dialogPath: '' }))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => path.join(env.root, name),
    getVersion: () => '1.0.0',
    addRecentDocument: () => {},
  },
  dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [env.dialogPath] }) },
  BrowserWindow: class {},
  net: {},
  protocol: {},
  shell: {},
}))

env.root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-versions-test-'))
const { openProject, openVersion, saveProject, snapshotVersion } = await import('./project')
const { listVersions } = await import('./versions')
const { collectProject } = await import('./collect')
const { fileUrl } = await import('./integrations/paths')

afterAll(() => fs.rmSync(env.root, { recursive: true, force: true }))

let n = 0
function scene(id: string) {
  const dir = path.join(env.root, `work-${++n}`)
  const media = path.join(dir, 'footage', 'shot.mp4')
  fs.mkdirSync(path.dirname(media), { recursive: true })
  fs.writeFileSync(media, 'not really a video, but bytes')
  const project = (name: string, clips = 0) => ({
    id,
    name,
    settings: { width: 1920, height: 1080, fps: 30, background: '#000000' },
    tracks: [],
    clips: Object.fromEntries(Array.from({ length: clips }, (_, i) => [`c${i}`, { id: `c${i}`, start: i * 30, duration: 30 }])),
    markers: [],
    assets: { a1: { id: 'a1', name: 'Shot', kind: 'video', source: { type: 'file', url: fileUrl(media), path: media, fileName: 'shot.mp4', mime: 'video/mp4', size: 29 }, addedAt: 0 } },
    createdAt: 0,
  })
  return { dir, media, project, file: path.join(dir, 'Show.lumen') }
}

describe('version history', () => {
  it('stores a version on every save and a snapshot only when something changed', () => {
    const s = scene('p-versions')
    saveProject(s.file, JSON.stringify(s.project('Show', 1)))
    saveProject(s.file, JSON.stringify(s.project('Show', 3)))
    snapshotVersion({ text: JSON.stringify(s.project('Show', 3)), path: s.file, kind: 'auto' })
    snapshotVersion({ text: JSON.stringify(s.project('Show', 4)), path: s.file, kind: 'auto' })
    const list = listVersions('p-versions')
    expect(list.map((v) => v.kind)).toEqual(['auto', 'save', 'save'])
    expect(list[0]).toMatchObject({ name: 'Show', clips: 4, seconds: 4 })
    expect(list[2].clips).toBe(1)
  })

  it('reads a version back with its media resolved', () => {
    const s = scene('p-read')
    saveProject(s.file, JSON.stringify(s.project('Old cut', 2)))
    saveProject(s.file, JSON.stringify(s.project('New cut', 5)))
    const old = listVersions('p-read').find((v) => v.clips === 2)!
    const opened = openVersion('p-read', old.id, s.file)
    const project = JSON.parse(opened.text)
    expect(project.name).toBe('Old cut')
    expect(project.assets.a1.source.path).toBe(s.media)
    expect(opened.missing).toEqual([])
  })

  it('keeps versions saved in the same millisecond apart', () => {
    const s = scene('p-same-ms')
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 9, 3, 12))
    try {
      saveProject(s.file, JSON.stringify(s.project('First', 1)))
      saveProject(s.file, JSON.stringify(s.project('Second', 2)))
    } finally {
      now.mockRestore()
    }
    const list = listVersions('p-same-ms')
    expect(new Set(list.map((v) => v.id)).size).toBe(2)
    const names = list.map((v) => JSON.parse(openVersion('p-same-ms', v.id, s.file).text).name)
    expect(names).toEqual(['Second', 'First'])
  })

  it('thins out old versions', () => {
    const s = scene('p-prune')
    for (let i = 0; i < 40; i++) saveProject(s.file, JSON.stringify(s.project('Show', i)))
    // The newest 30 stay; all 40 were written today, so the rest collapse into today's one.
    expect(listVersions('p-prune').length).toBe(30)
  })
})

describe('proxies in project files', () => {
  it('keeps a proxy that exists and forgets one that doesn’t', async () => {
    const s = scene('p-proxy')
    const proxy = path.join(env.root, 'userData', 'media', 'proxies', 'a1-0.mp4')
    fs.mkdirSync(path.dirname(proxy), { recursive: true })
    fs.writeFileSync(proxy, 'proxy')
    const p = s.project('Show')
    ;(p.assets.a1 as Record<string, unknown>).proxy = { path: proxy, url: 'stale', width: 960, height: 540 }
    saveProject(s.file, JSON.stringify(p))
    const saved = JSON.parse(fs.readFileSync(s.file, 'utf8'))
    expect(saved.project.assets.a1.proxy.url).toBeUndefined()
    let opened = JSON.parse((await openProject(null, s.file))!.text)
    expect(opened.assets.a1.proxy.url).toMatch(/^lumen-media:/)
    fs.rmSync(proxy)
    opened = JSON.parse((await openProject(null, s.file))!.text)
    expect(opened.assets.a1.proxy).toBeUndefined()
  })
})

describe('collect project', () => {
  it('copies the media next to a new project file and points the project at it', async () => {
    const s = scene('p-collect')
    const p = s.project('Collect me')
    // A second asset using the same file is copied once.
    ;(p.assets as Record<string, unknown>).a2 = { ...p.assets.a1, id: 'a2' }
    env.dialogPath = path.join(env.root, `archive-${n}`)
    fs.mkdirSync(env.dialogPath, { recursive: true })
    const res = await collectProject(null, JSON.stringify(p), 'Collect me', (file, text) => saveProject(file, text))
    expect(res).toMatchObject({ files: 1, missing: [] })
    const copied = path.join(env.dialogPath, 'Collect me', 'Media', 'shot.mp4')
    expect(fs.readFileSync(copied, 'utf8')).toBe('not really a video, but bytes')
    const opened = JSON.parse((await openProject(null, res!.path))!.text)
    expect(opened.assets.a1.source.path).toBe(copied)
    expect(opened.assets.a2.source.path).toBe(copied)
    // Moving the collected folder keeps it working: media is found relative to the project.
    const moved = path.join(env.root, `moved-${n}`)
    fs.renameSync(path.join(env.dialogPath, 'Collect me'), moved)
    const again = JSON.parse((await openProject(null, path.join(moved, 'Collect me.lumen')))!.text)
    expect(again.assets.a1.source.path).toBe(path.join(moved, 'Media', 'shot.mp4'))
  })
})
