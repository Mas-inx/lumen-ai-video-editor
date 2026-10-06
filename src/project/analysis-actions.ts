/**
 * The footage-reading features, wired to the editor: split or mark a clip at
 * its scene changes, build a multicam clip from recordings synced by sound,
 * stabilize a clip, and track a point so a clip or mask follows it. Shared by
 * menus, the Inspector and the AI tools.
 */
import { toast } from 'sonner'
import { propAt } from '@/editor/keyframes'
import { autoZoom, followOffset, stabilizeAt } from '@/editor/motion'
import { clipEnd } from '@/editor/ops'
import { usePlayback } from '@/editor/playback'
import { dispatch, getProject, useEditor } from '@/editor/store'
import { consumed, localForSource, sourceFrameAt } from '@/editor/timing'
import type { Asset, Clip, Project, TrackPath } from '@/editor/types'
import { AnalysisCancelled } from '@/engine/analysis'
import { detectScenes } from '@/engine/scenes'
import { syncByAudio, type SyncResult } from '@/engine/sync'
import { measureShake, trackBox, type TrackBox, type TrackSample } from '@/engine/tracker'

export { AnalysisCancelled }

/** Runs a long analysis with a progress toast that has a Cancel button. */
export async function withProgress<T>(label: string, run: (onProgress: (p: number) => void, signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const action = { label: 'Cancel', onClick: () => controller.abort() }
  const id = toast.loading(`${label}…`, { action, duration: Infinity })
  let last = 0
  try {
    const out = await run((p) => {
      const now = performance.now()
      if (now - last < 150) return
      last = now
      toast.loading(`${label}… ${Math.round(Math.min(1, p) * 100)}%`, { id, action, duration: Infinity })
    }, controller.signal)
    toast.dismiss(id)
    return out
  } catch (err) {
    toast.dismiss(id)
    throw err
  }
}

function mediaClip(clipId: string): { clip: Clip; asset: Asset } {
  const p = getProject()
  const clip = p.clips[clipId]
  if (!clip) throw new Error(`No clip with id “${clipId}”.`)
  const asset = clip.assetId ? p.assets[clip.assetId] : undefined
  if (!asset || asset.kind !== 'video' || asset.source.type !== 'file') throw new Error(`“${clip.name}” isn’t a video clip — this reads the pictures of a video file.`)
  if (clip.freeze) throw new Error(`“${clip.name}” is a freeze frame — there’s no motion in it.`)
  return { clip, asset }
}

/** Source seconds a clip plays, lowest first. */
function sourceRange(clip: Clip, fps: number): [number, number] {
  const a = sourceFrameAt(clip, 0) / fps
  const b = sourceFrameAt(clip, clip.duration) / fps
  return [Math.min(a, b), Math.max(a, b)]
}

// ─── Scenes ──────────────────────────────────────────────────────────────

export interface SceneResult {
  /** Timeline frames where new shots begin. */
  cuts: number[]
  applied: 'split' | 'markers' | 'none'
  clipIds?: string[]
}

/** Finds the shot changes in a clip; splits it there or adds markers (one undo step). */
export async function scenesInClip(clipId: string, opts: { sensitivity?: number; action?: 'split' | 'markers' | 'none'; source?: 'user' | 'ai' }, onProgress?: (p: number) => void, signal?: AbortSignal): Promise<SceneResult> {
  const { clip, asset } = mediaClip(clipId)
  const fps = getProject().settings.fps
  const [a, b] = sourceRange(clip, fps)
  const report = await detectScenes(asset, a, b, { sensitivity: opts.sensitivity }, onProgress, signal)
  const now = getProject().clips[clipId]
  if (!now) throw new Error('The clip was removed while it was being analysed.')
  const cuts = [
    ...new Set(
      report.cuts
        .map((t) => localForSource(now, t * fps))
        .filter((l): l is number => l !== null)
        .map((l) => now.start + Math.round(l))
        .filter((f) => f > now.start && f < clipEnd(now)),
    ),
  ].sort((x, y) => x - y)
  const action = opts.action ?? 'split'
  if (!cuts.length || action === 'none') return { cuts, applied: 'none' }
  const source = opts.source ?? 'user'
  const ids = [clipId]
  useEditor.getState().transaction(action === 'split' ? `Split at ${cuts.length} scene cut${cuts.length === 1 ? '' : 's'}` : 'Mark scene cuts', source, () => {
    let target = clipId
    cuts.forEach((frame, i) => {
      if (action === 'markers') {
        dispatch('marker.add', { frame, label: `Scene ${i + 2}`, color: 'sky' }, { source })
        return
      }
      const res = dispatch('clip.split', { frame, ids: [target] }, { source })
      const right = res.ok ? (res.result as string[])[0] : undefined
      if (right) {
        ids.push(right)
        target = right
      }
    })
  })
  return { cuts, applied: action, ...(action === 'split' ? { clipIds: ids } : {}) }
}

// ─── Multicam ────────────────────────────────────────────────────────────

/** Syncs recordings by their sound and makes a multicam clip of them. */
export async function multicamFromAssets(assetIds: string[], opts: { name?: string; audio?: number; place?: boolean; start?: number; source?: 'user' | 'ai' } = {}, onProgress?: (p: number) => void) {
  const p = getProject()
  const assets = assetIds.map((id) => {
    const a = p.assets[id]
    if (!a) throw new Error(`No media with id “${id}”.`)
    if (a.kind !== 'video') throw new Error(`“${a.name}” isn’t video — every angle needs pictures.`)
    return a
  })
  // The recording with sound that runs longest is the reference.
  const order = [...assets].sort((x, y) => Number(y.hasAudio !== false) - Number(x.hasAudio !== false) || (y.duration ?? 0) - (x.duration ?? 0))
  const synced = await syncByAudio(order, (done, total) => onProgress?.(done / total))
  const byId = new Map(order.map((a, i) => [a.id, synced[i]]))
  const angles = assets.map((a) => ({ assetId: a.id, offset: byId.get(a.id)!.offset }))
  const res = dispatch(
    'multicam.create',
    { name: opts.name, angles, audio: Math.min(assets.length - 1, opts.audio ?? assets.indexOf(order[0])), place: opts.place ?? true, start: opts.start ?? usePlayback.getState().frame },
    { source: opts.source ?? 'user' },
  )
  if (!res.ok) throw new Error(res.error)
  const out = res.result as { sequenceId: string; clipId: string | null }
  return { ...out, sync: assets.map((a) => ({ assetId: a.id, name: a.name, ...(byId.get(a.id) as SyncResult) })) }
}

// ─── Stabilization ───────────────────────────────────────────────────────

/** Measures a clip's camera shake and smooths it away (one undo step). `smooth` in seconds. */
export async function stabilizeClip(clipId: string, opts: { smooth?: number; rotation?: boolean; source?: 'user' | 'ai' } = {}, onProgress?: (p: number) => void, signal?: AbortSignal) {
  const { clip, asset } = mediaClip(clipId)
  const fps = getProject().settings.fps
  const [a, b] = sourceRange(clip, fps)
  // A second either side so the smoothing has context at the clip's edges.
  const from = Math.max(0, a - 1)
  const to = Math.min(asset.duration ?? b + 1, b + 1)
  const shake = await measureShake(asset, from, to, onProgress, signal)
  const smooth = opts.smooth ?? 1
  const rotation = opts.rotation ?? true
  const aspect = (asset.width ?? 16) / (asset.height ?? 9)
  const zoom = autoZoom({ path: shake.path, rate: shake.rate, smooth, rotation }, aspect)
  const res = dispatch('clip.update', { ids: [clipId], patch: { stabilize: { ...shake, smooth, zoom, rotation } } }, { source: opts.source ?? 'user', label: 'Stabilize' })
  if (!res.ok) throw new Error(res.error)
  return { zoom, frames: shake.path.length / 3 }
}

// ─── Tracking ────────────────────────────────────────────────────────────

const rot = (x: number, y: number, deg: number): [number, number] => {
  const r = (deg * Math.PI) / 180
  const c = Math.cos(r)
  const s = Math.sin(r)
  return [x * c - y * s, x * s + y * c]
}

/** Where a clip's layer sits at a clip frame: position (from the frame centre, followed motion included), scale, rotation. */
function placement(clip: Clip, local: number) {
  const [fx, fy] = clip.follow ? followOffset(clip.follow, local) : [0, 0]
  return { x: propAt(clip, 'x', local) + fx, y: propAt(clip, 'y', local) + fy, scale: propAt(clip, 'scale', local) || 1e-6, rotation: propAt(clip, 'rotation', local) }
}

/** The picture's box inside the frame (project pixels, from the centre). */
function containSize(project: Project, asset: Asset) {
  const { width: PW, height: PH } = project.settings
  const iw = asset.width ?? PW
  const ih = asset.height ?? PH
  const r = Math.min(PW / iw, PH / ih)
  return { w: iw * r, h: ih * r }
}

/** A point of a clip's footage (fractions of the picture) → the frame (project pixels from the centre). */
export function mediaToProject(project: Project, clip: Clip, asset: Asset, local: number, u: number, v: number): [number, number] {
  const { w, h } = containSize(project, asset)
  let mx = (u - 0.5) * w
  let my = (v - 0.5) * h
  if (clip.stabilize) {
    const c = stabilizeAt(clip.stabilize, sourceFrameAt(clip, local) / project.settings.fps)
    ;[mx, my] = rot(mx + c.dx * w, my + c.dy * h, (c.angle * 180) / Math.PI)
    mx *= c.zoom
    my *= c.zoom
  }
  const t = placement(clip, local)
  const [rx, ry] = rot(mx * t.scale, my * t.scale, t.rotation)
  return [t.x + rx, t.y + ry]
}

/** The frame (project pixels from the centre) → a point of a clip's footage (fractions of the picture). */
export function projectToMedia(project: Project, clip: Clip, asset: Asset, local: number, px: number, py: number): [number, number] {
  const { w, h } = containSize(project, asset)
  const t = placement(clip, local)
  let [mx, my] = rot((px - t.x) / t.scale, (py - t.y) / t.scale, -t.rotation)
  if (clip.stabilize) {
    const c = stabilizeAt(clip.stabilize, sourceFrameAt(clip, local) / project.settings.fps)
    ;[mx, my] = rot(mx / c.zoom, my / c.zoom, (-c.angle * 180) / Math.PI)
    mx -= c.dx * w
    my -= c.dy * h
  }
  return [mx / w + 0.5, my / h + 0.5]
}

/** The frame (project pixels from the centre) → a clip's mask space (fractions of its full-frame layer). */
export function projectToLayer(project: Project, clip: Clip, local: number, px: number, py: number): [number, number] {
  const { width: PW, height: PH } = project.settings
  if (clip.kind === 'adjustment') return [px / PW + 0.5, py / PH + 0.5]
  const t = placement(clip, local)
  const [lx, ly] = rot((px - t.x) / t.scale, (py - t.y) / t.scale, -t.rotation)
  return [lx / PW + 0.5, ly / PH + 0.5]
}

/**
 * The video whose footage is followed: for a mask, its own clip when that's
 * video; otherwise the topmost video clip under the target at `frame`.
 */
export function trackingSource(project: Project, target: Clip, frame: number, forMask: boolean): Clip | null {
  const isVideo = (c: Clip) => c.kind === 'video' && !c.sequenceId && Boolean(c.assetId && project.assets[c.assetId]?.kind === 'video')
  if (forMask && isVideo(target)) return target
  const order = new Map(project.tracks.map((t, i) => [t.id, i]))
  const level = order.get(target.trackId) ?? -1
  return (
    Object.values(project.clips)
      .filter((c) => c.id !== target.id && isVideo(c) && (order.get(c.trackId) ?? 0) > level && frame >= c.start && frame < clipEnd(c))
      .sort((a, b) => (order.get(a.trackId) ?? 0) - (order.get(b.trackId) ?? 0))[0] ?? null
  )
}

export interface TrackRequest {
  /** The clip that follows (or holds the mask that does). */
  targetId: string
  maskId?: string
  /** What to follow at the playhead, in project pixels from the frame centre (x, y = the box centre). */
  box: { x: number; y: number; width: number; height: number }
  direction: 'forward' | 'backward' | 'both'
  /** Frame the box is placed on (default: the playhead). */
  frame?: number
  /** Footage to read (default: the target if it's video, else the video under it). */
  sourceId?: string
  /** The target is the footage itself: nothing follows yet, so a new title is added and pinned to the point. */
  newTitle?: boolean
  source?: 'user' | 'ai'
}

/** Sample on a path at a source time (interpolated), or null outside it. */
function sampleAt(samples: TrackSample[], t: number): [number, number] | null {
  if (!samples.length) return null
  const first = samples[0].t
  const last = samples[samples.length - 1].t
  if (t < first - 1e-6 || t > last + 1e-6) return null
  let lo = 0
  let hi = samples.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (samples[mid].t <= t) lo = mid
    else hi = mid
  }
  const a = samples[lo]
  const b = samples[hi]
  const k = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0
  return [a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k]
}

