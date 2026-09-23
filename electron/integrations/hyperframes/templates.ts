import fs from 'node:fs'
import type { MotionTemplate } from '../../../shared/integrations'
import { packageFile } from '../paths'

/**
 * Motion-graphics templates, authored as HyperFrames compositions: plain
 * HTML + CSS, animated by a paused GSAP timeline registered on
 * window.__timelines so the runtime can seek it frame-exactly.
 * Backgrounds stay transparent — these render as overlays.
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

/** Lumen's fonts, inlined: a file:// page can't load file:// fonts (CORS), data: URLs always work. */
function fontFaces() {
  if (faces) return faces
  const data = (pkg: string, file: string) => `data:font/woff2;base64,${fs.readFileSync(packageFile(pkg, file)).toString('base64')}`
  faces = `
    @font-face { font-family: 'Geist'; font-weight: 100 900; src: url('${data('@fontsource-variable/geist', 'files/geist-latin-wght-normal.woff2')}') format('woff2'); }
    @font-face { font-family: 'Bricolage Grotesque'; font-weight: 200 800; src: url('${data('@fontsource-variable/bricolage-grotesque', 'files/bricolage-grotesque-latin-wght-normal.woff2')}') format('woff2'); }
    @font-face { font-family: 'Instrument Serif'; font-style: normal; src: url('${data('@fontsource/instrument-serif', 'files/instrument-serif-latin-400-normal.woff2')}') format('woff2'); }
    @font-face { font-family: 'Instrument Serif'; font-style: italic; src: url('${data('@fontsource/instrument-serif', 'files/instrument-serif-latin-400-italic.woff2')}') format('woff2'); }`
  return faces
}

const FONT_STACKS: Record<string, string> = {
  sans: "'Geist', system-ui, sans-serif",
  display: "'Bricolage Grotesque', 'Geist', sans-serif",
  serif: "'Instrument Serif', Georgia, serif",
}

interface Frame {
  width: number
  height: number
  duration: number
}

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
body { --s: ${s}; -webkit-font-smoothing: antialiased; text-rendering: geometricPrecision; }
#stage { position: relative; width: 100%; height: 100%; overflow: hidden; }
.clip { position: absolute; inset: 0; visibility: hidden; }
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

// ─── Lower third ─────────────────────────────────────────────────────────

function lowerThird(p: Record<string, unknown>, f: Frame) {
  const accent = color(p.accent, '#d6ee00')
  const accent2 = color(p.accent2, '#5ef2a6')
  const right = p.align === 'right'
  const font = FONT_STACKS[String(p.font ?? 'sans')] ?? FONT_STACKS.sans
  const radius = Math.round(18 * (Math.min(f.width, f.height) / 1080) * 10) / 10
  const css = `
    .lt { position: absolute; ${right ? 'right' : 'left'}: calc(110px * var(--s)); bottom: calc(140px * var(--s)); display: flex; flex-direction: ${right ? 'row-reverse' : 'row'}; align-items: stretch; gap: calc(16px * var(--s)); font-family: ${font}; }
    .bar { width: calc(7px * var(--s)); border-radius: 99px; background: linear-gradient(180deg, ${accent}, ${accent2}); transform-origin: 50% 100%; box-shadow: 0 0 calc(24px * var(--s)) ${accent}88; }
    .panel { position: relative; padding: calc(20px * var(--s)) calc(34px * var(--s)) calc(22px * var(--s)) calc(28px * var(--s)); border-radius: calc(18px * var(--s)); background: linear-gradient(120deg, rgba(12,13,10,0.78), rgba(22,24,16,0.62)); box-shadow: inset 0 0 0 1px rgba(255,255,255,0.08), 0 calc(20px * var(--s)) calc(60px * var(--s)) rgba(0,0,0,0.45); clip-path: inset(0 100% 0 0 round ${radius}px); text-align: ${right ? 'right' : 'left'}; }
    .line { overflow: hidden; }
    .line span { display: inline-block; will-change: transform; }
    .name { font-size: calc(56px * var(--s)); font-weight: 700; letter-spacing: -0.02em; color: #fff; line-height: 1.1; }
    .role { margin-top: calc(6px * var(--s)); font-size: calc(26px * var(--s)); font-weight: 500; letter-spacing: 0.01em; color: rgba(255,255,255,0.7); }
    .role b { color: ${accent}; font-weight: 600; }
    .glint { position: absolute; inset: 0; border-radius: inherit; background: linear-gradient(100deg, transparent 30%, rgba(255,255,255,0.14) 50%, transparent 70%); background-size: 250% 100%; background-position: 120% 0; }`
  const body = `
    <div class="lt">
      <div class="bar"></div>
      <div class="panel">
        <div class="glint"></div>
        <div class="line name"><span>${esc(p.name ?? 'Your Name')}</span></div>
        <div class="line role"><span>${esc(p.title ?? '')}</span></div>
      </div>
    </div>`
  const script = `
    const R = '${radius}px';
    gsap.set('.line span', { yPercent: 115 });
    tl.from('.bar', { scaleY: 0, duration: 0.55, ease: 'power3.out' }, 0.1)
      .to('.panel', { clipPath: 'inset(0 0% 0 0 round ' + R + ')', duration: 0.8, ease: 'power4.out' }, 0.22)
      .to('.name span', { yPercent: 0, duration: 0.8, ease: 'power4.out' }, 0.38)
      .to('.role span', { yPercent: 0, duration: 0.7, ease: 'power3.out' }, 0.52)
      .to('.glint', { backgroundPosition: '-120% 0', duration: 1.1, ease: 'power2.inOut' }, 0.9)
      .to('.line span', { yPercent: -115, duration: 0.45, ease: 'power2.in', stagger: 0.06 }, D - 0.8)
      .to('.panel', { clipPath: 'inset(0 0 0 100% round ' + R + ')', duration: 0.5, ease: 'power3.in' }, D - 0.62)
      .to('.bar', { scaleY: 0, transformOrigin: '50% 0%', duration: 0.35, ease: 'power2.in' }, D - 0.4);`
  return page(f, css, body, script, p)
}

