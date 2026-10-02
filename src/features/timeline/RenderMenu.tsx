import { Check, ChevronDown, LoaderCircle, Trash, X, Zap } from 'lucide-react'
import { useState } from 'react'
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '@/components/ui/menu'
import { Tip } from '@/components/ui/tooltip'
import { useEditor } from '@/editor/store'
import { RENDER_RES, useUI } from '@/editor/ui-store'
import { cancelRender, useRenders } from '@/engine/render-cache'
import { actions } from '@/features/shell/actions'
import { desktop } from '@/lib/platform'

const blank = <span className="size-4" />

function formatBytes(n: number) {
  if (n < 1024 ** 2) return `${Math.max(0, Math.round(n / 1024))} KB`
  if (n < 1024 ** 3) return `${Math.round(n / 1024 ** 2)} MB`
  return `${(n / 1024 ** 3).toFixed(1)} GB`
}

/** Render previews: what to render, at what quality, and the job that's running. */
export function RenderMenu() {
  const job = useRenders((s) => s.job)
  const hasRange = useEditor((s) => Boolean(s.project.range))
  const hasSelection = useUI((s) => s.selection.length > 0)
  const renderRes = useUI((s) => s.renderRes)
  const upscale = useUI((s) => s.upscale)
  const backgroundRender = useUI((s) => s.backgroundRender)
  const usePreviews = useUI((s) => s.usePreviews)
  const [usage, setUsage] = useState<string | null>(null)
  if (!desktop) return null
  const api = desktop

  const onOpen = (open: boolean) => {
    if (!open) return
    void api.renders
      .usage()
      .then((u) => setUsage(`${formatBytes(u.bytes)} of ${formatBytes(u.cap)} used by renders`))
      .catch(() => setUsage(null))
  }

  return (
    <div className="flex items-center">
      {job && (
        <div
          className={`mr-1 flex h-7 items-center gap-1.5 rounded-full pr-0.5 pl-2 text-2xs font-medium tabular ${job.background ? 'bg-white/[0.04] text-fg-3' : 'bg-accent/10 text-accent-2 shadow-[inset_0_0_0_1px_rgb(214_238_0/0.25)]'}`}
          title={job.label}
        >
          <LoaderCircle className="size-3 animate-spin" />
          <span>Rendering {Math.min(job.done + 1, job.total)}/{job.total}</span>
          <button type="button" aria-label="Stop rendering" onClick={cancelRender} className="grid size-5 place-items-center rounded-full opacity-80 hover:bg-white/[0.08] hover:opacity-100">
            <X className="size-3" />
          </button>
        </div>
      )}
      <Menu onOpenChange={onOpen}>
        <Tip content="Render previews — heavy stretches then play smoothly">
          <MenuTrigger asChild>
            <button
              type="button"
              aria-label="Render previews"
              className="flex h-7 items-center gap-1 rounded-lg px-1.5 text-fg-3 outline-none transition-colors hover:bg-white/[0.06] hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/60 data-[state=open]:bg-white/[0.08] data-[state=open]:text-fg"
            >
              <Zap className="size-4" />
              <ChevronDown className="size-3 text-fg-4" />
            </button>
          </MenuTrigger>
        </Tip>
        <MenuContent align="end" className="w-80">
          <MenuLabel>Render previews</MenuLabel>
          <MenuItem icon={<Zap />} shortcut="enter" onSelect={actions.renderPreviews}>
            {hasRange ? 'Render in to out' : 'Render the timeline'}
          </MenuItem>
          {hasRange && (
            <MenuItem icon={blank} onSelect={actions.renderTimeline}>
              Render the whole timeline
            </MenuItem>
          )}
          <MenuItem icon={blank} disabled={!hasSelection} onSelect={actions.renderSelection}>
            Render the selected clips
          </MenuItem>
          <MenuSeparator />
          <MenuLabel>Resolution</MenuLabel>
          {RENDER_RES.map((r) => (
            <MenuItem key={r.value} icon={renderRes === r.value ? <Check /> : blank} onSelect={() => useUI.getState().setRenderRes(r.value)}>
              <span className="flex flex-col py-0.5 leading-tight">
                <span>{r.label}</span>
                <span className="truncate text-2xs text-fg-4">{r.hint}</span>
              </span>
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuLabel>Scaling up to the viewer</MenuLabel>
          <MenuItem icon={upscale === 'sharp' ? <Check /> : blank} onSelect={() => useUI.getState().setUpscale('sharp')}>
            <span className="flex flex-col py-0.5 leading-tight">
              <span>Sharp</span>
              <span className="truncate text-2xs text-fg-4">Contrast-adaptive sharpening on the GPU</span>
            </span>
          </MenuItem>
          <MenuItem icon={upscale === 'smooth' ? <Check /> : blank} onSelect={() => useUI.getState().setUpscale('smooth')}>
            Smooth
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={backgroundRender ? <Check /> : blank} onSelect={() => useUI.getState().setBackgroundRender(!backgroundRender)}>
            Render heavy stretches when idle
          </MenuItem>
          <MenuItem icon={usePreviews ? <Check /> : blank} onSelect={() => useUI.getState().setUsePreviews(!usePreviews)}>
            Play rendered previews
          </MenuItem>
          <MenuSeparator />
          {hasRange && (
            <MenuItem icon={<Trash />} onSelect={() => void actions.deleteRenders(true)}>
              Delete renders in to out
            </MenuItem>
          )}
          <MenuItem icon={<Trash />} danger onSelect={() => void actions.deleteRenders(false)}>
            Delete all of this project’s renders
          </MenuItem>
          {usage && <div className="px-2 pt-1 pb-1.5 text-2xs text-fg-4">{usage}</div>}
        </MenuContent>
      </Menu>
    </div>
  )
}
