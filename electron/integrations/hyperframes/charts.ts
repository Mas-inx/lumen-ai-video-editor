import { chartData, chartKind, type ChartDatum } from '../../../shared/motion'
import { color, DROP_SHADOW, esc, FONT_STACKS, js, maskedWords, num, page, readingTime, SHADOW, stack, type Frame } from './page'

// ─── Charts ──────────────────────────────────────────────────────────────
// Animated infographics from real numbers, laid out from the data: a scale
// with round ticks chosen for its range, labels that fit, one item picked out.
// bar: bars grow from the baseline as their values count up — vertical, or
// horizontal when the labels are long. line: the line draws itself, its area
// follows, the points pop in at the end and the last (or highlighted) value is
// called out. donut: a ring fills as its number counts up — or, given data,
// splits into segments with a legend.

/**
 * Round ticks for a range: a step of 1, 2, 2.5 or 5 × 10ⁿ giving close to
 * `target` intervals with little wasted headroom. Zero is always a tick when
 * the range spans it.
 */
export function niceScale(lo: number, hi: number, target = 5) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) [lo, hi] = [0, 1]
  if (lo > hi) [lo, hi] = [hi, lo]
  if (lo === hi) {
    if (lo > 0) lo = 0
    else if (hi < 0) hi = 0
    else hi = 1
  }
  const mag = 10 ** Math.floor(Math.log10((hi - lo) / target))
  let best = { step: mag, min: 0, max: 0, score: Infinity }
  for (const m of [0.5, 1, 2, 2.5, 5, 10, 20]) {
    const step = m * mag
    const min = Math.floor(lo / step + 1e-9) * step
    const max = Math.ceil(hi / step - 1e-9) * step
    const intervals = Math.round((max - min) / step)
    const waste = 1 - (hi - lo) / (max - min)
    const score = Math.abs(intervals - target) + 4 * waste
    if (score < best.score - 1e-9) best = { step, min, max, score }
  }
  const decimals = decimalsOf(best.step)
  const fix = (v: number) => Number(v.toFixed(decimals)) || 0
  const ticks: number[] = []
  for (let i = 0; i <= Math.round((best.max - best.min) / best.step); i++) ticks.push(fix(best.min + i * best.step))
  return { min: fix(best.min), max: fix(best.max), step: fix(best.step), ticks, decimals }
}

const decimalsOf = (v: number) => {
  const text = Math.abs(v).toFixed(10).replace(/0+$/, '')
  return Math.min(6, text.length - text.indexOf('.') - 1)
}

export interface NumberStyle {
  decimals: number
  /** 1.2M rather than 1,200,000. */
  compact: boolean
  prefix: string
  suffix: string
}

/** A value as the chart shows it: grouped, with a real minus sign and its unit. */
export function formatNumber(v: number, f: NumberStyle) {
  const options: Intl.NumberFormatOptions = f.compact ? { notation: 'compact', maximumFractionDigits: 1 } : { minimumFractionDigits: f.decimals, maximumFractionDigits: f.decimals }
  const body = new Intl.NumberFormat('en-US', options).format(Math.abs(v))
  return `${v < 0 && /[1-9]/.test(body) ? '−' : ''}${f.prefix}${body}${f.suffix}`
}

// The page's copy of formatNumber, for the count-ups.
const FORMAT_JS = String.raw`
const formatters = {};
function formatNumber(v, f) {
  const key = f.compact ? 'c' : 'd' + f.decimals;
  const nf = formatters[key] || (formatters[key] = new Intl.NumberFormat('en-US', f.compact ? { notation: 'compact', maximumFractionDigits: 1 } : { minimumFractionDigits: f.decimals, maximumFractionDigits: f.decimals }));
  const body = nf.format(Math.abs(v));
  return (v < 0 && /[1-9]/.test(body) ? '−' : '') + f.prefix + body + f.suffix;
}`

/** Roughly how wide a line of text sets — for layout decisions made before the page exists. */
const textWidth = (chars: number, px: number, em = 0.56) => chars * px * em

