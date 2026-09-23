import { AudioLines, Check, CircleAlert, Download, ExternalLink, FolderOpen, Link2, LoaderCircle, Plus, X } from 'lucide-react'
import { motion } from 'motion/react'
import { useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import type { GeneratedAsset, Job, McpLink, McpStatus } from '@shared/integrations'
import { Button } from '@/components/ui/button'
import { placeAsset } from '@/editor/placement'
import { usePlayback } from '@/editor/playback'
import { useEditor } from '@/editor/store'
import { useUI } from '@/editor/ui-store'
import { assetThumb } from '@/features/assets/shared'
import { dnd } from '@/features/dnd'
import { api, cancelJob, importLink, useIntegrations } from '@/integrations/store'
import { cn } from '@/lib/cn'
import { formatSeconds } from '@/lib/time'

export function StatusDot({ status, className }: { status: McpStatus | 'ready' | 'missing'; className?: string }) {
  const color = {
    connected: 'bg-ok shadow-[0_0_8px_rgb(60_207_145/0.6)]',
    ready: 'bg-ok shadow-[0_0_8px_rgb(60_207_145/0.6)]',
    connecting: 'bg-warn animate-pulse',
    'needs-auth': 'bg-warn animate-pulse',
    error: 'bg-danger',
    missing: 'bg-danger/70',
    disconnected: 'bg-fg-4',
  }[status]
  return <span className={cn('inline-block size-1.5 shrink-0 rounded-full', color, className)} />
}

export const STATUS_LABEL: Record<McpStatus, string> = {
  connected: 'Connected',
  connecting: 'Connecting…',
  'needs-auth': 'Waiting for sign-in',
  error: 'Error',
  disconnected: 'Not connected',
}

/** A gradient icon tile used for integration headers. */
export function IconTile({ children, tone, size = 'md' }: { children: ReactNode; tone: 'blender' | 'hyperframes' | 'mcp' | 'lumen' | 'higgsfield'; size?: 'sm' | 'md' }) {
  const bg = {
    blender: 'bg-[linear-gradient(135deg,#ff9b3d,#e8590c)] shadow-[0_8px_24px_-10px_rgb(232_89_12/0.8)]',
    hyperframes: 'bg-[linear-gradient(135deg,#22d3ee,#3b82f6)] shadow-[0_8px_24px_-10px_rgb(59_130_246/0.8)]',
    mcp: 'bg-[linear-gradient(135deg,#3f403a,#1f201c)] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]',
    lumen: 'bg-ai text-accent-fg shadow-[0_8px_24px_-10px_rgb(94_242_166/0.6)]',
    higgsfield: 'bg-[linear-gradient(135deg,#d4ff3f,#44d17a)] text-black shadow-[0_8px_24px_-10px_rgb(120_220_90/0.7)]',
  }[tone]
  return (
    <span className={cn('grid shrink-0 place-items-center text-white', size === 'md' ? 'size-11 rounded-[13px] [&_svg]:size-5' : 'size-7 rounded-[8px] [&_svg]:size-3.5', bg)}>
      {children}
    </span>
  )
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('rounded-xl bg-white/[0.03] p-4 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]', className)}>{children}</div>
}

/** Progress for a running job: determinate bar, or a shimmer when the length is unknown. */
export function JobProgress({ job, compact }: { job: Job; compact?: boolean }) {
  const pct = job.progress >= 0 ? job.progress * 100 : null
  return (
    <div className={cn(compact ? 'space-y-1' : 'space-y-1.5')}>
      <div className="h-1 overflow-hidden rounded-full bg-white/10">
        {pct === null ? (
          <div className="h-full w-1/3 animate-indeterminate rounded-full bg-ai" />
        ) : (
          <div className="h-full rounded-full bg-ai transition-[width] duration-200" style={{ width: `${Math.max(3, pct)}%` }} />
        )}
      </div>
      <div className="flex items-center justify-between gap-2 text-2xs text-fg-3">
        <span className="truncate">{job.message ?? 'Working…'}</span>
        {pct !== null && <span className="shrink-0 font-mono tabular">{Math.round(pct)}%</span>}
      </div>
    </div>
  )
}

