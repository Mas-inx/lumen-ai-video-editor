import { describe, expect, it } from 'vitest'
import { CHART_MAX_ITEMS, chartData, chartKind, parseChartData, particleDirection, particleStyle, readNumber } from './motion'

const pairs = (input: unknown) => parseChartData(input).items.map((d) => [d.label, d.value])

describe('chart data', () => {
  it('reads "Label: value" lines, and the other ways people separate them', () => {
    const data = parseChartData('Mon: 42\nTue: 58\n\nWed = 61\nThu\t74\nFri 92\n# a comment')
    expect(data.items).toEqual([
      { label: 'Mon', value: 42 },
      { label: 'Tue', value: 58 },
      { label: 'Wed', value: 61 },
      { label: 'Thu', value: 74 },
      { label: 'Fri', value: 92 },
    ])
    expect(data.skipped).toEqual([])
  })

  it('keeps colons and commas in labels, and reads numbers as they are written', () => {
    expect(pairs('Q1: 2024: 1,234.5\nParis, France: −3\nRate: 12.5%\nBudget: $1,200\nSales, 1,234')).toEqual([
      ['Q1: 2024', 1234.5],
      ['Paris, France', -3],
      ['Rate', 12.5],
      ['Budget', 1200],
      ['Sales', 1234],
    ])
  })

  it('takes a unit that every value was written with', () => {
    expect(parseChartData('A: $12\nB: $7.50')).toMatchObject({ prefix: '$', suffix: '', decimals: 2 })
    expect(parseChartData('A: 40%\nB: 55%')).toMatchObject({ prefix: '', suffix: '%', decimals: 0 })
    expect(parseChartData('North: 12 km\nSouth: 9 km')).toMatchObject({ suffix: ' km' })
    expect(parseChartData('A: $12\nB: 7')).toMatchObject({ prefix: '', suffix: '' })
    expect(parseChartData('A: -$5\nB: $3')).toMatchObject({ prefix: '$', items: [{ label: 'A', value: -5 }, { label: 'B', value: 3 }] })
  })

  it('brings mixed magnitudes to one scale, and keeps a shared one as the unit', () => {
    expect(parseChartData('A: 900k\nB: 1.2M')).toMatchObject({ suffix: '', items: [{ value: 900_000 }, { value: 1_200_000 }] })
    expect(parseChartData('A: 1.2M\nB: 3.4M')).toMatchObject({ suffix: 'M', decimals: 1, items: [{ value: 1.2 }, { value: 3.4 }] })
  })

  it('says which lines it couldn’t read', () => {
    const data = parseChartData('A: 1\nB: lots\nC: 3\nD:')
    expect(data.items.map((d) => d.label)).toEqual(['A', 'C'])
    expect(data.skipped).toEqual([2, 4])
  })

  it('takes the shapes agents send', () => {
    expect(pairs([{ label: 'A', value: 1 }, { name: 'B', y: '2' }, { category: 'C', count: 3 }])).toEqual([
      ['A', 1],
      ['B', 2],
      ['C', 3],
    ])
    expect(pairs([['A', 1], ['B', -2.5]])).toEqual([
      ['A', 1],
      ['B', -2.5],
    ])
    expect(pairs({ A: 1, B: '2' })).toEqual([
      ['A', 1],
      ['B', 2],
    ])
    expect(pairs({ labels: ['A', 'B'], values: [1, 2] })).toEqual([
      ['A', 1],
      ['B', 2],
    ])
    expect(pairs('[{"label":"A","value":3}]')).toEqual([['A', 3]])
    expect(pairs([5, 6])).toEqual([
      ['', 5],
      ['', 6],
    ])
    expect(pairs(['Mon: 4', 'Tue: 5'])).toEqual([
      ['Mon', 4],
      ['Tue', 5],
    ])
    expect(chartData({ labels: ['x'], values: [9] }).items).toEqual([{ label: 'x', value: 9 }])
    expect(chartData({ data: 'y: 1', labels: ['x'], values: [9] }).items).toEqual([{ label: 'y', value: 1 }])
  })

  it('gives nothing back for nothing, and drops values that aren’t numbers', () => {
    for (const empty of [undefined, null, '', '   \n  ', [], {}, 42, '[not json']) expect(parseChartData(empty).items).toEqual([])
    expect(pairs([{ label: 'A', value: 'n/a' }, { label: 'B', value: Number.NaN }, { label: 'C', value: Infinity }, { label: 'D', value: 4 }])).toEqual([['D', 4]])
  })

  it('tidies labels and keeps a chart to what can be shown', () => {
    expect(pairs({ '  Spaced   out  ': 1 })).toEqual([['Spaced out', 1]])
    expect(parseChartData({ ['x'.repeat(200)]: 1 }).items[0].label).toHaveLength(80)
    expect(parseChartData(Array.from({ length: 500 }, (_, i) => i)).items).toHaveLength(CHART_MAX_ITEMS)
  })
})

describe('numbers', () => {
  it('reads what people type', () => {
    expect(readNumber('1,234.5')).toEqual({ value: 1234.5, prefix: '', suffix: '', decimals: 1 })
    expect(readNumber(' -$5 ')).toMatchObject({ value: -5, prefix: '$' })
    expect(readNumber('$-5')).toMatchObject({ value: -5, prefix: '$' })
    expect(readNumber('1,5')).toMatchObject({ value: 1.5 })
    expect(readNumber('€ 3.20')).toMatchObject({ value: 3.2, prefix: '€', decimals: 2 })
    expect(readNumber('.5')).toMatchObject({ value: 0.5 })
    // Thousands grouped with a (narrow) no-break space, as French and Swiss writing does.
    expect(readNumber(`12${String.fromCharCode(0xa0)}500`)).toMatchObject({ value: 12500 })
    expect(readNumber(`1${String.fromCharCode(0x202f)}234,5`)).toMatchObject({ value: 1234.5, decimals: 1 })
    expect(readNumber("12'500")).toMatchObject({ value: 12500 })
    expect(readNumber(`1${String.fromCharCode(0x202f)}234`)).toMatchObject({ value: 1234 })
    expect(readNumber(7)).toMatchObject({ value: 7, decimals: 0 })
  })

  it('refuses what isn’t one number', () => {
    for (const text of ['', 'n/a', '12 of 20', 'about twelve', null, undefined, Number.NaN, {}]) expect(readNumber(text)).toBeNull()
  })
})

describe('template options', () => {
  it('fall back to defaults the editor and templates agree on', () => {
    expect(particleStyle('glitter')).toBe('dust')
    expect(particleStyle('embers')).toBe('embers')
    expect(particleDirection(undefined, 'embers')).toBe('below')
    expect(particleDirection(undefined, 'sparks')).toBe('left')
    expect(particleDirection('right', 'embers')).toBe('right')
    expect(particleDirection('above', 'dust')).toBe('everywhere')
    expect(chartKind('pie')).toBe('bar')
    expect(chartKind('donut')).toBe('donut')
  })
})
