/**
 * Render previews: stretches of the timeline rendered ahead of time, so heavy
 * edits (stacked layers, grades, effects, 3D, nested timelines) play back
 * smoothly on any computer — like the render files of Premiere or Final Cut.
 *
 * - The timeline is cut into chunks of two seconds. A chunk's key is a hash of
 *   everything that shows in it (its clips, their media and grades, fonts,
 *   LUTs, nested timelines, the project's size, the render resolution and the
 *   app version). Editing makes only the chunks it touches stale, and undo
 *   brings their renders right back.
 * - A rendered chunk is a short H.264 file in Lumen's media folder, rendered
 *   frame-exactly through the same compositor as an export. Playback decodes
 *   it ahead of the playhead instead of compositing every layer live.
 * - The render bar over the timeline shows each chunk: green when rendered,
 *   red when it needs rendering to play smoothly, yellow when it probably
 *   plays, and nothing for simple cuts.
 */
import { BufferTarget, CanvasSource, canEncodeVideo, Mp4OutputFormat, Output } from 'mediabunny'
import { toast } from 'sonner'
import { create } from 'zustand'
import { clipEnd, projectDuration } from '@/editor/ops'
import { usePlayback } from '@/editor/playback'
import { is3dEffect, is3dTransition } from '@/editor/presets'
import { getProject, useEditor } from '@/editor/store'
import type { Asset, Clip, Project, Sequence } from '@/editor/types'
import { useUI, type RenderRes } from '@/editor/ui-store'
import { APP_VERSION, desktop } from '@/lib/platform'
import { clipsDrawnAt, renderFrame } from './compositor'
import { needsGpuGrade } from './gl-grade'
import { withVideoFrames } from './media'
import { useAutoRes } from './preview-res'
import { FrameFeeder } from './stills'

/** Bump when rendered files from older versions must not be reused. */
const FORMAT = 1

/** Frames in a chunk: two seconds. */
export const chunkFrames = (fps: number) => Math.max(1, Math.round(fps * 2))

// ─── Keys ────────────────────────────────────────────────────────────────

/** cyrb53: a fast 53-bit string hash. Two seeds make collisions out of reach. */
function cyrb53(str: string, seed: number) {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

export const hashText = (s: string) => cyrb53(s, 7).toString(36) + cyrb53(s, 1337).toString(36)

// Project objects are immutable (edits make new ones), so hashes are kept per object.
const hashes = new WeakMap<object, string>()
function hashOnce<T extends object>(obj: T, pick: (o: T) => unknown = (o) => o) {
  let h = hashes.get(obj)
  if (h === undefined) {
    h = hashText(JSON.stringify(pick(obj)))
    hashes.set(obj, h)
  }
  return h
}

/** What of a clip shows in the picture (its sound, name and grouping don't). */
const clipPicture = (c: Clip) => {
  const { audio: _audio, name: _name, groupId: _group, look: _look, ...picture } = c
  return picture
}

/** What of a media file shows in the picture (not its name, tags, peaks, transcript or proxy — renders read the original). */
const assetPicture = (a: Asset) => ({ kind: a.kind, source: a.source, width: a.width, height: a.height, fps: a.fps, duration: a.duration, alpha: a.alpha })

/** Video clips by track, sorted by start (per clips object). */
const sortedByTrack = new WeakMap<Record<string, Clip>, Map<string, Clip[]>>()
function clipsByTrack(clips: Record<string, Clip>) {
  let map = sortedByTrack.get(clips)
  if (!map) {
    map = new Map()
    for (const c of Object.values(clips)) {
      const list = map.get(c.trackId)
      if (list) list.push(c)
      else map.set(c.trackId, [c])
    }
    for (const list of map.values()) list.sort((a, b) => a.start - b.start)
    sortedByTrack.set(clips, map)
  }
  return map
}

/** The clips drawn anywhere in [f0, f1): on visible video tracks, plus the outgoing clips of transitions. */
function clipsIn(project: Project, f0: number, f1: number) {
  const byTrack = clipsByTrack(project.clips)
  const layers: Clip[][] = []
  for (const t of project.tracks) {
    if (t.kind !== 'video' || t.hidden) continue
    const list = byTrack.get(t.id) ?? []
    const out: Clip[] = []
    // Clips on a track don't overlap, so their ends are sorted too: start at the first ending after f0.
    let lo = 0
    let hi = list.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (clipEnd(list[mid]) > f0) hi = mid
      else lo = mid + 1
    }
    for (let i = lo; i < list.length; i++) {
      const c = list[i]
      if (c.start >= f1) break
      const tr = c.transitionIn
      // The clip before a transition is drawn past its end, into the transition.
      if (tr && c.start < f1 && c.start + tr.duration > f0) {
        const prev = list[i - 1]
        if (prev && clipEnd(prev) === c.start && clipEnd(prev) <= f0) out.push(prev)
      }
      if (clipEnd(c) > f0) out.push(c)
    }
    layers.push(out)
  }
  return layers
}

