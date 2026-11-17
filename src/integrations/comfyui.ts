/**
 * ComfyUI in the editor: the connection and the workflow library as the UI
 * sees them, and runs — with the project's footage, a clip or a frame of the
 * timeline sent as a workflow's input — whose results land in the media like
 * any render's (the job's events do that, see store.ts).
 */
import { create } from 'zustand'
import type { ComfyAPI, ComfyFileRef, ComfyMediaInput, ComfyMediaKind, ComfyRun, ComfyRunRequest, ComfyStatus, ComfyWorkflowInfo } from '@shared/comfyui'
import type { Job } from '@shared/integrations'
import { clipEnd, projectDuration } from '@/editor/ops'
import { placeAsset } from '@/editor/placement'
import { usePlayback } from '@/editor/playback'
import { getProject, useEditor } from '@/editor/store'
import { consumed, sourceFrameAt } from '@/editor/timing'
import type { Asset } from '@/editor/types'
import { useUI } from '@/editor/ui-store'
import { canvasBase64, mediaStills, timelineStills } from '@/engine/stills'
import { useIntegrations } from './store'

let bridge: ComfyAPI | undefined = typeof window !== 'undefined' ? window.lumen?.integrations?.comfyui : undefined

/** Tests stand in for the main process with this. */
export function setComfyBridge(api: ComfyAPI | undefined) {
  bridge = api
}

export const comfyAvailable = () => Boolean(bridge)

interface ComfyState {
  status: ComfyStatus | null
  checking: boolean
  workflows: ComfyWorkflowInfo[]
}

export const useComfy = create<ComfyState>(() => ({ status: null, checking: false, workflows: [] }))

const plain = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

async function call<T>(fn: (api: ComfyAPI) => Promise<T>): Promise<T> {
  if (!bridge) throw new Error('ComfyUI needs Lumen’s desktop app.')
  try {
    return await fn(bridge)
  } catch (err) {
    throw new Error(plain(err))
  }
}

// ─── Connection and library ──────────────────────────────────────────────

/** Checks the connection (again, unless `recheck` is false and it was checked a moment ago) and reads the library. */
export async function refreshComfy(recheck = true) {
  if (!bridge) return null
  useComfy.setState({ checking: true })
  try {
    const status = await call((api) => api.status(recheck))
    const workflows = await call((api) => api.workflows())
    useComfy.setState({ status, workflows })
    return status
  } finally {
    useComfy.setState({ checking: false })
  }
}

export async function loadComfyWorkflows() {
  const workflows = await call((api) => api.workflows())
  useComfy.setState({ workflows })
  return workflows
}

export async function configureComfy(patch: Parameters<ComfyAPI['configure']>[0]) {
  useComfy.setState({ checking: true })
  try {
    const status = await call((api) => api.configure(patch))
    useComfy.setState({ status })
    await loadComfyWorkflows()
    return status
  } finally {
    useComfy.setState({ checking: false })
  }
}

/** A .json or .png workflow file; without a path, a file dialog asks. Null when it was cancelled. */
export async function importComfyWorkflow(path?: string) {
  const workflow = await call((api) => api.importFile(path))
  if (workflow) await loadComfyWorkflows()
  return workflow
}

export async function importComfyJson(json: string, name?: string) {
  const workflow = await call((api) => api.importJson(json, name))
  await loadComfyWorkflows()
  return workflow
}

export async function renameComfyWorkflow(id: string, name: string) {
  useComfy.setState({ workflows: await call((api) => api.rename(id, name)) })
}

export async function removeComfyWorkflow(id: string) {
  useComfy.setState({ workflows: await call((api) => api.remove(id)) })
}

// ─── Media for a workflow's inputs ───────────────────────────────────────

/** Where a workflow's image, video or audio comes from. */
export type ComfySource =
  /** A media item; for a video going into an image input, its frame at `seconds` (default: the first). */
  | { from: 'asset'; assetId: string; seconds?: number }
  /** A clip on the timeline: the stretch of footage it uses, or its frame under the playhead (else its first). */
  | { from: 'clip'; clipId: string }
  /** The timeline at a frame, exactly as the export renders it. */
  | { from: 'timeline'; frame: number }

export interface ComfyMediaChoice {
  node: string
  input: string
  kind: ComfyMediaKind
  source: ComfySource
}

const pngBytes = (canvas: HTMLCanvasElement) => Uint8Array.from(atob(canvasBase64(canvas, 'image/png')), (c) => c.charCodeAt(0))

const sendBytes = (data: Uint8Array) => call((api) => api.upload({ kind: 'bytes', data, fileName: 'frame.png' }))

