/**
 * Brand kits in the editor: the kits the main process keeps (or, in a browser
 * tab, local storage), edited here and saved as they change — and applying one
 * to a project: its fonts are embedded, its logos become media, the project
 * remembers the brand (brand_set), and titles, captions, cuts and footage take
 * its house style. One undo step, and every value stays editable.
 */
import { create } from 'zustand'
import type { MediaFileInfo } from '@shared/app'
import { activeKit, newBrandKit, normalizeBrandStore, type BrandFont, type BrandKit, type BrandStore } from '@shared/brand'
import { FONTS } from '@/editor/defaults'
import { isEasing } from '@/editor/easing'
import { clipEnd, projectDuration } from '@/editor/ops'
import { ANIMATIONS, LOOKS, TRANSITIONS } from '@/editor/presets'
import { dispatch, getProject, rollbackTo, savepoint, useEditor, type ActionSource } from '@/editor/store'
import { brandStyle, planStyle, styleById, STYLE_PARTS, type StylePart, type StylePlan } from '@/editor/styles'
import type { AnimPreset, Asset, BrandCaptions, FontId, FontRef, ProjectBrand, TransitionKind } from '@/editor/types'
import { probeMedia } from '@/engine/decode'
import { fontCss, registerProjectFonts, uniqueFamily } from '@/engine/fonts'
import { uid } from '@/lib/id'
import { desktop } from '@/lib/platform'

const LOCAL_KEY = 'lumen.brand.v1'

interface BrandKitsState {
  store: BrandStore
  loaded: boolean
}

export const useBrandKits = create<BrandKitsState>(() => ({ store: { activeId: null, kits: [] }, loaded: false }))

let loading: Promise<BrandStore> | null = null

/** The kits, loaded once (from the main process, or local storage in a browser tab). */
export function loadBrandKits(force = false): Promise<BrandStore> {
  if (useBrandKits.getState().loaded && !force) return Promise.resolve(useBrandKits.getState().store)
  loading ??= (async () => {
    let store: BrandStore
    try {
      store = desktop ? await desktop.brand.get() : normalizeBrandStore(JSON.parse(localStorage.getItem(LOCAL_KEY) ?? 'null'))
    } catch {
      store = { activeId: null, kits: [] }
    }
    useBrandKits.setState({ store, loaded: true })
    return store
  })().finally(() => (loading = null))
  return loading
}

let saveTimer: ReturnType<typeof setTimeout> | undefined

async function persist() {
  const sent = useBrandKits.getState().store
  try {
    if (desktop) {
      const saved = await desktop.brand.save(sent)
      // Only if nothing changed meanwhile (the next save carries those changes).
      if (useBrandKits.getState().store === sent) useBrandKits.setState({ store: saved })
    } else localStorage.setItem(LOCAL_KEY, JSON.stringify(sent))
  } catch (err) {
    console.warn('Couldn’t save the brand kits', err)
  }
}

/** Changes the kits now and saves them a moment later (slider drags save once). */
export function updateBrandKits(fn: (store: BrandStore) => BrandStore) {
  useBrandKits.setState((s) => ({ store: fn(s.store) }))
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = undefined
    void persist()
  }, 350)
}

/** Saves now what's waiting to be saved (when the editor closes). */
export function flushBrandKits() {
  if (saveTimer === undefined) return
  clearTimeout(saveTimer)
  saveTimer = undefined
  void persist()
}

export function updateKit(kitId: string, patch: Partial<BrandKit> | ((kit: BrandKit) => Partial<BrandKit>)) {
  updateBrandKits((s) => ({ ...s, kits: s.kits.map((k) => (k.id === kitId ? { ...k, ...(typeof patch === 'function' ? patch(k) : patch), updatedAt: Date.now() } : k)) }))
}

export function createKit(name?: string) {
  const kit = newBrandKit(uid('brand'), name ?? (useBrandKits.getState().store.kits.length ? `Brand ${useBrandKits.getState().store.kits.length + 1}` : 'My brand'))
  updateBrandKits((s) => ({ activeId: kit.id, kits: [...s.kits, kit] }))
  return kit
}

