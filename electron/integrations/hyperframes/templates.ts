import fs from 'node:fs'
import type { MotionTemplate } from '../../../shared/integrations'
import { packageFile } from '../paths'

/**
 * Motion-graphics templates, authored as HyperFrames compositions: plain
 * HTML + CSS, animated by a paused GSAP timeline registered on
 * window.__timelines so the runtime can seek it frame-exactly.
 * Backgrounds stay transparent — these render as overlays.
 *
 * The craft they follow (the Copilot's motion skill teaches the same): type
 * set on purpose; no frosted panels, glows or gradient sweeps; masks instead
 * of fades; a different ease for each element's role — entrances decelerate,
 * exits accelerate and are shorter; holds long enough to read; and, given a
 * tempo, changes that land on the beat.
 */

export const COMPOSITION_ID = 'lumen'

const esc = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const color = (value: unknown, fallback: string) => (typeof value === 'string' && /^#[0-9a-f]{3,8}$/i.test(value) ? value : fallback)
const num = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? value : Number.isFinite(Number(value)) && value !== '' && value !== null ? Number(value) : fallback)

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
const stack = (key: unknown, fallback: string) => FONT_STACKS[String(key ?? fallback)] ?? FONT_STACKS[fallback]
const isSerif = (key: unknown) => key === 'serif' || key === 'editorial'

interface Frame {
  width: number
  height: number
  duration: number
}

/** Seconds a reader needs for some text once it has landed: 0.3 s a word plus a second, at least 1.5 s. */
export const readingTime = (text: string) => Math.max(1.5, 1 + 0.3 * text.split(/\s+/).filter(Boolean).length)

/** Words in masks: each word slides inside its own clip, so type wipes on instead of fading. */
const maskedWords = (text: string, cls = 'w') =>
  text
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => `<span class="mask"><span class="${cls}">${esc(w)}</span></span>`)
    .join(' ')

