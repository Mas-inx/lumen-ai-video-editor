import { Captions, CircleAlert, CircleStop, FolderSearch, ListVideo, LoaderCircle, Play, RotateCcw, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { Button, IconButton } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { useUI } from '@/editor/ui-store'
import { cancelJob, clearFinished, queueCounts, removeJob, retryJob, startQueue, stopQueue, useRenderQueue, type QueueJob } from '@/engine/render-queue'
import { cn } from '@/lib/cn'
import { desktop } from '@/lib/platform'

const fmtBytes = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`)
const fmtTime = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.max(1, Math.round(s))}s`)

const STATUS: Record<QueueJob['status'], { label: string; className: string }> = {
  queued: { label: 'Waiting', className: 'bg-white/[0.07] text-fg-3' },
  running: { label: 'Rendering', className: 'bg-ai/15 text-ai-2' },
  done: { label: 'Done', className: 'bg-ok/15 text-ok' },
  failed: { label: 'Failed', className: 'bg-danger/15 text-danger' },
  cancelled: { label: 'Cancelled', className: 'bg-white/[0.07] text-fg-4' },
}

/** Every queued export: start them, watch them render one after another, open what's done. */
export function RenderQueueDialog() {
  const open = useUI((s) => s.queueOpen)
  const jobs = useRenderQueue((s) => s.jobs)
  const active = useRenderQueue((s) => s.active)
  const counts = queueCounts(jobs)
  const close = () => useUI.getState().setQueueOpen(false)
  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()} title="Render queue" description="Exports wait here with their files already chosen, then render one after another — keep editing meanwhile." className="w-[min(640px,calc(100vw-32px))]">
      <div className="max-h-[min(460px,58vh)] space-y-2 overflow-y-auto px-5 pb-4">
        {!jobs.length && (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <ListVideo className="size-6 text-fg-4" />
            <p className="text-sm text-fg-2">Nothing queued</p>
            <p className="max-w-xs text-xs text-fg-4">In the Export dialog, choose “Add to queue” to line up several exports — other timelines, sizes or formats — and render them in one go.</p>
          </div>
        )}
        {jobs.map((job) => (
          <JobRow key={job.id} job={job} />
        ))}
      </div>
      <div className="flex items-center gap-2 border-t border-line bg-black/15 px-5 py-3.5">
        <div className="flex-1 text-xs text-fg-4">
          {counts.running ? `Rendering · ${counts.queued} waiting` : counts.queued ? `${counts.queued} waiting` : jobs.length ? `${counts.done} done${counts.failed ? ` · ${counts.failed} failed` : ''}` : ''}
        </div>
        {jobs.some((j) => j.status !== 'queued' && j.status !== 'running') && (
          <Button variant="ghost" onClick={clearFinished}>
            Clear finished
          </Button>
        )}
        {active ? (
          <Button variant="secondary" onClick={() => stopQueue(false)} title="Finish the export that's rendering, then stop">
            <CircleStop /> Stop after this one
          </Button>
        ) : (
          <Button variant="primary" disabled={!counts.queued || !desktop} onClick={() => void startQueue()}>
            <Play /> Start rendering
          </Button>
        )}
      </div>
    </Dialog>
  )
}

function JobRow({ job }: { job: QueueJob }) {
  const s = STATUS[job.status]
  const path = job.result?.path ?? job.target.path
  return (
    <div className={cn('flex gap-3 rounded-xl bg-white/[0.035] p-2.5 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.04)]', job.status === 'running' && 'shadow-[inset_0_0_0_1px_rgb(94_242_166/0.25)]')}>
      <div className="relative aspect-video w-24 shrink-0 overflow-hidden rounded-lg bg-black [background-image:repeating-conic-gradient(#1a1a1a_0_25%,#101010_0_50%)] [background-size:10px_10px]">
        {job.preview && <img src={job.preview} alt="" className="h-full w-full object-contain" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-fg">{job.label}</span>
          <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold', s.className)}>{s.label}</span>
        </div>
        <div className="truncate text-2xs text-fg-4">{job.detail}</div>
        <div className="truncate text-2xs text-fg-4" title={path}>
          {path}
        </div>
        {job.status === 'running' && (
          <div className="mt-1.5 flex items-center gap-2">
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/[0.08]">
              <div className="h-full rounded-full bg-gradient-to-r from-accent to-ai-2 transition-[width] duration-150" style={{ width: `${job.progress * 100}%` }} />
            </div>
            <span className="text-2xs text-fg-4 tabular">{job.message ?? `${Math.round(job.progress * 100)}%`}</span>
          </div>
        )}
        {job.status === 'done' && job.result && (
          <div className="mt-0.5 flex items-center gap-2 text-2xs text-fg-4">
            {fmtBytes(job.result.size)} · {fmtTime(job.result.seconds)}
            {job.result.sidecar && (
              <span className="flex items-center gap-0.5" title={job.result.sidecar}>
                <Captions className="size-3" /> captions
              </span>
            )}
          </div>
        )}
        {job.status === 'failed' && (
          <div className="mt-0.5 flex items-start gap-1 text-2xs text-danger">
            <CircleAlert className="mt-px size-3 shrink-0" />
            <span className="line-clamp-2">{job.error}</span>
          </div>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end justify-center gap-1">
        {job.status === 'running' && (
          <Button size="xs" variant="ghost" onClick={() => cancelJob(job.id)}>
            Cancel
          </Button>
        )}
        {job.status === 'done' && job.result && (
          <div className="flex gap-0.5">
            <IconButton size="xs" label="Show in folder" onClick={() => void desktop?.files.reveal(job.result!.path)}>
              <FolderSearch />
            </IconButton>
            {job.settings.format !== 'png' && (
              <IconButton size="xs" label="Play" onClick={() => void desktop?.files.open(job.result!.path)}>
                <Play />
              </IconButton>
            )}
          </div>
        )}
        {(job.status === 'failed' || job.status === 'cancelled') && (
          <Button size="xs" variant="ghost" onClick={() => void retryJob(job.id)}>
            <RotateCcw /> Retry
          </Button>
        )}
        {job.status !== 'running' && (
          <IconButton size="xs" label={job.status === 'queued' ? 'Remove from the queue' : 'Remove'} onClick={() => removeJob(job.id)}>
            <X />
          </IconButton>
        )}
      </div>
    </div>
  )
}

/** Title-bar progress for the render queue (hidden while it's empty). */
export function QueueIndicator() {
  const jobs = useRenderQueue((s) => s.jobs)
  const active = useRenderQueue((s) => s.active)
  const counts = queueCounts(jobs)
  const visible = active || counts.queued > 0 || jobs.some((j) => j.status === 'done' || j.status === 'failed')
  const running = counts.running
  const index = running ? jobs.filter((j) => j.status !== 'cancelled').indexOf(running) + 1 : 0
  const total = jobs.filter((j) => j.status !== 'cancelled').length
  return (
    <AnimatePresence>
      {visible && (
        <motion.button
          type="button"
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.9 }}
          onClick={() => useUI.getState().setQueueOpen(true)}
          title="Render queue"
          className="no-drag flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-fg-3 outline-none transition-colors hover:bg-white/[0.06] hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          {running ? <LoaderCircle className="size-3.5 animate-spin text-ai-2" /> : <ListVideo className="size-3.5" />}
          <span className="tabular">{running ? `${index}/${total} · ${Math.round(running.progress * 100)}%` : counts.queued ? `Queue · ${counts.queued}` : `Queue · ${counts.done} done`}</span>
        </motion.button>
      )}
    </AnimatePresence>
  )
}