export function removeKit(kitId: string) {
  updateBrandKits((s) => {
    const kits = s.kits.filter((k) => k.id !== kitId)
    return { activeId: s.activeId === kitId ? (kits[0]?.id ?? null) : s.activeId, kits }
  })
}

export const setActiveKit = (kitId: string) => updateBrandKits((s) => ({ ...s, activeId: kitId }))

/** Asks for an image and adds it to a kit's logos (the first one also goes in the corner). */
export async function addLogoTo(kitId: string) {
  if (!desktop) throw new Error('Adding logos needs the Lumen desktop app.')
  const logo = await desktop.brand.addLogo()
  if (!logo) return null
  updateKit(kitId, (k) => ({ logos: [...k.logos, logo].slice(-8), watermark: k.watermark.logoId ? k.watermark : { ...k.watermark, logoId: logo.id } }))
  return logo
}

/** The kit by id, or the active one. */
export function findKit(kitId?: string | null): BrandKit | undefined {
  const store = useBrandKits.getState().store
  return kitId ? store.kits.find((k) => k.id === kitId) : activeKit(store)
}

// ─── A kit, as a project's brand ─────────────────────────────────────────

const isFontId = (v: string): v is FontId => Object.hasOwn(FONTS, v)
const ANIM_IDS = new Set<string>(ANIMATIONS.map((a) => a.preset))
const TRANSITION_IDS = new Set<string>(TRANSITIONS.map((t) => t.kind))
const CAPTION_IDS = new Set(['clean', 'bold', 'word', 'boxed'])

export const kitFontName = (f: BrandFont) => ('builtin' in f ? (isFontId(f.builtin) ? FONTS[f.builtin].label : 'Geist') : f.name)

/** The CSS font family for a kit's typeface; a kit's own font file is registered with the page (once) to show it. */
export function kitFontCss(f: BrandFont, key: string): string {
  if ('builtin' in f) return fontCss(isFontId(f.builtin) ? f.builtin : 'sans')
  const id = `${key}-${f.data.length}`
  const family = `Lumen Brand ${id}`
  registerProjectFonts({ fonts: { [id]: { id, name: f.name, family, fileName: f.fileName, data: f.data } } })
  return `"${family}", ${FONTS.sans.css}`
}

/** The project's brand from a kit, given the fonts and logos it has in the project. Ids Lumen doesn't know fall back to defaults. */
export function projectBrandFrom(kit: BrandKit, fonts: { heading: FontRef; body: FontRef }, logoAssetIds: string[]): ProjectBrand {
  const anim = (v: string, fallback: AnimPreset) => (ANIM_IDS.has(v) ? (v as AnimPreset) : fallback)
  const transition = kit.motion.transition === 'cut' ? 'cut' : kit.motion.transition && TRANSITION_IDS.has(kit.motion.transition) ? (kit.motion.transition as TransitionKind) : null
  return {
    kitId: kit.id,
    name: kit.name.trim() || 'Brand',
    colors: kit.colors.map((c) => ({ name: c.name, hex: c.hex })),
    fonts,
    logoAssetIds,
    titles: { ...kit.titles },
    captions: { style: (CAPTION_IDS.has(kit.captions.style) ? kit.captions.style : 'clean') as BrandCaptions['style'], accent: kit.captions.accent, uppercase: kit.captions.uppercase },
    look: kit.look && LOOKS.some((l) => l.id === kit.look) ? kit.look : null,
    motion: {
      titleIn: anim(kit.motion.titleIn, 'fade'),
      titleOut: anim(kit.motion.titleOut, 'fade'),
      seconds: kit.motion.seconds,
      easing: isEasing(kit.motion.easing) ? kit.motion.easing : 'ease',
      transition,
      transitionSeconds: kit.motion.transitionSeconds,
    },
    style: styleById(kit.style) ? kit.style : null,
  }
}

