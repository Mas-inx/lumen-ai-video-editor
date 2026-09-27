/**
 * Integrations in the editor: Blender, HyperFrames and MCP servers, as seen
 * from the UI. Talks to the main process through window.lumen.integrations;
 * finished renders and generations land in the project's media automatically.
 */
import { toast } from 'sonner'
import { create } from 'zustand'
import type {
  TranscriptSegment,
  BlenderInfo,
  BlenderRenderRequest,
  GeneratedAsset,
  ImageGenRequest,
  Job,
  McpServerConfig,
  McpServerState,
  MotionRenderRequest,
  Provenance,
  VideoGenRequest,
} from '@shared/integrations'
import { dispatch, getProject } from '@/editor/store'
import type { Asset } from '@/editor/types'
import { speechAudio } from '@/engine/audio-engine'
import { speechWav } from '@/engine/wav'
import { probeMedia } from '@/engine/decode'
import { analyzeAssets } from '@/project/media-import'
import { uid } from '@/lib/id'

export const api = typeof window !== 'undefined' ? window.lumen?.integrations : undefined

interface IntegrationsState {
  /** False in the browser build — integrations need the desktop app. */
  available: boolean
  blender: BlenderInfo | null
  checkingBlender: boolean
  servers: Record<string, McpServerState>
  jobs: Record<string, Job>
  /** job id → asset ids it added to the project */
  imported: Record<string, string[]>
  hubOpen: boolean
  hubFocus: string | null
  elevenlabs: { configured: boolean; keyHint?: string } | null
  voices: { id: string; name: string; category?: string; labels?: Record<string, string>; previewUrl?: string | null }[]
}

export const useIntegrations = create<IntegrationsState>(() => ({
  available: Boolean(api),
  blender: null,
  checkingBlender: false,
  servers: {},
  jobs: {},
  imported: {},
  hubOpen: false,
  hubFocus: null,
  elevenlabs: null,
  voices: [],
}))

export const openIntegrations = (focus: string | null = null) => useIntegrations.setState({ hubOpen: true, hubFocus: focus })

let started = false

/** Wires up live job/MCP events. Safe to call more than once. */
export function startIntegrations() {
  if (started || !api) return
  started = true
  api.onJob(onJob)
  api.onMcp(onServer)
  void api.jobs.list().then((jobs) => jobs.forEach(onJob))
  void api.mcp.list().then((list) => useIntegrations.setState({ servers: Object.fromEntries(list.map((s) => [s.config.id, s])) }))
  void refreshBlender()
  void api.elevenlabs.state().then((elevenlabs) => {
    useIntegrations.setState({ elevenlabs })
    if (elevenlabs.configured) void loadVoices()
  })
}

function onServer(state: McpServerState) {
  useIntegrations.setState((s) => ({ servers: { ...s.servers, [state.config.id]: state } }))
}

/** Jobs the user cleared from the list; late events for them are ignored. */
const cleared = new Set<string>()

function onJob(job: Job) {
  if (cleared.has(job.id)) return
  const prev = useIntegrations.getState().jobs[job.id]
  useIntegrations.setState((s) => ({ jobs: { ...s.jobs, [job.id]: job } }))
  if (job.status === 'done' && job.assets?.length && !useIntegrations.getState().imported[job.id]) void importJob(job)
  if (job.status === 'done' && job.transcript && transcribing.has(job.id)) attachTranscript(job.id, job.transcript)
  if (prev?.status === 'running' && job.status === 'error') toast.error(job.title, { description: job.error })
}

// ─── Media ───────────────────────────────────────────────────────────────

const sourceKey = (s: GeneratedAsset['source'] | Asset['source']) => (s.type === 'sequence' ? s.base : s.type === 'file' ? s.url : '')

/** Turns a generated file/sequence into a project asset (probing files for duration, poster, peaks). */
export async function addGeneratedAsset(g: GeneratedAsset): Promise<string> {
  const existing = Object.values(getProject().assets).find((a) => sourceKey(a.source) && sourceKey(a.source) === sourceKey(g.source))
  if (existing) return existing.id
  let extra: Partial<Asset> = {}
  let source = g.source
  if (g.source.type === 'file') {
    try {
      const meta = await probeMedia(g.source.url, g.source.mime)
      extra = Object.fromEntries(
        Object.entries({ duration: meta.duration, width: meta.width, height: meta.height, fps: meta.fps, hasAudio: meta.kind === 'image' ? undefined : meta.hasAudio }).filter(([, v]) => v !== undefined),
      )
      if (meta.poster) source = { ...g.source, poster: meta.poster }
    } catch {
      /* keep what we know */
    }
  }
  const asset: Asset = {
    id: uid('asset'),
    name: g.name,
    kind: g.kind,
    duration: g.duration,
    width: g.width,
    height: g.height,
    fps: g.fps,
    ...extra,
    source,
    alpha: g.alpha,
    transcript: g.transcript?.length ? g.transcript : undefined,
    generated: true,
    provenance: { integration: g.provenance.integration, tool: g.provenance.tool, prompt: g.provenance.prompt, params: g.provenance.params },
    tags: ['ai', g.provenance.integration],
    addedAt: Date.now(),
  }
  if (g.kind === 'image') delete asset.duration
  const res = dispatch('asset.add', { asset }, { source: 'ai', label: `Add ${asset.name}` })
  if (!res.ok) throw new Error(res.error)
  void analyzeAssets([asset.id])
  return asset.id
}

