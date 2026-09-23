import { AudioLines, Ellipsis, Eye, EyeOff, Film, Layers, Lock, LockOpen, Music, PencilLine, Trash, Type, Volume2, VolumeX } from 'lucide-react'
import { useState } from 'react'
import { IconButton } from '@/components/ui/button'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/menu'
import { dispatch } from '@/editor/store'
import type { Track } from '@/editor/types'
import { cn } from '@/lib/cn'
import { HEADER_W } from './model'

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
  const update = (patch: Partial<Pick<Track, 'name' | 'hidden' | 'muted' | 'locked'>>) => dispatch('track.update', { id: track.id, patch })

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
      <span className="h-[55%] w-[3px] shrink-0 rounded-full" style={{ background: trackColor(track), opacity: visibilityOn ? 0.35 : 0.9 }} />
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
            <div className={cn('truncate text-sm font-medium', visibilityOn ? 'text-fg-4' : 'text-fg-2')}>{track.name}</div>
            {!compact && track.role === 'main' && <div className="text-2xs text-fg-4">Main track</div>}
          </>
        )}
      </div>
      {/* Controls float over the name on hover, so names get the full width at rest. */}
      <div
        className={cn(
          'absolute inset-y-0 right-0 flex items-center pr-1 pl-6 opacity-0 transition-opacity group-hover/track:opacity-100 has-[[data-state=open]]:opacity-100',
          'bg-[linear-gradient(90deg,transparent,var(--color-surface)_22px)]',
          (visibilityOn || track.locked) && 'opacity-100',
        )}
      >
        <IconButton
          size="xs"
          label={track.kind === 'video' ? (track.hidden ? 'Show track' : 'Hide track') : track.muted ? 'Unmute track' : 'Mute track'}
          className={cn('opacity-0 transition-opacity group-hover/track:opacity-100', visibilityOn && 'text-warn opacity-100')}
          onClick={() => (track.kind === 'video' ? update({ hidden: !track.hidden }) : update({ muted: !track.muted }))}
        >
          {track.kind === 'video' ? track.hidden ? <EyeOff /> : <Eye /> : track.muted ? <VolumeX /> : <Volume2 />}
        </IconButton>
        <IconButton
          size="xs"
          label={track.locked ? 'Unlock track' : 'Lock track'}
          className={cn('opacity-0 transition-opacity group-hover/track:opacity-100', track.locked && 'text-warn opacity-100')}
          onClick={() => update({ locked: !track.locked })}
        >
          {track.locked ? <Lock /> : <LockOpen />}
        </IconButton>
        <Menu>
          <MenuTrigger asChild>
            <IconButton size="xs" label="Track options" className="opacity-0 transition-opacity group-hover/track:opacity-100 data-[state=open]:opacity-100">
              <Ellipsis />
            </IconButton>
          </MenuTrigger>
          <MenuContent align="start" className="min-w-[180px]">
            <MenuItem icon={<PencilLine />} onSelect={() => (setDraft(track.name), setRenaming(true))}>
              Rename
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
