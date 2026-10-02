/**
 * The mixer: a channel strip per track that makes sound, and the master bus.
 * Faders and pan glide live while playing; meters read the real signal after
 * each channel's processing. Pick a strip to edit its EQ, compressor and limiter.
 */
import { AudioLines, Film, Headphones, Music, VolumeX } from 'lucide-react'
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Slider } from '@/components/ui/slider'
import { DEFAULT_BUS } from '@/editor/defaults'
import { dispatch, useEditor } from '@/editor/store'
import type { BusMix, Track } from '@/editor/types'
import { audioEngine } from '@/engine/audio-engine'
import { onMeterFrame } from '@/engine/meter-clock'
import { cn } from '@/lib/cn'
import { ChannelEditor } from './ChannelEditor'
import { FADER_MARKS, faderDb, faderPos, formatDb, meterPos } from './scales'

type Target = 'master' | string

const setMix = (target: Target, patch: Partial<Pick<BusMix, 'volume' | 'pan'>>, key?: string) => dispatch('mix.update', { target, patch }, key ? { coalesce: key } : undefined)

export function MixerPanel() {
  // Tracks that can make sound: audio tracks, and video tracks holding video clips.
  const trackIds = useEditor(
    useShallow((s) => s.project.tracks.filter((t) => t.kind === 'audio' || Object.values(s.project.clips).some((c) => c.trackId === t.id && c.kind === 'video')).map((t) => t.id)),
  )
  const [selected, setSelected] = useState<Target>('master')
  const exists = useEditor((s) => selected === 'master' || s.project.tracks.some((t) => t.id === selected))
  const target = exists ? selected : 'master'

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 gap-1.5 px-3 pt-2.5 pb-2.5">
        <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto">
          {trackIds.map((id) => (
            <TrackStrip key={id} id={id} selected={target === id} onSelect={() => setSelected(id)} />
          ))}
          {!trackIds.length && <p className="self-center px-2 text-xs text-fg-4">Tracks with sound show up here.</p>}
        </div>
        <div className="mx-0.5 w-px shrink-0 self-stretch bg-line-2" />
        <Strip target="master" name="Master" color="var(--color-accent)" icon={<Music />} mix={undefined} master selected={target === 'master'} onSelect={() => setSelected('master')} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto border-t border-line">
        <ChannelEditor target={target} />
      </div>
    </div>
  )
}

function TrackStrip({ id, selected, onSelect }: { id: string; selected: boolean; onSelect: () => void }) {
  const track = useEditor((s) => s.project.tracks.find((t) => t.id === id)) as Track | undefined
  const soloing = useEditor((s) => s.project.tracks.some((t) => t.solo))
  if (!track) return null
  const color = track.kind === 'video' ? 'var(--color-clip-video)' : 'var(--color-clip-audio)'
  return (
    <Strip
      target={id}
      name={track.name}
      color={color}
      icon={track.kind === 'video' ? <Film /> : <AudioLines />}
      mix={track.mix}
      track={track}
      dimmed={track.muted || (soloing && !track.solo)}
      selected={selected}
      onSelect={onSelect}
    />
  )
}

