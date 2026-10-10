import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IPC, type BlenderRenderRequest, type ImageGenRequest, type McpServerConfig, type MotionRenderRequest, type Provenance, type VideoGenRequest, type WebVideoOptions } from '../../shared/integrations'
import { detectBlender, renderBlender, runLive, setBlenderPath } from './blender'
import { renderMotion } from './hyperframes'
import { cancelJob, listJobs } from './jobs'
import { callToolForAgent, connectServer, disconnectServer, listServers, removeServer, saveServer, signOut, startToolCall } from './mcp'
import { elevenLabsState, listVoices, music, setElevenLabsKey, soundEffect, speak, transcribe } from './elevenlabs'
import { importUrl, reveal } from './media'
import { bridgeState, regenerateToken, startBridge, stopBridge } from './server'
import { forgetConversation, startAgentRun, stopAgentRun } from './ai/agent'
import { attachmentContent, readAttachment, removeAttachment, saveAttachment } from './ai/attachments'
import { loadChats, saveChats } from './ai/chats'
import { linkPreview, readPage, screenshotPage, webSearch } from './web'
import { watchVideo } from './video-link'
import { deleteSkill, importSkill, listSkills, openSkillsFolder, readSkill, readSkillFile, saveSkill } from './skills'
import { localAgentStates, signInLocal } from './ai/local-agents'
import { signInOpenRouter } from './ai/openrouter'
import { listModels, providerStates, setProvider } from './ai/providers'
import { transcribeWithOpenAI } from './ai/transcribe'
import { generateImage, generateVideo, mediaModels } from './ai/media-gen'
import { cleanTarget, PROVIDERS, type AgentRunRequest, type AttachmentInput, type ChatAttachment, type LocalAgentId, type ProviderId } from '../../shared/ai'

/**
 * The integration IPC surface. Only the editor's own page may call it —
 * never an offscreen composition or anything else that ends up in a frame.
 */
