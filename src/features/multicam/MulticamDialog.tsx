import { AudioLines, Check, LoaderCircle, Video, VolumeX } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Row } from '@/components/ui/section'
import { Segmented } from '@/components/ui/segmented'
import { Select } from '@/components/ui/select'
import { usePlayback } from '@/editor/playback'
import { freshName } from '@/editor/sequences'
import { dispatch, getProject, useEditor } from '@/editor/store'
import { useUI } from '@/editor/ui-store'
import { assetThumb } from '@/features/assets/shared'
import { cn } from '@/lib/cn'
import { formatSeconds } from '@/lib/time'
import { multicamFromAssets } from '@/project/analysis-actions'

type SyncBy = 'sound' | 'start'

/** Makes a multicam clip: pick the camera angles, line them up by their sound, choose whose sound you hear. */
export function MulticamDialog() {
  const request = useUI((s) => s.multicam)
  const videos = useEditor(useShallow((s) => Object.values(s.project.assets).filter((a) => a.kind === 'video' && !(a.source.type === 'file' && a.source.missing))))
  const [chosen, setChosen] = useState<string[]>([])
  const [name, setName] = useState('')
  const [sync, setSync] = useState<SyncBy>('sound')
  const [audio, setAudio] = useState('auto')
  const [busy, setBusy] = useState<number | null>(null)

  useEffect(() => {
    if (!request) return
    setChosen(request.assetIds)
    setName(freshName(getProject(), 'Multicam'))
    setSync('sound')
    setAudio('auto')
    setBusy(null)
  }, [request])

  const angles = useMemo(() => videos.filter((v) => chosen.includes(v.id)), [videos, chosen])
  const close = () => busy === null && useUI.getState().setMulticam(null)
  const toggle = (id: string) => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id].slice(0, 16)))

  const create = async () => {
    if (angles.length < 2) return
    const ids = videos.filter((v) => chosen.includes(v.id)).map((v) => v.id)
    const audioIndex = audio === 'auto' ? undefined : ids.indexOf(audio)
    try {
      if (sync === 'start') {
        const res = dispatch('multicam.create', { name, angles: ids.map((assetId) => ({ assetId, offset: 0 })), audio: audioIndex ?? 0, start: usePlayback.getState().frame })
        if (!res.ok) throw new Error(res.error)
        const r = res.result as { clipId: string | null }
        if (r.clipId) useUI.getState().select([r.clipId])
      } else {
        setBusy(0)
        const r = await multicamFromAssets(ids, { name, audio: audioIndex }, (p) => setBusy(p))
        if (r.clipId) useUI.getState().select([r.clipId])
        const weak = r.sync.filter((s) => Number.isFinite(s.confidence) && s.confidence < 6)
        if (weak.length) toast.warning(`Synced — but ${weak.map((w) => `“${w.name}”`).join(', ')} barely matched`, { description: 'Their sound didn’t line up clearly. Check them in the multicam timeline, or sync by the start of each file.' })
        else toast.success(`Synced ${plural(ids.length)} by their sound`, { description: 'Press 1–9 while it plays to cut between cameras.' })
      }
      useUI.getState().setAngleViewer(true)
      setBusy(null)
      useUI.getState().setMulticam(null)
    } catch (err) {
      setBusy(null)
      toast.error('Couldn’t make the multicam clip', { description: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <Dialog open={Boolean(request)} onOpenChange={(o) => !o && close()} title="New multicam clip" description="Several cameras filming the same moment, lined up so you can cut between them as it plays." className="w-[min(620px,calc(100vw-32px))]">
      <div className="space-y-3 px-5 pb-2">
        <div>
          <div className="mb-1.5 flex items-baseline justify-between">
            <span className="text-xs font-medium text-fg-2">Cameras</span>
            <span className="text-2xs text-fg-4">{angles.length} chosen · at least 2</span>
          </div>
          <div className="max-h-[260px] space-y-1 overflow-y-auto rounded-xl bg-black/20 p-1.5 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.04)]">
            {!videos.length && <p className="py-6 text-center text-xs text-fg-4">Import the camera recordings first.</p>}
            {videos.map((v) => {
              const on = chosen.includes(v.id)
              const n = chosen.indexOf(v.id)
              const thumb = assetThumb(v)
              return (
                <button
                  key={v.id}
                  type="button"
                  disabled={busy !== null}
                  onClick={() => toggle(v.id)}
                  className={cn('flex w-full items-center gap-2.5 rounded-lg p-1.5 text-left transition-colors', on ? 'bg-accent/10 shadow-[inset_0_0_0_1px_rgb(214_238_0/0.3)]' : 'hover:bg-white/[0.04]')}
                >
                  <span className={cn('grid size-5 shrink-0 place-items-center rounded-md text-[10px] font-bold', on ? 'bg-accent text-accent-fg' : 'bg-white/[0.06] text-transparent')}>{on ? videos.filter((x) => chosen.includes(x.id)).findIndex((x) => x.id === v.id) + 1 : <Check className="size-3" />}</span>
                  <span className="relative aspect-video w-16 shrink-0 overflow-hidden rounded-md bg-surface-3">{thumb && <img src={thumb} alt="" className="h-full w-full object-cover" />}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-fg">{v.name}</span>
                    <span className="flex items-center gap-1.5 text-2xs text-fg-4">
                      {formatSeconds(v.duration ?? 0)}
                      {v.hasAudio === false ? (
                        <span className="flex items-center gap-0.5 text-warn">
                          <VolumeX className="size-3" /> no sound
                        </span>
                      ) : (
                        <span className="flex items-center gap-0.5">
                          <AudioLines className="size-3" /> sound
                        </span>
                      )}
                    </span>
                  </span>
                  {n >= 0 && <Video className="size-3.5 shrink-0 text-accent-2" />}
                </button>
              )
            })}
          </div>
        </div>
        <Row label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} disabled={busy !== null} />
        </Row>
        <Row label="Line up by">
          <Segmented
            value={sync}
            onChange={setSync}
            options={[
              { value: 'sound', label: 'Their sound' },
              { value: 'start', label: 'Start of each file' },
            ]}
          />
        </Row>
        <Row label="Sound from">
          <Select
            aria-label="Sound from"
            value={audio}
            onChange={setAudio}
            className="w-full"
            options={[{ value: 'auto', label: 'The longest recording with sound' }, ...angles.filter((a) => a.hasAudio !== false).map((a) => ({ value: a.id, label: a.name }))]}
          />
        </Row>
        <p className="text-2xs leading-relaxed text-fg-4">
          {sync === 'sound'
            ? 'Lumen listens to every recording and lines them up by what they heard — claps, speech, music — to about a millisecond. Each camera’s sound is kept (muted) in the multicam timeline.'
            : 'Every file starts at the same moment — for recorders started together or with matching timecode.'}
        </p>
      </div>
      <div className="flex items-center gap-3 border-t border-line bg-black/15 px-5 py-3.5">
        {busy !== null ? (
          <div className="min-w-0 flex-1">
            <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.08]">
              <div className="h-full rounded-full bg-gradient-to-r from-accent to-ai-2 transition-[width] duration-150" style={{ width: `${Math.max(4, busy * 100)}%` }} />
            </div>
            <div className="mt-1.5 flex items-center gap-1.5 text-2xs text-fg-4">
              <LoaderCircle className="size-3 animate-spin" /> Listening to the recordings…
            </div>
          </div>
        ) : (
          <div className="flex-1 text-xs text-fg-4">{angles.length >= 2 ? `${plural(angles.length)} → one clip on the main track at the playhead` : 'Choose two or more cameras'}</div>
        )}
        <Button variant="ghost" onClick={close} disabled={busy !== null}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => void create()} disabled={angles.length < 2 || busy !== null || !name.trim()}>
          <Video /> Create
        </Button>
      </div>
    </Dialog>
  )
}

const plural = (n: number) => `${n} camera${n === 1 ? '' : 's'}`
