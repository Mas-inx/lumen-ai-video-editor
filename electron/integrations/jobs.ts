import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'
import { IPC, type IntegrationKind, type Job } from '../../shared/integrations'

/**
 * Long-running work (renders, generations) as observable jobs. Every change
 * is pushed to the editor windows so progress shows up live.
 */
const jobs = new Map<string, Job>()
const cancellers = new Map<string, () => void>()
/** Windows that should hear about jobs (the editor, not offscreen renderers). */
const listeners = new Set<BrowserWindow>()

export function registerJobListener(win: BrowserWindow) {
  listeners.add(win)
  win.on('closed', () => listeners.delete(win))
}

export function broadcast(channel: string, payload: unknown) {
  for (const win of listeners) if (!win.isDestroyed()) win.webContents.send(channel, payload)
}

export function createJob(integration: IntegrationKind, title: string, cancel?: () => void): Job {
  const job: Job = { id: randomUUID(), integration, title, status: 'running', progress: -1, startedAt: Date.now() }
  jobs.set(job.id, job)
  if (cancel) cancellers.set(job.id, cancel)
  broadcast(IPC.jobEvent, job)
  return job
}

export function setCanceller(id: string, cancel: () => void) {
  cancellers.set(id, cancel)
}

let lastSent = new Map<string, number>()

export function updateJob(id: string, patch: Partial<Job>) {
  const job = jobs.get(id)
  if (!job || (job.status !== 'running' && !patch.status)) return
  const next = { ...job, ...patch }
  if (next.status !== 'running') {
    next.finishedAt = Date.now()
    cancellers.delete(id)
  }
  jobs.set(id, next)
  // Progress ticks are throttled; state changes always go out.
  const now = Date.now()
  if (patch.status || patch.assets || patch.message !== job.message || now - (lastSent.get(id) ?? 0) > 80) {
    lastSent.set(id, now)
    broadcast(IPC.jobEvent, next)
  }
  if (jobs.size > 200) pruneJobs()
}

export const finishJob = (id: string, patch: Partial<Job> = {}) => updateJob(id, { progress: 1, ...patch, status: 'done' })

export function failJob(id: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  updateJob(id, { status: 'error', error: message })
}

export function cancelJob(id: string) {
  const job = jobs.get(id)
  if (!job || job.status !== 'running') return
  cancellers.get(id)?.()
  updateJob(id, { status: 'cancelled' })
}

export const isCancelled = (id: string) => jobs.get(id)?.status === 'cancelled'

export const getJob = (id: string) => jobs.get(id)

export const listJobs = () => [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt)

function pruneJobs() {
  const done = listJobs().filter((j) => j.status !== 'running')
  for (const job of done.slice(100)) {
    jobs.delete(job.id)
    lastSent.delete(job.id)
  }
  lastSent = new Map([...lastSent].filter(([id]) => jobs.has(id)))
}
