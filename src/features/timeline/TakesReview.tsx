import { LoaderCircle, Pause, Play, Repeat2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tip } from '@/components/ui/tooltip'
import { playback, usePlayback } from '@/editor/playback'
import { SURE, timelineRetakes, type RetakeGroup, type Take } from '@/editor/retakes'
import { untranscribed } from '@/editor/smart'
import { clock, defaultChoices, removeSpeech, takesToRemove } from '@/editor/speech-cuts'
import { getProject, useEditor } from '@/editor/store'
import { cn } from '@/lib/cn'
import { ensureTranscripts } from '@/project/transcribe'

type Choice = number | 'all'

const KIND: Record<RetakeGroup['kind'], string> = {
  restart: 'False start',
  repeat: 'Said twice',
  similar: 'Said again',
  stumble: 'Stumble',
}

// ─── Hearing a take ──────────────────────────────────────────────────────

let stopPreview: (() => void) | null = null

/** Plays timeline seconds [from, to) with a moment either side, then stops. */
function preview(from: number, to: number, onEnd: () => void) {
  stopPreview?.()
  const fps = getProject().settings.fps
  const end = Math.round((to + 0.15) * fps)
  playback.pause()
  playback.seek(Math.max(0, Math.round((from - 0.3) * fps)))
  playback.play()
  const done = () => {
    unsub()
    stopPreview = null
    onEnd()
  }
  const unsub = usePlayback.subscribe((s) => {
    if (s.playing && s.frame < end) return
    if (s.playing) playback.pause()
    done()
  })
  stopPreview = () => {
    playback.pause()
    done()
  }
}

// ─── The review ──────────────────────────────────────────────────────────

/** Repeated takes in the speech: hear each take, choose the one to keep (or keep them all), and cut the rest in one step. */
export function TakesReview() {
  const [open, setOpen] = useState(false)
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) stopPreview?.()
      }}
    >
      <Tip content="Repeated takes — lines said more than once">
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Repeated takes"
            className="flex h-7 items-center rounded-lg px-1.5 text-fg-3 outline-none transition-colors hover:bg-white/[0.06] hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/60 data-[state=open]:bg-white/[0.08] data-[state=open]:text-fg"
          >
            <Repeat2 className="size-4" />
          </button>
        </PopoverTrigger>
      </Tip>
      <PopoverContent align="end" className="w-[460px] p-0" onOpenAutoFocus={(e) => e.preventDefault()}>
        {open && <TakesPanel />}
      </PopoverContent>
    </Popover>
  )
}

