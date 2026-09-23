import { Film, AudioLines, Plus } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { toast } from 'sonner'
import { ContextMenu } from 'radix-ui'
import { ContextContent, ContextItem, ContextSeparator, ContextSub } from '@/components/ui/menu'
import { AiSparkle } from '@/components/brand'
import { clipEnd, findFreeStart, isMagneticTrack, magneticLayout, projectDuration, trackAccepts } from '@/editor/ops'
import { applyEffect, applyLook, applyTransition, assetFrames, placeAsset, placeTitle } from '@/editor/placement'
import { usePlayback } from '@/editor/playback'
import { TITLE_PRESETS } from '@/editor/presets'
import { dispatch, getProject, useEditor } from '@/editor/store'
import type { ClipKind } from '@/editor/types'
import { useUI, ZOOM_MAX, ZOOM_MIN } from '@/editor/ui-store'
import { SFX } from '@/engine/sfx'
import { sfxAsset } from '@/project/audio-library'
import { askCopilotAbout } from '@/features/copilot/store'
import { dnd } from '@/features/dnd'
import { actions } from '@/features/shell/actions'
import { useElementSize } from '@/lib/hooks'
import { clamp } from '@/lib/math'
import { computeRows, LayoutContext, type TimelineLayout } from './layout'
import { ADD_ROW_H, HEADER_W, RULER_H, useDrag, type ClipPreview, type DropGhost } from './model'
import { Ruler, TimecodeCell } from './Ruler'
import { TimelineToolbar } from './TimelineToolbar'
import { TrackHeader } from './TrackHeader'
import { TrackLane } from './TrackLane'
import { usePointerController } from './usePointerController'

const SCISSORS_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><path d="M8.12 8.12 12 12"/><path d="M20 4 8.12 15.88"/><circle cx="6" cy="18" r="3"/><path d="M14.8 14.8 20 20"/></svg>',
)}") 11 11, crosshair`

