import { ArrowDown, ArrowUp, AudioLines, Ellipsis, Eye, EyeOff, Film, GripVertical, Headphones, Layers, Lock, LockOpen, Music, PencilLine, Trash, Type, Volume2, VolumeX } from 'lucide-react'
import { useState, type PointerEvent as ReactPointerEvent } from 'react'
import { IconButton } from '@/components/ui/button'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/menu'
import { dispatch } from '@/editor/store'
import type { Track } from '@/editor/types'
import { cn } from '@/lib/cn'
import { useLayout } from './layout'
import { HEADER_W, useDrag } from './model'

const trackColor = (t: Track) =>
  t.role === 'titles' ? 'var(--color-clip-text)' : t.kind === 'video' ? 'var(--color-clip-video)' : 'var(--color-clip-audio)'

function TrackIcon({ track }: { track: Track }) {
  if (track.role === 'titles') return <Type />
  if (track.kind === 'video') return track.role === 'main' ? <Film /> : <Layers />
  return /music|score/i.test(track.name) ? <Music /> : <AudioLines />
}

export function TrackHeader({ track }: { track: Track }) {
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(track.name)
  const compact = track.height < 50
  const layout = useLayout()
  const update = (patch: Partial<Pick<Track, 'name' | 'hidden' | 'muted' | 'locked' | 'solo'>>) => dispatch('track.update', { id: track.id, patch })
  const siblings = layout.tracks.map((t, i) => ({ t, i })).filter(({ t }) => t.kind === track.kind)
  const index = layout.tracks.findIndex((t) => t.id === track.id)
  const first = siblings[0]?.i ?? 0
  const last = siblings[siblings.length - 1]?.i ?? 0

  /** Drag the grip to reorder tracks (video among video, audio among audio). */
  const startReorder = (e: ReactPointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const content = (e.currentTarget as HTMLElement).closest('[data-timeline-content]') as HTMLElement | null
    if (!content) return
    let target = index
    const move = (ev: PointerEvent) => {
      const y = ev.clientY - content.getBoundingClientRect().top
      // The slot boundary nearest the pointer, among this track's kind.
      let best = { slot: index, y: layout.rowTop[track.id], dist: Infinity }
      for (let slot = first; slot <= last + 1; slot++) {
        const t = layout.tracks[slot]
        const edge = t && slot <= last ? layout.rowTop[t.id] : layout.rowTop[layout.tracks[last].id] + layout.rowHeight[layout.tracks[last].id]
        const dist = Math.abs(edge - y)
        if (dist < best.dist) best = { slot, y: edge, dist }
      }
      target = best.slot > index ? best.slot - 1 : best.slot
      useDrag.setState({ trackDropY: target === index ? null : best.y })
      document.body.style.cursor = 'grabbing'
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.cursor = ''
      useDrag.setState({ trackDropY: null })
      if (target !== index) dispatch('track.move', { id: track.id, index: target })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const soloing = layout.tracks.some((t) => t.solo)

  const commit = () => {
    if (draft.trim() && draft.trim() !== track.name) update({ name: draft.trim() })
    setRenaming(false)
  }

  const visibilityOn = track.kind === 'video' ? track.hidden : track.muted

  return (
    <div
      className="group/track sticky left-0 z-30 flex shrink-0 items-center gap-2 border-r border-b border-line bg-surface pr-1 pl-2"
      style={{ width: HEADER_W, height: track.height }}
    >
      <span
        onPointerDown={startReorder}
        className="absolute inset-y-0 left-0 z-10 flex w-3 cursor-grab items-center justify-center text-fg-4 opacity-0 transition-opacity group-hover/track:opacity-100 [&_svg]:size-3"
        aria-label="Drag to reorder"
        title="Drag to reorder"
      >
        <GripVertical />
      </span>
      <span className="h-[55%] w-[3px] shrink-0 rounded-full" style={{ background: trackColor(track), opacity: visibilityOn || (soloing && !track.solo) ? 0.35 : 0.9 }} />
      <span className={cn('grid size-6 shrink-0 place-items-center rounded-md bg-white/[0.05] text-fg-3 [&_svg]:size-3.5', compact && 'size-5')}>
        <TrackIcon track={track} />
      </span>
      <div className="min-w-0 flex-1" onDoubleClick={() => (setDraft(track.name), setRenaming(true))}>
        {renaming ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => e.target.select()}
            onBlur={commit}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') commit()
              if (e.key === 'Escape') setRenaming(false)
            }}
            className="h-6 w-full rounded bg-white/[0.07] px-1.5 text-sm text-fg outline-none ring-1 ring-accent/60"
          />
        ) : (
          <>
            <div className="flex min-w-0 items-center gap-1">
              <span className={cn('truncate text-sm font-medium', visibilityOn ? 'text-fg-4' : 'text-fg-2')}>{track.name}</span>
              {/* At rest, just the states that are on — the full controls appear on hover. */}
              <span className="flex shrink-0 items-center gap-0.5 transition-opacity group-hover/track:opacity-0 [&_svg]:size-3">
                {track.solo && <Headphones className="text-accent-2" aria-label="Soloed" />}
                {track.muted && <VolumeX className="text-warn" aria-label="Muted" />}
                {track.hidden && <EyeOff className="text-warn" aria-label="Hidden" />}
                {track.locked && <Lock className="text-warn" aria-label="Locked" />}
              </span>
            </div>
            {!compact && track.role === 'main' && <div className="text-2xs text-fg-4">Main track</div>}
          </>
        )}
      </div>
      {/* Controls float over the name on hover, so names get the full width at rest. */}
      <div
        className={cn(
          'pointer-events-none absolute inset-y-0 right-0 flex items-center pr-1 pl-6 opacity-0 transition-opacity group-hover/track:pointer-events-auto group-hover/track:opacity-100 has-[[data-state=open]]:pointer-events-auto has-[[data-state=open]]:opacity-100',
          'bg-[linear-gradient(90deg,transparent,var(--color-surface)_22px)]',
        )}
      >
        {track.kind === 'video' && (
          <IconButton
            size="xs"
            label={track.muted ? 'Unmute track sound' : 'Mute track sound'}
            className={cn(track.muted && 'text-warn')}
            onClick={() => update({ muted: !track.muted })}
          >
            {track.muted ? <VolumeX /> : <Volume2 />}
          </IconButton>
        )}
        <IconButton
          size="xs"
          label={track.solo ? 'Unsolo' : 'Solo (hear only soloed tracks)'}
          className={cn(track.solo && 'text-accent-2')}
          onClick={() => update({ solo: !track.solo })}
        >
          <Headphones />
        </IconButton>
        <IconButton
          size="xs"
          label={track.kind === 'video' ? (track.hidden ? 'Show track' : 'Hide track') : track.muted ? 'Unmute track' : 'Mute track'}
          className={cn(visibilityOn && 'text-warn')}
          onClick={() => (track.kind === 'video' ? update({ hidden: !track.hidden }) : update({ muted: !track.muted }))}
        >
          {track.kind === 'video' ? track.hidden ? <EyeOff /> : <Eye /> : track.muted ? <VolumeX /> : <Volume2 />}
        </IconButton>
        <IconButton
          size="xs"
          label={track.locked ? 'Unlock track' : 'Lock track'}
          className={cn(track.locked && 'text-warn')}
          onClick={() => update({ locked: !track.locked })}
        >
          {track.locked ? <Lock /> : <LockOpen />}
        </IconButton>
        <Menu>
          <MenuTrigger asChild>
            <IconButton size="xs" label="Track options">
              <Ellipsis />
            </IconButton>
          </MenuTrigger>
          <MenuContent align="start" className="min-w-[180px]">
            <MenuItem icon={<PencilLine />} onSelect={() => (setDraft(track.name), setRenaming(true))}>
              Rename
            </MenuItem>
            <MenuItem icon={<ArrowUp />} disabled={index <= first} onSelect={() => dispatch('track.move', { id: track.id, index: index - 1 })}>
              Move up
            </MenuItem>
            <MenuItem icon={<ArrowDown />} disabled={index >= last} onSelect={() => dispatch('track.move', { id: track.id, index: index + 1 })}>
              Move down
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={<Trash />} danger onSelect={() => dispatch('track.remove', { id: track.id })}>
              Delete track
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
    </div>
  )
}