function page(f: Frame, css: string, body: string, script: string, params: Record<string, unknown>) {
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
const P = ${JSON.stringify(params).replace(/</g, '\\u003c')};
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
const SHADOW = 'text-shadow: 0 calc(1px * var(--s)) calc(2px * var(--s)) rgba(0,0,0,0.25), 0 calc(4px * var(--s)) calc(24px * var(--s)) rgba(0,0,0,0.35);'

// ─── Lower third ─────────────────────────────────────────────────────────
// editorial (default): a hairline rule, the name set in a serif, the role in tracked caps — no panel.
// block: solid colour blocks, broadcast style. minimal: two lines of type and nothing else.

function lowerThird(p: Record<string, unknown>, f: Frame) {
  const accent = color(p.accent, '#d6ee00')
  const right = p.align === 'right'
  const style = p.style === 'block' || p.style === 'minimal' ? p.style : 'editorial'
  const fontKey = p.font ?? (style === 'block' ? 'display' : style === 'minimal' ? 'sans' : 'editorial')
  const serif = isSerif(fontKey)
  const side = right ? 'right' : 'left'
  const css = `
    .lt { position: absolute; ${side}: calc(120px * var(--s)); bottom: calc(150px * var(--s)); text-align: ${side}; color: #fff; }
    .name { font-family: ${stack(fontKey, 'editorial')}; font-size: calc(${style === 'block' ? 50 : 60}px * var(--s)); font-weight: ${style === 'block' ? 650 : serif ? 420 : 600}; letter-spacing: ${serif ? '-0.012em' : '-0.022em'}; line-height: 1.05; ${style === 'block' ? '' : SHADOW} }
    .role { font-family: ${FONT_STACKS.sans}; font-size: calc(19px * var(--s)); font-weight: 560; letter-spacing: 0.2em; text-transform: uppercase; color: rgba(255,255,255,0.78); ${style === 'block' ? '' : SHADOW} }
    .rule { height: calc(1.5px * var(--s)); width: calc(64px * var(--s)); background: ${accent}; margin: calc(14px * var(--s)) 0 calc(12px * var(--s)); ${right ? 'margin-left: auto;' : ''} transform: scaleX(0); transform-origin: ${right ? '100%' : '0%'} 50%; }
    .gap { height: calc(10px * var(--s)); }
    .blk { display: inline-block; overflow: hidden; }
    .blk > span { display: inline-block; }
    .b1 { background: ${accent}; color: #0b0b09; padding: calc(10px * var(--s)) calc(20px * var(--s)) calc(12px * var(--s)); }
    .b2 { background: #0e0f0c; margin-top: calc(4px * var(--s)); padding: calc(9px * var(--s)) calc(20px * var(--s)); }
    .b1, .b2 { clip-path: ${right ? 'inset(0 0 0 100%)' : 'inset(0 100% 0 0)'}; }`
  const name = esc(p.name ?? 'Your Name')
  const role = esc(p.title ?? '')
  const body =
    style === 'block'
      ? `<div class="lt"><div><span class="blk b1"><span class="name">${name}</span></span></div>${role ? `<div><span class="blk b2"><span class="role">${role}</span></span></div>` : ''}</div>`
      : `<div class="lt"><div class="name"><span class="mask"><span>${name}</span></span></div>${style === 'editorial' ? '<div class="rule"></div>' : '<div class="gap"></div>'}${role ? `<div class="role"><span class="mask"><span>${role}</span></span></div>` : ''}</div>`
  // Entrances decelerate, each element with its own ease; exits are quicker and accelerate.
  const script =
    style === 'block'
      ? `
    const open = 'inset(0 0% 0 0%)';
    const shut = '${right ? 'inset(0 100% 0 0)' : 'inset(0 0 0 100%)'}';
    tl.to('.b1', { clipPath: open, duration: 0.62, ease: 'expo.out' }, 0.1)
      .from('.b1 .name', { xPercent: ${right ? 18 : -18}, duration: 0.8, ease: 'power3.out' }, 0.16)
      .to('.b2', { clipPath: open, duration: 0.5, ease: 'power4.out' }, 0.34)
      .from('.b2 .role', { xPercent: ${right ? 12 : -12}, opacity: 0, duration: 0.6, ease: 'power2.out' }, 0.4)
      .to('.b2', { clipPath: shut, duration: 0.32, ease: 'power3.in' }, D - 0.62)
      .to('.b1', { clipPath: shut, duration: 0.36, ease: 'power3.in' }, D - 0.5);`
      : `
    gsap.set('.mask > span', { yPercent: 110 });
    ${style === 'editorial' ? "tl.to('.rule', { scaleX: 1, duration: 0.7, ease: 'power3.inOut' }, 0.05);" : ''}
    tl.to('.name .mask > span', { yPercent: 0, duration: 0.95, ease: 'expo.out' }, 0.18)
      .to('.role .mask > span', { yPercent: 0, duration: 0.7, ease: 'power2.out' }, 0.44)
      .to('.lt', { x: ${right ? -6 : 6}, duration: Math.max(0.5, D - 2), ease: 'sine.inOut' }, 0.9)
      .to('.role .mask > span', { yPercent: -110, duration: 0.32, ease: 'power2.in' }, D - 0.66)
      .to('.name .mask > span', { yPercent: -110, duration: 0.42, ease: 'power3.in' }, D - 0.56);
    ${style === 'editorial' ? `tl.to('.rule', { scaleX: 0, transformOrigin: '${right ? '0%' : '100%'} 50%', duration: 0.36, ease: 'power2.in' }, D - 0.42);` : ''}`
  return page(f, css, body, script, p)
}

// ─── Title card ──────────────────────────────────────────────────────────
// editorial (default): a serif title in masked lines, a tracked eyebrow, a hairline that draws.
// poster: a huge grotesk, uppercase and tight, cut in word by word (on the beat, given a tempo).

function titleCard(p: Record<string, unknown>, f: Frame) {
  const accent = color(p.accent, '#d6ee00')
  const fg = color(p.color, '#ffffff')
  const poster = p.style === 'poster'
  const fontKey = p.font ?? (poster ? 'art' : 'editorial')
  const serif = isSerif(fontKey)
  const title = String(p.title ?? 'Your Title')
  // Line breaks the writer chose ("|" or a newline) are kept: break on meaning, not on width.
  const lines = title.split(/\s*\|\s*|\n/).filter(Boolean)
  const css = `
    .card { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; color: ${fg}; text-align: center; padding: 0 8%; }
    .eyebrow { font-family: ${FONT_STACKS.sans}; font-size: calc(18px * var(--s)); font-weight: 600; letter-spacing: 0.34em; text-transform: uppercase; color: ${accent}; margin-bottom: calc(26px * var(--s)); ${SHADOW} }
    .title { font-family: ${stack(fontKey, poster ? 'art' : 'editorial')}; ${SHADOW} }
    .title .row { display: block; text-wrap: balance; }
    ${
      poster
        ? `.title { font-size: calc(170px * var(--s)); font-weight: 780; letter-spacing: -0.045em; line-height: 0.92; text-transform: uppercase; }`
        : `.title { font-size: calc(${serif ? 148 : 128}px * var(--s)); font-weight: ${serif ? 380 : 680}; letter-spacing: ${serif ? '-0.02em' : '-0.035em'}; line-height: 1.02; ${fontKey === 'editorial' ? "font-variation-settings: 'opsz' 144;" : ''} }
    .title em { font-style: italic; color: ${accent}; }`
    }
    .rule { width: calc(56px * var(--s)); height: calc(1.5px * var(--s)); margin-top: calc(34px * var(--s)); background: ${accent}; transform: scaleX(0); }
    .sub { margin-top: calc(22px * var(--s)); font-family: ${FONT_STACKS.sans}; font-size: calc(26px * var(--s)); font-weight: 420; color: rgba(255,255,255,0.8); letter-spacing: 0.005em; ${SHADOW} }`
  // *word* sets a word in italics and the accent colour (editorial).
  const rich = (line: string) =>
    line
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => {
        const hot = /^\*.+\*$/.test(w)
        const word = esc(w.replace(/\*/g, ''))
        return `<span class="mask"><span class="w">${hot && !poster ? `<em>${word}</em>` : word}</span></span>`
      })
      .join(' ')
  const body = `
    <div class="card">
      ${p.eyebrow ? `<div class="eyebrow"><span class="mask"><span>${esc(p.eyebrow)}</span></span></div>` : ''}
      <h1 class="title">${lines.map((l) => `<span class="row">${rich(l)}</span>`).join('')}</h1>
      ${poster ? '' : '<div class="rule"></div>'}
      ${p.subtitle ? `<p class="sub"><span class="mask"><span>${esc(p.subtitle)}</span></span></p>` : ''}
    </div>`
  const script = poster
    ? `
    const ws = gsap.utils.toArray('.title .w');
    gsap.set('.mask > span', { yPercent: 105 });
    // Hard, rhythmic cuts: each word lands, the next follows a beat later.
    const beat = P.bpm ? 60 / P.bpm : Math.min(0.32, Math.max(0.14, (D * 0.3) / Math.max(1, ws.length)));
    ws.forEach((w, i) => tl.to(w, { yPercent: 0, duration: 0.42, ease: 'power4.out' }, 0.1 + i * beat));
    const landed = 0.1 + ws.length * beat;
    tl.to('.eyebrow .mask > span', { yPercent: 0, duration: 0.6, ease: 'power2.out' }, 0.05)
      .to('.sub .mask > span', { yPercent: 0, duration: 0.6, ease: 'power2.out' }, landed)
      .to('.card', { scale: 1.035, duration: Math.max(0.5, D - landed - 0.5), ease: 'none' }, landed)
      .to(ws, { yPercent: -105, duration: 0.34, ease: 'power3.in', stagger: 0.025 }, D - 0.48)
      .to('.eyebrow, .sub', { opacity: 0, duration: 0.25, ease: 'power1.in' }, D - 0.4);`
    : `
    gsap.set('.mask > span', { yPercent: 108 });
    tl.to('.eyebrow .mask > span', { yPercent: 0, duration: 0.8, ease: 'sine.out' }, 0.05);
    gsap.utils.toArray('.title .row').forEach((row, i) => {
      tl.to(row.querySelectorAll('.w'), { yPercent: 0, duration: 1.15, ease: 'expo.out', stagger: 0.07 }, 0.2 + i * 0.14);
    });
    tl.to('.rule', { scaleX: 1, duration: 0.85, ease: 'power3.inOut' }, 0.62)
      .to('.sub .mask > span', { yPercent: 0, duration: 0.75, ease: 'power2.out' }, 0.8)
      // The hold breathes: a slow drift, nothing that pulls the eye.
      .to('.card', { scale: 1.02, duration: Math.max(0.5, D - 1.6), ease: 'none' }, 1.1)
      .to('.title .w', { yPercent: -108, duration: 0.45, ease: 'power3.in', stagger: 0.02 }, D - 0.62)
      .to('.eyebrow .mask > span, .sub .mask > span', { yPercent: -108, duration: 0.36, ease: 'power2.in' }, D - 0.55)
      .to('.rule', { scaleX: 0, duration: 0.34, ease: 'power2.in' }, D - 0.5);`
  return page(f, css, body, script, p)
}