function Strip({
  target,
  name,
  color,
  icon,
  mix: trackMix,
  track,
  master,
  dimmed,
  selected,
  onSelect,
}: {
  target: Target
  name: string
  color: string
  icon: ReactNode
  mix: BusMix | undefined
  track?: Track
  master?: boolean
  dimmed?: boolean
  selected: boolean
  onSelect: () => void
}) {
  const masterMix = useEditor((s) => s.project.master)
  const mix = (master ? masterMix : trackMix) ?? DEFAULT_BUS
  const fx = [
    { label: 'EQ', on: Boolean(mix.eq?.enabled), present: Boolean(mix.eq) },
    { label: 'CMP', on: Boolean(mix.compressor?.enabled), present: Boolean(mix.compressor) },
    { label: 'LIM', on: Boolean(mix.limiter?.enabled), present: Boolean(mix.limiter) },
  ]
  const pan = mix.pan
  const panLabel = Math.abs(pan) < 0.005 ? 'C' : `${pan < 0 ? 'L' : 'R'}${Math.round(Math.abs(pan) * 100)}`

  return (
    <div
      onPointerDown={onSelect}
      className={cn(
        'flex w-[68px] shrink-0 flex-col items-stretch gap-1.5 rounded-xl bg-white/[0.03] p-1.5 pt-2 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.05)] transition-[background-color,box-shadow]',
        selected && 'bg-white/[0.06] shadow-[inset_0_0_0_1.5px_rgb(214_238_0/0.55)]',
        master && 'w-[76px]',
      )}
    >
      <div className="flex min-w-0 items-center gap-1 px-0.5">
        <span className="h-3 w-[3px] shrink-0 rounded-full" style={{ background: color }} />
        <span className="min-w-0 truncate text-2xs font-semibold text-fg-2" title={name}>
          {name}
        </span>
        <span className="sr-only">{icon}</span>
      </div>
      <div className="flex justify-between gap-0.5">
        {fx.map((f) => (
          <span
            key={f.label}
            className={cn(
              'grid h-4 flex-1 place-items-center rounded-[4px] text-[8.5px] font-bold tracking-wide',
              f.on ? 'bg-accent/20 text-accent-2' : f.present ? 'bg-white/[0.06] text-fg-4 line-through' : 'bg-white/[0.035] text-fg-4/60',
            )}
          >
            {f.label}
          </span>
        ))}
      </div>
      <div title={`Pan ${panLabel}`}>
        <Slider aria-label={`${name} pan`} value={pan} min={-1} max={1} step={0.01} bipolar defaultValue={0} onChange={(v) => setMix(target, { pan: Math.round(v * 100) / 100 }, `pan:${target}`)} />
        <div className="text-center font-mono text-[9px] text-fg-4 tabular">{panLabel}</div>
      </div>
      <div className={cn('flex h-[124px] justify-center gap-1.5', dimmed && 'opacity-40')}>
        <Meter target={target} />
        <Fader value={mix.volume} name={name} onChange={(db, key) => setMix(target, { volume: db }, key)} />
      </div>
      <div className="text-center font-mono text-[10.5px] font-medium text-fg-2 tabular">{formatDb(mix.volume)}</div>
      {track ? (
        <div className="flex gap-1">
          <button
            type="button"
            title={track.muted ? 'Unmute' : 'Mute'}
            onClick={() => dispatch('track.update', { id: track.id, patch: { muted: !track.muted } })}
            className={cn('grid h-6 flex-1 place-items-center rounded-md text-2xs font-bold transition-colors', track.muted ? 'bg-warn/25 text-warn' : 'bg-white/[0.05] text-fg-3 hover:bg-white/[0.09]')}
          >
            {track.muted ? <VolumeX className="size-3" /> : 'M'}
          </button>
          <button
            type="button"
            title={track.solo ? 'Unsolo' : 'Solo'}
            onClick={() => dispatch('track.update', { id: track.id, patch: { solo: !track.solo } })}
            className={cn('grid h-6 flex-1 place-items-center rounded-md text-2xs font-bold transition-colors', track.solo ? 'bg-accent/25 text-accent-2' : 'bg-white/[0.05] text-fg-3 hover:bg-white/[0.09]')}
          >
            {track.solo ? <Headphones className="size-3" /> : 'S'}
          </button>
        </div>
      ) : (
        <div className="grid h-6 place-items-center text-[9px] font-semibold tracking-wider text-fg-4 uppercase">Out</div>
      )}
    </div>
  )
}