/**
 * Tracks what's in `box` through the footage under a clip and makes the clip
 * (or one of its masks) follow it. Returns how many frames were tracked.
 */
export async function trackMotion(req: TrackRequest, onProgress?: (p: number) => void, signal?: AbortSignal) {
  const p = getProject()
  const target = p.clips[req.targetId]
  if (!target) throw new Error(`No clip with id “${req.targetId}”.`)
  if (req.maskId && !target.masks?.some((m) => m.id === req.maskId)) throw new Error(`“${target.name}” has no mask ${req.maskId}.`)
  if (!req.maskId && target.kind === 'adjustment') throw new Error('An adjustment layer doesn’t move — track one of its masks instead.')
  const frame = Math.round(req.frame ?? usePlayback.getState().frame)
  if (frame < target.start || frame >= clipEnd(target)) throw new Error(`Put the playhead over “${target.name}” — on a frame where what it should follow is visible.`)
  const src = req.newTitle ? target : req.sourceId ? p.clips[req.sourceId] : trackingSource(p, target, frame, Boolean(req.maskId))
  if (!src) throw new Error(NOTHING_TO_FOLLOW)
  const { asset } = mediaClip(src.id)
  if (frame < src.start || frame >= clipEnd(src)) throw new Error('Put the playhead over the footage to follow.')
  const fps = p.settings.fps
  // The box in the footage's own coordinates.
  const local = frame - src.start
  const corners = [
    [req.box.x - req.box.width / 2, req.box.y - req.box.height / 2],
    [req.box.x + req.box.width / 2, req.box.y + req.box.height / 2],
  ].map(([x, y]) => projectToMedia(p, src, asset, local, x, y))
  const [cu, cv] = projectToMedia(p, src, asset, local, req.box.x, req.box.y)
  const box: TrackBox = { x: cu, y: cv, w: Math.abs(corners[1][0] - corners[0][0]), h: Math.abs(corners[1][1] - corners[0][1]) }
  if (cu < 0 || cu > 1 || cv < 0 || cv > 1) throw new Error('The box has to sit on the footage.')
  // Tracking runs over the frames the target and the footage share — forwards
  // on the timeline may be backwards in the file (a reversed clip).
  const start = Math.max(src.start, target.start)
  const end = Math.min(clipEnd(src), clipEnd(target))
  const tAt = (f: number) => sourceFrameAt(src, f - src.start) / fps
  const t0 = tAt(frame)
  const fwd = req.direction !== 'backward'
  const back = req.direction !== 'forward'
  const both = fwd && back
  const past = (t: number) => t + (t >= t0 ? 1 : -1) / fps
  let samples: TrackSample[] = []
  if (fwd) samples = await trackBox(asset, box, t0, past(tAt(end - 1)), (x) => onProgress?.(both ? x / 2 : x), signal)
  if (back) samples = samples.concat(await trackBox(asset, box, t0, past(tAt(start)), (x) => onProgress?.(both ? 0.5 + x / 2 : x), signal))
  samples.sort((x, y) => x.t - y.t)
  samples = samples.filter((x, i) => i === 0 || x.t - samples[i - 1].t > 1e-6)
  if (samples.length < 2) throw new Error('Couldn’t follow that — try a box over something with more detail.')

  // Positions on the target's frames, in the space that follows.
  const now = getProject()
  const tgt = now.clips[req.targetId]
  const s = now.clips[src.id]
  if (!tgt || !s) throw new Error('The clip was removed while tracking.')
  const points: number[] = []
  let first = -1
  let ref = 0
  for (let f = start; f < end; f++) {
    const at = sampleAt(samples, tAt(f))
    if (!at) {
      if (first >= 0) break
      continue
    }
    if (first < 0) first = f
    if (f === frame) ref = (f - first) | 0
    const [px, py] = mediaToProject(now, s, asset, f - s.start, at[0], at[1])
    if (req.maskId) {
      const [mx, my] = projectToLayer(now, tgt, f - tgt.start, px, py)
      points.push(Math.round(mx * 1e5) / 1e5, Math.round(my * 1e5) / 1e5)
    } else points.push(Math.round(px * 100) / 100, Math.round(py * 100) / 100)
  }
  if (first < 0 || points.length < 4) throw new Error('Couldn’t follow that — try a box over something with more detail.')
  if (frame < first) ref = 0
  const path: TrackPath = { start: first - tgt.start, ref: Math.min(ref, points.length / 2 - 1), points }
  const how = { source: req.source ?? ('user' as const), label: 'Track motion' }
  const tracked = { frames: points.length / 2, from: first, to: first + points.length / 2, lost: samples.length > 1 && samples[samples.length - 1].score < 0.6 }
  if (req.newTitle) return { ...tracked, clipId: pinnedTitle(now, first, path, req.box.height, how.source) }
  const res = req.maskId ? dispatch('mask.update', { clipId: tgt.id, maskId: req.maskId, patch: { follow: path } }, how) : dispatch('clip.update', { ids: [tgt.id], patch: { follow: path } }, how)
  if (!res.ok) throw new Error(res.error)
  return tracked
}

