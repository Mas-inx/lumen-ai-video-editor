import { Check } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { splitAudioClips } from '@/editor/ops'
import { dispatch, getProject, useEditor } from '@/editor/store'
import { useUI } from '@/editor/ui-store'
import { cn } from '@/lib/cn'

interface Remembered {
  picked: number[]
  labels: Record<number, string>
}

/** Choices are remembered per number of tracks, so a recording setup that always has five tracks comes back as you left it. */
const memoryKey = (count: number) => `lumen.audioTracks.${count}`

function recall(count: number): Remembered | null {
  try {
    const raw = localStorage.getItem(memoryKey(count))
    return raw ? (JSON.parse(raw) as Remembered) : null
  } catch {
    return null
  }
}

function remember(count: number, value: Remembered) {
  try {
    localStorage.setItem(memoryKey(count), JSON.stringify(value))
  } catch {
    /* storage can be unavailable; the choice just isn't remembered */
  }
}

/**
 * Audio tracks of a multi-track recording (mic, game, comms…): pick which go on the
 * timeline, each on its own track so one — a cough on the mic — can be muted or cut alone.
 */
export function AudioTracksDialog() {
  const clipId = useUI((s) => s.audioTracksClipId)
  const clip = useEditor((s) => (clipId ? s.project.clips[clipId] : undefined))
  const asset = useEditor((s) => (clip?.assetId ? s.project.assets[clip.assetId] : undefined))
  const streams = asset?.audioTracks ?? []
  const open = Boolean(clip && streams.length > 1)
  const [picked, setPicked] = useState<number[]>([])
  const [labels, setLabels] = useState<Record<number, string>>({})

  // Start from what is already split out; otherwise from the last choice for a recording like this; otherwise every track.
  useEffect(() => {
    if (!clipId) return
    const project = getProject()
    const current = project.clips[clipId]
    const list = (current?.assetId ? project.assets[current.assetId]?.audioTracks : undefined) ?? []
    if (!current || list.length < 2) return
    const existing = splitAudioClips(project, current)
    if (existing.size) {
      setPicked([...existing.keys()].sort((a, b) => a - b))
      setLabels(Object.fromEntries([...existing].map(([i, c]) => [i, c.name])))
      return
    }
    const saved = recall(list.length)
    setPicked(saved?.picked.filter((i) => list.some((s) => s.index === i)) ?? list.map((s) => s.index))
    setLabels(saved?.labels ?? {})
  }, [clipId])

  const close = () => useUI.getState().setAudioTracksClip(null)
  const toggle = (i: number) => setPicked((p) => (p.includes(i) ? p.filter((x) => x !== i) : [...p, i].sort((a, b) => a - b)))
  const labelOf = (i: number) => labels[i] ?? streams.find((s) => s.index === i)?.name ?? ''

  const apply = () => {
    if (!clip) return close()
    const names = Object.fromEntries(picked.map((i) => [String(i), labelOf(i).trim()]).filter(([, name]) => name))
    const res = dispatch('clip.splitAudioTracks', { id: clip.id, tracks: picked, names })
    if (!res.ok) return void toast(res.error)
    remember(streams.length, { picked, labels: Object.fromEntries(picked.map((i) => [i, labelOf(i).trim()])) })
    close()
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="Audio tracks"
      description={clip ? `“${clip.name}” has ${streams.length} audio tracks. Each one you tick goes on its own timeline track.` : undefined}
      className="w-[min(520px,calc(100vw-32px))]"
    >
      <div className="space-y-1 px-5 pb-3">
        {streams.map((s) => {
          const on = picked.includes(s.index)
          return (
            <div key={s.index} className={cn('flex items-center gap-3 rounded-lg px-3 py-2 transition-colors', on ? 'bg-accent/10' : 'hover:bg-white/[0.04]')}>
              <button
                type="button"
                aria-label={`Track ${s.index + 1}`}
                aria-pressed={on}
                onClick={() => toggle(s.index)}
                className={cn('grid size-4 shrink-0 place-items-center rounded-[5px] ring-1 ring-inset', on ? 'bg-accent text-accent-fg ring-accent' : 'ring-line-2')}
              >
                {on && <Check className="size-3" strokeWidth={3} />}
              </button>
              <span className="w-14 shrink-0 text-xs text-fg-3 tabular">Track {s.index + 1}</span>
              <Input
                value={labelOf(s.index)}
                placeholder={`Audio ${s.index + 1}`}
                disabled={!on}
                onChange={(e) => setLabels((l) => ({ ...l, [s.index]: e.target.value }))}
                aria-label={`Name for track ${s.index + 1}`}
                className="h-8 min-w-0 flex-1"
              />
              <span className="shrink-0 text-2xs text-fg-4">
                {s.channels === 1 ? 'mono' : s.channels === 2 ? 'stereo' : `${s.channels} ch`}
                {s.codec ? ` · ${s.codec}` : ''}
              </span>
            </div>
          )
        })}
        <p className="px-3 pt-2 text-2xs leading-relaxed text-fg-4">
          Leave out a track that already mixes the others (a “everything combined” backup) or it will play twice. Name a track “Voice …” so Remove pauses treats it as speech, or “… Sync” so it
          is cut along with the video.
        </p>
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-line bg-black/15 px-5 py-3.5">
        <Button variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button variant="primary" onClick={apply}>
          {picked.length ? `Use ${picked.length} of ${streams.length} tracks` : 'Keep sound in the video'}
        </Button>
      </div>
    </Dialog>
  )
}
