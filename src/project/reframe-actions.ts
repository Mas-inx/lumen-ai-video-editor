/**
 * Reframing that keeps the subject in frame: before the canvas changes shape,
 * each shot that fills the frame is looked at — its subject matte's box when
 * it has one (a person cut out), otherwise a few small frames of the footage
 * — and reframe() then places the picture so its subject stays in view.
 */
import type { ActionSource } from '@/editor/store'
import { getProject } from '@/editor/store'
import { reframe } from '@/editor/smart'
import { focusKey, focusOf, medianFocus, type Focus } from '@/editor/subject-frame'
import type { Clip, Project } from '@/editor/types'
import { clipSourceTime } from '@/engine/compositor'
import { mediaStills } from '@/engine/stills'

/** Below this, a reading is too unsure to move a shot for: it stays centred. */
const MIN_CONFIDENCE = 0.12

/** The shots reframe() moves: video and image clips at their own size that filled the canvas. */
export function framedShots(project: Project): Clip[] {
  const { width: W, height: H } = project.settings
  return Object.values(project.clips).filter((c) => {
    if ((c.kind !== 'video' && c.kind !== 'image') || !c.assetId || c.sequenceId) return false
    const a = project.assets[c.assetId]
    if (!a?.width || !a.height || a.alpha || Math.abs(c.transform.scale - 1) > 0.001) return false
    const contain = Math.min(W / a.width, H / a.height)
    const cover = Math.max(W / a.width, H / a.height)
    return Math.abs(contain - cover) / cover <= 0.02
  })
}

/** Where the subject of a shot is: its matte's box, else read from three small frames. */
export async function shotFocus(clip: Clip, project: Project = getProject()): Promise<Focus> {
  const box = clip.matte && !clip.matte.invert ? project.assets[clip.matte.assetId]?.matteOf?.box : undefined
  if (box) return { x: box.x + box.w / 2, y: box.y + box.h / 2, confidence: 1 }
  const asset = clip.assetId ? project.assets[clip.assetId] : undefined
  if (!asset || asset.kind === 'audio') return { x: 0.5, y: 0.5, confidence: 0 }
  const fps = project.settings.fps
  const n = asset.kind === 'image' ? 1 : 3
  const times = Array.from({ length: n }, (_, i) => clipSourceTime(clip, Math.round(((i + 0.5) / n) * Math.max(0, clip.duration - 1)), fps))
  const stills = await mediaStills(asset, times, 128)
  return medianFocus(stills.map((c) => focusOf(c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data, c.width, c.height)))
}

/** Each framed shot's focus, by footage and stretch (shared by copies of the shot on other timelines). */
export async function subjectFocus(project: Project = getProject(), onProgress?: (done: number, total: number) => void): Promise<Map<string, Focus>> {
  const shots = framedShots(project)
  const unique = new Map<string, Clip>()
  for (const c of shots) if (!unique.has(focusKey(c))) unique.set(focusKey(c), c)
  const out = new Map<string, Focus>()
  let done = 0
  for (const [key, clip] of unique) {
    try {
      const f = await shotFocus(clip, project)
      if (f.confidence >= MIN_CONFIDENCE) out.set(key, f)
    } catch {
      /* unreadable footage stays centred */
    }
    onProgress?.(++done, unique.size)
  }
  return out
}

/**
 * Changes the canvas size and reframes everything, keeping each shot's subject
 * in view (with `followSubject` false, shots stay centred). One undo step.
 */
export async function smartReframe(width: number, height: number, opts: { source?: ActionSource; followSubject?: boolean; onProgress?: (done: number, total: number) => void } = {}) {
  const focus = opts.followSubject === false ? new Map<string, Focus>() : await subjectFocus(getProject(), opts.onProgress)
  const res = reframe(width, height, opts.source ?? 'ai', (c) => focus.get(focusKey(c)))
  return { ...res, followed: focus.size }
}
