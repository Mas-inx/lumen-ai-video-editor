/**
 * Parameters of the motion-graphic templates that both sides read: the editor
 * (the Generate panel and the AI's render_motion_graphic) and the main process,
 * which builds the HyperFrames compositions (electron/integrations/hyperframes).
 *
 * Chart data comes as text from the panel ("Label: value", one per line) and as
 * JSON from agents, in whatever shape they chose. Both are read here, the same way.
 */

export const PARTICLE_STYLES = ['dust', 'sparks', 'embers', 'digital'] as const
export type ParticleStyle = (typeof PARTICLE_STYLES)[number]

export const PARTICLE_DIRECTIONS = ['left', 'right', 'below', 'everywhere'] as const
export type ParticleDirection = (typeof PARTICLE_DIRECTIONS)[number]

/** Where each style's particles come from unless asked otherwise. */
export const PARTICLE_DEFAULT_DIRECTION: Record<ParticleStyle, ParticleDirection> = { dust: 'everywhere', sparks: 'left', embers: 'below', digital: 'everywhere' }

export const particleStyle = (v: unknown): ParticleStyle => (PARTICLE_STYLES.includes(v as ParticleStyle) ? (v as ParticleStyle) : 'dust')
export const particleDirection = (v: unknown, style: ParticleStyle): ParticleDirection => (PARTICLE_DIRECTIONS.includes(v as ParticleDirection) ? (v as ParticleDirection) : PARTICLE_DEFAULT_DIRECTION[style])

export const CHART_KINDS = ['bar', 'line', 'donut'] as const
export type ChartKind = (typeof CHART_KINDS)[number]

export const chartKind = (v: unknown): ChartKind => (CHART_KINDS.includes(v as ChartKind) ? (v as ChartKind) : 'bar')

/** More than a chart can show legibly; anything after it is left out. */
export const CHART_MAX_ITEMS = 240

export interface ChartDatum {
  label: string
  value: number
}

export interface ChartData {
  items: ChartDatum[]
  /** A symbol every value was written with ("$", "%", " km"), shown with the numbers unless the params name one. */
  prefix: string
  suffix: string
  /** The most decimals any value was written with (at most 3). */
  decimals: number
  /** Lines (1-based) of text data that couldn't be read. */
  skipped: number[]
}

interface Reading {
  value: number
  prefix: string
  suffix: string
  decimals: number
}