export function Timeline() {
  const tracks = useEditor((s) => s.project.tracks)
  const fps = useEditor((s) => s.project.settings.fps)
  const duration = useEditor((s) => projectDuration(s.project))
  const pps = useUI((s) => s.pxPerSecond)
  const tool = useUI((s) => s.tool)
  const fitRequest = useUI((s) => s.fitRequest)

  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const { width: viewW } = useElementSize(scrollRef)
  const [scrollLeft, setScrollLeft] = useState(0)
  const laneViewport = Math.max(0, viewW - HEADER_W)
  const contentW = Math.max(laneViewport, (duration / fps + 30) * pps)

  const rows = useMemo(() => computeRows(tracks), [tracks])
  const layout = useMemo<TimelineLayout>(() => ({ pps, fps, tracks, rowTop: rows.rowTop, rowHeight: rows.rowHeight }), [pps, fps, tracks, rows])
  const layoutRef = useRef(layout)
  useLayoutEffect(() => {
    layoutRef.current = layout
  }, [layout])

  const pointer = usePointerController({ scrollRef, contentRef, layoutRef })

  // ── Scroll & zoom ─────────────────────────────────────────────────────
  const anchor = useRef<{ sec: number; px: number } | null>(null)
  const prevPps = useRef(pps)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let raf = 0
    const onScroll = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        setScrollLeft(el.scrollLeft)
      })
    }
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const px = Math.max(0, e.clientX - rect.left - HEADER_W)
      const { pxPerSecond, setZoom } = useUI.getState()
      anchor.current = { sec: (el.scrollLeft + px) / pxPerSecond, px }
      setZoom(clamp(pxPerSecond * Math.exp(-e.deltaY * 0.0025), ZOOM_MIN, ZOOM_MAX))
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('wheel', onWheel)
      cancelAnimationFrame(raf)
    }
  }, [])

  // Keep the zoom anchored (pointer for wheel, otherwise the playhead).
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || prevPps.current === pps) return
    if (anchor.current) {
      el.scrollLeft = anchor.current.sec * pps - anchor.current.px
      anchor.current = null
    } else {
      const sec = usePlayback.getState().frame / fps
      const onScreen = sec * prevPps.current - el.scrollLeft
      el.scrollLeft = sec * pps - clamp(onScreen, 0, laneViewport)
    }
    prevPps.current = pps
  }, [pps, fps, laneViewport])

  // Zoom to fit on first layout and on request.
  const fitted = useRef(-1)
  useEffect(() => {
    if (laneViewport < 120 || fitted.current === fitRequest) return
    fitted.current = fitRequest
    const seconds = Math.max(1, projectDuration(getProject()) / fps)
    useUI.getState().setZoom((laneViewport - 56) / seconds)
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ left: 0, behavior: 'smooth' }))
  }, [fitRequest, laneViewport, fps])

  // The blade guide only makes sense while the blade tool is active.
  useEffect(() => {
    if (tool !== 'blade') useDrag.setState({ bladeFrame: null })
  }, [tool])

  // Follow the playhead during playback.
  useEffect(
    () =>
      usePlayback.subscribe((s, prev) => {
        const el = scrollRef.current
        if (!el || !s.playing || s.frame === prev.frame) return
        const x = (s.frame / fps) * useUI.getState().pxPerSecond
        const view = el.clientWidth - HEADER_W
        if (x > el.scrollLeft + view - 24 || x < el.scrollLeft) el.scrollLeft = x - 48
      }),
    [fps],
  )

  // ── Drag & drop from the asset browser / desktop ───────────────────────
  const hitTest = (e: DragEvent) => {
    const p = pointer.toContent(e.clientX, e.clientY)
    const row = pointer.rowAt(p.y)
    const clipEl = (e.target as HTMLElement).closest<HTMLElement>('[data-clip-id]')
    return { frame: pointer.frameAtX(p.x), track: row >= 0 ? tracks[row] : undefined, clipId: clipEl?.dataset.clipId }
  }

  const ghostFor = (e: DragEvent): DropGhost | null => {
    const payload = dnd.get()
    if (!payload) return null
    const project = getProject()
    const { frame, track } = hitTest(e)
    let kind: ClipKind
    let length: number
    let label: string
    if (payload.type === 'asset') {
      const asset = project.assets[payload.assetId]
      if (!asset) return null
      kind = asset.kind
      length = assetFrames(project, asset)
      label = asset.name
    } else if (payload.type === 'title') {
      const preset = TITLE_PRESETS.find((p) => p.id === payload.presetId) ?? TITLE_PRESETS[0]
      kind = 'text'
      length = Math.round(preset.duration * fps)
      label = preset.name
    } else if (payload.type === 'sfx') {
      const item = SFX.find((i) => i.id === payload.sfxId)
      if (!item) return null
      kind = 'audio'
      length = Math.round(item.duration * fps)
      label = item.name
    } else return null
    const trackId = track && !track.locked && trackAccepts(track, kind) ? track.id : null
    if (trackId && isMagneticTrack(project, trackId)) {
      const { insertAt } = magneticLayout(project, trackId, [{ id: '__drop__', duration: length }], frame)
      return { trackId, start: insertAt, duration: length, label, kind }
    }
    const start = trackId ? findFreeStart(project, trackId, frame, length) : frame
    return { trackId, start, duration: length, label, kind }
  }

  /** On the magnetic track, neighbours slide apart to make room for what's being dropped. */
  const makeRoom = (ghost: DropGhost | null, frame: number) => {
    const project = getProject()
    if (!ghost?.trackId || !isMagneticTrack(project, ghost.trackId)) return {}
    const { starts } = magneticLayout(project, ghost.trackId, [{ id: '__drop__', duration: ghost.duration }], frame)
    const previews: Record<string, ClipPreview> = {}
    for (const [id, start] of Object.entries(starts)) {
      const c = project.clips[id]
      if (c && start !== c.start) previews[id] = { start, duration: c.duration, trackId: c.trackId, inPoint: c.inPoint }
    }
    return previews
  }

  const onDragOver = (e: DragEvent) => {
    const payload = dnd.get()
    const files = e.dataTransfer.types.includes('Files')
    if (!payload && !files) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    if (payload && (payload.type === 'effect' || payload.type === 'look' || payload.type === 'transition')) {
      const { clipId } = hitTest(e)
      const clip = clipId ? getProject().clips[clipId] : undefined
      const ok = clip && clip.kind !== 'audio' && (payload.type !== 'look' || clip.kind !== 'text')
      useDrag.setState({ dropTargetClip: ok ? clipId! : null, dropGhost: null })
      return
    }
    const ghost = ghostFor(e)
    useDrag.setState({ dropGhost: ghost, dropTargetClip: null, previews: makeRoom(ghost, hitTest(e).frame) })
  }

  const clearDrop = () => useDrag.setState({ dropGhost: null, dropTargetClip: null, previews: {} })

  const onDrop = async (e: DragEvent) => {
    e.preventDefault()
    const payload = dnd.get()
    const { frame, clipId } = hitTest(e)
    const ghost = useDrag.getState().dropGhost
    clearDrop()
    dnd.end()

    if (!payload && e.dataTransfer.files.length) {
      const assets = await actions.importFileList([...e.dataTransfer.files])
      let at = frame
      for (const a of assets) {
        const id = placeAsset(a.id, at)
        if (id) at = clipEnd(getProject().clips[id])
      }
      return
    }
    if (!payload) return
    const select = (id: string | null) => id && useUI.getState().select([id])
    switch (payload.type) {
      case 'asset':
        select(placeAsset(payload.assetId, ghost?.start ?? frame, { trackId: ghost?.trackId ?? undefined }))
        break
      case 'title':
        select(placeTitle(payload.presetId, ghost?.start ?? frame, { trackId: ghost?.trackId ?? undefined }))
        break
      case 'sfx': {
        try {
          const assetId = await sfxAsset(payload.sfxId)
          select(placeAsset(assetId, ghost?.start ?? frame, { trackId: ghost?.trackId ?? undefined }))
        } catch (err) {
          toast.error('Couldn’t add the sound', { description: err instanceof Error ? err.message : String(err) })
        }
        break
      }
      case 'effect':
        if (clipId) applyEffect(payload.kind, [clipId])
        break
      case 'look':
        if (clipId) applyLook(payload.lookId, [clipId])
        break
      case 'transition':
        if (clipId) applyTransition(payload.kind, clipId)
        break
    }
  }

  // ── Context menu ─────────────────────────────────────────────────────
  const [menu, setMenu] = useState<{ clipId: string | null; frame: number }>({ clipId: null, frame: 0 })
  const onContextMenu = (e: ReactMouseEvent) => {
    const clipEl = (e.target as HTMLElement).closest<HTMLElement>('[data-clip-id]')
    const clipId = clipEl?.dataset.clipId ?? null
    const frame = pointer.frameAtX(pointer.toContent(e.clientX, e.clientY).x)
    if (clipId && !useUI.getState().selection.includes(clipId)) useUI.getState().select([clipId])
    setMenu({ clipId, frame })
  }

  const endX = HEADER_W + (duration / fps) * pps

  return (
    <LayoutContext.Provider value={layout}>
      <div className="panel flex h-full flex-col overflow-hidden">
        <TimelineToolbar />
        <ContextMenu.Root>
          <ContextMenu.Trigger asChild>
            <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-auto overscroll-contain">
              <div
                ref={contentRef}
                className="relative flex min-h-full flex-col"
                style={{ width: HEADER_W + contentW, cursor: tool === 'blade' ? SCISSORS_CURSOR : undefined }}
                onPointerDown={pointer.onPointerDown}
                onPointerMove={pointer.onPointerMove}
                onPointerLeave={pointer.onPointerLeave}
                onContextMenu={onContextMenu}
                onDragOver={onDragOver}
                onDragLeave={(e) => {
                  if (!contentRef.current?.contains(e.relatedTarget as Node)) clearDrop()
                }}
                onDrop={onDrop}
              >
                <div className="sticky top-0 z-40 flex shrink-0" style={{ height: RULER_H }}>
                  <TimecodeCell />
                  <Ruler width={contentW} laneViewport={laneViewport} scrollLeft={scrollLeft} />
                </div>

                {tracks.map((t) => (
                  <div key={t.id} className="flex shrink-0" style={{ height: t.height }}>
                    <TrackHeader track={t} />
                    <TrackLane track={t} width={contentW} />
                  </div>
                ))}

                <div className="flex shrink-0" style={{ height: ADD_ROW_H }}>
                  <div className="sticky left-0 z-30 flex shrink-0 items-center gap-1 border-r border-line bg-surface px-2" style={{ width: HEADER_W }}>
                    <AddTrackButton kind="video" />
                    <AddTrackButton kind="audio" />
                  </div>
                  <div data-lane-filler className="relative flex-1" />
                </div>
                <div className="flex flex-1">
                  <div className="sticky left-0 z-30 shrink-0 border-r border-line bg-surface" style={{ width: HEADER_W }} />
                  <div data-lane-filler className="flex-1" />
                </div>

                {/* Past-the-end shading */}
                <div className="pointer-events-none absolute bottom-0 z-[1] bg-black/[0.18]" style={{ left: endX, right: 0, top: RULER_H }} />
                <Overlays />
              </div>
            </div>
          </ContextMenu.Trigger>
          <TimelineMenu clipId={menu.clipId} frame={menu.frame} />
        </ContextMenu.Root>
      </div>
    </LayoutContext.Provider>
  )
}

