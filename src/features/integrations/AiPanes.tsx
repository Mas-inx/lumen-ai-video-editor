import { Check, ExternalLink, KeyRound, LoaderCircle, LogIn, RefreshCw, Server, Sparkles, Terminal, Trash } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { PROVIDERS, type LocalAgentId, type ProviderSpec } from '@shared/ai'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { LOCAL_AGENT_NAMES, loadModels, refreshLocalAgents, setProviderBaseURL, setProviderKey, setTarget, signInLocal, signInOpenRouter, useAi } from '@/integrations/ai'
import { useIntegrations } from '@/integrations/store'
import { cn } from '@/lib/cn'
import { Card, IconTile, StatusDot } from './parts'

const fail = (err: unknown) => toast.error(err instanceof Error ? err.message : String(err))

function Header({ icon, title, subtitle }: { icon: ReactNode; title: string; subtitle: ReactNode }) {
  return (
    <div className="mb-6 flex items-start gap-4">
      {icon}
      <div className="min-w-0 flex-1">
        <h2 className="text-xl font-semibold tracking-tight text-fg">{title}</h2>
        <p className="mt-0.5 text-sm leading-relaxed text-fg-3">{subtitle}</p>
      </div>
    </div>
  )
}

// ─── AI models ───────────────────────────────────────────────────────────

export function ModelsPane() {
  return (
    <div>
      <Header
        icon={
          <IconTile tone="lumen">
            <Sparkles />
          </IconTile>
        }
        title="AI models"
        subtitle="Bring your own model for Copilot. Keys are encrypted with your OS keychain and only used by Lumen on this computer; usage is billed to your own account with each provider."
      />
      <div className="space-y-2.5">
        {PROVIDERS.map((p) => (
          <ProviderCard key={p.id} spec={p} />
        ))}
      </div>
      <p className="mt-5 text-2xs leading-relaxed text-fg-4">
        Claude and Gemini subscriptions can’t be used by other apps under Anthropic’s and Google’s terms — use an API key, OpenRouter, or your own Claude Code install (see Local agents).
      </p>
    </div>
  )
}