// ─── Title card ──────────────────────────────────────────────────────────

function titleCard(p: Record<string, unknown>, f: Frame) {
  const accent = color(p.accent, '#d6ee00')
  const fg = color(p.color, '#ffffff')
  const fontKey = String(p.font ?? 'display')
  const font = FONT_STACKS[fontKey] ?? FONT_STACKS.display
  const serif = fontKey === 'serif'
  const title = String(p.title ?? 'Your Title')
  const chars = [...title].map((c) => (c === ' ' ? '<span class="ch sp">&nbsp;</span>' : `<span class="ch">${esc(c)}</span>`)).join('')
  const css = `
    .card { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; font-family: ${font}; color: ${fg}; text-align: center; perspective: calc(900px * var(--s)); }
    .eyebrow { font-family: 'Geist', sans-serif; font-size: calc(22px * var(--s)); font-weight: 600; letter-spacing: 0.32em; text-transform: uppercase; color: ${accent}; margin-bottom: calc(18px * var(--s)); }
    .title { font-size: calc(${serif ? 190 : 150}px * var(--s)); font-weight: ${serif ? 400 : 750}; ${serif ? 'font-style: italic;' : ''} letter-spacing: ${serif ? '-0.01em' : '-0.035em'}; line-height: 1; white-space: nowrap; text-shadow: 0 calc(10px * var(--s)) calc(40px * var(--s)) rgba(0,0,0,0.35); }
    .ch { display: inline-block; transform-origin: 50% 100%; will-change: transform, opacity, filter; }
    .rule { width: calc(420px * var(--s)); height: calc(3px * var(--s)); margin-top: calc(34px * var(--s)); border-radius: 99px; background: linear-gradient(90deg, transparent, ${accent}, transparent); transform: scaleX(0); }
    .sub { margin-top: calc(22px * var(--s)); font-family: 'Geist', sans-serif; font-size: calc(30px * var(--s)); font-weight: 400; color: rgba(255,255,255,0.78); letter-spacing: 0.01em; }`
  const body = `
    <div class="card">
      ${p.eyebrow ? `<div class="eyebrow">${esc(p.eyebrow)}</div>` : ''}
      <h1 class="title">${chars}</h1>
      <div class="rule"></div>
      ${p.subtitle ? `<p class="sub">${esc(p.subtitle)}</p>` : ''}
    </div>`
  const script = `
    const chars = gsap.utils.toArray('.ch');
    tl.from('.eyebrow', { opacity: 0, letterSpacing: '0.6em', duration: 1, ease: 'power3.out' }, 0.05)
      .from(chars, { yPercent: 110, rotateX: -85, opacity: 0, filter: 'blur(14px)', duration: 1.05, ease: 'expo.out', stagger: 0.045 }, 0.15)
      .to('.rule', { scaleX: 1, duration: 1.1, ease: 'expo.out' }, 0.55)
      .from('.sub', { opacity: 0, y: 24, filter: 'blur(8px)', duration: 0.9, ease: 'power3.out' }, 0.75)
      // A shimmer rolls through the letters once they have landed.
      .to(chars, { color: '${accent}', duration: 0.22, ease: 'sine.inOut', stagger: 0.035, yoyo: true, repeat: 1 }, 1.35)
      .to(chars, { yPercent: -60, opacity: 0, filter: 'blur(10px)', duration: 0.5, ease: 'power2.in', stagger: 0.025 }, D - 0.9)
      .to('.rule', { scaleX: 0, duration: 0.45, ease: 'power2.in' }, D - 0.7)
      .to('.sub, .eyebrow', { opacity: 0, y: -10, duration: 0.4, ease: 'power2.in' }, D - 0.75);`
  return page(f, css, body, script, p)
}