export const NOTHING_TO_FOLLOW = 'There’s no video under this clip at the playhead. Put the clip on a track above the video it should follow, with the playhead over both.'

/** A new title sitting just above a tracked point and moving with it (one undo step). Returns its id. */
function pinnedTitle(project: Project, start: number, path: TrackPath, boxHeight: number, source: 'user' | 'ai'): string {
  const { height: PH } = project.settings
  const frames = path.points.length / 2
  const size = Math.round(PH * 0.06)
  let id = ''
  let failed = ''
  useEditor.getState().transaction('Track motion', source, () => {
    const p = getProject()
    const how = { source }
    let trackId = (p.tracks.find((t) => t.role === 'titles' && !t.locked) ?? p.tracks.find((t) => t.kind === 'video' && t.role !== 'main' && t.role !== 'captions' && !t.locked))?.id
    if (!trackId) {
      const made = dispatch('track.add', { kind: 'video', name: 'Titles', index: 0, role: 'titles' }, how)
      if (!made.ok) return void (failed = made.error)
      trackId = made.result as string
    }
    const x = path.points[path.ref * 2]
    const y = path.points[path.ref * 2 + 1] - boxHeight / 2 - size
    const added = dispatch('clip.add', { trackId, kind: 'text', start, duration: frames, name: 'Tracked title', patch: { text: { content: 'Title', size }, transform: { x: Math.round(x), y: Math.round(y) } } }, how)
    if (!added.ok) return void (failed = added.error)
    id = added.result as string
    // Where it landed (a busy track moves it to the nearest free spot) decides where its path starts.
    const clip = getProject().clips[id]
    const pinned = dispatch('clip.update', { ids: [id], patch: { follow: { ...path, start: start - clip.start } } }, how)
    if (!pinned.ok) failed = pinned.error
  })
  if (failed || !id) throw new Error(failed || 'Couldn’t add the title.')
  return id
}

