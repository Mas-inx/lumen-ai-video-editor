/**
 * Smart transitions: reading the two shots at a cut — where each one's subject
 * is, how the camera moves, how the outgoing frame lines up with the incoming
 * one, how their colours differ — choosing the transition that ties them
 * together, and timing it so the shots swap on the music's beat.
 *
 * Frames come from the media itself, frame-exact (titles, adjustment layers
 * and nested timelines are read from the timeline as it renders). What's read
 * is stored on the transition, so preview and export draw it identically.
 */
import { colorDistance, matchCurves, samplePixels } from '@/editor/color-correct'
import { timelineBeats } from '@/editor/beat-grid'
import { adjacentBefore } from '@/editor/ops'
import { isSmartTransition } from '@/editor/presets'
import { dispatch, getProject, useEditor, type ActionSource } from '@/editor/store'
import { focusOf } from '@/editor/subject-frame'
import type { Clip, Project, TransitionAlign, TransitionKind, TransitionMatch } from '@/editor/types'
import { toGray } from '@/engine/analysis'
import { clipSourceTime } from '@/engine/compositor'
import { beatTiming, blockFlow, chooseTransition, encodeFlow, FLOW_COLS, FLOW_ROWS, flowMagnitude, type CutReading } from '@/engine/cut-match'
import { mediaStills, timelineStills } from '@/engine/stills'
import { frameMotion, type Gray } from '@/engine/tracker'

/** Frames are read this wide: plenty for subjects, motion and flow. */
const WIDTH = 192

const round = (v: number, places = 3) => Math.round(v * 10 ** places) / 10 ** places

interface Shot {
  rgba: Uint8ClampedArray
  gray: Gray
}

function shot(canvas: HTMLCanvasElement): Shot {
  const ctx = canvas.getContext('2d')!
  const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data
  return { rgba, gray: { data: toGray(rgba), width: canvas.width, height: canvas.height } }
}

/** A clip's frames at `locals` (frames into the clip), small. */
async function framesOf(project: Project, clip: Clip, locals: number[]): Promise<Shot[]> {
  const fps = project.settings.fps
  const asset = clip.assetId ? project.assets[clip.assetId] : undefined
  const at = (l: number) => Math.min(Math.max(0, l), Math.max(0, clip.duration - 1))
  if (asset && (asset.kind === 'video' || asset.kind === 'image') && !clip.sequenceId) {
    const stills = await mediaStills(asset, locals.map((l) => clipSourceTime(clip, at(l), fps)), WIDTH)
    return stills.map(shot)
  }
  // Titles, adjustment layers, nested timelines: the timeline as it renders there.
  return (await timelineStills(project, locals.map((l) => clip.start + at(l)), WIDTH)).map(shot)
}

/** The camera's motion between two frames `frames` apart, in frame heights a second (the way the camera goes). */
function cameraMotion(a: Gray, b: Gray, frames: number, fps: number) {
  const m = frameMotion(a, b)
  if (m.used < 5) return null
  const k = fps / Math.max(1, frames) / a.height
  // Content moving left means the camera moving right.
  return { x: -m.dx * k, y: -m.dy * k }
}

