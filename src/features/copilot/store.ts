import { toast } from 'sonner'
import { create } from 'zustand'
import type { AgentErrorCode, AgentEvent, AgentUsage, ChatAttachment, CopilotTarget } from '@shared/ai'
import { usePlayback } from '@/editor/playback'
import { getProject, undoEntry, useEditor } from '@/editor/store'
import { useUI } from '@/editor/ui-store'
import { onAgentEvent, resolveTarget, targetLabel } from '@/integrations/ai'
import { setConversation } from '@/integrations/conversation'
import { skillsPrompt } from '@/integrations/skills'
import { api } from '@/integrations/store'
import { abortCalls } from '@/integrations/tool-runs'
import { onToolImages, onToolProgress } from '@/integrations/tools/events'
import { uid } from '@/lib/id'
import { formatTimecode } from '@/lib/time'
import { importDropped } from '@/project/media-import'
import { applyEvent, finish, fromLegacy, type Activity, type LocalEvent, type Part, type ToolPart } from './transcript'

export type { Activity, Part, ToolPart }

/** A file on a message, as the chat shows it. */
export interface FileChip {
  id: string
  name: string
  kind: ChatAttachment['kind']
  size: number
  /** A small picture of it (pictures only), kept with the chat. */
  thumb?: string
}

export interface Message {
  id: string
  role: 'user' | 'assistant'
  /** The user's words. A reply's are in `parts`. */
  text: string
  createdAt?: number
  /** Clips and media the request was about. */
  context?: { id: string; name: string }[]
  /** Files attached to the request. */
  files?: FileChip[]

  // ── replies ──
  /** Everything the AI did, in order. */
  parts?: Part[]
  phase?: 'working' | 'done'
  /** What it is doing right now (while working). */
  activity?: Activity
  /** When anything last arrived from it. */
  lastEventAt?: number
  /** Which brain answered. */
  agent?: string
  error?: { message: string; code?: AgentErrorCode }
  /** The user stopped it. */
  stopped?: boolean
  usage?: AgentUsage
  startedAt?: number
  finishedAt?: number
  suggestions?: string[]
  historyId?: number
  /** An agent makes several undo steps; "Undo all" reverts them together. */
  historyIds?: number[]
  undone?: boolean
}

/** One Copilot conversation; each project keeps its own. */
export interface Chat {
  id: string
  /** Set when renamed; otherwise the first request names it. */
  title?: string
  createdAt: number
  updatedAt: number
  messages: Message[]
}

/** A request waiting for the reply before it to finish. */
export interface Queued {
  id: string
  text: string
  context: { id: string; name: string }[]
  assets: AssetAttachment[]
  files: FileAttachment[]
}

interface CopilotState {
  /** The project these chats belong to. */
  projectId: string | null
  /** This project's chats, newest first. The open one's messages live in `messages` while it's open. */
  chats: Chat[]
  messages: Message[]
  busy: boolean
  draft: string
  /** Requests sent while the AI was busy: each goes out when the one before is done. */
  queue: Queued[]
  /** The queue waits (after an error) until the user sends the next one. */
  queueHeld: boolean
  /** The open chat — also keys the main process's history / agent session for it. */
  conversationId: string
  setDraft: (draft: string) => void
  /** Starts a fresh chat (the current one stays in the list). */
  clear: () => void
}

export const useCopilot = create<CopilotState>((set) => ({
  projectId: null,
  chats: [],
  messages: [],
  busy: false,
  draft: '',
  queue: [],
  queueHeld: false,
  conversationId: uid('conv'),
  setDraft: (draft) => set({ draft }),
  clear: () => newChat(),
}))

setConversation(useCopilot.getState().conversationId)
useCopilot.subscribe((s, prev) => {
  if (s.conversationId !== prev.conversationId) setConversation(s.conversationId)
})

// ─── Chats ───────────────────────────────────────────────────────────────

/** What a chat is called: its own title, or its first request. */
export function chatTitle(chat: Pick<Chat, 'title' | 'messages'>) {
  if (chat.title) return chat.title
  const first = chat.messages.find((m) => m.role === 'user')?.text.trim().replace(/\s+/g, ' ')
  if (!first) return 'New chat'
  return first.length > 52 ? `${first.slice(0, 50).trimEnd()}…` : first
}

