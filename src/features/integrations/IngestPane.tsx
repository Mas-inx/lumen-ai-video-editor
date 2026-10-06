import { Film, FolderOpen } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { INGEST_QUALITIES, type IngestClip } from '@shared/ingest'
import { Button } from '@/components/ui/button'
import { Segmented } from '@/components/ui/segmented'
import { Switch } from '@/components/ui/switch'
import { useEditor } from '@/editor/store'
import { useUI } from '@/editor/ui-store'
import { useIntegrations } from '@/integrations/store'
import { desktop } from '@/lib/platform'
import { pickIngestFolder, regenerateIngestToken, setIngestEnabled, setIngestOptions, useIngest } from '@/project/ingest'
import { Card, CopyField, IconTile, PaneHeader, StatusDot } from './parts'

const megabytes = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${Math.max(0.1, bytes / 1e6).toFixed(1)} MB`)

/** Frame ingest: clips another app on this computer sends frame by frame. */
export function IngestPane() {
  const state = useIngest((s) => s.state)
  const [busy, setBusy] = useState(false)
  if (!state) return null
  const toggle = async (on: boolean) => {
    setBusy(true)
    try {
      await setIngestEnabled(on)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  const quality = INGEST_QUALITIES.find((q) => q.id === state.quality) ?? INGEST_QUALITIES[0]
  return (
    <div>
      <PaneHeader
        icon={<IconTile tone="lumen"><Film /></IconTile>}
        title="Frame ingest"
        subtitle="Another app on this computer — GS Cinematic Studio filming GTA V, a renderer, a capture tool — sends finished frames straight to Lumen. Each shot is encoded once, with full colour, into a master clip in your media."
        right={<Switch aria-label="Enable frame ingest" checked={state.running} disabled={busy} onChange={(on) => void toggle(on)} />}
      />
      {state.error && <div className="mb-4 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{state.error}</div>}
      <div className="space-y-4">
        {state.running && state.url ? (
          <>
            <CopyField label="Address (this computer only)" value={state.url} />
            <CopyField label="Access token" value={state.token} secret />
            <div className="flex items-center justify-between gap-4 text-2xs text-fg-4">
              <span>Paste both into the sending app — in GS Cinematic Studio, the Lumen address and token of an export. The Copilot can also wire it up itself.</span>
              <button type="button" className="shrink-0 text-fg-3 hover:text-fg" onClick={() => void regenerateIngestToken()}>
                New token
              </button>
            </div>
          </>
        ) : (
          <Card>
            <p className="text-sm leading-relaxed text-fg-2">When it’s on, Lumen listens on 127.0.0.1 only and every request needs a secret token. Nothing leaves this computer.</p>
          </Card>
        )}

        <Card>
          <div className="text-sm font-medium text-fg-2">Master quality</div>
          <p className="mt-0.5 mb-3 text-xs leading-relaxed text-fg-4">Used when the sender doesn’t ask for one. All three keep full colour resolution.</p>
          <Segmented stretch value={state.quality} onChange={(q) => void setIngestOptions({ quality: q })} options={INGEST_QUALITIES.map((q) => ({ value: q.id, label: q.name }))} />
          <p className="mt-2.5 text-xs text-fg-3">{quality.hint}</p>
        </Card>

        <Card>
          <div className="text-sm font-medium text-fg-2">Saved to</div>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg bg-black/30 px-3 py-2 font-mono text-xs text-fg-2 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]" title={state.folder}>
              {state.folder}
            </code>
            <Button size="sm" variant="secondary" onClick={() => void pickIngestFolder()}>
              Change…
            </Button>
            <Button size="sm" variant="ghost" aria-label="Open the folder" onClick={() => void desktop?.files.open(state.folder)}>
              <FolderOpen />
            </Button>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-fg-4">Masters are large. Choose a drive with room — a minute of 1440p is about 1 GB at Master quality.</p>
        </Card>

        {state.clips.length > 0 && (
          <Card className="p-0">
            <div className="border-b border-line px-4 py-2.5 text-xs font-medium text-fg-2">Recent clips</div>
            <div className="max-h-64 overflow-y-auto py-1">
              {state.clips.slice(0, 20).map((clip) => (
                <ClipRow key={clip.id} clip={clip} />
              ))}
            </div>
          </Card>
        )}
      </div>
    </div>
  )
}

function ClipRow({ clip }: { clip: IngestClip }) {
  const inProject = useEditor((s) => Boolean(clip.assetId && s.project.assets[clip.assetId]))
  const total = clip.frames || clip.received
  const active = clip.status === 'receiving' || clip.status === 'assembling'
  const detail =
    clip.status === 'done'
      ? `${clip.received} frames · ${clip.width}×${clip.height} · ${megabytes(clip.bytes ?? 0)}`
      : clip.status === 'error'
        ? (clip.error ?? 'Failed')
        : clip.status === 'assembling'
          ? 'Finishing the file…'
          : `${clip.received} of ${total || '?'} frames · ${clip.width}×${clip.height}`
  const show = () => {
    useUI.getState().setLeftTab('media')
    useIntegrations.setState({ hubOpen: false })
  }
  return (
    <div className="px-4 py-2">
      <div className="flex items-center gap-2.5 text-xs">
        <StatusDot status={clip.status === 'done' ? 'ready' : clip.status === 'error' ? 'error' : 'connecting'} />
        <span className="min-w-0 truncate font-medium text-fg-2">{clip.name}</span>
        <span className={`min-w-0 flex-1 truncate ${clip.status === 'error' ? 'text-danger' : 'text-fg-4'}`} title={detail}>
          {detail}
        </span>
        {clip.status === 'done' && inProject && (
          <button type="button" className="shrink-0 text-2xs text-fg-3 hover:text-fg" onClick={show}>
            In media
          </button>
        )}
        <span className="shrink-0 font-mono text-2xs text-fg-4">{new Date(clip.createdAt).toLocaleTimeString()}</span>
      </div>
      {active && total > 0 && (
        <div className="mt-1.5 ml-[18px] h-1 overflow-hidden rounded-full bg-white/[0.06]">
          <div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${Math.min(100, (clip.encoded / total) * 100)}%` }} />
        </div>
      )}
    </div>
  )
}
