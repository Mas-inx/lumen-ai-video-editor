import { ArrowRight, Check, ExternalLink, FileJson, Import, KeyRound, LoaderCircle, Pencil, RefreshCw, Trash, Workflow, X } from 'lucide-react'
import { useEffect, useState, type DragEvent, type ReactNode } from 'react'
import { toast } from 'sonner'
import { COMFY_DEFAULT_URL, type ComfyInputRole, type ComfyWorkflowInfo } from '@shared/comfyui'
import { Button, IconButton } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useUI } from '@/editor/ui-store'
import { useGenerate } from '@/features/assets/generate-store'
import { configureComfy, importComfyWorkflow, refreshComfy, removeComfyWorkflow, renameComfyWorkflow, useComfy } from '@/integrations/comfyui'
import { useIntegrations } from '@/integrations/store'
import { cn } from '@/lib/cn'
import { desktop } from '@/lib/platform'
import { Card, IconTile, PaneHeader, StatusDot } from './parts'

const fail = (title: string) => (err: unknown) => toast.error(title, { description: err instanceof Error ? err.message : String(err) })

const gb = (bytes?: number) => (bytes ? `${Math.round((bytes / 1024 ** 3) * 10) / 10} GB` : '')

const FORMAT: Record<ComfyWorkflowInfo['format'], string> = { api: 'API format', png: 'From an image', ui: 'Converted' }

const ROLE_WORDS: Partial<Record<ComfyInputRole, string>> = { negative: 'negative prompt', cfg: 'CFG', fps: 'frame rate', batch: 'batch size' }

/** What a workflow lets you set, in a few words: "Prompt · negative · seed · image". */
function inputsSummary(w: ComfyWorkflowInfo) {
  const roles = [...new Set(w.inputs.map((i) => i.role))]
  const named = roles.filter((r) => r !== 'text').map((r) => ROLE_WORDS[r] ?? r)
  const outputs = [...new Set(w.outputs.map((o) => o.kind).filter((k) => k !== 'preview'))]
  return [named.length ? `Sets ${named.join(', ')}` : 'Nothing to set', outputs.length ? `makes ${outputs.map((k) => (k === 'audio' ? 'sound' : k === '3d' ? '3D' : k)).join(', ')}` : ''].filter(Boolean).join(' · ')
}

function openGenerator() {
  useUI.getState().setLeftTab('generate')
  useGenerate.setState({ engine: 'comfyui' })
  useIntegrations.setState({ hubOpen: false })
}

function Feature({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl bg-white/[0.025] p-3.5 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.05)]">
      <div className="text-sm font-medium text-fg-2">{title}</div>
      <p className="mt-1 text-xs leading-relaxed text-fg-4">{children}</p>
    </div>
  )
}

