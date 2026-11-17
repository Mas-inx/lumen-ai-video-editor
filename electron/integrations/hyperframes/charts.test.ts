import os from 'node:os'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }))

const { chartSpec, formatNumber, monotonePath, niceScale } = await import('./charts')
const { buildTemplate, templateDuration } = await import('./templates')

const FRAME = { width: 1920, height: 1080, duration: 6 }
const build = (params: Record<string, unknown>, frame = FRAME) => buildTemplate('chart', params, frame)

/** The page without its scripts and inlined fonts: what's laid out. */
const markup = (html: string) => html.replace(/<script[^>]*>[\s\S]*?<\/script>/g, '').replace(/url\('data:[^']*'\)/g, '')
const inlineScripts = (html: string) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
const count = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0

function expectValidPage(html: string, duration = FRAME.duration) {
  expect(html.startsWith('<!doctype html>')).toBe(true)
  expect(html).toContain('<meta data-composition-id="lumen"')
  expect(html).toContain(`data-start="0" data-duration="${duration}" data-track-index="0"`)
  expect(html).toContain('window.__timelines["lumen"] = tl;')
  const body = markup(html)
  for (const tag of ['div', 'span', 'p', 'svg', 'ul', 'li', 'header', 'h1', 'b', 'em', 'i']) expect(count(body, new RegExp(`<${tag}[\\s>]`, 'g')), tag).toBe(count(body, new RegExp(`</${tag}>`, 'g')))
  expect(body).not.toMatch(/NaN|undefined|Infinity|\[object /)
  // User text can't close a script early, and the page's own code parses.
  expect(count(html, /<script/g)).toBe(count(html, /<\/script>/g))
  for (const code of inlineScripts(html)) expect(() => new Function(code)).not.toThrow()
}

type Vars = Record<string, unknown> & { duration?: number; stagger?: number }
interface Tween {
  targets: unknown[]
  vars: Vars
  at: number
}

interface El {
  tag: string
  classes: string[]
  parent: El | null
  children: El[]
  style: Record<string, string>
  attrs: Record<string, string>
  textContent: string
  classList: { contains: (c: string) => boolean }
  setAttribute: (k: string, v: string) => void
  querySelector: (sel: string) => El | null
  getTotalLength: () => number
  getPointAtLength: (l: number) => { x: number; y: number }
}

/** The page's body as a tree, enough to answer the selectors its script uses (classes, tags, descendant and child). */
function parse(html: string) {
  const body = /<body>([\s\S]*)<\/body>/.exec(html)![1].replace(/<script[^>]*>[\s\S]*?<\/script>/g, '')
  const make = (tag: string, classes: string[], parent: El | null): El => {
    const el: El = {
      tag,
      classes,
      parent,
      children: [],
      style: {},
      attrs: {},
      textContent: '',
      classList: { contains: (c) => classes.includes(c) },
      setAttribute: (k, v) => void (el.attrs[k] = v),
      querySelector: (sel) => select(sel, el)[0] ?? null,
      getTotalLength: () => 1000,
      getPointAtLength: (l) => ({ x: l, y: 500 - l / 4 }),
    }
    return el
  }
  const root = make('#root', [], null)
  let at = root
  for (const [, close, tag, attrs, self] of body.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g)) {
    if (close) at = at.parent ?? root
    else {
      const el = make(tag, /class="([^"]*)"/.exec(attrs)?.[1].split(/\s+/).filter(Boolean) ?? [], at)
      at.children.push(el)
      if (!self) at = el
    }
  }
  const all = (from: El): El[] => from.children.flatMap((c) => [c, ...all(c)])
  const fits = (el: El, simple: string) => (simple.startsWith('.') ? el.classes.includes(simple.slice(1)) : el.tag === simple)
  // Right to left: the last simple selector names the element, the rest its ancestors (or parent, after ">").
  const matches = (el: El, parts: string[]): boolean => {
    if (!fits(el, parts[parts.length - 1])) return false
    if (parts.length === 1) return true
    const rest = parts.slice(0, -1)
    if (rest[rest.length - 1] === '>') return el.parent !== null && matches(el.parent, rest.slice(0, -1))
    for (let p = el.parent; p; p = p.parent) if (matches(p, rest)) return true
    return false
  }
  const select = (sel: string, from: El) => {
    const groups = sel.split(',').map((g) => g.replace(/>/g, ' > ').trim().split(/\s+/))
    return all(from).filter((el) => groups.some((parts) => matches(el, parts)))
  }
  return { root, select }
}