export function registerIntegrationIpc(isTrustedUrl: (url: string) => boolean) {
  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => R) => {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      const url = event.senderFrame?.url ?? ''
      if (!isTrustedUrl(url)) throw new Error('Blocked: untrusted sender')
      return fn(...(args as A))
    })
  }

  handle(IPC.blenderDetect, () => detectBlender(true))
  handle(IPC.blenderSetPath, (file: string | null) => setBlenderPath(typeof file === 'string' && file.trim() ? file.trim() : null))
  handle(IPC.blenderRender, (req: BlenderRenderRequest) => renderBlender(sanitizeBlender(req)))
  handle(IPC.blenderLive, (code: string) => runLive(String(code)))
  handle(IPC.motionRender, (req: MotionRenderRequest) => renderMotion(sanitizeMotion(req)))

  handle(IPC.mcpList, () => listServers())
  handle(IPC.mcpSave, (config: McpServerConfig) => saveServer(config))
  handle(IPC.mcpRemove, (id: string) => removeServer(String(id)))
  handle(IPC.mcpConnect, (id: string) => connectServer(String(id)))
  handle(IPC.mcpDisconnect, (id: string) => disconnectServer(String(id)))
  handle(IPC.mcpSignOut, (id: string) => signOut(String(id)))
  handle(IPC.mcpCall, async (id: string, tool: string, args: Record<string, unknown>) => (await startToolCall(String(id), String(tool), args && typeof args === 'object' ? args : {})).job)
  handle(IPC.mcpCallForAgent, (id: string, tool: string, args: Record<string, unknown>) => callToolForAgent(String(id), String(tool), args && typeof args === 'object' ? args : {}))

  handle(IPC.mediaImportUrl, (url: string, name?: string, provenance?: Provenance) => importUrl(String(url), name, provenance ?? { integration: 'web', tool: 'download' }))
  handle(IPC.mediaReveal, (url: string) => reveal(String(url)))
  handle(IPC.jobsList, () => listJobs())
  handle(IPC.jobsCancel, (id: string) => cancelJob(String(id)))

  const provider = (id: unknown) => {
    if (!PROVIDERS.some((p) => p.id === id)) throw new Error('Unknown provider')
    return id as ProviderId
  }
  const localAgent = (id: unknown) => {
    if (id !== 'claude-code' && id !== 'codex') throw new Error('Unknown agent')
    return id as LocalAgentId
  }
  handle(IPC.aiProviders, () => providerStates())
  handle(IPC.aiSetProvider, (id: string, patch: { key?: string | null; baseURL?: string | null }) =>
    setProvider(provider(id), { key: typeof patch?.key === 'string' || patch?.key === null ? patch.key : undefined, baseURL: typeof patch?.baseURL === 'string' || patch?.baseURL === null ? patch.baseURL : undefined }),
  )
  handle(IPC.aiModels, (id: string, refresh?: boolean) => listModels(provider(id), Boolean(refresh)))
  handle(IPC.aiSignInOpenRouter, () => signInOpenRouter())
  handle(IPC.aiLocalAgents, (refresh?: boolean) => localAgentStates(Boolean(refresh)))
  handle(IPC.aiSignInLocal, (id: string) => signInLocal(localAgent(id)))
  handle(IPC.aiRun, (req: AgentRunRequest) => {
    if (!req || typeof req.runId !== 'string' || typeof req.conversationId !== 'string' || typeof req.prompt !== 'string') throw new Error('Bad request')
    const target = cleanTarget(req.target)
    if (!target) throw new Error('Unknown model or agent')
    return startAgentRun({
      ...req,
      target,
      prompt: req.prompt.slice(0, 20_000),
      context: typeof req.context === 'string' ? req.context.slice(0, 4000) : undefined,
      instructions: typeof req.instructions === 'string' ? req.instructions.slice(0, 12_000) : undefined,
      // Only what was really saved for this chat: the bytes are looked up by id.
      attachments: (Array.isArray(req.attachments) ? req.attachments : [])
        .slice(0, 12)
        .flatMap((a) => (a && typeof a.id === 'string' ? [readAttachment(req.conversationId, a.id)?.meta] : []))
        .filter((a): a is ChatAttachment => Boolean(a)),
    })
  })
  handle(IPC.aiAttach, (conversationId: string, file: AttachmentInput) => {
    if (!file || typeof file.name !== 'string' || !(file.data instanceof Uint8Array)) throw new Error('Bad file')
    return saveAttachment(String(conversationId), { name: file.name, mime: typeof file.mime === 'string' ? file.mime : undefined, data: file.data })
  })
  handle(IPC.aiDetach, (conversationId: string, id: string) => removeAttachment(String(conversationId), String(id)))
  handle(IPC.aiAttachment, (conversationId: string, id: string) => attachmentContent(String(conversationId), String(id)))
  handle(IPC.aiStop, (runId: string) => stopAgentRun(String(runId)))
  handle(IPC.aiForget, (conversationId: string) => forgetConversation(String(conversationId)))
  handle(IPC.aiChatsLoad, (projectId: string) => loadChats(String(projectId)))
  handle(IPC.aiChatsSave, (projectId: string, chats: unknown) => saveChats(String(projectId), chats))
  handle(IPC.webSearch, (query: string, max?: number) => webSearch(String(query), Number(max) || 8))
  handle(IPC.webRead, (url: string, maxChars?: number) => readPage(String(url), Number(maxChars) || 12000))
  handle(IPC.webScreenshot, (url: string, opts?: { width?: number; height?: number; fullPage?: boolean }) => {
    const o = opts && typeof opts === 'object' ? opts : {}
    return screenshotPage(String(url), { width: Number(o.width) || undefined, height: Number(o.height) || undefined, fullPage: o.fullPage === true })
  })
  handle(IPC.webPreview, (url: string) => linkPreview(String(url)))
  handle(IPC.webVideo, (url: string, opts?: WebVideoOptions) => watchVideo(String(url), opts && typeof opts === 'object' ? opts : {}))

  const skillSource = (s: unknown) => {
    if (s !== 'user' && s !== 'claude') throw new Error('Unknown skill source')
    return s
  }
  handle(IPC.skillsList, () => listSkills())
  handle(IPC.skillsRead, (source: string, folder: string) => readSkill(skillSource(source), String(folder)))
  handle(IPC.skillsReadFile, (source: string, folder: string, file: string) => readSkillFile(skillSource(source), String(folder), String(file)))
  handle(IPC.skillsSave, (input: { folder?: unknown; name?: unknown; description?: unknown; body?: unknown }) =>
    saveSkill({
      folder: typeof input?.folder === 'string' && input.folder ? input.folder : undefined,
      name: String(input?.name ?? ''),
      description: String(input?.description ?? ''),
      body: String(input?.body ?? ''),
    }),
  )
  handle(IPC.skillsDelete, (folder: string) => deleteSkill(String(folder)))
  handle(IPC.skillsImport, () => importSkill(BrowserWindow.getFocusedWindow()))
  handle(IPC.skillsOpenFolder, () => openSkillsFolder())
  const genProvider = (p: unknown) => {
    if (p !== 'openai' && p !== 'gemini') throw new Error('Unknown provider')
    return p
  }
  handle(IPC.aiMediaModels, (p: string, refresh?: boolean) => mediaModels(genProvider(p), Boolean(refresh)))
  handle(IPC.aiGenerateImage, (req: ImageGenRequest) => {
    const aspect = ['16:9', '9:16', '1:1'].includes(req?.aspect) ? req.aspect : '16:9'
    return generateImage({ provider: genProvider(req?.provider), model: String(req?.model ?? ''), prompt: String(req?.prompt ?? '').slice(0, 4000), aspect, quality: req?.quality })
  })
  handle(IPC.aiGenerateVideo, (req: VideoGenRequest) => {
    const aspect = req?.aspect === '9:16' ? '9:16' : '16:9'
    const seconds = Math.max(1, Math.min(60, Math.round(Number(req?.seconds) || 8)))
    return generateVideo({ provider: genProvider(req?.provider), model: String(req?.model ?? ''), prompt: String(req?.prompt ?? '').slice(0, 4000), aspect, seconds, resolution: req?.resolution })
  })
  handle(IPC.aiTranscribe, (wav: Uint8Array, language?: string) => {
    if (!(wav instanceof Uint8Array)) throw new Error('Expected WAV bytes')
    return transcribeWithOpenAI(wav, typeof language === 'string' && language ? language : undefined)
  })

  const text = (v: unknown, max: number) => {
    if (typeof v !== 'string' || !v.trim()) throw new Error('Text is required.')
    return v.slice(0, max)
  }
  handle(IPC.elevenState, () => elevenLabsState())
  handle(IPC.elevenSetKey, (key: string | null) => setElevenLabsKey(typeof key === 'string' && key.trim() ? key : null))
  handle(IPC.elevenVoices, (search?: string) => listVoices(typeof search === 'string' ? search.slice(0, 80) : undefined))
  handle(IPC.elevenSpeak, (req: { text: string; voiceId: string; voiceName?: string; modelId?: string }) =>
    speak({ text: text(req?.text, 10_000), voiceId: text(req?.voiceId, 64), voiceName: typeof req.voiceName === 'string' ? req.voiceName.slice(0, 60) : undefined, modelId: typeof req.modelId === 'string' ? req.modelId.slice(0, 64) : undefined }),
  )
  handle(IPC.elevenSfx, (req: { prompt: string; durationSeconds?: number; loop?: boolean }) =>
    soundEffect({ prompt: text(req?.prompt, 1000), durationSeconds: Number(req.durationSeconds) || undefined, loop: Boolean(req.loop) }),
  )
  handle(IPC.elevenMusic, (req: { prompt: string; lengthSeconds: number; instrumental?: boolean }) =>
    music({ prompt: text(req?.prompt, 2000), lengthSeconds: Number(req.lengthSeconds) || 30, instrumental: Boolean(req.instrumental) }),
  )
  handle(IPC.elevenTranscribe, (wav: ArrayBuffer, name: string, languageCode?: string) => {
    if (!(wav instanceof ArrayBuffer) || wav.byteLength > 1024 * 1024 * 1024) throw new Error('Bad audio')
    return transcribe({ wav, name: String(name ?? 'Audio').slice(0, 80), languageCode: typeof languageCode === 'string' ? languageCode.slice(0, 8) : undefined })
  })

  handle(IPC.bridgeState, () => bridgeState())
  handle(IPC.bridgeSetEnabled, (on: boolean) => (on ? startBridge() : stopBridge()))
  handle(IPC.bridgeRegenerate, () => regenerateToken())
}

