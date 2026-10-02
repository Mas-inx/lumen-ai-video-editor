import { AudioLines, Captions, Check, FolderSearch, Gauge, Heart, Image as ImageIcon, Link2, Pause, Play, Plus, Trash, TriangleAlert, Upload, Video, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Button, IconButton } from '@/components/ui/button'
import { SearchInput } from '@/components/ui/input'
import { ContextContent, ContextItem, ContextRoot, ContextSeparator, ContextTrigger } from '@/components/ui/menu'
import { placeAsset } from '@/editor/placement'
import { usePlayback } from '@/editor/playback'
import { dispatch, useEditor } from '@/editor/store'
import type { Asset, AssetKind } from '@/editor/types'
import { useUI } from '@/editor/ui-store'
import { dnd } from '@/features/dnd'
import { actions } from '@/features/shell/actions'
import { cn } from '@/lib/cn'
import { desktop, platform } from '@/lib/platform'
import { formatSeconds } from '@/lib/time'
import { relinkAsset } from '@/project/media-import'
import { cancelProxy, canProxy, makeProxy, removeProxy, useProxyJobs } from '@/project/proxies'
import { canTranscribe, ensureTranscripts, TRANSCRIBER_NAMES, transcribers } from '@/project/transcribe'
import { FrameCanvas, stripFrame, useFilmstrip } from './frames'
import { addMediaAtPlayhead, clearMediaSelection, pickMedia, removeMedia, setMediaSelection, toggleFavorite, useMediaSelection } from './media-selection'
import { assetThumb, Chip, MiniWave, PanelHeader, scrollArea, SectionLabel } from './shared'
import { TimelinesSection } from './TimelinesSection'

type Filter = 'all' | AssetKind