// ─── Kinetic typography ──────────────────────────────────────────────────

function kinetic(p: Record<string, unknown>, f: Frame) {
  const accent = color(p.accent, '#facc15')
  const fg = color(p.color, '#ffffff')
  const font = FONT_STACKS[String(p.font ?? 'display')] ?? FONT_STACKS.display
  const words = String(p.text ?? 'Make every frame count')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 24)
  const stack = p.style === 'stack'
  const css = stack
    ? `
    .wrap { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: calc(4px * var(--s)); font-family: ${font}; }
    .row { overflow: hidden; padding: 0 calc(10px * var(--s)); }
    .w { display: inline-block; font-size: calc(128px * var(--s)); font-weight: 800; letter-spacing: -0.04em; line-height: 1.02; color: ${fg}; text-transform: uppercase; text-shadow: 0 calc(8px * var(--s)) calc(30px * var(--s)) rgba(0,0,0,0.35); }
    .w.hot { color: ${accent}; }`
    : `
    .wrap { position: absolute; inset: 0; font-family: ${font}; }
    .w { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); white-space: nowrap; font-size: calc(190px * var(--s)); font-weight: 800; letter-spacing: -0.045em; color: ${fg}; text-transform: uppercase; opacity: 0; text-shadow: 0 calc(12px * var(--s)) calc(40px * var(--s)) rgba(0,0,0,0.35); }
    .w.hot { color: ${accent}; }
    .under { position: absolute; left: 50%; top: calc(50% + 110px * var(--s)); width: calc(360px * var(--s)); height: calc(12px * var(--s)); margin-left: calc(-180px * var(--s)); border-radius: 99px; background: ${accent}; transform: scaleX(0); transform-origin: 0 50%; }`
  // Emphasise the last word (and any word wrapped in *stars*).
  const items = words.map((w, i) => ({ text: w.replace(/\*/g, ''), hot: /^\*.*\*$/.test(w) || i === words.length - 1 }))
  const body = stack
    ? `<div class="wrap">${chunk(items, 2)
        .map((row) => `<div class="row">${row.map((w) => `<span class="w${w.hot ? ' hot' : ''}">${esc(w.text)}</span>`).join(' ')}</div>`)
        .join('')}</div>`
    : `<div class="wrap">${items.map((w) => `<span class="w${w.hot ? ' hot' : ''}">${esc(w.text)}</span>`).join('')}<div class="under"></div></div>`
  const script = stack
    ? `
    const rows = gsap.utils.toArray('.row');
    const beat = Math.max(0.28, (D - 1.4) / rows.length);
    rows.forEach((row, i) => {
      tl.from(row.children, { yPercent: 105, duration: 0.55, ease: 'expo.out', stagger: 0.06 }, 0.15 + i * beat);
      if (i > 0) tl.to(rows.slice(0, i), { opacity: 0.38, duration: 0.3, ease: 'power2.out' }, 0.15 + i * beat);
    });
    tl.to(rows, { opacity: 1, duration: 0.3 }, D - 1.05)
      .to('.w', { yPercent: -105, duration: 0.45, ease: 'power3.in', stagger: 0.03 }, D - 0.7);`
    : `
    const ws = gsap.utils.toArray('.w');
    const beat = Math.max(0.22, (D - 1.1) / ws.length);
    ws.forEach((w, i) => {
      const at = 0.12 + i * beat;
      tl.fromTo(w, { opacity: 0, scale: 1.7, filter: 'blur(16px)' }, { opacity: 1, scale: 1, filter: 'blur(0px)', duration: 0.3, ease: 'expo.out' }, at);
      if (i < ws.length - 1) tl.to(w, { opacity: 0, scale: 0.82, filter: 'blur(8px)', duration: 0.16, ease: 'power2.in' }, at + beat - 0.14);
    });
    const end = 0.12 + (ws.length - 1) * beat;
    tl.to('.under', { scaleX: 1, duration: 0.5, ease: 'expo.out' }, end + 0.15)
      .to(ws[ws.length - 1], { scale: 1.06, duration: Math.max(0.3, D - end - 0.9), ease: 'none' }, end + 0.3)
      .to([ws[ws.length - 1], '.under'], { opacity: 0, y: -30, filter: 'blur(10px)', duration: 0.4, ease: 'power2.in' }, D - 0.5);`
  return page(f, css, body, script, p)
}

