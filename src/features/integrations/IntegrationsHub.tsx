import { ArrowRight, AudioLines, Box, Check, Clapperboard, Copy, ExternalLink, Eye, EyeOff, LoaderCircle, LogOut, Plug, Plus, RefreshCw, Server, Sparkles, Terminal, Trash, Unplug, Waypoints } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { MCP_CATALOG, type McpCatalogEntry, type McpServerConfig, type McpServerState, type McpTool } from '@shared/integrations'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { Switch } from '@/components/ui/switch'
import { useUI } from '@/editor/ui-store'
import { PROVIDERS } from '@shared/ai'
import { useAi } from '@/integrations/ai'
import { useBridge, setBridgeEnabled, regenerateBridgeToken } from '@/integrations/bridge'
import { connectServer, disconnectServer, refreshBlender, removeServer, saveServer, setBlenderPath, signOutServer, useIntegrations } from '@/integrations/store'
import { cn } from '@/lib/cn'
import { useGenerate } from '@/features/assets/generate-store'
import { LocalAgentsPane, ModelsPane } from './AiPanes'
import { ElevenLabsPane } from './ElevenLabsPane'
import { Card, IconTile, STATUS_LABEL, StatusDot } from './parts'
import { ToolList, ToolRunner } from './ToolRunner'

type Selection = 'ai-models' | 'local-agents' | 'blender' | 'hyperframes' | 'elevenlabs' | 'agents' | 'add' | `server:${string}` | `catalog:${string}`

export function IntegrationsHub() {
  const open = useIntegrations((s) => s.hubOpen)
  const focus = useIntegrations((s) => s.hubFocus)
  const [selected, setSelected] = useState<Selection>('blender')

  useEffect(() => {
    if (open && focus) setSelected(focus as Selection)
  }, [open, focus])

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => useIntegrations.setState({ hubOpen: o })}
      title="Integrations"
      description="Connect Blender, HyperFrames and MCP servers so Lumen’s AI can make assets for your edit."
      bare
      focusContent
      className="h-[min(680px,calc(100vh-64px))] w-[min(1000px,calc(100vw-48px))]"
    >
      <div className="flex h-full min-h-0">
        <Sidebar selected={selected} onSelect={setSelected} />
        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[680px] px-8 py-7">
            <Detail selected={selected} onSelect={setSelected} />
          </div>
        </div>
      </div>
    </Dialog>
  )
}

// ─── Sidebar ─────────────────────────────────────────────────────────────