function AddTrackButton({ kind }: { kind: 'video' | 'audio' }) {
  return (
    <button
      type="button"
      onClick={() => dispatch('track.add', { kind })}
      className="flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md text-xs font-medium text-fg-4 outline-none transition-colors hover:bg-white/[0.05] hover:text-fg-2 focus-visible:ring-2 focus-visible:ring-accent/60"
    >
      <Plus className="size-3" />
      {kind === 'video' ? <Film className="size-3" /> : <AudioLines className="size-3" />}
      {kind === 'video' ? 'Video' : 'Audio'}
    </button>
  )
}

function Overlays() {
  const pps = useUI((s) => s.pxPerSecond)
  const fps = useEditor((s) => s.project.settings.fps)
  const frame = usePlayback((s) => s.frame)
  const snapFrame = useDrag((s) => s.snapFrame)
  const bladeFrame = useDrag((s) => s.bladeFrame)
  const marquee = useDrag((s) => s.marquee)
  const readout = useDrag((s) => s.readout)
  const x = (f: number) => HEADER_W + (f / fps) * pps

  return (
    <>
      {/* Playhead */}
      <div className="pointer-events-none absolute bottom-0 z-20 w-[1.5px] -translate-x-1/2 bg-white shadow-[0_0_10px_rgb(255_255_255/0.45)]" style={{ left: x(frame), top: RULER_H }} />
      {snapFrame !== null && (
        <div className="pointer-events-none absolute top-0 bottom-0 z-[22] w-px -translate-x-1/2 bg-snap shadow-[0_0_8px_var(--color-snap)]" style={{ left: x(snapFrame) }}>
          <span className="absolute top-[7px] left-1/2 size-2 -translate-x-1/2 rotate-45 bg-snap" />
        </div>
      )}
      {bladeFrame !== null && (
        <div className="pointer-events-none absolute bottom-0 z-[22] w-0 -translate-x-1/2 border-l border-dashed border-white/80" style={{ left: x(bladeFrame), top: RULER_H }} />
      )}
      {marquee && (
        <div
          className="pointer-events-none absolute z-[24] rounded-[3px] border border-accent/80 bg-accent/10"
          style={{ left: marquee.x0, top: marquee.y0, width: marquee.x1 - marquee.x0, height: marquee.y1 - marquee.y0 }}
        />
      )}
      {readout && (
        <div
          className="popover pointer-events-none absolute z-[45] rounded-md px-2 py-1 font-mono text-[11px] whitespace-pre text-fg tabular"
          style={{ left: readout.x + 14, top: Math.max(RULER_H + 4, readout.y - 34) }}
        >
          {readout.text}
        </div>
      )}
    </>
  )
}