/** Reads the cut before `clipId`: everything a smart transition needs, and what chooses one. */
export async function measureCut(clipId: string, project: Project = getProject()): Promise<{ match: TransitionMatch; reading: CutReading }> {
  const b = project.clips[clipId]
  if (!b) throw new Error(`There’s no clip ${clipId}.`)
  const a = adjacentBefore(project, b)
  if (!a) throw new Error(`“${b.name}” doesn’t follow another clip — a transition goes on a cut.`)
  const fps = project.settings.fps
  const step = Math.max(1, Math.round(fps / 10))
  const end = a.duration - 1
  const [[a0, a1], [b0, b1]] = await Promise.all([framesOf(project, a, [end - step, end]), framesOf(project, b, [0, step])])
  const motions = [cameraMotion(a0.gray, a1.gray, step, fps), cameraMotion(b0.gray, b1.gray, step, fps)].filter((m): m is { x: number; y: number } => Boolean(m))
  const motion = motions.length ? { x: motions.reduce((s, m) => s + m.x, 0) / motions.length, y: motions.reduce((s, m) => s + m.y, 0) / motions.length } : { x: 0, y: 0 }
  const { flow, confidence } = blockFlow(a1.gray, b0.gray)
  const from = focusOf(a1.rgba, a1.gray.width, a1.gray.height)
  const to = focusOf(b0.rgba, b0.gray.width, b0.gray.height)
  const pxA = samplePixels(a1.rgba, 2)
  const pxB = samplePixels(b0.rgba, 2)
  const { red, green, blue } = matchCurves(pxB, pxA)
  const match: TransitionMatch = {
    from: { x: round(from.x), y: round(from.y) },
    to: { x: round(to.x), y: round(to.y) },
    motion: { x: round(motion.x), y: round(motion.y) },
    flow: { w: FLOW_COLS, h: FLOW_ROWS, data: encodeFlow(flow) },
    color: { red, green, blue },
  }
  const reading: CutReading = {
    motion,
    flowConfidence: round(confidence),
    flowMagnitude: round(flowMagnitude(flow)),
    colorDistance: colorDistance(pxA, pxB),
    fromConfidence: from.confidence,
    toConfidence: to.confidence,
  }
  return { match, reading }
}

/** The beats of the timeline's music, as frames. */
const beatsOf = (project: Project) => timelineBeats(project).map((b) => b.frame)

export interface SmartTransitionResult {
  clipId: string
  kind: TransitionKind
  reason: string
  /** Frames. */
  duration: number
  align: TransitionAlign
  /** The beat (timeline frame) the shots swap on, when timed to the music. */
  beat?: number
}

/**
 * Puts a smart transition on the cut before `clipId` — `kind`, or the one that
 * suits the cut ('auto') — measured first, and timed to a nearby beat of the
 * music unless a length is given or `onBeat` is false. One undo step.
 */
export async function smartTransition(
  clipId: string,
  kind: TransitionKind | 'auto' = 'auto',
  opts: { duration?: number; align?: TransitionAlign; onBeat?: boolean; source?: ActionSource } = {},
): Promise<SmartTransitionResult> {
  const plan = await planTransition(clipId, kind, opts)
  const res = dispatch('clip.setTransition', { id: clipId, transition: { kind: plan.kind, duration: plan.duration, align: plan.align, match: plan.match } }, { source: opts.source ?? 'user' })
  if (!res.ok) throw new Error(res.error)
  const set = getProject().clips[clipId]?.transitionIn
  return { clipId, kind: plan.kind, reason: plan.reason, duration: set?.duration ?? plan.duration, align: set?.align ?? 'after', ...(plan.beat !== undefined ? { beat: plan.beat } : {}) }
}

async function planTransition(clipId: string, kind: TransitionKind | 'auto', opts: { duration?: number; align?: TransitionAlign; onBeat?: boolean }) {
  const project = getProject()
  const clip = project.clips[clipId]
  if (!clip) throw new Error(`There’s no clip ${clipId}.`)
  const { match, reading } = await measureCut(clipId, project)
  const picked = kind === 'auto' ? chooseTransition(reading) : { kind, reason: 'as asked' }
  const fps = project.settings.fps
  let duration = opts.duration ?? clip.transitionIn?.duration ?? Math.round(fps * 0.7)
  let align: TransitionAlign = opts.align ?? clip.transitionIn?.align ?? 'center'
  let beat: number | undefined
  if (opts.onBeat !== false && opts.duration === undefined && opts.align === undefined) {
    const t = beatTiming(clip.start, beatsOf(project), fps)
    if (t) {
      duration = t.duration
      align = t.align
      beat = t.beat
    }
  }
  return { ...picked, match, duration, align, beat }
}

/** The cuts smart transitions can go on: one picture clip straight after another on a video track. */
export function cutsIn(project: Project, from = 0, to = Infinity): Clip[] {
  const visual = new Set(project.tracks.filter((t) => t.kind === 'video').map((t) => t.id))
  const picture = (c: Clip) => (c.kind === 'video' || c.kind === 'image') && visual.has(c.trackId)
  return Object.values(project.clips)
    .filter((c) => picture(c) && c.start >= from && c.start <= to)
    .filter((c) => {
      const prev = adjacentBefore(project, c)
      return Boolean(prev && picture(prev))
    })
    .sort((a, b) => a.start - b.start)
}

