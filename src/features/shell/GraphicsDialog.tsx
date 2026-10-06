import { Check, Copy, LoaderCircle, Minus, RefreshCw, TriangleAlert } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import type { GpuChoice, GpuInfo } from '@shared/app'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Segmented } from '@/components/ui/segmented'
import { Switch } from '@/components/ui/switch'
import { useUI } from '@/editor/ui-store'
import { CODEC_NAME } from '@/engine/encoders'
import { CHECK_CODECS, CHECK_SIZES, checkEncoders, decoderSupport, reportText, webglInfo, type EncoderCheck, type EncoderState } from '@/engine/graphics-report'
import { APP_VERSION, desktop, platform } from '@/lib/platform'
import { isDirty, saveProject } from '@/project/session'

/** What Chromium calls its features, in the editor's words. */
const FEATURES: [key: string, label: string][] = [
  ['gpu_compositing', 'Drawing the editor'],
  ['webgl', 'Grading, mattes and 3D'],
  ['video_decode', 'Playing video'],
  ['video_encode', 'Encoding exports'],
]

const featureState = (value: string | undefined) => (!value ? 'unknown' : value.startsWith('enabled') ? 'on' : value.includes('software') ? 'software' : 'off')

const GPU_CHOICES: { value: GpuChoice; label: string }[] = [
  { value: 'system', label: 'Let Windows choose' },
  { value: 'high-performance', label: 'Fastest card' },
  { value: 'power-saving', label: 'Power saving' },
]

