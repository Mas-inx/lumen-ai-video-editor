import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { dialog, nativeImage, type BrowserWindow } from 'electron'
import { normalizeBrandStore, type BrandLogo, type BrandStore } from '../shared/brand'
import { ensureDir, isInside, mediaRoot, mediaUrl, readJson, writeJson } from './integrations/paths'

/**
 * Brand kits on disk: userData/brand-kits.json, with every logo copied into
 * userData/media/brand, so it's served like Lumen's other media and outlives
 * the file it came from. A logo taken out of a kit keeps its file — projects
 * that were given it still show it.
 */

const FILE = 'brand-kits.json'
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'svg', 'gif']
const MAX_LOGO = 20 * 1024 * 1024

export const logoFolder = () => path.join(mediaRoot(), 'brand')

/** Logos only from Lumen's brand folder, each with the URL it's served at. */
function served(store: BrandStore): BrandStore {
  for (const kit of store.kits) {
    kit.logos = kit.logos.filter((l) => isInside(l.path, logoFolder())).map((l) => ({ ...l, url: mediaUrl(l.path) }))
    if (kit.watermark.logoId && !kit.logos.some((l) => l.id === kit.watermark.logoId)) kit.watermark.logoId = null
  }
  return store
}

export function brandKits(): BrandStore {
  return served(normalizeBrandStore(readJson<unknown>(FILE, null)))
}

export function saveBrandKits(raw: unknown): BrandStore {
  const store = served(normalizeBrandStore(raw))
  writeJson(FILE, store)
  return store
}

/** Copies an image into the brand folder as a logo. */
export function copyLogo(src: string): BrandLogo {
  const ext = path.extname(src).toLowerCase()
  if (!IMAGE_EXT.includes(ext.slice(1))) throw new Error('A logo is an image: PNG, JPEG, WebP, SVG or GIF.')
  if (fs.statSync(src).size > MAX_LOGO) throw new Error('That image is over 20 MB — too large for a logo.')
  const id = `logo_${randomUUID().slice(0, 8)}`
  const dest = path.join(ensureDir(logoFolder()), `${id}${ext}`)
  fs.copyFileSync(src, dest)
  // The size helps place it; Chromium reads what this can't (SVG, WebP) when it's applied.
  const size = ext === '.svg' ? null : nativeImage.createFromPath(dest).getSize()
  return { id, name: path.basename(src, ext).slice(0, 120) || 'Logo', path: dest, url: mediaUrl(dest), ...(size?.width ? { width: size.width, height: size.height } : {}) }
}

export async function addLogo(win: BrowserWindow | null): Promise<BrandLogo | null> {
  const opts: Electron.OpenDialogOptions = { title: 'Add a logo', buttonLabel: 'Add logo', properties: ['openFile'], filters: [{ name: 'Images', extensions: IMAGE_EXT }] }
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  const src = res.filePaths[0]
  if (res.canceled || !src) return null
  return copyLogo(src)
}
