/**
 * A least-recently-used cache with a budget: at most `max` entries and, given a
 * `size` for each value, at most `budget` units (usually bytes) in all. Reading
 * an entry with `get` makes it the most recent; past the budget the least recent
 * go first, and `evict` is told about each one (to close or free it). An entry
 * that costs nothing yet (still loading) only counts towards `max`; the entry
 * just added, and any `pinned` one, is never the one that goes.
 */
export interface LruOptions<K, V> {
  max?: number
  budget?: number
  size?: (value: V) => number
  evict?: (value: V, key: K) => void
  /** Entries in use that mustn't go yet (they still count). */
  pinned?: (key: K) => boolean
}

export class Lru<K, V> {
  private entries = new Map<K, { value: V; size: number }>()
  private total = 0

  constructor(private readonly opts: LruOptions<K, V> = {}) {}

  /** How many entries there are. */
  get count() {
    return this.entries.size
  }

  /** Units in use: the sum of the entries' sizes. */
  get used() {
    return this.total
  }

  has(key: K) {
    return this.entries.has(key)
  }

  /** The value, made the most recent. */
  get(key: K): V | undefined {
    const e = this.entries.get(key)
    if (!e) return undefined
    this.entries.delete(key)
    this.entries.set(key, e)
    return e.value
  }

  /** The value, leaving its place alone. */
  peek(key: K): V | undefined {
    return this.entries.get(key)?.value
  }

  /**
   * Adds an entry, or replaces one (setting the same value again re-measures it,
   * for something that has finished loading). It becomes the most recent, and the
   * least recent others go while the cache is over its budget.
   */
  set(key: K, value: V) {
    const old = this.entries.get(key)
    if (old) {
      this.entries.delete(key)
      this.total -= old.size
      if (old.value !== value) this.opts.evict?.(old.value, key)
    }
    const size = this.opts.size ? Math.max(0, this.opts.size(value)) : 0
    this.entries.set(key, { value, size })
    this.total += size
    this.trim(key)
    return this
  }

  /** Measures an entry again where it stands (it has finished loading), letting others go if that puts the cache over budget. */
  measure(key: K) {
    const e = this.entries.get(key)
    if (!e) return
    const size = this.opts.size ? Math.max(0, this.opts.size(e.value)) : 0
    this.total += size - e.size
    e.size = size
    this.trim(key)
  }

  /** Lets an entry go (telling `evict`). */
  delete(key: K) {
    const e = this.entries.get(key)
    if (!e) return false
    this.entries.delete(key)
    this.total -= e.size
    this.opts.evict?.(e.value, key)
    return true
  }

  /** Lets go of every entry `keep` says no to. */
  prune(keep: (key: K, value: V) => boolean) {
    for (const [key, e] of [...this.entries]) if (!keep(key, e.value)) this.delete(key)
  }

  clear() {
    this.prune(() => false)
  }

  /** Keys from the least to the most recent. */
  keys() {
    return this.entries.keys()
  }

  *values() {
    for (const e of this.entries.values()) yield e.value
  }

  private trim(keep: K) {
    const max = this.opts.max ?? Infinity
    const budget = this.opts.budget ?? Infinity
    // A Map iterates oldest first, and entries can be deleted along the way.
    for (const [key, e] of this.entries) {
      const overCount = this.entries.size > max
      if (!overCount && this.total <= budget) break
      if (key === keep || this.opts.pinned?.(key)) continue
      // Over the budget only, letting go of an entry that costs nothing wouldn't help.
      if (!overCount && e.size === 0) continue
      this.entries.delete(key)
      this.total -= e.size
      this.opts.evict?.(e.value, key)
    }
  }
}
