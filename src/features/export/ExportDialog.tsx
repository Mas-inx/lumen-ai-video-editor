import { Captions, Check, CircleAlert, Cpu, FolderSearch, ListPlus, LoaderCircle, Play, Upload } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Row } from '@/components/ui/section'
import { Segmented } from '@/components/ui/segmented'
import { Select } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { projectDuration } from '@/editor/ops'
import { allSequences, openSequenceId, openSequenceName, withSequenceOpen } from '@/editor/sequences'
import { useEditor } from '@/editor/store'
import { timelineCues, type SubtitleFormat } from '@/editor/subtitles'
import type { Project } from '@/editor/types'
import { useUI } from '@/editor/ui-store'
import { timelineStills } from '@/engine/stills'
import {
  canAlpha,
  CODEC_LABEL,
  CODECS_FOR,
  codecSupport,
  ExportCancelled,
  FORMAT_INFO,
  LOUDNESS_TARGETS,
  runExport,
  videoBitrate,
  type ExportFormat,
  type ExportProgress,
  type ExportResult,
  type ExportSettings,
  type ExportVideoCodec,
} from '@/engine/export'
import { queueExport, useRenderQueue } from '@/engine/render-queue'
import { desktop } from '@/lib/platform'
import { formatDuration } from '@/lib/time'

const QUALITY_LABEL = (q: number) => (q < 30 ? 'Draft' : q < 60 ? 'Good' : q < 85 ? 'High' : 'Master')
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)

interface Size {
  value: string
  label: string
  width: number
  height: number
}

/** Output sizes in the timeline's shape, by short side. */
function sizesFor(pw: number, ph: number): Size[] {
  const short = Math.min(pw, ph)
  const out: Size[] = []
  for (const s of [2160, 1440, 1080, 720, 480]) {
    const k = s / short
    const width = even(pw * k)
    const height = even(ph * k)
    out.push({ value: String(s), label: `${s === 2160 ? '4K' : `${s}p`} · ${width}×${height}`, width, height })
  }
  if (![2160, 1440, 1080, 720, 480].includes(short)) out.unshift({ value: 'project', label: `Timeline · ${even(pw)}×${even(ph)}`, width: even(pw), height: even(ph) })
  return out
}

const fmtBytes = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`)
const fmtEta = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.max(1, Math.round(s))}s`)

type State = { kind: 'idle' } | { kind: 'running'; progress: ExportProgress } | { kind: 'done'; result: ExportResult; seconds: number } | { kind: 'error'; message: string }

/** A remembered-between-exports choice (loudness target, captions file). */
function useRemembered<T extends string>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      return (localStorage.getItem(key) as T | null) ?? initial
    } catch {
      return initial
    }
  })
  const set = (v: T) => {
    setValue(v)
    try {
      localStorage.setItem(key, v)
    } catch {
      /* private storage */
    }
  }
  return [value, set]
}

