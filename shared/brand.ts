/**
 * Brand kits: the colours, typefaces, logos and house style someone uses in
 * every project. The main process keeps them in userData (electron/brand.ts);
 * the editor applies one to a project (src/project/brand.ts), which gets its
 * own copy — fonts embedded, logos as media — so the project travels.
 *
 * Ids of looks, styles, animations and transitions are the editor's; here
 * they're only kept tidy, and the editor ignores ones it doesn't know.
 */

export interface BrandColor {
  name: string
  hex: string
}

/** A typeface: one of Lumen's built-in fonts, or a font file kept with the kit. */
export type BrandFont = { builtin: string } | { name: string; fileName: string; data: string }

/** A logo image, copied into Lumen's own media folder when it was added. */
export interface BrandLogo {
  id: string
  name: string
  path: string
  url: string
  width?: number
  height?: number
}

export type BrandCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

export interface BrandKit {
  id: string
  name: string
  colors: BrandColor[]
  fonts: { heading: BrandFont; body: BrandFont }
  logos: BrandLogo[]
  titles: { color: string | null; background: string | null; weight: number; uppercase: boolean; tracking: number }
  captions: { style: string; accent: string | null; uppercase: boolean | null }
  /** A colour look, or null to leave footage as it is. */
  look: string | null
  motion: { titleIn: string; titleOut: string; seconds: number; easing: string; transition: string | null; transitionSeconds: number }
  /** The style the brand builds on, or null. */
  style: string | null
  /** The logo in a corner of the picture, when the kit is applied with it. */
  watermark: { logoId: string | null; corner: BrandCorner; size: number; opacity: number }
  updatedAt: number
}

export interface BrandStore {
  activeId: string | null
  kits: BrandKit[]
}

export const BRAND_LIMITS = { kits: 24, colors: 16, logos: 8, fontBytes: 12 * 1024 * 1024 } as const

const HEX = /^#[0-9a-f]{3,8}$/i
const CORNERS: BrandCorner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right']

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown, max: number, fallback = '') => (typeof v === 'string' ? v.trim().slice(0, max) : fallback)
const num = (v: unknown, lo: number, hi: number, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback)
const hex = (v: unknown) => (typeof v === 'string' && HEX.test(v.trim()) ? v.trim().toLowerCase() : null)
const id = (v: unknown) => (typeof v === 'string' && /^[\w-]{1,64}$/.test(v) ? v : null)

export function newBrandKit(kitId: string, name = 'My brand'): BrandKit {
  return {
    id: kitId,
    name,
    colors: [
      { name: 'Primary', hex: '#d6ee00' },
      { name: 'Ink', hex: '#0b0c02' },
      { name: 'Paper', hex: '#f4f1ea' },
    ],
    fonts: { heading: { builtin: 'display' }, body: { builtin: 'sans' } },
    logos: [],
    titles: { color: '#ffffff', background: null, weight: 700, uppercase: false, tracking: -0.01 },
    captions: { style: 'clean', accent: '#d6ee00', uppercase: null },
    look: null,
    motion: { titleIn: 'rise', titleOut: 'fade', seconds: 0.5, easing: 'cubic-out', transition: null, transitionSeconds: 0.5 },
    style: null,
    watermark: { logoId: null, corner: 'top-right', size: 0.1, opacity: 0.9 },
    updatedAt: Date.now(),
  }
}

function font(v: unknown, fallback: BrandFont): BrandFont {
  if (!isRecord(v)) return fallback
  if (typeof v.builtin === 'string') return { builtin: text(v.builtin, 40) || 'sans' }
  const data = typeof v.data === 'string' ? v.data : ''
  // base64 only, and not more than a font file can sensibly be.
  if (!data || data.length > (BRAND_LIMITS.fontBytes * 4) / 3 + 4 || !/^[A-Za-z0-9+/]+=*$/.test(data)) return fallback
  return { name: text(v.name, 120) || 'Font', fileName: text(v.fileName, 160) || 'font.ttf', data }
}