/** A vertical fader with a console-style scale; Shift drags finely, double-click resets to 0 dB, the wheel nudges. */
function Fader({ value, name, onChange }: { value: number; name: string; onChange: (db: number, key: string) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const drag = (e: ReactPointerEvent) => {
    e.preventDefault()
    const el = ref.current!
    const r = el.getBoundingClientRect()
    const key = `fader:${name}:${Date.now()}`
    const startY = e.clientY
    const startPos = faderPos(value)
    const onThumb = (e.target as HTMLElement).dataset.thumb !== undefined
    const at = (ev: PointerEvent) => {
      if (onThumb || ev.shiftKey) return startPos - ((ev.clientY - startY) / r.height) * (ev.shiftKey ? 0.2 : 1)
      return 1 - (ev.clientY - r.top) / r.height
    }
    const apply = (ev: PointerEvent) => {
      const pos = Math.max(0, Math.min(1, at(ev)))
      let db = Math.round(faderDb(pos) * 10) / 10
      if (Math.abs(db) < 0.35 && !ev.altKey) db = 0
      onChange(db, key)
    }
    if (!onThumb) apply(e.nativeEvent)
    const up = () => {
      window.removeEventListener('pointermove', apply)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', apply)
    window.addEventListener('pointerup', up)
  }
  return (
    <div
      ref={ref}
      role="slider"
      aria-label={`${name} volume`}
      aria-valuemin={-60}
      aria-valuemax={12}
      aria-valuenow={value}
      tabIndex={0}
      onPointerDown={drag}
      onDoubleClick={() => onChange(0, `fader:${name}:reset`)}
      onWheel={(e) => onChange(Math.max(-60, Math.min(12, Math.round((value - Math.sign(e.deltaY) * 0.5) * 10) / 10)), `fader:${name}:wheel`)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault()
          e.stopPropagation()
          onChange(Math.max(-60, Math.min(12, Math.round((value + (e.key === 'ArrowUp' ? 0.5 : -0.5)) * 10) / 10)), `fader:${name}:key`)
        }
      }}
      className="group/fader relative w-5 cursor-ns-resize rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
    >
      <div className="absolute inset-y-1 left-1/2 w-[3px] -translate-x-1/2 rounded-full bg-black/50 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]" />
      {FADER_MARKS.map((m) => (
        <span key={m} className={cn('pointer-events-none absolute right-0 left-0 h-px', m === 0 ? 'bg-white/35' : 'bg-white/10')} style={{ bottom: `calc(${faderPos(m) * 100}% * 0.94 + 3%)` }} />
      ))}
      <span
        data-thumb
        className="absolute left-1/2 h-3 w-5 -translate-x-1/2 translate-y-1/2 cursor-grab rounded-[4px] bg-[linear-gradient(180deg,#f4f4f5,#b9b9bf)] shadow-[0_2px_6px_rgb(0_0_0/0.6),inset_0_-1px_0_rgb(0_0_0/0.25)] active:cursor-grabbing"
        style={{ bottom: `calc(${faderPos(value) * 100}% * 0.94 + 3%)` }}
      >
        <span className="pointer-events-none absolute top-1/2 right-1 left-1 h-px -translate-y-1/2 bg-black/50" />
      </span>
    </div>
  )
}

/** Stereo peak meter with ballistics, a peak hold and a clip light (click to reset). */
function Meter({ target }: { target: Target }) {
  const barL = useRef<HTMLDivElement>(null)
  const barR = useRef<HTMLDivElement>(null)
  const holdL = useRef<HTMLDivElement>(null)
  const holdR = useRef<HTMLDivElement>(null)
  const clip = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const bars = [barL, barR]
    const holds = [holdL, holdR]
    const shown = [-Infinity, -Infinity]
    const hold = [
      { db: -Infinity, at: 0 },
      { db: -Infinity, at: 0 },
    ]
    // The shared meter clock runs only while sound plays (and while the meters fall back).
    return onMeterFrame((now, dt) => {
      const lv = audioEngine.levels(target) ?? [-Infinity, -Infinity]
      for (let i = 0; i < 2; i++) {
        // Instant attack, a 24 dB/s fall.
        shown[i] = Math.max(lv[i], (Number.isFinite(shown[i]) ? shown[i] : -60) - 24 * dt)
        if (shown[i] <= -60) shown[i] = -Infinity
        const pos = meterPos(shown[i])
        bars[i].current?.style.setProperty('clip-path', `inset(${((1 - pos) * 100).toFixed(2)}% 0 0 0)`)
        if (lv[i] >= hold[i].db || now - hold[i].at > 1400) hold[i] = { db: lv[i], at: now }
        const h = holds[i].current
        if (h) {
          h.style.bottom = `${meterPos(hold[i].db) * 100}%`
          h.style.opacity = Number.isFinite(hold[i].db) && hold[i].db > -60 ? '1' : '0'
        }
        if (lv[i] > -0.1 && clip.current) clip.current.dataset.on = 'true'
      }
    })
  }, [target])

  return (
    <div className="flex flex-col items-center gap-1">
      <button
        ref={clip}
        type="button"
        title="Clipped — click to reset"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => delete e.currentTarget.dataset.on}
        className="h-1.5 w-full rounded-[2px] bg-white/[0.07] data-[on=true]:bg-danger data-[on=true]:shadow-[0_0_6px_var(--color-danger)]"
      />
      <div className="flex min-h-0 flex-1 gap-[3px]">
        {[0, 1].map((i) => (
          <div key={i} className="relative w-[7px] overflow-hidden rounded-[2px] bg-black/55 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.05)]">
            <div ref={i ? barR : barL} className="absolute inset-0 bg-[linear-gradient(to_top,#2fcf7e_0%,#2fcf7e_62%,#e6e238_76%,#f5a524_88%,#ef4444_96%)]" style={{ clipPath: 'inset(100% 0 0 0)' }} />
            <div ref={i ? holdR : holdL} className="absolute inset-x-0 h-[2px] bg-white/85 opacity-0" />
          </div>
        ))}
      </div>
    </div>
  )
}