async function importJob(job: Job) {
  useIntegrations.setState((s) => ({ imported: { ...s.imported, [job.id]: [] } }))
  const ids: string[] = []
  for (const g of job.assets ?? []) {
    try {
      ids.push(await addGeneratedAsset(g))
    } catch (err) {
      toast.error(`Couldn’t add ${g.name}`, { description: String(err) })
    }
  }
  useIntegrations.setState((s) => ({ imported: { ...s.imported, [job.id]: ids } }))
}

/** Downloads a URL a tool returned and adds it to the project. */
export async function importLink(url: string, name?: string, provenance?: Provenance) {
  if (!api) throw new Error('Importing needs the desktop app.')
  const g = await api.media.importUrl(url, name, provenance)
  return addGeneratedAsset(g)
}

// ─── Blender ─────────────────────────────────────────────────────────────

export async function refreshBlender() {
  if (!api) return null
  useIntegrations.setState({ checkingBlender: true })
  try {
    const blender = await api.blender.detect()
    useIntegrations.setState({ blender })
    return blender
  } finally {
    useIntegrations.setState({ checkingBlender: false })
  }
}

export async function setBlenderPath(path: string | null) {
  if (!api) return
  useIntegrations.setState({ blender: await api.blender.setPath(path) })
}

/** Output size/rate for renders: the project's canvas. */
export function projectFrame() {
  const { width, height, fps } = getProject().settings
  return { width, height, fps }
}

export async function renderBlender(req: Omit<BlenderRenderRequest, 'width' | 'height' | 'fps'> & Partial<Pick<BlenderRenderRequest, 'width' | 'height' | 'fps'>>) {
  if (!api) throw new Error('Blender renders need the desktop app.')
  const job = await api.blender.render({ ...projectFrame(), ...req })
  onJob(job)
  return job
}

export async function renderMotion(req: Omit<MotionRenderRequest, 'width' | 'height' | 'fps'> & Partial<Pick<MotionRenderRequest, 'width' | 'height' | 'fps'>>) {
  if (!api) throw new Error('Motion graphics need the desktop app.')
  const job = await api.motion.render({ ...projectFrame(), ...req })
  onJob(job)
  return job
}

// ─── MCP ─────────────────────────────────────────────────────────────────

export async function saveServer(config: McpServerConfig) {
  if (!api) return
  const list = await api.mcp.save(config)
  useIntegrations.setState({ servers: Object.fromEntries(list.map((s) => [s.config.id, s])) })
}

export async function removeServer(id: string) {
  if (!api) return
  const list = await api.mcp.remove(id)
  useIntegrations.setState({ servers: Object.fromEntries(list.map((s) => [s.config.id, s])) })
}

export async function connectServer(id: string) {
  if (!api) return
  onServer(await api.mcp.connect(id))
}

export async function disconnectServer(id: string) {
  if (!api) return
  onServer(await api.mcp.disconnect(id))
}

export async function signOutServer(id: string) {
  if (!api) return
  onServer(await api.mcp.signOut(id))
}

export async function callTool(serverId: string, tool: string, args: Record<string, unknown>) {
  if (!api) throw new Error('MCP tools need the desktop app.')
  const job = await api.mcp.call(serverId, tool, args)
  onJob(job)
  return job
}

export const cancelJob = (id: string) => api?.jobs.cancel(id)

/** Forgets finished jobs in the UI (their media stays in the project). */
export function clearFinishedJobs() {
  useIntegrations.setState((s) => {
    for (const [id, j] of Object.entries(s.jobs)) if (j.status !== 'running') cleared.add(id)
    return { jobs: Object.fromEntries(Object.entries(s.jobs).filter(([, j]) => j.status === 'running')) }
  })
}