/** Every chat of this project with the open one up to date, newest first, empty ones left out. */
export function allChats(): Chat[] {
  const { chats, messages, conversationId } = useCopilot.getState()
  return mergeChats(chats, messages, conversationId)
}

/** The chat list with the open chat's current messages in it (pure, for rendering). */
export function mergeChats(chats: Chat[], messages: Message[], conversationId: string): Chat[] {
  const open = chats.find((c) => c.id === conversationId)
  const list = chats.filter((c) => c.id !== conversationId)
  if (messages.length) {
    const updatedAt = open && open.messages === messages ? open.updatedAt : Date.now()
    list.push({ id: conversationId, title: open?.title, createdAt: open?.createdAt ?? Date.now(), updatedAt, messages })
  }
  return list.filter((c) => c.messages.length).sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Files waiting in the composer belong to the open chat: leaving it lets them go. */
function dropPendingFiles() {
  const { conversationId } = useCopilot.getState()
  for (const item of useAttachments.getState().items) if (item.kind === 'file' && item.file) void api?.ai.detach(conversationId, item.file.id)
  useAttachments.setState((s) => ({ items: s.items.filter((i) => i.kind !== 'file') }))
}

/** Opens a fresh chat; the one that was open stays in the list. */
export function newChat() {
  if (useCopilot.getState().busy) return
  dropPendingFiles()
  const chats = allChats()
  useCopilot.setState({ chats, messages: [], conversationId: uid('conv'), queue: [], queueHeld: false })
}

export function openChat(id: string) {
  const s = useCopilot.getState()
  if (s.busy || id === s.conversationId) return
  dropPendingFiles()
  const chats = allChats()
  const chat = chats.find((c) => c.id === id)
  if (!chat) return
  useCopilot.setState({ chats, messages: chat.messages, conversationId: id, queue: [], queueHeld: false })
}

export function deleteChat(id: string) {
  const s = useCopilot.getState()
  if (s.busy && id === s.conversationId) return
  void api?.ai.forget(id)
  const chats = allChats().filter((c) => c.id !== id)
  if (id === s.conversationId) {
    useAttachments.setState((a) => ({ items: a.items.filter((i) => i.kind !== 'file') }))
    useCopilot.setState({ chats, messages: [], conversationId: uid('conv'), queue: [], queueHeld: false })
  } else useCopilot.setState({ chats })
}

export function renameChat(id: string, title: string) {
  const name = title.trim().slice(0, 80)
  const chats = allChats().map((c) => (c.id === id ? { ...c, title: name || undefined } : c))
  useCopilot.setState({ chats })
}

/** A chat as it's kept on disk: no pictures the AI looked at (they're large) — just how many there were. */
function forDisk(chat: Chat): Chat {
  return {
    ...chat,
    messages: chat.messages.map((m) => ({
      ...m,
      activity: undefined,
      lastEventAt: undefined,
      parts: m.parts?.map((p) => (p.kind === 'tool' ? { ...p, images: undefined, progress: undefined, chars: undefined, pictures: (p.pictures ?? 0) + (p.images?.length ?? 0) || undefined } : p)),
    })),
  }
}

/** A chat read back from disk: whatever was running when it was saved has stopped. */
function fromDisk(raw: unknown): Chat | null {
  const c = raw as Partial<Chat> | null
  if (!c || typeof c.id !== 'string' || !Array.isArray(c.messages)) return null
  const messages = (c.messages as (Message & Parameters<typeof fromLegacy>[0])[])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string')
    .map((m): Message => {
      if (m.role === 'user') return { id: m.id, role: 'user', text: m.text, createdAt: m.createdAt, context: m.context, files: m.files }
      // Replies saved before transcripts had an intro, a list of calls and an outro.
      const parts = Array.isArray(m.parts) ? m.parts : fromLegacy(m)
      const done = finish({ parts, phase: 'working', error: m.error, stopped: m.stopped, usage: m.usage }, m.finishedAt ?? 0)
      return { id: m.id, role: 'assistant', text: '', createdAt: m.createdAt, agent: m.agent, startedAt: m.startedAt, suggestions: m.suggestions, undone: m.undone, ...done, finishedAt: m.finishedAt }
    })
  return { id: c.id, title: typeof c.title === 'string' ? c.title : undefined, createdAt: Number(c.createdAt) || Date.now(), updatedAt: Number(c.updatedAt) || Date.now(), messages }
}

let saveTimer: ReturnType<typeof setTimeout> | undefined
let pendingFor: string | null = null
/** Projects with chats on disk (the others get no file until they have a chat). */
const kept = new Set<string>()

function saveNow() {
  clearTimeout(saveTimer)
  const projectId = pendingFor
  pendingFor = null
  if (!projectId || !api) return
  const chats = allChats()
  if (!chats.length && !kept.has(projectId)) return
  if (chats.length) kept.add(projectId)
  void api.ai.saveChats(projectId, chats.map(forDisk)).catch(() => {})
}

useCopilot.subscribe((s, prev) => {
  if (!s.projectId || s.projectId !== prev.projectId) return
  if (s.messages === prev.messages && s.chats === prev.chats) return
  pendingFor = s.projectId
  clearTimeout(saveTimer)
  // While a reply streams, saving now and then is plenty.
  saveTimer = setTimeout(saveNow, s.busy ? 2500 : 700)
})

/** Opens a project's chats: the latest one, ready to carry on. */
async function loadChatsFor(projectId: string) {
  saveNow()
  if (useCopilot.getState().busy) stopCopilot({ keepQueue: false })
  useAttachments.setState({ items: [] })
  useCopilot.setState({ projectId, chats: [], messages: [], conversationId: uid('conv'), busy: false, queue: [], queueHeld: false })
  if (!api) return
  try {
    const chats = (await api.ai.loadChats(projectId)).map(fromDisk).filter((c): c is Chat => c !== null)
    if (useCopilot.getState().projectId !== projectId || useCopilot.getState().messages.length) return
    chats.sort((a, b) => b.updatedAt - a.updatedAt)
    if (chats.length) kept.add(projectId)
    const latest = chats[0]
    useCopilot.setState(latest ? { chats, messages: latest.messages, conversationId: latest.id } : { chats })
  } catch {
    // No saved chats.
  }
}

if (api) {
  useEditor.subscribe((s, prev) => {
    if (s.project.id !== prev.project.id) void loadChatsFor(s.project.id)
  })
  void loadChatsFor(useEditor.getState().project.id)
  window.addEventListener('beforeunload', saveNow)
}

function patch(id: string, fn: (m: Message) => Partial<Message>) {
  useCopilot.setState((s) => ({ messages: s.messages.map((m) => (m.id === id ? { ...m, ...fn(m) } : m)) }))
}

/** The turn in progress. Events for any other run are ignored, which is what makes Stop immediate. */
let live: { runId: string; messageId: string; startedAfter: number; startedAt: number; local: boolean } | null = null

function feed(e: LocalEvent) {
  const run = live
  if (!run) return
  patch(run.messageId, (m) => applyEvent(m, e, Date.now()))
}

// What a tool shows the AI, and how a long tool is getting on, land on that tool's step in the running
// reply, whichever brain asked (models, Claude Code and Codex all go through the same tools).
onToolImages((tool, images) => feed({ type: 'tool-images', tool, images: images.map((i) => `data:${i.mimeType};base64,${i.data}`) }))
onToolProgress((tool, message) => feed({ type: 'tool-progress', tool, message }))

/**
 * Stops the reply now. The chat doesn't wait to hear back: it marks the reply
 * stopped, stops the work its tools started, and tells the brain to quit.
 */
export function stopCopilot(opts: { keepQueue?: boolean } = {}) {
  const run = live
  if (!run) return
  abortCalls(run.runId, run.local ? run.startedAt : undefined)
  void api?.ai.stop(run.runId)
  if (opts.keepQueue === false) useCopilot.setState({ queue: [] })
  finishLive(run.messageId, { message: 'Stopped.', code: 'cancelled' })
}

// ─── Attachments ─────────────────────────────────────────────────────────

/** Media from the library the next message is about. */
export interface AssetAttachment {
  id: string
  name: string
  kind: 'asset'
}

/** A picture or document that goes to the AI with the next message. */
export interface FileAttachment {
  id: string
  name: string
  kind: 'file'
  status: 'reading' | 'ready'
  /** Set once the file is kept for this chat. */
  file?: ChatAttachment
  thumb?: string
}

export type Attachment = AssetAttachment | FileAttachment

export const useAttachments = create<{ items: Attachment[] }>(() => ({ items: [] }))

export function attach(item: AssetAttachment) {
  useAttachments.setState((s) => (s.items.some((i) => i.id === item.id) ? s : { items: [...s.items, item] }))
}

export function detach(id: string) {
  const item = useAttachments.getState().items.find((i) => i.id === id)
  if (item?.kind === 'file' && item.file) void api?.ai.detach(useCopilot.getState().conversationId, item.file.id)
  useAttachments.setState((s) => ({ items: s.items.filter((i) => i.id !== id) }))
}

const isMedia = (file: File) => /^(video|audio)\//.test(file.type) || /\.(mp4|mov|mkv|webm|avi|m4v|mp3|wav|m4a|aac|flac|ogg)$/i.test(file.name)

/** A small picture of an image file, to show on the message and keep with the chat. */
async function thumbnail(file: Blob): Promise<string | undefined> {
  try {
    const bitmap = await createImageBitmap(file)
    const k = Math.min(1, 160 / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * k))
    canvas.height = Math.max(1, Math.round(bitmap.height * k))
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()
    return canvas.toDataURL('image/jpeg', 0.72)
  } catch {
    return undefined
  }
}

