import { CopyPlus, FolderOpen, Layers, PencilLine, Plus, Trash, Video } from 'lucide-react'
import { useMemo, type DragEvent } from 'react'
import { toast } from 'sonner'
import { ContextContent, ContextItem, ContextRoot, ContextSeparator, ContextTrigger } from '@/components/ui/menu'
import { placeSequence } from '@/editor/placement'
import { usePlayback } from '@/editor/playback'
import { allSequences, clipsLength, openSequenceId, usesOf, wouldLoop } from '@/editor/sequences'
import { dispatch, getProject, useEditor } from '@/editor/store'
import { openTimeline } from '@/editor/timeline-nav'
import type { Sequence } from '@/editor/types'
import { useUI } from '@/editor/ui-store'
import { dnd } from '@/features/dnd'
import { cn } from '@/lib/cn'
import { formatDuration } from '@/lib/time'
import { SectionLabel } from './shared'

/** The project's timelines: open one, or drag it onto the timeline to nest it. */
export function TimelinesSection({ query }: { query: string }) {
  const project = useEditor((s) => s.project)
  const sequences = useMemo(() => allSequences(project), [project])
  if (sequences.length < 2) return null
  const openId = openSequenceId(project)
  const visible = sequences.filter((s) => !query || s.name.toLowerCase().includes(query.toLowerCase()))
  if (!visible.length) return null
  return (
    <>
      <SectionLabel>Timelines</SectionLabel>
      <div className="mb-1 space-y-1">
        {visible.map((s) => (
          <TimelineRow key={s.id} seq={s} open={s.id === openId} />
        ))}
      </div>
    </>
  )
}

function TimelineRow({ seq, open }: { seq: Sequence; open: boolean }) {
  const add = () => {
    const id = placeSequence(seq.id, usePlayback.getState().frame)
    if (id) useUI.getState().select([id])
  }
  const nestable = !open && !wouldLoop(getProject(), openSequenceId(getProject()), seq.id)
  const onDragStart = (e: DragEvent) => {
    if (!nestable) {
      e.preventDefault()
      return
    }
    dnd.start(e, { type: 'sequence', sequenceId: seq.id }, seq.name)
  }
  const remove = () => {
    const uses = usesOf(getProject(), seq.id)
    if (uses.length) return void toast(`“${seq.name}” is nested in ${uses.map((u) => `“${u.name}”`).join(', ')}`, { description: 'Remove it there first.' })
    const res = dispatch('sequence.delete', { id: seq.id })
    if (!res.ok) toast(res.error)
  }
  const Icon = seq.multicam ? Video : Layers
  return (
    <ContextRoot>
      <ContextTrigger asChild>
        <div
          draggable={nestable}
          onDragStart={onDragStart}
          onDragEnd={dnd.end}
          onDoubleClick={() => openTimeline(seq.id)}
          className={cn('group/tl flex h-11 items-center gap-2.5 rounded-[10px] px-1.5 transition-colors hover:bg-white/[0.04]', nestable ? 'cursor-grab active:cursor-grabbing' : 'cursor-default')}
          title={open ? 'The timeline you’re editing' : 'Double-click to open — drag onto the timeline to nest it'}
        >
          <span className={cn('grid size-8 shrink-0 place-items-center rounded-lg', open ? 'bg-accent/15 text-accent-2' : 'bg-clip-nest/15 text-clip-nest')}>
            <Icon className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-xs font-medium text-fg-2 group-hover/tl:text-fg">{seq.name}</span>
              {open && <span className="shrink-0 rounded bg-accent/15 px-1 text-[9px] font-bold text-accent-2">OPEN</span>}
              {seq.multicam && <span className="shrink-0 rounded bg-white/[0.07] px-1 text-[9px] font-bold text-fg-3">MULTICAM</span>}
            </div>
            <div className="text-2xs text-fg-4 tabular">
              {seq.settings.width}×{seq.settings.height} · {seq.settings.fps} fps · {formatDuration(clipsLength(seq.clips), seq.settings.fps)}
            </div>
          </div>
          {nestable && (
            <button
              type="button"
              aria-label={`Add ${seq.name} at the playhead`}
              onClick={add}
              className="grid size-6 shrink-0 place-items-center rounded-full text-fg-3 opacity-0 transition-opacity group-hover/tl:opacity-100 hover:bg-white/[0.1] hover:text-fg"
            >
              <Plus className="size-3.5" />
            </button>
          )}
        </div>
      </ContextTrigger>
      <ContextContent>
        {!open && (
          <ContextItem icon={<FolderOpen />} onSelect={() => openTimeline(seq.id)}>
            Open
          </ContextItem>
        )}
        {nestable && (
          <ContextItem icon={<Plus />} onSelect={add}>
            Add at playhead (nested)
          </ContextItem>
        )}
        <ContextItem icon={<PencilLine />} onSelect={() => useUI.getState().setRenamingTimeline(seq.id)}>
          Rename…
        </ContextItem>
        <ContextItem icon={<CopyPlus />} onSelect={() => dispatch('sequence.duplicate', { id: seq.id })}>
          Duplicate
        </ContextItem>
        {!open && (
          <>
            <ContextSeparator />
            <ContextItem icon={<Trash />} danger onSelect={remove}>
              Delete timeline
            </ContextItem>
          </>
        )}
      </ContextContent>
    </ContextRoot>
  )
}