/**
 * Where the tracking box starts (project pixels, top-left based) for a clip or
 * one of its masks at a frame: over the mask, or a square around the clip's position.
 */
export function initialTrackBox(project: Project, clip: Clip, maskId: string | undefined, frame: number) {
  const { width: PW, height: PH } = project.settings
  const local = Math.max(0, Math.min(clip.duration - 1, frame - clip.start))
  const mask = maskId ? clip.masks?.find((m) => m.id === maskId) : undefined
  if (mask) {
    const [ox, oy] = mask.follow ? followOffset(mask.follow, local) : [0, 0]
    const mx = (mask.x + ox - 0.5) * PW
    const my = (mask.y + oy - 0.5) * PH
    const t = clip.kind === 'adjustment' ? { x: 0, y: 0, scale: 1, rotation: 0 } : placement(clip, local)
    const [rx, ry] = rot(mx * t.scale, my * t.scale, t.rotation)
    const w = Math.max(16, mask.width * PW * t.scale)
    const h = Math.max(16, mask.height * PH * t.scale)
    return { x: PW / 2 + t.x + rx - w / 2, y: PH / 2 + t.y + ry - h / 2, w, h }
  }
  const t = placement(clip, local)
  const size = Math.round(Math.min(PW, PH) * 0.16)
  return { x: PW / 2 + t.x - size / 2, y: PH / 2 + t.y - size / 2, w: size, h: size }
}

/** Frames of footage a clip plays (for progress estimates). */
export const clipFrames = (clip: Clip) => Math.round(consumed(clip))