/**
 * Attaches files to the next message: pasted, dropped or picked. Pictures, PDFs,
 * Word and text files go to the AI with the message; video and audio go into the
 * project's media, and the message points at them.
 */
export async function attachFiles(files: File[]) {
  if (!files.length) return
  useUI.getState().setRightTab('copilot')
  const media = files.filter(isMedia)
  if (media.length) {
    try {
      for (const a of await importDropped(media)) attach({ id: a.id, name: a.name, kind: 'asset' })
    } catch (err) {
      toast.error('Couldn’t add that to Media', { description: err instanceof Error ? err.message : String(err) })
    }
  }
  await Promise.all(
    files
      .filter((f) => !isMedia(f))
      .slice(0, 12)
      .map(async (file) => {
        const id = uid('file')
        const name = file.name || (file.type.startsWith('image/') ? `pasted-${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}.${file.type.slice(6).replace('jpeg', 'jpg')}` : 'pasted.txt')
        useAttachments.setState((s) => ({ items: [...s.items, { id, name, kind: 'file', status: 'reading' }] }))
        const conversationId = useCopilot.getState().conversationId
        try {
          if (!api) throw new Error('Attaching files needs Lumen’s desktop app.')
          const kept = await api.ai.attach(conversationId, { name, mime: file.type || undefined, data: new Uint8Array(await file.arrayBuffer()) })
          const thumb = kept.kind === 'image' ? await thumbnail(file) : undefined
          // Removed, or the chat changed, while it was being read: let it go.
          const still = useAttachments.getState().items.some((i) => i.id === id) && useCopilot.getState().conversationId === conversationId
          if (!still) return void api.ai.detach(conversationId, kept.id)
          useAttachments.setState((s) => ({ items: s.items.map((i) => (i.id === id ? { id, name: kept.name, kind: 'file', status: 'ready', file: kept, thumb } : i)) }))
        } catch (err) {
          useAttachments.setState((s) => ({ items: s.items.filter((i) => i.id !== id) }))
          toast.error(`Couldn’t attach ${name}`, { description: (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, ''), duration: 8000 })
        }
      }),
  )
}

