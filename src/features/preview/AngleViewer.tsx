import { useEffect, useRef, useState } from 'react'
import { Kbd } from '@/components/ui/kbd'
import { clipsAt } from '@/editor/ops'
import { usePlayback } from '@/editor/playback'
import { angleTracks } from '@/editor/sequences'
import { dispatch, getProject, useEditor } from '@/editor/store'
import { useUI } from '@/editor/ui-store'
import { setAngleSink } from '@/engine/compositor'
import { notifyMediaReady } from '@/engine/media'
import { cn } from '@/lib/cn'

interface Shown {
  clipId: string
  angles: { id: string; name: string }[]
  active: string
  aspect: number
}

/** The multicam clip under the playhead (the topmost), if any. */
function multicamUnder(): Shown | null {
  const p = getProject()
  const order = new Map(p.tracks.map((t, i) => [t.id, i]))
  const clip = clipsAt(p, usePlayback.getState().frame)
    .filter((c) => c.sequenceId && p.sequences?.[c.sequenceId]?.multicam)
    .sort((a, b) => (order.get(a.trackId) ?? 0) - (order.get(b.trackId) ?? 0))[0]
  const seq = clip?.sequenceId ? p.sequences?.[clip.sequenceId] : undefined
  if (!clip || !seq) return null
  const angles = angleTracks(seq).map((t) => ({ id: t.id, name: t.name.replace(/^Cam \d+ · /, '') }))
  return { clipId: clip.id, angles, active: clip.angle ?? angles[0]?.id ?? '', aspect: seq.settings.width / seq.settings.height }
}

/**
 * Every camera of the multicam clip under the playhead, live. Click one (or
 * press its number) to cut to it at the playhead — while it plays, too.
 */
export function AngleViewer() {
  const enabled = useUI((s) => s.angleViewer)
  const [shown, setShown] = useState<Shown | null>(null)
  const canvases = useRef(new Map<string, HTMLCanvasElement>())

  useEffect(() => {
    let key = ''
    const update = () => {
      const next = multicamUnder()
      const k = next ? `${next.clipId}|${next.active}|${next.angles.map((a) => a.id + a.name).join(',')}` : ''
      if (k === key) return
      key = k
      setShown(next)
    }
    update()
    const unsubs = [usePlayback.subscribe(update), useEditor.subscribe(update)]
    return () => unsubs.forEach((u) => u())
  }, [])

  const clipId = shown?.clipId
  useEffect(() => {
    if (!enabled || !clipId) return
    setAngleSink((clip, angles, draw) => {
      if (clip.id !== clipId) return
      for (const t of angles) {
        const c = canvases.current.get(t.id)
        if (c) draw(t.id, c.getContext('2d')!)
      }
    })
    // Draw the tiles now rather than on the next frame.
    notifyMediaReady()
    return () => setAngleSink(null)
  }, [enabled, clipId])

  if (!enabled || !shown) return null
  const tileW = 150
  const tileH = Math.round(tileW / shown.aspect)
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const cut = (index: number) => {
    const res = dispatch('multicam.switch', { frame: usePlayback.getState().frame, angle: index + 1, clipId: shown.clipId })
    if (!res.ok) return
    // Keep the new piece selected only if the old one was.
    if (useUI.getState().selection.includes(shown.clipId)) useUI.getState().select([res.result as string])
  }
  return (
    <div className="shrink-0 border-t border-line bg-black/20 px-3 py-2">
      <div className="scrollbar-none flex gap-2 overflow-x-auto">
        {shown.angles.map((a, i) => {
          const active = a.id === shown.active
          return (
            <button
              key={a.id}
              type="button"
              onClick={() => cut(i)}
              title={`Cut to ${a.name} at the playhead`}
              className={cn(
                'group/angle relative shrink-0 overflow-hidden rounded-lg bg-black outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-accent/60',
                active ? 'shadow-[0_0_0_2px_var(--color-accent),0_0_16px_-2px_rgb(214_238_0/0.5)]' : 'shadow-[0_0_0_1px_rgb(255_255_255/0.1)] hover:shadow-[0_0_0_1.5px_rgb(255_255_255/0.5)]',
              )}
              style={{ width: tileW, height: tileH }}
            >
              <canvas
                ref={(el) => {
                  if (el) canvases.current.set(a.id, el)
                  else canvases.current.delete(a.id)
                }}
                width={Math.round(tileW * dpr)}
                height={Math.round(tileH * dpr)}
                className="block h-full w-full"
              />
              <span className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/80 to-transparent px-1.5 pt-3 pb-1 text-left">
                {i < 9 && <Kbd combo={String(i + 1)} />}
                <span className={cn('truncate text-[11px] font-medium', active ? 'text-accent-2' : 'text-white/85')}>{a.name}</span>
              </span>
              {active && <span className="absolute top-1.5 left-1.5 rounded bg-accent px-1 text-[9px] font-bold text-accent-fg">LIVE</span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}
