import { ArrowLeftRight, Copy, Flag, Magnet, MousePointer2, MoveHorizontal, Scissors, SeparatorVertical, SquareSplitHorizontal, Trash, UnfoldHorizontal, X, ZoomIn, ZoomOut } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { AiSparkle } from '@/components/brand'
import { IconButton } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { useEditor } from '@/editor/store'
import { useUI, ZOOM_MAX, ZOOM_MIN } from '@/editor/ui-store'
import { formatDuration } from '@/lib/time'
import { suggestFor, type Suggestion } from '@/editor/smart'
import { useCopilot } from '@/features/copilot/store'
import { actions } from '@/features/shell/actions'
import { TimelineSwitcher } from './TimelineSwitcher'

export function TimelineToolbar() {
  const tool = useUI((s) => s.tool)
  const setTool = useUI((s) => s.setTool)
  const snapping = useUI((s) => s.snapping)
  const toggleSnapping = useUI((s) => s.toggleSnapping)
  const pps = useUI((s) => s.pxPerSecond)
  const setZoom = useUI((s) => s.setZoom)
  const hasSelection = useUI((s) => s.selection.length > 0)

  return (
    <div className="flex h-11 shrink-0 items-center gap-1 border-b border-line px-2">
      <TimelineSwitcher />
      <div className="mx-1 h-4 w-px bg-line-2" />
      <div className="flex items-center gap-0.5 rounded-[9px] bg-black/25 p-[3px] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.04)]">
        <IconButton size="xs" label="Select" shortcut="v" active={tool === 'select'} onClick={() => setTool('select')}>
          <MousePointer2 />
        </IconButton>
        <IconButton size="xs" label="Blade" shortcut="b" active={tool === 'blade'} onClick={() => setTool('blade')}>
          <Scissors />
        </IconButton>
        <IconButton size="xs" label="Roll — move a cut between two clips" shortcut="r" active={tool === 'roll'} onClick={() => setTool('roll')}>
          <SeparatorVertical />
        </IconButton>
        <IconButton size="xs" label="Slip — change the footage in place" shortcut="y" active={tool === 'slip'} onClick={() => setTool('slip')}>
          <ArrowLeftRight />
        </IconButton>
        <IconButton size="xs" label="Slide — move a clip between its neighbours" shortcut="u" active={tool === 'slide'} onClick={() => setTool('slide')}>
          <MoveHorizontal />
        </IconButton>
      </div>
      <div className="mx-1.5 h-4 w-px bg-line-2" />
      <IconButton label="Split at playhead" shortcut="s" onClick={actions.split}>
        <SquareSplitHorizontal />
      </IconButton>
      <IconButton label="Duplicate" shortcut="mod+d" disabled={!hasSelection} onClick={actions.duplicateSelection}>
        <Copy />
      </IconButton>
      <IconButton label="Delete" shortcut="delete" disabled={!hasSelection} onClick={() => actions.deleteSelection(false)}>
        <Trash />
      </IconButton>
      <div className="mx-1.5 h-4 w-px bg-line-2" />
      <IconButton label={snapping ? 'Snapping on' : 'Snapping off'} shortcut="n" active={snapping} onClick={toggleSnapping}>
        <Magnet />
      </IconButton>
      <IconButton label="Add marker" shortcut="m" onClick={actions.addMarker}>
        <Flag />
      </IconButton>

      <RangeChip />

      <div className="flex min-w-0 flex-1 justify-center px-3">
        <CopilotHint />
      </div>

      <IconButton label="Zoom out" shortcut="-" onClick={() => actions.zoom(1 / 1.35)}>
        <ZoomOut />
      </IconButton>
      <div className="w-28">
        <Slider
          aria-label="Timeline zoom"
          value={Math.log(pps)}
          min={Math.log(ZOOM_MIN)}
          max={Math.log(ZOOM_MAX)}
          step={0.01}
          onChange={(v) => setZoom(Math.exp(v))}
        />
      </div>
      <IconButton label="Zoom in" shortcut="=" onClick={() => actions.zoom(1.35)}>
        <ZoomIn />
      </IconButton>
      <IconButton label="Zoom to fit" shortcut="shift+z" onClick={actions.zoomToFit}>
        <UnfoldHorizontal />
      </IconButton>
    </div>
  )
}

/** The marked in / out stretch, with a way to clear it. */
function RangeChip() {
  const range = useEditor((s) => s.project.range)
  const fps = useEditor((s) => s.project.settings.fps)
  if (!range) return null
  return (
    <div className="ml-1 flex h-6 shrink-0 items-center gap-1 rounded-full bg-accent/10 pr-0.5 pl-2 text-2xs font-medium text-accent-2 shadow-[inset_0_0_0_1px_rgb(214_238_0/0.25)]">
      <button type="button" onClick={actions.goToIn} className="font-mono tabular hover:text-fg" title="In to out — click to go to the in point (Shift+I)">
        In–Out {formatDuration(range.out - range.in, fps)}
      </button>
      <button type="button" aria-label="Clear in and out" onClick={actions.clearInOut} className="grid size-5 place-items-center rounded-full text-accent-2/80 hover:bg-white/[0.08] hover:text-fg">
        <X className="size-3" />
      </button>
    </div>
  )
}

function CopilotHint() {
  const project = useEditor((s) => s.project)
  const busy = useCopilot((s) => s.busy)
  const [dismissed, setDismissed] = useState<string[]>([])
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null)
  const [running, setRunning] = useState(false)
  // Analysis reads real audio, so it runs a moment after edits settle.
  useEffect(() => {
    let alive = true
    const timer = setTimeout(() => {
      void suggestFor(project).then((s) => alive && setSuggestion(s))
    }, 800)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [project.clips, project.tracks, project.assets]) // eslint-disable-line react-hooks/exhaustive-deps
  const visible = suggestion && !dismissed.includes(suggestion.id) && !busy
  const act = async () => {
    if (!suggestion || running) return
    setRunning(true)
    try {
      toast.success(await suggestion.run())
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key={suggestion.id}
          initial={{ opacity: 0, y: 6, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -4, scale: 0.97 }}
          transition={{ type: 'spring', stiffness: 420, damping: 32 }}
          className="ring-ai flex h-7 min-w-0 items-center gap-2 rounded-full bg-white/[0.035] pr-1 pl-2.5 text-xs"
        >
          <AiSparkle className="size-3.5 shrink-0" />
          <span className="truncate text-fg-2">{suggestion.text}</span>
          <button
            type="button"
            disabled={running}
            onClick={() => void act()}
            className="shrink-0 rounded-full bg-white/[0.09] px-2.5 py-1 font-medium text-fg transition-colors hover:bg-white/[0.16]"
          >
            {suggestion.action}
          </button>
          <button
            type="button"
            aria-label="Dismiss suggestion"
            onClick={() => setDismissed((d) => [...d, suggestion.id])}
            className="grid size-5 shrink-0 place-items-center rounded-full text-fg-4 hover:bg-white/[0.08] hover:text-fg-2"
          >
            <X className="size-3" />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