/** A long paste becomes a text file on the message, so the box stays for the request itself. */
export const PASTE_AS_FILE = 6000

// ─── Sending ─────────────────────────────────────────────────────────────

/**
 * Sends a request — or, while the AI is busy, lines it up to go when the reply
 * in progress is done.
 */
export async function sendPrompt(text: string) {
  const prompt = text.trim()
  const items = useAttachments.getState().items
  if (!prompt && !items.length) return
  // A file still being read isn't ready to send.
  if (items.some((i) => i.kind === 'file' && i.status !== 'ready')) return void toast('Still reading the attached file — one moment.')
  useUI.getState().setRightTab('copilot')

  const project = getProject()
  const context = useUI
    .getState()
    .selection.slice(0, 4)
    .map((id) => project.clips[id])
    .filter(Boolean)
    .map((c) => ({ id: c.id, name: c.name }))
  const assets = items.filter((a): a is AssetAttachment => a.kind === 'asset' && Boolean(project.assets[a.id]))
  const files = items.filter((a): a is FileAttachment => a.kind === 'file' && Boolean(a.file))
  useAttachments.setState({ items: [] })
  const request: Queued = { id: uid('q'), text: prompt || (files.length ? 'Look at what I attached.' : ''), context, assets, files }

  if (useCopilot.getState().busy) {
    useCopilot.setState((s) => ({ draft: '', queue: [...s.queue, request] }))
    return
  }
  useCopilot.setState({ draft: '' })
  return start(request)
}