/** Everything a set of clips draws from: media, fonts, LUTs and nested timelines (and theirs). */
function dependencies(project: Project, clips: Iterable<Clip>) {
  const assets = new Map<string, string>()
  const fonts = new Map<string, string>()
  const luts = new Map<string, string>()
  const sequences = new Map<string, string>()
  const visit = (c: Clip) => {
    for (const id of [c.assetId, c.matte?.assetId]) {
      if (!id || assets.has(id)) continue
      const a = project.assets[id]
      assets.set(id, a ? hashOnce(a, assetPicture) : 'missing')
    }
    const font = c.text?.font
    if (font && project.fonts?.[font] && !fonts.has(font)) fonts.set(font, hashOnce(project.fonts[font]))
    const lut = c.color.lut?.id
    if (lut && project.luts?.[lut] && !luts.has(lut)) luts.set(lut, hashOnce(project.luts[lut]))
    if (c.sequenceId && !sequences.has(c.sequenceId)) {
      const seq: Sequence | undefined = project.sequences?.[c.sequenceId]
      sequences.set(c.sequenceId, seq ? hashOnce(seq) : 'missing')
      if (seq) for (const inner of Object.values(seq.clips)) visit(inner)
    }
  }
  for (const c of clips) visit(c)
  const sorted = (m: Map<string, string>) => [...m].sort((a, b) => (a[0] < b[0] ? -1 : 1))
  return [sorted(assets), sorted(fonts), sorted(luts), sorted(sequences)]
}

/** A chunk's frames: [from, to), clipped to the end of the timeline. */
export function chunkSpan(project: Project, index: number): [number, number] {
  const len = chunkFrames(project.settings.fps)
  const f0 = index * len
  return [f0, Math.min(f0 + len, Math.max(f0, projectDuration(project)))]
}

/** The size a chunk renders at. */
export function renderSize(project: Project, res: RenderRes) {
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)
  return { width: even(project.settings.width * res), height: even(project.settings.height * res) }
}

function computeKey(project: Project, index: number, res: RenderRes): string | null {
  const [f0, f1] = chunkSpan(project, index)
  if (f1 <= f0) return null
  const layers = clipsIn(project, f0, f1)
  if (!layers.some((l) => l.length)) return null
  const size = renderSize(project, res)
  const desc = [
    FORMAT,
    APP_VERSION,
    size.width,
    size.height,
    project.settings,
    f0,
    f1,
    // Empty tracks draw nothing: adding or hiding one changes no picture.
    layers.filter((l) => l.length).map((l) => l.map((c) => hashOnce(c, clipPicture))),
    dependencies(project, layers.flat()),
  ]
  return `${hashText(JSON.stringify(desc))}-${Math.round(res * 1000)}`
}

// Keys and estimates for the current state, recomputed only when the project changes.
let memoDeps: unknown[] = []
const keyMemo = new Map<number, string | null>()
const costMemo = new Map<number, number>()
function fresh(project: Project, res: RenderRes) {
  const deps = [project.clips, project.tracks, project.assets, project.sequences, project.settings, project.fonts, project.luts, res]
  if (deps.length === memoDeps.length && deps.every((d, i) => d === memoDeps[i])) return
  memoDeps = deps
  keyMemo.clear()
  costMemo.clear()
}