/** A kit as it can be stored: every field present, in range, and nothing else. */
export function normalizeBrandKit(raw: unknown, fallbackId: string): BrandKit {
  const r = isRecord(raw) ? raw : {}
  const base = newBrandKit(id(r.id) ?? fallbackId, text(r.name, 80) || 'My brand')
  const colors = Array.isArray(r.colors)
    ? r.colors
        .filter(isRecord)
        .map((c) => ({ name: text(c.name, 40), hex: hex(c.hex) }))
        .filter((c): c is BrandColor => c.hex !== null)
        .slice(0, BRAND_LIMITS.colors)
    : base.colors
  const fonts = isRecord(r.fonts) ? r.fonts : {}
  const logos = Array.isArray(r.logos)
    ? r.logos
        .filter(isRecord)
        .map((l) => ({
          id: id(l.id),
          name: text(l.name, 120) || 'Logo',
          path: text(l.path, 1024),
          url: text(l.url, 2048),
          ...(typeof l.width === 'number' && l.width > 0 ? { width: Math.round(l.width) } : {}),
          ...(typeof l.height === 'number' && l.height > 0 ? { height: Math.round(l.height) } : {}),
        }))
        .filter((l): l is BrandLogo => l.id !== null && Boolean(l.path))
        .slice(0, BRAND_LIMITS.logos)
    : []
  const t = isRecord(r.titles) ? r.titles : {}
  const c = isRecord(r.captions) ? r.captions : {}
  const m = isRecord(r.motion) ? r.motion : {}
  const w = isRecord(r.watermark) ? r.watermark : {}
  const logoId = id(w.logoId)
  return {
    ...base,
    colors,
    fonts: { heading: font(fonts.heading, base.fonts.heading), body: font(fonts.body, base.fonts.body) },
    logos,
    titles: {
      color: t.color === null ? null : (hex(t.color) ?? base.titles.color),
      background: hex(t.background),
      weight: Math.round(num(t.weight, 100, 900, base.titles.weight) / 50) * 50,
      uppercase: typeof t.uppercase === 'boolean' ? t.uppercase : base.titles.uppercase,
      tracking: num(t.tracking, -0.5, 2, base.titles.tracking),
    },
    captions: {
      style: text(c.style, 20) || base.captions.style,
      accent: c.accent === null ? null : (hex(c.accent) ?? base.captions.accent),
      uppercase: typeof c.uppercase === 'boolean' ? c.uppercase : null,
    },
    look: text(r.look, 40) || null,
    motion: {
      titleIn: text(m.titleIn, 20) || base.motion.titleIn,
      titleOut: text(m.titleOut, 20) || base.motion.titleOut,
      seconds: num(m.seconds, 0.05, 10, base.motion.seconds),
      easing: text(m.easing, 60) || base.motion.easing,
      transition: text(m.transition, 20) || null,
      transitionSeconds: num(m.transitionSeconds, 0.05, 10, base.motion.transitionSeconds),
    },
    style: text(r.style, 40) || null,
    watermark: {
      logoId: logoId && logos.some((l) => l.id === logoId) ? logoId : null,
      corner: CORNERS.includes(w.corner as BrandCorner) ? (w.corner as BrandCorner) : base.watermark.corner,
      size: num(w.size, 0.02, 0.5, base.watermark.size),
      opacity: num(w.opacity, 0.05, 1, base.watermark.opacity),
    },
    updatedAt: num(r.updatedAt, 0, Number.MAX_SAFE_INTEGER, Date.now()),
  }
}

/** The kits as they can be stored: valid kits with unique ids, and an active one that exists. */
export function normalizeBrandStore(raw: unknown): BrandStore {
  const r = isRecord(raw) ? raw : {}
  const seen = new Set<string>()
  const kits = (Array.isArray(r.kits) ? r.kits : [])
    .slice(0, BRAND_LIMITS.kits)
    .map((k, i) => normalizeBrandKit(k, `brand_${i + 1}`))
    .filter((k) => !seen.has(k.id) && Boolean(seen.add(k.id)))
  const active = id(r.activeId)
  return { activeId: active && kits.some((k) => k.id === active) ? active : (kits[0]?.id ?? null), kits }
}

export const activeKit = (store: BrandStore) => store.kits.find((k) => k.id === store.activeId) ?? store.kits[0]
