import { ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { useApprovals } from '@/integrations/approvals'

/** Asks before any agent-written code runs on this machine. */
export function AgentApprovals() {
  const current = useApprovals((s) => s.queue[0])
  const waiting = useApprovals((s) => s.queue.length)
  return (
    <Dialog open={Boolean(current)} onOpenChange={(open) => !open && current?.resolve(false)} title={current?.title ?? ''} bare className="w-[min(640px,calc(100vw-48px))]">
      {current && (
        <div className="p-5">
          <div className="flex items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-warn/15 text-warn">
              <ShieldCheck className="size-4.5" />
            </span>
            <div className="min-w-0">
              <h2 className="text-lg font-semibold tracking-tight text-fg">{current.title}</h2>
              <p className="mt-0.5 text-sm text-fg-3">
                {current.requester} wants to: <span className="text-fg-2">{current.detail}</span>
              </p>
            </div>
          </div>
          {current.code && (
            <pre className="mt-4 max-h-[46vh] overflow-auto rounded-xl bg-black/40 px-4 py-3 font-mono text-[11px] leading-relaxed text-fg-2 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]">{current.code}</pre>
          )}
          <p className="mt-3 text-2xs leading-relaxed text-fg-4">This runs with your permissions on this computer. Only allow code you’re comfortable with.</p>
          <div className="mt-5 flex items-center justify-end gap-2">
            {waiting > 1 && <span className="mr-auto text-2xs text-fg-4">{waiting - 1} more waiting</span>}
            <Button variant="ghost" onClick={() => current.resolve(false)}>
              Don’t run
            </Button>
            <Button variant="primary" onClick={() => current.resolve(true)}>
              Run it
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  )
}