/** The key of a chunk as the timeline is now, or null when nothing is drawn in it. */
export function chunkKey(project: Project, index: number, res: RenderRes = useUI.getState().renderRes): string | null {
  fresh(project, res)
  let key = keyMemo.get(index)
  if (key === undefined) {
    key = computeKey(project, index, res)
    keyMemo.set(index, key)
  }
  return key
}

// ─── How heavy a stretch is ──────────────────────────────────────────────

const EFFECT_COST: Partial<Record<string, number>> = { blur: 1, glow: 1.2, rgb: 1, grain: 0.3, leak: 0.3, vignette: 0.2 }

/** Roughly how much work drawing one frame is, in "plain video layers". */
function frameCost(project: Project, frame: number) {
  let cost = 0
  for (const { clip, local } of clipsDrawnAt(project, frame)) {
    cost += clip.kind === 'text' ? 0.4 : clip.kind === 'adjustment' ? 1.5 : 1
    if (clip.sequenceId) cost += 2.5
    if (needsGpuGrade(clip)) cost += 1
    if (clip.reverse) cost += 2
    for (const e of clip.effects) if (e.enabled) cost += is3dEffect(e.kind) ? 2.5 : (EFFECT_COST[e.kind] ?? 0.1)
    for (const m of clip.masks ?? []) cost += m.feather > 0 ? 1 : 0.5
    if (clip.crop) cost += 0.2
    if (clip.text && clip.text.extrude > 0) cost += 2.5
    const tr = clip.transitionIn
    if (tr && local < tr.duration) cost += is3dTransition(tr.kind) ? 2.5 : 1
    const kf = clip.keyframes
    if (kf.rotateX?.length || kf.rotateY?.length || kf.z?.length || clip.transform.rotateX || clip.transform.rotateY || clip.transform.z) cost += 2.5
  }
  return cost
}

function chunkCost(project: Project, index: number) {
  fresh(project, useUI.getState().renderRes)
  let cost = costMemo.get(index)
  if (cost === undefined) {
    const [f0, f1] = chunkSpan(project, index)
    cost = 0
    for (const f of [f0, Math.floor((f0 + f1) / 2), f1 - 1]) if (f >= f0 && f < f1) cost = Math.max(cost, frameCost(project, f))
    costMemo.set(index, cost)
  }
  return cost
}

/** empty: nothing drawn · fine: plays in real time · light: probably plays · heavy: needs rendering · rendered: has a render. */
export type ChunkState = 'empty' | 'fine' | 'light' | 'heavy' | 'rendered'

export function chunkState(project: Project, index: number): ChunkState {
  const key = chunkKey(project, index)
  if (!key) return 'empty'
  if (useRenders.getState().files[key]) return 'rendered'
  const cost = chunkCost(project, index)
  // A computer that already had to lower the preview resolution gets less benefit of the doubt.
  const slow = useAutoRes.getState().level < 1
  if (cost <= 1.3) return 'fine'
  return cost <= (slow ? 2.2 : 3.2) ? 'light' : 'heavy'
}

// ─── Store ───────────────────────────────────────────────────────────────

export interface RenderJob {
  label: string
  background: boolean
  /** Chunks finished and to do. */
  done: number
  total: number
  /** The chunk rendering now. */
  current: number | null
}

interface RenderState {
  projectId: string | null
  /** This project's rendered chunks: key → URL. */
  files: Record<string, string>
  job: RenderJob | null
  /** Bumps whenever the render bar should redraw. */
  version: number
}

export const useRenders = create<RenderState>(() => ({ projectId: null, files: {}, job: null, version: 0 }))

const bump = (patch: Partial<RenderState> = {}) => useRenders.setState((s) => ({ ...patch, version: s.version + 1 }))

