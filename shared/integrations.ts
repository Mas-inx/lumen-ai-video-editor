/**
 * The contract between Lumen's main process — which owns Blender, the
 * HyperFrames renderer and every MCP connection — and the editor UI.
 * Type-only apart from the IPC channel names, so both sides can import it.
 */
import type { AgentEvent, AgentRunRequest, LocalAgentId, LocalAgentState, ModelInfo, ProviderId, ProviderState } from './ai'

// ─── Generated media ─────────────────────────────────────────────────────

export type GeneratedSource =
  /** Numbered PNG frames (with alpha) — what Blender and HyperFrames render. */
  | { type: 'sequence'; base: string; dir?: string; pattern: string; frameCount: number; fps: number; poster?: string }
  /** A single media file on disk (downloads, MCP image/audio results). */
  | { type: 'file'; url: string; path?: string; mime: string; fileName: string; size: number; poster?: string }

/** A timed phrase of speech (voiceovers, transcripts) — what captions and pause detection read. */
export interface TranscriptSegment {
  start: number
  end: number
  text: string
}

export interface Provenance {
  integration: string
  tool: string
  prompt?: string
  params?: Record<string, unknown>
}

/** Everything the editor needs to turn a render into a project asset. */
export interface GeneratedAsset {
  name: string
  kind: 'video' | 'image' | 'audio'
  source: GeneratedSource
  width?: number
  height?: number
  fps?: number
  /** seconds */
  duration?: number
  alpha?: boolean
  /** Speech timings, for voiceovers. */
  transcript?: TranscriptSegment[]
  provenance: Provenance
}

// ─── Jobs ────────────────────────────────────────────────────────────────

export type IntegrationKind = 'blender' | 'hyperframes' | 'mcp' | 'elevenlabs' | 'ai'

// ─── Image & video generation (the user's OpenAI / Google keys) ──────────

export interface ImageGenRequest {
  provider: 'openai' | 'gemini'
  model: string
  prompt: string
  aspect: '16:9' | '9:16' | '1:1'
  quality?: 'low' | 'medium' | 'high'
}

export interface VideoGenRequest {
  provider: 'openai' | 'gemini'
  model: string
  prompt: string
  aspect: '16:9' | '9:16'
  seconds: number
  resolution?: '720p' | '1080p'
}

export interface MediaModels {
  image: string[]
  video: string[]
}
export type JobStatus = 'running' | 'done' | 'error' | 'cancelled'

export interface Job {
  id: string
  integration: IntegrationKind
  title: string
  status: JobStatus
  /** 0–1, or -1 while the length of the work is unknown */
  progress: number
  message?: string
  assets?: GeneratedAsset[]
  /** MCP tool calls keep their full result for the tool explorer. */
  result?: McpCallResult
  /** Transcription jobs return phrase timings. */
  transcript?: TranscriptSegment[]
  error?: string
  startedAt: number
  finishedAt?: number
}

// ─── Blender ─────────────────────────────────────────────────────────────

export interface BlenderInfo {
  found: boolean
  path?: string
  version?: string
  /** The BlenderMCP add-on socket is reachable, i.e. a Blender window is open and listening. */
  live: boolean
}

export type BlenderTemplate = 'title3d' | 'shapes' | 'script'
export type RenderQuality = 'draft' | 'standard' | 'high'

export interface BlenderRenderRequest {
  template: BlenderTemplate
  /** Template parameters (text, material, motion, palette…). */
  params: Record<string, unknown>
  /** bpy code for the `script` template: runs once, may define animate(t, frame). */
  script?: string
  name?: string
  prompt?: string
  width: number
  height: number
  fps: number
  /** seconds */
  duration: number
  quality?: RenderQuality
  /** Transparent background (default true, except for `shapes` backgrounds). */
  transparent?: boolean
}

export interface BlenderLiveResult {
  ok: boolean
  result?: unknown
  error?: string
}

// ─── HyperFrames (HTML motion graphics) ──────────────────────────────────

export type MotionTemplate = 'lower-third' | 'kinetic' | 'counter' | 'title-card' | 'custom'

export interface MotionRenderRequest {
  template: MotionTemplate
  params: Record<string, unknown>
  /** A complete HyperFrames composition for the `custom` template. */
  html?: string
  name?: string
  prompt?: string
  width: number
  height: number
  fps: number
  /** seconds; defaults to the composition's own duration */
  duration?: number
}

// ─── MCP ─────────────────────────────────────────────────────────────────

export type McpTransportKind = 'stdio' | 'http'

