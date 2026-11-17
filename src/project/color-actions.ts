/**
 * Colour correction measured from the footage itself: automatic white balance
 * and levels, and matching clips to a reference shot. Frames of the media —
 * the footage as it came in — are measured small, and the result goes through
 * clip.update, so it undoes like any edit. Shared by the inspector, the
 * command palette and the AI tools.
 */
import { autoBalance, autoLevels, colorDistance, correctPixels, matchCurves, samplePixels } from '@/editor/color-correct'
import { dispatch, getProject, useEditor, type ActionSource } from '@/editor/store'
import type { Clip, ColorGrade, Levels, ShotMatch, WhiteBalance } from '@/editor/types'
import { clipSourceTime } from '@/engine/compositor'
import { mediaStills } from '@/engine/stills'

function pictureClip(id: string): Clip {
  const clip = getProject().clips[id]
  if (!clip) throw new Error(`There’s no clip ${id}.`)
  if (clip.kind !== 'video' && clip.kind !== 'image') throw new Error(`“${clip.name}” isn’t a video or image clip — there’s no footage to measure.`)
  if (clip.sequenceId) throw new Error(`“${clip.name}” plays a nested timeline: open it and correct the clips inside.`)
  return clip
}

/** The footage a clip shows, measured: `frames` frames spread across it, `width` pixels wide, as RGB samples. */
export async function clipPixels(clip: Clip, frames = 3, width = 160): Promise<Float32Array> {
  const project = getProject()
  const asset = clip.assetId ? project.assets[clip.assetId] : undefined
  if (!asset || asset.kind === 'audio') throw new Error(`“${clip.name}” has no picture to measure.`)
  const fps = project.settings.fps
  const n = asset.kind === 'image' ? 1 : frames
  const times = Array.from({ length: n }, (_, i) => clipSourceTime(clip, Math.round(((i + 0.5) / n) * Math.max(0, clip.duration - 1)), fps))
  const stills = await mediaStills(asset, times, width)
  const parts = stills.map((c) => samplePixels(c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data))
  const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  if (out.length < 30) throw new Error(`Couldn’t read enough of “${clip.name}” to measure it.`)
  return out
}

const fail = (res: { ok: true } | { ok: false; error: string }) => {
  if (!res.ok) throw new Error(res.error)
}

export interface AutoColorResult {
  clipId: string
  balance?: WhiteBalance
  levels?: Levels
}

/**
 * Automatic correction for each clip on its own: a white balance that takes
 * out the light's colour cast, then levels that set black and white. One undo step.
 */
export async function autoColor(clipIds: string[], opts: { balance?: boolean; levels?: boolean; source?: ActionSource } = {}): Promise<AutoColorResult[]> {
  const results: AutoColorResult[] = []
  for (const id of clipIds) {
    const px = await clipPixels(pictureClip(id))
    const balance = opts.balance === false ? undefined : autoBalance(px)
    const levels = opts.levels === false ? undefined : autoLevels(balance ? correctPixels(px, { balance }) : px)
    results.push({ clipId: id, ...(balance ? { balance } : {}), ...(levels ? { levels } : {}) })
  }
  let error: string | null = null
  useEditor.getState().transaction(clipIds.length > 1 ? `Auto colour ${clipIds.length} clips` : 'Auto colour', opts.source ?? 'user', () => {
    for (const r of results) {
      const res = dispatch('clip.update', { ids: [r.clipId], patch: { color: { ...(r.balance ? { balance: r.balance } : {}), ...(r.levels ? { levels: r.levels } : {}) } } })
      if (!res.ok) error ??= res.error
    }
  })
  if (error) throw new Error(error)
  return results
}

/** The creative grade (everything but the correction), for copying a reference's look along with a match. */
function lookOf(g: ColorGrade): NonNullable<Parameters<typeof dispatch<'clip.update'>>[1]['patch']>['color'] {
  return {
    exposure: g.exposure,
    contrast: g.contrast,
    saturation: g.saturation,
    temperature: g.temperature,
    tint: g.tint,
    vignette: g.vignette,
    curves: g.curves ?? null,
    wheels: g.wheels ?? null,
    hsl: g.hsl ?? null,
    lut: g.lut ?? null,
  }
}

export interface MatchResult {
  clipId: string
  match: ShotMatch
  /** How far the clip was from the reference before and after (0 = identical), in tone and colour. */
  before: number
  after: number
}

/**
 * Matches clips to a reference: each clip's footage is lined up with how the
 * reference looks after its own correction — shadows, midtones, highlights and
 * colour cast. The match replaces the clip's own balance and levels. With
 * `copyLook`, the reference's creative grade comes too, so the shots cut
 * together. One undo step.
 */
export async function matchColor(clipIds: string[], refId: string, opts: { copyLook?: boolean; source?: ActionSource } = {}): Promise<MatchResult[]> {
  const ref = pictureClip(refId)
  const target = correctPixels(await clipPixels(ref), ref.color)
  const results: MatchResult[] = []
  for (const id of clipIds) {
    if (id === refId) continue
    const clip = pictureClip(id)
    const px = await clipPixels(clip)
    const curves = matchCurves(px, target)
    const match: ShotMatch = { ...curves, ref: refId }
    results.push({ clipId: id, match, before: colorDistance(correctPixels(px, clip.color), target), after: colorDistance(correctPixels(px, { match }), target) })
  }
  if (!results.length) throw new Error('Pick the clips to match, other than the reference.')
  let error: string | null = null
  useEditor.getState().transaction(`Match colour to “${ref.name}”`, opts.source ?? 'user', () => {
    for (const r of results) {
      const color = { ...(opts.copyLook ? lookOf(ref.color) : {}), balance: null, levels: null, match: r.match }
      const res = dispatch('clip.update', { ids: [r.clipId], patch: { color, ...(opts.copyLook ? { look: ref.look } : {}) } })
      if (!res.ok) error ??= res.error
    }
  })
  if (error) throw new Error(error)
  return results
}

/** Sets a clip's white balance from a colour picked off something that should be neutral. One undo step. */
export function setBalance(clipIds: string[], balance: WhiteBalance, source: ActionSource = 'user') {
  fail(dispatch('clip.update', { ids: clipIds, patch: { color: { balance } } }, { source, label: 'White balance' }))
}
