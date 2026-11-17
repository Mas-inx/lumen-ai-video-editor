import { CircleAlert, CircleCheck, Info, LoaderCircle, RotateCcw, ShieldCheck, TriangleAlert } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tip } from '@/components/ui/tooltip'
import { projectDuration } from '@/editor/ops'
import { playback } from '@/editor/playback'
import { checkEdit, sampleFrames, verdict, worstFirst, type QualityIssue, type Severity } from '@/editor/quality'
import { clock } from '@/editor/speech-cuts'
import { dispatch, getProject, useEditor } from '@/editor/store'
import type { Project } from '@/editor/types'
import { useUI } from '@/editor/ui-store'
import { AnalysisCancelled } from '@/engine/analysis'
import { measurePicture, measureSound, measureTextBoxes } from '@/engine/edit-check'
import { cn } from '@/lib/cn'

const ICON: Record<Severity, ReactNode> = {
  critical: <CircleAlert className="size-3.5 shrink-0 text-danger" />,
  warning: <TriangleAlert className="size-3.5 shrink-0 text-warn" />,
  info: <Info className="size-3.5 shrink-0 text-fg-3" />,
}

/** Check edit: what's wrong with the timeline, the picture and the sound, worst first — click one to go there, fix it in one click where that's safe. */
export function EditCheck() {
  const [open, setOpen] = useState(false)
  const [critical, setCritical] = useState(0)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tip content="Check edit — find problems before you export">
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Check edit"
            className="relative flex h-7 items-center rounded-lg px-1.5 text-fg-3 outline-none transition-colors hover:bg-white/[0.06] hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/60 data-[state=open]:bg-white/[0.08] data-[state=open]:text-fg"
          >
            <ShieldCheck className="size-4" />
            {critical > 0 && <span className="absolute top-1 right-1 size-1.5 rounded-full bg-danger" />}
          </button>
        </PopoverTrigger>
      </Tip>
      <PopoverContent align="end" className="w-[440px] p-0" onOpenAutoFocus={(e) => e.preventDefault()}>
        {open && <CheckPanel onCritical={setCritical} />}
      </PopoverContent>
    </Popover>
  )
}

/** The last check of the rendered picture and sound, kept while the edit stays as it was. */
let lastMeasured: { issues: QualityIssue[]; of: Project } | null = null