/** A kit's typeface as the project knows it: a built-in id, or its font file embedded (once). */
function fontRef(f: BrandFont, source: ActionSource): FontRef {
  if ('builtin' in f) return isFontId(f.builtin) ? f.builtin : 'sans'
  const existing = Object.values(getProject().fonts ?? {}).find((x) => x.name === f.name && x.data.length === f.data.length && x.data.slice(0, 64) === f.data.slice(0, 64))
  if (existing) return `custom:${existing.id}`
  const id = uid('font')
  const res = dispatch('font.add', { font: { id, name: f.name, family: uniqueFamily(f.name, id), fileName: f.fileName, data: f.data } }, { source })
  if (!res.ok) throw new Error(res.error)
  return `custom:${id}`
}

// ─── Applying a kit ──────────────────────────────────────────────────────

export type BrandPart = StylePart | 'logo'
export const BRAND_PARTS: BrandPart[] = [...STYLE_PARTS, 'logo']

export interface BrandResult {
  kit: BrandKit
  brand: ProjectBrand
  plan: StylePlan
  /** The logo in the corner, if it went on. */
  logoClipId: string | null
  notes: string[]
}

interface LogoFile {
  logoId: string
  name: string
  info: MediaFileInfo
  width: number
  height: number
}

/** The kit's logos as files the editor may read (and their size), before anything changes. */
async function logoFiles(kit: BrandKit, notes: string[]): Promise<LogoFile[]> {
  if (!desktop || !kit.logos.length) return []
  const out: LogoFile[] = []
  for (const logo of kit.logos) {
    const info = await desktop.files.urlForPath(logo.path)
    if (!info) {
      notes.push(`The logo “${logo.name}” is missing from Lumen’s brand folder — add it to the kit again.`)
      continue
    }
    let { width, height } = logo
    if (!width || !height) {
      const probed = await probeMedia(info.url, info.mime).catch(() => null)
      width = probed?.width
      height = probed?.height
    }
    out.push({ logoId: logo.id, name: logo.name, info, width: width || 512, height: height || 512 })
  }
  return out
}

/** The logo's place in a corner: its size a fraction of the frame's width, a margin from the edges. */
export function watermarkTransform(settings: { width: number; height: number }, logo: { width: number; height: number }, wm: BrandKit['watermark']) {
  const { width: W, height: H } = settings
  const fit = Math.min(W / logo.width, H / logo.height)
  const scale = (wm.size * W) / (logo.width * fit)
  const w = logo.width * fit * scale
  const h = logo.height * fit * scale
  const m = Math.min(W, H) * 0.045
  const sx = wm.corner.endsWith('left') ? -1 : 1
  const sy = wm.corner.startsWith('top') ? -1 : 1
  return { scale: Math.round(scale * 1000) / 1000, x: Math.round(sx * (W / 2 - m - w / 2)), y: Math.round(sy * (H / 2 - m - h / 2)), opacity: wm.opacity }
}

/**
 * Applies a brand kit to the open project as one undo step: embeds its fonts,
 * brings its logos in as media, gives the project the brand, restyles the
 * timeline (or just `clipIds`) in the brand's house style and, with `logo`,
 * puts the logo in its corner for the whole stretch.
 */
