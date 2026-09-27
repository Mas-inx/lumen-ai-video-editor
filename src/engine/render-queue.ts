/**
 * The render queue: exports lined up with their destinations already chosen,
 * rendered one after another. Each job keeps a snapshot of the project as it
 * was when it was queued, so editing on while the queue runs changes nothing.
 */
import { create } from 'zustand'
import type { ExportTarget } from '@shared/app'
import type { Project } from '@/editor/types'
import { uid } from '@/lib/id'
import { desktop } from '@/lib/platform'
import { ExportCancelled, exportRunning, runExport, type ExportResult, type ExportSettings } from './export'

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

export interface QueueJob {
  id: string
  /** What's rendered, e.g. “Trip · Main timeline”. */
  label: string
  /** Format and size, e.g. “MP4 · 1920×1080 · H.264”. */
  detail: string
  project: Project
  settings: ExportSettings
  target: ExportTarget
  status: JobStatus
  /** 0..1 */
  progress: number
  message?: string
  preview?: string
  result?: ExportResult & { seconds: number }
  error?: string
  addedAt: number
}

interface QueueState {
  jobs: QueueJob[]
  /** The queue works through its jobs until none are left queued. */
  active: boolean
}

export const useRenderQueue = create<QueueState>(() => ({ jobs: [], active: false }))

const update = (id: string, patch: Partial<QueueJob>) => useRenderQueue.setState((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)) }))

let controller: AbortController | null = null
let runningId: string | null = null

export function queueExport(job: Pick<QueueJob, 'label' | 'detail' | 'project' | 'settings' | 'target'>): QueueJob {
  const full: QueueJob = { ...job, id: uid('render'), status: 'queued', progress: 0, addedAt: Date.now() }
  useRenderQueue.setState((s) => ({ jobs: [...s.jobs, full] }))
  return full
}

/** Starts working through the queue (a no-op while it already is). Resolves when it stops. */
export async function startQueue() {
  if (useRenderQueue.getState().active) return
  useRenderQueue.setState({ active: true })
  try {
    for (;;) {
      if (!useRenderQueue.getState().active) break
      const next = useRenderQueue.getState().jobs.find((j) => j.status === 'queued')
      if (!next) break
      if (exportRunning()) {
        // An export from the dialog (or the Copilot) is running: wait for it.
        await new Promise((r) => setTimeout(r, 1000))
        continue
      }
      await runJob(next)
    }
  } finally {
    useRenderQueue.setState({ active: false })
  }
}

/** Stops after the job that's rendering now (which is cancelled too with `cancelCurrent`). */
export function stopQueue(cancelCurrent = false) {
  useRenderQueue.setState({ active: false })
  if (cancelCurrent) controller?.abort()
}

async function runJob(job: QueueJob) {
  if (!desktop) throw new Error('Rendering needs the desktop app.')
  runningId = job.id
  controller = new AbortController()
  const started = performance.now()
  update(job.id, { status: 'running', progress: 0, message: 'Starting…', error: undefined })
  try {
    const handle = await desktop.export.open(job.target.token)
    update(job.id, { target: { ...job.target, path: handle.path } })
    const res = await runExport(
      job.project,
      job.settings,
      handle,
      (p) => {
        const progress = p.phase === 'rendering' ? p.done / Math.max(1, p.total) : p.phase === 'finishing' ? 1 : 0
        update(job.id, { progress, message: p.phase === 'rendering' ? `${Math.round(progress * 100)}%` : p.message, ...(p.preview ? { preview: p.preview } : {}) })
      },
      controller.signal,
    )
    update(job.id, { status: 'done', progress: 1, message: undefined, result: { ...res, seconds: (performance.now() - started) / 1000 } })
  } catch (err) {
    if (err instanceof ExportCancelled) update(job.id, { status: 'cancelled', message: undefined })
    else update(job.id, { status: 'failed', message: undefined, error: err instanceof Error ? err.message : String(err) })
  } finally {
    runningId = null
    controller = null
  }
}

export function cancelJob(id: string) {
  if (runningId === id) controller?.abort()
  else {
    const job = useRenderQueue.getState().jobs.find((j) => j.id === id)
    if (job?.status === 'queued') {
      void desktop?.export.forget(job.target.token)
      update(id, { status: 'cancelled' })
    }
  }
}

export function removeJob(id: string) {
  const job = useRenderQueue.getState().jobs.find((j) => j.id === id)
  if (!job) return
  if (job.status === 'running') return
  if (job.status === 'queued') void desktop?.export.forget(job.target.token)
  useRenderQueue.setState((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) }))
}

/** Puts a failed or cancelled job back in line (asking where to save it again — its first destination was used). */
export async function retryJob(id: string) {
  const job = useRenderQueue.getState().jobs.find((j) => j.id === id)
  if (!job || !desktop || (job.status !== 'failed' && job.status !== 'cancelled')) return false
  const name = job.target.path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') ?? job.label
  const ext = job.target.folder ? 'png' : (job.target.path.split('.').pop() ?? 'mp4')
  const target = await desktop.export.pick({ defaultName: name, extension: ext, filterName: ext.toUpperCase(), folder: job.target.folder })
  if (!target) return false
  update(id, { status: 'queued', progress: 0, error: undefined, result: undefined, preview: undefined, target })
  return true
}

export function clearFinished() {
  useRenderQueue.setState((s) => ({ jobs: s.jobs.filter((j) => j.status === 'queued' || j.status === 'running') }))
}

export const queueCounts = (jobs: QueueJob[]) => ({
  queued: jobs.filter((j) => j.status === 'queued').length,
  running: jobs.find((j) => j.status === 'running') ?? null,
  done: jobs.filter((j) => j.status === 'done').length,
  failed: jobs.filter((j) => j.status === 'failed').length,
})