const MAGNITUDE: Record<string, number> = { k: 1e3, K: 1e3, M: 1e6, mn: 1e6, B: 1e9, bn: 1e9, T: 1e12 }
const NUMBER = /[+-]?(?:\d[\d,'\u00a0\u202f]*(?:\.\d+)?|\.\d+)/

/** A number as people write it: "1,234.5", "$12", "-8%", "−3", "4.2M", "12 km". */
export function readNumber(input: unknown): Reading | null {
  if (typeof input === 'number') return Number.isFinite(input) ? { value: input, prefix: '', suffix: '', decimals: decimalsOf(String(input)) } : null
  if (typeof input !== 'string') return null
  const text = input.trim().replace(/[\u2212\u2013\u2014]/g, '-')
  const m = NUMBER.exec(text)
  if (!m) return null
  let core = m[0]
  let prefix = text.slice(0, m.index).trim()
  // A sign written before the symbol ("-$5") belongs to the number.
  if (/^[+-]/.test(prefix) && !/^[+-]/.test(core)) {
    core = prefix[0] + core
    prefix = prefix.slice(1).trim()
  }
  const suffix = text
    .slice(m.index + m[0].length)
    .replace(/^\s+/, ' ')
    .trimEnd()
  const digits = core.replace(/^[+-]/, '')
  let clean: string
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(digits)) clean = digits.replace(/,/g, '')
  // Thousands set apart by a (narrow) no-break space or an apostrophe, with a decimal comma: "1 234,5", "12'500".
  else if (/^\d{1,3}([\u00a0\u202f']\d{3})+(,\d+)?$/.test(digits)) clean = digits.replace(/[\u00a0\u202f']/g, '').replace(',', '.')
  else if (/^\d+,\d+$/.test(digits)) clean = digits.replace(',', '.')
  else clean = digits.replace(/[,'\u00a0\u202f]/g, '')
  const value = Number((core.startsWith('-') ? '-' : '') + clean)
  if (!Number.isFinite(value) || prefix.length > 4 || /\d/.test(suffix)) return null
  return { value, prefix, suffix, decimals: decimalsOf(clean) }
}

const decimalsOf = (s: string) => Math.min(3, /\.(\d+)$/.exec(s)?.[1].length ?? 0)

/** Splits "Label: value" (or "Label = value", "Label<tab>value", "Label 42") into its two halves. */
function splitLine(line: string): [string, string] {
  const at = Math.max(line.lastIndexOf(':'), line.lastIndexOf('='), line.lastIndexOf('\t'), line.lastIndexOf('|'))
  if (at >= 0) return [line.slice(0, at), line.slice(at + 1)]
  const m = /^(.*?)[\s,;]+([^\s,;]*\d[^\s;]*)$/.exec(line)
  return m ? [m[1], m[2]] : ['', line]
}

const LABEL_KEYS = ['label', 'name', 'category', 'key', 'x']
const VALUE_KEYS = ['value', 'y', 'count', 'amount', 'total', 'v']

const cleanLabel = (v: unknown) =>
  String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)

/**
 * Reads chart data from what the panel or an agent sent: "Label: value" lines,
 * a JSON string, [{ label, value }], [label, value] pairs, plain numbers,
 * { label: value } or { labels, values }.
 */
export function parseChartData(input: unknown): ChartData {
  const raw: { label: unknown; value: unknown; line?: number }[] = []
  const skipped: number[] = []
  const add = (label: unknown, value: unknown, line?: number) => raw.push({ label, value, line })

  let data = input
  if (typeof data === 'string' && /^\s*[[{]/.test(data)) {
    try {
      data = JSON.parse(data)
    } catch {
      // Not JSON after all: read it as lines.
    }
  }
  if (typeof data === 'string') {
    data.split(/\r?\n/).forEach((line, i) => {
      const text = line.trim()
      if (!text || text.startsWith('#')) return
      const [label, value] = splitLine(text)
      if (readNumber(value)) add(label, value, i + 1)
      else skipped.push(i + 1)
    })
  } else if (Array.isArray(data)) {
    data.forEach((d, i) => {
      if (Array.isArray(d)) add(d[0], d[1])
      else if (d && typeof d === 'object') {
        const o = d as Record<string, unknown>
        add(o[LABEL_KEYS.find((k) => k in o) ?? 'label'], o[VALUE_KEYS.find((k) => k in o) ?? 'value'])
      } else if (typeof d === 'string') {
        const [label, value] = splitLine(d.trim())
        add(label, value, i + 1)
      } else add('', d)
    })
  } else if (data && typeof data === 'object') {
    const o = data as Record<string, unknown>
    if (Array.isArray(o.labels) && Array.isArray(o.values)) o.values.forEach((v, i) => add((o.labels as unknown[])[i], v))
    else for (const [k, v] of Object.entries(o)) add(k, v)
  }

  const read = raw.map((r) => ({ label: cleanLabel(r.label), reading: readNumber(r.value), line: r.line }))
  for (const r of read) if (!r.reading && r.line && !skipped.includes(r.line)) skipped.push(r.line)
  const ok = read.filter((r): r is { label: string; reading: Reading; line: number | undefined } => r.reading !== null).slice(0, CHART_MAX_ITEMS)

  // One symbol on every value is a unit worth showing; different magnitudes ("900k", "1.2M") are scaled to one.
  const same = (key: 'prefix' | 'suffix') => (ok.length && ok.every((r) => r.reading[key] === ok[0].reading[key]) ? ok[0].reading[key] : '')
  const prefix = same('prefix')
  const suffix = same('suffix')
  const magnitudes = ok.map((r) => r.reading.suffix.trim())
  const scale = !suffix && magnitudes.some((m) => m in MAGNITUDE) && magnitudes.every((m) => !m || m in MAGNITUDE)
  const items = ok.map((r) => ({ label: r.label, value: scale ? r.reading.value * (MAGNITUDE[r.reading.suffix.trim()] ?? 1) : r.reading.value }))
  return { items, prefix, suffix, decimals: scale ? 0 : Math.max(0, ...ok.map((r) => r.reading.decimals)), skipped: skipped.sort((a, b) => a - b) }
}

/** A chart's data from its params: `data`, or `labels` with `values` side by side. */
export const chartData = (p: Record<string, unknown>) => parseChartData(p.data ?? (Array.isArray(p.labels) && Array.isArray(p.values) ? { labels: p.labels, values: p.values } : undefined))
