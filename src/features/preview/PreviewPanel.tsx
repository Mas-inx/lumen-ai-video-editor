import { Camera, Grid3x3, Maximize2, Pause, Play, Repeat, SkipBack, SkipForward, StepBack, StepForward } from 'lucide-react'
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { toast } from 'sonner'
import { desktop } from '@/lib/platform'
import { importMediaFiles } from '@/project/media-import'
import { IconButton } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { Tip } from '@/components/ui/tooltip'
import { projectDuration } from '@/editor/ops'
import { playback, usePlayback } from '@/editor/playback'
import { getProject, useEditor } from '@/editor/store'
import { useUI } from '@/editor/ui-store'
import { timelineStills } from '@/engine/stills'
import { MARKER_COLORS } from '@/features/timeline/Ruler'
import { actions } from '@/features/shell/actions'
import { cn } from '@/lib/cn'
import { clamp } from '@/lib/math'
import { formatTimecode } from '@/lib/time'
import { PreviewStage } from './PreviewStage'

export function PreviewPanel() {
  const panelRef = useRef<HTMLDivElement>(null)
  const [quality, setQuality] = useState<'full' | 'half'>('full')
  const settings = useEditor((s) => s.project.settings)
  const showGuides = useUI((s) => s.showGuides)
  const setShowGuides = useUI((s) => s.setShowGuides)

  /** Saves the current frame (full resolution, frame-exact) into the media library as a still. */
  const snapshot = async () => {
    const project = getProject()
    const frame = usePlayback.getState().frame
    let canvas: HTMLCanvasElement
    try {
      ;[canvas] = await timelineStills(project, [frame], project.settings.width)
    } catch (err) {
      toast.error('Couldn’t capture the frame', { description: err instanceof Error ? err.message : String(err) })
      return
    }
    canvas.toBlob(async (blob) => {
      if (!blob || !desktop) return
      const name = `${project.name} ${formatTimecode(frame, project.settings.fps).replace(/:/g, '-')}.png`
      try {
        const file = await desktop.files.saveMedia('snapshots', name, new Uint8Array(await blob.arrayBuffer()))
        await importMediaFiles([file])
        toast.success('Frame saved to Media', { description: name, action: { label: 'Show', onClick: () => void desktop!.files.reveal(file.path) } })
      } catch (err) {
        toast.error('Couldn’t save the frame', { description: err instanceof Error ? err.message : String(err) })
      }
    }, 'image/png')
  }

  return (
    <div ref={panelRef} className="panel flex h-full flex-col overflow-hidden">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line pr-2 pl-4">
        <span className="text-sm font-semibold text-fg">Program</span>
        <button
          type="button"
          onClick={() => {
            useUI.getState().clearSelection()
            useUI.getState().setRightTab('inspector')
          }}
          className="rounded-md bg-white/[0.05] px-1.5 py-0.5 font-mono text-2xs text-fg-3 tabular transition-colors hover:bg-white/[0.08] hover:text-fg-2"
        >
          {settings.width}×{settings.height} · {settings.fps} fps
        </button>
        <div className="ml-auto flex items-center gap-0.5">
          <Select
            aria-label="Preview quality"
            value={quality}
            onChange={setQuality}
            className="mr-1 w-[76px]"
            options={[
              { value: 'full', label: 'Full' },
              { value: 'half', label: 'Half' },
            ]}
          />
          <IconButton label="Safe-area guides" shortcut="g" active={showGuides} onClick={() => setShowGuides(!showGuides)}>
            <Grid3x3 />
          </IconButton>
          <IconButton label="Save this frame to Media" onClick={snapshot}>
            <Camera />
          </IconButton>
          <IconButton label="Full screen" onClick={() => void panelRef.current?.requestFullscreen()}>
            <Maximize2 />
          </IconButton>
        </div>
      </div>
      <PreviewStage q={quality} />
      <Transport />
    </div>
  )
}