function Sidebar({ selected, onSelect }: { selected: Selection; onSelect: (s: Selection) => void }) {
  const blender = useIntegrations((s) => s.blender)
  const servers = useIntegrations((s) => s.servers)
  const available = useIntegrations((s) => s.available)
  const eleven = useIntegrations((s) => s.elevenlabs)
  const bridge = useBridge((s) => s.status)
  const providers = useAi((s) => s.providers)
  const localAgents = useAi((s) => s.localAgents)
  const configured = Object.values(servers)
  const catalog = MCP_CATALOG.filter((c) => !servers[c.id])
  const modelCount = PROVIDERS.filter((p) => providers[p.id]?.configured).length
  const agentsReady = Object.values(localAgents).filter((a) => a?.signedIn).length

  return (
    <nav className="flex w-[244px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line bg-black/15 px-2.5 py-5">
      <div className="mb-4 px-2.5">
        <div className="flex items-center gap-2 text-md font-semibold tracking-tight text-fg">
          <Plug className="size-4 text-accent-2" /> Integrations
        </div>
        <p className="mt-1 text-2xs leading-relaxed text-fg-4">Tools Lumen’s AI can use to make assets for your edit.</p>
      </div>

      <NavLabel>Copilot</NavLabel>
      <NavItem
        active={selected === 'ai-models'}
        onClick={() => onSelect('ai-models')}
        icon={<IconTile tone="lumen" size="sm"><Sparkles /></IconTile>}
        label="AI models"
        hint={modelCount ? `${modelCount} connected` : 'Claude, GPT, Gemini, OpenRouter…'}
        status={modelCount ? 'ready' : undefined}
      />
      <NavItem
        active={selected === 'local-agents'}
        onClick={() => onSelect('local-agents')}
        icon={<IconTile tone="mcp" size="sm"><Terminal /></IconTile>}
        label="Claude Code & Codex"
        hint={agentsReady ? `${agentsReady} ready` : 'Use your own install'}
        status={agentsReady ? 'ready' : undefined}
      />

      <NavLabel>Engines</NavLabel>
      <NavItem active={selected === 'blender'} onClick={() => onSelect('blender')} icon={<IconTile tone="blender" size="sm"><Box /></IconTile>} label="Blender" hint={!available ? 'Desktop app' : blender?.found ? blender.version : blender ? 'Not found' : 'Checking…'} status={blender?.found ? 'ready' : blender ? 'missing' : undefined} />
      <NavItem active={selected === 'hyperframes'} onClick={() => onSelect('hyperframes')} icon={<IconTile tone="hyperframes" size="sm"><Clapperboard /></IconTile>} label="HyperFrames" hint="Built in" status={available ? 'ready' : undefined} />
      <NavItem
        active={selected === 'elevenlabs'}
        onClick={() => onSelect('elevenlabs')}
        icon={<IconTile tone="mcp" size="sm"><AudioLines /></IconTile>}
        label="ElevenLabs"
        hint={eleven?.configured ? 'Connected' : 'Voice, transcripts, SFX, music'}
        status={eleven?.configured ? 'ready' : undefined}
      />

      <NavLabel>MCP servers</NavLabel>
      {configured.map((s) => (
        <NavItem
          key={s.config.id}
          active={selected === `server:${s.config.id}`}
          onClick={() => onSelect(`server:${s.config.id}`)}
          icon={<ServerGlyph config={s.config} />}
          label={s.config.name}
          hint={s.status === 'connected' ? `${s.tools.length} tools` : STATUS_LABEL[s.status]}
          status={s.status}
        />
      ))}
      {catalog.map((c) => (
        <NavItem key={c.id} active={selected === `catalog:${c.id}`} onClick={() => onSelect(`catalog:${c.id}`)} icon={<ServerGlyph config={c} />} label={c.name} hint="Not added" muted />
      ))}
      <NavItem active={selected === 'add'} onClick={() => onSelect('add')} icon={<span className="grid size-7 place-items-center rounded-[8px] border border-dashed border-line-3 text-fg-3"><Plus className="size-3.5" /></span>} label="Add a server" hint="Any MCP URL or command" />

      <NavLabel>For AI agents</NavLabel>
      <NavItem active={selected === 'agents'} onClick={() => onSelect('agents')} icon={<IconTile tone="lumen" size="sm"><Waypoints /></IconTile>} label="Lumen MCP server" hint={bridge.running ? 'On' : 'Off'} status={bridge.running ? 'ready' : undefined} />
    </nav>
  )
}

function NavLabel({ children }: { children: ReactNode }) {
  return <div className="mt-4 mb-1 px-2.5 text-[10px] font-semibold tracking-wider text-fg-4 uppercase first:mt-0">{children}</div>
}

function NavItem({ active, onClick, icon, label, hint, status, muted }: { active: boolean; onClick: () => void; icon: ReactNode; label: string; hint?: string; status?: Parameters<typeof StatusDot>[0]['status']; muted?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/60',
        active ? 'bg-white/[0.07] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.05)]' : 'hover:bg-white/[0.04]',
        muted && !active && 'opacity-70',
      )}
    >
      {icon}
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate text-sm font-medium', active ? 'text-fg' : 'text-fg-2')}>{label}</span>
        {hint && <span className="block truncate text-2xs text-fg-4">{hint}</span>}
      </span>
      {status && <StatusDot status={status} />}
    </button>
  )
}