export function MediaPanel() {
  // Subject mattes belong to their footage, not the library.
  const assets = useEditor(useShallow((s) => Object.values(s.project.assets).filter((a) => !a.matteOf).sort((a, b) => b.addedAt - a.addedAt)))
  const used = useEditor(useShallow((s) => [...new Set(Object.values(s.project.clips).map((c) => c.assetId).filter(Boolean))] as string[]))
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [dragOver, setDragOver] = useState(false)

  const counts = useMemo(() => {
    const c = { all: assets.length, video: 0, image: 0, audio: 0 }
    for (const a of assets) c[a.kind]++
    return c
  }, [assets])

  const visible = assets.filter(
    (a) => (filter === 'all' || a.kind === filter) && (!query || `${a.name} ${a.tags?.join(' ') ?? ''}`.toLowerCase().includes(query.toLowerCase())),
  )
  const visual = visible.filter((a) => a.kind !== 'audio')
  const audio = visible.filter((a) => a.kind === 'audio')
  // The media as shown, for Shift-click ranges and Select all.
  const order = [...visual, ...audio].map((a) => a.id)
  const selected = useMediaSelection((s) => s.ids)
  const scrollRef = useRef<HTMLDivElement>(null)
  const marquee = useMarquee(scrollRef)

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const mod = platform.isMac ? e.metaKey : e.ctrlKey
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      setMediaSelection(order)
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && selected.length) {
      e.preventDefault()
      removeMedia(selected)
    } else if (e.key === 'Escape' && selected.length) {
      e.preventDefault()
      clearMediaSelection()
    }
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    if (e.dataTransfer.files.length) void actions.importFileList([...e.dataTransfer.files])
  }

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false)
      }}
      onDrop={onDrop}
    >
      <PanelHeader title="Media">
        <Button size="sm" variant="secondary" onClick={actions.importMedia}>
          <Upload />
          Import
        </Button>
      </PanelHeader>
      <div className="space-y-2.5 px-3.5 pb-2">
        <SearchInput value={query} onChange={setQuery} placeholder="Search media, tags…" />
        <div className="scrollbar-none flex gap-1 overflow-x-auto">
          <Chip active={filter === 'all'} onClick={() => setFilter('all')} count={counts.all}>
            All
          </Chip>
          <Chip active={filter === 'video'} onClick={() => setFilter('video')} count={counts.video}>
            Video
          </Chip>
          <Chip active={filter === 'image'} onClick={() => setFilter('image')} count={counts.image}>
            Images
          </Chip>
          <Chip active={filter === 'audio'} onClick={() => setFilter('audio')} count={counts.audio}>
            Audio
          </Chip>
        </div>
      </div>

      <div ref={scrollRef} tabIndex={-1} onKeyDown={onKeyDown} onPointerDown={marquee.onPointerDown} className={cn(scrollArea, 'relative outline-none')}>
        <TimelinesSection query={query} />
        {!assets.length && <EmptyDrop />}
        {visual.length > 0 && (
          <>
            <SectionLabel>Footage & photos</SectionLabel>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(122px,1fr))] gap-x-2.5 gap-y-3">
              {visual.map((a) => (
                <MediaCard key={a.id} asset={a} used={used.includes(a.id)} order={order} />
              ))}
            </div>
          </>
        )}
        {audio.length > 0 && (
          <>
            <SectionLabel>Audio</SectionLabel>
            <div className="space-y-1">
              {audio.map((a) => (
                <AudioRow key={a.id} asset={a} used={used.includes(a.id)} order={order} />
              ))}
            </div>
          </>
        )}
        {assets.length > 0 && !visible.length && <p className="mt-10 text-center text-sm text-fg-4">No media matches “{query}”.</p>}
        {marquee.box && (
          <div
            className="pointer-events-none absolute z-20 rounded-[3px] border border-accent/70 bg-accent/10"
            style={{ left: marquee.box.x, top: marquee.box.y, width: marquee.box.w, height: marquee.box.h }}
          />
        )}
      </div>
      {selected.length > 1 && <SelectionBar ids={order.filter((id) => selected.includes(id))} />}

      <AnimatePresence>
        {dragOver && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="pointer-events-none absolute inset-2 z-10 grid place-items-center rounded-xl border-2 border-dashed border-accent/70 bg-accent/10 backdrop-blur-[2px]"
          >
            <div className="text-center">
              <Upload className="mx-auto mb-2 size-6 text-accent-2" />
              <p className="text-sm font-medium text-fg">Drop to import</p>
              <p className="text-xs text-fg-3">Video, audio and images</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/** Dragging on empty space draws a box; the media it touches gets selected (Ctrl/⌘ or Shift adds to the selection). */
function useMarquee(scrollRef: React.RefObject<HTMLDivElement | null>) {
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = scrollRef.current
    if (!el || e.button !== 0) return
    if ((e.target as HTMLElement).closest('[data-asset-id], button, a, input, [role="button"]')) return
    const rect = el.getBoundingClientRect()
    const at = (x: number, y: number) => ({ x: x - rect.left + el.scrollLeft, y: y - rect.top + el.scrollTop })
    const start = at(e.clientX, e.clientY)
    const additive = e.ctrlKey || e.metaKey || e.shiftKey
    const base = additive ? useMediaSelection.getState().ids : []
    // Where every card sits, in scrolled-content coordinates (they don't move while the box is drawn).
    const cards = [...el.querySelectorAll<HTMLElement>('[data-asset-id]')].map((c) => {
      const r = c.getBoundingClientRect()
      const p = at(r.left, r.top)
      return { id: c.dataset.assetId!, x0: p.x, y0: p.y, x1: p.x + r.width, y1: p.y + r.height }
    })
    let moved = false
    const onMove = (ev: PointerEvent) => {
      // Near the top or bottom edge, the list scrolls along.
      if (ev.clientY < rect.top + 28) el.scrollTop -= 14
      else if (ev.clientY > rect.bottom - 28) el.scrollTop += 14
      const p = at(ev.clientX, ev.clientY)
      if (!moved && Math.hypot(p.x - start.x, p.y - start.y) < 4) return
      moved = true
      const b = { x0: Math.min(start.x, p.x), y0: Math.min(start.y, p.y), x1: Math.max(start.x, p.x), y1: Math.max(start.y, p.y) }
      setBox({ x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 })
      const hits = cards.filter((c) => c.x0 < b.x1 && c.x1 > b.x0 && c.y0 < b.y1 && c.y1 > b.y0).map((c) => c.id)
      setMediaSelection([...new Set([...base, ...hits])])
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setBox(null)
      // A plain click on empty space clears the selection.
      if (!moved && !additive) clearMediaSelection()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  return { box, onPointerDown }
}

/** What to do with several selected media at once. */
function SelectionBar({ ids }: { ids: string[] }) {
  const assets = useEditor((s) => s.project.assets)
  const list = ids.map((id) => assets[id]).filter(Boolean)
  const proxyable = list.filter((a) => canProxy(a) && !a.proxy)
  const transcribable = list.filter((a) => canTranscribe(a) && !a.transcript?.length)
  const allFavorite = list.every((a) => a.favorite)
  return (
    <div className="flex shrink-0 items-center gap-0.5 border-t border-line bg-surface px-3 py-1.5">
      <span className="mr-auto text-xs font-medium text-fg-2 tabular">{list.length} selected</span>
      <IconButton label="Add to the timeline at the playhead, one after another" onClick={() => addMediaAtPlayhead(ids)}>
        <Plus />
      </IconButton>
      <IconButton label={allFavorite ? 'Remove from favorites' : 'Add to favorites'} active={allFavorite} onClick={() => toggleFavorite(ids)}>
        <Heart />
      </IconButton>
      {proxyable.length > 0 && (
        <IconButton label={`Make proxies for smooth playback (${proxyable.length})`} onClick={() => proxyable.forEach((a) => makeProxy(a.id))}>
          <Gauge />
        </IconButton>
      )}
      {transcribable.length > 0 && (
        <IconButton label={`Transcribe (${transcribable.length})`} onClick={() => void ensureTranscripts(transcribable.map((a) => a.id))}>
          <Captions />
        </IconButton>
      )}
      <IconButton label="Remove from project" shortcut="delete" onClick={() => removeMedia(ids)} className="hover:text-danger">
        <Trash />
      </IconButton>
      <IconButton label="Clear selection" shortcut="esc" onClick={clearMediaSelection}>
        <X />
      </IconButton>
    </div>
  )
}

/** Click selects, Ctrl/⌘-click toggles, Shift-click selects a range; right-clicking something unselected selects it. */
function useSelectable(asset: Asset, order: string[]) {
  const selected = useMediaSelection((s) => s.ids.includes(asset.id))
  const onClick = (e: ReactMouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    pickMedia(asset.id, e.shiftKey ? 'range' : (platform.isMac ? e.metaKey : e.ctrlKey) ? 'toggle' : 'replace', order)
  }
  const onContextMenu = () => {
    if (!useMediaSelection.getState().ids.includes(asset.id)) pickMedia(asset.id, 'replace', order)
  }
  // Dragging a selected card drags the whole selection, in the order shown.
  const onDragStart = (e: DragEvent) => {
    const ids = useMediaSelection.getState().ids
    const group = ids.includes(asset.id) && ids.length > 1 ? order.filter((id) => ids.includes(id)) : [asset.id]
    dnd.start(e, { type: 'asset', assetId: asset.id, assetIds: group }, group.length > 1 ? `${group.length} items` : asset.name)
  }
  return { selected, onClick, onContextMenu, onDragStart }
}

function EmptyDrop() {
  return (
    <button
      type="button"
      onClick={actions.importMedia}
      className="mt-2 flex w-full flex-col items-center gap-2 rounded-xl border border-dashed border-line-3 px-4 py-10 text-center transition-colors hover:border-accent/60 hover:bg-accent/5"
    >
      <span className="grid size-10 place-items-center rounded-full bg-white/[0.06]">
        <Upload className="size-4 text-fg-2" />
      </span>
      <span className="text-sm font-medium text-fg">Import your media</span>
      <span className="text-xs text-fg-4">Drag files here, or click to browse</span>
    </button>
  )
}

function useAssetActions(asset: Asset) {
  const add = () => {
    const id = placeAsset(asset.id, usePlayback.getState().frame)
    if (id) useUI.getState().select([id])
  }
  const onDragStart = (e: DragEvent) => dnd.start(e, { type: 'asset', assetId: asset.id }, asset.name)
  return { add, onDragStart }
}

const missing = (asset: Asset) => asset.source.type !== 'sequence' && Boolean(asset.source.missing)
const filePath = (asset: Asset) => (asset.source.type === 'file' ? asset.source.path : asset.source.dir)

function AssetMenu({ asset, children }: { asset: Asset; children: ReactNode }) {
  const { add } = useAssetActions(asset)
  const making = useProxyJobs((s) => s.jobs[asset.id])
  const group = useMediaSelection((s) => (s.ids.length > 1 && s.ids.includes(asset.id) ? s.ids : null))
  if (group)
    return (
      <ContextRoot>
        <ContextTrigger asChild>{children}</ContextTrigger>
        <BulkMenu ids={group} />
      </ContextRoot>
    )
  const transcribe = () => {
    if (asset.transcript?.length) dispatch('asset.update', { id: asset.id, patch: { transcript: [] } }, { history: false })
    void ensureTranscripts([asset.id])
  }
  const path = filePath(asset)
  return (
    <ContextRoot>
      <ContextTrigger asChild>{children}</ContextTrigger>
      <ContextContent>
        {!missing(asset) && (
          <ContextItem icon={<Plus />} onSelect={add}>
            Add at playhead
          </ContextItem>
        )}
        {asset.source.type === 'file' && (
          <ContextItem icon={<Link2 />} onSelect={() => void relinkAsset(asset.id)}>
            {missing(asset) ? 'Locate file…' : 'Replace file…'}
          </ContextItem>
        )}
        {canTranscribe(asset) && (
          <ContextItem icon={<Captions />} onSelect={transcribe}>
            {asset.transcript?.length ? 'Transcribe again' : 'Transcribe'} · {TRANSCRIBER_NAMES[transcribers()[0]]}
          </ContextItem>
        )}
        {asset.kind === 'video' && !missing(asset) && (
          <ContextItem icon={<Video />} onSelect={() => useUI.getState().setMulticam({ assetIds: [asset.id] })}>
            Make a multicam clip…
          </ContextItem>
        )}
        {path && desktop && !missing(asset) && (
          <ContextItem icon={<FolderSearch />} onSelect={() => void desktop!.files.reveal(path)}>
            Show in folder
          </ContextItem>
        )}
        {canProxy(asset) &&
          (making !== undefined ? (
            <ContextItem icon={<Gauge />} onSelect={() => cancelProxy(asset.id)}>
              Stop making the proxy ({Math.round(making * 100)}%)
            </ContextItem>
          ) : asset.proxy ? (
            <ContextItem icon={<Gauge />} onSelect={() => removeProxy(asset.id)}>
              Remove proxy ({asset.proxy.height}p)
            </ContextItem>
          ) : (
            <ContextItem icon={<Gauge />} onSelect={() => makeProxy(asset.id)}>
              Make a proxy for smooth playback
            </ContextItem>
          ))}
        <ContextItem icon={<Heart />} onSelect={() => dispatch('asset.update', { id: asset.id, patch: { favorite: !asset.favorite } })}>
          {asset.favorite ? 'Remove from favorites' : 'Add to favorites'}
        </ContextItem>
        <ContextSeparator />
        <ContextItem icon={<Trash />} danger onSelect={() => removeMedia([asset.id])}>
          Remove from project
        </ContextItem>
      </ContextContent>
    </ContextRoot>
  )
}

/** The right-click menu for several selected media. */
function BulkMenu({ ids }: { ids: string[] }) {
  const assets = useEditor((s) => s.project.assets)
  const list = ids.map((id) => assets[id]).filter(Boolean)
  const proxyable = list.filter((a) => canProxy(a) && !a.proxy)
  const transcribable = list.filter((a) => canTranscribe(a) && !a.transcript?.length)
  return (
    <ContextContent>
      <ContextItem icon={<Plus />} onSelect={() => addMediaAtPlayhead(ids)}>
        Add {list.length} at the playhead
      </ContextItem>
      {proxyable.length > 0 && (
        <ContextItem icon={<Gauge />} onSelect={() => proxyable.forEach((a) => makeProxy(a.id))}>
          Make proxies ({proxyable.length})
        </ContextItem>
      )}
      {transcribable.length > 0 && (
        <ContextItem icon={<Captions />} onSelect={() => void ensureTranscripts(transcribable.map((a) => a.id))}>
          Transcribe ({transcribable.length})
        </ContextItem>
      )}
      <ContextItem icon={<Heart />} onSelect={() => toggleFavorite(ids)}>
        {list.every((a) => a.favorite) ? 'Remove from favorites' : 'Add to favorites'}
      </ContextItem>
      <ContextSeparator />
      <ContextItem icon={<Trash />} danger onSelect={() => removeMedia(ids)}>
        Remove {list.length} from project
      </ContextItem>
    </ContextContent>
  )
}

/** Proxy state on a card: a progress ring while it's being made, then a small PROXY tag. */
function ProxyBadge({ asset }: { asset: Asset }) {
  const making = useProxyJobs((s) => s.jobs[asset.id])
  if (making !== undefined)
    return (
      <span className="absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded-md bg-black/65 px-1.5 py-0.5 text-[9px] font-semibold text-white/85 backdrop-blur-sm" title="Making a proxy">
        <svg viewBox="0 0 16 16" className="size-2.5 -rotate-90">
          <circle cx="8" cy="8" r="6" fill="none" stroke="rgb(255 255 255 / 0.25)" strokeWidth="3" />
          <circle cx="8" cy="8" r="6" fill="none" stroke="var(--color-accent)" strokeWidth="3" strokeDasharray={`${making * 37.7} 37.7`} />
        </svg>
        PROXY
      </span>
    )
  if (!asset.proxy) return null
  return (
    <span className="absolute bottom-1.5 left-1.5 rounded-md bg-black/60 px-1.5 py-0.5 text-[9px] font-semibold text-accent-2 backdrop-blur-sm" title={`Plays a ${asset.proxy.height}p proxy in the preview; exports use the original`}>
      PROXY
    </span>
  )
}

function MediaCard({ asset, used, order }: { asset: Asset; used: boolean; order: string[] }) {
  const { add } = useAssetActions(asset)
  const { selected, onClick, onContextMenu, onDragStart } = useSelectable(asset, order)
  const [skim, setSkim] = useState<number | null>(null)
  const poster = assetThumb(asset)
  const offline = missing(asset)
  const canSkim = asset.kind === 'video' && Boolean(asset.duration) && !offline
  // Video files skim through decoded thumbnails (generated the first time you hover).
  const strip = useFilmstrip(asset, skim !== null)
  const skimFrame = skim !== null && asset.source.type === 'file' ? stripFrame(strip, skim) : null
  const src = skim !== null && canSkim && asset.source.type === 'sequence' ? assetThumb(asset, skim) : poster
  const res = asset.width && asset.height ? (Math.max(asset.width, asset.height) >= 3840 ? '4K' : `${Math.min(asset.width, asset.height)}p`) : null

  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!canSkim) return
    const r = e.currentTarget.getBoundingClientRect()
    const t = ((e.clientX - r.left) / r.width) * (asset.duration ?? 0)
    setSkim(Math.round(t * 4) / 4)
  }

  return (
    <AssetMenu asset={asset}>
      <div
        data-asset-id={asset.id}
        draggable
        onDragStart={onDragStart}
        onDragEnd={dnd.end}
        onClick={onClick}
        onContextMenu={onContextMenu}
        onDoubleClick={add}
        aria-selected={selected}
        className="group/card min-w-0 cursor-grab active:cursor-grabbing"
      >
        <div
          onPointerMove={onMove}
          onPointerLeave={() => setSkim(null)}
          className={cn(
            'relative aspect-video overflow-hidden rounded-[10px] bg-surface-3 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)] transition-[box-shadow,transform] duration-200 group-hover/card:shadow-[0_0_0_1px_rgb(255_255_255/0.16),0_10px_24px_-10px_rgb(0_0_0/0.9)]',
            selected && 'shadow-[0_0_0_2px_var(--color-accent)] group-hover/card:shadow-[0_0_0_2px_var(--color-accent),0_10px_24px_-10px_rgb(0_0_0/0.9)]',
          )}
        >
          {src ? (
            <img src={src} alt="" draggable={false} className={cn('h-full w-full object-cover transition-transform duration-500 ease-out group-hover/card:scale-[1.04]', offline && 'opacity-35 grayscale')} />
          ) : (
            <div className="grid h-full place-items-center text-fg-4">
              <ImageIcon className="size-5" />
            </div>
          )}
          {skimFrame && (
            <div className="absolute inset-0">
              <FrameCanvas frame={skimFrame} />
            </div>
          )}
          {offline && (
            <button
              type="button"
              onClick={() => void relinkAsset(asset.id)}
              className="absolute inset-0 grid place-items-center bg-black/40 text-center text-2xs font-medium text-warn"
            >
              <span className="flex flex-col items-center gap-1">
                <TriangleAlert className="size-4" />
                Media offline · Locate…
              </span>
            </button>
          )}
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/55 via-transparent to-transparent" />
          {skim !== null && canSkim && (
            <div className="absolute inset-x-0 bottom-0 h-[2px] bg-white/20">
              <div className="h-full bg-white" style={{ width: `${(skim / (asset.duration ?? 1)) * 100}%` }} />
            </div>
          )}
          {asset.alpha && <span className="absolute bottom-1.5 left-1.5 rounded-md bg-black/60 px-1.5 py-0.5 text-[9px] font-semibold text-white/80 backdrop-blur-sm">ALPHA</span>}
          <ProxyBadge asset={asset} />
          {asset.kind === 'image' && (
            <span className="absolute top-1.5 left-1.5 grid size-5 place-items-center rounded-md bg-black/50 text-white backdrop-blur-sm">
              <ImageIcon className="size-3" />
            </span>
          )}
          {asset.generated && <span className="absolute top-1.5 left-1.5 rounded-md bg-ai px-1.5 py-0.5 text-[9px] font-bold text-accent-fg shadow">AI</span>}
          {selected && (
            <span className="absolute top-1.5 left-1.5 grid size-5 place-items-center rounded-full bg-accent text-accent-fg shadow-[0_0_0_2px_rgb(0_0_0/0.35)]">
              <Check className="size-3" strokeWidth={3} />
            </span>
          )}
          {asset.duration !== undefined && (
            <span className="absolute right-1.5 bottom-1.5 rounded-md bg-black/60 px-1.5 py-0.5 font-mono text-[10px] text-white tabular backdrop-blur-sm">
              {skim !== null && canSkim ? formatSeconds(skim) : formatSeconds(asset.duration)}
            </span>
          )}
          {used && <span className="absolute top-2 right-2 size-1.5 rounded-full bg-ok shadow-[0_0_0_2px_rgb(0_0_0/0.4)]" title="Used in timeline" />}
          <button
            type="button"
            aria-label={`Add ${asset.name} at playhead`}
            onClick={add}
            className="absolute top-1.5 right-1.5 grid size-6 scale-90 place-items-center rounded-full bg-white text-black opacity-0 shadow-lg transition-[opacity,transform] duration-200 group-hover/card:scale-100 group-hover/card:opacity-100 hover:bg-accent-2 hover:text-accent-fg"
          >
            <Plus className="size-3.5" strokeWidth={2.5} />
          </button>
        </div>
        <div className="mt-1.5 px-0.5">
          <div className="truncate text-xs font-medium text-fg-2 group-hover/card:text-fg">{asset.name}</div>
          <div className="text-2xs text-fg-4">{[asset.kind === 'image' ? 'Photo' : res, asset.fps ? `${asset.fps} fps` : null].filter(Boolean).join(' · ') || 'Media'}</div>
        </div>
      </div>
    </AssetMenu>
  )
}