function Transport() {
  const frame = usePlayback((s) => s.frame)
  const playing = usePlayback((s) => s.playing)
  const rate = usePlayback((s) => s.rate)
  const loop = usePlayback((s) => s.loop)
  const fps = useEditor((s) => s.project.settings.fps)
  const duration = useEditor((s) => projectDuration(s.project))

  return (
    <div className="shrink-0 px-4 pt-1 pb-3">
      <ScrubBar />
      <div className="mt-2 grid grid-cols-[1fr_auto_1fr] items-center">
        <div className="flex items-baseline gap-1.5 font-mono tabular">
          <span className="text-[13px] font-medium text-fg">{formatTimecode(frame, fps)}</span>
          <span className="text-xs text-fg-4">/ {formatTimecode(duration, fps)}</span>
        </div>
        <div className="flex items-center gap-1">
          <IconButton label="Go to start" shortcut="home" onClick={actions.goToStart}>
            <SkipBack />
          </IconButton>
          <IconButton label="Previous frame" shortcut="left" onClick={() => playback.step(-1)}>
            <StepBack />
          </IconButton>
          <Tip content={playing ? 'Pause' : 'Play'} shortcut="space">
            <button
              type="button"
              aria-label={playing ? 'Pause' : 'Play'}
              onClick={() => playback.toggle()}
              className="relative mx-1.5 grid size-10 place-items-center rounded-full bg-white text-black shadow-[0_4px_18px_-4px_rgb(255_255_255/0.45),inset_0_-2px_0_rgb(0_0_0/0.12)] outline-none transition-transform duration-150 hover:scale-105 active:scale-95 focus-visible:ring-2 focus-visible:ring-accent/70"
            >
              {playing ? <Pause className="size-4" fill="currentColor" /> : <Play className="ml-0.5 size-4" fill="currentColor" />}
              {playing && rate !== 1 && (
                <span className="absolute -top-1.5 -right-2 rounded-full bg-accent px-1.5 py-px text-[9px] font-bold text-accent-fg tabular">{rate}×</span>
              )}
            </button>
          </Tip>
          <IconButton label="Next frame" shortcut="right" onClick={() => playback.step(1)}>
            <StepForward />
          </IconButton>
          <IconButton label="Go to end" shortcut="end" onClick={actions.goToEnd}>
            <SkipForward />
          </IconButton>
        </div>
        <div className="flex items-center justify-end gap-1">
          <IconButton label={loop ? 'Loop on' : 'Loop off'} active={loop} onClick={() => playback.toggleLoop()}>
            <Repeat />
          </IconButton>
        </div>
      </div>
    </div>
  )
}

function ScrubBar() {
  const frame = usePlayback((s) => s.frame)
  const fps = useEditor((s) => s.project.settings.fps)
  const duration = useEditor((s) => Math.max(1, projectDuration(s.project)))
  const markers = useEditor((s) => s.project.markers)
  const [hover, setHover] = useState<number | null>(null)
  const pct = clamp(frame / duration, 0, 1) * 100

  const frameAt = (e: ReactPointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return Math.round(clamp((e.clientX - r.left) / r.width, 0, 1) * duration)
  }

  return (
    <div
      className="group/scrub relative flex h-4 cursor-pointer items-center"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        playback.pause()
        playback.seek(frameAt(e))
      }}
      onPointerMove={(e) => {
        const f = frameAt(e)
        setHover(f)
        if (e.buttons === 1) playback.seek(f)
      }}
      onPointerLeave={() => setHover(null)}
    >
      <div className="relative h-[3px] w-full overflow-hidden rounded-full bg-white/[0.08] transition-[height] duration-150 group-hover/scrub:h-[5px]">
        <div className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-accent to-ai-2" style={{ width: `${pct}%` }} />
      </div>
      {markers.map((m) => (
        <span key={m.id} className="pointer-events-none absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-surface" style={{ left: `${(m.frame / duration) * 100}%`, background: MARKER_COLORS[m.color] }} />
      ))}
      <span
        className={cn('pointer-events-none absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_1px_4px_rgb(0_0_0/0.5)] transition-transform duration-150', 'scale-0 group-hover/scrub:scale-100')}
        style={{ left: `${pct}%` }}
      />
      {hover !== null && (
        <span
          className="popover pointer-events-none absolute -top-7 -translate-x-1/2 rounded-md px-1.5 py-0.5 font-mono text-2xs text-fg tabular"
          style={{ left: `${(hover / duration) * 100}%` }}
        >
          {formatTimecode(hover, fps)}
        </span>
      )}
    </div>
  )
}