function ServerGlyph({ config }: { config: Pick<McpServerConfig, 'id' | 'name' | 'transport' | 'preset'> }) {
  if (config.preset === 'runway' || config.preset === 'replicate' || config.preset === 'fal')
    return (
      <IconTile tone="mcp" size="sm">
        <span className="text-[11px] font-black">{config.preset === 'runway' ? 'R' : config.preset === 'replicate' ? 'Re' : 'f'}</span>
      </IconTile>
    )
  if (config.preset === 'higgsfield')
    return (
      <IconTile tone="higgsfield" size="sm">
        <span className="text-[11px] font-black">H</span>
      </IconTile>
    )
  if (config.preset === 'blender-mcp')
    return (
      <IconTile tone="blender" size="sm">
        <Terminal />
      </IconTile>
    )
  return <IconTile tone="mcp" size="sm">{config.transport === 'http' ? <Server /> : <Terminal />}</IconTile>
}

// ─── Detail panes ────────────────────────────────────────────────────────

function Detail({ selected, onSelect }: { selected: Selection; onSelect: (s: Selection) => void }) {
  const available = useIntegrations((s) => s.available)
  const servers = useIntegrations((s) => s.servers)
  if (!available && selected !== 'hyperframes') return <DesktopOnly />
  if (selected === 'ai-models') return <ModelsPane />
  if (selected === 'local-agents') return <LocalAgentsPane />
  if (selected === 'blender') return <BlenderPane />
  if (selected === 'hyperframes') return <HyperFramesPane />
  if (selected === 'elevenlabs') return <ElevenLabsPane />
  if (selected === 'agents') return <AgentsPane />
  if (selected === 'add') return <AddServerPane onAdded={(id) => onSelect(`server:${id}`)} />
  if (selected.startsWith('server:')) {
    const server = servers[selected.slice(7)]
    return server ? <ServerPane key={server.config.id} server={server} onRemoved={() => onSelect('add')} /> : <AddServerPane onAdded={(id) => onSelect(`server:${id}`)} />
  }
  const entry = MCP_CATALOG.find((c) => `catalog:${c.id}` === selected)
  return entry ? <CatalogPane entry={entry} onAdded={(id) => onSelect(`server:${id}`)} /> : null
}

function PaneHeader({ icon, title, subtitle, right }: { icon: ReactNode; title: ReactNode; subtitle: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-6 flex items-start gap-4">
      {icon}
      <div className="min-w-0 flex-1">
        <h2 className="text-xl font-semibold tracking-tight text-fg">{title}</h2>
        <p className="mt-0.5 text-sm leading-relaxed text-fg-3">{subtitle}</p>
      </div>
      {right}
    </div>
  )
}

function DesktopOnly() {
  return (
    <div className="grid min-h-[420px] place-items-center text-center">
      <div className="max-w-sm">
        <Plug className="mx-auto mb-3 size-8 text-fg-4" />
        <h2 className="text-lg font-semibold text-fg">Integrations run in the desktop app</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-fg-3">Blender, HyperFrames rendering and MCP connections need Lumen’s desktop app — the browser preview can’t launch local tools.</p>
      </div>
    </div>
  )
}

function Feature({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl bg-white/[0.025] p-3.5 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.05)]">
      <div className="text-sm font-medium text-fg-2">{title}</div>
      <p className="mt-1 text-xs leading-relaxed text-fg-4">{children}</p>
    </div>
  )
}

function openGenerator(mode: '3d' | 'motion' | 'media') {
  useUI.getState().setLeftTab('generate')
  useGenerate.setState({ engine: mode })
  useIntegrations.setState({ hubOpen: false })
}