/** Loads the renders kept for the open project. */
async function loadFiles(projectId: string) {
  if (!desktop) return
  useRenders.setState({ projectId, files: {} })
  try {
    const list = await desktop.renders.list(projectId)
    if (useRenders.getState().projectId !== projectId) return
    bump({ files: Object.fromEntries(list.map((f) => [f.key, f.url])) })
  } catch {
    // No renders yet.
  }
}

// ─── Rendering ───────────────────────────────────────────────────────────

let controller: AbortController | null = null
let canvas: HTMLCanvasElement | null = null
let encoderChecked: Promise<boolean> | null = null

/** Gives the editor its turn: rendering runs between frames at background priority. */
function yieldToEditor() {
  const s = (globalThis as { scheduler?: { postTask?: (cb: () => void, opts: { priority: string }) => Promise<void> } }).scheduler
  if (s?.postTask) return s.postTask(() => {}, { priority: 'background' })
  return new Promise<void>((r) => setTimeout(r, 0))
}

/** Waits while the timeline plays: playback gets the whole computer. */
async function whilePlaying(signal: AbortSignal) {
  while (usePlayback.getState().playing && !signal.aborted) await new Promise((r) => setTimeout(r, 250))
}

async function renderChunk(project: Project, index: number, key: string, res: RenderRes, feeder: FrameFeeder, signal: AbortSignal) {
  const { width, height } = renderSize(project, res)
  const fps = project.settings.fps
  const [f0, f1] = chunkSpan(project, index)
  canvas ??= document.createElement('canvas')
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }
  const ctx = canvas.getContext('2d', { alpha: false })!
  const target = new BufferTarget()
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target })
  const pixels = width * height
  const source = new CanvasSource(canvas, {
    codec: 'avc',
    bitrate: Math.round(20_000_000 * (pixels / 2_073_600) * Math.pow(fps / 30, 0.75)),
    keyFrameInterval: 1,
    latencyMode: 'quality',
    hardwareAcceleration: 'prefer-hardware',
  })
  output.addVideoTrack(source, { frameRate: fps })
  await output.start()
  try {
    feeder.project = project
    for (let f = f0; f < f1; f++) {
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError')
      await feeder.prepare(f)
      withVideoFrames(feeder.frame, () => renderFrame(ctx, project, f))
      await source.add((f - f0) / fps, 1 / fps)
      await yieldToEditor()
    }
    source.close()
    await output.finalize()
  } catch (err) {
    await output.cancel().catch(() => {})
    throw err
  }
  const bytes = new Uint8Array(target.buffer!)
  const url = await desktop!.renders.write(project.id, key, bytes)
  // The file is right for its key even if the timeline changed meanwhile: undo can bring it back.
  if (useRenders.getState().projectId === project.id) bump({ files: { ...useRenders.getState().files, [key]: url } })
}

/**
 * Renders the chunks covering [from, to) that need it — everything drawn, or
 * (in the background) only the stretches too heavy to play live. Rendering
 * waits while the timeline plays and yields to the editor between frames.
 */
