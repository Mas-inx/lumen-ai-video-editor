import { Blend, Plus } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { Slider } from '@/components/ui/slider'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { adjacentBefore, clipEnd } from '@/editor/ops'
import { TRANSITIONS } from '@/editor/presets'
import { dispatch, useEditor } from '@/editor/store'
import type { Clip, Project, Track, TransitionKind } from '@/editor/types'
import { cn } from '@/lib/cn'
import { formatDuration } from '@/lib/time'
import { ClipView } from './ClipView'
import { useLayout } from './layout'
import { CLIP_COLOR, useDrag } from './model'

function clipIdsOn(project: Project, trackId: string) {
  return Object.values(project.clips)
    .filter((c) => c.trackId === trackId)
    .sort((a, b) => a.start - b.start)
    .map((c) => c.id)
}

export function TrackLane({ track, width }: { track: Track; width: number }) {
  const clipIds = useEditor(useShallow((s) => clipIdsOn(s.project, track.id)))
  const ghost = useDrag((s) => (s.dropGhost?.trackId === track.id ? s.dropGhost : null))
  const { pps, fps } = useLayout()

  return (
    <div
      data-lane={track.id}
      className={cn(
        'group/lane relative shrink-0 border-b border-line/70',
        track.role === 'main' && 'bg-white/[0.016]',
        (track.hidden || track.muted) && 'opacity-45',
      )}
      style={{ width, height: track.height }}
    >
      {clipIds.map((id) => (
        <ClipView key={id} clipId={id} locked={track.locked} />
      ))}
      <TransitionBadges trackId={track.id} />
      {track.kind === 'audio' && !track.locked && <CrossfadeHandles trackId={track.id} />}
      {ghost && (
        <div
          className="pointer-events-none absolute top-[3px] bottom-[3px] z-20 flex items-center overflow-hidden rounded-[7px] border-2 border-dashed px-2 text-[11px] font-medium text-white/90"
          style={{
            left: (ghost.start / fps) * pps,
            width: Math.max(8, (ghost.duration / fps) * pps),
            borderColor: CLIP_COLOR[ghost.kind],
            background: `color-mix(in oklab, ${CLIP_COLOR[ghost.kind]} 22%, transparent)`,
          }}
        >
          <span className="truncate">{ghost.label}</span>
        </div>
      )}
    </div>
  )
}

function TransitionBadges({ trackId }: { trackId: string }) {
  const items = useEditor(
    useShallow((s) =>
      Object.values(s.project.clips)
        .filter((c) => c.trackId === trackId && c.transitionIn && adjacentBefore(s.project, c))
        .map((c) => c.id),
    ),
  )
  return items.map((id) => <TransitionBadge key={id} clipId={id} />)
}

/** On audio tracks, a + at every cut between touching clips adds a crossfade. */
function CrossfadeHandles({ trackId }: { trackId: string }) {
  const cuts = useEditor(
    useShallow((s) => {
      const clips = Object.values(s.project.clips)
        .filter((c) => c.trackId === trackId)
        .sort((a, b) => a.start - b.start)
      return clips.filter((c, i) => i > 0 && !c.transitionIn && clipEnd(clips[i - 1]) === c.start).map((c) => c.id)
    }),
  )
  return cuts.map((id) => <CrossfadeHandle key={id} clipId={id} />)
}

function CrossfadeHandle({ clipId }: { clipId: string }) {
  const clip = useEditor((s) => s.project.clips[clipId]) as Clip | undefined
  const moving = useDrag((s) => Boolean(s.previews[clipId]))
  const { pps, fps } = useLayout()
  if (!clip || moving) return null
  return (
    <button
      type="button"
      title="Add a crossfade"
      onClick={() => dispatch('clip.setTransition', { id: clip.id, transition: { kind: 'dissolve', duration: Math.max(2, Math.min(clip.duration, Math.round(fps / 2))) } }, { label: 'Add crossfade' })}
      className="absolute top-1/2 z-[12] grid size-4 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-surface-5 text-fg-2 opacity-0 shadow-[0_0_0_1px_rgb(255_255_255/0.18),0_4px_10px_rgb(0_0_0/0.5)] outline-none transition-[opacity,transform] group-hover/lane:opacity-100 hover:scale-110 hover:text-fg focus-visible:opacity-100"
      style={{ left: (clip.start / fps) * pps }}
    >
      <Plus className="size-2.5" />
    </button>
  )
}

function TransitionBadge({ clipId }: { clipId: string }) {
  const clip = useEditor((s) => s.project.clips[clipId]) as Clip | undefined
  const moving = useDrag((s) => Boolean(s.previews[clipId]))
  const { pps, fps } = useLayout()
  if (!clip?.transitionIn || moving) return null
  const tr = clip.transitionIn
  const x = (clip.start / fps) * pps
  const w = (tr.duration / fps) * pps
  // On audio, every transition is a crossfade.
  const audio = clip.kind === 'audio'
  const name = audio ? 'Crossfade' : (TRANSITIONS.find((t) => t.kind === tr.kind)?.name ?? 'Transition')

  return (
    <>
      <div
        className="pointer-events-none absolute top-[3px] bottom-[3px] z-[11] rounded-l-[7px] bg-[linear-gradient(90deg,rgb(255_255_255/0.26),rgb(255_255_255/0.04))]"
        style={{ left: x, width: w }}
      />
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            title={`${name} · ${formatDuration(tr.duration, fps)}`}
            className="absolute bottom-[6px] z-[12] grid size-4 -translate-x-1/2 place-items-center rounded-[5px] bg-surface-5 text-fg shadow-[0_0_0_1px_rgb(255_255_255/0.18),0_4px_10px_rgb(0_0_0/0.5)] outline-none transition-transform hover:scale-110 data-[state=open]:bg-accent data-[state=open]:text-accent-fg"
            style={{ left: x }}
          >
            <Blend className="size-2.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" className="w-64">
          <div className="mb-2 text-xs font-semibold text-fg">{audio ? 'Crossfade' : 'Transition'}</div>
          {audio && <p className="-mt-1 mb-1 text-2xs text-fg-4">Equal-power: the outgoing sound plays on into its handle while the next fades in.</p>}
          <div className={cn('grid grid-cols-2 gap-1', audio && 'hidden')}>
            {TRANSITIONS.map((t) => (
              <button
                key={t.kind}
                type="button"
                onClick={() => dispatch('clip.setTransition', { id: clip.id, transition: { ...tr, kind: t.kind as TransitionKind } })}
                className={cn(
                  'h-7 rounded-md px-2 text-left text-xs text-fg-2 transition-colors hover:bg-white/[0.06]',
                  t.kind === tr.kind && 'bg-accent/15 text-accent-2',
                )}
              >
                {t.name}
              </button>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-3">
            <span className="w-14 text-xs text-fg-3">Duration</span>
            <Slider
              value={tr.duration}
              min={2}
              max={Math.max(3, Math.min(clip.duration, fps * 3))}
              onChange={(v) => dispatch('clip.setTransition', { id: clip.id, transition: { ...tr, duration: Math.round(v) } }, { coalesce: `tr:${clip.id}` })}
            />
            <span className="w-10 text-right text-xs text-fg-2 tabular">{formatDuration(tr.duration, fps)}</span>
          </div>
          <Button variant="danger" size="sm" className="mt-3 w-full" onClick={() => dispatch('clip.setTransition', { id: clip.id, transition: null })}>
            {audio ? 'Remove crossfade' : 'Remove transition'}
          </Button>
        </PopoverContent>
      </Popover>
    </>
  )
}
