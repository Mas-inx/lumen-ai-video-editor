/**
 * The Copilot's brains, as the editor sees them: model providers (keys live in
 * the main process — the editor only sees hints) and the user's local agents.
 */
import { create } from 'zustand'
import {
  cleanTarget,
  PROVIDERS,
  type AgentEvent,
  type CopilotTarget,
  type Effort,
  type LocalAgentId,
  type LocalAgentState,
  type ModelInfo,
  type ProviderId,
  type ProviderState,
} from '@shared/ai'
import { api } from './store'

const TARGET_KEY = 'lumen.copilot.target'

/** The brain the user picked; null means "automatic" (the best one that's ready). */
function loadTarget(): CopilotTarget | null {
  try {
    const raw = localStorage.getItem(TARGET_KEY)
    return raw ? cleanTarget(JSON.parse(raw)) : null
  } catch {
    return null
  }
}

interface AiState {
  providers: Record<ProviderId, ProviderState | undefined>
  models: Partial<Record<ProviderId, { models: ModelInfo[]; error?: string; loading?: boolean }>>
  localAgents: Record<LocalAgentId, LocalAgentState | undefined>
  signingIn: Partial<Record<LocalAgentId | 'openrouter', boolean>>
  target: CopilotTarget | null
}

export const useAi = create<AiState>(() => ({
  providers: {} as AiState['providers'],
  models: {},
  localAgents: {} as AiState['localAgents'],
  signingIn: {},
  target: loadTarget(),
}))

export function setTarget(target: CopilotTarget | null) {
  useAi.setState({ target })
  try {
    localStorage.setItem(TARGET_KEY, JSON.stringify(target))
  } catch {
    /* storage unavailable */
  }
}

/** Switches brain, keeping the chosen effort when the new model takes it too. */
export function chooseTarget(next: CopilotTarget | null) {
  const effort = useAi.getState().target?.effort
  if (!next || !effort || next.effort) return setTarget(next)
  setTarget(targetEfforts(next).levels.includes(effort) ? { ...next, effort } : next)
}

/** Sets the effort for the chosen brain (undefined: the model's default). */
export function setEffort(effort: Effort | undefined) {
  const target = useAi.getState().target
  if (target) setTarget({ ...target, effort })
}

const eventListeners = new Set<(e: AgentEvent) => void>()
export const onAgentEvent = (fn: (e: AgentEvent) => void) => {
  eventListeners.add(fn)
  return () => void eventListeners.delete(fn)
}

let started = false
export function startAi() {
  if (started || !api) return
  started = true
  api.ai.onEvent((e) => eventListeners.forEach((fn) => fn(e)))
  void refreshProviders()
  void refreshLocalAgents()
}

// ─── Providers ───────────────────────────────────────────────────────────

export async function refreshProviders() {
  if (!api) return
  const list = await api.ai.providers()
  useAi.setState({ providers: Object.fromEntries(list.map((p) => [p.id, p])) as AiState['providers'] })
  // Warm the model lists of anything already set up.
  for (const p of list) if (p.configured && !PROVIDERS.find((s) => s.id === p.id)?.local) void loadModels(p.id)
}

function putProvider(state: ProviderState) {
  useAi.setState((s) => ({ providers: { ...s.providers, [state.id]: state }, models: { ...s.models, [state.id]: undefined } }))
}

export async function setProviderKey(id: ProviderId, key: string | null) {
  if (!api) return
  putProvider(await api.ai.setProvider(id, { key }))
  if (key) await loadModels(id, true)
}

export async function setProviderBaseURL(id: ProviderId, baseURL: string | null) {
  if (!api) return
  putProvider(await api.ai.setProvider(id, { baseURL }))
}

export async function loadModels(id: ProviderId, refresh = false) {
  if (!api) return
  useAi.setState((s) => ({ models: { ...s.models, [id]: { models: s.models[id]?.models ?? [], loading: true } } }))
  const res = await api.ai.models(id, refresh)
  useAi.setState((s) => ({ models: { ...s.models, [id]: { ...res, loading: false } } }))
  return res
}

export async function signInOpenRouter() {
  if (!api) return
  useAi.setState((s) => ({ signingIn: { ...s.signingIn, openrouter: true } }))
  try {
    putProvider(await api.ai.signInOpenRouter())
    await loadModels('openrouter', true)
  } finally {
    useAi.setState((s) => ({ signingIn: { ...s.signingIn, openrouter: false } }))
  }
}