/**
 * Runs the page's script against its own markup and a stand-in GSAP that
 * records the tweens (in the piece's own time; `end` is when the last one is
 * done in the clip's); the clock can be set to any time to read what the page
 * shows then.
 */
function run(html: string) {
  const { root, select } = parse(html)
  const document = { querySelector: (sel: string) => select(sel, root)[0] ?? null, querySelectorAll: (sel: string) => select(sel, root) }
  const tweens: Tween[] = []
  const list = (t: unknown) => (Array.isArray(t) ? t : typeof t === 'string' ? select(t, root) : [t])
  const tl = {
    to: (t: unknown, vars: Vars, at: number) => (tweens.push({ targets: list(t), vars, at }), tl),
    fromTo: (t: unknown, _from: Vars, vars: Vars, at: number) => (tweens.push({ targets: list(t), vars, at }), tl),
    set: (t: unknown, vars: Vars, at: number) => (tweens.push({ targets: list(t), vars: { ...vars, duration: 0 }, at }), tl),
    timeScale: (v: number) => ((scale = v), tl),
    add: () => tl,
  }
  let scale = 1
  const gsap = { timeline: () => tl, set: () => {}, config: () => {}, parseEase: () => (x: number) => x }
  const window: Record<string, unknown> = {}
  new Function('window', 'document', 'gsap', inlineScripts(html)[0])(window, document, gsap)
  const clock = tweens.find((t) => (t.targets[0] as { now?: number }).now !== undefined)!.targets[0] as { t: number }
  return {
    tweens,
    end: () => Math.max(...ends(tweens)) / scale,
    at: (t: number) => {
      clock.t = t
      return (sel: string) => document.querySelector(sel)!
    },
  }
}

/** When each tween is done, counting its stagger. */
const ends = (tweens: Tween[]) => tweens.map((t) => t.at + (t.vars.duration ?? 0) + (t.vars.stagger ?? 0) * Math.max(0, t.targets.length - 1))

describe('chart scales', () => {
  it('picks round ticks that cover the data with little to spare', () => {
    expect(niceScale(0, 87).ticks).toEqual([0, 20, 40, 60, 80, 100])
    expect(niceScale(0, 42).ticks).toEqual([0, 10, 20, 30, 40, 50])
    expect(niceScale(0, 1234).ticks).toEqual([0, 250, 500, 750, 1000, 1250])
    expect(niceScale(-30, 50).ticks).toEqual([-40, -20, 0, 20, 40, 60])
    expect(niceScale(0, 0.73)).toMatchObject({ ticks: [0, 0.2, 0.4, 0.6, 0.8], decimals: 1 })
    expect(niceScale(120, 180).ticks).toEqual([120, 130, 140, 150, 160, 170, 180])
  })

  it('always gives a range, a zero tick across zero, and an even step', () => {
    for (const [lo, hi] of [
      [0, 0],
      [5, 5],
      [-5, -5],
      [-0.004, 0.01],
      [3, 3_200_000],
      [-987, -12],
      [Number.NaN, 4],
    ]) {
      const s = niceScale(lo, hi)
      expect(s.max).toBeGreaterThan(s.min)
      if (Number.isFinite(lo)) expect(s.min).toBeLessThanOrEqual(Math.min(lo, hi))
      if (Number.isFinite(lo)) expect(s.max).toBeGreaterThanOrEqual(Math.max(lo, hi))
      if (s.min < 0 && s.max > 0) expect(s.ticks).toContain(0)
      expect(s.ticks.length).toBeGreaterThanOrEqual(2)
      expect(s.ticks.length).toBeLessThanOrEqual(11)
      s.ticks.slice(1).forEach((v, i) => expect(v - s.ticks[i]).toBeCloseTo(s.step, 9))
    }
  })

  it('formats values as a chart shows them', () => {
    const f = { decimals: 0, compact: false, prefix: '', suffix: '' }
    expect(formatNumber(1234.5, { ...f, decimals: 1 })).toBe('1,234.5')
    expect(formatNumber(-3, { ...f, prefix: '$' })).toBe('−$3')
    expect(formatNumber(-0.004, { ...f, decimals: 1, suffix: '%' })).toBe('0.0%')
    expect(formatNumber(1_250_000, { ...f, compact: true })).toBe('1.3M')
    expect(formatNumber(12, { ...f, suffix: ' km' })).toBe('12 km')
  })

  it('draws a smooth line that never overshoots its points', () => {
    expect(monotonePath([])).toBe('')
    expect(monotonePath([[0, 5]])).toBe('M0,5')
    expect(monotonePath([
      [0, 5],
      [10, 7],
    ])).toBe('M0,5L10,7')
    const pts: [number, number][] = [
      [0, 100],
      [10, 0],
      [20, 0],
      [30, 100],
      [40, 60],
    ]
    const path = monotonePath(pts)
    expect(count(path, /C/g)).toBe(4)
    // Every control point lies between the two points of its segment.
    const segments = path.split('C').slice(1)
    segments.forEach((seg, i) => {
      const [c1, c2] = seg.split(' ').map((p) => p.split(',').map(Number))
      const [lo, hi] = [Math.min(pts[i][1], pts[i + 1][1]), Math.max(pts[i][1], pts[i + 1][1])]
      for (const c of [c1, c2]) {
        expect(c[1]).toBeGreaterThanOrEqual(lo - 1e-9)
        expect(c[1]).toBeLessThanOrEqual(hi + 1e-9)
      }
    })
  })
})