const clampInt = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

const clampNum = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

/** Keeps renders to sane sizes whatever asked for them (UI, Copilot or an external agent). */
function frameSpec<T extends { width: number; height: number; fps: number }>(req: T) {
  // Even dimensions, 16 px – 4K.
  const even = (v: unknown, fallback: number) => clampInt(v, 16, 3840, fallback) & ~1
  return { ...req, width: even(req.width, 1920), height: even(req.height, 1080), fps: clampNum(req.fps, 1, 120, 30) }
}

function sanitizeBlender(req: BlenderRenderRequest): BlenderRenderRequest {
  if (!['title3d', 'shapes', 'script'].includes(req?.template)) throw new Error('Unknown Blender template')
  return {
    ...frameSpec(req),
    params: req.params && typeof req.params === 'object' ? req.params : {},
    duration: clampNum(req.duration, 0.1, 60, 4),
    quality: ['draft', 'standard', 'high'].includes(req.quality ?? '') ? req.quality : 'standard',
    script: typeof req.script === 'string' ? req.script : undefined,
  }
}

function sanitizeMotion(req: MotionRenderRequest): MotionRenderRequest {
  if (!['lower-third', 'kinetic', 'counter', 'title-card', 'quote', 'chapter', 'custom'].includes(req?.template)) throw new Error('Unknown motion template')
  return {
    ...frameSpec(req),
    params: req.params && typeof req.params === 'object' ? req.params : {},
    duration: req.duration === undefined ? undefined : clampNum(req.duration, 0.1, 120, 5),
    html: typeof req.html === 'string' ? req.html : undefined,
  }
}