/** ComfyUI in the Integrations hub: where it is, what it runs on, and the workflows Lumen keeps for it. */
export function ComfyUIPane() {
  const status = useComfy((s) => s.status)
  const checking = useComfy((s) => s.checking)
  const workflows = useComfy((s) => s.workflows)
  const [editing, setEditing] = useState(false)
  const [url, setUrl] = useState('')
  const [addingHeader, setAddingHeader] = useState(false)
  const [headerName, setHeaderName] = useState('Authorization')
  const [headerValue, setHeaderValue] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void refreshComfy(false)
  }, [])

  const act = (title: string, fn: () => Promise<unknown>) => async () => {
    setBusy(true)
    try {
      await fn()
    } catch (err) {
      fail(title)(err)
    } finally {
      setBusy(false)
    }
  }

  const saveUrl = (value: string | null) =>
    act('Couldn’t use that address', async () => {
      await configureComfy({ url: value })
      setEditing(false)
    })

  return (
    <div>
      <PaneHeader
        icon={
          <IconTile tone="mcp">
            <Workflow />
          </IconTile>
        }
        title="ComfyUI"
        subtitle="Run your own ComfyUI workflows — images, video, sound, 3D — on your own graphics card, with your footage as their input. What they make lands in your media."
      />

      <Card>
        <div className="flex items-center gap-3">
          <StatusDot status={status?.connected ? 'ready' : status ? 'missing' : 'disconnected'} className="size-2" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-fg">{status?.connected ? `ComfyUI ${status.version ?? ''} is connected` : checking ? 'Looking for ComfyUI…' : 'ComfyUI isn’t connected'}</div>
            <div className="truncate font-mono text-2xs text-fg-4">{status?.url ?? COMFY_DEFAULT_URL}</div>
          </div>
          <Button size="sm" variant="ghost" onClick={() => void refreshComfy(true)} disabled={checking}>
            <RefreshCw className={cn(checking && 'animate-spin')} /> Re-check
          </Button>
          <Button size="sm" variant="outline" onClick={() => (setEditing(!editing), setUrl(status?.url ?? COMFY_DEFAULT_URL))}>
            Change
          </Button>
        </div>
        {editing && (
          <div className="mt-3 border-t border-line pt-3">
            <div className="flex gap-2">
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void saveUrl(url.trim())()}
                placeholder={COMFY_DEFAULT_URL}
                className="font-mono text-xs"
                spellCheck={false}
              />
              <Button size="md" variant="primary" disabled={busy || !url.trim()} onClick={saveUrl(url.trim())}>
                Save
              </Button>
              <Button size="md" variant="ghost" disabled={busy} onClick={saveUrl(null)}>
                Default
              </Button>
            </div>
            <p className="mt-1.5 text-2xs leading-relaxed text-fg-4">
              ComfyUI on another computer: start it with --listen and use that computer’s address. Plain http works on this computer and your local network; over the internet, use https. Lumen talks to this address and nothing else.
            </p>
          </div>
        )}
        {status && !status.connected && status.error && !editing && <p className="mt-3 border-t border-line pt-3 text-xs leading-relaxed text-fg-3">{status.error}</p>}
        {status?.connected && (
          <dl className="mt-3 grid grid-cols-[110px_1fr] gap-x-4 gap-y-2 border-t border-line pt-3 text-sm">
            {status.devices.map((d, i) => (
              <div key={i} className="contents">
                <dt className="text-fg-4">{d.type === 'cpu' ? 'Processor' : 'Graphics'}</dt>
                <dd className="min-w-0 truncate text-fg-2">
                  {d.name}
                  {d.vramTotal ? <span className="text-fg-4"> · {gb(d.vramTotal)}{d.vramFree ? `, ${gb(d.vramFree)} free` : ''}</span> : null}
                </dd>
              </div>
            ))}
            {(status.pytorch || status.python) && (
              <>
                <dt className="text-fg-4">Runs on</dt>
                <dd className="font-mono text-xs text-fg-3">{[status.pytorch && `PyTorch ${status.pytorch}`, status.python && `Python ${status.python}`].filter(Boolean).join(' · ')}</dd>
              </>
            )}
            {status.queue && (
              <>
                <dt className="text-fg-4">Queue</dt>
                <dd className="text-fg-2">{status.queue.running || status.queue.pending ? `${status.queue.running} running · ${status.queue.pending} waiting` : 'Idle'}</dd>
              </>
            )}
          </dl>
        )}
      </Card>

      <Card className="mt-4">
        <div className="flex items-center gap-3">
          <span className={cn('grid size-8 shrink-0 place-items-center rounded-lg [&_svg]:size-4', status?.header ? 'bg-accent/15 text-accent-2' : 'bg-white/[0.05] text-fg-3')}>
            <KeyRound />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-fg">
              Auth header <span className="font-normal text-fg-4">— optional</span>
            </div>
            <div className="truncate text-2xs text-fg-4">{status?.header ? `${status.header.name}: ${status.header.hint ?? '…'} · encrypted with your OS keychain` : 'For a ComfyUI behind a login or a proxy that wants a token.'}</div>
          </div>
          {status?.header ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={act('Couldn’t remove the header', () => configureComfy({ header: null }))}>
              <Trash /> Remove
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setAddingHeader(!addingHeader)}>
              Add
            </Button>
          )}
        </div>
        {addingHeader && !status?.header && (
          <div className="mt-3 flex gap-2 border-t border-line pt-3">
            <Input value={headerName} onChange={(e) => setHeaderName(e.target.value)} placeholder="Authorization" className="w-40 shrink-0 font-mono text-xs" />
            <Input type="password" value={headerValue} onChange={(e) => setHeaderValue(e.target.value)} placeholder="Bearer …" className="font-mono text-xs" autoComplete="off" />
            <Button
              size="md"
              variant="primary"
              disabled={busy || !headerName.trim() || !headerValue.trim()}
              onClick={act('Couldn’t save the header', async () => {
                await configureComfy({ header: { name: headerName.trim(), value: headerValue.trim() } })
                setHeaderValue('')
                setAddingHeader(false)
              })}
            >
              {busy ? <LoaderCircle className="animate-spin" /> : <Check />} Save
            </Button>
          </div>
        )}
      </Card>

      <Library />

      <div className="mt-6 grid grid-cols-3 gap-2.5">
        <Feature title="Your workflows">Anything you build in ComfyUI — SDXL, Flux, Wan, Hunyuan, upscalers, custom nodes — runs from Lumen with its prompt, seed and size up front.</Feature>
        <Feature title="Footage in">A clip, the frame under the playhead or anything in your media goes into the workflow’s image, video and audio inputs.</Feature>
        <Feature title="For the Copilot">Agents list your workflows and run them — B-roll, stills, clean-ups, analysis — on your hardware, not the model’s bill.</Feature>
      </div>

      <div className="mt-6 flex items-center gap-3">
        <Button variant="primary" size="lg" disabled={!workflows.length} onClick={openGenerator}>
          Run a workflow <ArrowRight />
        </Button>
        <a href="https://docs.comfy.org" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-fg-3 hover:text-fg">
          ComfyUI docs <ExternalLink className="size-3" />
        </a>
      </div>
    </div>
  )
}

