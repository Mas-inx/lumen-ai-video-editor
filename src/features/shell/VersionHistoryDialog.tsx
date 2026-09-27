import { CopyPlus, History, LoaderCircle, RotateCcw } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ProjectVersion } from '@shared/app'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { useUI } from '@/editor/ui-store'
import { cn } from '@/lib/cn'
import { desktop } from '@/lib/platform'
import { projectVersions, restoreVersion } from '@/project/session'

const KIND: Record<ProjectVersion['kind'], { label: string; className: string }> = {
  save: { label: 'Saved', className: 'bg-accent/15 text-accent-2' },
  auto: { label: 'Auto', className: 'bg-white/[0.07] text-fg-3' },
  restore: { label: 'Before restore', className: 'bg-warn/15 text-warn' },
}

const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const day = (t: number) => {
  const d = new Date(t)
  const today = new Date()
  const yesterday = new Date(Date.now() - 86_400_000)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })
}
const length = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

/** Every stored version of the project: restore one, or open it as a copy. */
export function VersionHistoryDialog() {
  const open = useUI((s) => s.versionsOpen)
  const [versions, setVersions] = useState<ProjectVersion[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setVersions(null)
    void projectVersions().then(setVersions)
  }, [open])

  const close = () => useUI.getState().setVersionsOpen(false)
  const act = async (v: ProjectVersion, asCopy: boolean) => {
    setBusy(v.id)
    const ok = await restoreVersion(v, asCopy)
    setBusy(null)
    if (ok) close()
  }

  const groups: { day: string; items: ProjectVersion[] }[] = []
  for (const v of versions ?? []) {
    const d = day(v.savedAt)
    const g = groups[groups.length - 1]
    if (g?.day === d) g.items.push(v)
    else groups.push({ day: d, items: [v] })
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()} title="Version history" description="Every save, plus a snapshot every ten minutes while you edit. Older versions thin out to one a day." className="w-[min(560px,calc(100vw-32px))]">
      <div className="max-h-[min(520px,62vh)] overflow-y-auto px-5 pb-5">
        {!desktop && <p className="py-8 text-center text-sm text-fg-3">Version history needs the desktop app.</p>}
        {desktop && versions === null && (
          <p className="flex items-center justify-center gap-2 py-8 text-sm text-fg-3">
            <LoaderCircle className="size-4 animate-spin" /> Loading versions…
          </p>
        )}
        {versions?.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <History className="size-6 text-fg-4" />
            <p className="text-sm text-fg-2">No versions yet</p>
            <p className="max-w-xs text-xs text-fg-4">Save the project and it starts here — and while you edit, Lumen keeps a snapshot every ten minutes.</p>
          </div>
        )}
        {groups.map((g) => (
          <div key={g.day} className="mt-2">
            <div className="sticky top-0 z-10 bg-surface-2/95 py-1.5 text-2xs font-semibold tracking-wider text-fg-4 uppercase backdrop-blur">{g.day}</div>
            <div className="space-y-1">
              {g.items.map((v, i) => (
                <div key={v.id} className="group/v flex items-center gap-3 rounded-lg px-2.5 py-2 transition-colors hover:bg-white/[0.04]">
                  <span className="w-[4.5rem] shrink-0 font-mono text-sm whitespace-nowrap text-fg tabular">{time(v.savedAt)}</span>
                  <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold', KIND[v.kind].className)}>{KIND[v.kind].label}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-fg-3">
                    {v.name} · {length(v.seconds)} · {v.clips} clip{v.clips === 1 ? '' : 's'}
                    {g.day === 'Today' && i === 0 && groups[0] === g && <span className="ml-1.5 text-fg-4">(latest)</span>}
                  </span>
                  <div className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover/v:opacity-100 focus-within:opacity-100">
                    <Button size="xs" variant="ghost" disabled={busy !== null} onClick={() => void act(v, true)} title="Open this version as a new, unsaved project">
                      <CopyPlus /> Copy
                    </Button>
                    <Button size="xs" variant="secondary" disabled={busy !== null} onClick={() => void act(v, false)}>
                      {busy === v.id ? <LoaderCircle className="animate-spin" /> : <RotateCcw />} Restore
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Dialog>
  )
}