export interface McpServerConfig {
  id: string
  name: string
  transport: McpTransportKind
  /** stdio */
  command?: string
  args?: string[]
  env?: Record<string, string>
  /** http (Streamable HTTP, falling back to SSE) */
  url?: string
  headers?: Record<string, string>
  enabled: boolean
  /** Catalog entry this server was added from. */
  preset?: string
  description?: string
  /** Copilot and agents may call this server's tools (default on). */
  agentTools?: boolean
}

export type McpStatus = 'disconnected' | 'connecting' | 'needs-auth' | 'connected' | 'error'

export interface McpTool {
  name: string
  title?: string
  description?: string
  inputSchema: Record<string, unknown>
  /** The server's hints: read-only tools change nothing, destructive ones can't be undone. */
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }
}

/** What a tool said, for an AI agent: text and pictures as-is (nothing saved or imported). */
export interface McpAgentResult {
  isError: boolean
  text: string[]
  images: { data: string; mimeType: string }[]
  links: McpLink[]
  structured?: unknown
}

export interface McpServerState {
  config: McpServerConfig
  status: McpStatus
  error?: string
  tools: McpTool[]
  server?: { name: string; version: string }
  /** Signed in with OAuth (tokens stored, encrypted, on this machine). */
  authorized?: boolean
}

export interface McpLink {
  url: string
  mime?: string
  name?: string
}

export interface McpCallResult {
  isError: boolean
  /** Text blocks, in order. */
  text: string[]
  /** Media the tool returned inline (saved to disk and ready to add). */
  media: GeneratedAsset[]
  /** Media URLs found in the result — import them with media.importUrl. */
  links: McpLink[]
  structured?: unknown
}

// ─── IPC ─────────────────────────────────────────────────────────────────

export const IPC = {
  blenderDetect: 'lumen:blender:detect',
  blenderSetPath: 'lumen:blender:set-path',
  blenderRender: 'lumen:blender:render',
  blenderLive: 'lumen:blender:live',
  motionRender: 'lumen:motion:render',
  mcpList: 'lumen:mcp:list',
  mcpSave: 'lumen:mcp:save',
  mcpRemove: 'lumen:mcp:remove',
  mcpConnect: 'lumen:mcp:connect',
  mcpDisconnect: 'lumen:mcp:disconnect',
  mcpSignOut: 'lumen:mcp:sign-out',
  mcpCall: 'lumen:mcp:call',
  mcpCallForAgent: 'lumen:mcp:call-for-agent',
  mediaImportUrl: 'lumen:media:import-url',
  mediaReveal: 'lumen:media:reveal',
  jobsList: 'lumen:jobs:list',
  jobsCancel: 'lumen:jobs:cancel',
  bridgeState: 'lumen:bridge:state',
  bridgeSetEnabled: 'lumen:bridge:set-enabled',
  bridgeRegenerate: 'lumen:bridge:regenerate',
  bridgeRequest: 'lumen:bridge:request',
  bridgeResponse: 'lumen:bridge:response',
  bridgeEvent: 'lumen:bridge:event',
  elevenState: 'lumen:eleven:state',
  elevenSetKey: 'lumen:eleven:set-key',
  elevenVoices: 'lumen:eleven:voices',
  elevenSpeak: 'lumen:eleven:speak',
  elevenSfx: 'lumen:eleven:sfx',
  elevenMusic: 'lumen:eleven:music',
  elevenTranscribe: 'lumen:eleven:transcribe',
  aiProviders: 'lumen:ai:providers',
  aiSetProvider: 'lumen:ai:set-provider',
  aiModels: 'lumen:ai:models',
  aiSignInOpenRouter: 'lumen:ai:openrouter-sign-in',
  aiLocalAgents: 'lumen:ai:local-agents',
  aiSignInLocal: 'lumen:ai:local-sign-in',
  aiRun: 'lumen:ai:run',
  aiStop: 'lumen:ai:stop',
  aiForget: 'lumen:ai:forget',
  aiTranscribe: 'lumen:ai:transcribe',
  aiMediaModels: 'lumen:ai:media-models',
  aiGenerateImage: 'lumen:ai:generate-image',
  aiGenerateVideo: 'lumen:ai:generate-video',
  /** main → renderer */
  jobEvent: 'lumen:job',
  mcpEvent: 'lumen:mcp',
  aiEvent: 'lumen:ai:event',
} as const