function TakesPanel() {
  const clips = useEditor((s) => s.project.clips)
  const assets = useEditor((s) => s.project.assets)
  const tracks = useEditor((s) => s.project.tracks)
  const { groups, sentences } = useMemo(() => timelineRetakes(getProject()), [clips, assets, tracks]) // eslint-disable-line react-hooks/exhaustive-deps
  const pending = useMemo(() => untranscribed(getProject()), [clips, assets]) // eslint-disable-line react-hooks/exhaustive-deps
  const [choices, setChoices] = useState<Record<string, Choice>>({})
  const [playing, setPlaying] = useState<string | null>(null)
  const [busy, setBusy] = useState<'cut' | 'transcribe' | null>(null)

  // New groups start on their suggestion when it's sure, on keeping every take when it isn't.
  useEffect(() => {
    setChoices((prev) => ({ ...defaultChoices(groups, SURE), ...Object.fromEntries(Object.entries(prev).filter(([id]) => groups.some((g) => g.id === id))) }))
  }, [groups])
  useEffect(() => () => stopPreview?.(), [])

  const choice = (g: RetakeGroup): Choice => choices[g.id] ?? (g.confidence >= SURE ? g.keep : 'all')
  const cutting = groups.filter((g) => choice(g) !== 'all')
  const going = cutting.reduce((s, g) => s + g.takes.length - 1, 0)
  const seconds = cutting.reduce((s, g) => s + g.takes.reduce((t, take, i) => t + (i === choice(g) ? 0 : take.end - take.start), 0), 0)
  const sure = groups.filter((g) => g.confidence >= SURE)
  const unsure = groups.filter((g) => g.confidence < SURE)

  const hear = (key: string, take: Take) => {
    if (playing === key) {
      stopPreview?.()
      return
    }
    setPlaying(key)
    preview(take.start, take.end, () => setPlaying((k) => (k === key ? null : k)))
  }

  const apply = async () => {
    stopPreview?.()
    setBusy('cut')
    try {
      const chosen = Object.fromEntries(groups.map((g) => [g.id, choice(g)]))
      const r = await removeSpeech(takesToRemove(groups, chosen), { label: going === 1 ? 'Cut a repeated take' : 'Cut repeated takes', source: 'user' })
      if (!r.cuts.length) toast.error('Nothing was cut', { description: r.refused.map((x) => `${x.what}: ${x.reason}`).join('\n') })
      else
        toast.success(`${r.refused.length ? 'Cut some of the takes' : going === 1 ? 'Cut a take' : `Cut ${going} takes`} (${r.seconds.toFixed(1)} s)`, {
          description: [
            r.remaining.length ? `${r.remaining.length} repeat${r.remaining.length > 1 ? 's' : ''} still nearby` : 'No repetition left around the cuts',
            ...r.refused.map((x) => `Kept ${x.what}: ${x.reason}`),
          ].join('\n'),
        })
    } catch (err) {
      toast.error('Couldn’t cut the takes', { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(null)
    }
  }

  const transcribe = async () => {
    setBusy('transcribe')
    await ensureTranscripts(pending)
    setBusy(null)
  }

  return (
    <div className="flex max-h-[min(620px,70vh)] flex-col">
      <div className="border-b border-line px-3.5 py-2.5">
        <div className="text-sm font-semibold text-fg">Repeated takes</div>
        <div className="text-2xs text-fg-4">
          {groups.length
            ? `${groups.length} ${groups.length === 1 ? 'place' : 'places'} a line is said more than once · ${sentences.length} sentences read`
            : sentences.length
              ? `No repeats in ${sentences.length} sentences — lines said again in other words are for the Copilot to spot`
              : 'Lines said more than once in the speech, from its transcript'}
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2.5">
        {pending.length > 0 && (
          <div className="flex items-center gap-3 rounded-xl bg-white/[0.025] p-3 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]">
            <p className="min-w-0 flex-1 text-xs leading-relaxed text-fg-3">
              {pending.length === 1 ? 'A clip with speech has' : `${pending.length} clips with speech have`} no transcript yet. Takes are found from what’s said.
            </p>
            <Button size="xs" variant="secondary" disabled={busy !== null} onClick={() => void transcribe()}>
              {busy === 'transcribe' && <LoaderCircle className="animate-spin" />}
              Transcribe
            </Button>
          </div>
        )}
        {!groups.length && !pending.length && <p className="py-8 text-center text-sm text-fg-3">{sentences.length ? 'Every line is said once.' : 'There’s no transcribed speech on the timeline.'}</p>}
        {sure.length > 0 && <SectionLabel>Ready to cut</SectionLabel>}
        {sure.map((g) => (
          <GroupCard key={g.id} group={g} choice={choice(g)} onChoose={(c) => setChoices((s) => ({ ...s, [g.id]: c }))} playing={playing} onHear={hear} />
        ))}
        {unsure.length > 0 && <SectionLabel>Your call — kept unless you choose</SectionLabel>}
        {unsure.map((g) => (
          <GroupCard key={g.id} group={g} choice={choice(g)} onChoose={(c) => setChoices((s) => ({ ...s, [g.id]: c }))} playing={playing} onHear={hear} />
        ))}
      </div>

      {groups.length > 0 && (
        <div className="flex items-center justify-end gap-2 border-t border-line bg-black/15 px-3.5 py-2.5">
          <span className="min-w-0 flex-1 truncate text-2xs text-fg-4 tabular">
            {going ? `${going === 1 ? '1 take goes' : `${going} takes go`} · about ${seconds.toFixed(1)} s` : 'Choose a take to keep in a group to cut the others'}
          </span>
          <Button size="sm" variant="primary" disabled={!cutting.length || busy !== null} onClick={() => void apply()}>
            {busy === 'cut' && <LoaderCircle className="animate-spin" />}
            Apply
          </Button>
        </div>
      )}
    </div>
  )
}

function SectionLabel({ children }: { children: string }) {
  return <div className="px-1 pt-1.5 text-2xs font-semibold tracking-wider text-fg-4 uppercase">{children}</div>
}

function GroupCard({ group: g, choice, onChoose, playing, onHear }: { group: RetakeGroup; choice: Choice; onChoose: (c: Choice) => void; playing: string | null; onHear: (key: string, take: Take) => void }) {
  const sure = g.confidence >= SURE
  return (
    <div className="rounded-xl bg-white/[0.025] p-2.5 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]">
      <div className="mb-1.5 flex items-center gap-2 px-0.5">
        <span className="text-xs font-medium text-fg-2">{g.takes.length > 2 && g.kind !== 'stumble' ? `Said ${g.takes.length} times` : KIND[g.kind]}</span>
        <span className="font-mono text-2xs text-fg-4 tabular">{clock(g.takes[0].start)}</span>
        <span className={cn('ml-auto rounded-full px-1.5 py-px text-2xs font-medium tabular', sure ? 'bg-accent/12 text-accent-2' : 'bg-white/[0.06] text-fg-3')} title="How sure the suggestion is">
          {sure ? 'Sure' : 'Unsure'} · {Math.round(g.confidence * 100)}%
        </span>
      </div>
      {g.stumble && <p className="mb-1.5 line-clamp-2 px-0.5 text-2xs leading-relaxed text-fg-4">In “{g.stumble.sentence}”</p>}
      <div className="space-y-0.5">
        {g.takes.map((t, i) => {
          const key = `${g.id}:${i}`
          const kept = choice === 'all' || choice === i
          return (
            <div key={key} className={cn('group/take flex items-center gap-2 rounded-lg px-1 py-1 transition-colors', choice === i ? 'bg-accent/10' : 'hover:bg-white/[0.04]')}>
              <button
                type="button"
                aria-label={playing === key ? 'Stop' : `Hear take ${i + 1}`}
                onClick={() => onHear(key, t)}
                className={cn('grid size-7 shrink-0 place-items-center rounded-lg transition-colors', playing === key ? 'bg-accent text-accent-fg' : 'bg-white/[0.05] text-fg-2 hover:bg-white/[0.1] hover:text-fg')}
              >
                {playing === key ? <Pause className="size-3" fill="currentColor" /> : <Play className="size-3" fill="currentColor" />}
              </button>
              <button type="button" onClick={() => onChoose(i)} className="flex min-w-0 flex-1 items-center gap-2 text-left" title="Keep this take">
                <span className={cn('grid size-3.5 shrink-0 place-items-center rounded-full ring-1 ring-inset', choice === i ? 'bg-accent ring-accent' : 'ring-line-3')}>{choice === i && <span className="size-1.5 rounded-full bg-accent-fg" />}</span>
                <span className={cn('min-w-0 flex-1 text-xs leading-snug', kept ? 'text-fg' : 'text-fg-4 line-through decoration-fg-4/60')}>
                  <span className="line-clamp-2">{t.text}</span>
                </span>
                <span className="shrink-0 font-mono text-2xs text-fg-4 tabular">{clock(t.start)}</span>
                <span className={cn('w-8 shrink-0 text-right text-2xs font-medium', choice === 'all' ? 'text-fg-4' : kept ? 'text-accent-2' : 'text-fg-4')}>{choice === 'all' ? '' : kept ? 'Keep' : 'Cut'}</span>
              </button>
            </div>
          )
        })}
      </div>
      <div className="mt-1.5 flex items-start gap-2 px-0.5">
        <p className="min-w-0 flex-1 text-2xs leading-relaxed text-fg-4">{g.reason}</p>
        <button
          type="button"
          onClick={() => onChoose('all')}
          className={cn('shrink-0 rounded-md px-1.5 py-0.5 text-2xs font-medium transition-colors', choice === 'all' ? 'bg-white/[0.09] text-fg' : 'text-fg-3 hover:bg-white/[0.06] hover:text-fg-2')}
        >
          Keep all
        </button>
      </div>
    </div>
  )
}
