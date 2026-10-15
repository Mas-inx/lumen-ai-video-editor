import { describe, expect, it } from 'vitest'
import { loadMonitor, MONITOR_DEFAULT, monitorGain, saveMonitor } from './monitor'

const memory = () => {
  const data = new Map<string, string>()
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data }
}

describe('preview volume', () => {
  it('plays at the export level by default', () => {
    expect(MONITOR_DEFAULT).toEqual({ volume: 1, muted: false })
    expect(monitorGain(MONITOR_DEFAULT)).toBe(1)
  })

  it('maps the slider so half way is about -12 dB, and mute is silence', () => {
    expect(20 * Math.log10(monitorGain({ volume: 0.5, muted: false }))).toBeCloseTo(-12.04, 1)
    expect(monitorGain({ volume: 0, muted: false })).toBe(0)
    expect(monitorGain({ volume: 0.7, muted: true })).toBe(0)
    expect(monitorGain({ volume: 3, muted: false })).toBe(1)
  })

  it('remembers the level and mute between sessions', () => {
    const store = memory()
    expect(loadMonitor(store)).toEqual(MONITOR_DEFAULT)
    saveMonitor({ volume: 0.35, muted: true }, store)
    expect(loadMonitor(store)).toEqual({ volume: 0.35, muted: true })
  })

  it('shrugs off damaged or missing storage', () => {
    const store = memory()
    store.data.set('lumen.monitor.v1', '{not json')
    expect(loadMonitor(store)).toEqual(MONITOR_DEFAULT)
    store.data.set('lumen.monitor.v1', JSON.stringify({ volume: 'loud', muted: 'yes' }))
    expect(loadMonitor(store)).toEqual(MONITOR_DEFAULT)
    store.data.set('lumen.monitor.v1', JSON.stringify({ volume: -2 }))
    expect(loadMonitor(store)).toEqual({ volume: 0, muted: false })
    expect(loadMonitor(null)).toEqual(MONITOR_DEFAULT)
    expect(() => saveMonitor({ volume: 1, muted: false }, { getItem: () => null, setItem: () => { throw new Error('full') } })).not.toThrow()
  })
})