function start(request: Queued) {
  const target = resolveTarget()
  const aid = uid('msg')
  const now = Date.now()
  useCopilot.setState((s) => ({
    busy: true,
    queueHeld: false,
    messages: [
      ...s.messages,
      {
        id: uid('msg'),
        role: 'user',
        text: request.text,
        createdAt: now,
        context: [...request.context, ...request.assets.map((a) => ({ id: a.id, name: a.name }))],
        files: request.files.map((f) => ({ id: f.file!.id, name: f.name, kind: f.file!.kind, size: f.file!.size, thumb: f.thumb })),
      },
      { id: aid, role: 'assistant', text: '', parts: [], phase: 'working', createdAt: now, startedAt: now, lastEventAt: now, activity: { kind: 'starting', label: 'Starting…', since: now }, agent: target ? targetLabel(target).title : undefined },
    ],
  }))

  if (!target) {
    finishLive(aid, { message: 'Copilot needs an AI to think with. Use your own Claude Code or Codex, or add a model with an API key.', code: 'no-brain' })
    return
  }
  return runLive(aid, target, request)
}

// ─── The queue ───────────────────────────────────────────────────────────

export function removeQueued(id: string) {
  const item = useCopilot.getState().queue.find((q) => q.id === id)
  if (!item) return
  const { conversationId } = useCopilot.getState()
  for (const f of item.files) if (f.file) void api?.ai.detach(conversationId, f.file.id)
  useCopilot.setState((s) => ({ queue: s.queue.filter((q) => q.id !== id) }))
}

/** Puts a queued request back in the box to change it. */
export function editQueued(id: string) {
  const item = useCopilot.getState().queue.find((q) => q.id === id)
  if (!item) return
  useCopilot.setState((s) => ({ queue: s.queue.filter((q) => q.id !== id), draft: s.draft ? `${s.draft}\n${item.text}` : item.text }))
  useAttachments.setState((s) => ({ items: [...s.items, ...item.assets, ...item.files].filter((a, i, all) => all.findIndex((b) => b.id === a.id) === i) }))
}

/** Sends a queued request right away: the reply in progress is stopped and this one goes next. */
export function sendQueuedNow(id: string) {
  const s = useCopilot.getState()
  const item = s.queue.find((q) => q.id === id)
  if (!item) return
  useCopilot.setState({ queue: [item, ...s.queue.filter((q) => q.id !== id)], queueHeld: false })
  if (s.busy) stopCopilot()
  else sendNext()
}

function sendNext() {
  const s = useCopilot.getState()
  if (s.busy || !s.queue.length) return
  const [next, ...rest] = s.queue
  useCopilot.setState({ queue: rest })
  void start(next)
}

// ─── Live agents (models and local agents) ───────────────────────────────