// ─── Kinetic typography ──────────────────────────────────────────────────
// punch (default): one word at a time, cut on the beat. stack: lines build up, earlier ones dim.
// stretch: a variable-width grotesk that opens from condensed to wide on every word.

function kinetic(p: Record<string, unknown>, f: Frame) {
  const accent = color(p.accent, '#d6ee00')
  const fg = color(p.color, '#ffffff')
  const style = p.style === 'stack' || p.style === 'stretch' ? p.style : 'punch'
  const font = style === 'stretch' ? FONT_STACKS.wide : stack(p.font, 'display')
  const words = String(p.text ?? 'Make every frame count')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 24)
  // Emphasise any word in *stars* — or the last one when none is marked.
  const marked = words.some((w) => /^\*.+\*$/.test(w))
  const items = words.map((w, i) => ({ text: w.replace(/\*/g, ''), hot: marked ? /^\*.+\*$/.test(w) : i === words.length - 1 }))
  const css =
    style === 'stack'
      ? `
    .wrap { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; font-family: ${font}; font-size: calc(124px * var(--s)); }
    .row { display: block; word-spacing: 0.05em; }
    .w { font-weight: 760; letter-spacing: -0.04em; line-height: 0.98; color: ${fg}; text-transform: uppercase; ${SHADOW} }
    .w.hot { color: ${accent}; }`
      : `
    .wrap { position: absolute; inset: 0; font-family: ${font}; }
    .w { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); white-space: nowrap; font-size: calc(${style === 'stretch' ? 170 : 184}px * var(--s)); font-weight: ${style === 'stretch' ? 820 : 800}; letter-spacing: ${style === 'stretch' ? '-0.02em' : '-0.045em'}; color: ${fg}; text-transform: uppercase; opacity: 0; ${SHADOW} }
    .w.hot { color: ${accent}; }`
  const body =
    style === 'stack'
      ? `<div class="wrap">${chunk(items, 2)
          .map((row) => `<div class="row">${row.map((w) => `<span class="mask"><span class="w${w.hot ? ' hot' : ''}">${esc(w.text)}</span></span>`).join(' ')}</div>`)
          .join('')}</div>`
      : `<div class="wrap">${items.map((w) => `<span class="w${w.hot ? ' hot' : ''}">${esc(w.text)}</span>`).join('')}</div>`
  const timing = `
    // On a tempo, every change lands on a beat (or every few beats when one is too quick to read).
    const spb = P.bpm ? 60 / P.bpm : 0;
    const want = (D - 1.2) / Math.max(1, N);
    const beat = spb ? spb * Math.max(1, Math.round(want / spb)) : Math.max(0.22, want);`
  const script =
    style === 'stack'
      ? `
    const rows = gsap.utils.toArray('.row');
    const N = rows.length;
    ${timing}
    gsap.set('.w', { yPercent: 105 });
    rows.forEach((row, i) => {
      const at = 0.12 + i * beat;
      tl.to(row.querySelectorAll('.w'), { yPercent: 0, duration: 0.5, ease: 'expo.out', stagger: 0.05 }, at);
      if (i > 0) tl.to(rows.slice(0, i), { opacity: 0.35, duration: 0.4, ease: 'power2.out' }, at);
    });
    tl.to(rows, { opacity: 1, duration: 0.3, ease: 'power1.out' }, 0.12 + N * beat)
      .to('.w', { yPercent: -105, duration: 0.36, ease: 'power3.in', stagger: 0.02 }, D - 0.5);`
      : `
    const ws = gsap.utils.toArray('.w');
    const N = ws.length;
    ${timing}
    ws.forEach((w, i) => {
      const at = 0.1 + i * beat;
      const hot = w.classList.contains('hot');
      tl.set(w, { opacity: 1 }, at);
      ${
        style === 'stretch'
          ? `tl.fromTo(w, { fontStretch: '62%', scale: 0.96 }, { fontStretch: '125%', scale: 1, duration: Math.min(0.9, beat * 1.6), ease: 'expo.out', immediateRender: false }, at);`
          : `tl.fromTo(w, { scale: hot ? 1.18 : 1.07 }, { scale: 1, duration: hot ? 0.5 : 0.28, ease: hot ? 'back.out(1.5)' : 'power4.out', immediateRender: false }, at);`
      }
      // A clean cut to the next word — no blur, no fade.
      if (i < N - 1) tl.set(w, { opacity: 0 }, at + beat);
    });
    const last = 0.1 + (N - 1) * beat;
    tl.to(ws[N - 1], { scale: 1.05, duration: Math.max(0.3, D - last - 0.6), ease: 'sine.inOut' }, last + 0.3)
      .set(ws[N - 1], { opacity: 0 }, D - 0.06);`
  return page(f, css, body, script, p)
}