/** Where a finished job's media ended up, with one-click placement. */
export function JobMedia({ job, single }: { job: Job; single?: boolean }) {
  const ids = useIntegrations((s) => s.imported[job.id])
  const library = useEditor((s) => s.project.assets)
  const assets = (ids ?? []).map((id) => library[id]).filter(Boolean)
  if (!assets.length) return null
  return (
    <div className={cn('grid gap-2.5', single || assets.length === 1 ? 'grid-cols-1' : 'grid-cols-2')}>
      {assets.map((asset) => {
        const thumb = asset.kind !== 'audio' ? assetThumb(asset) : undefined
        return (
          <div
            key={asset.id}
            draggable
            onDragStart={(e) => dnd.start(e, { type: 'asset', assetId: asset.id }, asset.name)}
            onDragEnd={dnd.end}
            className="group/gen min-w-0 cursor-grab active:cursor-grabbing"
          >
            <div className="checker relative aspect-video overflow-hidden rounded-[10px] bg-surface-3 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]">
              {thumb ? (
                <img src={thumb} alt="" draggable={false} className="h-full w-full object-contain" />
              ) : (
                <div className="grid h-full place-items-center text-clip-audio/70">
                  <AudioLines className="size-6" />
                </div>
              )}
              {asset.duration !== undefined && (
                <span className="absolute right-1.5 bottom-1.5 rounded-md bg-black/60 px-1.5 py-0.5 font-mono text-[10px] text-white">{formatSeconds(asset.duration)}</span>
              )}
              <button
                type="button"
                aria-label={`Add ${asset.name} at playhead`}
                onClick={() => {
                  const id = placeAsset(asset.id, usePlayback.getState().frame)
                  if (id) useUI.getState().select([id])
                }}
                className="absolute top-1.5 right-1.5 grid size-6 scale-90 place-items-center rounded-full bg-white text-black opacity-0 shadow-lg transition-[opacity,transform] duration-200 group-hover/gen:scale-100 group-hover/gen:opacity-100"
              >
                <Plus className="size-3.5" strokeWidth={2.5} />
              </button>
            </div>
            <div className="mt-1.5 flex items-center gap-1 px-0.5 text-2xs text-fg-3">
              <Check className="size-3 text-ok" /> <span className="truncate">In your media</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function LinkRow({ link, provenance }: { link: McpLink; provenance: GeneratedAsset['provenance'] }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle')
  const url = new URL(link.url)
  const file = decodeURIComponent(url.pathname.split('/').pop() || url.hostname)
  const importIt = async () => {
    setState('busy')
    try {
      await importLink(link.url, link.name, provenance)
      setState('done')
      toast.success('Added to your media')
    } catch (err) {
      setState('idle')
      toast.error('Couldn’t import that link', { description: err instanceof Error ? err.message : String(err) })
    }
  }
  return (
    <div className="flex items-center gap-2.5 rounded-lg bg-white/[0.03] px-2.5 py-2 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.05)]">
      <Link2 className="size-3.5 shrink-0 text-fg-4" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs text-fg-2">{link.name ?? file}</div>
        <div className="truncate text-2xs text-fg-4">{url.hostname}</div>
      </div>
      <a href={link.url} target="_blank" rel="noreferrer" className="grid size-6 place-items-center rounded-md text-fg-4 hover:bg-white/[0.06] hover:text-fg-2" aria-label="Open in browser">
        <ExternalLink className="size-3.5" />
      </a>
      <Button size="xs" variant={state === 'done' ? 'ghost' : 'secondary'} disabled={state !== 'idle'} onClick={importIt}>
        {state === 'busy' ? <LoaderCircle className="animate-spin" /> : state === 'done' ? <Check /> : <Download />}
        {state === 'done' ? 'Imported' : 'Import'}
      </Button>
    </div>
  )
}

/** Everything a finished (or running) job has to show. */
export function JobOutcome({ job }: { job: Job }) {
  const result = job.result
  return (
    <div className="space-y-3">
      {job.status === 'running' && (
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <JobProgress job={job} />
          </div>
          <Button size="xs" variant="ghost" onClick={() => void cancelJob(job.id)}>
            <X /> Cancel
          </Button>
        </div>
      )}
      {job.status === 'error' && (
        <div className="flex gap-2 rounded-lg bg-danger/10 px-3 py-2.5 text-xs text-danger shadow-[inset_0_0_0_1px_rgb(255_93_93/0.2)]">
          <CircleAlert className="mt-px size-3.5 shrink-0" />
          <span className="min-w-0 break-words whitespace-pre-wrap">{job.error}</span>
        </div>
      )}
      {job.status === 'cancelled' && <p className="text-xs text-fg-3">Cancelled.</p>}
      <JobMedia job={job} />
      {result?.links.map((link) => (
        <LinkRow key={link.url} link={link} provenance={{ integration: job.integration, tool: job.title }} />
      ))}
      {!!result?.text.length && (
        <pre className="max-h-56 overflow-auto rounded-lg bg-black/30 px-3 py-2.5 font-mono text-2xs leading-relaxed whitespace-pre-wrap text-fg-2 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.05)]">
          {result.text.join('\n\n')}
        </pre>
      )}
      {job.status === 'done' && job.assets?.[0]?.source && api && (
        <button
          type="button"
          onClick={() => {
            const s = job.assets![0].source
            void api?.media.reveal(s.type === 'sequence' ? s.base + s.pattern.replace(/%0(\d)d/, (_, n: string) => '1'.padStart(Number(n), '0')) : s.url)
          }}
          className="inline-flex items-center gap-1.5 text-2xs text-fg-4 hover:text-fg-2"
        >
          <FolderOpen className="size-3" /> Show files
        </button>
      )}
    </div>
  )
}

const ago = (t: number) => {
  const s = Math.round((Date.now() - t) / 1000)
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/** A render/generation in the Generate panel: live progress, then the result. */
export function RenderCard({ job }: { job: Job }) {
  const running = job.status === 'running'
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: 'spring', stiffness: 380, damping: 32 }}
      className={cn('rounded-xl p-3 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]', running ? 'ring-ai bg-white/[0.035]' : 'bg-white/[0.025]')}
    >
      <div className="mb-2 flex items-center gap-2">
        {running ? (
          <LoaderCircle className="size-3.5 shrink-0 animate-spin text-ai-2" />
        ) : job.status === 'done' ? (
          <Check className="size-3.5 shrink-0 text-ok" />
        ) : job.status === 'error' ? (
          <CircleAlert className="size-3.5 shrink-0 text-danger" />
        ) : (
          <X className="size-3.5 shrink-0 text-fg-4" />
        )}
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-fg-2">{job.title}</span>
        {running ? (
          <button type="button" aria-label="Cancel" onClick={() => void cancelJob(job.id)} className="grid size-5 place-items-center rounded-md text-fg-4 hover:bg-white/[0.08] hover:text-fg-2">
            <X className="size-3" />
          </button>
        ) : (
          <span className="shrink-0 text-2xs text-fg-4">{ago(job.finishedAt ?? job.startedAt)}</span>
        )}
      </div>
      {running && <JobProgress job={job} compact />}
      {job.status === 'done' && <JobMedia job={job} single />}
      {job.status === 'done' && !job.assets?.length && job.result && (
        <div className="space-y-2">
          {job.result.links.map((link) => (
            <LinkRow key={link.url} link={link} provenance={{ integration: job.integration, tool: job.title }} />
          ))}
          {!job.result.links.length && <p className="line-clamp-4 text-2xs leading-relaxed text-fg-3">{job.result.text.join(' ') || 'Done'}</p>}
        </div>
      )}
      {job.status === 'error' && <p className="line-clamp-4 text-2xs leading-relaxed break-words text-danger/90">{job.error}</p>}
    </motion.div>
  )
}
