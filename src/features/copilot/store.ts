import { create } from 'zustand'
import type { AgentErrorCode, AgentEvent, CopilotTarget } from '@shared/ai'
import { usePlayback } from '@/editor/playback'
import { getProject, undoEntry, useEditor } from '@/editor/store'
import { useUI } from '@/editor/ui-store'
import { onAgentEvent, resolveTarget, targetLabel } from '@/integrations/ai'
import { api } from '@/integrations/store'
import { onToolImages } from '@/integrations/tools/events'
import { uid } from '@/lib/id'
import { formatTimecode } from '@/lib/time'

export type CallStatus = 'queued' | 'running' | 'done' | 'error'

export interface ToolCall {
  id: string
  tool: string
  title: string
  detail?: string
  status: CallStatus
  /** What the AI looked at — frames, contact sheets, screenshots (data URLs). */
  images?: string[]
}

export interface Message {
  id: string
  role: 'user' | 'assistant'
  /** user text, or the assistant's intro */
  text: string
  shown: number
  phase?: 'thinking' | 'intro' | 'tools' | 'outro' | 'done'
  calls?: ToolCall[]
  outro?: string
  outroShown?: number
  suggestions?: string[]
  historyId?: number
  /** Live agents make several undo steps; "Undo all" reverts them together. */
  historyIds?: number[]
  undone?: boolean
  context?: { id: string; name: string }[]
  /** Which brain answered (live agents). */
  agent?: string
  /** Live progress line, e.g. "Codex is working…" */
  status?: string
  error?: { message: string; code?: AgentErrorCode }
}

interface CopilotState {
  messages: Message[]
  busy: boolean
  draft: string
  /** Keys the main process's history / agent session for this conversation. */
  conversationId: string
  setDraft: (draft: string) => void
  clear: () => void
}

export const useCopilot = create<CopilotState>((set, get) => ({
  messages: [],
  busy: false,
  draft: '',
  conversationId: uid('conv'),
  setDraft: (draft) => set({ draft }),
  clear: () => {
    void api?.ai.forget(get().conversationId)
    set({ messages: [], conversationId: uid('conv') })
  },
}))

function patch(id: string, fn: (m: Message) => Partial<Message>) {
  useCopilot.setState((s) => ({ messages: s.messages.map((m) => (m.id === id ? { ...m, ...fn(m) } : m)) }))
}

let live: { runId: string; messageId: string; startedAfter: number } | null = null

// Pictures a tool showed the AI land on that tool's row in the running reply,
// whichever brain asked (models, Claude Code and Codex all go through the same tools).
onToolImages((tool, images) => {
  const run = live
  if (!run) return
  const urls = images.map((i) => `data:${i.mimeType};base64,${i.data}`)
  patch(run.messageId, (m) => {
    const calls = m.calls ?? []
    const running = calls.findLastIndex((c) => c.tool === tool && c.status === 'running')
    const index = running >= 0 ? running : calls.findLastIndex((c) => c.tool === tool)
    if (index < 0) return {}
    return { calls: calls.map((c, i) => (i === index ? { ...c, images: [...(c.images ?? []), ...urls] } : c)) }
  })
})

export function stopCopilot() {
  if (live) void api?.ai.stop(live.runId)
}

/** Extra context the user attached to the next message (media from the library). */
export interface Attachment {
  id: string
  name: string
  kind: 'asset'
}

export const useAttachments = create<{ items: Attachment[] }>(() => ({ items: [] }))

export function attach(item: Attachment) {
  useAttachments.setState((s) => (s.items.some((i) => i.id === item.id) ? s : { items: [...s.items, item] }))
}

export function detach(id: string) {
  useAttachments.setState((s) => ({ items: s.items.filter((i) => i.id !== id) }))
}

export async function sendPrompt(text: string) {
  const prompt = text.trim()
  if (!prompt || useCopilot.getState().busy) return
  useUI.getState().setRightTab('copilot')

  const project = getProject()
  const context = useUI
    .getState()
    .selection.slice(0, 4)
    .map((id) => project.clips[id])
    .filter(Boolean)
    .map((c) => ({ id: c.id, name: c.name }))
  const attachments = useAttachments.getState().items.filter((a) => project.assets[a.id])
  useAttachments.setState({ items: [] })

  const target = resolveTarget()
  const aid = uid('msg')
  useCopilot.setState((s) => ({
    busy: true,
    draft: '',
    messages: [
      ...s.messages,
      { id: uid('msg'), role: 'user', text: prompt, shown: prompt.length, context: [...context, ...attachments.map((a) => ({ id: a.id, name: a.name }))] },
      { id: aid, role: 'assistant', text: '', shown: 0, phase: 'thinking', agent: target ? targetLabel(target).title : undefined },
    ],
  }))

  if (!target) {
    finishLive(aid, { message: 'Copilot needs an AI to think with. Use your own Claude Code or Codex, or add a model with an API key.', code: 'no-brain' })
    return
  }
  return runLive(aid, target, prompt, context, attachments)
}

// ─── Live agents (models and local agents) ───────────────────────────────

/** What the agent should know about this moment that isn't in the project itself. */
function turnContext(context: { id: string; name: string }[], attachments: Attachment[]) {
  const fps = getProject().settings.fps
  const frame = usePlayback.getState().frame
  const lines = [`[Lumen] Playhead at frame ${frame} (${formatTimecode(frame, fps)}).`]
  if (context.length) lines.push(`Selected clips: ${context.map((c) => `${c.name} (${c.id})`).join(', ')}.`)
  if (attachments.length) lines.push(`Media the user attached (asset ids): ${attachments.map((a) => `${a.name} (${a.id})`).join(', ')}.`)
  return lines.join(' ')
}