export function ExportDialog() {
  const open = useUI((s) => s.exportOpen)
  const setOpen = useUI((s) => s.setExportOpen)
  const current = useEditor((s) => s.project)

  // Which timeline: the open one unless another is picked.
  const [timelineId, setTimelineId] = useState(openSequenceId(current))
  const timelines = useMemo(() => allSequences(current), [current])
  const project: Project = useMemo(() => {
    try {
      return withSequenceOpen(current, timelineId)
    } catch {
      return current
    }
  }, [current, timelineId])

  const marked = project.range ?? null
  const [span, setSpan] = useState<'all' | 'range'>('all')
  const useRange = span === 'range' && marked !== null
  const duration = useRange ? marked.out - marked.in : projectDuration(project)
  const { fps: projectFps, width: pw, height: ph } = project.settings
  const sizes = useMemo(() => sizesFor(pw, ph), [pw, ph])

  const [name, setName] = useState(current.name)
  const [format, setFormat] = useState<ExportFormat>('mp4')
  const [codec, setCodec] = useState<ExportVideoCodec>('avc')
  const [size, setSize] = useState(sizes[0].value)
  const [rate, setRate] = useState(String(projectFps))
  const [quality, setQuality] = useState(72)
  const [hw, setHw] = useState(true)
  const [alpha, setAlpha] = useState(true)
  const [burn, setBurn] = useState(true)
  const [sidecar, setSidecar] = useRemembered<'none' | SubtitleFormat>('lumen.export.sidecar', 'none')
  // The loudness target is a delivery habit, so it's remembered between exports.
  const [loudness, setLoudness] = useRemembered<string>('lumen.export.loudness', 'off')
  const target = LOUDNESS_TARGETS.find((t) => t.id === loudness)
  const [support, setSupport] = useState<Partial<Record<ExportVideoCodec, boolean>>>({})
  const [state, setState] = useState<State>({ kind: 'idle' })
  const [preview, setPreview] = useState<string>()
  const abort = useRef<AbortController | null>(null)
  const queued = useRenderQueue((s) => s.jobs.filter((j) => j.status === 'queued').length)

  const info = FORMAT_INFO[format]
  const chosen = sizes.find((s) => s.value === size) ?? sizes.find((s) => s.width === even(pw) && s.height === even(ph)) ?? sizes[0]
  const fps = Number(rate)
  const gif = format === 'gif'
  const png = format === 'png'
  const out = gif ? { width: even(Math.min(chosen.width, 720)), height: even((Math.min(chosen.width, 720) * chosen.height) / chosen.width) } : chosen
  const codecs = format === 'mp4' || format === 'mov' || format === 'webm' ? CODECS_FOR[format] : []
  const hasCaptions = useMemo(() => timelineCues(project).length > 0, [project])
  const transparent = alpha && (png || format === 'webm')

  useEffect(() => {
    if (!open) return
    const p = useEditor.getState().project
    setTimelineId(openSequenceId(p))
    setName(p.name)
    setState({ kind: 'idle' })
  }, [open])

  // The timeline's own shape, rate and marked range.
  useEffect(() => {
    if (!open) return
    setSize(sizes.find((s) => s.width === even(pw) && s.height === even(ph))?.value ?? sizes[0].value)
    setRate(String(projectFps))
    // A marked in / out stretch is what you most likely want to export.
    setSpan(project.range ? 'range' : 'all')
    const p = project
    // Frame-exact, like the export itself — media the preview hasn't loaded still shows.
    let alive = true
    setPreview(undefined)
    void timelineStills(p, [p.range ? Math.round((p.range.in + p.range.out) / 2) : Math.round(projectDuration(p) * 0.2)], 640)
      .then(([canvas]) => alive && setPreview(canvas.toDataURL('image/jpeg', 0.85)))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [open, timelineId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Which encoders this machine has, for the chosen size.
  useEffect(() => {
    if (!open || !info.video || gif || png) return
    let alive = true
    void codecSupport(out.width, out.height, fps, hw).then((s) => alive && setSupport(s))
    return () => {
      alive = false
    }
  }, [open, out.width, out.height, fps, hw, info.video, gif, png])

  useEffect(() => {
    if (!codecs.length) return
    if (format === 'webm' && alpha && support.vp9 !== false) return void setCodec('vp9')
    if (!codecs.includes(codec) || support[codec] === false) setCodec(codecs.find((c) => support[c] !== false) ?? codecs[0])
  }, [format, support, alpha]) // eslint-disable-line react-hooks/exhaustive-deps

  const seconds = duration / projectFps
  const videoBits = info.video && !gif && !png ? videoBitrate(out.width, out.height, fps, codec, quality) : 0
  const audioBits = format === 'wav' ? 48000 * 2 * 16 : 192_000
  const estBytes = gif ? out.width * out.height * Math.min(fps, 20) * seconds * 0.12 : png ? out.width * out.height * 1.6 * fps * seconds : ((videoBits + audioBits) * seconds) / 8

  const running = state.kind === 'running'
  const ready = duration > 0 && (!codecs.length || support[codec] !== false)

  /** What to render: the timeline (as it is now) and how. */
  const job = (): { project: Project; settings: ExportSettings } => {
    const r = project.range
    const range: [number, number] | undefined = useRange && r ? [r.in, r.out] : undefined
    return {
      project,
      settings: {
        format,
        codec,
        width: out.width,
        height: out.height,
        fps,
        quality,
        hardware: hw,
        range,
        ...(target && !gif && !png ? { loudness: { lufs: target.lufs, peak: target.peak } } : {}),
        ...(transparent && canAlpha(format, codec) ? { alpha: true } : png ? { alpha: false } : {}),
        ...(hasCaptions ? { burnCaptions: info.video ? burn : false, sidecar: sidecar === 'none' ? null : sidecar } : {}),
      },
    }
  }

  const request = () => ({ defaultName: name || 'Untitled', extension: info.extension, filterName: info.filter, folder: Boolean(info.folder) })

  const start = async () => {
    if (!desktop || running) return
    const handle = await desktop.export.begin(request())
    if (!handle) return
    const controller = new AbortController()
    abort.current = controller
    const started = performance.now()
    setState({ kind: 'running', progress: { phase: 'preparing', done: 0, total: 1, speed: 0, eta: 0, message: 'Starting…' } })
    try {
      const { project: p, settings } = job()
      const res = await runExport(
        p,
        settings,
        handle,
        (prog) => {
          if (prog.preview) setPreview(prog.preview)
          setState({ kind: 'running', progress: prog })
        },
        controller.signal,
      )
      setState({ kind: 'done', result: res, seconds: (performance.now() - started) / 1000 })
    } catch (err) {
      if (err instanceof ExportCancelled) setState({ kind: 'idle' })
      else setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    } finally {
      abort.current = null
    }
  }

  const addToQueue = async () => {
    if (!desktop) return
    const target = await desktop.export.pick(request())
    if (!target) return
    const { project: p, settings } = job()
    const timelineName = timelines.find((t) => t.id === timelineId)?.name ?? openSequenceName(current)
    const detail = info.video ? `${info.label} · ${out.width}×${out.height}${gif || png ? '' : ` · ${CODEC_LABEL[codec].split(' —')[0]}`}${transparent ? ' · alpha' : ''}` : `${info.label} audio`
    queueExport({ label: timelines.length > 1 ? `${name} · ${timelineName}` : name, detail, project: p, settings, target })
    // The dialog stays open, to queue another size, format or timeline.
    toast.success('Added to the render queue', {
      description: target.path,
      action: { label: 'Show queue', onClick: () => (setOpen(false), useUI.getState().setQueueOpen(true)) },
    })
  }

  const progress = state.kind === 'running' ? state.progress : null
  const pct = progress ? (progress.phase === 'rendering' ? progress.done / Math.max(1, progress.total) : progress.phase === 'finishing' ? 1 : 0) : state.kind === 'done' ? 1 : 0
  const formats = (Object.keys(FORMAT_INFO) as ExportFormat[]).map((f) => ({ value: f, label: FORMAT_INFO[f].label }))

  return (
    <Dialog open={open} onOpenChange={(o) => (running ? undefined : setOpen(o))} title="Export" description="Render your edit to a file — now, or add it to the render queue." className="w-[min(920px,calc(100vw-32px))]">
      <div className="grid grid-cols-[1fr_1.15fr] gap-6 px-5 pt-1 pb-5">
        {/* Preview */}
        <div>
          <div className="relative aspect-video overflow-hidden rounded-xl bg-black shadow-[0_0_0_1px_rgb(255_255_255/0.08),0_16px_40px_-16px_rgb(0_0_0/0.9)] [background-image:repeating-conic-gradient(#1a1a1a_0_25%,#101010_0_50%)] [background-size:16px_16px]">
            {preview && <img src={preview} alt="" className="h-full w-full object-contain" />}
            <AnimatePresence>
              {state.kind !== 'idle' && state.kind !== 'error' && (
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 grid place-items-center bg-black/45 backdrop-blur-[1px]">
                  {state.kind === 'running' ? (
                    <div className="text-center">
                      <div className="text-3xl font-semibold tracking-tight text-white tabular">{Math.round(pct * 100)}%</div>
                      <div className="mt-1 text-xs text-white/70 tabular">
                        {progress?.phase === 'rendering' ? `${info.video ? 'Frame' : 'Block'} ${progress.done} / ${progress.total}` : progress?.message}
                      </div>
                    </div>
                  ) : (
                    <motion.div initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 380, damping: 22 }} className="grid size-14 place-items-center rounded-full bg-ok text-black shadow-[0_0_40px_rgb(60_207_145/0.5)]">
                      <Check className="size-7" strokeWidth={3} />
                    </motion.div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2">
            <Fact label="Duration" value={formatDuration(duration, projectFps)} />
            <Fact label="Est. size" value={duration ? fmtBytes(estBytes) : '—'} />
            <Fact label={info.video && !gif && !png ? 'Bitrate' : 'Output'} value={info.video && !gif && !png ? `${(videoBits / 1e6).toFixed(1)} Mbps` : gif || png ? `${out.width}×${out.height}` : format === 'wav' ? '48 kHz · 16-bit' : '192 kbps'} />
          </div>
        </div>

        {/* Settings */}
        <div className="space-y-3">
          <Row label="File name">
            <Input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} disabled={running} />
          </Row>
          {timelines.length > 1 && (
            <Row label="Timeline">
              <Select
                aria-label="Timeline"
                value={timelineId}
                onChange={setTimelineId}
                className="w-full"
                options={timelines.map((t) => ({ value: t.id, label: `${t.name} · ${t.settings.width}×${t.settings.height}` }))}
              />
            </Row>
          )}
          {marked && (
            <Row label="Range">
              <Segmented
                value={span}
                onChange={(v) => setSpan(v)}
                options={[
                  { value: 'all', label: 'Whole timeline' },
                  { value: 'range', label: `In to out · ${formatDuration(marked.out - marked.in, projectFps)}` },
                ]}
              />
            </Row>
          )}
          <Row label="Format">
            <Segmented value={format} onChange={(f) => setFormat(f)} options={formats} />
          </Row>
          {codecs.length > 0 && (
            <Row label="Codec">
              <Select
                aria-label="Codec"
                value={codec}
                onChange={(c) => setCodec(c as ExportVideoCodec)}
                className="w-full"
                options={codecs.map((c) => ({
                  value: c,
                  label: support[c] === false ? `${CODEC_LABEL[c].split(' —')[0]} — not available here` : CODEC_LABEL[c],
                  disabled: support[c] === false || (format === 'webm' && alpha && c !== 'vp9'),
                }))}
              />
            </Row>
          )}
          {(png || format === 'webm') && (
            <Row label="Background">
              <Switch aria-label="Transparent background" checked={alpha} onChange={setAlpha} />
              <span className="text-xs text-fg-3">{alpha ? 'Transparent — keeps the alpha channel' : 'Filled with the timeline background'}</span>
            </Row>
          )}
          {info.video && (
            <Row label="Resolution">
              <Select aria-label="Resolution" value={chosen.value} onChange={setSize} options={sizes.map((s) => ({ value: s.value, label: s.label }))} className="w-full" />
            </Row>
          )}
          {info.video && (
            <Row label="Frame rate">
              <Select
                aria-label="Frame rate"
                value={rate}
                onChange={setRate}
                options={[...new Set([projectFps, 24, 25, 30, 50, 60])].sort((a, b) => a - b).map((f) => ({ value: String(f), label: `${f} fps${f === projectFps ? ' (timeline)' : ''}` }))}
                className="w-full"
              />
            </Row>
          )}
          {info.video && !gif && !png && (
            <Row label="Quality">
              <Slider value={quality} min={10} max={100} onChange={setQuality} />
              <span className="w-14 shrink-0 text-right text-xs font-medium text-fg-2">{QUALITY_LABEL(quality)}</span>
            </Row>
          )}
          {info.video && !gif && !png && (
            <Row label="Hardware">
              <Switch aria-label="Hardware encoding" checked={hw} onChange={setHw} />
              <span className="flex items-center gap-1 text-xs text-fg-3">
                <Cpu className="size-3.5" /> Use the GPU encoder when available
              </span>
            </Row>
          )}
          {!gif && !png && (
            <Row label="Loudness">
              <Select aria-label="Loudness" value={loudness} onChange={setLoudness} options={[{ value: 'off', label: 'As mixed' }, ...LOUDNESS_TARGETS.map((t) => ({ value: t.id, label: t.label }))]} className="w-full" />
            </Row>
          )}
          {hasCaptions && (
            <Row label="Captions">
              {info.video && (
                <label className="flex shrink-0 items-center gap-1.5 text-xs text-fg-3">
                  <Switch aria-label="Burn captions into the picture" checked={burn} onChange={setBurn} /> In picture
                </label>
              )}
              <Select
                aria-label="Captions file"
                value={sidecar}
                onChange={setSidecar}
                className="w-full"
                options={[
                  { value: 'none', label: 'No captions file' },
                  { value: 'srt', label: '+ SRT file next to it' },
                  { value: 'vtt', label: '+ WebVTT file next to it' },
                ]}
              />
            </Row>
          )}
          {target && !gif && !png && <p className="text-2xs leading-relaxed text-fg-4">Measures the mix first, then sets it to {target.lufs} LUFS with peaks held under {target.peak} dBFS.</p>}
          {gif && <p className="text-2xs leading-relaxed text-fg-4">GIFs export at up to 720 px wide and 20 fps, without sound.</p>}
          {png && <p className="text-2xs leading-relaxed text-fg-4">One numbered PNG per frame, in a folder of its own{alpha ? ', with transparency — for compositing in other apps' : ''}. No sound.</p>}
          {format === 'webm' && alpha && <p className="text-2xs leading-relaxed text-fg-4">VP9 with an alpha channel — plays transparent in browsers and imports as an overlay.</p>}
          {!info.video && <p className="text-2xs leading-relaxed text-fg-4">Exports the mixed audio of {useRange ? 'the marked in-to-out stretch' : 'the whole timeline'}.</p>}
        </div>
      </div>

      <div className="flex items-center gap-3 border-t border-line bg-black/15 px-5 py-3.5">
        {state.kind === 'running' ? (
          <div className="min-w-0 flex-1">
            <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.08]">
              <div className="h-full rounded-full bg-gradient-to-r from-accent to-ai-2 transition-[width] duration-150" style={{ width: `${pct * 100}%` }} />
            </div>
            <div className="mt-1.5 flex items-center gap-1.5 text-2xs text-fg-4">
              <LoaderCircle className="size-3 animate-spin" />
              {progress?.phase === 'rendering'
                ? `${info.video ? `${progress.speed.toFixed(1)} fps · ${(progress.speed / fps).toFixed(2)}× realtime · ` : ''}${fmtEta(progress.eta)} left`
                : progress?.message}
            </div>
          </div>
        ) : state.kind === 'done' ? (
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-fg">Export finished</div>
            <div className="truncate text-xs text-fg-4" title={state.result.path}>
              {fmtBytes(state.result.size)} · {fmtEta(state.seconds)} · {state.result.path}
            </div>
            {state.result.sidecar && (
              <div className="flex items-center gap-1 truncate text-2xs text-fg-4" title={state.result.sidecar}>
                <Captions className="size-3 shrink-0" /> {state.result.sidecar}
              </div>
            )}
          </div>
        ) : state.kind === 'error' ? (
          <div className="flex min-w-0 flex-1 items-start gap-2 text-xs text-danger">
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span className="line-clamp-2">{state.message}</span>
          </div>
        ) : (
          <div className="flex-1 text-xs text-fg-4">
            {!duration
              ? 'The timeline is empty.'
              : info.video
                ? `${out.width}×${out.height} · ${gif ? 'GIF' : png ? 'PNG frames' : CODEC_LABEL[codec].split(' —')[0]} · ${Math.min(fps, gif ? 20 : fps)} fps${transparent ? ' · transparent' : ''}`
                : `${info.label} audio`}
          </div>
        )}
        {state.kind === 'running' ? (
          <Button variant="ghost" onClick={() => abort.current?.abort()}>
            Cancel
          </Button>
        ) : state.kind === 'done' ? (
          <>
            <Button variant="ghost" onClick={() => void desktop?.files.reveal(state.result.path)}>
              <FolderSearch /> Show in folder
            </Button>
            {!png && (
              <Button variant="secondary" onClick={() => void desktop?.files.open(state.result.path)}>
                <Play /> Play
              </Button>
            )}
            <Button variant="primary" onClick={() => setOpen(false)}>
              Done
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {state.kind === 'error' ? 'Close' : 'Cancel'}
            </Button>
            <Button variant="secondary" onClick={() => void addToQueue()} disabled={!ready || !desktop} title="Choose where it goes now, render it later with the rest of the queue">
              <ListPlus /> Add to queue{queued ? ` (${queued})` : ''}
            </Button>
            <Button variant="primary" onClick={() => void start()} className="px-4" disabled={!ready || !desktop}>
              <Upload />
              {state.kind === 'error' ? 'Try again' : 'Export'}
            </Button>
          </>
        )}
      </div>
    </Dialog>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-white/[0.035] px-2.5 py-2 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.04)]">
      <div className="text-2xs text-fg-4">{label}</div>
      <div className="text-sm font-semibold text-fg tabular">{value}</div>
    </div>
  )
}

