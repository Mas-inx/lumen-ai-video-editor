import { LoaderCircle, Plug } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { IconButton } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { clearFinishedJobs, openIntegrations, useIntegrations } from '@/integrations/store'
import { RenderCard } from './parts'

/** Title-bar entry to integrations, which turns into live progress while renders run. */
export function JobsIndicator() {
  const jobs = useIntegrations((s) => s.jobs)
  const available = useIntegrations((s) => s.available)
  const list = Object.values(jobs).sort((a, b) => b.startedAt - a.startedAt)
  const running = list.filter((j) => j.status === 'running')
  if (!available) return null

  return (
    <div className="flex items-center gap-0.5">
      <AnimatePresence>
        {list.length > 0 && (
          <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }}>
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-fg-3 outline-none transition-colors hover:bg-white/[0.06] hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/60 data-[state=open]:bg-white/[0.07]"
                >
                  {running.length ? (
                    <>
                      <LoaderCircle className="size-3.5 animate-spin text-ai-2" />
                      <span className="tabular">{running.length === 1 ? `${Math.max(0, Math.round((running[0].progress >= 0 ? running[0].progress : 0) * 100))}%` : `${running.length} renders`}</span>
                    </>
                  ) : (
                    <span className="tabular">Renders · {list.length}</span>
                  )}
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-80 p-0">
                <div className="flex items-center justify-between border-b border-line px-3.5 py-2.5">
                  <span className="text-sm font-semibold text-fg">Renders & generations</span>
                  {list.length > running.length && (
                    <button type="button" onClick={clearFinishedJobs} className="text-2xs text-fg-4 transition-colors hover:text-fg-2">
                      Clear finished
                    </button>
                  )}
                </div>
                <div className="max-h-[60vh] space-y-2 overflow-y-auto p-2.5">
                  {list.slice(0, 20).map((job) => (
                    <RenderCard key={job.id} job={job} />
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          </motion.div>
        )}
      </AnimatePresence>
      <IconButton label="Integrations" onClick={() => openIntegrations()} tooltipSide="bottom">
        <Plug />
      </IconButton>
    </div>
  )
}