function chunk<T>(items: T[], size: number) {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

// ─── Stat counter ────────────────────────────────────────────────────────

function counter(p: Record<string, unknown>, f: Frame) {
  const accent = color(p.accent, '#34d399')
  const value = num(p.value, 87)
  const decimals = Math.max(0, Math.min(3, Math.round(num(p.decimals, Number.isInteger(value) ? 0 : 1))))
  const suffix = String(p.suffix ?? '%')
  const pct = suffix.trim() === '%' ? Math.max(0, Math.min(1, value / 100)) : 1
  const R = 170
  const C = 2 * Math.PI * R
  const css = `
    .counter { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; font-family: 'Geist', sans-serif; color: #fff; }
    .dial { position: relative; width: calc(400px * var(--s)); height: calc(400px * var(--s)); display: grid; place-items: center; }
    .dial svg { position: absolute; inset: 0; width: 100%; height: 100%; transform: rotate(-90deg); overflow: visible; }
    .track { fill: none; stroke: rgba(255,255,255,0.1); stroke-width: 16; }
    .arc { fill: none; stroke: url(#g); stroke-width: 16; stroke-linecap: round; stroke-dasharray: ${C}; stroke-dashoffset: ${C}; filter: drop-shadow(0 0 14px ${accent}99); }
    .value { font-size: calc(128px * var(--s)); font-weight: 750; letter-spacing: -0.05em; font-variant-numeric: tabular-nums; line-height: 1; text-shadow: 0 calc(8px * var(--s)) calc(30px * var(--s)) rgba(0,0,0,0.35); }
    .value small { font-size: 0.42em; font-weight: 600; letter-spacing: -0.01em; color: ${accent}; margin-left: 0.06em; }
    .value .pre { font-size: 0.55em; font-weight: 600; color: rgba(255,255,255,0.7); margin-right: 0.04em; }
    .label { margin-top: calc(34px * var(--s)); font-size: calc(30px * var(--s)); font-weight: 500; color: rgba(255,255,255,0.78); letter-spacing: 0.01em; }`
  const body = `
    <div class="counter">
      <div class="dial">
        <svg viewBox="-200 -200 400 400"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${accent}"/><stop offset="1" stop-color="${color(p.accent2, '#22d3ee')}"/></linearGradient></defs>
          <circle class="track" r="${R}"/><circle class="arc" r="${R}"/></svg>
        <div class="value">${p.prefix ? `<span class="pre">${esc(p.prefix)}</span>` : ''}<span class="num">0</span>${suffix ? `<small>${esc(suffix)}</small>` : ''}</div>
      </div>
      ${p.label ? `<div class="label">${esc(p.label)}</div>` : ''}
    </div>`
  const script = `
    const numEl = document.querySelector('.num');
    const fmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: ${decimals}, maximumFractionDigits: ${decimals} });
    const o = { v: 0 };
    tl.from('.dial', { scale: 0.6, opacity: 0, duration: 0.8, ease: 'back.out(1.6)' }, 0.05)
      .to(o, { v: ${value}, duration: Math.min(2.2, D * 0.5), ease: 'power3.out', onUpdate: () => { numEl.textContent = fmt.format(o.v); } }, 0.25)
      .to('.arc', { strokeDashoffset: ${C * (1 - pct)}, duration: Math.min(2.2, D * 0.5), ease: 'power3.out' }, 0.25)
      .from('.label', { opacity: 0, y: 20, duration: 0.7, ease: 'power3.out' }, 0.6)
      .to('.counter', { opacity: 0, scale: 0.94, filter: 'blur(8px)', duration: 0.45, ease: 'power2.in' }, D - 0.5);`
  return page(f, css, body, script, p)
}

// ─── Entry ───────────────────────────────────────────────────────────────

export const TEMPLATE_DURATION: Record<Exclude<MotionTemplate, 'custom'>, number> = {
  'lower-third': 5,
  'title-card': 4,
  kinetic: 4,
  counter: 4,
}

export const TEMPLATE_NAMES: Record<MotionTemplate, string> = {
  'lower-third': 'Lower third',
  'title-card': 'Title card',
  kinetic: 'Kinetic type',
  counter: 'Stat counter',
  custom: 'Motion graphic',
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
  }
}
