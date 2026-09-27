import { Crosshair, FolderOpen, Layers, Move, RotateCcw, Split, Video, X } from 'lucide-react'
import { Button, IconButton } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Row, Section } from '@/components/ui/section'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { autoZoom } from '@/editor/motion'
import { angleTracks, clipsLength } from '@/editor/sequences'
import { dispatch, useEditor } from '@/editor/store'
import { openTimeline } from '@/editor/timeline-nav'
import type { Clip } from '@/editor/types'
import { actions } from '@/features/shell/actions'
import { cn } from '@/lib/cn'
import { formatDuration } from '@/lib/time'

/** A nested or multicam clip: what it plays, a way in, and (multicam) which camera it shows. */
export function NestSection({ clip }: { clip: Clip }) {
  const seq = useEditor((s) => (clip.sequenceId ? s.project.sequences?.[clip.sequenceId] : undefined))
  if (!clip.sequenceId) return null
  const angles = seq?.multicam ? angleTracks(seq) : []
  const active = clip.angle ?? angles[0]?.id
  return (
    <Section title={seq?.multicam ? 'Multicam' : 'Nested timeline'} icon={seq?.multicam ? <Video /> : <Layers />}>
      {!seq ? (
        <p className="text-2xs text-danger">Its timeline is missing from the project.</p>
      ) : (
        <div className="space-y-2.5">
          <div className="flex items-center gap-2 rounded-lg bg-white/[0.035] px-2.5 py-2 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.04)]">
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-medium text-fg">{seq.name}</div>
              <div className="text-2xs text-fg-4 tabular">
                {seq.settings.width}×{seq.settings.height} · {formatDuration(clipsLength(seq.clips), seq.settings.fps)}
                {seq.multicam ? ` · ${angles.length} cameras` : ` · ${Object.keys(seq.clips).length} clips`}
              </div>
            </div>
            <Button size="xs" variant="secondary" onClick={() => openTimeline(seq.id, true)}>
              <FolderOpen /> Open
            </Button>
          </div>
          {angles.length > 0 && (
            <>
              <div className="grid grid-cols-2 gap-1.5">
                {angles.map((t, i) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => dispatch('clip.update', { ids: [clip.id], patch: { angle: t.id } })}
                    className={cn(
                      'flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-xs transition-colors',
                      t.id === active ? 'bg-accent/15 text-accent-2 shadow-[inset_0_0_0_1px_rgb(214_238_0/0.35)]' : 'bg-white/[0.035] text-fg-2 hover:bg-white/[0.07] hover:text-fg',
                    )}
                  >
                    {i < 9 && <Kbd combo={String(i + 1)} />}
                    <span className="truncate">{t.name.replace(/^Cam \d+ · /, '')}</span>
                  </button>
                ))}
              </div>
              <p className="text-2xs leading-relaxed text-fg-4">Press a camera’s number while it plays to cut to it at the playhead. The camera angle strip under the preview shows them all.</p>
            </>
          )}
          <Button size="xs" variant="ghost" onClick={actions.unnestSelection} className="w-full justify-center">
            <Split /> Break apart onto this timeline
          </Button>
        </div>
      )}
    </Section>
  )
}

/** Tracking (follow something in the footage) and stabilization. */
export function MotionSection({ clip }: { clip: Clip }) {
  const asset = useEditor((s) => (clip.assetId ? s.project.assets[clip.assetId] : undefined))
  const canStabilize = clip.kind === 'video' && asset?.kind === 'video' && !clip.freeze && !clip.sequenceId
  const canFollow = clip.kind !== 'audio' && clip.kind !== 'adjustment'
  if (!canStabilize && !canFollow) return null
  const s = clip.stabilize
  const setStab = (patch: Partial<NonNullable<Clip['stabilize']>>, key?: string) => dispatch('clip.update', { ids: [clip.id], patch: { stabilize: patch } }, key ? { coalesce: `stab:${clip.id}:${key}` } : undefined)
  const followFrames = clip.follow ? clip.follow.points.length / 2 : 0
  return (
    <Section title="Motion" icon={<Crosshair />} defaultOpen={Boolean(clip.follow || s)}>
      <div className="space-y-3">
        {canFollow && (
          <div>
            <div className="mb-1.5 flex items-center gap-1.5">
              <Crosshair className="size-3.5 text-fg-3" />
              <span className="flex-1 text-xs font-medium text-fg">Follow something</span>
              {clip.follow && (
                <IconButton size="xs" label="Stop following" onClick={() => dispatch('clip.update', { ids: [clip.id], patch: { follow: null } })}>
                  <X />
                </IconButton>
              )}
            </div>
            <p className="mb-2 text-2xs leading-relaxed text-fg-4">
              {clip.follow
                ? `Moves with a point tracked over ${followFrames} frames. Drag it on the canvas to change where it sits relative to the point.`
                : 'Pin this clip to something moving in the footage below it — a title to a car, a sticker to a face.'}
            </p>
            <Button size="xs" variant="secondary" onClick={() => actions.trackMotion(clip.id)} className="w-full justify-center">
              <Crosshair /> {clip.follow ? 'Track again…' : 'Track motion…'}
            </Button>
          </div>
        )}
        {canStabilize && (
          <div className="border-t border-line pt-3">
            <div className="mb-1.5 flex items-center gap-1.5">
              <Move className="size-3.5 text-fg-3" />
              <span className="flex-1 text-xs font-medium text-fg">Stabilize</span>
              {s && (
                <IconButton size="xs" label="Remove stabilization" onClick={() => dispatch('clip.update', { ids: [clip.id], patch: { stabilize: null } })}>
                  <X />
                </IconButton>
              )}
            </div>
            {!s ? (
              <>
                <p className="mb-2 text-2xs leading-relaxed text-fg-4">Measures the camera shake in this clip and smooths it away, zooming in just enough to hide the moving edges.</p>
                <Button size="xs" variant="secondary" onClick={() => void actions.stabilize(clip.id)} className="w-full justify-center">
                  <Move /> Stabilize
                </Button>
              </>
            ) : (
              <div className="space-y-0.5">
                <Row label="Smoothness">
                  <Slider value={s.smooth} min={0.2} max={4} step={0.1} defaultValue={1} onChange={(v) => setStab({ smooth: Math.round(v * 10) / 10 }, 'smooth')} />
                  <span className="w-10 text-right text-xs text-fg-3 tabular">{s.smooth.toFixed(1)}s</span>
                </Row>
                <Row label="Zoom">
                  <Slider value={s.zoom} min={1} max={1.6} step={0.005} defaultValue={1} onChange={(v) => setStab({ zoom: Math.round(v * 1000) / 1000 }, 'zoom')} />
                  <span className="w-10 text-right text-xs text-fg-3 tabular">{Math.round((s.zoom - 1) * 100)}%</span>
                </Row>
                <Row label="Level">
                  <span className="flex-1 text-2xs text-fg-4">Hold the horizon steady</span>
                  <Switch aria-label="Stabilize rotation" checked={s.rotation} onChange={(v) => setStab({ rotation: v })} />
                </Row>
                <div className="flex justify-end pt-1">
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => setStab({ zoom: autoZoom(s, (asset?.width ?? 16) / (asset?.height ?? 9)) })}
                    title="The least zoom that hides the edges at this smoothness"
                  >
                    <RotateCcw /> Fit zoom
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </Section>
  )
}
