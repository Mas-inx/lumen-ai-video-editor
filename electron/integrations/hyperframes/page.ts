import fs from 'node:fs'
import { packageFile } from '../paths'

/**
 * The page every template is built on — a HyperFrames composition with
 * Lumen's fonts, one timed clip and a paused GSAP timeline on
 * window.__timelines — and the small helpers templates share.
 */

export const COMPOSITION_ID = 'lumen'

export const esc = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

export const color = (value: unknown, fallback: string) => (typeof value === 'string' && /^#[0-9a-f]{3,8}$/i.test(value) ? value : fallback)
export const num = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? value : Number.isFinite(Number(value)) && value !== '' && value !== null ? Number(value) : fallback)

/** A value for an inline script: JSON that can't close the <script> it sits in. */
export const js = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c')

let faces = ''

/**
 * Lumen's typefaces, inlined: a file:// page can't load file:// fonts (CORS),
 * data: URLs always work. Templates and custom compositions get them all.
 */
export function fontFaces() {
  if (faces) return faces
  const data = (pkg: string, file: string) => `data:font/woff2;base64,${fs.readFileSync(packageFile(pkg, file)).toString('base64')}`
  faces = `
    @font-face { font-family: 'Geist'; font-weight: 100 900; src: url('${data('@fontsource-variable/geist', 'files/geist-latin-wght-normal.woff2')}') format('woff2'); }
    @font-face { font-family: 'Geist Mono'; font-weight: 100 900; src: url('${data('@fontsource-variable/geist-mono', 'files/geist-mono-latin-wght-normal.woff2')}') format('woff2'); }
    @font-face { font-family: 'Bricolage Grotesque'; font-weight: 200 800; font-stretch: 75% 100%; src: url('${data('@fontsource-variable/bricolage-grotesque', 'files/bricolage-grotesque-latin-wght-normal.woff2')}') format('woff2'); }
    @font-face { font-family: 'Instrument Serif'; font-style: normal; src: url('${data('@fontsource/instrument-serif', 'files/instrument-serif-latin-400-normal.woff2')}') format('woff2'); }
    @font-face { font-family: 'Instrument Serif'; font-style: italic; src: url('${data('@fontsource/instrument-serif', 'files/instrument-serif-latin-400-italic.woff2')}') format('woff2'); }
    @font-face { font-family: 'Fraunces'; font-style: normal; font-weight: 100 900; src: url('${data('@fontsource-variable/fraunces', 'files/fraunces-latin-standard-normal.woff2')}') format('woff2'); }
    @font-face { font-family: 'Fraunces'; font-style: italic; font-weight: 100 900; src: url('${data('@fontsource-variable/fraunces', 'files/fraunces-latin-standard-italic.woff2')}') format('woff2'); }
    @font-face { font-family: 'Archivo'; font-weight: 100 900; font-stretch: 62% 125%; src: url('${data('@fontsource-variable/archivo', 'files/archivo-latin-standard-normal.woff2')}') format('woff2'); }
    @font-face { font-family: 'Archivo'; font-style: italic; font-weight: 100 900; font-stretch: 62% 125%; src: url('${data('@fontsource-variable/archivo', 'files/archivo-latin-standard-italic.woff2')}') format('woff2'); }
    @font-face { font-family: 'Syne'; font-weight: 400 800; src: url('${data('@fontsource-variable/syne', 'files/syne-latin-wght-normal.woff2')}') format('woff2'); }
    @font-face { font-family: 'Space Grotesk'; font-weight: 300 700; src: url('${data('@fontsource-variable/space-grotesk', 'files/space-grotesk-latin-wght-normal.woff2')}') format('woff2'); }`
  return faces
}

/** Template font choices: each one a deliberate voice. */
export const FONT_STACKS: Record<string, string> = {
  sans: "'Geist', system-ui, sans-serif",
  display: "'Bricolage Grotesque', 'Geist', sans-serif",
  serif: "'Instrument Serif', Georgia, serif",
  editorial: "'Fraunces', Georgia, serif",
  wide: "'Archivo', 'Geist', sans-serif",
  art: "'Syne', 'Geist', sans-serif",
  tech: "'Space Grotesk', 'Geist', sans-serif",
  mono: "'Geist Mono', ui-monospace, monospace",
}
export const stack = (key: unknown, fallback: string) => FONT_STACKS[String(key ?? fallback)] ?? FONT_STACKS[fallback]
export const isSerif = (key: unknown) => key === 'serif' || key === 'editorial'

export interface Frame {
  width: number
  height: number
  duration: number
}

/** Seconds a reader needs for some text once it has landed: 0.3 s a word plus a second, at least 1.5 s. */
export const readingTime = (text: string) => Math.max(1.5, 1 + 0.3 * text.split(/\s+/).filter(Boolean).length)

/** Words in masks: each word slides inside its own clip, so type wipes on instead of fading. */
export const maskedWords = (text: string, cls = 'w') =>
  text
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => `<span class="mask"><span class="${cls}">${esc(w)}</span></span>`)
    .join(' ')

export function page(f: Frame, css: string, body: string, script: string, params: Record<string, unknown>) {
  // Templates are authored at 1080p; --s scales them to the output's short side.
  const s = Math.min(f.width, f.height) / 1080
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=${f.width}, height=${f.height}" />
<meta data-composition-id="${COMPOSITION_ID}" data-width="${f.width}" data-height="${f.height}" />
<script src="__GSAP__"></script>
<style>
${fontFaces()}
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: ${f.width}px; height: ${f.height}px; overflow: hidden; background: transparent; }
body { --s: ${s}; -webkit-font-smoothing: antialiased; text-rendering: geometricPrecision; font-kerning: normal; font-feature-settings: "kern", "liga"; }
#stage { position: relative; width: 100%; height: 100%; overflow: hidden; }
.clip { position: absolute; inset: 0; visibility: hidden; }
.mask { display: inline-block; overflow: hidden; vertical-align: top; padding-bottom: 0.1em; margin-bottom: -0.1em; }
.mask > * { display: inline-block; will-change: transform; }
${css}
</style>
</head>
<body>
<div id="stage">
  <div class="clip" id="root" data-start="0" data-duration="${f.duration}" data-track-index="0">${body}</div>
</div>
<script>
const P = ${js(params)};
const D = ${f.duration};
const tl = gsap.timeline({ paused: true });
${script}
window.__timelines = window.__timelines || {};
window.__timelines["${COMPOSITION_ID}"] = tl;
</script>
</body>
</html>`
}

/** Legibility over footage without a box: a soft, close shadow that reads as nothing. */
export const SHADOW = 'text-shadow: 0 calc(1px * var(--s)) calc(2px * var(--s)) rgba(0,0,0,0.25), 0 calc(4px * var(--s)) calc(24px * var(--s)) rgba(0,0,0,0.35);'

/**
 * The same shadow for type that wipes through a mask, set on the mask's parent. A mask clips its own type's
 * text-shadow to its box, which shows as a block over bright footage; a filter follows the letters that show.
 */
export const DROP_SHADOW = 'filter: drop-shadow(0 calc(1px * var(--s)) calc(2px * var(--s)) rgba(0,0,0,0.25)) drop-shadow(0 calc(4px * var(--s)) calc(24px * var(--s)) rgba(0,0,0,0.3));'