export async function renderPreviews(range: [number, number], label: string, opts: { background?: boolean } = {}) {
  if (!desktop) return
  const background = Boolean(opts.background)
  // An explicit render replaces whatever runs; the background never interrupts anything.
  if (useRenders.getState().job) {
    if (background) return
    cancelRender()
  }
  encoderChecked ??= canEncodeVideo('avc', { width: 1280, height: 720, bitrate: 4e6 }).catch(() => false)
  if (!(await encoderChecked)) {
    if (!background) toast.error('This computer can’t encode H.264 video, so previews can’t be rendered.')
    return
  }
  const project = getProject()
  const len = chunkFrames(project.settings.fps)
  const first = Math.max(0, Math.floor(range[0] / len))
  const last = Math.ceil(Math.min(range[1], projectDuration(project)) / len)
  const playhead = Math.floor(usePlayback.getState().frame / len)
  let todo: number[] = []
  for (let i = first; i < last; i++) {
    const state = chunkState(project, i)
    if (state === 'empty' || state === 'rendered') continue
    if (background && state === 'fine') continue
    todo.push(i)
  }
  // The background starts where you are.
  if (background) todo = todo.sort((a, b) => Math.abs(a - playhead) - Math.abs(b - playhead))
  if (!todo.length) {
    if (!background) toast.success('Everything here is rendered already.')
    return
  }

  const ctl = new AbortController()
  controller = ctl
  useRenders.setState({ job: { label, background, done: 0, total: todo.length, current: null } })
  await document.fonts.ready
  const res = useUI.getState().renderRes
  const { width, height } = renderSize(project, res)
  const feeder = new FrameFeeder(project, width, height)
  let failed: unknown = null
  try {
    for (const index of todo) {
      await whilePlaying(ctl.signal)
      if (ctl.signal.aborted) break
      const now = getProject()
      const key = chunkKey(now, index, res)
      const started = useRenders.getState().job
      if (started && controller === ctl) useRenders.setState({ job: { ...started, current: index } })
      if (key && !useRenders.getState().files[key]) await renderChunk(now, index, key, res, feeder, ctl.signal)
      const job = useRenders.getState().job
      if (job && controller === ctl) useRenders.setState({ job: { ...job, done: job.done + 1, current: null } })
    }
  } catch (err) {
    if (!(err instanceof DOMException && err.name === 'AbortError')) failed = err
  } finally {
    feeder.dispose()
    if (controller === ctl) {
      controller = null
      useRenders.setState({ job: null })
    }
  }
  if (failed) {
    if (background) useUI.getState().setBackgroundRender(false)
    toast.error('Rendering previews stopped', { description: failed instanceof Error ? failed.message : String(failed) })
  }
}

/** Stops the render that's running (finished chunks stay). */
export function cancelRender() {
  controller?.abort()
  controller = null
  useRenders.setState({ job: null })
}

/** Deletes rendered previews: those of the chunks covering a range, or all of this project's. */
export async function deleteRenders(range?: [number, number]) {
  if (!desktop) return
  const project = getProject()
  if (!range) {
    cancelRender()
    await desktop.renders.remove(project.id, null)
    bump({ files: {} })
    return
  }
  const len = chunkFrames(project.settings.fps)
  const keys: string[] = []
  for (let i = Math.floor(range[0] / len); i < Math.ceil(range[1] / len); i++) {
    const key = chunkKey(project, i)
    if (key && useRenders.getState().files[key]) keys.push(key)
  }
  if (!keys.length) return
  await desktop.renders.remove(project.id, keys)
  const files = { ...useRenders.getState().files }
  for (const k of keys) delete files[k]
  bump({ files })
}

// ─── Background rendering ────────────────────────────────────────────────
// After a few quiet seconds (no edits, no playback, no clicks or keys), heavy
// stretches render on their own, nearest the playhead first. Anything you do
// stops it at once; it picks up again when things are quiet.

const IDLE_MS = 4000
let lastActivity = performance.now()

function activity() {
  lastActivity = performance.now()
  if (useRenders.getState().job?.background) cancelRender()
}

if (desktop && typeof window !== 'undefined') {
  for (const type of ['pointerdown', 'keydown', 'wheel'] as const) window.addEventListener(type, activity, { capture: true, passive: true })
  useEditor.subscribe((s, prev) => {
    if (s.project.id !== prev.project.id) {
      cancelRender()
      void loadFiles(s.project.id)
    }
    if (s.project !== prev.project) activity()
  })
  usePlayback.subscribe((s, prev) => {
    if (s.playing && !prev.playing) activity()
  })
  // The render bar reflects how this computer copes (heavier means red sooner).
  useAutoRes.subscribe(() => bump())
  useUI.subscribe((s, prev) => {
    if (s.renderRes !== prev.renderRes) {
      cancelRender()
      bump()
    }
  })
  void loadFiles(useEditor.getState().project.id)
  setInterval(() => {
    if (!useUI.getState().backgroundRender || useRenders.getState().job || usePlayback.getState().playing) return
    if (performance.now() - lastActivity < IDLE_MS || document.hidden) return
    const project = getProject()
    void renderPreviews([0, projectDuration(project)], 'Rendering in the background', { background: true })
  }, 1000)
}