function BlenderPane() {
  const blender = useIntegrations((s) => s.blender)
  const checking = useIntegrations((s) => s.checkingBlender)
  const [editing, setEditing] = useState(false)
  const [path, setPath] = useState('')

  return (
    <div>
      <PaneHeader
        icon={<IconTile tone="blender"><Box /></IconTile>}
        title="Blender"
        subtitle="Real 3D for your edit: Lumen drives Blender in the background and drops transparent renders straight into your media."
      />
      <Card>
        <div className="flex items-center gap-3">
          <StatusDot status={blender?.found ? 'ready' : 'missing'} className="size-2" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-fg">{blender?.found ? `Blender ${blender.version} is ready` : checking ? 'Looking for Blender…' : 'Blender not found'}</div>
            <div className="truncate font-mono text-2xs text-fg-4">{blender?.path ?? 'Install Blender 4.2 or newer, or point Lumen at it.'}</div>
          </div>
          <Button size="sm" variant="ghost" onClick={() => void refreshBlender()} disabled={checking}>
            <RefreshCw className={cn(checking && 'animate-spin')} /> Re-detect
          </Button>
          <Button size="sm" variant="outline" onClick={() => (setEditing(!editing), setPath(blender?.path ?? ''))}>
            {blender?.found ? 'Change' : 'Locate'}
          </Button>
        </div>
        {editing && (
          <div className="mt-3 flex gap-2 border-t border-line pt-3">
            <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="C:\Program Files\Blender Foundation\Blender 5.1\blender.exe" className="font-mono text-xs" />
            <Button
              size="md"
              variant="primary"
              onClick={async () => {
                await setBlenderPath(path.trim() || null)
                setEditing(false)
              }}
            >
              Save
            </Button>
            <Button size="md" variant="ghost" onClick={async () => (await setBlenderPath(null), setEditing(false))}>
              Auto
            </Button>
          </div>
        )}
        {!blender?.found && !editing && (
          <a href="https://www.blender.org/download/" target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 text-xs text-accent-2 hover:underline">
            Download Blender (free) <ExternalLink className="size-3" />
          </a>
        )}
      </Card>

      <div className="mt-4 grid grid-cols-3 gap-2.5">
        <Feature title="3D titles">Extruded, bevelled type in chrome, gold, glass or neon — lit in a studio, with motion blur and a transparent background.</Feature>
        <Feature title="Motion backgrounds">Seamless looping abstract 3D scenes with depth of field, in your palette.</Feature>
        <Feature title="AI-built scenes">Agents write Blender Python; Lumen renders it after you approve, and it lands on your timeline.</Feature>
      </div>

      <Card className="mt-4">
        <div className="flex items-start gap-3">
          <StatusDot status={blender?.live ? 'ready' : 'disconnected'} className="mt-1.5 size-2" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-fg">Live link {blender?.live ? '— your Blender is listening' : '(optional)'}</div>
            <p className="mt-0.5 text-xs leading-relaxed text-fg-3">
              {blender?.live
                ? 'Agents can now inspect and change the scene you have open in Blender (port 9876). Every script asks for your approval first.'
                : 'To let agents work inside the Blender window you have open, install the BlenderMCP add-on and start its server (port 9876). Headless renders don’t need this.'}
            </p>
          </div>
          <a href="https://github.com/ahujasid/blender-mcp" target="_blank" rel="noreferrer" className="shrink-0 text-xs text-accent-2 hover:underline">
            Add-on ↗
          </a>
        </div>
      </Card>

      <Button variant="primary" size="lg" className="mt-6" disabled={!blender?.found} onClick={() => openGenerator('3d')}>
        Make something in 3D <ArrowRight />
      </Button>
    </div>
  )
}