function ProviderCard({ spec }: { spec: ProviderSpec }) {
  const state = useAi((s) => s.providers[spec.id])
  const models = useAi((s) => s.models[spec.id])
  const signingIn = useAi((s) => s.signingIn.openrouter)
  const [editing, setEditing] = useState(false)
  const [key, setKey] = useState('')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const connected = Boolean(state?.configured)
  const needsUrl = spec.local || spec.needsBaseURL

  const act = (fn: () => Promise<unknown>) => async () => {
    setBusy(true)
    try {
      await fn()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const useFirstModel = () => {
    const m = models?.models[0]
    if (!m) return toast('No models found yet — check the key or server.')
    setTarget({ kind: 'model', provider: spec.id, model: m.id })
    toast.success(`Copilot now uses ${m.name}`)
  }

  return (
    <Card className="p-3.5">
      <div className="flex items-center gap-3">
        <span className={cn('grid size-8 shrink-0 place-items-center rounded-lg [&_svg]:size-4', connected ? 'bg-accent/15 text-accent-2' : 'bg-white/[0.05] text-fg-3')}>
          {spec.local ? <Server /> : <KeyRound />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-fg">{spec.name}</span>
            {connected && !spec.local && !spec.needsBaseURL && <StatusDot status="ready" />}
          </div>
          <div className="truncate text-2xs text-fg-4">
            {connected
              ? spec.local || spec.needsBaseURL
                ? (state?.baseURL ?? '')
                : `${state?.via === 'oauth' ? 'Signed in' : 'Key'} ${state?.keyHint ?? ''}${models?.models.length ? ` · ${models.models.length} models` : ''}`
              : spec.tagline}
          </div>
          {models?.error && connected && <div className="mt-0.5 truncate text-2xs text-danger/80">{models.error}</div>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {spec.oauth && !connected && (
            <Button size="sm" variant="primary" disabled={signingIn} onClick={act(signInOpenRouter)}>
              {signingIn ? <LoaderCircle className="animate-spin" /> : <LogIn />} {signingIn ? 'Waiting…' : 'Sign in'}
            </Button>
          )}
          {connected && (
            <Button size="sm" variant="ghost" disabled={busy || models?.loading} onClick={act(() => loadModels(spec.id, true))} title="Refresh models">
              <RefreshCw className={cn(models?.loading && 'animate-spin')} />
            </Button>
          )}
          {connected && models?.models.length ? (
            <Button size="sm" variant="outline" onClick={useFirstModel}>
              Use in Copilot
            </Button>
          ) : null}
          <Button
            size="sm"
            variant={connected ? 'ghost' : 'outline'}
            onClick={() => {
              setEditing(!editing)
              setUrl(state?.baseURL ?? spec.defaultBaseURL ?? '')
            }}
          >
            {connected ? 'Edit' : needsUrl ? 'Set up' : 'Add key'}
          </Button>
        </div>
      </div>

      {editing && (
        <div className="mt-3 space-y-2 border-t border-line pt-3">
          {needsUrl && (
            <div className="flex gap-2">
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={spec.defaultBaseURL ?? 'https://…/v1'} className="font-mono text-xs" />
              <Button
                size="md"
                variant="primary"
                disabled={busy || !url.trim()}
                onClick={act(async () => {
                  await setProviderBaseURL(spec.id, url.trim())
                  const res = await loadModels(spec.id, true)
                  if (res?.error) toast.error(`Couldn’t reach it: ${res.error}`)
                  else setEditing(false)
                })}
              >
                Connect
              </Button>
            </div>
          )}
          {!spec.local && (
            <div className="flex gap-2">
              <Input
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={spec.needsBaseURL ? 'API key (optional)' : (spec.keyPlaceholder ?? 'API key')}
                className="font-mono text-xs"
                autoComplete="off"
              />
              <Button
                size="md"
                variant="primary"
                disabled={busy || !key.trim()}
                onClick={act(async () => {
                  await setProviderKey(spec.id, key.trim())
                  setKey('')
                  const res = useAi.getState().models[spec.id]
                  if (res?.error) toast.error(res.error)
                  else setEditing(false)
                })}
              >
                <Check /> Save
              </Button>
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            {spec.keyUrl ? (
              <a href={spec.keyUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-2xs text-accent-2 hover:underline">
                Get a key <ExternalLink className="size-3" />
              </a>
            ) : (
              <span className="text-2xs text-fg-4">{spec.local ? 'Start the server on this computer, then connect.' : ''}</span>
            )}
            {connected && !spec.local && state?.keyHint && (
              <button type="button" onClick={act(() => setProviderKey(spec.id, null))} className="inline-flex items-center gap-1 text-2xs text-fg-4 hover:text-danger">
                <Trash className="size-3" /> Remove key
              </button>
            )}
          </div>
        </div>
      )}
    </Card>
  )
}

// ─── Local agents ────────────────────────────────────────────────────────

export function LocalAgentsPane() {
  const agents = useAi((s) => s.localAgents)
  const available = useIntegrations((s) => s.available)
  const [checking, setChecking] = useState(false)
  if (!available) return null
  return (
    <div>
      <Header
        icon={
          <IconTile tone="mcp">
            <Terminal />
          </IconTile>
        }
        title="Claude Code & Codex"
        subtitle="Use the Claude Code or Codex already installed on this computer as Copilot’s brain, signed in with your own account. Lumen runs the official tool and gives it only Lumen’s editing tools."
      />
      <div className="space-y-2.5">
        {(['claude-code', 'codex'] as const).map((id) => (
          <LocalAgentCard key={id} id={id} />
        ))}
      </div>
      <Card className="mt-4">
        <div className="text-sm font-medium text-fg">How it works</div>
        <ul className="mt-1.5 space-y-1 text-xs leading-relaxed text-fg-3">
          <li>• Each Copilot message runs the tool in its headless mode, connected to Lumen’s MCP server — the same tools any MCP client gets.</li>
          <li>• Claude Code runs with no shell, file or web tools; Codex runs in its read-only sandbox in an empty folder.</li>
          <li>• Sign-in happens in the tool’s own login flow. Lumen never sees or stores your credentials; usage counts toward your own plan.</li>
        </ul>
      </Card>
      <Button
        size="sm"
        variant="ghost"
        className="mt-3"
        disabled={checking || Object.values(agents).length === 0}
        onClick={async () => {
          setChecking(true)
          try {
            await refreshLocalAgents(true)
          } finally {
            setChecking(false)
          }
        }}
      >
        <RefreshCw className={cn(checking && 'animate-spin')} /> Check again
      </Button>
    </div>
  )
}

const INSTALL: Record<LocalAgentId, string> = {
  'claude-code': 'https://code.claude.com/docs/en/setup',
  codex: 'https://developers.openai.com/codex/cli',
}

function LocalAgentCard({ id }: { id: LocalAgentId }) {
  const a = useAi((s) => s.localAgents[id])
  const signingIn = useAi((s) => s.signingIn[id])
  const target = useAi((s) => s.target)
  const active = target?.kind === 'local' && target.agent === id
  return (
    <Card className="p-3.5">
      <div className="flex items-center gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-white/[0.05] text-fg-2 [&_svg]:size-4">
          <Terminal />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-fg">{LOCAL_AGENT_NAMES[id]}</span>
            {a && <StatusDot status={a.found && a.signedIn ? 'ready' : a.found ? 'needs-auth' : 'disconnected'} />}
          </div>
          <div className="truncate text-2xs text-fg-4">
            {!a ? 'Checking…' : !a.found ? 'Not installed' : `${a.signedIn ? `Signed in · ${a.account ?? 'your account'}` : 'Not signed in'}${a.version ? ` · v${a.version}` : ''}`}
          </div>
          {a?.path && <div className="truncate font-mono text-[10px] text-fg-4/80">{a.path}</div>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {a && !a.found && (
            <a href={INSTALL[id]} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-accent-2 hover:underline">
              Install <ExternalLink className="size-3" />
            </a>
          )}
          {a?.found && !a.signedIn && (
            <Button size="sm" variant="primary" disabled={signingIn} onClick={() => void signInLocal(id).catch(fail)}>
              {signingIn ? <LoaderCircle className="animate-spin" /> : <LogIn />} {signingIn ? 'Finish in the window…' : 'Sign in'}
            </Button>
          )}
          {a?.found && a.signedIn && (
            <Button size="sm" variant={active ? 'ghost' : 'outline'} disabled={active} onClick={() => setTarget({ kind: 'local', agent: id })}>
              {active ? (
                <>
                  <Check /> In use
                </>
              ) : (
                'Use in Copilot'
              )}
            </Button>
          )}
        </div>
      </div>
    </Card>
  )
}
