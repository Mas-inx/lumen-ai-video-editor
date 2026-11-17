import { AudioLines, Dices, FileBox, FolderOpen, Image as ImageIcon, Import, LoaderCircle, RefreshCw, Video, Workflow } from 'lucide-react'
import { AnimatePresence } from 'motion/react'
import { useEffect, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { COMFY_DEFAULT_URL, COMFY_MEDIA_ROLES, type ComfyInput, type ComfyInputRole, type ComfyMediaKind, type ComfyOverride, type ComfyWorkflowInfo } from '@shared/comfyui'
import type { Job } from '@shared/integrations'
import { Button, IconButton } from '@/components/ui/button'
import { ScrubInput } from '@/components/ui/scrub-input'
import { Select } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { projectDuration } from '@/editor/ops'
import { usePlayback } from '@/editor/playback'
import { getProject, useEditor } from '@/editor/store'
import type { Asset, Clip } from '@/editor/types'
import { useUI } from '@/editor/ui-store'
import { IconTile, RenderCard, StatusDot } from '@/features/integrations/parts'
import { importComfyWorkflow, refreshComfy, runComfy, useComfy, type ComfyMediaChoice, type ComfySource } from '@/integrations/comfyui'
import { openIntegrations, useIntegrations } from '@/integrations/store'
import { cn } from '@/lib/cn'
import { desktop } from '@/lib/platform'
import { SectionLabel } from './shared'

const keyOf = (i: { node: string; input: string }) => `${i.node}.${i.input}`
const isMedia = (i: ComfyInput) => COMFY_MEDIA_ROLES.includes(i.role)
const TEXT_ROLES = new Set<ComfyInputRole>(['prompt', 'negative', 'text'])
const NUMBER_ROLES = new Set<ComfyInputRole>(['steps', 'cfg', 'denoise', 'width', 'height', 'frames', 'batch', 'fps'])
const SHORT: Partial<Record<ComfyInputRole, string>> = { steps: 'Steps', cfg: 'CFG', denoise: 'Denoise', width: 'W', height: 'H', frames: 'Frames', batch: 'Batch', fps: 'FPS' }
const MEDIA_ICON: Record<ComfyMediaKind, ReactNode> = { image: <ImageIcon />, video: <Video />, audio: <AudioLines /> }

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** Whether a media item can go into an input of this kind (image inputs take pictures; a clip's frame comes from the clip choice). */
function fits(asset: Asset, kind: ComfyMediaKind) {
  if (kind === 'image') return asset.kind === 'image'
  if (asset.source.type !== 'file') return false
  return kind === 'video' ? asset.kind === 'video' : asset.kind === 'audio' || (asset.kind === 'video' && asset.hasAudio !== false)
}

/** A selected clip whose footage this kind of input can take. */
function clipFits(clip: Clip | undefined, assets: Record<string, Asset>, kind: ComfyMediaKind) {
  const asset = clip?.assetId ? assets[clip.assetId] : undefined
  if (!asset) return false
  return kind === 'image' ? asset.kind !== 'audio' : fits(asset, kind)
}

/** What a media input takes by default: the frame under the playhead for pictures, the selected clip for video and sound. */
function defaultSource(i: ComfyInput) {
  const p = getProject()
  const kind = i.role as ComfyMediaKind
  const clip = useUI.getState().selection.map((id) => p.clips[id]).find((c) => clipFits(c, p.assets, kind))
  if (kind === 'image') return projectDuration(p) > 0 ? 'playhead' : 'keep'
  return clip ? 'clip' : 'keep'
}

const stepOf = (i: ComfyInput) => i.step ?? (i.role === 'denoise' ? 0.01 : i.role === 'cfg' ? 0.1 : 1)
const precisionOf = (i: ComfyInput) => (i.integer ? 0 : i.role === 'denoise' ? 2 : i.role === 'fps' ? (Number.isInteger(i.value) ? 0 : 3) : 1)

export function GenerateComfy() {
  const available = useIntegrations((s) => s.available)
  const jobs = useIntegrations((s) => s.jobs)
  const workflows = useComfy((s) => s.workflows)
  const status = useComfy((s) => s.status)
  const [picked, setPicked] = useState('')

  useEffect(() => {
    if (available) void refreshComfy(false)
  }, [available])

  if (!available) return <DesktopOnly />
  const workflow = workflows.find((w) => w.id === picked) ?? workflows[0]
  const runs = Object.values(jobs)
    .filter((j) => j.integration === 'comfyui')
    .sort((a, b) => b.startedAt - a.startedAt)

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="space-y-3 px-3.5 pb-3">
        {workflow ? (
          <>
            <Connection />
            <div className="flex items-center gap-1.5">
              <Select aria-label="Workflow" value={workflow.id} onChange={setPicked} size="md" className="min-w-0 flex-1" options={workflows.map((w) => ({ value: w.id, label: w.name }))} />
              <IconButton label="Import a workflow" onClick={() => void importWorkflow()}>
                <Import />
              </IconButton>
            </div>
            <WorkflowForm key={workflow.id} workflow={workflow} />
          </>
        ) : (
          <SetUp connected={Boolean(status?.connected)} />
        )}
      </div>

      <div className="px-3.5 pb-4">
        <SectionLabel>Runs</SectionLabel>
        {!runs.length && <p className="rounded-xl border border-dashed border-line-2 px-4 py-6 text-center text-xs leading-relaxed text-fg-4">Workflows run in ComfyUI, on your graphics card — keep editing. Everything they save lands in your media.</p>}
        <div className="space-y-2.5">
          <AnimatePresence initial={false}>
            {runs.map((job) => (
              <RunCard key={job.id} job={job} />
            ))}
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}

async function importWorkflow() {
  try {
    const workflow = await importComfyWorkflow()
    if (workflow) toast.success(`“${workflow.name}” is in your workflows`)
  } catch (err) {
    toast.error('Couldn’t import that workflow', { description: errorText(err) })
  }
}

function Connection() {
  const status = useComfy((s) => s.status)
  const checking = useComfy((s) => s.checking)
  const device = status?.devices.find((d) => d.type !== 'cpu') ?? status?.devices[0]
  return (
    <div className="flex items-center gap-2 px-1 text-2xs text-fg-4">
      <StatusDot status={status?.connected ? 'ready' : status ? 'missing' : 'disconnected'} />
      <button type="button" onClick={() => openIntegrations('comfyui')} className="min-w-0 flex-1 truncate text-left hover:text-fg-2">
        {status?.connected ? `ComfyUI ${status.version ?? ''}${device ? ` · ${device.name}` : ''}` : checking ? 'Looking for ComfyUI…' : `ComfyUI isn’t answering at ${status?.url ?? COMFY_DEFAULT_URL}`}
      </button>
      <button type="button" aria-label="Check again" onClick={() => void refreshComfy(true)} className="grid size-5 place-items-center rounded-md hover:bg-white/[0.06] hover:text-fg-2">
        <RefreshCw className={cn('size-3', checking && 'animate-spin')} />
      </button>
    </div>
  )
}

function WorkflowForm({ workflow }: { workflow: ComfyWorkflowInfo }) {
  const assets = useEditor((s) => s.project.assets)
  const clips = useEditor((s) => s.project.clips)
  const selection = useUI((s) => s.selection)
  const status = useComfy((s) => s.status)
  const [values, setValues] = useState<Record<string, ComfyInput['value']>>(() => Object.fromEntries(workflow.inputs.map((i) => [keyOf(i), i.value])))
  const [media, setMedia] = useState<Record<string, string>>(() => Object.fromEntries(workflow.inputs.filter(isMedia).map((i) => [keyOf(i), defaultSource(i)])))
  const [random, setRandom] = useState(true)
  const [place, setPlace] = useState(false)
  const [busy, setBusy] = useState(false)

  const texts = workflow.inputs.filter((i) => TEXT_ROLES.has(i.role))
  const mediaInputs = workflow.inputs.filter(isMedia)
  const seeds = workflow.inputs.filter((i) => i.role === 'seed')
  const numbers = workflow.inputs.filter((i) => NUMBER_ROLES.has(i.role))
  const prompts = texts.filter((i) => i.role === 'prompt')
  const set = (key: string, value: ComfyInput['value']) => setValues((v) => ({ ...v, [key]: value }))
  const selectedClip = (kind: ComfyMediaKind) => selection.map((id) => clips[id]).find((c) => clipFits(c, assets, kind))
  const device = status?.devices.find((d) => d.type !== 'cpu') ?? status?.devices[0]

  const run = async () => {
    if (busy) return
    setBusy(true)
    try {
      const overrides: ComfyOverride[] = []
      for (const i of workflow.inputs) {
        const v = values[keyOf(i)]
        if (isMedia(i) || v === null || v === undefined || (i.role === 'seed' && random)) continue
        // Every text goes as it is in the form; the rest only when changed.
        if (TEXT_ROLES.has(i.role) || v !== i.value) overrides.push({ node: i.node, input: i.input, value: v })
      }
      const choices: ComfyMediaChoice[] = []
      for (const i of mediaInputs) {
        const kind = i.role as ComfyMediaKind
        const choice = media[keyOf(i)] ?? 'keep'
        if (choice === 'keep') continue
        let source: ComfySource
        if (choice === 'clip') {
          const clip = selectedClip(kind)
          if (!clip) throw new Error(`Select a clip with ${kind === 'audio' ? 'sound' : kind === 'video' ? 'video' : 'footage'} on the timeline first — or choose another source for “${i.label}”.`)
          source = { from: 'clip', clipId: clip.id }
        } else if (choice === 'playhead') source = { from: 'timeline', frame: usePlayback.getState().frame }
        else source = { from: 'asset', assetId: choice.slice('asset:'.length) }
        choices.push({ node: i.node, input: i.input, kind, source })
      }
      const first = (role: ComfyInputRole) => {
        const i = workflow.inputs.find((x) => x.role === role)
        return i ? String(values[keyOf(i)] ?? '') : undefined
      }
      const result = await runComfy({ workflowId: workflow.id, prompt: first('prompt'), negative: first('negative'), seed: random ? 'random' : 'keep', overrides }, choices, place ? { at: usePlayback.getState().frame, source: 'user' } : undefined)
      // The seeds it drew stay in the form: switch off "new seed" to make the same again.
      if (random) setValues((v) => ({ ...v, ...result.seeds }))
      if (result.notes.length) toast('Running in ComfyUI', { description: result.notes.join(' ') })
    } catch (err) {
      toast.error('Couldn’t start the run', { description: errorText(err) })
    } finally {
      setBusy(false)
    }
  }

  const sourceOptions = (i: ComfyInput) => {
    const kind = i.role as ComfyMediaKind
    const clip = selectedClip(kind)
    const library = Object.values(assets)
      .filter((a) => !a.matteOf && fits(a, kind))
      .sort((a, b) => b.addedAt - a.addedAt)
      .slice(0, 60)
    return [
      ...(kind === 'image' ? [{ value: 'playhead', label: 'The frame at the playhead' }] : []),
      { value: 'clip', label: clip ? `Selected clip · ${clip.name}` : 'The selected clip', disabled: !clip },
      { value: 'keep', label: typeof i.value === 'string' && i.value ? `Its own · ${i.value}` : 'The workflow’s own file' },
      ...library.map((a) => ({ value: `asset:${a.id}`, label: a.name })),
    ]
  }

  return (
    <>
      {workflow.missing?.length ? (
        <p className="rounded-xl bg-warn/10 px-3 py-2.5 text-2xs leading-relaxed text-warn shadow-[inset_0_0_0_1px_rgb(255_255_255/0.04)]">Your ComfyUI is missing {workflow.missing.join(', ')}. Install them (ComfyUI-Manager finds missing nodes) and restart ComfyUI to run this workflow.</p>
      ) : null}

      {texts.map((i) =>
        i.role === 'prompt' ? (
          <div key={keyOf(i)} className="ring-ai rounded-xl bg-white/[0.035] p-2.5">
            {prompts.length > 1 && <div className="mb-1 text-2xs text-fg-4">{i.label}</div>}
            <textarea
              value={String(values[keyOf(i)] ?? '')}
              onChange={(e) => set(keyOf(i), e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void run()
              }}
              rows={4}
              placeholder="Describe what to make…"
              className="w-full resize-none bg-transparent text-sm leading-relaxed text-fg outline-none placeholder:text-fg-4"
            />
          </div>
        ) : (
          <div key={keyOf(i)} className="rounded-xl bg-white/[0.03] p-2.5 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.05)]">
            <div className="mb-1 text-2xs font-semibold tracking-wider text-fg-4 uppercase">{i.label}</div>
            <textarea
              value={String(values[keyOf(i)] ?? '')}
              onChange={(e) => set(keyOf(i), e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              rows={2}
              placeholder={i.role === 'negative' ? 'What to keep out…' : undefined}
              className="w-full resize-none bg-transparent text-xs leading-relaxed text-fg-2 outline-none placeholder:text-fg-4"
            />
          </div>
        ),
      )}

      {mediaInputs.map((i) => (
        <div key={keyOf(i)}>
          <div className="mb-1.5 flex items-center gap-1.5 text-2xs font-semibold tracking-wider text-fg-4 uppercase [&_svg]:size-3">
            {MEDIA_ICON[i.role as ComfyMediaKind]} {i.label}
            {i.label !== i.title && <span className="truncate font-normal tracking-normal normal-case">· {i.title}</span>}
          </div>
          <Select aria-label={i.label} value={media[keyOf(i)] ?? 'keep'} onChange={(v) => setMedia((m) => ({ ...m, [keyOf(i)]: v }))} size="md" className="w-full" options={sourceOptions(i)} />
        </div>
      ))}

      {seeds.length > 0 && (
        <div className="flex items-start gap-1.5">
          <div className="grid min-w-0 flex-1 gap-1.5">
            {seeds.map((i) => (
              <ScrubInput key={keyOf(i)} prefix={seeds.length > 1 ? `Seed ${i.node}` : 'Seed'} value={Number(values[keyOf(i)] ?? 0)} onChange={(v) => set(keyOf(i), Math.round(v))} min={i.min ?? 0} max={i.max} disabled={random} aria-label={i.label} />
            ))}
          </div>
          <IconButton label={random ? 'A new seed each run — click to keep this one' : 'Keeping this seed — click for a new one each run'} active={random} onClick={() => setRandom(!random)}>
            <Dices />
          </IconButton>
        </div>
      )}

      {numbers.length > 0 && (
        <div className="grid grid-cols-2 gap-1.5">
          {numbers.map((i) => (
            <ScrubInput
              key={keyOf(i)}
              prefix={`${SHORT[i.role]}${numbers.filter((x) => x.role === i.role).length > 1 ? ` ${i.node}` : ''}`}
              value={Number(values[keyOf(i)] ?? 0)}
              onChange={(v) => set(keyOf(i), i.integer ? Math.round(v) : v)}
              min={i.min}
              max={i.max}
              step={stepOf(i)}
              precision={precisionOf(i)}
              aria-label={i.label}
            />
          ))}
        </div>
      )}

      <div className="flex items-center justify-between">
        <span className="text-xs text-fg-2">Add to the timeline at the playhead</span>
        <Switch aria-label="Add to the timeline at the playhead" checked={place} onChange={setPlace} />
      </div>

      <Button variant="ai" size="lg" className="w-full" disabled={busy} onClick={() => void run()}>
        {busy ? <LoaderCircle className="animate-spin" /> : <Workflow />}
        Run in ComfyUI
      </Button>
      <p className="-mt-2 text-center text-2xs text-fg-4">
        {workflow.outputs.length ? `Makes ${[...new Set(workflow.outputs.filter((o) => o.kind !== 'preview').map((o) => (o.kind === 'audio' ? 'sound' : o.kind === '3d' ? '3D' : o.kind)))].join(', ') || 'previews'}` : 'No output node found'}
        {device ? ` · ${device.name}` : ''}
      </p>
    </>
  )
}

/** A run: its progress and results as any render's card shows them, plus the files that aren't media (3D models). */
function RunCard({ job }: { job: Job }) {
  return (
    <div className="space-y-1.5">
      <RenderCard job={job} />
      {job.status === 'done' &&
        job.files?.map((f) => (
          <div key={f.path} className="flex items-center gap-2.5 rounded-lg bg-white/[0.03] px-2.5 py-2 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.05)]">
            <FileBox className="size-3.5 shrink-0 text-fg-4" />
            <span className="min-w-0 flex-1 truncate text-xs text-fg-2">{f.name}</span>
            <IconButton size="xs" label="Show in folder" onClick={() => void desktop?.files.reveal(f.path)}>
              <FolderOpen />
            </IconButton>
          </div>
        ))}
    </div>
  )
}

function SetUp({ connected }: { connected: boolean }) {
  return (
    <div className="rounded-xl bg-white/[0.03] p-4 text-center shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]">
      <div className="mx-auto mb-3 w-fit">
        <IconTile tone="mcp">
          <Workflow />
        </IconTile>
      </div>
      <p className="text-sm font-medium text-fg">{connected ? 'Add a ComfyUI workflow' : 'Run your ComfyUI workflows here'}</p>
      <p className="mt-1 text-xs leading-relaxed text-fg-3">
        {connected
          ? 'In ComfyUI, use Workflow › Export (API) and import the file — or import a normal saved workflow, or a PNG ComfyUI made.'
          : 'Start ComfyUI on this computer (or point Lumen at it), then import a workflow you made there. It runs on your graphics card, with your footage as its input.'}
      </p>
      <div className="mt-3 flex justify-center gap-2">
        <Button size="sm" variant="primary" onClick={() => void importWorkflow()}>
          <Import /> Import a workflow
        </Button>
        <Button size="sm" variant="outline" onClick={() => openIntegrations('comfyui')}>
          Set up ComfyUI
        </Button>
      </div>
    </div>
  )
}

function DesktopOnly() {
  return (
    <div className="px-3.5">
      <div className="rounded-xl border border-dashed border-line-2 px-4 py-8 text-center">
        <p className="text-sm font-medium text-fg-2">Available in the desktop app</p>
        <p className="mt-1 text-xs leading-relaxed text-fg-4">ComfyUI runs on your computer, so Lumen talks to it from its desktop app.</p>
      </div>
    </div>
  )
}