export async function applyBrandKit(opts: { kitId?: string; clipIds?: string[]; parts?: BrandPart[]; source?: ActionSource } = {}): Promise<BrandResult> {
  await loadBrandKits()
  const kit = findKit(opts.kitId)
  if (!kit) throw new Error(opts.kitId ? `There’s no brand kit “${opts.kitId}”.` : 'There’s no brand kit yet — make one in Styles › Brand kit.')
  const source = opts.source ?? 'user'
  const parts = new Set(opts.parts?.length ? opts.parts : BRAND_PARTS)
  const notes: string[] = []
  const files = await logoFiles(kit, notes)
  let result: BrandResult | null = null
  useEditor.getState().transaction(`Apply brand kit “${kit.name}”`, source, () => {
    const mark = savepoint()
    try {
      const fonts = { heading: fontRef(kit.fonts.heading, source), body: fontRef(kit.fonts.body, source) }
      // The logos, as media (once each).
      const logoAssets = new Map<string, string>()
      for (const f of files) {
        const existing = Object.values(getProject().assets).find((a) => a.source.type === 'file' && a.source.path?.toLowerCase() === f.info.path.toLowerCase())
        if (existing) logoAssets.set(f.logoId, existing.id)
        else {
          const asset: Asset = {
            id: uid('asset'),
            name: `${kit.name} · ${f.name}`,
            kind: 'image',
            width: f.width,
            height: f.height,
            alpha: !/jpe?g/i.test(f.info.mime),
            source: { type: 'file', url: f.info.url, path: f.info.path, mime: f.info.mime, fileName: f.info.name, size: f.info.size, mtime: f.info.mtime },
            tags: ['logo', 'brand'],
            description: `${kit.name} logo`,
            addedAt: Date.now(),
          }
          const res = dispatch('asset.add', { asset }, { source })
          if (!res.ok) throw new Error(res.error)
          logoAssets.set(f.logoId, asset.id)
        }
      }
      const brand = projectBrandFrom(kit, fonts, [...logoAssets.values()])
      const set = dispatch('brand.set', { brand }, { source })
      if (!set.ok) throw new Error(set.error)

      const spec = brandStyle(brand, styleById(brand.style), 'all')
      const plan = planStyle(getProject(), spec, { clipIds: opts.clipIds, parts: [...parts].filter((p): p is StylePart => p !== 'logo') })
      for (const s of plan.steps) {
        const res = dispatch(s.name, s.input as never, { source })
        if (!res.ok) throw new Error(`${s.name}: ${res.error}`)
      }

      let logoClipId: string | null = null
      const corner = files.find((f) => f.logoId === kit.watermark.logoId)
      if (parts.has('logo') && kit.watermark.logoId && !corner) notes.push('The corner logo couldn’t be found, so it wasn’t placed.')
      if (parts.has('logo') && corner) logoClipId = placeWatermark(kit, corner, logoAssets.get(corner.logoId)!, opts.clipIds, source)
      result = { kit, brand, plan, logoClipId, notes }
    } catch (err) {
      if (mark) rollbackTo(mark)
      throw err
    }
  })
  return result!
}

/** The logo in its corner over the whole timeline (or the stretch the clips cover), on a Logo track of its own. */
function placeWatermark(kit: BrandKit, logo: LogoFile, assetId: string, clipIds: string[] | undefined, source: ActionSource) {
  const p = getProject()
  const scoped = clipIds?.map((id) => p.clips[id]).filter(Boolean) ?? []
  const from = scoped.length ? Math.min(...scoped.map((c) => c.start)) : 0
  const to = scoped.length ? Math.max(...scoped.map(clipEnd)) : projectDuration(p)
  if (to <= from) return null
  let track = p.tracks.find((t) => t.kind === 'video' && t.name === 'Logo' && !t.locked)
  if (!track) {
    const res = dispatch('track.add', { kind: 'video', name: 'Logo', index: 0 }, { source })
    if (!res.ok) throw new Error(res.error)
    track = getProject().tracks.find((t) => t.id === res.result)!
  }
  // A logo already in that stretch makes way for this one.
  const before = Object.values(getProject().clips).filter((c) => c.trackId === track.id && c.start < to && clipEnd(c) > from)
  if (before.length) {
    const res = dispatch('clip.delete', { ids: before.map((c) => c.id) }, { source })
    if (!res.ok) throw new Error(res.error)
  }
  const res = dispatch(
    'clip.add',
    { trackId: track.id, kind: 'image', start: from, duration: to - from, assetId, name: `${kit.name} logo`, mode: 'overwrite', patch: { transform: watermarkTransform(p.settings, logo, kit.watermark) } },
    { source },
  )
  if (!res.ok) throw new Error(res.error)
  return res.result as string
}
