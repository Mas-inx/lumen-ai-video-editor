import { describe, expect, it } from 'vitest'
import { Lru } from './lru'

/** A cache of strings whose size is their length, remembering what it let go. */
function cache(opts: { max?: number; budget?: number; pinned?: (key: string) => boolean } = {}) {
  const evicted: string[] = []
  const lru = new Lru<string, string>({ ...opts, size: (v) => v.length, evict: (_v, k) => evicted.push(k) })
  return { lru, evicted }
}

describe('Lru', () => {
  it('keeps at most `max` entries, letting the least recently used go first', () => {
    const { lru, evicted } = cache({ max: 3 })
    lru.set('a', 'x').set('b', 'x').set('c', 'x')
    lru.get('a')
    lru.set('d', 'x')
    expect(evicted).toEqual(['b'])
    expect([...lru.keys()]).toEqual(['c', 'a', 'd'])
  })

  it('keeps within a byte budget', () => {
    const { lru, evicted } = cache({ budget: 10 })
    lru.set('a', '1234').set('b', '1234').set('c', '1234')
    expect(evicted).toEqual(['a'])
    expect(lru.used).toBe(8)
    expect(lru.count).toBe(2)
  })

  it('never lets go of the entry just added, even when it alone is over budget', () => {
    const { lru, evicted } = cache({ budget: 10 })
    lru.set('a', '12').set('b', '12')
    lru.set('big', '1234567890123')
    expect(evicted).toEqual(['a', 'b'])
    expect(lru.peek('big')).toBe('1234567890123')
    expect(lru.used).toBe(13)
  })

  it('peeks without making an entry recent', () => {
    const { lru, evicted } = cache({ max: 2 })
    lru.set('a', 'x').set('b', 'x')
    expect(lru.peek('a')).toBe('x')
    lru.set('c', 'x')
    expect(evicted).toEqual(['a'])
  })

  it('counts entries that cost nothing yet towards `max` only', () => {
    const { lru, evicted } = cache({ max: 3, budget: 5 })
    lru.set('loading', '').set('a', '123')
    lru.set('b', '123')
    // Over budget: the loading entry is older, but letting it go wouldn't help.
    expect(evicted).toEqual(['a'])
    lru.set('c', '1')
    lru.set('d', '1')
    // Over the count: now any entry can go, oldest first.
    expect(evicted).toEqual(['a', 'loading'])
  })

  it('re-measures an entry set again (it has finished loading)', () => {
    const entry = { bytes: 0 }
    const evicted: string[] = []
    const lru = new Lru<string, { bytes: number }>({ budget: 10, size: (v) => v.bytes, evict: (_v, k) => evicted.push(k) })
    lru.set('old', { bytes: 6 })
    lru.set('new', entry)
    expect(lru.used).toBe(6)
    entry.bytes = 8
    lru.set('new', entry)
    expect(lru.used).toBe(8)
    expect(evicted).toEqual(['old'])
  })

  it('measures an entry again where it stands, without making it recent', () => {
    const entry = { bytes: 0 }
    const evicted: string[] = []
    const lru = new Lru<string, { bytes: number }>({ budget: 10, size: (v) => v.bytes, evict: (_v, k) => evicted.push(k) })
    lru.set('loading', entry).set('a', { bytes: 3 }).set('b', { bytes: 3 })
    entry.bytes = 6
    lru.measure('loading')
    // It pushes the next oldest out, and stays the least recent itself.
    expect(evicted).toEqual(['a'])
    expect([...lru.keys()]).toEqual(['loading', 'b'])
    lru.set('c', { bytes: 3 })
    expect(evicted).toEqual(['a', 'loading'])
    lru.measure('gone')
    expect(lru.used).toBe(6)
  })

  it('tells `evict` about a value replaced by a different one, not the same one set again', () => {
    const { lru, evicted } = cache()
    const v = 'same'
    lru.set('a', v).set('a', v)
    expect(evicted).toEqual([])
    lru.set('a', 'other')
    expect(evicted).toEqual(['a'])
  })

  it('never lets go of pinned entries', () => {
    const pins = new Set(['a'])
    const { lru, evicted } = cache({ max: 2, pinned: (k) => pins.has(k) })
    lru.set('a', 'x').set('b', 'x').set('c', 'x')
    expect(evicted).toEqual(['b'])
    pins.clear()
    lru.set('d', 'x')
    expect(evicted).toEqual(['b', 'a'])
  })

  it('deletes, prunes and clears, telling `evict` each time', () => {
    const { lru, evicted } = cache()
    lru.set('a1', 'x').set('a2', 'xx').set('b1', 'xxx')
    expect(lru.delete('a1')).toBe(true)
    expect(lru.delete('a1')).toBe(false)
    lru.prune((k) => k.startsWith('b'))
    expect(evicted).toEqual(['a1', 'a2'])
    expect(lru.used).toBe(3)
    lru.clear()
    expect(evicted).toEqual(['a1', 'a2', 'b1'])
    expect(lru.count).toBe(0)
    expect(lru.used).toBe(0)
  })
})
