/**
 * The storyboard: a plan for the video made before producing it — ordered
 * scenes, each with its script, how it's made (its treatment), a target
 * length, the transition into it, what it needs and the media it uses — and,
 * once made, the stretch of a timeline it was produced into. Changes go
 * through the storyboard commands; this module holds the rules they share
 * with the panel and the AI tools.
 */
import { clipEnd } from './ops'
import { getSequence, openSequenceId } from './sequences'
import type { Clip, Project, SceneStatus, SceneTreatment, Storyboard, StoryboardScene } from './types'

export const SCENE_TREATMENTS: { id: SceneTreatment; name: string; description: string }[] = [
  { id: 'footage', name: 'Footage', description: 'Shot material: the interview, the talk, the action' },
  { id: 'broll', name: 'B-roll', description: 'Cutaways that show what is being said' },
  { id: 'kinetic-type', name: 'Kinetic type', description: 'The words themselves, animated' },
  { id: 'infographic', name: 'Infographic', description: 'Numbers, charts, labels and steps' },
  { id: 'generated-image', name: 'Generated image', description: 'A still made with an image model' },
  { id: 'generated-video', name: 'Generated video', description: 'A shot made with a video model' },
  { id: '3d', name: '3D', description: 'A Blender title or scene' },
  { id: 'motion-graphic', name: 'Motion graphic', description: 'A HyperFrames composition: title card, lower third, counter…' },
  { id: 'other', name: 'Other', description: 'Anything else' },
]

export const SCENE_TREATMENT_IDS = SCENE_TREATMENTS.map((t) => t.id) as [SceneTreatment, ...SceneTreatment[]]

export const SCENE_STATUSES: { id: SceneStatus; name: string }[] = [
  { id: 'planned', name: 'Planned' },
  { id: 'in-progress', name: 'In progress' },
  { id: 'done', name: 'Done' },
]

export const SCENE_STATUS_IDS = SCENE_STATUSES.map((s) => s.id) as [SceneStatus, ...SceneStatus[]]

/** Seconds a scene is planned at when nothing says otherwise. */
export const DEFAULT_SCENE_SECONDS = 5

/** The fields of a change that say something (undefined ones would clobber what's there). */
export function definedFields<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<T>
}

export function createScene(id: string, init: Partial<Omit<StoryboardScene, 'id'>> = {}): StoryboardScene {
  return {
    id,
    title: '',
    script: '',
    treatment: 'footage',
    seconds: DEFAULT_SCENE_SECONDS,
    transition: null,
    needs: [],
    assetIds: [],
    status: 'planned',
    notes: '',
    ...definedFields(init),
  }
}

export const emptyStoryboard = (): Storyboard => ({ scenes: [] })

/** Where each scene starts in the plan, in seconds (the running total before it). */
export function sceneStarts(storyboard: Pick<Storyboard, 'scenes'> | undefined): number[] {
  let t = 0
  return (storyboard?.scenes ?? []).map((s) => {
    const at = t
    t += s.seconds
    return at
  })
}

export const plannedSeconds = (storyboard: Pick<Storyboard, 'scenes'> | undefined) => (storyboard?.scenes ?? []).reduce((t, s) => t + s.seconds, 0)

/** The clips of a timeline (the open one, or a stored one) by id. */
function timelineClips(project: Project, timelineId: string): Record<string, Clip> | null {
  return getSequence(project, timelineId)?.clips ?? null
}

/** The stretch some clips cover on a timeline: [first start, last end), or null when none of them is there. */
export function rangeOfClips(project: Project, clipIds: readonly string[], timelineId = openSequenceId(project)): [number, number] | null {
  const clips = timelineClips(project, timelineId)
  if (!clips) return null
  const found = clipIds.map((id) => clips[id]).filter((c): c is Clip => Boolean(c))
  if (!found.length) return null
  return [Math.min(...found.map((c) => c.start)), Math.max(...found.map(clipEnd))]
}

export interface SceneRange {
  timelineId: string
  /** Frames on that timeline, at its own frame rate. */
  from: number
  to: number
  fps: number
  /** The timeline is the one that's open. */
  open: boolean
  /** The clips of the scene that are still there. */
  clipIds: string[]
}

/**
 * Where a produced scene is now. A scene that knows its clips follows them —
 * trims, ripples and removed pauses move them — else it keeps the stretch it
 * was given. Null when it isn't produced, or its timeline is gone.
 */
export function sceneRange(project: Project, scene: Pick<StoryboardScene, 'produced'>): SceneRange | null {
  const p = scene.produced
  if (!p) return null
  const seq = getSequence(project, p.timelineId)
  if (!seq) return null
  const live = p.clipIds?.filter((id) => seq.clips[id]) ?? []
  const span = live.length ? rangeOfClips(project, live, p.timelineId) : null
  const [from, to] = span ?? [p.from, p.to]
  return { timelineId: p.timelineId, from, to, fps: seq.settings.fps, open: p.timelineId === openSequenceId(project), clipIds: live }
}

/** Where a scene is in the storyboard's order (-1 when it isn't in it). */
export function sceneIndex(storyboard: Storyboard | undefined, sceneId: string) {
  return storyboard?.scenes.findIndex((s) => s.id === sceneId) ?? -1
}

/** Clips on the open timeline a scene's stretch covers (its own clips, else everything inside the stretch). */
export function sceneClips(project: Project, scene: Pick<StoryboardScene, 'produced'>): Clip[] {
  const range = sceneRange(project, scene)
  if (!range?.open) return []
  if (range.clipIds.length) return range.clipIds.map((id) => project.clips[id]).filter((c): c is Clip => Boolean(c))
  return Object.values(project.clips).filter((c) => c.start < range.to && clipEnd(c) > range.from)
}