function HyperFramesPane() {
  return (
    <div>
      <PaneHeader
        icon={<IconTile tone="hyperframes"><Clapperboard /></IconTile>}
        title="HyperFrames"
        subtitle="HeyGen’s open-source HTML-to-video framework. Motion graphics are written as HTML + GSAP and rendered frame-exactly inside Lumen — no FFmpeg or browser download."
      />
      <Card>
        <div className="flex items-center gap-3">
          <StatusDot status="ready" className="size-2" />
          <div className="flex-1">
            <div className="text-sm font-medium text-fg">Built in</div>
            <div className="text-2xs text-fg-4">@hyperframes/core runtime · Apache-2.0</div>
          </div>
          <a href="https://github.com/heygen-com/hyperframes" target="_blank" rel="noreferrer" className="text-xs text-accent-2 hover:underline">
            GitHub ↗
          </a>
        </div>
      </Card>
      <div className="mt-4 grid grid-cols-2 gap-2.5">
        <Feature title="Lower thirds">Names and titles with a glass panel, accent bar and clean exits.</Feature>
        <Feature title="Title cards">Letter-by-letter reveals with a shimmer pass.</Feature>
        <Feature title="Kinetic type">Punchy word-by-word typography, timed to fill the clip.</Feature>
        <Feature title="Stat counters">Animated numbers with a progress ring.</Feature>
      </div>
      <p className="mt-4 text-xs leading-relaxed text-fg-4">AI agents can also hand Lumen a complete HyperFrames composition — anything HTML, CSS and GSAP can draw — and get back a transparent clip.</p>
      <Button variant="primary" size="lg" className="mt-6" onClick={() => openGenerator('motion')}>
        Make a motion graphic <ArrowRight />
      </Button>
    </div>
  )
}

// ─── MCP servers ─────────────────────────────────────────────────────────