/** One audio preview at a time, straight from the file. */
let previewEl: HTMLAudioElement | null = null
const previewListeners = new Set<() => void>()
function usePreviewing(url: string | undefined) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const fn = () => setTick((t) => t + 1)
    previewListeners.add(fn)
    return () => void previewListeners.delete(fn)
  }, [])
  const playing = Boolean(url && previewEl && !previewEl.paused && previewEl.dataset.url === url)
  const toggle = () => {
    if (!url) return
    if (playing) previewEl!.pause()
    else {
      previewEl?.pause()
      previewEl = new Audio(url)
      previewEl.dataset.url = url
      previewEl.crossOrigin = 'anonymous'
      previewEl.onpause = previewEl.onended = previewEl.onplay = () => previewListeners.forEach((f) => f())
      void previewEl.play()
    }
  }
  return { playing, toggle }
}

function AudioRow({ asset, used, order }: { asset: Asset; used: boolean; order: string[] }) {
  const { add } = useAssetActions(asset)
  const { selected, onClick, onContextMenu, onDragStart } = useSelectable(asset, order)
  const voice = Boolean(asset.transcript?.length)
  const offline = missing(asset)
  const url = asset.source.type === 'file' && !offline ? asset.source.url : undefined
  const preview = usePreviewing(url)
  return (
    <AssetMenu asset={asset}>
      <div
        data-asset-id={asset.id}
        draggable
        onDragStart={onDragStart}
        onDragEnd={dnd.end}
        onClick={onClick}
        onContextMenu={onContextMenu}
        onDoubleClick={add}
        aria-selected={selected}
        className={cn(
          'group/row flex h-12 cursor-grab items-center gap-2.5 rounded-[10px] px-1.5 transition-colors hover:bg-white/[0.04] active:cursor-grabbing',
          selected && 'bg-accent/[0.08] shadow-[inset_0_0_0_1px_rgb(214_238_0/0.45)] hover:bg-accent/[0.11]',
        )}
      >
        <button
          type="button"
          aria-label={preview.playing ? `Stop ${asset.name}` : `Play ${asset.name}`}
          disabled={!url}
          onClick={preview.toggle}
          className={cn(
            'group/play grid size-9 shrink-0 place-items-center rounded-lg transition-colors',
            offline ? 'bg-warn/10 text-warn' : voice ? 'bg-clip-audio/15 text-clip-audio hover:bg-clip-audio/25' : 'bg-accent/15 text-accent-2 hover:bg-accent/25',
          )}
        >
          {offline ? (
            <TriangleAlert className="size-4" />
          ) : preview.playing ? (
            <Pause className="size-4" fill="currentColor" />
          ) : (
            <>
              <AudioLines className="size-4 group-hover/play:hidden" />
              <Play className="hidden size-4 group-hover/play:block" fill="currentColor" />
            </>
          )}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-xs font-medium text-fg-2 group-hover/row:text-fg">{asset.name}</span>
            {used && <span className="size-1.5 shrink-0 rounded-full bg-ok" title="Used in timeline" />}
          </div>
          <div className="mt-1 h-3 text-clip-audio/50">
            {offline ? <span className="text-2xs text-warn">Offline — right-click to locate</span> : <MiniWave peaks={asset.peaks} bars={34} />}
          </div>
        </div>
        <span className="shrink-0 font-mono text-2xs text-fg-4 tabular">{formatSeconds(asset.duration ?? 0)}</span>
        <button
          type="button"
          aria-label={`Add ${asset.name} at playhead`}
          onClick={add}
          className="grid size-6 shrink-0 place-items-center rounded-full text-fg-3 opacity-0 transition-opacity group-hover/row:opacity-100 hover:bg-white/[0.1] hover:text-fg"
        >
          <Plus className="size-3.5" />
        </button>
      </div>
    </AssetMenu>
  )
}
