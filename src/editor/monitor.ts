/**
 * The preview's own volume: how loud Lumen plays while you edit. It comes after
 * the master bus and never reaches the project or an export, so it belongs to
 * the person, not the project: it is kept in this profile, not the project file.
 */

export interface MonitorLevel {
  /** Slider position, 0..1. 1 plays the mix at the level it will be exported at. */
  volume: number
  muted: boolean
}

export const MONITOR_DEFAULT: MonitorLevel = { volume: 1, muted: false }

const KEY = 'lumen.monitor.v1'

type Store = Pick<Storage, 'getItem' | 'setItem'>

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : MONITOR_DEFAULT.volume)

/** The gain for a level. Squared, so the slider's travel sounds even: half way is about -12 dB. */
export const monitorGain = (m: MonitorLevel) => (m.muted ? 0 : clamp01(m.volume) ** 2)

function storage(): Store | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

export function loadMonitor(store: Store | null = storage()): MonitorLevel {
  try {
    const saved = JSON.parse(store?.getItem(KEY) ?? 'null') as Partial<MonitorLevel> | null
    if (!saved || typeof saved !== 'object') return { ...MONITOR_DEFAULT }
    return { volume: clamp01(Number(saved.volume)), muted: saved.muted === true }
  } catch {
    return { ...MONITOR_DEFAULT }
  }
}

export function saveMonitor(m: MonitorLevel, store: Store | null = storage()) {
  try {
    store?.setItem(KEY, JSON.stringify({ volume: clamp01(m.volume), muted: m.muted }))
  } catch {
    /* private or full storage: the level lasts until Lumen closes */
  }
}
