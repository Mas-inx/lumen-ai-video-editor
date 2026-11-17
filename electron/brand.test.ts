import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({ root: '', picked: [] as string[] }))

vi.mock('electron', () => ({
  app: { getPath: (name: string) => path.join(env.root, name), getVersion: () => '1.0.0' },
  dialog: { showOpenDialog: async () => ({ canceled: env.picked.length === 0, filePaths: env.picked }) },
  nativeImage: { createFromPath: () => ({ getSize: () => ({ width: 640, height: 320 }) }) },
  BrowserWindow: class {},
  shell: {},
}))

env.root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-brand-test-'))
const { addLogo, brandKits, copyLogo, logoFolder, saveBrandKits } = await import('./brand')

afterAll(() => fs.rmSync(env.root, { recursive: true, force: true }))

const file = () => path.join(env.root, 'userData', 'brand-kits.json')

beforeEach(() => {
  fs.rmSync(file(), { force: true })
  env.picked = []
})

function image(name: string) {
  const p = path.join(env.root, 'Downloads', name)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, Uint8Array.from([137, 80, 78, 71]))
  return p
}

describe('brand kits on disk', () => {
  it('start empty', () => {
    expect(brandKits()).toEqual({ activeId: null, kits: [] })
  })

  it('are stored tidy — and read back as stored', () => {
    const saved = saveBrandKits({
      activeId: 'gone',
      kits: [
        { id: 'acme', name: '  Acme  ', colors: [{ name: 'Signal', hex: '#FF5A36' }, { name: 'Bad', hex: 'red' }], titles: { weight: 777, tracking: 9 }, watermark: { logoId: 'nope', size: 5 } },
        { id: 'acme', name: 'Duplicate' },
        'not a kit',
      ],
    })
    expect(saved.kits).toHaveLength(2)
    expect(saved.activeId).toBe('acme')
    const acme = saved.kits[0]
    expect(acme).toMatchObject({ id: 'acme', name: 'Acme', colors: [{ name: 'Signal', hex: '#ff5a36' }], titles: { weight: 800, tracking: 2 }, watermark: { logoId: null, size: 0.5 } })
    expect(JSON.parse(fs.readFileSync(file(), 'utf8'))).toEqual(saved)
    expect(brandKits()).toEqual(saved)
  })

  it('only keep logos from Lumen’s brand folder, served from there', () => {
    const logo = copyLogo(image('acme.png'))
    const saved = saveBrandKits({
      kits: [{ id: 'acme', name: 'Acme', logos: [logo, { id: 'evil', name: 'Elsewhere', path: path.join(env.root, 'secret.png'), url: 'x' }], watermark: { logoId: logo.id } }],
    })
    expect(saved.kits[0].logos.map((l) => l.id)).toEqual([logo.id])
    expect(saved.kits[0].logos[0].url).toMatch(/^lumen-media:\/\/local\/brand\//)
    expect(saved.kits[0].watermark.logoId).toBe(logo.id)
  })
})

describe('logos', () => {
  it('are copied into the brand folder, with their size', () => {
    const logo = copyLogo(image('Acme Logo.png'))
    expect(logo).toMatchObject({ id: expect.stringMatching(/^logo_[0-9a-f]{8}$/), name: 'Acme Logo', width: 640, height: 320 })
    expect(path.dirname(logo.path)).toBe(logoFolder())
    expect(fs.existsSync(logo.path)).toBe(true)
  })

  it('must be images', () => {
    const doc = path.join(env.root, 'Downloads', 'notes.txt')
    fs.writeFileSync(doc, 'hello')
    expect(() => copyLogo(doc)).toThrow(/A logo is an image/)
  })

  it('come from the dialog, or not at all when it is cancelled', async () => {
    expect(await addLogo(null)).toBeNull()
    env.picked = [image('mark.svg')]
    const logo = await addLogo(null)
    expect(logo).toMatchObject({ name: 'mark' })
    // SVG: Chromium works out its size when it's used.
    expect(logo?.width).toBeUndefined()
  })
})