function ServerPane({ server, onRemoved }: { server: McpServerState; onRemoved: () => void }) {
  const [tool, setTool] = useState<McpTool | null>(null)
  const [busy, setBusy] = useState(false)
  const { config, status } = server
  const act = (fn: () => Promise<unknown>) => async () => {
    setBusy(true)
    try {
      await fn()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (tool && status === 'connected') return <ToolRunner server={server} tool={tool} onBack={() => setTool(null)} />

  return (
    <div>
      <PaneHeader
        icon={<ServerGlyphLarge config={config} />}
        title={config.name}
        subtitle={
          <span className="inline-flex items-center gap-1.5">
            <StatusDot status={status} /> {STATUS_LABEL[status]}
            {server.server && <span className="text-fg-4">· {server.server.name} {server.server.version}</span>}
          </span>
        }
        right={
          <div className="flex shrink-0 items-center gap-1.5">
            {status === 'connected' ? (
              <Button size="sm" variant="outline" disabled={busy} onClick={act(() => disconnectServer(config.id))}>
                <Unplug /> Disconnect
              </Button>
            ) : (
              <Button size="sm" variant="primary" disabled={busy || status === 'connecting' || status === 'needs-auth'} onClick={act(() => connectServer(config.id))}>
                {status === 'connecting' || status === 'needs-auth' ? <LoaderCircle className="animate-spin" /> : <Plug />} Connect
              </Button>
            )}
          </div>
        }
      />
      <div className="mb-5 rounded-lg bg-black/25 px-3 py-2 font-mono text-2xs break-all text-fg-3 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.05)]">
        {config.transport === 'http' ? config.url : [config.command, ...(config.args ?? [])].join(' ')}
      </div>

      {status === 'needs-auth' && (
        <Card className="mb-5 flex items-center gap-3">
          <LoaderCircle className="size-4 shrink-0 animate-spin text-accent-2" />
          <p className="text-sm text-fg-2">Finish signing in to {config.name} in your browser — Lumen connects as soon as you’re back.</p>
        </Card>
      )}
      {status === 'error' && server.error && (
        <div className="mb-5 rounded-lg bg-danger/10 px-3 py-2.5 font-mono text-2xs leading-relaxed break-words whitespace-pre-wrap text-danger shadow-[inset_0_0_0_1px_rgb(255_93_93/0.2)]">{server.error}</div>
      )}

      {status === 'connected' ? (
        <ToolList server={server} onPick={setTool} />
      ) : (
        status !== 'needs-auth' && (
          <p className="text-sm leading-relaxed text-fg-3">Connect to see what {config.name} can do. Its tools show up here, in the Generate panel and for Copilot.</p>
        )
      )}

      <div className="mt-8 flex items-center gap-2 border-t border-line pt-4">
        {server.authorized && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={act(() => signOutServer(config.id))}>
            <LogOut /> Sign out
          </Button>
        )}
        <Button
          size="sm"
          variant="danger"
          className="ml-auto"
          disabled={busy}
          onClick={act(async () => {
            await removeServer(config.id)
            onRemoved()
          })}
        >
          <Trash /> Remove server
        </Button>
      </div>
    </div>
  )
}

function ServerGlyphLarge({ config }: { config: Pick<McpServerConfig, 'transport' | 'preset'> }) {
  if (config.preset === 'runway' || config.preset === 'replicate' || config.preset === 'fal')
    return (
      <IconTile tone="mcp">
        <span className="text-base font-black">{config.preset === 'runway' ? 'R' : config.preset === 'replicate' ? 'Re' : 'f'}</span>
      </IconTile>
    )
  if (config.preset === 'higgsfield')
    return (
      <IconTile tone="higgsfield">
        <span className="text-lg font-black">H</span>
      </IconTile>
    )
  if (config.preset === 'blender-mcp')
    return (
      <IconTile tone="blender">
        <Terminal />
      </IconTile>
    )
  return <IconTile tone="mcp">{config.transport === 'http' ? <Server /> : <Terminal />}</IconTile>
}

function CatalogPane({ entry, onAdded }: { entry: McpCatalogEntry; onAdded: (id: string) => void }) {
  const [busy, setBusy] = useState(false)
  const [key, setKey] = useState('')
  const add = async () => {
    setBusy(true)
    try {
      const { id, name, transport, url, command, args, preset } = entry
      const headers = entry.auth === 'key' && entry.keyHeader ? { [entry.keyHeader]: `${entry.keyPrefix ?? ''}${key.trim()}` } : undefined
      await saveServer({ id, name, transport, url, command, args, preset, headers, enabled: true, description: entry.tagline })
      onAdded(entry.id)
      void connectServer(entry.id)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div>
      <PaneHeader icon={<ServerGlyphLarge config={entry} />} title={entry.name} subtitle={entry.tagline} />
      <Card>
        <dl className="grid grid-cols-[110px_1fr] gap-x-4 gap-y-2.5 text-sm">
          <dt className="text-fg-4">Connection</dt>
          <dd className="font-mono text-xs break-all text-fg-2">{entry.transport === 'http' ? entry.url : [entry.command, ...(entry.args ?? [])].join(' ')}</dd>
          <dt className="text-fg-4">Sign-in</dt>
          <dd className="text-fg-2">
            {entry.auth === 'oauth'
              ? 'Your browser opens to sign in; tokens are encrypted on this computer.'
              : entry.auth === 'key'
                ? 'Your API key, encrypted with your OS keychain.'
                : entry.auth === 'local'
                  ? 'Runs locally on your computer.'
                  : 'None'}
          </dd>
          {entry.requirement && (
            <>
              <dt className="text-fg-4">You’ll need</dt>
              <dd className="text-fg-2">{entry.requirement}</dd>
            </>
          )}
        </dl>
      </Card>
      {entry.auth === 'key' && (
        <div className="mt-4 flex items-center gap-2">
          <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="API key" className="font-mono text-xs" autoComplete="off" />
          {entry.keyUrl && (
            <a href={entry.keyUrl} target="_blank" rel="noreferrer" className="shrink-0 text-xs text-accent-2 hover:underline">
              Get a key ↗
            </a>
          )}
        </div>
      )}
      <div className="mt-6 flex items-center gap-3">
        <Button variant="primary" size="lg" disabled={busy || (entry.auth === 'key' && !key.trim())} onClick={add}>
          {busy ? <LoaderCircle className="animate-spin" /> : <Plug />} Connect {entry.name}
        </Button>
        <a href={entry.docs} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-fg-3 hover:text-fg">
          Learn more <ExternalLink className="size-3" />
        </a>
      </div>
    </div>
  )
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'server'

function parsePairs(text: string, sep: RegExp) {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const m = line.match(sep)
    if (m) out[m[1].trim()] = m[2].trim()
  }
  return out
}

function AddServerPane({ onAdded }: { onAdded: (id: string) => void }) {
  const servers = useIntegrations((s) => s.servers)
  const [name, setName] = useState('')
  const [kind, setKind] = useState<'http' | 'stdio'>('http')
  const [url, setUrl] = useState('')
  const [command, setCommand] = useState('')
  const [extra, setExtra] = useState('')
  const [busy, setBusy] = useState(false)

  const ready = name.trim() && (kind === 'http' ? /^https?:\/\//.test(url.trim()) : command.trim())
  const add = async () => {
    setBusy(true)
    try {
      let id = slug(name)
      for (let i = 2; servers[id]; i++) id = `${slug(name)}-${i}`
      const [cmd, ...args] = command.trim().match(/"[^"]*"|\S+/g)?.map((a) => a.replace(/^"|"$/g, '')) ?? []
      const config: McpServerConfig =
        kind === 'http'
          ? { id, name: name.trim(), transport: 'http', url: url.trim(), headers: parsePairs(extra, /^([^:]+):(.+)$/), enabled: true }
          : { id, name: name.trim(), transport: 'stdio', command: cmd, args, env: parsePairs(extra, /^([A-Za-z_][\w]*)=(.*)$/), enabled: true }
      await saveServer(config)
      onAdded(id)
      void connectServer(id)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <PaneHeader icon={<IconTile tone="mcp"><Plus /></IconTile>} title="Add an MCP server" subtitle="Any Model Context Protocol server — hosted (URL) or local (command). Its tools become available to you and to Lumen’s AI." />
      <div className="space-y-4">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-fg-2">Name</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Runway, ElevenLabs, My tools" />
        </label>
        <Segmented
          value={kind}
          onChange={setKind}
          size="md"
          options={[
            { value: 'http', label: 'Remote (URL)', icon: <Server /> },
            { value: 'stdio', label: 'Local (command)', icon: <Terminal /> },
          ]}
        />
        {kind === 'http' ? (
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-fg-2">Server URL</span>
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" className="font-mono text-xs" />
          </label>
        ) : (
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-fg-2">Command</span>
            <Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx -y @modelcontextprotocol/server-everything" className="font-mono text-xs" />
          </label>
        )}
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-fg-2">{kind === 'http' ? 'Headers' : 'Environment'} <span className="font-normal text-fg-4">— optional, one per line</span></span>
          <textarea
            value={extra}
            onChange={(e) => setExtra(e.target.value)}
            rows={3}
            placeholder={kind === 'http' ? 'Authorization: Bearer …' : 'API_KEY=…'}
            className="w-full resize-y rounded-control bg-white/[0.045] px-2.5 py-2 font-mono text-xs leading-relaxed text-fg shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)] outline-none placeholder:text-fg-4 focus:bg-white/[0.07]"
          />
          <span className="mt-1 block text-2xs text-fg-4">{kind === 'http' ? 'Servers that support OAuth open a sign-in page instead — no keys needed.' : 'Stored in Lumen’s settings on this computer.'}</span>
        </label>
      </div>
      <div className="mt-6 flex items-center gap-3">
        <Button variant="primary" size="lg" disabled={!ready || busy} onClick={add}>
          {busy ? <LoaderCircle className="animate-spin" /> : <Plus />} Add & connect
        </Button>
        <span className="text-2xs leading-relaxed text-fg-4">Local servers run with your permissions — only add ones you trust.</span>
      </div>
    </div>
  )
}

// ─── Lumen's own MCP server ──────────────────────────────────────────────

function CopyField({ label, value, secret }: { label: string; value: string; secret?: boolean }) {
  const [shown, setShown] = useState(!secret)
  const [copied, setCopied] = useState(false)
  return (
    <div>
      <div className="mb-1.5 text-xs font-medium text-fg-2">{label}</div>
      <div className="flex items-center gap-1 rounded-lg bg-black/30 py-1 pr-1 pl-3 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]">
        <code className="min-w-0 flex-1 truncate font-mono text-xs text-fg-2">{shown ? value : '•'.repeat(Math.min(32, value.length))}</code>
        {secret && (
          <button type="button" aria-label={shown ? 'Hide' : 'Show'} onClick={() => setShown(!shown)} className="grid size-7 place-items-center rounded-md text-fg-4 hover:bg-white/[0.06] hover:text-fg-2">
            {shown ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </button>
        )}
        <button
          type="button"
          aria-label="Copy"
          onClick={() => {
            void navigator.clipboard.writeText(value)
            setCopied(true)
            setTimeout(() => setCopied(false), 1400)
          }}
          className="grid size-7 place-items-center rounded-md text-fg-4 hover:bg-white/[0.06] hover:text-fg-2"
        >
          {copied ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
        </button>
      </div>
    </div>
  )
}

function AgentsPane() {
  const status = useBridge((s) => s.status)
  const tools = useBridge((s) => s.toolNames)
  const log = useBridge((s) => s.log)
  const [busy, setBusy] = useState(false)
  const toggle = async (on: boolean) => {
    setBusy(true)
    try {
      await setBridgeEnabled(on)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  const auth = status.token ? `Authorization: Bearer ${status.token}` : ''
  return (
    <div>
      <PaneHeader
        icon={<IconTile tone="lumen"><Waypoints /></IconTile>}
        title="Lumen MCP server"
        subtitle="Let AI agents — Claude Code, Claude Desktop or any MCP client — drive this editor: cut, arrange, title, grade, and render with Blender and HyperFrames."
        right={<Switch aria-label="Enable Lumen MCP server" checked={status.running} disabled={busy} onChange={(on) => void toggle(on)} />}
      />
      {status.error && <div className="mb-4 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{status.error}</div>}
      {status.running && status.url ? (
        <div className="space-y-4">
          <CopyField label="Endpoint (Streamable HTTP, this computer only)" value={status.url} />
          <CopyField label="Access token" value={status.token ?? ''} secret />
          <CopyField label="Claude Code" value={`claude mcp add --transport http lumen ${status.url} --header "${auth}"`} secret />
          <CopyField label=".mcp.json" value={JSON.stringify({ mcpServers: { lumen: { type: 'http', url: status.url, headers: { Authorization: `Bearer ${status.token}` } } } })} secret />
          <div className="flex items-center justify-between text-2xs text-fg-4">
            <span>{tools.length} tools exposed · edits show up in History like your own, and can be undone.</span>
            <button type="button" className="text-fg-3 hover:text-fg" onClick={() => void regenerateBridgeToken()}>
              New token
            </button>
          </div>
          {log.length > 0 && (
            <Card className="p-0">
              <div className="border-b border-line px-4 py-2.5 text-xs font-medium text-fg-2">Recent agent activity</div>
              <div className="max-h-48 overflow-y-auto py-1">
                {log.map((entry) => (
                  <div key={entry.id} className="flex items-center gap-2.5 px-4 py-1.5 text-xs">
                    <StatusDot status={entry.ok ? 'ready' : 'error'} />
                    <span className="font-mono text-fg-2">{entry.tool}</span>
                    <span className="truncate text-fg-4">{entry.detail}</span>
                    <span className="ml-auto shrink-0 font-mono text-2xs text-fg-4">{new Date(entry.at).toLocaleTimeString()}</span>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      ) : (
        <Card>
          <p className="text-sm leading-relaxed text-fg-2">When it’s on, Lumen listens on 127.0.0.1 only and every request needs a secret token. Scripts that would run code in Blender always ask you first.</p>
        </Card>
      )}
    </div>
  )
}