/** What the preload exposes as `window.lumen.integrations`. */
export interface IntegrationsAPI {
  blender: {
    detect(): Promise<BlenderInfo>
    setPath(path: string | null): Promise<BlenderInfo>
    /** Starts a headless render; resolves with the job once it has started. */
    render(req: BlenderRenderRequest): Promise<Job>
    /** Runs bpy code in the user's open Blender (needs the BlenderMCP add-on). */
    runLive(code: string): Promise<BlenderLiveResult>
  }
  motion: {
    render(req: MotionRenderRequest): Promise<Job>
  }
  mcp: {
    list(): Promise<McpServerState[]>
    save(config: McpServerConfig): Promise<McpServerState[]>
    remove(id: string): Promise<McpServerState[]>
    connect(id: string): Promise<McpServerState>
    disconnect(id: string): Promise<McpServerState>
    signOut(id: string): Promise<McpServerState>
    /** Starts a tool call; resolves with the running job — progress and the result arrive as job events. */
    call(serverId: string, tool: string, args: Record<string, unknown>): Promise<Job>
    /** Calls a tool for an AI agent and resolves with what it said (no job, nothing imported). */
    callForAgent(serverId: string, tool: string, args: Record<string, unknown>): Promise<McpAgentResult>
  }
  media: {
    /** Downloads remote media into Lumen's library folder. */
    importUrl(url: string, name?: string, provenance?: Provenance): Promise<GeneratedAsset>
    reveal(url: string): Promise<void>
  }
  jobs: {
    list(): Promise<Job[]>
    cancel(id: string): Promise<void>
  }
  /** ElevenLabs: voice, transcription, sound effects, music (API key). */
  elevenlabs: {
    state(): Promise<{ configured: boolean; keyHint?: string }>
    setKey(key: string | null): Promise<{ configured: boolean; keyHint?: string }>
    voices(search?: string): Promise<{ id: string; name: string; category?: string; labels?: Record<string, string>; previewUrl?: string | null }[]>
    speak(req: { text: string; voiceId: string; voiceName?: string; modelId?: string }): Promise<Job>
    soundEffect(req: { prompt: string; durationSeconds?: number; loop?: boolean }): Promise<Job>
    music(req: { prompt: string; lengthSeconds: number; instrumental?: boolean }): Promise<Job>
    /** Scribe transcription of a WAV the editor extracted; the job carries the transcript. */
    transcribe(wav: ArrayBuffer, name: string, languageCode?: string): Promise<Job>
  }
  /** The Copilot's brains: model providers and the user's local agents. */
  ai: {
    providers(): Promise<ProviderState[]>
    setProvider(id: ProviderId, patch: { key?: string | null; baseURL?: string | null }): Promise<ProviderState>
    models(id: ProviderId, refresh?: boolean): Promise<{ models: ModelInfo[]; error?: string }>
    /** "Sign in with OpenRouter" (OAuth PKCE); resolves once the key is stored. */
    signInOpenRouter(): Promise<ProviderState>
    localAgents(refresh?: boolean): Promise<LocalAgentState[]>
    /** Opens the agent's own login in a terminal; resolves when it reports signed in (or times out). */
    signInLocal(id: LocalAgentId): Promise<LocalAgentState>
    /** Starts a Copilot turn; events arrive through onEvent. */
    run(req: AgentRunRequest): Promise<void>
    stop(runId: string): Promise<void>
    /** Drops a conversation's history / agent session. */
    forget(conversationId: string): Promise<void>
    onEvent(cb: (event: AgentEvent) => void): () => void
    /** Speech-to-text with the user's OpenAI key (16 kHz mono WAV in, timed phrases out). */
    transcribe(wav: Uint8Array, language?: string): Promise<TranscriptSegment[]>
    /** Image / video models the provider key can use. */
    mediaModels(provider: 'openai' | 'gemini', refresh?: boolean): Promise<MediaModels>
    generateImage(req: ImageGenRequest): Promise<Job>
    generateVideo(req: VideoGenRequest): Promise<Job>
  }
  /** Lumen's own MCP server, for external agents. */
  bridge: {
    state(): Promise<BridgeState>
    setEnabled(on: boolean): Promise<BridgeState>
    regenerateToken(): Promise<BridgeState>
    /** The editor answers agents' requests (listing and running its tools). */
    serve(handler: (req: BridgeRequest) => Promise<BridgeTool[] | BridgeToolResult>): () => void
    onState(cb: (state: BridgeState) => void): () => void
  }
  onJob(cb: (job: Job) => void): () => void
  onMcp(cb: (state: McpServerState) => void): () => void
}

// ─── Lumen's own MCP server (external agents driving the editor) ─────────

/** main → editor: an agent listed or called a tool. */
export interface BridgeRequest {
  id: string
  method: 'tools' | 'call'
  tool?: string
  args?: Record<string, unknown>
}

/** An MCP tool definition as the editor serves it. */
export interface BridgeTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** An MCP CallToolResult, as the editor produces it. */
export interface BridgeToolResult {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]
  isError?: boolean
  structuredContent?: Record<string, unknown>
}

export interface BridgeResponse {
  id: string
  ok: boolean
  result?: BridgeTool[] | BridgeToolResult
  error?: string
}

export interface BridgeStatus {
  running: boolean
  port: number
  url?: string
  token?: string
  error?: string
}

