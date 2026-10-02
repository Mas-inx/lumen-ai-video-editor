/**
 * Where a piece of music's beats fall on the timeline: its clip's position,
 * trim and speed (ramps included) applied to the beat grid found in the media.
 */
import { clipEnd } from './ops'
import { localForConsumed } from './timing'
import type { Asset, Clip, Project } from './types'

export interface TimelineBeat {
  frame: number
  /** The first beat of a bar. */
  down: boolean
}

/** The beats of a clip's music, as timeline frames inside the clip (empty when its media has no beat grid). */
export function clipBeats(project: Pick<Project, 'assets' | 'settings'>, clip: Clip): TimelineBeat[] {
  const asset: Asset | undefined = clip.assetId ? project.assets[clip.assetId] : undefined
  const grid = asset?.beats
  if (!grid?.times.length || clip.reverse || clip.freeze) return []
  const fps = project.settings.fps
  const downs = new Set(grid.downbeats.map((t) => Math.round(t * 1000)))
  const out: TimelineBeat[] = []
  for (const t of grid.times) {
    const consumed = t * fps - clip.inPoint
    if (consumed < 0) continue
    const local = localForConsumed(clip, consumed)
    if (!Number.isFinite(local)) continue
    if (local >= clip.duration) break
    out.push({ frame: Math.round(clip.start + local), down: downs.has(Math.round(t * 1000)) })
  }
  return out
}

/** Every beat on the timeline, from the music clips that have beat grids (optionally only some clips). */
export function timelineBeats(project: Project, only?: string[]): TimelineBeat[] {
  const out: TimelineBeat[] = []
  for (const c of Object.values(project.clips)) {
    if (only && !only.includes(c.id)) continue
    if (c.kind !== 'audio' && c.kind !== 'video') continue
    out.push(...clipBeats(project, c))
  }
  return out.sort((a, b) => a.frame - b.frame)
}

/** The music clip whose beats a montage should follow: the selected one, else the longest audio clip with a beat grid (or any audio clip). */
export function musicClip(project: Project, preferred?: string): Clip | undefined {
  if (preferred && project.clips[preferred]) return project.clips[preferred]
  const audio = Object.values(project.clips).filter((c) => c.kind === 'audio' && c.assetId)
  const withGrid = audio.filter((c) => project.assets[c.assetId!]?.beats?.times.length)
  const pool = withGrid.length ? withGrid : audio
  return pool.sort((a, b) => clipEnd(b) - b.start - (clipEnd(a) - a.start))[0]
}