const rgba = (hex: string, a: number) => {
  let h = hex.slice(1)
  if (h.length <= 4) h = [...h].map((c) => c + c).join('')
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`
}

const MAGNITUDE = /^(k|K|M|mn|B|bn|T)$/

/** What a chart's params say, read once: the data, how its numbers look, which item is picked out. */
export function chartSpec(p: Record<string, unknown>) {
  const kind = chartKind(p.kind ?? p.type)
  const data = chartData(p)
  const items = data.items
  // An empty field means "not set": the unit the data was written with still shows.
  const text = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined)
  let suffix = text(p.suffix) ?? text(p.unit) ?? data.suffix
  // A word unit reads "12 km"; a symbol, "12%".
  if (/^[a-z]{2,}/i.test(suffix) && !MAGNITUDE.test(suffix)) suffix = ` ${suffix}`
  const prefix = text(p.prefix) ?? data.prefix
  const single = num(p.value, NaN)
  const lone = kind === 'donut' && Number.isFinite(single)
  const largest = Math.max(0, ...items.map((d) => Math.abs(d.value)), lone ? Math.abs(single) : 0)
  const explicit = p.decimals !== undefined && p.decimals !== null && p.decimals !== ''
  const decimals = Math.max(0, Math.min(3, Math.round(num(p.decimals, lone ? Math.min(1, decimalsOf(single)) : data.decimals))))
  const format: NumberStyle = { decimals, compact: !explicit && largest >= 100_000, prefix, suffix }
  return { kind, items, format, highlight: pickOut(p.highlight, items), single }
}

type Spec = ReturnType<typeof chartSpec>

/** The item a highlight names: its label, or max, min, first or last. */
function pickOut(h: unknown, items: ChartDatum[]) {
  if (h === undefined || h === null || h === '' || !items.length) return -1
  const key = String(h).trim().toLowerCase()
  const values = items.map((d) => d.value)
  if (key === 'max') return values.indexOf(Math.max(...values))
  if (key === 'min') return values.indexOf(Math.min(...values))
  if (key === 'first') return 0
  if (key === 'last') return items.length - 1
  return items.findIndex((d) => d.label.toLowerCase() === key)
}

/** How long a chart stays up: time to read its words, a moment per item, and the motion. */
export function chartDuration(p: Record<string, unknown>) {
  const { items } = chartSpec(p)
  const words = [p.title, p.subtitle, p.label, p.source].filter((v) => typeof v === 'string').join(' ')
  return Math.min(24, Math.round((readingTime(words) + 0.25 * Math.min(items.length, 16) + 2.6) * 10) / 10)
}

interface Geometry {
  s: number
  fg: string
  accent: string
  /** The chart's measure and its plot's height, in px. */
  width: number
  height: number
}

interface Plot {
  html: string
  css: string
  config: Record<string, unknown>
}

const px = (v: number) => `${Math.round(v * 10) / 10}px`

export function chart(p: Record<string, unknown>, f: Frame) {
  const spec = chartSpec(p)
  const s = Math.min(f.width, f.height) / 1080
  const donut = spec.kind === 'donut'
  const g: Geometry = {
    s,
    fg: color(p.color, '#ffffff'),
    accent: color(p.accent, '#d6ee00'),
    // Inside the title-safe area, and no wider than a chart reads comfortably.
    width: Math.round(Math.min(f.width * 0.8, (donut ? 1200 : 1480) * s)),
    height: Math.round(Math.min(f.height * 0.48, 540 * s)),
  }
  const plot = spec.kind === 'line' ? linePlot(spec, g) : donut ? donutPlot(spec, g, p) : barPlot(spec, g, p)
  const title = String(p.title ?? '').trim()
  const subtitle = String(p.subtitle ?? '').trim()
  const source = String(p.source ?? '').trim()
  const { fg, accent } = g
  const css = `
    .chart { position: absolute; top: 0; bottom: 0; left: ${Math.round((f.width - g.width) / 2)}px; width: ${g.width}px; display: flex; flex-direction: column; justify-content: center; align-items: ${donut ? 'center' : 'stretch'}; text-align: ${donut ? 'center' : 'left'}; color: ${fg}; }
    .title { font-family: ${stack(p.font, 'tech')}; font-size: calc(48px * var(--s)); font-weight: 600; letter-spacing: -0.022em; line-height: 1.08; text-wrap: balance; ${DROP_SHADOW} }
    .subtitle { margin-top: calc(10px * var(--s)); font-family: ${FONT_STACKS.sans}; font-size: calc(22px * var(--s)); font-weight: 420; color: ${rgba(fg, 0.72)}; ${DROP_SHADOW} }
    .source { margin-top: calc(28px * var(--s)); font-family: ${FONT_STACKS.sans}; font-size: calc(14px * var(--s)); font-weight: 560; letter-spacing: 0.16em; text-transform: uppercase; color: ${rgba(fg, 0.5)}; ${DROP_SHADOW} }
    .plot { position: relative; flex: none; }
    .mask > * { will-change: auto; }
    .gl { position: absolute; left: 0; right: 0; height: calc(1.5px * var(--s)); background: ${rgba(fg, 0.16)}; transform: scaleX(0); transform-origin: 0 50%; }
    .gl.base { background: ${rgba(fg, 0.62)}; }
    .ticks { position: absolute; inset: 0; ${DROP_SHADOW} }
    .tk { position: absolute; left: 0; font-family: ${FONT_STACKS.mono}; font-size: calc(15px * var(--s)); font-weight: 500; letter-spacing: 0.02em; font-variant-numeric: tabular-nums; line-height: 1; color: ${rgba(fg, 0.55)}; white-space: nowrap; }
    .cat { position: absolute; font-family: ${FONT_STACKS.sans}; font-weight: 500; line-height: 1.2; color: ${rgba(fg, 0.8)}; ${DROP_SHADOW} }
    .cat .mask { display: block; }
    .cat.hot { color: ${accent}; }
    .val { position: absolute; font-family: ${stack(p.font, 'tech')}; font-weight: 600; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; white-space: nowrap; line-height: 1; ${SHADOW} }
    .val.hot { color: ${accent}; }
    ${plot.css}`
  const body = `
    <div class="chart">
      ${title || subtitle ? `<header>${title ? `<h1 class="title">${maskedWords(title)}</h1>` : ''}${subtitle ? `<p class="subtitle"><span class="mask"><span>${esc(subtitle)}</span></span></p>` : ''}</header>` : ''}
      ${plot.html}
      ${source ? `<p class="source"><span class="mask"><span>${esc(source)}</span></span></p>` : ''}
    </div>`
  const config = { kind: spec.kind, format: spec.format, words: title.split(/\s+/).filter(Boolean).length, ...plot.config }
  return page(f, css, body, `const C = ${js(config)};\n${FORMAT_JS}\n${RUNTIME}`, p)
}

/** Ticks only where there's data to read against: an empty chart keeps just its baseline. */
function axis(scale: ReturnType<typeof niceScale>, format: NumberStyle, empty: boolean) {
  // Ticks carry a short unit ("$", "%") but not a long one ("users").
  const short: NumberStyle = {
    decimals: scale.decimals,
    compact: Math.max(Math.abs(scale.min), Math.abs(scale.max)) >= 10_000,
    prefix: format.prefix.length <= 2 ? format.prefix : '',
    suffix: format.suffix.length <= 2 && !format.suffix.startsWith(' ') ? format.suffix : '',
  }
  return (empty ? [0] : scale.ticks).map((v) => ({ v, label: empty ? '' : v === 0 ? '0' : formatNumber(v, short) }))
}

/** A value's markup: the number, unit and all, counts up in place. */
const valueHtml = (f: NumberStyle) => `<span class="num">${esc(formatNumber(0, f))}</span>`

/** A big number set in parts: the unit's prefix and suffix smaller than the figure, which counts up between them. */
const figureHtml = (f: NumberStyle) => `${f.prefix ? `<span class="pre">${esc(f.prefix)}</span>` : ''}<span class="num">${esc(formatNumber(0, counting(f)))}</span>${f.suffix ? `<span class="suf">${esc(f.suffix)}</span>` : ''}`

const counting = (f: NumberStyle): NumberStyle => ({ ...f, prefix: '', suffix: '' })

/** The type's soft, close shadow, for bars: they read over bright footage too, and it's nothing over dark. */
const BAR_SHADOW = 'box-shadow: 0 calc(1px * var(--s)) calc(2px * var(--s)) rgba(0,0,0,0.16), 0 calc(4px * var(--s)) calc(18px * var(--s)) rgba(0,0,0,0.22);'

// ─── Bars ────────────────────────────────────────────────────────────────

function barPlot(spec: Spec, g: Geometry, p: Record<string, unknown>): Plot {
  const { items, format, highlight } = spec
  const { s } = g
  const n = items.length
  const values = items.map((d) => d.value)
  const scale = niceScale(Math.min(0, ...values), Math.max(0, ...values), 5)
  const ticks = axis(scale, format, !n)
  const finals = items.map((d) => formatNumber(d.value, format))
  const longest = Math.max(0, ...items.map((d) => d.label.length))
  const longestWord = Math.max(0, ...items.flatMap((d) => d.label.split(' ').map((w) => w.length)))
  const catPx = 19 * s
  const gutter = Math.max(0, ...ticks.map((t) => textWidth(t.label.length, 15 * s, 0.62))) + 22 * s
  const room = (g.width - gutter) / Math.max(1, n) - 12 * s
  const wanted = p.orientation === 'horizontal' || p.orientation === 'vertical' ? p.orientation : null
  // Columns while every label fits under its bar in two lines (and its longest word in one); otherwise rows give each label a line of its own.
  // Past sixteen there are too many rows to read: columns, with the labels thinned out.
  const vertical = wanted ? wanted === 'vertical' : n > 16 || (textWidth(longestWord, catPx) <= room && textWidth(longest, catPx) <= room * 1.9)
  const kinds = items.map((d, i) => `${d.value < 0 ? ' neg' : ''}${i === highlight ? ' hot' : ''}`)
  return vertical ? columns(spec, g, scale, ticks, finals, gutter, kinds, longest, longestWord) : rows(spec, g, scale, ticks, finals, kinds, longest)
}

type Ticks = ReturnType<typeof axis>

function columns(spec: Spec, g: Geometry, scale: ReturnType<typeof niceScale>, ticks: Ticks, finals: string[], gutter: number, kinds: string[], longest: number, longestWord: number): Plot {
  const { items, format, highlight } = spec
  const { s } = g
  const n = items.length
  const values = items.map((d) => d.value)
  const H = g.height
  const span = scale.max - scale.min || 1
  const y = (v: number) => (H * (scale.max - v)) / span
  const y0 = y(0)
  const slot = (g.width - gutter) / Math.max(1, n)
  const barW = Math.min(slot * (n <= 3 ? 0.5 : 0.64), 132 * s)
  const valPx = Math.max(14 * s, Math.min(28 * s, slot * 0.34))
  const catPx = 19 * s
  // Values show where they fit; labels thin out when there are more than can be read.
  const showValue = (i: number) => i === highlight || textWidth(finals[i].length, valPx, 0.6) <= slot - 6 * s
  // Labels share a column's width: in one line, or two when they have spaces to break at. When they can't, only every few are
  // shown, each as wide as the columns it stands for.
  const one = textWidth(Math.min(longest, 24), catPx)
  const lines = one <= slot - 10 * s ? 1 : 2
  const fits = lines === 1 || (textWidth(longestWord, catPx) <= slot - 10 * s && one <= (slot - 10 * s) * 1.9)
  const every = fits ? 1 : Math.max(2, Math.ceil((textWidth(Math.min(longestWord, 14), catPx) + 14 * s) / slot))
  const labelW = fits ? slot - 10 * s : Math.min(every * slot - 10 * s, one * 1.2 + 12 * s)
  // The highlighted label always shows; thinned-out neighbours make room for it.
  const shown = (i: number) => i === highlight || (i % every === 0 && (highlight < 0 || highlight % every === 0 || Math.abs(i - highlight) >= every))
  // Room above the plot for the tallest bar's value, and below it for a negative one's.
  const head = 56 * s
  const html = `
    <div class="plot bars" style="width: ${px(g.width)}; height: ${px(H)}; margin-top: ${px(head)}; margin-bottom: ${px(20 * s + lines * catPx * 1.2)};">
      ${ticks.map((t) => `<div class="gl${t.v === 0 ? ' base' : ''}" style="top: ${px(y(t.v))}"></div>`).join('')}
      <div class="ticks">${ticks.map((t) => (t.label ? `<div class="tk" style="top: ${px(y(t.v) - 21 * s)}"><span class="mask"><span>${esc(t.label)}</span></span></div>` : '')).join('')}</div>
      ${items
        .map((_, i) => {
          const v = values[i]
          const len = Math.abs(y(v) - y0)
          // Each column stands on the baseline (or hangs from it): its bar grows from there and its value rides on the bar's end.
          const col = v >= 0 ? `top: ${px(-head)}; height: ${px(y0 + head)};` : `top: ${px(y0)}; height: ${px(H - y0 + head)};`
          const bar = v >= 0 ? `bottom: 0; height: ${px(len)};` : `top: 0; height: ${px(len)};`
          const val = v >= 0 ? `bottom: ${px(len + 10 * s)};` : `top: ${px(len + 9 * s)};`
          return `<div class="col" style="left: ${px(gutter + slot * i)}; width: ${px(slot)}; ${col}">
            <div class="bar b${i}${kinds[i]}" style="left: ${px(slot / 2 - barW / 2)}; width: ${px(barW)}; ${bar}"></div>
            ${showValue(i) ? `<div class="val v${i}${kinds[i]}" style="font-size: ${px(valPx)}; ${val}">${valueHtml(format)}</div>` : ''}
          </div>`
        })
        .join('')}
      ${items
        .map((d, i) => (shown(i) ? `<div class="cat c${i}${i === highlight ? ' hot' : ''}" style="left: ${px(gutter + slot * (i + 0.5) - labelW / 2)}; width: ${px(labelW)}; top: ${px(H + 16 * s)}; font-size: ${px(catPx)};"><span class="mask"><span>${esc(d.label)}</span></span></div>` : ''))
        .join('')}
    </div>`
  const css = `
    .col { position: absolute; }
    .bar { position: absolute; background: ${g.fg}; border-radius: calc(3px * var(--s)) calc(3px * var(--s)) 0 0; ${BAR_SHADOW} }
    .bar.neg { border-radius: 0 0 calc(3px * var(--s)) calc(3px * var(--s)); }
    .bar.hot { background: ${g.accent}; }
    .col .val { left: 0; right: 0; text-align: center; }
    .bars .cat { text-align: center; }
    .bars .cat .mask > span { display: ${lines > 1 && fits ? '-webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; white-space: normal' : 'block; white-space: nowrap'}; overflow: hidden; text-overflow: ellipsis; }`
  return { html, css, config: { bars: n, vertical: true, highlight, values, lengths: values.map((v) => Math.abs(y(v) - y0)), count: format } }
}

function rows(spec: Spec, g: Geometry, scale: ReturnType<typeof niceScale>, ticks: Ticks, finals: string[], kinds: string[], longest: number): Plot {
  const { items, format, highlight } = spec
  const { s } = g
  const n = items.length
  const values = items.map((d) => d.value)
  const rowH = Math.max(42 * s, Math.min(78 * s, g.height / Math.max(1, n)))
  const H = rowH * n
  const labelPx = Math.max(14 * s, Math.min(20 * s, rowH * 0.42))
  const valPx = Math.max(15 * s, Math.min(24 * s, rowH * 0.4))
  const labelCol = Math.min(g.width * 0.36, Math.max(110 * s, textWidth(longest, labelPx) + 24 * s))
  const valueRoom = Math.max(0, ...finals.map((t) => textWidth(t.length, valPx, 0.6))) + 16 * s
  const negRoom = values.some((v) => v < 0) ? valueRoom : 0
  const x0 = labelCol + negRoom
  const area = Math.max(40 * s, g.width - valueRoom - x0)
  const span = scale.max - scale.min || 1
  const x = (v: number) => x0 + (area * (v - scale.min)) / span
  const zero = x(0)
  const thick = Math.min(rowH * 0.58, 40 * s)
  const pad = 20 * s
  const tickW = Math.round(Math.max(0, ...ticks.map((t) => textWidth(t.label.length, 15 * s, 0.62))) + 16 * s)
  const html = `
    <div class="plot bars rows" style="width: ${px(g.width)}; height: ${px(H)}; margin-top: ${px(30 * s)}; margin-bottom: ${px(46 * s)};">
      ${ticks.map((t) => `<div class="gl vgl${t.v === 0 ? ' base' : ''}" style="left: ${px(x(t.v))}"></div>`).join('')}
      <div class="ticks">${ticks.map((t) => (t.label ? `<div class="tk" style="left: ${Math.round(x(t.v) - tickW / 2)}px; width: ${tickW}px; top: ${px(H + 14 * s)}"><span class="mask"><span>${esc(t.label)}</span></span></div>` : '')).join('')}</div>
      ${items
        .map((d, i) => {
          const v = values[i]
          const len = Math.abs(x(v) - zero)
          const top = rowH * i
          // Each row starts at the zero line: its bar grows from there and its value rides on the bar's end.
          const row = v >= 0 ? `left: ${px(zero)}; width: ${px(g.width - zero)};` : `left: 0; width: ${px(zero)};`
          const bar = v >= 0 ? `left: 0; width: ${px(len)};` : `right: 0; width: ${px(len)};`
          const val = v >= 0 ? `left: ${px(len + 10 * s)};` : `right: ${px(len + 10 * s)};`
          return `<div class="cat c${i}${i === highlight ? ' hot' : ''}" style="top: ${px(top)}; height: ${px(rowH)}; width: ${px(labelCol - 18 * s)}; font-size: ${px(labelPx)};"><span class="mask"><span>${esc(d.label)}</span></span></div>
          <div class="row" style="top: ${px(top + (rowH - thick) / 2 - pad)}; height: ${px(thick + pad * 2)}; ${row}">
            <div class="bar b${i}${kinds[i]}" style="top: ${px(pad)}; height: ${px(thick)}; ${bar}"></div>
            <div class="val v${i}${kinds[i]}" style="font-size: ${px(valPx)}; ${val}">${valueHtml(format)}</div>
          </div>`
        })
        .join('')}
    </div>`
  const css = `
    .vgl { top: 0; bottom: 0; right: auto; width: calc(1.5px * var(--s)); height: auto; transform: scaleY(0); transform-origin: 50% 0%; }
    .rows .tk { text-align: center; }
    .rows .cat { left: 0; display: flex; align-items: center; justify-content: flex-end; text-align: right; }
    .rows .cat .mask { max-width: 100%; }
    .rows .cat .mask > span { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .row { position: absolute; }
    .bar { position: absolute; background: ${g.fg}; border-radius: 0 calc(3px * var(--s)) calc(3px * var(--s)) 0; ${BAR_SHADOW} }
    .bar.neg { border-radius: calc(3px * var(--s)) 0 0 calc(3px * var(--s)); }
    .bar.hot { background: ${g.accent}; }
    .row .val { top: 0; bottom: 0; display: flex; align-items: center; }`
  return { html, css, config: { bars: n, vertical: false, highlight, values, lengths: values.map((v) => Math.abs(x(v) - zero)), count: format } }
}

// ─── Line ────────────────────────────────────────────────────────────────

/** A smooth path through points that never overshoots them (monotone cubic, Fritsch–Carlson). */
export function monotonePath(pts: [number, number][]) {
  const n = pts.length
  const r = (v: number) => Math.round(v * 100) / 100
  const at = (i: number) => `${r(pts[i][0])},${r(pts[i][1])}`
  if (n === 0) return ''
  if (n < 3) return n === 1 ? `M${at(0)}` : `M${at(0)}L${at(1)}`
  const m: number[] = []
  for (let i = 0; i < n - 1; i++) m.push((pts[i + 1][1] - pts[i][1]) / (pts[i + 1][0] - pts[i][0] || 1))
  const t = pts.map((_, i) => (i === 0 ? m[0] : i === n - 1 ? m[n - 2] : m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2))
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) {
      t[i] = 0
      t[i + 1] = 0
      continue
    }
    const a = t[i] / m[i]
    const b = t[i + 1] / m[i]
    const h = a * a + b * b
    if (h > 9) {
      const k = 3 / Math.sqrt(h)
      t[i] = k * a * m[i]
      t[i + 1] = k * b * m[i]
    }
  }
  let d = `M${at(0)}`
  for (let i = 0; i < n - 1; i++) {
    const dx = (pts[i + 1][0] - pts[i][0]) / 3
    d += `C${r(pts[i][0] + dx)},${r(pts[i][1] + t[i] * dx)} ${r(pts[i + 1][0] - dx)},${r(pts[i + 1][1] - t[i + 1] * dx)} ${at(i + 1)}`
  }
  return d
}

function linePlot(spec: Spec, g: Geometry): Plot {
  const { items, format, highlight } = spec
  const { s } = g
  const n = items.length
  const values = items.map((d) => d.value)
  const lo = n ? Math.min(...values) : 0
  const hi = n ? Math.max(...values) : 1
  // Zero belongs on the scale when the data sits near it; otherwise the scale hugs the data.
  const scale = niceScale(lo >= 0 && lo <= hi * 0.35 ? 0 : lo, hi, 5)
  const ticks = axis(scale, format, !n)
  const H = g.height
  const gutter = Math.max(0, ...ticks.map((t) => textWidth(t.label.length, 15 * s, 0.62))) + 22 * s
  const inset = 14 * s
  const span = scale.max - scale.min || 1
  const y = (v: number) => (H * (scale.max - v)) / span
  const x = (i: number) => (n === 1 ? (gutter + g.width) / 2 : gutter + inset + ((g.width - gutter - 2 * inset) * i) / (n - 1))
  const pts = items.map((d, i) => [x(i), y(d.value)] as [number, number])
  const line = monotonePath(pts)
  const baseY = y(Math.max(scale.min, Math.min(0, scale.max)))
  const area = n > 1 ? `${line}L${pts[n - 1][0].toFixed(2)},${baseY.toFixed(2)}L${pts[0][0].toFixed(2)},${baseY.toFixed(2)}Z` : ''
  const catPx = 17 * s
  // As many x labels as fit, spread evenly, always the first and the last.
  const longest = Math.max(1, ...items.map((d) => Math.min(d.label.length, 16)))
  const fits = Math.max(2, Math.floor((g.width - gutter) / (textWidth(longest, catPx) + 28 * s)))
  const shown = n <= fits ? items.map((_, i) => i) : [...new Set(Array.from({ length: fits }, (_, k) => Math.round((k * (n - 1)) / (fits - 1))))]
  const call = highlight >= 0 ? highlight : n - 1
  const dots = n <= 40
  const r = Math.max(3.5 * s, Math.min(6 * s, ((g.width - gutter) / Math.max(1, n)) * 0.18))
  // Labels sit in boxes of a known width at whole pixels: nothing is centred by a fractional transform.
  const labelW = Math.round(textWidth(longest, catPx) + 24 * s)
  const xLabel = (i: number) => {
    const first = shown.length > 1 && i === shown[0]
    const last = shown.length > 1 && i === shown[shown.length - 1]
    const left = first ? pts[i][0] - inset : last ? pts[i][0] + inset - labelW : pts[i][0] - labelW / 2
    return `<div class="cat xl" style="left: ${Math.round(left)}px; width: ${labelW}px; top: ${px(H + 16 * s)}; font-size: ${px(catPx)}; text-align: ${first ? 'left' : last ? 'right' : 'center'};"><span class="mask"><span>${esc(items[i].label)}</span></span></div>`
  }
  // The called-out value sits over its point — or ends at it, or starts at it, where centring would leave the plot.
  const callPx = 32 * s
  const tagPx = 13 * s
  const tag = n ? items[call].label : ''
  const callW = Math.round(Math.max(textWidth(n ? formatNumber(values[call], format).length : 1, callPx, 0.62), textWidth(tag.length, tagPx, 0.8)) + 28 * s)
  const callH = Math.round(callPx * 1.05 + (tag ? tagPx * 1.25 + 6 * s : 0))
  const [cx, cy] = n ? pts[call] : [0, 0]
  const ring = r * 1.5
  let callLeft = cx - callW / 2
  let callAlign = 'center'
  if (callLeft + callW > g.width) [callLeft, callAlign] = [cx + ring - callW, 'flex-end']
  else if (callLeft < gutter) [callLeft, callAlign] = [cx - ring, 'flex-start']
  const callTop = Math.round(cy - ring - 12 * s - callH)
  callLeft = Math.round(callLeft)
  // Gridlines step aside for the callout rather than run through its type.
  const knock = (gy: number) => {
    if (!n || gy < callTop - 6 * s || gy > callTop + callH + 6 * s) return ''
    const a = Math.round(callLeft - 10 * s)
    const b = Math.round(callLeft + callW + 10 * s)
    const m = `linear-gradient(90deg, #000 ${a}px, transparent ${a}px, transparent ${b}px, #000 ${b}px)`
    return ` -webkit-mask-image: ${m}; mask-image: ${m};`
  }
  const html = `
    <div class="plot line" style="width: ${px(g.width)}; height: ${px(H)}; margin-top: ${px(96 * s)}; margin-bottom: ${px(52 * s)};">
      ${ticks.map((t) => `<div class="gl${t.v === 0 && scale.min < 0 ? ' base' : ''}" style="top: ${px(y(t.v))};${knock(y(t.v))}"></div>`).join('')}
      <div class="ticks">${ticks.map((t) => (t.label ? `<div class="tk" style="top: ${px(y(t.v) - 21 * s)}"><span class="mask"><span>${esc(t.label)}</span></span></div>` : '')).join('')}</div>
      <svg class="lines" width="${g.width}" height="${H}" viewBox="0 0 ${g.width} ${H}">
        <defs><clipPath id="reveal"><rect class="reveal" x="0" y="${-H}" width="0" height="${H * 3}" /></clipPath></defs>
        ${area ? `<path class="area" d="${area}" clip-path="url(#reveal)" />` : ''}
        ${n > 1 ? `<path class="stroke" d="${line}" pathLength="1" />` : ''}
        ${items.map((_, i) => (dots || i === call ? `<circle class="pt${i === call ? ' call' : ''}" cx="${pts[i][0].toFixed(2)}" cy="${pts[i][1].toFixed(2)}" r="${(i === call ? ring : r).toFixed(2)}" />` : '')).join('')}
        ${n > 1 ? `<circle class="head" r="${(r * 1.2).toFixed(2)}" cx="${pts[0][0].toFixed(2)}" cy="${pts[0][1].toFixed(2)}" />` : ''}
      </svg>
      ${shown.map(xLabel).join('')}
      ${
        n
          ? `<div class="callout${highlight >= 0 ? ' hot' : ''}" style="left: ${callLeft}px; top: ${callTop}px; width: ${callW}px; height: ${callH}px; align-items: ${callAlign};">
        ${tag ? `<span class="mask"><span class="call-label">${esc(tag)}</span></span>` : ''}
        <span class="mask"><span class="val">${valueHtml(format)}</span></span>
      </div>`
          : ''
      }
    </div>`
  const css = `
    .lines { position: absolute; inset: 0; overflow: visible; }
    .area { fill: ${rgba(g.accent, 0.14)}; }
    .stroke { fill: none; stroke: ${g.accent}; stroke-width: calc(4px * var(--s)); stroke-linecap: round; stroke-linejoin: round; stroke-dasharray: 1 2; stroke-dashoffset: 1; }
    .pt { fill: ${g.fg}; }
    .pt.call { fill: ${g.accent}; stroke: ${g.fg}; stroke-width: calc(2.5px * var(--s)); }
    .head { fill: ${g.accent}; opacity: 0; }
    .xl .mask > span { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .callout { position: absolute; display: flex; flex-direction: column; justify-content: flex-end; ${DROP_SHADOW} }
    .callout .val { position: static; font-size: ${px(callPx)}; text-shadow: none; }
    .callout.hot .val { color: ${g.accent}; }
    .call-label { font-family: ${FONT_STACKS.sans}; font-size: ${px(tagPx)}; font-weight: 600; letter-spacing: 0.18em; text-transform: uppercase; color: ${rgba(g.fg, 0.72)}; padding-bottom: calc(6px * var(--s)); }`
  return { html, css, config: { points: n, width: g.width, value: n ? values[call] : 0, callX: n ? pts[call][0] : 0, count: format } }
}

// ─── Donut ───────────────────────────────────────────────────────────────

/** Segments of a whole: up to six, the rest gathered as "Other". */
function segmentsOf(items: ChartDatum[]) {
  const positive = items.filter((d) => d.value > 0)
  if (positive.length <= 6) return positive
  const sorted = [...positive].sort((a, b) => b.value - a.value)
  return [...sorted.slice(0, 5), { label: 'Other', value: sorted.slice(5).reduce((sum, d) => sum + d.value, 0) }]
}

function donutPlot(spec: Spec, g: Geometry, p: Record<string, unknown>): Plot {
  const { s } = g
  const segments = Number.isFinite(spec.single) ? [] : segmentsOf(spec.items)
  const ring = Math.round(Math.min(g.height * 0.46, 236 * s))
  const stroke = Math.round(ring * 0.2)
  const mid = ring - stroke / 2
  const label = String(p.label ?? '').trim()
  const svg = (arcs: string) => `<svg viewBox="${-ring} ${-ring} ${ring * 2} ${ring * 2}"><circle class="track" r="${mid}" pathLength="100" />${arcs}</svg>`
  const base = `
    .donut svg { position: absolute; inset: 0; width: 100%; height: 100%; transform: rotate(-90deg); overflow: visible; }
    .track, .arc, .seg { fill: none; stroke-width: ${stroke}; stroke-dasharray: 0 100; }
    .track { stroke: ${rgba(g.fg, 0.14)}; }
    .ringbox { position: relative; flex: none; width: ${px(ring * 2)}; height: ${px(ring * 2)}; }
    .centre { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; ${DROP_SHADOW} }
    .big { font-family: ${stack(p.font, 'tech')}; font-size: ${px(ring * 0.4)}; font-weight: 600; letter-spacing: -0.04em; line-height: 1; font-variant-numeric: tabular-nums; }
    .big .suf { font-size: 0.42em; font-weight: 500; letter-spacing: -0.01em; color: ${g.accent}; margin-left: 0.06em; }
    .big .pre { font-size: 0.5em; font-weight: 500; color: ${rgba(g.fg, 0.72)}; margin-right: 0.04em; }
    .dlabel { margin-top: calc(34px * var(--s)); font-family: ${FONT_STACKS.sans}; font-size: calc(19px * var(--s)); font-weight: 600; letter-spacing: 0.22em; text-transform: uppercase; color: ${rgba(g.fg, 0.78)}; text-align: center; ${DROP_SHADOW} }`
  const caption = label ? `<div class="dlabel"><span class="mask"><span>${esc(label)}</span></span></div>` : ''

  if (!segments.length) {
    // One value: a ring filled to its share of the maximum (100 unless given), the number counting up inside it.
    const value = Number.isFinite(spec.single) ? spec.single : 0
    const given = num(p.max ?? p.total, NaN)
    const max = Number.isFinite(given) && given !== 0 ? given : 100
    // Out of 100 unless told otherwise, it reads as a percentage.
    const format = { ...spec.format, suffix: spec.format.suffix || (Number.isFinite(given) ? '' : '%') }
    const html = `
      <div class="plot donut" style="margin-top: ${px(44 * s)};">
        <div class="ringbox">${svg('<circle class="arc" r="' + mid + '" pathLength="100" />')}
          <div class="centre"><span class="mask"><span class="big">${figureHtml(format)}</span></span></div>
        </div>
      </div>
      ${caption}`
    return { html, css: `${base} .arc { stroke: ${g.accent}; }`, config: { segments: 0, value, share: Math.max(0, Math.min(1, value / max)), count: counting(format) } }
  }

  // Segments: the highlight (or the largest) in the accent, the rest in steps of the main colour, a legend beside the ring.
  const total = segments.reduce((sum, d) => sum + d.value, 0)
  const named = spec.highlight >= 0 ? segments.findIndex((d) => d.label === spec.items[spec.highlight]?.label) : -1
  const hot = named >= 0 ? named : segments.reduce((best, d, i) => (d.value > segments[best].value ? i : best), 0)
  const steps = [0.9, 0.62, 0.44, 0.3, 0.2, 0.14]
  let next = 0
  const fills = segments.map((_, i) => (i === hot ? g.accent : rgba(g.fg, steps[next++] ?? 0.12)))
  const shares = segments.map((d) => (d.value / total) * 100)
  const pct: NumberStyle = { decimals: shares.some((v) => v < 9.95 && Math.round(v * 10) % 10 !== 0) ? 1 : 0, compact: false, prefix: '', suffix: '%' }
  const legendPx = 20 * s
  const legendW = Math.max(200 * s, Math.min(g.width - ring * 2 - 90 * s, Math.max(...segments.map((d) => textWidth(d.label.length, legendPx))) + 130 * s))
  // Where each segment starts and how long it is, in hundredths of the ring, a hairline apart.
  const gap = segments.length > 1 ? 0.6 : 0
  let start = 0
  const arcs = shares.map((v) => {
    const arc = { from: start + gap / 2, len: Math.max(0, v - gap) }
    start += v
    return arc
  })
  const html = `
    <div class="plot donut split" style="margin-top: ${px(48 * s)};">
      <div class="ringbox">${svg(segments.map((_, i) => `<circle class="seg" r="${mid}" pathLength="100" style="stroke: ${fills[i]}" />`).join(''))}
        <div class="centre"><span class="mask"><span class="big">${figureHtml(pct)}</span></span><span class="mask"><span class="seglabel">${esc(segments[hot].label)}</span></span></div>
      </div>
      <ul class="legend" style="width: ${px(legendW)};">
        ${segments.map((d, i) => `<li><span class="mask"><span class="key"><i style="background: ${fills[i]}"></i><b>${esc(d.label)}</b><em>${esc(formatNumber(shares[i], pct))}</em></span></span></li>`).join('')}
      </ul>
    </div>
    ${caption}`
  const css = `
    ${base}
    .split { display: flex; align-items: center; gap: calc(90px * var(--s)); }
    .seglabel { display: block; max-width: ${px(ring * 1.2)}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ${FONT_STACKS.sans}; font-size: calc(15px * var(--s)); font-weight: 600; letter-spacing: 0.16em; text-transform: uppercase; color: ${rgba(g.fg, 0.72)}; padding-top: calc(10px * var(--s)); }
    .legend { list-style: none; display: flex; flex-direction: column; gap: calc(14px * var(--s)); text-align: left; ${DROP_SHADOW} }
    .legend .mask { display: block; }
    .key { display: grid !important; grid-template-columns: calc(14px * var(--s)) minmax(0, 1fr) auto; align-items: center; gap: calc(14px * var(--s)); font-family: ${FONT_STACKS.sans}; font-size: ${px(legendPx)}; }
    .key i { width: calc(14px * var(--s)); height: calc(14px * var(--s)); border-radius: calc(3px * var(--s)); }
    .key b { font-weight: 500; color: ${rgba(g.fg, 0.86)}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .key em { font-style: normal; font-family: ${FONT_STACKS.mono}; font-variant-numeric: tabular-nums; font-size: 0.9em; color: ${rgba(g.fg, 0.7)}; }`
  return { html, css, config: { segments: segments.length, arcs, value: shares[hot], count: counting(pct) } }
}

// ─── The page's side ─────────────────────────────────────────────────────
// Transforms and masks are GSAP tweens. What GSAP can't tween — numbers
// counting up, the line's moving head and its area — is set from the
// timeline's time by one clock, so any frame renders on its own.

const RUNTIME = String.raw`
// Flat transforms only: a 3D one gets a layer of its own, whose cached raster can differ with the frames drawn before.
gsap.config({ force3D: false });
// The piece is set on its own timeline, at least three seconds long: a shorter clip plays it faster.
const DN = Math.max(D, 3);
const T = gsap.timeline();
const k = Math.min(1, Math.max(0.55, DN / 6));
const OUT = DN - 0.7;
const q = (sel) => Array.from(document.querySelectorAll(sel));
const to = (sel, vars, at) => {
  const els = typeof sel === 'string' ? q(sel) : sel.filter(Boolean);
  if (els.length) T.to(els, vars, at);
};
// Type wipes in and out through its mask, but its soft shadow would show at the mask's edge: it's hidden until it comes in and once it's out.
const inn = (sel, vars, at) => {
  const els = typeof sel === 'string' ? q(sel) : sel;
  if (!els.length) return;
  T.set(els, { visibility: 'visible' }, at);
  T.to(els, vars, at);
};
const out = (sel, vars, at) => {
  const els = q(sel);
  if (!els.length) return;
  T.to(els, vars, at);
  T.set(els, { visibility: 'hidden' }, at + vars.duration + (vars.stagger || 0) * (els.length - 1));
};
const ease = (name) => gsap.parseEase(name);
const progress = (t, start, dur, e) => e(Math.min(1, Math.max(0, (t - start) / dur)));
const draws = [];
const count = (el, value, start, dur, e, f) => {
  if (el) draws.push((t) => (el.textContent = formatNumber(value * progress(t, start, dur, e), f)));
};

const masks = q('.mask > span');
if (masks.length) gsap.set(masks, { yPercent: 110, visibility: 'hidden' });
// The title wipes on word by word; the chart's frame draws after it.
inn('.title .w', { yPercent: 0, duration: 1.0, ease: 'expo.out', stagger: 0.05 }, 0.08);
inn('.subtitle .mask > span', { yPercent: 0, duration: 0.7, ease: 'power2.out' }, 0.3);
to('.gl', { scaleX: 1, scaleY: 1, duration: 0.8, ease: 'power3.inOut', stagger: 0.04 }, 0.28);
inn('.tk .mask > span', { yPercent: 0, duration: 0.5, ease: 'power2.out', stagger: 0.04 }, 0.5);
inn('.source .mask > span', { yPercent: 0, duration: 0.6, ease: 'power2.out' }, 0.9);

if (C.kind === 'bar') {
  const n = C.bars;
  const grow = 1.1 * k;
  const stagger = Math.min(0.08, 0.7 / Math.max(1, n)) * k;
  const start = 0.62 * k;
  // Bars grow in length rather than scale: their shadow stays true, and nothing is cached from frame to frame.
  const axis = C.vertical ? 'height' : 'width';
  const rise = ease('expo.out');
  // Each value rides on the end of its bar, showing as the bar leaves the baseline.
  const off = (i) => (C.vertical ? { y: (C.values[i] < 0 ? -1 : 1) * C.lengths[i] } : { x: (C.values[i] < 0 ? 1 : -1) * C.lengths[i] });
  for (let i = 0; i < n; i++) {
    const at = start + i * stagger;
    const bar = document.querySelector('.b' + i);
    const val = document.querySelector('.v' + i);
    T.fromTo(bar, { [axis]: 0 }, { [axis]: C.lengths[i], duration: grow, ease: 'expo.out' }, at);
    if (val) {
      T.fromTo(val, { ...off(i), opacity: 0 }, { x: 0, y: 0, opacity: 1, duration: grow, ease: 'expo.out' }, at);
      count(val.querySelector('.num'), C.values[i], at, grow, rise, C.count);
    }
    inn('.c' + i + ' .mask > span', { yPercent: 0, duration: 0.6, ease: 'power2.out' }, 0.5 * k + i * stagger);
  }
  // The highlighted bar keeps its weight; the others step back once all have landed.
  if (C.highlight >= 0) to(q('.bar').filter((b) => !b.classList.contains('hot')), { opacity: 0.42, duration: 0.6, ease: 'power2.out' }, start + (n - 1) * stagger + grow * 0.7);
  // Out: back to the baseline, last first, quicker than they came.
  const back = Math.min(0.03, 0.24 / Math.max(1, n));
  for (let i = n - 1; i >= 0; i--) {
    const at = OUT + (n - 1 - i) * back;
    T.to('.b' + i, { [axis]: 0, duration: 0.42, ease: 'power3.in' }, at);
    const val = document.querySelector('.v' + i);
    if (val) T.to(val, { ...off(i), opacity: 0, duration: 0.42, ease: 'power3.in' }, at);
  }
  out('.cat .mask > span', { yPercent: -110, duration: 0.32, ease: 'power2.in', stagger: back }, OUT + 0.06);
} else if (C.kind === 'line') {
  const path = document.querySelector('.stroke');
  const head = document.querySelector('.head');
  const reveal = document.querySelector('.reveal');
  const length = path ? path.getTotalLength() : 0;
  const drawAt = 0.7 * k;
  const drawFor = Math.min(2.0, Math.max(1.2, 0.9 + 0.02 * C.points)) * k;
  const draw = ease('power2.inOut');
  const erase = ease('power3.in');
  const end = drawAt + drawFor;
  if (path) {
    draws.push((t) => {
      const shown = progress(t, drawAt, drawFor, draw);
      const gone = progress(t, OUT, 0.5, erase);
      // The line draws on from its start, and on the way out is taken back from the same end; its area follows the pen.
      // One dash the path's length, then a longer gap: no dash edge (which a round cap would draw as a dot) sits on the path when it's hidden.
      path.style.strokeDashoffset = String(gone >= 1 ? -1.5 : gone > 0 ? -gone : 1 - shown);
      const pen = path.getPointAtLength(length * shown);
      const tail = path.getPointAtLength(length * gone);
      reveal.setAttribute('x', gone > 0 ? tail.x.toFixed(2) : '0');
      reveal.setAttribute('width', Math.max(0, gone > 0 ? C.width - tail.x : shown > 0 ? pen.x : 0).toFixed(2));
      head.setAttribute('cx', pen.x.toFixed(2));
      head.setAttribute('cy', pen.y.toFixed(2));
      head.style.opacity = shown > 0 && shown < 1 ? '1' : '0';
    });
  }
  q('.xl .mask > span').forEach((el, i) => inn([el], { yPercent: 0, duration: 0.55, ease: 'power2.out' }, 0.5 * k + i * 0.03));
  // The points pop in once the line is drawn: the piece's one small overshoot.
  const pts = q('.pt');
  if (pts.length) {
    gsap.set(pts, { scale: 0, transformOrigin: '50% 50%' });
    T.to(pts, { scale: 1, duration: 0.42, ease: 'back.out(1.6)', stagger: Math.min(0.03, 0.5 / pts.length) }, end - 0.1);
    T.to(pts, { scale: 0, duration: 0.26, ease: 'power2.in', stagger: Math.min(0.015, 0.25 / pts.length) }, OUT - 0.1);
  }
  // The called-out value arrives as the pen reaches its point.
  const callAt = Math.max(drawAt + drawFor * Math.min(1, 0.15 + (C.callX / C.width) * 0.85), end - 0.25);
  inn('.callout .mask > span', { yPercent: 0, duration: 0.6, ease: 'power2.out', stagger: 0.06 }, callAt);
  count(document.querySelector('.callout .num'), C.value, callAt, 0.9, ease('expo.out'), C.count);
  out('.callout .mask > span', { yPercent: -110, duration: 0.32, ease: 'power2.in' }, OUT - 0.15);
  out('.xl .mask > span', { yPercent: -110, duration: 0.32, ease: 'power2.in', stagger: 0.01 }, OUT + 0.05);
} else {
  const fill = ease('power3.out');
  const sweep = ease('power3.inOut');
  const takeBack = ease('power3.in');
  const fillAt = 0.55 * k;
  const fillFor = 1.5 * k;
  const track = document.querySelector('.track');
  // The ring's track sweeps round first; the value fills it as the number counts up.
  draws.push((t) => {
    const p = progress(t, 0.22 * k, 0.9 * k, sweep) * (1 - progress(t, OUT + 0.1, 0.4, takeBack));
    track.style.strokeDasharray = (p * 100).toFixed(3) + ' 100';
  });
  if (C.segments) {
    const segs = q('.seg');
    draws.push((t) => {
      const p = progress(t, fillAt, fillFor, fill) * (1 - progress(t, OUT, 0.45, takeBack)) * 100;
      segs.forEach((seg, i) => {
        const a = C.arcs[i];
        seg.style.strokeDasharray = Math.max(0, Math.min(a.len, p - a.from)).toFixed(3) + ' 100';
        seg.style.strokeDashoffset = (-a.from).toFixed(3);
      });
    });
    q('.legend .mask > span').forEach((el, i) => inn([el], { yPercent: 0, duration: 0.6, ease: 'power2.out' }, fillAt + (C.arcs[i].from / 100) * fillFor * 0.8));
    out('.legend .mask > span', { yPercent: -110, duration: 0.32, ease: 'power2.in', stagger: 0.03 }, OUT);
  } else {
    const arc = document.querySelector('.arc');
    draws.push((t) => {
      const p = progress(t, fillAt, fillFor, fill) * (1 - progress(t, OUT, 0.45, takeBack));
      arc.style.strokeDasharray = (p * C.share * 100).toFixed(3) + ' 100';
    });
  }
  count(document.querySelector('.centre .num'), C.value, fillAt, fillFor, fill, C.count);
  inn('.centre .mask > span', { yPercent: 0, duration: 0.8, ease: 'expo.out', stagger: 0.08 }, fillAt - 0.1);
  inn('.dlabel .mask > span', { yPercent: 0, duration: 0.7, ease: 'power2.out' }, fillAt + 0.3);
  out('.centre .mask > span, .dlabel .mask > span', { yPercent: -110, duration: 0.34, ease: 'power2.in', stagger: 0.04 }, OUT - 0.05);
}

// Out: the chart's frame, then the title — the reverse of how they came, and quicker.
out('.tk .mask > span', { yPercent: -110, duration: 0.3, ease: 'power2.in', stagger: 0.02 }, OUT + 0.08);
to('.gl', { scaleX: 0, scaleY: 0, duration: 0.36, ease: 'power2.in', stagger: 0.02 }, OUT + 0.12);
out('.source .mask > span', { yPercent: -110, duration: 0.3, ease: 'power2.in' }, OUT + 0.08);
out('.subtitle .mask > span', { yPercent: -110, duration: 0.3, ease: 'power2.in' }, OUT + 0.16);
out('.title .w', { yPercent: -110, duration: 0.36, ease: 'power3.in', stagger: Math.min(0.02, 0.12 / Math.max(1, C.words)) }, OUT + 0.18);

// One linear clock over the whole piece: setting its time sets everything drawn from time.
const clock = {
  now: 0,
  get t() {
    return this.now;
  },
  set t(v) {
    this.now = v;
    for (const d of draws) d(v);
  },
};
T.to(clock, { t: DN, duration: DN, ease: 'none' }, 0);
clock.t = 0;
tl.add(T.timeScale(DN / D), 0);
`