/**
 * Chooses a transition for every cut (on the open timeline, between `from`
 * and `to` frames): each cut is read and gets the smart transition that suits
 * it, timed to the music's beat where there is one. Cuts that already have a
 * transition keep it unless `replace`. One undo step.
 */
export async function autoTransitions(
  opts: { from?: number; to?: number; replace?: boolean; onBeat?: boolean; source?: ActionSource; onProgress?: (done: number, total: number) => void; signal?: AbortSignal } = {},
): Promise<{ placed: SmartTransitionResult[]; skipped: number }> {
  const project = getProject()
  const cuts = cutsIn(project, opts.from, opts.to)
  const todo = cuts.filter((c) => opts.replace || !c.transitionIn)
  const plans: (Awaited<ReturnType<typeof planTransition>> & { clipId: string })[] = []
  let done = 0
  for (const c of todo) {
    if (opts.signal?.aborted) throw new Error('Cancelled')
    try {
      plans.push({ ...(await planTransition(c.id, 'auto', { onBeat: opts.onBeat })), clipId: c.id })
    } catch {
      /* a cut that can't be read keeps what it has */
    }
    opts.onProgress?.(++done, todo.length)
  }
  let error: string | null = null
  useEditor.getState().transaction(plans.length === 1 ? 'Smart transition' : `Smart transitions on ${plans.length} cuts`, opts.source ?? 'user', () => {
    for (const p of plans) {
      const res = dispatch('clip.setTransition', { id: p.clipId, transition: { kind: p.kind, duration: p.duration, align: p.align, match: p.match } })
      if (!res.ok) error ??= res.error
    }
  })
  if (error) throw new Error(error)
  const now = getProject()
  return {
    placed: plans.map((p) => ({
      clipId: p.clipId,
      kind: p.kind,
      reason: p.reason,
      duration: now.clips[p.clipId]?.transitionIn?.duration ?? p.duration,
      align: now.clips[p.clipId]?.transitionIn?.align ?? 'after',
      ...(p.beat !== undefined ? { beat: p.beat } : {}),
    })),
    skipped: cuts.length - plans.length,
  }
}

// ─── Measuring transitions that arrive without a reading ─────────────────

const pending = new Set<string>()
/** Cuts that couldn't be read (offline media…), by clip, kind and place: not tried again until something changes. */
const unreadable = new Set<string>()
let draining = false

const tryKey = (c: Clip) => `${c.id}:${c.transitionIn?.kind}:${c.start}:${c.assetId}`

async function drain() {
  if (draining) return
  draining = true
  try {
    while (pending.size) {
      const id = pending.values().next().value as string
      pending.delete(id)
      const clip = getProject().clips[id]
      const t = clip?.transitionIn
      if (!clip || !t || !isSmartTransition(t.kind) || t.match || unreadable.has(tryKey(clip))) continue
      try {
        const { match } = await measureCut(id)
        const now = getProject().clips[id]?.transitionIn
        // Into the same step as the transition itself: undo removes both.
        if (now && isSmartTransition(now.kind) && !now.match) dispatch('clip.setTransition', { id, transition: { ...now, match } }, { history: false })
      } catch {
        unreadable.add(tryKey(clip))
      }
    }
  } finally {
    draining = false
  }
}

/**
 * Reads the cut of any smart transition that has no reading yet — dropped from
 * the library, pasted, set by an agent with clip_setTransition, or brought back
 * by redo — so it draws with the shots' own subjects, motion and colours.
 */
export function watchSmartTransitions() {
  return useEditor.subscribe((s, prev) => {
    if (s.project.clips === prev.project.clips) return
    for (const c of Object.values(s.project.clips)) if (c.transitionIn && isSmartTransition(c.transitionIn.kind) && !c.transitionIn.match) pending.add(c.id)
    if (pending.size) void drain()
  })
}