/** What the agent should know about this moment that isn't in the project itself. */
function turnContext(context: { id: string; name: string }[], assets: AssetAttachment[]) {
  const fps = getProject().settings.fps
  const frame = usePlayback.getState().frame
  const lines = [`[Lumen] Playhead at frame ${frame} (${formatTimecode(frame, fps)}).`]
  if (context.length) lines.push(`Selected clips: ${context.map((c) => `${c.name} (${c.id})`).join(', ')}.`)
  if (assets.length) lines.push(`Media the user attached (asset ids): ${assets.map((a) => `${a.name} (${a.id})`).join(', ')}.`)
  return lines.join(' ')
}

async function runLive(messageId: string, target: CopilotTarget, request: Queued) {
  if (!api) {
    finishLive(messageId, { message: 'Live models need Lumen’s desktop app.', code: 'failed' })
    return
  }
  const runId = uid('run')
  live = { runId, messageId, startedAfter: Math.max(0, ...useEditor.getState().past.map((e) => e.id)), startedAt: Date.now(), local: target.kind === 'local' }
  try {
    await api.ai.run({
      runId,
      conversationId: useCopilot.getState().conversationId,
      target,
      prompt: request.text,
      context: turnContext(request.context, request.assets),
      instructions: skillsPrompt() || undefined,
      attachments: request.files.flatMap((f) => (f.file ? [f.file] : [])),
    })
  } catch (err) {
    if (live?.runId === runId) finishLive(messageId, { message: err instanceof Error ? err.message : String(err), code: 'failed' })
  }
}

function finishLive(messageId: string, error?: { message: string; code?: AgentErrorCode }, usage?: AgentUsage) {
  const run = live?.messageId === messageId ? live : null
  const past = useEditor.getState().past
  const ids = run ? past.filter((e) => e.id > run.startedAfter && e.source === 'ai').map((e) => e.id) : []
  patch(messageId, (m) => ({ ...finish(m, Date.now(), error, usage), historyIds: ids.length ? ids : undefined }))
  if (run) live = null
  // After an error the queue waits: what's next may depend on what just failed. Stopping is the user's
  // own move, usually to say something else, so what they lined up goes straight on.
  const held = Boolean(error) && error?.code !== 'cancelled' && useCopilot.getState().queue.length > 0
  useCopilot.setState({ busy: false, queueHeld: held })
  if (!held) sendNext()
}

onAgentEvent((e: AgentEvent) => {
  // Anything from a run that is no longer the live one (stopped, replaced) is dropped.
  if (!live || e.runId !== live.runId) return
  const id = live.messageId
  if (e.type === 'done') return finishLive(id, undefined, e.usage)
  if (e.type === 'error') return finishLive(id, { message: e.message, code: e.code })
  patch(id, (m) => applyEvent(m, e, Date.now()))
})

// ─── Undo ────────────────────────────────────────────────────────────────

export function undoMessage(messageId: string) {
  const msg = useCopilot.getState().messages.find((m) => m.id === messageId)
  if (!msg) return false
  if (msg.historyIds?.length) {
    if (!canUndoAll(msg.historyIds)) return false
    for (let i = 0; i < msg.historyIds.length; i++) useEditor.getState().undo()
    patch(messageId, () => ({ undone: true }))
    return true
  }
  if (!msg.historyId) return false
  const ok = undoEntry(msg.historyId)
  if (ok) patch(messageId, () => ({ undone: true }))
  return ok
}

/** Only while the agent's steps are still the latest ones (nothing happened after them). */
export function canUndoAll(ids: number[]) {
  const past = useEditor.getState().past
  const top = past.slice(-ids.length).map((e) => e.id)
  return top.length === ids.length && top.every((id, i) => id === ids[i])
}

/** Opens Copilot focused on one clip (clip context menu → “Ask Copilot”). */
export function askCopilotAbout(clipId: string) {
  const clip = getProject().clips[clipId]
  if (!clip) return
  useUI.getState().select([clipId])
  useUI.getState().setRightTab('copilot')
  const draft =
    clip.kind === 'audio' ? 'Remove the long pauses from this' : clip.kind === 'text' ? 'Make this title neon' : 'Make this clip look cinematic'
  useCopilot.getState().setDraft(draft)
}