function CheckPanel({ onCritical }: { onCritical: (n: number) => void }) {
  const project = useEditor((s) => s.project)
  // The timeline's own checks follow every edit; the rendered picture and sound are measured on demand.
  const timeline = useMemo(() => checkEdit(project), [project])
  const [measured, setMeasured] = useState(() => (lastMeasured?.of === project ? lastMeasured : null))
  const [fixed, setFixed] = useState<string[]>([])
  const [progress, setProgress] = useState<string | null>(null)
  const run = useRef<AbortController | null>(null)

  const measure = async () => {
    run.current?.abort()
    const ctl = new AbortController()
    run.current = ctl
    const p = getProject()
    const end = projectDuration(p)
    setMeasured(null)
    setFixed([])
    if (end <= 0) return
    try {
      setProgress('Listening to the mix…')
      const sound = await measureSound(p, 0, end / p.settings.fps, { signal: ctl.signal, onProgress: (x) => setProgress(`Listening to the mix… ${Math.round(x * 100)}%`) })
      setProgress('Watching the picture…')
      const frames = await measurePicture(p, sampleFrames(p), { signal: ctl.signal, onProgress: (x) => setProgress(`Watching the picture… ${Math.round(x * 100)}%`) })
      const boxes = await measureTextBoxes(p)
      const plain = new Set(checkEdit(p).map((i) => i.id))
      lastMeasured = { issues: checkEdit(p, { sound, frames, boxes }).filter((i) => !plain.has(i.id)), of: p }
      setMeasured(lastMeasured)
    } catch (err) {
      if (!(err instanceof AnalysisCancelled) && !ctl.signal.aborted) toast.error('Couldn’t check the picture and sound', { description: err instanceof Error ? err.message : String(err) })
    } finally {
      if (run.current === ctl) setProgress(null)
    }
  }

  useEffect(() => {
    if (!measured) void measure()
    return () => run.current?.abort()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const issues = useMemo(() => [...timeline, ...(measured?.issues ?? [])].filter((i) => !fixed.includes(i.id)).sort(worstFirst), [timeline, measured, fixed])
  const stale = Boolean(measured && measured.of !== project)
  const v = verdict(issues)
  useEffect(() => {
    onCritical(issues.filter((i) => i.severity === 'critical').length)
  }, [issues, onCritical])

  const go = (i: QualityIssue) => {
    playback.seek(i.frame)
    const ids = (i.clipIds ?? []).filter((id) => getProject().clips[id])
    if (ids.length) useUI.getState().select(ids)
  }

  const fix = (i: QualityIssue) => {
    if (!i.fix) return
    let failed: string | null = null
    useEditor.getState().transaction(i.fix.label, 'user', () => {
      for (const c of i.fix!.commands) {
        const res = dispatch(c.command, c.input as never)
        if (!res.ok) failed ??= res.error
      }
    })
    if (failed) toast.error('Couldn’t fix it all', { description: failed })
    setFixed((f) => [...f, i.id])
  }

  return (
    <div className="flex max-h-[min(600px,70vh)] flex-col">
      <div className="flex items-start gap-2 border-b border-line px-3.5 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-fg">Check edit</div>
          <div className={cn('text-2xs', v.finished ? 'text-fg-4' : 'text-danger/90')}>
            {progress ? 'The timeline is checked — now the picture and sound…' : v.text}
            {stale && !progress && ' The edit changed since the picture and sound were checked.'}
          </div>
        </div>
        <Tip content="Check again">
          <button
            type="button"
            aria-label="Check again"
            disabled={Boolean(progress)}
            onClick={() => void measure()}
            className="grid size-6 shrink-0 place-items-center rounded-md text-fg-3 transition-colors hover:bg-white/[0.08] hover:text-fg disabled:opacity-40"
          >
            <RotateCcw className="size-3.5" />
          </button>
        </Tip>
      </div>
      {progress && (
        <div className="flex items-center gap-2 border-b border-line px-3.5 py-2 text-2xs text-fg-3">
          <LoaderCircle className="size-3.5 animate-spin text-ai-2" />
          <span className="min-w-0 flex-1 truncate tabular">{progress}</span>
          <button type="button" onClick={() => run.current?.abort()} className="text-fg-4 transition-colors hover:text-fg-2">
            Stop
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
        {!issues.length && !progress && (
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <CircleCheck className="size-5 text-ok" />
            <p className="text-sm text-fg-3">No problems found.</p>
          </div>
        )}
        {issues.map((i) => (
          <div key={i.id} className="flex items-start gap-2 rounded-lg px-2 py-2 transition-colors hover:bg-white/[0.04]">
            <button type="button" onClick={() => go(i)} className="flex min-w-0 flex-1 items-start gap-2.5 text-left" title="Go there">
              <span className="mt-px">{ICON[i.severity]}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-xs leading-snug text-fg">{i.message}</span>
                <span className="mt-0.5 block text-2xs leading-relaxed text-fg-4">{i.suggestion}</span>
              </span>
              <span className="shrink-0 font-mono text-2xs text-fg-4 tabular">{clock(i.frame / project.settings.fps)}</span>
            </button>
            {i.fix && (
              <Button size="xs" variant="secondary" onClick={() => fix(i)}>
                {i.fix.label}
              </Button>
            )}
          </div>
        ))}
      </div>
      {!v.finished && <div className="border-t border-line bg-black/15 px-3.5 py-2 text-2xs text-fg-4">Critical issues mean the edit isn’t finished — fix them before exporting.</div>}
    </div>
  )
}