function Library() {
  const workflows = useComfy((s) => s.workflows)
  const [dragging, setDragging] = useState(false)

  const importFrom = async (paths: (string | undefined)[]) => {
    for (const path of paths) {
      try {
        const workflow = await importComfyWorkflow(path)
        if (workflow) toast.success(`“${workflow.name}” is in your workflows`, { description: inputsSummary(workflow) })
      } catch (err) {
        fail('Couldn’t import that workflow')(err)
      }
    }
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const files = [...e.dataTransfer.files].filter((f) => /\.(json|png)$/i.test(f.name))
    if (!files.length) return void toast.error('Drop a workflow saved as .json, or a .png ComfyUI made.')
    void importFrom(files.map((f) => desktop?.files.pathForFile(f) || undefined).filter(Boolean))
  }

  return (
    <div
      className="mt-6"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          setDragging(true)
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false)
      }}
      onDrop={onDrop}
    >
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-2xs font-semibold tracking-wider text-fg-4 uppercase">Workflows</h3>
        <span className="text-2xs text-fg-4 tabular">{workflows.length}</span>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => void importFrom([undefined])}>
          <Import /> Import a workflow…
        </Button>
      </div>
      <div className={cn('space-y-1.5 rounded-xl transition-shadow', dragging && 'shadow-[0_0_0_2px_var(--color-accent)]')}>
        {workflows.map((w) => (
          <WorkflowRow key={w.id} workflow={w} />
        ))}
        {!workflows.length && (
          <div className="rounded-xl border border-dashed border-line-2 px-4 py-5 text-xs leading-relaxed text-fg-4">
            <p className="text-fg-3">Drop a workflow here, or import one.</p>
            <p className="mt-1">
              In ComfyUI, open it and use <span className="text-fg-3">Workflow › Export (API)</span> (classic interface: turn on Dev mode in the settings, then <span className="text-fg-3">Save (API Format)</span>). A normal saved workflow works too while ComfyUI is running — Lumen converts it — and so does a PNG ComfyUI made, which carries its workflow.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

function WorkflowRow({ workflow }: { workflow: ComfyWorkflowInfo }) {
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(workflow.name)
  const rename = async () => {
    setRenaming(false)
    if (!name.trim() || name.trim() === workflow.name) return setName(workflow.name)
    await renameComfyWorkflow(workflow.id, name.trim()).catch(fail('Couldn’t rename it'))
  }
  return (
    <div className="group/workflow flex items-start gap-3 rounded-xl bg-white/[0.025] px-3.5 py-3 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.05)]">
      <FileJson className="mt-0.5 size-4 shrink-0 text-fg-4" />
      <div className="min-w-0 flex-1">
        {renaming ? (
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => void rename()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void rename()
              if (e.key === 'Escape') (setName(workflow.name), setRenaming(false))
            }}
            className="h-7 text-sm"
          />
        ) : (
          <div className="truncate text-sm font-medium text-fg">{workflow.name}</div>
        )}
        <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-fg-3">{inputsSummary(workflow)}</p>
        <p className="mt-0.5 truncate text-2xs text-fg-4">
          {FORMAT[workflow.format]} · {workflow.nodes} nodes{workflow.source ? ` · ${workflow.source}` : ''}
        </p>
        {workflow.missing?.length ? <p className="mt-1 text-2xs leading-relaxed text-warn">Your ComfyUI is missing {workflow.missing.join(', ')} — install them (ComfyUI-Manager finds missing nodes) to run this.</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {renaming ? (
          <IconButton size="xs" label="Cancel" onMouseDown={(e) => e.preventDefault()} onClick={() => (setName(workflow.name), setRenaming(false))}>
            <X />
          </IconButton>
        ) : (
          <IconButton size="xs" label="Rename" onClick={() => (setName(workflow.name), setRenaming(true))}>
            <Pencil />
          </IconButton>
        )}
        <IconButton size="xs" label="Remove from Lumen" onClick={() => void removeComfyWorkflow(workflow.id).catch(fail('Couldn’t remove it'))} className="hover:text-danger">
          <Trash />
        </IconButton>
      </div>
    </div>
  )
}