export interface BridgeLogEntry {
  id: string
  tool: string
  at: number
  ok: boolean
  detail?: string
}

export interface BridgeState {
  status: BridgeStatus
  log: BridgeLogEntry[]
}

/** This computer or the local network (a game server in the next room): plain http is allowed there. */
export function isPrivateHost(hostname: string) {
  if (['localhost', '127.0.0.1', '[::1]'].includes(hostname) || hostname.endsWith('.local') || hostname.endsWith('.localhost')) return true
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(hostname)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  // 10/8, 172.16/12, 192.168/16, 100.64/10 (Tailscale and other carrier-grade NAT VPNs)
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
}

// ─── MCP catalog ─────────────────────────────────────────────────────────

export interface McpCatalogEntry extends Omit<McpServerConfig, 'enabled'> {
  tagline: string
  /** What the user needs before connecting. */
  requirement?: string
  docs?: string
  /** The address differs per install (a game server): the user edits `url`, with this hint. */
  urlHint?: string
  /** Shown under the key field. */
  keyHint?: string
  auth: 'oauth' | 'none' | 'local' | 'key'
  /** For `key` auth: the header the key goes in, e.g. Authorization with a "Bearer " prefix. */
  keyHeader?: string
  keyPrefix?: string
  keyUrl?: string
}

/** Servers Lumen knows how to set up in one click. Anything else can be added by URL or command. */
export const MCP_CATALOG: McpCatalogEntry[] = [
  {
    id: 'higgsfield',
    preset: 'higgsfield',
    name: 'Higgsfield',
    transport: 'http',
    url: 'https://mcp.higgsfield.ai/mcp',
    tagline: 'Video & image generation — Veo, Kling, Flux, Nano Banana and more',
    requirement: 'A Higgsfield account (generations use your credits)',
    docs: 'https://higgsfield.ai/blog/MCP-For-Motion-Designers',
    auth: 'oauth',
  },
  {
    id: 'runway',
    preset: 'runway',
    name: 'Runway',
    transport: 'http',
    url: 'https://mcp.runwayml.com/mcp',
    tagline: 'Gen-4.5 and other video & image models, on your Runway plan',
    requirement: 'A Runway account (generations use your plan’s credits)',
    docs: 'https://runway.com/mcp',
    auth: 'oauth',
  },
  {
    id: 'replicate',
    preset: 'replicate',
    name: 'Replicate',
    transport: 'http',
    url: 'https://mcp.replicate.com/sse',
    tagline: 'Search and run thousands of open models — video, image, audio',
    requirement: 'A Replicate account and API token (you paste it during sign-in)',
    docs: 'https://replicate.com/docs/reference/mcp',
    auth: 'oauth',
  },
  {
    id: 'fal',
    preset: 'fal',
    name: 'fal.ai',
    transport: 'http',
    url: 'https://mcp.fal.ai/mcp',
    tagline: 'Fast generative media — search, price and run fal’s models',
    requirement: 'A fal API key',
    docs: 'https://fal.ai/docs/documentation/setting-up/mcp',
    auth: 'key',
    keyHeader: 'Authorization',
    keyPrefix: 'Bearer ',
    keyUrl: 'https://fal.ai/dashboard/keys',
  },
  {
    id: 'gs-cinematic-studio',
    preset: 'gs-cinematic-studio',
    name: 'GS Cinematic Studio',
    transport: 'http',
    url: 'http://127.0.0.1:30120/gs-cinematic-studio/mcp',
    tagline: 'Direct GTA V cinematics in a FiveM game — stage scenes, AI Director, cameras, renders straight into your edit',
    requirement:
      'The gs-cinematic-studio resource (1.1.0 or later) on your FiveM server with a gcs_mcp_token set in its server.cfg, and a director in the game who has run /studio_remote on — their game does the filming.',
    urlHint:
      'Your FiveM server: http://<address>:<port>/gs-cinematic-studio/mcp. Plain http works on this computer or your local network; over the internet use the server’s https address (e.g. its users.cfx.re link).',
    keyHint: 'The gcs_mcp_token value from the server’s server.cfg.',
    auth: 'key',
    keyHeader: 'Authorization',
    keyPrefix: 'Bearer ',
  },
  {
    id: 'blender-mcp',
    preset: 'blender-mcp',
    name: 'Blender MCP',
    transport: 'stdio',
    command: 'uvx',
    args: ['blender-mcp'],
    tagline: 'Community server for a live Blender session: scene info, Poly Haven, Sketchfab and Hyper3D assets',
    requirement: 'uv installed, and the BlenderMCP add-on running in Blender. Note: this third-party server may collect usage telemetry — check its README.',
    docs: 'https://github.com/ahujasid/blender-mcp',
    auth: 'local',
  },
]