function chunk<T>(items: T[], size: number) {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

// ─── Stat counter ────────────────────────────────────────────────────────
// Tabular figures that count up, a hairline dial that draws with a different ease, a tracked label.

function counter(p: Record<string, unknown>, f: Frame) {
  const accent = color(p.accent, '#d6ee00')
  const value = num(p.value, 87)
  const decimals = Math.max(0, Math.min(3, Math.round(num(p.decimals, Number.isInteger(value) ? 0 : 1))))
  const suffix = String(p.suffix ?? '%')
  const pct = suffix.trim() === '%' ? Math.max(0, Math.min(1, value / 100)) : 1
  const R = 170
  const C = 2 * Math.PI * R
  const css = `
    .counter { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; color: #fff; }
    .dial { position: relative; width: calc(400px * var(--s)); height: calc(400px * var(--s)); display: grid; place-items: center; }
    .dial svg { position: absolute; inset: 0; width: 100%; height: 100%; transform: rotate(-90deg); overflow: visible; }
    .track { fill: none; stroke: rgba(255,255,255,0.16); stroke-width: 1.5; }
    .arc { fill: none; stroke: ${accent}; stroke-width: 4; stroke-linecap: round; stroke-dasharray: ${C}; stroke-dashoffset: ${C}; }
    .value { font-family: ${stack(p.font, 'tech')}; font-size: calc(124px * var(--s)); font-weight: 600; letter-spacing: -0.04em; font-variant-numeric: tabular-nums; line-height: 1; ${SHADOW} }
    .value small { font-size: 0.4em; font-weight: 500; letter-spacing: -0.01em; color: ${accent}; margin-left: 0.06em; }
    .value .pre { font-size: 0.5em; font-weight: 500; color: rgba(255,255,255,0.72); margin-right: 0.04em; }
    .label { margin-top: calc(38px * var(--s)); font-family: ${FONT_STACKS.sans}; font-size: calc(19px * var(--s)); font-weight: 600; letter-spacing: 0.22em; text-transform: uppercase; color: rgba(255,255,255,0.78); ${SHADOW} }`
  const body = `
    <div class="counter">
      <div class="dial">
        <svg viewBox="-200 -200 400 400"><circle class="track" r="${R}"/><circle class="arc" r="${R}"/></svg>
        <div class="value">${p.prefix ? `<span class="pre">${esc(p.prefix)}</span>` : ''}<span class="num">0</span>${suffix ? `<small>${esc(suffix)}</small>` : ''}</div>
      </div>
      ${p.label ? `<div class="label"><span class="mask"><span>${esc(p.label)}</span></span></div>` : ''}
    </div>`
  const script = `
    const numEl = document.querySelector('.num');
    const fmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: ${decimals}, maximumFractionDigits: ${decimals} });
    const o = { v: 0 };
    const count = Math.min(1.8, Math.max(0.8, D * 0.35));
    gsap.set('.label .mask > span', { yPercent: 110 });
    tl.from('.track', { opacity: 0, duration: 0.5, ease: 'power1.out' }, 0)
      .to(o, { v: ${value}, duration: count, ease: 'expo.out', onUpdate: () => { numEl.textContent = fmt.format(o.v); } }, 0.2)
      .to('.arc', { strokeDashoffset: ${C * (1 - pct)}, duration: count + 0.3, ease: 'power2.inOut' }, 0.15)
      .to('.label .mask > span', { yPercent: 0, duration: 0.7, ease: 'power2.out' }, 0.55)
      .to('.label .mask > span', { yPercent: -110, duration: 0.3, ease: 'power2.in' }, D - 0.5)
      .to('.value, .dial svg', { opacity: 0, duration: 0.3, ease: 'power2.in' }, D - 0.38);`
  return page(f, css, body, script, p)
}

// ─── Pull quote ──────────────────────────────────────────────────────────

function quote(p: Record<string, unknown>, f: Frame) {
  const accent = color(p.accent, '#d6ee00')
  const fontKey = p.font ?? 'editorial'
  const text = String(p.text ?? 'Simplicity is the ultimate sophistication.')
  const words = text.split(/\s+/).filter(Boolean).length
  const css = `
    .q { position: absolute; left: 12%; right: 12%; top: 50%; transform: translateY(-50%); color: #fff; }
    .mark { font-family: ${FONT_STACKS.editorial}; font-size: calc(170px * var(--s)); line-height: 0.6; color: ${accent}; height: calc(70px * var(--s)); ${SHADOW} }
    .text { font-family: ${stack(fontKey, 'editorial')}; font-size: calc(62px * var(--s)); font-weight: ${isSerif(fontKey) ? 360 : 560}; line-height: 1.16; letter-spacing: -0.012em; text-wrap: balance; ${SHADOW} }
    .by { margin-top: calc(34px * var(--s)); font-family: ${FONT_STACKS.sans}; font-size: calc(18px * var(--s)); font-weight: 600; letter-spacing: 0.24em; text-transform: uppercase; color: rgba(255,255,255,0.75); ${SHADOW} }
    .by .mask > span::before { content: ''; display: inline-block; width: calc(36px * var(--s)); height: calc(1.5px * var(--s)); background: ${accent}; vertical-align: middle; margin-right: calc(14px * var(--s)); }`
  const body = `
    <div class="q">
      <div class="mark">“</div>
      <div class="text">${maskedWords(text)}</div>
      ${p.author ? `<div class="by"><span class="mask"><span>${esc(p.author)}</span></span></div>` : ''}
    </div>`
  const script = `
    gsap.set('.mask > span', { yPercent: 110 });
    tl.from('.mark', { opacity: 0, y: 12, duration: 0.7, ease: 'power2.out' }, 0)
      .to('.text .w', { yPercent: 0, duration: 0.9, ease: 'expo.out', stagger: 0.035 }, 0.2)
      .to('.by .mask > span', { yPercent: 0, duration: 0.7, ease: 'power2.out' }, ${(0.5 + 0.035 * words).toFixed(2)})
      .to('.text .w, .by .mask > span', { yPercent: -110, duration: 0.4, ease: 'power3.in', stagger: 0.01 }, D - 0.62)
      .to('.mark', { opacity: 0, duration: 0.3, ease: 'power2.in' }, D - 0.4);`
  return page(f, css, body, script, p)
}

// ─── Chapter marker ──────────────────────────────────────────────────────

function chapter(p: Record<string, unknown>, f: Frame) {
  const accent = color(p.accent, '#d6ee00')
  const css = `
    .ch { position: absolute; left: calc(120px * var(--s)); bottom: calc(140px * var(--s)); color: #fff; }
    .num { font-family: ${FONT_STACKS.mono}; font-size: calc(20px * var(--s)); font-weight: 500; letter-spacing: 0.18em; color: ${accent}; ${SHADOW} }
    .rule { width: calc(240px * var(--s)); height: calc(1.5px * var(--s)); background: rgba(255,255,255,0.85); margin: calc(16px * var(--s)) 0 calc(18px * var(--s)); transform: scaleX(0); transform-origin: 0 50%; }
    .title { font-family: ${stack(p.font, 'display')}; font-size: calc(76px * var(--s)); font-weight: 650; letter-spacing: -0.03em; line-height: 1; text-wrap: balance; ${SHADOW} }`
  const body = `
    <div class="ch">
      <div class="num"><span class="mask"><span>${esc(p.number ?? '01')}</span></span></div>
      <div class="rule"></div>
      <div class="title">${maskedWords(String(p.title ?? 'Chapter title'))}</div>
    </div>`
  const script = `
    gsap.set('.mask > span', { yPercent: 110 });
    tl.to('.num .mask > span', { yPercent: 0, duration: 0.5, ease: 'power2.out' }, 0.05)
      .to('.rule', { scaleX: 1, duration: 0.8, ease: 'power3.inOut' }, 0.12)
      .to('.title .w', { yPercent: 0, duration: 0.9, ease: 'expo.out', stagger: 0.06 }, 0.3)
      .to('.title .w', { yPercent: -110, duration: 0.38, ease: 'power3.in', stagger: 0.02 }, D - 0.55)
      .to('.rule', { scaleX: 0, transformOrigin: '100% 50%', duration: 0.34, ease: 'power2.in' }, D - 0.45)
      .to('.num .mask > span', { yPercent: -110, duration: 0.3, ease: 'power2.in' }, D - 0.4);`
  return page(f, css, body, script, p)
}

// ─── Entry ───────────────────────────────────────────────────────────────

export const TEMPLATE_DURATION: Record<Exclude<MotionTemplate, 'custom'>, number> = {
  'lower-third': 5,
  'title-card': 4,
  kinetic: 4,
  counter: 4,
  quote: 6,
  chapter: 3.5,
}

export const TEMPLATE_NAMES: Record<MotionTemplate, string> = {
  'lower-third': 'Lower third',
  'title-card': 'Title card',
  kinetic: 'Kinetic type',
  counter: 'Stat counter',
  quote: 'Pull quote',
  chapter: 'Chapter marker',
  custom: 'Motion graphic',
}

/** How long a template stays up when no length is asked for: its default, or longer when it has a lot to read. */
export function templateDuration(template: Exclude<MotionTemplate, 'custom'>, params: Record<string, unknown>) {
  const words = [params.title, params.name, params.text, params.subtitle, params.label, params.author].filter((v) => typeof v === 'string').join(' ')
  const motion = template === 'kinetic' ? 1.2 : 1.6
  return Math.max(TEMPLATE_DURATION[template], Math.round((readingTime(words) + motion) * 10) / 10)
}

export function buildTemplate(template: Exclude<MotionTemplate, 'custom'>, params: Record<string, unknown>, frame: Frame) {
  switch (template) {
    case 'lower-third':
      return lowerThird(params, frame)
    case 'title-card':
      return titleCard(params, frame)
    case 'kinetic':
      return kinetic(params, frame)
    case 'counter':
      return counter(params, frame)
    case 'quote':
      return quote(params, frame)
    case 'chapter':
      return chapter(params, frame)
  }
}