// ─── Local agents ────────────────────────────────────────────────────────

export async function refreshLocalAgents(refresh = false) {
  if (!api) return
  const list = await api.ai.localAgents(refresh)
  useAi.setState({ localAgents: Object.fromEntries(list.map((a) => [a.id, a])) as AiState['localAgents'] })
}

export async function signInLocal(id: LocalAgentId) {
  if (!api) return
  useAi.setState((s) => ({ signingIn: { ...s.signingIn, [id]: true } }))
  try {
    const state = await api.ai.signInLocal(id)
    useAi.setState((s) => ({ localAgents: { ...s.localAgents, [id]: state } }))
    return state
  } finally {
    useAi.setState((s) => ({ signingIn: { ...s.signingIn, [id]: false } }))
  }
}

// ─── Labels ──────────────────────────────────────────────────────────────

export const LOCAL_AGENT_NAMES: Record<LocalAgentId, string> = { 'claude-code': 'Claude Code', codex: 'Codex' }

export function targetLabel(t: CopilotTarget | null): { title: string; subtitle: string } {
  if (!t) {
    const auto = autoTarget()
    return auto ? { title: targetLabel(auto).title, subtitle: 'automatic' } : { title: 'No AI connected', subtitle: 'set one up' }
  }
  if (t.kind === 'local') {
    if (!t.model) return { title: LOCAL_AGENT_NAMES[t.agent], subtitle: 'your account' }
    return { title: targetModel(t)?.name || t.model, subtitle: LOCAL_AGENT_NAMES[t.agent] }
  }
  const spec = PROVIDERS.find((p) => p.id === t.provider)
  return { title: targetModel(t)?.name || t.model, subtitle: spec?.name ?? t.provider }
}

/** What Lumen knows about the target's model (its name, effort levels…), when listed. */
export function targetModel(t: CopilotTarget): ModelInfo | undefined {
  const s = useAi.getState()
  if (t.kind === 'local') return t.model ? s.localAgents[t.agent]?.models?.find((m) => m.id === t.model) : undefined
  return s.models[t.provider]?.models.find((m) => m.id === t.model)
}

/**
 * The effort levels the target takes, and what Default means for it when known —
 * `fromSettings` when that comes from the agent's own settings (Codex's config.toml).
 */
export function targetEfforts(t: CopilotTarget | null): { levels: Effort[]; defaultEffort?: Effort; fromSettings?: boolean } {
  if (!t) return { levels: [] }
  if (t.kind === 'local') {
    const agent = useAi.getState().localAgents[t.agent]
    const model = targetModel(t)
    const levels = (t.model ? model?.efforts : agent?.efforts) ?? []
    if (agent?.settingsEffort) return { levels, defaultEffort: agent.settingsEffort, fromSettings: true }
    return { levels, defaultEffort: t.model ? model?.defaultEffort : agent?.defaultEffort }
  }
  const model = targetModel(t)
  return { levels: model?.efforts ?? [], defaultEffort: model?.defaultEffort }
}

/** Is the selected brain ready to answer? (false → Copilot explains what's missing) */
export function targetReady(t: CopilotTarget | null): boolean {
  const s = useAi.getState()
  if (!t) return Boolean(resolveTarget())
  if (t.kind === 'local') return Boolean(s.localAgents[t.agent]?.found && s.localAgents[t.agent]?.signedIn)
  return Boolean(s.providers[t.provider]?.configured)
}

/** The brain that answers: the user's pick, or the automatic one. */
export function resolveTarget(): CopilotTarget | null {
  return useAi.getState().target ?? autoTarget()
}

/** What Automatic picks: the first brain that's ready — their own Claude Code, then Codex, then a model with a saved key. */
export function autoTarget(): CopilotTarget | null {
  const s = useAi.getState()
  for (const agent of ['claude-code', 'codex'] as const) {
    const a = s.localAgents[agent]
    if (a?.found && a.signedIn) return { kind: 'local', agent }
  }
  for (const spec of PROVIDERS) {
    if (!s.providers[spec.id]?.configured) continue
    const listed = s.models[spec.id]?.models ?? []
    const model = spec.suggested?.find((id) => !listed.length || listed.some((m) => m.id === id)) ?? listed[0]?.id
    if (model) return { kind: 'model', provider: spec.id, model }
  }
  return null
}
