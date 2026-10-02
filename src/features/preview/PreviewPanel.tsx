import { Activity, Camera, Check, ChevronDown, Gauge, Grid3x3, Maximize2, MonitorPlay, Pause, Play, Repeat, SkipBack, SkipForward, StepBack, StepForward, Video } from 'lucide-react'
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { toast } from 'sonner'
import { desktop } from '@/lib/platform'
import { importMediaFiles } from '@/project/media-import'
import { IconButton } from '@/components/ui/button'
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '@/components/ui/menu'
import { Tip } from '@/components/ui/tooltip'
import { projectDuration } from '@/editor/ops'
import { onPlayhead, playback, usePlayback } from '@/editor/playback'
import { getProject, useEditor } from '@/editor/store'
import { PREVIEW_RES, useUI } from '@/editor/ui-store'
import { audioEngine } from '@/engine/audio-engine'
import { onMeterFrame } from '@/engine/meter-clock'
import { useAutoRes } from '@/engine/preview-res'
import { timelineStills } from '@/engine/stills'
import { meterPos } from '@/features/mixer/scales'
import { MARKER_COLORS } from '@/features/timeline/Ruler'
import { actions } from '@/features/shell/actions'
import { cn } from '@/lib/cn'
import { clamp } from '@/lib/math'
import { formatTimecode } from '@/lib/time'
import { AngleViewer } from './AngleViewer'
import { PreviewStage } from './PreviewStage'
import { Scopes } from './Scopes'

const RES_SHORT: Record<string, string> = { '1': 'Full', '0.5': '½', '0.25': '¼', '0.125': '⅛' }