describe('chart params', () => {
  it('pick out the item a highlight names', () => {
    const data = 'Mon: 4\nTue: 9\nWed: 2'
    expect(chartSpec({ data, highlight: 'max' }).highlight).toBe(1)
    expect(chartSpec({ data, highlight: 'min' }).highlight).toBe(2)
    expect(chartSpec({ data, highlight: 'last' }).highlight).toBe(2)
    expect(chartSpec({ data, highlight: 'TUE' }).highlight).toBe(1)
    expect(chartSpec({ data, highlight: 'Sun' }).highlight).toBe(-1)
    expect(chartSpec({ data }).highlight).toBe(-1)
  })

  it('show the unit the data was written with unless one is given', () => {
    expect(chartSpec({ data: 'A: $4\nB: $9' }).format).toMatchObject({ prefix: '$', suffix: '' })
    expect(chartSpec({ data: 'A: $4\nB: $9', prefix: '', suffix: '' }).format).toMatchObject({ prefix: '$' })
    expect(chartSpec({ data: 'A: 4\nB: 9', suffix: 'km' }).format.suffix).toBe(' km')
    expect(chartSpec({ data: 'A: 4\nB: 9', unit: '%' }).format.suffix).toBe('%')
    expect(chartSpec({ data: 'A: 1500000\nB: 900000' }).format.compact).toBe(true)
    expect(chartSpec({ data: 'A: 1500000\nB: 900000', decimals: 0 }).format.compact).toBe(false)
  })
})