const SPEEDS = [0.25, 0.5, 1, 1.5, 2, 4]

function TimelineMenu({ clipId, frame }: { clipId: string | null; frame: number }) {
  const clip = useEditor((s) => (clipId ? s.project.clips[clipId] : undefined))
  if (clip) {
    return (
      <ContextContent>
        <ContextItem shortcut="s" onSelect={actions.split}>
          Split at playhead
        </ContextItem>
        <ContextItem shortcut="mod+d" onSelect={actions.duplicateSelection}>
          Duplicate
        </ContextItem>
        {clip.kind !== 'text' && clip.kind !== 'adjustment' && (
          <ContextSub label="Speed">
            {SPEEDS.map((s) => (
              <ContextItem key={s} onSelect={() => dispatch('clip.update', { ids: useUI.getState().selection, patch: { speed: s } })}>
                <span className="tabular">{s}×</span> {s === clip.speed && <span className="text-accent-2">•</span>}
              </ContextItem>
            ))}
          </ContextSub>
        )}
        <ContextSeparator />
        <ContextItem icon={<AiSparkle />} onSelect={() => askCopilotAbout(clip.id)}>
          Ask Copilot about this clip
        </ContextItem>
        <ContextSeparator />
        <ContextItem shortcut="delete" danger onSelect={() => actions.deleteSelection(false)}>
          Delete
        </ContextItem>
        <ContextItem shortcut="shift+delete" danger onSelect={() => actions.deleteSelection(true)}>
          Ripple delete
        </ContextItem>
      </ContextContent>
    )
  }
  return (
    <ContextContent>
      <ContextItem onSelect={() => dispatch('marker.add', { frame })}>Add marker here</ContextItem>
      <ContextItem
        onSelect={() => {
          const id = placeTitle('cinematic', frame)
          if (id) useUI.getState().select([id])
        }}
      >
        Add title here
      </ContextItem>
      <ContextSeparator />
      <ContextItem shortcut="mod+a" onSelect={actions.selectAll}>
        Select all
      </ContextItem>
      <ContextItem shortcut="shift+z" onSelect={actions.zoomToFit}>
        Zoom to fit
      </ContextItem>
      <ContextItem
        onSelect={() => {
          dispatch('track.add', { kind: 'video' })
          toast('Added a video track')
        }}
      >
        Add video track
      </ContextItem>
    </ContextContent>
  )
}