/** Preview resolution while playing (Auto adapts to this computer) and while paused. */
function ResolutionMenu() {
  const playbackRes = useUI((s) => s.playbackRes)
  const pausedRes = useUI((s) => s.pausedRes)
  const auto = useAutoRes((s) => s.level)
  const label = playbackRes === 'auto' ? `Auto${auto < 1 ? ` · ${RES_SHORT[String(auto)]}` : ''}` : RES_SHORT[String(playbackRes)]
  return (
    <Menu>
      <Tip content="Preview resolution — lower plays heavy timelines smoothly">
        <MenuTrigger asChild>
          <button
            type="button"
            className="mr-1 flex h-7 items-center gap-1.5 rounded-lg bg-white/[0.045] px-2 text-xs font-medium text-fg-2 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)] outline-none transition-colors hover:bg-white/[0.08] hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/60 data-[state=open]:bg-white/[0.08]"
          >
            <MonitorPlay className="size-3.5 text-fg-3" />
            <span className="tabular">{label}</span>
            <ChevronDown className="size-3 text-fg-4" />
          </button>
        </MenuTrigger>
      </Tip>
      <MenuContent align="end" className="w-72">
        <MenuLabel>While playing</MenuLabel>
        {PREVIEW_RES.map((r) => (
          <MenuItem key={String(r.value)} icon={playbackRes === r.value ? <Check /> : <span className="size-4" />} onSelect={() => useUI.getState().setPlaybackRes(r.value)}>
            <span className="flex flex-col py-0.5 leading-tight">
              <span>{r.label}</span>
              <span className="text-2xs text-fg-4">{r.hint}</span>
            </span>
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuLabel>While paused</MenuLabel>
        {PREVIEW_RES.filter((r) => r.value !== 'auto').map((r) => (
          <MenuItem key={String(r.value)} icon={pausedRes === r.value ? <Check /> : <span className="size-4" />} onSelect={() => useUI.getState().setPausedRes(r.value as 1)}>
            {r.label}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  )
}

export function PreviewPanel() {
  const panelRef = useRef<HTMLDivElement>(null)
  const [scopes, setScopes] = useState(false)
  const hasProxies = useEditor((s) => Object.values(s.project.assets).some((a) => a.proxy))
  const useProxies = useUI((s) => s.useProxies)
  const settings = useEditor((s) => s.project.settings)
  const showGuides = useUI((s) => s.showGuides)
  const setShowGuides = useUI((s) => s.setShowGuides)
  const angleViewer = useUI((s) => s.angleViewer)
  const hasMulticam = useEditor((s) => Object.values(s.project.clips).some((c) => c.sequenceId && s.project.sequences?.[c.sequenceId]?.multicam))

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
          <ResolutionMenu />
          {hasProxies && (
            <IconButton label={useProxies ? 'Playing proxies — click for the originals' : 'Playing originals — click for the proxies'} active={useProxies} onClick={() => useUI.getState().setUseProxies(!useProxies)}>
              <Gauge />
            </IconButton>
          )}
          {hasMulticam && (
            <IconButton label="Camera angles" active={angleViewer} onClick={() => useUI.getState().setAngleViewer(!angleViewer)}>
              <Video />
            </IconButton>
          )}
          <IconButton label="Scopes" active={scopes} onClick={() => setScopes(!scopes)}>
            <Activity />
          </IconButton>
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
      <div className="flex min-h-0 flex-1">
        <PreviewStage />
        {scopes && <Scopes />}
      </div>
      <AngleViewer />
      <Transport />
    </div>
  )
}

/** The playhead's timecode, written straight to the DOM as it moves (no re-render per frame). */
function LiveTimecode({ fps, className }: { fps: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(
    () =>
      onPlayhead((f) => {
        if (ref.current) ref.current.textContent = formatTimecode(f, fps)
      }),
    [fps],
  )
  return <span ref={ref} className={className} />
}

function Transport() {
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
          <LiveTimecode fps={fps} className="text-[13px] font-medium text-fg" />
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
          <MasterMeter />
          <IconButton label={loop ? 'Loop on' : 'Loop off'} active={loop} onClick={() => playback.toggleLoop()}>
            <Repeat />
          </IconButton>
        </div>
      </div>
    </div>
  )
}

/** A slim stereo meter of the master output; click it to open the mixer. */
function MasterMeter() {
  const left = useRef<HTMLSpanElement>(null)
  const right = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const bars = [left, right]
    const shown = [-60, -60]
    // The shared meter clock only runs while sound plays — an idle editor doesn't redraw 120 times a second.
    return onMeterFrame((_now, dt) => {
      const lv = audioEngine.levels('master') ?? [-Infinity, -Infinity]
      for (let i = 0; i < 2; i++) {
        shown[i] = Math.max(Number.isFinite(lv[i]) ? lv[i] : -60, shown[i] - 24 * dt)
        const el = bars[i].current
        if (el) el.style.clipPath = `inset(0 ${((1 - meterPos(shown[i])) * 100).toFixed(2)}% 0 0)`
      }
    })
  }, [])
  return (
    <Tip content="Master level — open the mixer">
      <button type="button" aria-label="Open the mixer" onClick={() => useUI.getState().setRightTab('mixer')} className="mr-1 flex w-16 flex-col gap-[3px] rounded-md px-1 py-1.5 outline-none hover:bg-white/[0.05] focus-visible:ring-2 focus-visible:ring-accent/60">
        {[left, right].map((ref, i) => (
          <span key={i} className="relative h-[4px] w-full overflow-hidden rounded-full bg-white/[0.07]">
            <span ref={ref} className="absolute inset-0 bg-[linear-gradient(to_right,#2fcf7e_0%,#2fcf7e_62%,#e6e238_76%,#f5a524_88%,#ef4444_96%)]" style={{ clipPath: 'inset(0 100% 0 0)' }} />
          </span>
        ))}
      </button>
    </Tip>
  )
}

function ScrubBar() {
  const fps = useEditor((s) => s.project.settings.fps)
  const duration = useEditor((s) => Math.max(1, projectDuration(s.project)))
  const markers = useEditor((s) => s.project.markers)
  const [hover, setHover] = useState<number | null>(null)
  const fill = useRef<HTMLDivElement>(null)
  const knob = useRef<HTMLSpanElement>(null)
  // Follows the playhead by writing to the DOM: no re-render on every playback frame.
  useEffect(
    () =>
      onPlayhead((f) => {
        const pct = `${clamp(f / duration, 0, 1) * 100}%`
        if (fill.current) fill.current.style.width = pct
        if (knob.current) knob.current.style.left = pct
      }),
    [duration],
  )

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
        <div ref={fill} className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-accent to-ai-2" />
      </div>
      {markers.map((m) => (
        <span key={m.id} className="pointer-events-none absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-surface" style={{ left: `${(m.frame / duration) * 100}%`, background: MARKER_COLORS[m.color] }} />
      ))}
      <span
        ref={knob}
        className={cn('pointer-events-none absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_1px_4px_rgb(0_0_0/0.5)] transition-transform duration-150', 'scale-0 group-hover/scrub:scale-100')}
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
