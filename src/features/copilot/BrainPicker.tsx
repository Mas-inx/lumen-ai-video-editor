import { Command } from 'cmdk'
import { Check, ChevronDown, LoaderCircle, Settings2, Sparkles, Terminal } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { PROVIDERS, type CopilotTarget, type LocalAgentId, type LocalAgentState } from '@shared/ai'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { chooseTarget, LOCAL_AGENT_NAMES, loadModels, signInLocal, targetLabel, targetReady, useAi } from '@/integrations/ai'
import { openIntegrations, useIntegrations } from '@/integrations/store'
import { cn } from '@/lib/cn'

/** Same brain and model — effort aside. */
function same(a: CopilotTarget | null, b: CopilotTarget | null) {
  if (!a || !b) return a === b
  if (a.kind === 'local' && b.kind === 'local') return a.agent === b.agent && a.model === b.model
  if (a.kind === 'model' && b.kind === 'model') return a.provider === b.provider && a.model === b.model
  return false
}

/** Chooses what powers the Copilot: your own Claude Code / Codex, or any model you've added (or automatic). */
export function BrainPicker() {
  const target = useAi((s) => s.target)
  const providers = useAi((s) => s.providers)
  const models = useAi((s) => s.models)
  const localAgents = useAi((s) => s.localAgents)
  const signingIn = useAi((s) => s.signingIn)
  const available = useIntegrations((s) => s.available)
  const [open, setOpen] = useState(false)
  const label = targetLabel(target)
  const ready = targetReady(target)

  const choose = (t: CopilotTarget | null) => {
    chooseTarget(t)
    setOpen(false)
  }

  const signIn = async (id: LocalAgentId) => {
    try {
      const s = await signInLocal(id)
      if (s?.signedIn) choose({ kind: 'local', agent: id })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const configured = PROVIDERS.filter((p) => providers[p.id]?.configured)

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        // Local model servers come and go; re-list them when the picker opens.
        if (o) for (const p of configured) if (p.local || !models[p.id]?.models.length) void loadModels(p.id)
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className="-ml-1.5 flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 outline-none transition-colors hover:bg-white/[0.06] focus-visible:ring-2 focus-visible:ring-accent/60 data-[state=open]:bg-white/[0.07]"
        >
          <span className="relative flex size-1.5 shrink-0">
            {ready && <span className="absolute inset-0 animate-ping rounded-full bg-ok/60" />}
            <span className={cn('relative size-1.5 rounded-full', ready ? 'bg-ok' : 'bg-warn')} />
          </span>
          <span className="truncate font-medium text-fg-2">{label.title}</span>
          <span className="shrink-0 text-fg-4">· {label.subtitle}</span>
          <ChevronDown className="size-3 shrink-0 text-fg-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[340px] p-0">
        <Command loop className="flex flex-col">
          <Command.Input placeholder="Search models…" className="h-10 border-b border-line bg-transparent px-3.5 text-sm text-fg outline-none placeholder:text-fg-4" />
          <Command.List className="max-h-[420px] overflow-y-auto p-1.5 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-fg-4 [&_[cmdk-group-heading]]:uppercase">
            <Command.Empty className="px-3 py-6 text-center text-xs text-fg-4">No models match.</Command.Empty>

            <Command.Group heading="Default">
              <Row
                value="Automatic best available"
                icon={<Sparkles className="size-3.5" />}
                title="Automatic"
                hint={targetLabel(null).subtitle === 'automatic' ? `Uses ${targetLabel(null).title}` : 'Uses the first brain you connect'}
                selected={target === null}
                onSelect={() => choose(null)}
              />
            </Command.Group>

            {available &&
              (['claude-code', 'codex'] as const).map((id) => (
                <Command.Group key={id} heading={`${LOCAL_AGENT_NAMES[id]} · your account`}>
                  <AgentRows
                    id={id}
                    agent={localAgents[id]}
                    target={target}
                    signingIn={Boolean(signingIn[id])}
                    onChoose={choose}
                    onSignIn={() => void signIn(id)}
                  />
                </Command.Group>
              ))}

            {configured.map((p) => {
              const list = models[p.id]
              return (
                <Command.Group key={p.id} heading={p.name}>
                  {list?.loading && !list.models.length && <div className="px-2 py-1.5 text-xs text-fg-4">Loading models…</div>}
                  {list?.error && !list.models.length && <div className="px-2 py-1.5 text-xs text-danger/80">{list.error}</div>}
                  {(list?.models ?? []).slice(0, 400).map((m) => {
                    const t: CopilotTarget = { kind: 'model', provider: p.id, model: m.id }
                    return <Row key={m.id} value={`${p.name} ${m.name} ${m.id}`} title={m.name} hint={m.name !== m.id ? m.id : undefined} selected={same(target, t)} onSelect={() => choose(t)} />
                  })}
                </Command.Group>
              )
            })}
          </Command.List>
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              openIntegrations('ai-models')
            }}
            className="flex items-center gap-2 border-t border-line px-3.5 py-2.5 text-xs text-fg-3 transition-colors hover:bg-white/[0.04] hover:text-fg"
          >
            <Settings2 className="size-3.5" />
            {configured.length ? 'Add or manage models…' : 'Add a model — Claude, GPT, Gemini, OpenRouter…'}
          </button>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/** One local agent: its default and each model it can switch to — or what it needs first. */
function AgentRows({
  id,
  agent,
  target,
  signingIn,
  onChoose,
  onSignIn,
}: {
  id: LocalAgentId
  agent: LocalAgentState | undefined
  target: CopilotTarget | null
  signingIn: boolean
  onChoose: (t: CopilotTarget) => void
  onSignIn: () => void
}) {
  const name = LOCAL_AGENT_NAMES[id]
  if (!agent?.found || !agent.signedIn) {
    return (
      <Row
        value={`${name} local agent`}
        icon={<Terminal className="size-3.5" />}
        title={name}
        hint={!agent ? 'Checking…' : !agent.found ? 'Not installed' : 'Not signed in'}
        selected={false}
        disabled={!agent?.found}
        onSelect={() => (agent?.found ? onSignIn() : openIntegrations('local-agents'))}
        action={
          agent?.found ? (
            <span className="flex items-center gap-1 rounded-md bg-white/[0.08] px-1.5 py-0.5 text-[10px] font-medium text-fg-2">
              {signingIn ? <LoaderCircle className="size-3 animate-spin" /> : null}
              Sign in
            </span>
          ) : undefined
        }
      />
    )
  }
  const fallback: CopilotTarget = { kind: 'local', agent: id }
  const defaultModel = agent.defaultModel && (agent.models?.find((m) => m.id === agent.defaultModel)?.name ?? agent.defaultModel)
  return (
    <>
      <Row
        value={`${name} default model`}
        title="Default model"
        hint={defaultModel ? `${defaultModel} · from your ${name} settings` : `Your ${name} setting · ${agent.account ?? 'signed in'}`}
        selected={same(target, fallback)}
        onSelect={() => onChoose(fallback)}
      />
      {(agent.models ?? []).map((m) => {
        const t: CopilotTarget = { kind: 'local', agent: id, model: m.id }
        return <Row key={m.id} value={`${name} ${m.name} ${m.id}`} title={m.name} hint={m.description ?? m.id} selected={same(target, t)} onSelect={() => onChoose(t)} />
      })}
    </>
  )
}

function Row({
  value,
  title,
  hint,
  icon,
  selected,
  disabled,
  action,
  onSelect,
}: {
  value: string
  title: string
  hint?: string
  icon?: ReactNode
  selected: boolean
  disabled?: boolean
  action?: ReactNode
  onSelect: () => void
}) {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      className={cn(
        'flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm outline-none data-[selected=true]:bg-white/[0.06]',
        disabled && 'opacity-50',
      )}
    >
      {icon && <span className="grid size-6 shrink-0 place-items-center rounded-md bg-white/[0.05] text-fg-3">{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-fg">{title}</span>
        {hint && <span className="block truncate text-[10.5px] text-fg-4">{hint}</span>}
      </span>
      {action}
      {selected && <Check className="size-3.5 shrink-0 text-accent-2" />}
    </Command.Item>
  )
}