/** Tools across connected servers that look like they make media. */
export function generatorTools(servers: Record<string, McpServerState>) {
  const out: { serverId: string; server: string; tool: McpServerState['tools'][number] }[] = []
  for (const s of Object.values(servers)) {
    if (s.status !== 'connected') continue
    for (const tool of s.tools) {
      const text = `${tool.name} ${tool.title ?? ''} ${tool.description ?? ''}`.toLowerCase()
      if (/generat|create|render|text.?to|image|video|animate|upscale|speech|voice|music/.test(text)) out.push({ serverId: s.config.id, server: s.config.name, tool })
    }
  }
  return out
}

// ─── ElevenLabs ──────────────────────────────────────────────────────────

export async function setElevenLabsKey(key: string | null) {
  if (!api) return
  const elevenlabs = await api.elevenlabs.setKey(key)
  useIntegrations.setState({ elevenlabs, voices: elevenlabs.configured ? useIntegrations.getState().voices : [] })
  if (elevenlabs.configured) await loadVoices()
}

export async function loadVoices() {
  if (!api) return
  try {
    useIntegrations.setState({ voices: await api.elevenlabs.voices() })
  } catch {
    /* key problems show up when generating */
  }
}

const track = (job: Job) => {
  onJob(job)
  return job
}

export async function elevenSpeak(req: { text: string; voiceId: string; voiceName?: string; modelId?: string }) {
  if (!api) throw new Error('Needs the desktop app.')
  return track(await api.elevenlabs.speak(req))
}

export async function elevenSfx(req: { prompt: string; durationSeconds?: number; loop?: boolean }) {
  if (!api) throw new Error('Needs the desktop app.')
  return track(await api.elevenlabs.soundEffect(req))
}

export async function elevenMusic(req: { prompt: string; lengthSeconds: number; instrumental?: boolean }) {
  if (!api) throw new Error('Needs the desktop app.')
  return track(await api.elevenlabs.music(req))
}

// ─── Image & video generation (OpenAI / Google keys) ─────────────────────

export type GenProvider = 'openai' | 'gemini'

interface GenModelsState {
  models: Partial<Record<GenProvider, { image: string[]; video: string[]; error?: string; loading?: boolean }>>
}

export const useGenModels = create<GenModelsState>(() => ({ models: {} }))

/** Which image / video models each connected key can use (fetched once, then cached). */
export async function loadGenModels(provider: GenProvider, refresh = false) {
  if (!api) return
  const prev = useGenModels.getState().models[provider]
  if (prev && !prev.error && !refresh && (prev.loading || prev.image.length || prev.video.length)) return
  useGenModels.setState((s) => ({ models: { ...s.models, [provider]: { image: prev?.image ?? [], video: prev?.video ?? [], loading: true } } }))
  try {
    const m = await api.ai.mediaModels(provider, refresh)
    useGenModels.setState((s) => ({ models: { ...s.models, [provider]: { ...m, loading: false } } }))
  } catch (err) {
    useGenModels.setState((s) => ({
      models: { ...s.models, [provider]: { image: [], video: [], loading: false, error: err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err) } },
    }))
  }
}

export async function generateImage(req: ImageGenRequest) {
  if (!api) throw new Error('Needs the desktop app.')
  return track(await api.ai.generateImage(req))
}

export async function generateVideo(req: VideoGenRequest) {
  if (!api) throw new Error('Needs the desktop app.')
  return track(await api.ai.generateVideo(req))
}

/** transcription job id → the asset it belongs to */
const transcribing = new Map<string, string>()

function attachTranscript(jobId: string, transcript: TranscriptSegment[]) {
  const assetId = transcribing.get(jobId)
  transcribing.delete(jobId)
  if (!assetId || !getProject().assets[assetId]) return
  dispatch('asset.update', { id: assetId, patch: { transcript } }, { source: 'ai', label: 'Add transcript' })
  toast.success('Transcript added', { description: `${transcript.length} phrases — captions and pause removal now use it.` })
}

export const canTranscribe = (asset: Asset | undefined) => Boolean(asset && asset.source.type === 'file' && (asset.kind === 'audio' || asset.kind === 'video'))

/** Starts an ElevenLabs Scribe job for an asset; the transcript attaches itself when the job finishes. */
export async function transcribeAsset(assetId: string, languageCode?: string) {
  if (!api) throw new Error('Needs the desktop app.')
  const asset = getProject().assets[assetId]
  if (!asset || asset.source.type !== 'file') throw new Error('Only imported audio and video can be transcribed.')
  const buffer = await speechAudio(asset)
  if (!buffer) throw new Error('This media has no sound to transcribe.')
  const wav = await speechWav(buffer)
  const job = await api.elevenlabs.transcribe(wav.buffer, asset.name, languageCode)
  transcribing.set(job.id, assetId)
  return track(job)
}