/** Puts the media a workflow input takes into ComfyUI's input folder: a file as it is, or a frame rendered as a PNG. */
export async function sendToComfy(kind: ComfyMediaKind, source: ComfySource): Promise<{ file: ComfyFileRef; trim?: ComfyMediaInput['trim'] }> {
  const p = getProject()
  if (source.from === 'timeline') {
    if (kind !== 'image') throw new Error(`A frame of the timeline can only go into an image input, not a ${kind} one.`)
    const end = projectDuration(p)
    if (end <= 0) throw new Error('The timeline is empty — there’s no frame to send.')
    const frame = Math.max(0, Math.min(end - 1, Math.round(source.frame)))
    const [canvas] = await timelineStills(p, [frame], p.settings.width)
    return { file: await sendBytes(pngBytes(canvas)) }
  }

  let asset: Asset | undefined
  let at = 0
  let trim: ComfyMediaInput['trim']
  if (source.from === 'clip') {
    const clip = p.clips[source.clipId]
    if (!clip) throw new Error('That clip isn’t on the timeline any more.')
    asset = clip.assetId ? p.assets[clip.assetId] : undefined
    if (!asset) throw new Error(`“${clip.name}” has no footage of its own — use a clip with media, or a frame of the timeline.`)
    const fps = p.settings.fps
    const playhead = usePlayback.getState().frame
    at = (playhead >= clip.start && playhead < clipEnd(clip) ? sourceFrameAt(clip, playhead - clip.start) : clip.inPoint) / fps
    trim = { from: clip.inPoint / fps, to: (clip.inPoint + consumed(clip)) / fps, ...(asset.fps ? { fps: asset.fps } : {}) }
  } else {
    asset = p.assets[source.assetId]
    if (!asset) throw new Error('That media item isn’t in the project any more.')
    at = source.seconds ?? 0
  }
  if (asset.source.missing) throw new Error(`“${asset.name}” is offline — its file can’t be found.`)

  const src = asset.source
  if (kind === 'image') {
    if (asset.kind === 'audio') throw new Error(`“${asset.name}” is audio — an image input needs a picture.`)
    if (asset.kind === 'image' && src.type === 'file') return { file: await call((api) => api.upload({ kind: 'media', url: src.url })) }
    const [still] = await mediaStills(asset, [at], asset.width ?? p.settings.width)
    return { file: await sendBytes(pngBytes(still)) }
  }
  if (src.type !== 'file') throw new Error(`“${asset.name}” is an image sequence — ComfyUI’s ${kind} loaders need a file. Export it first, or send one of its frames to an image input.`)
  if (kind === 'video' && asset.kind !== 'video') throw new Error(`“${asset.name}” isn’t a video — a video input needs one.`)
  if (kind === 'audio' && (asset.kind === 'image' || (asset.kind === 'video' && asset.hasAudio === false))) throw new Error(`“${asset.name}” has no sound.`)
  return { file: await call((api) => api.upload({ kind: 'media', url: src.url })), ...(trim ? { trim } : {}) }
}

// ─── Runs ────────────────────────────────────────────────────────────────

/**
 * Sends the media, starts the run and lists its job. What it saves lands in
 * the media when it finishes — and on the timeline at `place.at` when asked.
 */
export async function runComfy(req: Omit<ComfyRunRequest, 'media'>, media: ComfyMediaChoice[] = [], place?: { at: number; source: 'ai' | 'user' }): Promise<ComfyRun> {
  const sent: ComfyMediaInput[] = []
  for (const m of media) {
    const { file, trim } = await sendToComfy(m.kind, m.source)
    sent.push({ node: m.node, input: m.input, file, ...(trim ? { trim } : {}) })
  }
  const run = await call((api) => api.run({ ...req, media: sent }))
  // The job's own events are on their way too; don't wait for them to list it.
  useIntegrations.setState((s) => (s.jobs[run.job.id] ? s : { jobs: { ...s.jobs, [run.job.id]: run.job } }))
  if (place) placeWhenDone(run.job.id, place.at, place.source)
  return run
}

/** Waits up to `seconds` for a run to end and, if it made media, for that media to be in the project. */
export function waitForComfy(jobId: string, seconds: number, signal?: AbortSignal, progress?: (line: string) => void): Promise<Job | undefined> {
  const done = () => {
    const s = useIntegrations.getState()
    const job = s.jobs[jobId]
    return job && job.status !== 'running' && (job.status !== 'done' || !job.assets?.length || (s.imported[jobId]?.length ?? 0) >= job.assets.length) ? job : undefined
  }
  const now = done()
  if (now || seconds <= 0) return Promise.resolve(now ?? useIntegrations.getState().jobs[jobId])
  return new Promise((resolve) => {
    let told = ''
    const finish = (job: Job | undefined) => {
      clearTimeout(timer)
      unsubscribe()
      signal?.removeEventListener('abort', stop)
      resolve(job)
    }
    // Stopped waiting (the run carries on, and still lands in the media).
    const stop = () => finish(useIntegrations.getState().jobs[jobId])
    const timer = setTimeout(stop, seconds * 1000)
    const unsubscribe = useIntegrations.subscribe(() => {
      const job = done()
      if (job) return finish(job)
      const running = useIntegrations.getState().jobs[jobId]
      if (!running || !progress) return
      const line = [running.progress >= 0 ? `${Math.round(running.progress * 100)}%` : '', running.message ?? ''].filter(Boolean).join(' — ')
      if (line && line !== told) progress((told = line))
    })
    signal?.addEventListener('abort', stop, { once: true })
  })
}

/** Puts a finished run's media on the timeline one after another from `at`, as one undo step. */
export function placeComfyResults(jobId: string, at: number, source: 'ai' | 'user'): string[] {
  const ids = useIntegrations.getState().imported[jobId] ?? []
  const placed: string[] = []
  if (!ids.length) return placed
  let frame = at
  useEditor.getState().transaction(ids.length > 1 ? `Add ${ids.length} clips` : 'Add clip', source, () => {
    for (const id of ids) {
      const clip = placeAsset(id, frame, { source })
      if (!clip) continue
      placed.push(clip)
      frame = clipEnd(getProject().clips[clip])
    }
  })
  if (placed.length && source === 'user') useUI.getState().select(placed)
  return placed
}

/** For runs still going: their media goes on the timeline once it lands. */
export function placeWhenDone(jobId: string, at: number, source: 'ai' | 'user') {
  void waitForComfy(jobId, 12 * 60 * 60).then((job) => {
    if (job?.status === 'done') placeComfyResults(jobId, at, source)
  })
}