async function runLive(messageId: string, target: CopilotTarget, prompt: string, context: { id: string; name: string }[], attachments: Attachment[]) {
  if (!api) {
    finishLive(messageId, { message: 'Live models need Lumen’s desktop app.', code: 'failed' })
    return
  }
  const runId = uid('run')
  live = { runId, messageId, startedAfter: Math.max(0, ...useEditor.getState().past.map((e) => e.id)) }
  try {
    await api.ai.run({ runId, conversationId: useCopilot.getState().conversationId, target, prompt, context: turnContext(context, attachments) })
  } catch (err) {
    finishLive(messageId, { message: err instanceof Error ? err.message : String(err), code: 'failed' })
  }
}

const TOOL_TITLES: Record<string, string> = {
  get_project: 'Read the project',
  place_asset: 'Place media on the timeline',
  seek: 'Move the playhead',
  render_3d_title: 'Render a 3D title in Blender',
  render_3d_background: 'Render a 3D background in Blender',
  render_blender_script: 'Render a Blender scene',
  blender_live: 'Run code in Blender',
  render_motion_graphic: 'Render a motion graphic',
  render_hyperframes_html: 'Render a HyperFrames composition',
  get_job: 'Check on a render',
  import_media_url: 'Import media',
  import_media_file: 'Import media',
  transcribe_media: 'Transcribe speech',
  find_pauses: 'Find pauses',
  remove_pauses: 'Remove pauses',
  add_captions: 'Add captions',
  duck_music: 'Duck the music',
  reframe: 'Reframe the canvas',
  generate_image: 'Generate an image',
  generate_video: 'Generate a video',
  add_sound_effect: 'Add a sound effect',
  list_voices: 'Look up voices',
  generate_voiceover: 'Generate a voiceover',
  generate_sound_effect: 'Generate a sound effect',
  generate_music: 'Generate music',
  get_frame: 'Look at the video',
  get_contact_sheet: 'Watch the edit',
  get_media_frames: 'Look at the footage',
  get_editor_screenshot: 'Look at the editor',
  get_clips_at: 'Check what’s on screen',
  get_clip: 'Read clip details',
  find_media: 'Search the media',
  get_transcript: 'Read the transcript',
  analyze_audio: 'Listen to the sound',
  get_history: 'Check the history',
  list_catalog: 'Look up effects and presets',
  batch_edit: 'Make the edits',
  add_title: 'Add a title',
  undo: 'Undo',
  redo: 'Redo',
  select_clips: 'Select clips',
  playback: 'Play the preview',
  save_project: 'Save the project',
  export_video: 'Export the video',
  shell: 'Run a command',
}

function toolTitle(tool: string) {
  if (TOOL_TITLES[tool]) return TOOL_TITLES[tool]
  const words = tool.replace(/^mcp__\w+__/, '').replace(/[_.]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function inputDetail(input: unknown) {
  if (!input || typeof input !== 'object') return undefined
  const entries = Object.entries(input as Record<string, unknown>).filter(([, v]) => v !== undefined && v !== null && typeof v !== 'object')
  const text = entries
    .slice(0, 3)
    .map(([k, v]) => `${k}: ${String(v).slice(0, 40)}`)
    .join(' · ')
  return text || undefined
}

function finishLive(messageId: string, error?: { message: string; code?: AgentErrorCode }) {
  const run = live?.messageId === messageId ? live : null
  const past = useEditor.getState().past
  const ids = run ? past.filter((e) => e.id > run.startedAfter && e.source === 'ai').map((e) => e.id) : []
  patch(messageId, (m) => ({
    phase: 'done',
    status: undefined,
    error: error?.code === 'cancelled' ? undefined : error,
    outro: error?.code === 'cancelled' ? [m.outro, 'Stopped.'].filter(Boolean).join('\n\n') : m.outro,
    outroShown: undefined,
    historyIds: ids.length ? ids : undefined,
    calls: m.calls?.map((c) => (c.status === 'running' ? { ...c, status: error ? 'error' : 'done' } : c)),
  }))
  if (run) live = null
  useCopilot.setState({ busy: false })
}

onAgentEvent((e: AgentEvent) => {
  if (!live || e.runId !== live.runId) return
  const id = live.messageId
  switch (e.type) {
    case 'status':
      patch(id, () => ({ status: e.message }))
      break
    case 'text':
      // Before any tool call, text is the intro; after, it's the wrap-up.
      patch(id, (m) =>
        m.calls?.length
          ? { outro: (m.outro ?? '') + e.delta.replace(/^\n+/, m.outro ? '\n\n' : ''), phase: 'outro' }
          : { text: m.text + e.delta, shown: m.text.length + e.delta.length, phase: 'intro' },
      )
      break
    case 'tool-start':
      patch(id, (m) => ({
        phase: 'tools',
        status: undefined,
        calls: [...(m.calls ?? []), { id: e.callId, tool: e.tool, title: toolTitle(e.tool), detail: inputDetail(e.input), status: 'running' }],
      }))
      break
    case 'tool-end':
      patch(id, (m) => ({ calls: m.calls?.map((c) => (c.id === e.callId ? { ...c, status: e.ok ? 'done' : 'error', detail: e.ok ? c.detail : (e.summary ?? c.detail) } : c)) }))
      break
    case 'done':
      finishLive(id)
      break
    case 'error':
      finishLive(id, { message: e.message, code: e.code })
      break
  }
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