/** Which graphics card Lumen runs on, what works on it, and the settings to change that. */
export function GraphicsDialog() {
  const open = useUI((s) => s.graphicsOpen)
  const setOpen = useUI((s) => s.setGraphicsOpen)
  const [info, setInfo] = useState<GpuInfo | null>(null)
  const [rows, setRows] = useState<EncoderCheck[]>([])
  const [checking, setChecking] = useState(false)

  const check = async () => {
    setChecking(true)
    setRows([])
    try {
      await checkEncoders((row) => setRows((r) => [...r, row]))
    } finally {
      setChecking(false)
    }
  }

  useEffect(() => {
    if (!open) return
    void desktop?.system.gpu().then(setInfo)
    void check()
  }, [open])

  const set = async (patch: Parameters<NonNullable<typeof desktop>['system']['setGraphics']>[0]) => {
    if (desktop) setInfo(await desktop.system.setGraphics(patch))
  }
  const restart = async () => {
    // Nothing is lost: an unsaved project is saved first (cancelling the Save dialog cancels the restart).
    if (isDirty() && !(await saveProject())) return
    desktop?.system.relaunch()
  }
  const copy = async () => {
    const report = { gpu: info, webgl: webglInfo(), decoders: await decoderSupport(), encoders: rows }
    await navigator.clipboard.writeText(reportText(report, { app: APP_VERSION, electron: platform.versions?.electron, chrome: platform.versions?.chrome }))
    toast.success('Copied the graphics report')
  }

  const devices = info?.devices ?? []
  const active = devices.find((d) => d.active)
  // Two cards, running on the integrated one, and nobody asked for that.
  const faster = devices.find((d) => !d.active && (d.vendor === 'NVIDIA' || d.vendor === 'AMD'))
  const onSlowCard = Boolean(active && faster && active.vendor === 'Intel' && info?.settings.gpu === 'system')
  const softwareOnly = info ? featureState(info.features.gpu_compositing) !== 'on' : false

  return (
    <Dialog open={open} onOpenChange={setOpen} title="Graphics and encoding" className="w-[min(620px,calc(100vw-32px))]">
      <div className="max-h-[min(72vh,720px)] space-y-5 overflow-y-auto px-5 pt-1 pb-5">
        <Section title="Graphics card">
          {devices.length ? (
            <div className="space-y-1.5">
              {devices.map((d, i) => (
                <div key={i} className="flex items-center gap-2.5 rounded-lg bg-white/[0.03] px-3 py-2 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.05)]">
                  <span className={`size-1.5 shrink-0 rounded-full ${d.active ? 'bg-ok' : 'bg-white/20'}`} />
                  <span className="min-w-0 flex-1 truncate text-sm text-fg-2">
                    <span className="text-fg-4">{d.vendor}</span> {d.name}
                  </span>
                  {d.driver && <span className="shrink-0 font-mono text-2xs text-fg-4">driver {d.driver}</span>}
                  {d.active && <span className="shrink-0 rounded-md bg-ok/10 px-1.5 py-0.5 text-2xs font-medium text-ok">In use</span>}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-fg-3">{info ? 'No graphics card was reported — Lumen is drawing on the processor.' : 'Looking…'}</p>
          )}
          {onSlowCard && (
            <Note>
              Lumen is running on the power-saving card. Exports and heavy effects are faster on the {faster!.vendor} card — choose <b>Fastest card</b> below.
            </Note>
          )}
          {softwareOnly && <Note>The graphics card isn’t being used, so everything runs on the processor. A newer graphics driver usually fixes this.</Note>}
        </Section>

        {info && (
          <Section title="What it speeds up">
            <div className="grid grid-cols-2 gap-1.5">
              {FEATURES.map(([key, label]) => {
                const state = featureState(info.features[key])
                return (
                  <div key={key} className="flex items-center justify-between gap-2 rounded-lg bg-white/[0.03] px-3 py-2 text-sm shadow-[inset_0_0_0_1px_rgb(255_255_255/0.05)]">
                    <span className="text-fg-2">{label}</span>
                    <span className={state === 'on' ? 'text-ok' : state === 'software' ? 'text-warn' : 'text-fg-4'}>{state === 'on' ? 'Graphics card' : state === 'software' ? 'Processor' : state === 'off' ? 'Off' : '—'}</span>
                  </div>
                )
              })}
            </div>
          </Section>
        )}

        <Section
          title="Encoders, tested"
          right={
            <button type="button" disabled={checking} onClick={() => void check()} className="flex items-center gap-1 text-2xs text-fg-3 hover:text-fg disabled:opacity-50">
              {checking ? <LoaderCircle className="size-3 animate-spin" /> : <RefreshCw className="size-3" />} Test again
            </button>
          }
        >
          <div className="overflow-hidden rounded-lg shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-white/[0.03] text-left text-2xs font-medium text-fg-4">
                  <th className="px-3 py-1.5 font-medium">Codec</th>
                  {CHECK_SIZES.map((s) => (
                    <th key={s.label} colSpan={2} className="px-3 py-1.5 font-medium">
                      {s.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {CHECK_CODECS.map((codec) => (
                  <tr key={codec} className="border-t border-white/[0.05]">
                    <td className="px-3 py-1.5 text-fg-2">{CODEC_NAME[codec]}</td>
                    {CHECK_SIZES.map((s) => {
                      const row = rows.find((r) => r.codec === codec && r.size === s.label)
                      return (
                        <EncoderCells key={s.label} row={row} />
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-fg-4">
            Each encoder is tried with real frames. Exports use the graphics card’s when it works and fall back to the processor by themselves — and to H.264 if a codec has no working encoder.
          </p>
        </Section>

        {info && desktop && (
          <Section title="On a computer with two graphics cards">
            <Segmented stretch value={info.settings.gpu} onChange={(gpu) => void set({ gpu })} options={GPU_CHOICES} />
            <label className="mt-3 flex items-start gap-2.5 text-sm text-fg-2">
              <Switch aria-label="Use the graphics card even if its driver is distrusted" checked={info.settings.ignoreBlocklist} onChange={(ignoreBlocklist) => void set({ ignoreBlocklist })} />
              <span>
                Use the graphics card even if its driver is distrusted
                <span className="block text-xs text-fg-4">For a card that shows “Processor” or “Off” above. If Lumen misbehaves afterwards, switch this back off.</span>
              </span>
            </label>
            {info.restartNeeded && (
              <div className="mt-3 flex items-center justify-between gap-3 rounded-lg bg-accent/[0.07] px-3 py-2 shadow-[inset_0_0_0_1px_rgb(214_238_0/0.18)]">
                <span className="text-xs text-fg-2">These apply the next time Lumen starts. Your project is saved first.</span>
                <Button size="sm" variant="primary" onClick={() => void restart()}>
                  Restart Lumen
                </Button>
              </div>
            )}
          </Section>
        )}

        <div className="flex justify-end">
          <Button size="sm" variant="ghost" onClick={() => void copy()}>
            <Copy /> Copy report
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-2xs font-semibold tracking-wider text-fg-4 uppercase">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  )
}

function Note({ children }: { children: ReactNode }) {
  return (
    <div className="mt-2 flex items-start gap-2 rounded-lg bg-warn/[0.08] px-3 py-2 text-xs leading-relaxed text-fg-2 shadow-[inset_0_0_0_1px_rgb(255_190_60/0.18)]">
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warn" />
      <span>{children}</span>
    </div>
  )
}

const STATE_TEXT: Record<EncoderState, string> = { works: 'works', fails: 'fails', none: 'none' }

function EncoderCell({ label, state, error }: { label: string; state: EncoderState | undefined; error?: string }) {
  return (
    <td className="px-3 py-1.5" title={error ?? (state ? `${label}: ${STATE_TEXT[state]}` : undefined)}>
      <span className={`flex items-center gap-1.5 text-xs ${state === 'works' ? 'text-fg-2' : state === 'fails' ? 'text-danger' : 'text-fg-4'}`}>
        {state === undefined ? (
          <LoaderCircle className="size-3 animate-spin text-fg-4" />
        ) : state === 'works' ? (
          <Check className="size-3 text-ok" />
        ) : state === 'fails' ? (
          <TriangleAlert className="size-3" />
        ) : (
          <Minus className="size-3" />
        )}
        {label}
      </span>
    </td>
  )
}

function EncoderCells({ row }: { row: EncoderCheck | undefined }) {
  return (
    <>
      <EncoderCell label="Card" state={row?.hardware} error={row?.hardwareError} />
      <EncoderCell label="Processor" state={row?.software} error={row?.softwareError} />
    </>
  )
}