describe('chart pages', () => {
  const bars = { kind: 'bar', title: 'Weekly active users', subtitle: 'Thousands', data: 'Mon: 42\nTue: 58\nWed: 61\nThu: 74\nFri: 92', highlight: 'max', source: 'Internal data' }

  it('build a bar chart: bars, values that count up to the data, labels, ticks and a highlight', () => {
    const html = build(bars)
    expectValidPage(html)
    expect(count(html, /class="bar b\d/g)).toBe(5)
    expect(html).toContain('class="bar b4 hot"')
    for (const label of ['Mon', 'Fri', 'Weekly', 'Thousands', 'Internal data']) expect(markup(html)).toContain(label)
    for (const tick of ['>0<', '>20<', '>100<']) expect(markup(html)).toContain(tick)
    const page = run(html)
    const at = page.at(4)
    expect(at('.v0 .num').textContent).toBe('42')
    expect(at('.v4 .num').textContent).toBe('92')
    expect(page.end()).toBeLessThanOrEqual(FRAME.duration + 1e-9)
    // Every line of type that wipes out is hidden once out, so no shadow lingers in its mask on the last frame.
    const hidden = new Set(page.tweens.filter((t) => t.vars.visibility === 'hidden').flatMap((t) => t.targets))
    const leaving = page.tweens.filter((t) => t.vars.yPercent === -110).flatMap((t) => t.targets)
    expect(leaving.length).toBeGreaterThan(10)
    for (const el of leaving) expect(hidden.has(el)).toBe(true)
  })

  it('build a line chart that draws itself and calls out a value', () => {
    const html = build({ kind: 'line', title: 'Revenue', data: 'Jan: 12\nFeb: 15\nMar: 14\nApr: 19', prefix: '$', suffix: 'M' })
    expectValidPage(html)
    expect(html).toContain('class="stroke"')
    expect(html).toContain('class="area"')
    expect(count(html, /<circle class="pt/g)).toBe(4)
    expect(markup(html)).toContain('$20M')
    const page = run(html)
    expect(page.at(5)('.callout .num').textContent).toBe('$19M')
    expect(page.end()).toBeLessThanOrEqual(FRAME.duration + 1e-9)
  })

  it('build a donut from one value, as a percentage unless given a maximum', () => {
    const html = build({ kind: 'donut', title: 'Watch to the end', value: 72.5, label: 'Completion' })
    expectValidPage(html)
    expect(markup(html)).toContain('<span class="suf">%</span>')
    expect(run(html).at(5)('.centre .num').textContent).toBe('72.5')
    const outOf = build({ kind: 'donut', value: 3, max: 4, suffix: ' of 4' })
    expect(markup(outOf)).toContain(' of 4')
    expect(markup(outOf)).not.toContain('<span class="suf">%</span>')
  })

  it('split a donut into parts when it has data and no value, folding the smallest into “Other”', () => {
    const html = build({ kind: 'donut', title: 'Where viewers come from', data: 'Search: 40\nSocial: 25\nDirect: 15\nEmail: 8\nAds: 6\nPress: 4\nOther: 2', highlight: 'Social' })
    expectValidPage(html)
    expect(count(html, /class="seg"/g)).toBe(6)
    expect(markup(html)).toContain('<b>Other</b>')
    expect(run(html).at(5)('.centre .num').textContent).toBe('25')
  })

  it('build from empty data: the title and a baseline, nothing invented', () => {
    for (const kind of ['bar', 'line', 'donut']) {
      const html = build({ kind, title: 'Nothing yet', data: '' })
      expectValidPage(html)
      expect(html).not.toContain('class="bar b0')
      expect(html).not.toContain('class="stroke"')
      expect(() => run(html).at(3)).not.toThrow()
    }
    expect(markup(build({ kind: 'bar', data: [] }))).not.toMatch(/class="tk/)
  })

  it('build a single bar at a sensible width', () => {
    const html = build({ kind: 'bar', title: 'One', data: 'Only: 7' })
    expectValidPage(html)
    expect(count(html, /class="bar b\d/g)).toBe(1)
    const width = Number(/class="bar b0[^"]*" style="left: [\d.]+px; width: ([\d.]+)px/.exec(html)![1])
    expect(width).toBeLessThanOrEqual(132)
    expect(run(html).at(5)('.v0 .num').textContent).toBe('7')
  })

  it('hang negative bars below a zero line, with real minus signs', () => {
    const html = build({ kind: 'bar', data: 'Q1: 12\nQ2: -8\nQ3: 5\nQ4: -14' })
    expectValidPage(html)
    expect(count(html, /class="bar b\d neg/g)).toBe(2)
    expect(html).toContain('class="gl base"')
    expect(markup(html)).toMatch(/>−\d+</)
    const page = run(html)
    expect(page.at(5)('.v3 .num').textContent).toBe('−14')
    // The sign goes before the unit: −$8M, not $−8M.
    expect(run(build({ kind: 'bar', data: 'Q1: 12\nQ2: -8', prefix: '$', suffix: 'M' })).at(5)('.v1 .num').textContent).toBe('−$8M')
    const rows = build({ kind: 'bar', orientation: 'horizontal', data: 'Q1: 12\nQ2: -8' })
    expectValidPage(rows)
    expect(rows).toContain('class="bar b1 neg"')
  })

  it('turn bars on their side when the labels are long, and escape them', () => {
    const regions = ['North America & <Canada>', 'Europe, Middle East and Africa', 'Asia–Pacific including Oceania', 'Latin America and the Caribbean', 'Sub-Saharan Africa', 'Central Asia', 'Scandinavia', 'Southeast Asia']
    const data = regions.map((l, i) => `${l}: ${(i + 1) * 10}`).join('\n')
    const html = build({ kind: 'bar', title: 'Revenue by region', data })
    expectValidPage(html)
    expect(html).toContain('plot bars rows')
    expect(count(html, /class="cat c\d+/g)).toBe(8)
    expect(markup(html)).toContain('North America &amp; &lt;Canada&gt;')
    expect(markup(html)).not.toContain('<Canada>')
    // A few short labels stay in columns; asked for columns, long ones do too.
    expect(build({ kind: 'bar', data: 'North: 1\nSouth: 2\nEast: 3' })).not.toContain('plot bars rows')
    expect(build({ kind: 'bar', data, orientation: 'vertical' })).not.toContain('plot bars rows')
  })

  it('thin out labels and points when there are many', () => {
    const data = Array.from({ length: 200 }, (_, i) => `Day ${i + 1}: ${Math.round(50 + 40 * Math.sin(i / 9))}`).join('\n')
    const line = build({ kind: 'line', title: 'Two hundred days', data })
    expectValidPage(line)
    expect(count(/class="stroke" d="([^"]+)"/.exec(line)![1], /C/g)).toBe(199)
    // Only the called-out point keeps a dot; a handful of x labels, the first and the last among them.
    expect(count(line, /<circle class="pt/g)).toBe(1)
    const labels = count(line, /class="cat xl"/g)
    expect(labels).toBeGreaterThan(3)
    expect(labels).toBeLessThan(20)
    expect(markup(line)).toContain('Day 1<')
    expect(markup(line)).toContain('Day 200<')
    const page = run(line)
    expect(page.end()).toBeLessThanOrEqual(FRAME.duration + 1e-9)

    const many = build({ kind: 'bar', title: 'Thirty bars', data: Array.from({ length: 30 }, (_, i) => `${2000 + i}: ${i * 3 + 1}`).join('\n') })
    expectValidPage(many)
    expect(count(many, /class="bar b\d+/g)).toBe(30)
    expect(count(many, /class="cat c\d+/g)).toBeLessThan(30)
    expect(run(many).end()).toBeLessThanOrEqual(FRAME.duration + 1e-9)
  })

  it('fit any frame, and finish inside a short clip', () => {
    for (const frame of [
      { width: 1080, height: 1920, duration: 6 },
      { width: 1080, height: 1080, duration: 6 },
      { width: 3840, height: 2160, duration: 6 },
      { width: 1920, height: 1080, duration: 2 },
      { width: 1920, height: 1080, duration: 1 },
    ]) {
      for (const kind of ['bar', 'line', 'donut']) {
        const html = build({ ...bars, kind, value: 40, title: 'A long title that has to wrap across more than one line of the frame' }, frame)
        expectValidPage(html, frame.duration)
        expect(run(html).end(), `${kind} ${frame.width}x${frame.height} ${frame.duration}s`).toBeLessThanOrEqual(frame.duration + 1e-9)
      }
    }
  })

  it('are the same page for the same params, and use only the timeline’s time', () => {
    expect(build(bars)).toBe(build({ ...bars }))
    expect(build({ ...bars, kind: 'line' })).toBe(build({ ...bars, kind: 'line' }))
    for (const kind of ['bar', 'line', 'donut']) {
      const code = inlineScripts(build({ ...bars, kind }))[0]
      expect(code).not.toMatch(/Math\.random|Date\.now|new Date|performance\.now|requestAnimationFrame|setTimeout|setInterval/)
    }
  })

  it('stay up long enough to read their data', () => {
    expect(templateDuration('chart', bars)).toBeGreaterThanOrEqual(6)
    const twelve = { ...bars, data: Array.from({ length: 12 }, (_, i) => `M${i}: ${i}`).join('\n') }
    expect(templateDuration('chart', twelve)).toBeGreaterThan(templateDuration('chart', { ...bars, data: 'A: 1' }))
    expect(templateDuration('chart', { ...bars, data: Array.from({ length: 200 }, (_, i) => i) })).toBeLessThanOrEqual(24)
  })
})
