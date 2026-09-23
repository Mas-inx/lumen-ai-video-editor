import { AudioLines, Circle, Mic, Music, Pause, Play, Plus, Sparkles, Square, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { SearchInput } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { placeAsset } from '@/editor/placement'
import { playback, usePlayback } from '@/editor/playback'
import { getProject } from '@/editor/store'
import { useUI } from '@/editor/ui-store'
import { SFX, type SfxDef } from '@/engine/sfx'
import { dnd } from '@/features/dnd'
import { cn } from '@/lib/cn'
import { desktop } from '@/lib/platform'
import { formatSeconds } from '@/lib/time'
import { auditionSfx, cancelRecording, finishRecording, inputLevel, sfxAsset, startRecording, stopAudition, type Recording } from '@/project/audio-library'
import { useGenerate } from './generate-store'
import { PanelHeader, scrollArea, SectionLabel } from './shared'

const CATEGORIES: SfxDef['category'][] = ['Transitions', 'Impacts', 'UI & accents', 'Atmosphere']

export function AudioPanel() {
  const [query, setQuery] = useState('')
  const items = SFX.filter((s) => !query || `${s.name} ${s.description} ${s.category}`.toLowerCase().includes(query.toLowerCase()))
  return (
    <>
      <PanelHeader title="Audio" />
      <div className={scrollArea}>
        <RecordCard />
        <GenerateCards />
        <SectionLabel right={<span className="text-2xs text-fg-4">Made in Lumen · free to use</span>}>Sound effects</SectionLabel>
        <SearchInput value={query} onChange={setQuery} placeholder="Search sounds…" />
        {CATEGORIES.map((cat) => {
          const list = items.filter((s) => s.category === cat)
          if (!list.length) return null
          return (
            <div key={cat}>
              <div className="mt-3 mb-1 px-0.5 text-2xs font-medium text-fg-4">{cat}</div>
              <div className="space-y-0.5">
                {list.map((s) => (
                  <SfxRow key={s.id} sfx={s} />
                ))}
              </div>
            </div>
          )
        })}
        {!items.length && <p className="mt-6 text-center text-sm text-fg-4">No sounds match “{query}”.</p>}
      </div>
    </>
  )
}

// ─── Sound effects ───────────────────────────────────────────────────────

let playingId: string | null = null
const playListeners = new Set<() => void>()
const setPlaying = (id: string | null) => {
  playingId = id
  playListeners.forEach((fn) => fn())
}

function SfxRow({ sfx }: { sfx: SfxDef }) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const fn = () => setTick((t) => t + 1)
    playListeners.add(fn)
    return () => void playListeners.delete(fn)
  }, [])
  const playing = playingId === sfx.id
  const [adding, setAdding] = useState(false)

  const toggle = () => {
    if (playing) {
      stopAudition()
      setPlaying(null)
    } else {
      setPlaying(sfx.id)
      void auditionSfx(sfx.id, () => playingId === sfx.id && setPlaying(null))
    }
  }
  const add = async () => {
    if (adding) return
    setAdding(true)
    try {
      const assetId = await sfxAsset(sfx.id)
      const id = placeAsset(assetId, usePlayback.getState().frame)
      if (id) useUI.getState().select([id])
    } catch (err) {
      toast.error(`Couldn’t add ${sfx.name}`, { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setAdding(false)
    }
  }

  return (
    <div
      draggable
      onDragStart={(e) => dnd.start(e, { type: 'sfx', sfxId: sfx.id }, sfx.name)}
      onDragEnd={dnd.end}
      onDoubleClick={() => void add()}
      className="group/row flex h-12 cursor-grab items-center gap-2.5 rounded-[10px] px-1.5 transition-colors hover:bg-white/[0.04] active:cursor-grabbing"
    >
      <button
        type="button"
        aria-label={playing ? `Stop ${sfx.name}` : `Play ${sfx.name}`}
        onClick={toggle}
        className={cn('grid size-9 shrink-0 place-items-center rounded-lg transition-colors', playing ? 'bg-accent text-accent-fg' : 'bg-white/[0.05] text-fg-2 hover:bg-white/[0.1] hover:text-fg')}
      >
        {playing ? <Pause className="size-3.5" fill="currentColor" /> : <Play className="size-3.5" fill="currentColor" />}
      </button>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-fg-2 group-hover/row:text-fg">{sfx.name}</div>
        <div className="truncate text-2xs text-fg-4">{sfx.description}</div>
      </div>
      <span className="shrink-0 font-mono text-2xs text-fg-4 tabular">{formatSeconds(sfx.duration)}</span>
      <button
        type="button"
        aria-label={`Add ${sfx.name} at playhead`}
        onClick={() => void add()}
        disabled={adding || !desktop}
        className="grid size-7 shrink-0 place-items-center rounded-full bg-white/[0.06] text-fg-2 opacity-0 transition-[opacity,background-color] group-hover/row:opacity-100 hover:bg-white hover:text-black disabled:opacity-40"
      >
        <Plus className="size-3.5" />
      </button>
    </div>
  )
}

// ─── Generate ────────────────────────────────────────────────────────────

function GenerateCards() {
  const open = (mode: 'music' | 'sfx' | 'voice') => {
    useGenerate.setState({ engine: 'media', mode })
    useUI.getState().setLeftTab('generate')
  }
  const cards = [
    { mode: 'music' as const, icon: <Music />, title: 'Music', hint: 'Score from a prompt' },
    { mode: 'sfx' as const, icon: <Sparkles />, title: 'Sound effect', hint: 'Describe any sound' },
    { mode: 'voice' as const, icon: <AudioLines />, title: 'Voiceover', hint: 'Text to speech' },
  ]
  return (
    <>
      <SectionLabel>Generate with AI</SectionLabel>
      <div className="grid grid-cols-3 gap-1.5">
        {cards.map((c) => (
          <button
            key={c.mode}
            type="button"
            onClick={() => open(c.mode)}
            className="rounded-xl bg-white/[0.03] p-2.5 text-left shadow-[inset_0_0_0_1px_rgb(255_255_255/0.05)] transition-colors hover:bg-white/[0.06] [&_svg]:size-4"
          >
            <span className="text-accent-2">{c.icon}</span>
            <div className="mt-1.5 text-xs font-medium text-fg">{c.title}</div>
            <div className="text-2xs leading-snug text-fg-4">{c.hint}</div>
          </button>
        ))}
      </div>
    </>
  )
}

// ─── Voiceover recording ─────────────────────────────────────────────────

function voiceTrack() {
  const p = getProject()
  const audio = p.tracks.filter((t) => t.kind === 'audio' && !t.locked)
  return (audio.find((t) => /voice|vo\b|narrat/i.test(t.name)) ?? audio[0])?.id
}

function RecordCard() {
  const [rec, setRec] = useState<Recording | null>(null)
  const [level, setLevel] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [playAlong, setPlayAlong] = useState(true)
  const [saving, setSaving] = useState(false)
  const startFrame = useRef(0)

  useEffect(() => {
    if (!rec) return
    let raf = 0
    const tick = () => {
      setLevel(inputLevel(rec))
      setElapsed((performance.now() - rec.startedAt) / 1000)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [rec])

  const start = async () => {
    try {
      startFrame.current = usePlayback.getState().frame
      const r = await startRecording()
      setRec(r)
      if (playAlong) playback.play()
    } catch {
      toast.error('Microphone unavailable', { description: 'Allow Lumen to use the microphone in your system settings, then try again.' })
    }
  }

  const stop = async () => {
    if (!rec) return
    playback.pause()
    setSaving(true)
    const stamp = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    try {
      const asset = await finishRecording(rec, `Voiceover ${stamp}`)
      if (asset) {
        const id = placeAsset(asset.id, startFrame.current, { trackId: voiceTrack() })
        if (id) useUI.getState().select([id])
        toast.success('Voiceover recorded', { description: `${formatSeconds(asset.duration ?? 0)} · added at the playhead` })
      }
    } catch (err) {
      toast.error('Couldn’t save the recording', { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setRec(null)
      setSaving(false)
    }
  }

  const cancel = () => {
    if (!rec) return
    playback.pause()
    cancelRecording(rec)
    setRec(null)
  }

  if (rec) {
    return (
      <div className="mt-1 rounded-xl bg-danger/[0.07] p-3 shadow-[inset_0_0_0_1px_rgb(255_93_93/0.25)]">
        <div className="flex items-center gap-2">
          <Circle className="size-2.5 animate-pulse-soft text-danger" fill="currentColor" />
          <span className="text-sm font-medium text-fg">Recording</span>
          <span className="ml-auto font-mono text-sm text-fg tabular">{formatSeconds(elapsed)}</span>
        </div>
        <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-white/[0.08]">
          <div className={cn('h-full rounded-full transition-[width] duration-75', level > 0.9 ? 'bg-danger' : level > 0.5 ? 'bg-warn' : 'bg-ok')} style={{ width: `${Math.min(100, level * 110)}%` }} />
        </div>
        <div className="mt-3 flex gap-2">
          <Button variant="primary" size="sm" className="flex-1" onClick={() => void stop()} disabled={saving}>
            <Square className="size-3" fill="currentColor" /> Stop & add
          </Button>
          <Button variant="ghost" size="sm" onClick={cancel} disabled={saving}>
            <X /> Discard
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="mt-1 rounded-xl bg-white/[0.03] p-3 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.05)]">
      <div className="flex items-center gap-2.5">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-danger/15 text-danger">
          <Mic className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-fg">Record a voiceover</div>
          <div className="text-2xs text-fg-4">Lands at the playhead on your voice track</div>
        </div>
        <Button variant="secondary" size="sm" onClick={() => void start()} disabled={!desktop}>
          <Circle className="size-2.5 text-danger" fill="currentColor" /> Record
        </Button>
      </div>
      <label className="mt-2.5 flex items-center justify-between gap-2 text-2xs text-fg-3">
        Play the timeline while recording
        <Switch aria-label="Play the timeline while recording" checked={playAlong} onChange={setPlayAlong} />
      </label>
    </div>
  )
}
