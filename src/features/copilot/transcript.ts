/**
 * A Copilot reply as a transcript: everything the AI did, in the order it did
 * it — thinking, words, each tool call with what went in and what came back —
 * plus what it is doing right now. The chat renders this as is, so nothing a
 * turn does is ever hidden, and there is always a line saying what is going on.
 *
 * Pure: events in, message out (the store feeds it; tests drive it directly).
 */
import type { AgentErrorCode, AgentEventBody, AgentUsage } from '@shared/ai'

export type StepStatus = 'writing' | 'running' | 'done' | 'error' | 'stopped'

export interface ThinkingPart {
  kind: 'thinking'
  id: string
  text: string
  startedAt: number
  /** How long this stretch lasted; unset while it is still going. */
  ms?: number
}

export interface TextPart {
  kind: 'text'
  id: string
  text: string
}

export interface ToolPart {
  kind: 'tool'
  /** The call's id. */
  id: string
  tool: string
  title: string
  /** A few of its arguments, in a line. */
  detail?: string
  /** Its arguments in full, as the step shows them when opened. */
  input?: string
  /** What came back (cut to a readable length). */
  output?: string
  status: StepStatus
  /** When the model started writing the call, then when it started running. */
  startedAt: number
  endedAt?: number
  /** While the model writes the call: how many characters of input so far. */
  chars?: number
  /** While it runs: how the work is getting on. */
  progress?: string
  /** What the AI looked at — frames, contact sheets, screenshots (data URLs). */
  images?: string[]
  /** Pictures that were shown but aren't kept (a chat reopened after a restart). */
  pictures?: number
}

/** A line worth keeping: a retry, a fallback, a limit reached. */
export interface NotePart {
  kind: 'note'
  id: string
  text: string
}

export type Part = ThinkingPart | TextPart | ToolPart | NotePart

/** What the AI is doing at this moment. */
export interface Activity {
  kind: 'starting' | 'waiting' | 'thinking' | 'writing' | 'tool' | 'answering'
  label: string
  since: number
}

/** The part of a reply the transcript works on. */
export interface Reply {
  parts?: Part[]
  phase?: 'working' | 'done'
  activity?: Activity
  /** When anything last arrived (a long gap is said out loud). */
  lastEventAt?: number
  error?: { message: string; code?: AgentErrorCode }
  stopped?: boolean
  usage?: AgentUsage
  finishedAt?: number
}

/** Something a running tool said about itself (from the editor, not the model). */
export type LocalEvent = { type: 'tool-progress'; tool: string; message: string } | { type: 'tool-images'; tool: string; images: string[] }

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
  web_search: 'Search the web',
  read_web_page: 'Read a web page',
  screenshot_web_page: 'Look at a web page',
  watch_web_video: 'Watch a video link',
  read_attachment: 'Open an attached file',
  list_skills: 'Check its skills',
  detect_beats: 'Find the beat',
  cut_to_beats: 'Cut to the beat',
  cut_out_subject: 'Cut out the subject',
  clip_animate: 'Animate',
  use_skill: 'Use a skill',
  read_skill_file: 'Read a skill’s notes',
  detect_scenes: 'Find the scene changes',
  stabilize_clip: 'Stabilize the clip',
  track_motion: 'Track motion',
  graphics_report: 'Check the graphics card',
  ingest_start: 'Start frame ingest',
  ingest_status: 'Check frame ingest',
}

export function toolTitle(tool: string) {
  if (TOOL_TITLES[tool]) return TOOL_TITLES[tool]
  const words = tool.replace(/^mcp__\w+?__/, '').replace(/[_.]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** A few simple arguments in a line: "clip_id: clip_1 · seconds: 4". */
export function inputDetail(input: unknown) {
  if (!input || typeof input !== 'object') return undefined
  const entries = Object.entries(input as Record<string, unknown>).filter(([, v]) => v !== undefined && v !== null && typeof v !== 'object')
  const text = entries
    .slice(0, 3)
    .map(([k, v]) => `${k}: ${String(v).slice(0, 40)}`)
    .join(' · ')
  return text || undefined
}

const INPUT_LIMIT = 6000

/** A call's arguments as readable JSON, cut when huge (a whole HTML composition). */
export function inputText(input: unknown) {
  if (input === undefined || input === null) return undefined
  let text: string
  try {
    text = typeof input === 'string' ? input : JSON.stringify(input, null, 2)
  } catch {
    return undefined
  }
  if (!text || text === '{}') return undefined
  return text.length > INPUT_LIMIT ? `${text.slice(0, INPUT_LIMIT)}\n… (${text.length - INPUT_LIMIT} more characters)` : text
}

let seq = 0
const pid = (kind: string) => `${kind}_${Date.now().toString(36)}_${(seq++).toString(36)}`

/** Ends the stretch of thinking that is open, if any. */
function closeThinking(parts: Part[], now: number): Part[] {
  const last = parts[parts.length - 1]
  if (last?.kind !== 'thinking' || last.ms !== undefined) return parts
  return [...parts.slice(0, -1), { ...last, ms: Math.max(0, now - last.startedAt) }]
}

const replace = (parts: Part[], id: string, fn: (p: ToolPart) => ToolPart) => parts.map((p) => (p.kind === 'tool' && p.id === id ? fn(p) : p))

/** The latest step of a tool that is (or just was) running: where its pictures and progress land. */
function latestTool(parts: Part[], tool: string): ToolPart | undefined {
  const tools = parts.filter((p): p is ToolPart => p.kind === 'tool' && p.tool === tool)
  return tools.findLast((p) => p.status === 'running') ?? tools[tools.length - 1]
}

/** What to say is happening once a tool has finished: the next one still running, or waiting on the model. */
function afterTool(parts: Part[], now: number): Activity {
  const running = parts.findLast((p): p is ToolPart => p.kind === 'tool' && p.status === 'running')
  return running ? { kind: 'tool', label: running.title, since: running.startedAt } : { kind: 'waiting', label: 'Reading the result…', since: now }
}

/** A reply after one more event. */
export function applyEvent<T extends Reply>(reply: T, e: AgentEventBody | LocalEvent, now: number): T {
  const parts = reply.parts ?? []
  const seen = { ...reply, lastEventAt: now }
  switch (e.type) {
    case 'status':
      return { ...seen, activity: reply.activity?.label === e.message ? reply.activity : { kind: reply.activity?.kind ?? 'starting', label: e.message, since: now } }
    case 'note':
      return { ...seen, parts: [...closeThinking(parts, now), { kind: 'note', id: pid('note'), text: e.message }] }
    case 'step': {
      // A request the model was still writing when its connection dropped never ran: it goes with the step it was in.
      const kept = closeThinking(parts, now).filter((p) => !(p.kind === 'tool' && p.status === 'writing'))
      return { ...seen, parts: kept, activity: { kind: 'waiting', label: e.index <= 1 ? 'Asking the model…' : 'Waiting for the model…', since: now } }
    }
    case 'reasoning': {
      const last = parts[parts.length - 1]
      if (last?.kind === 'thinking' && last.ms === undefined) {
        return { ...seen, parts: [...parts.slice(0, -1), { ...last, text: last.text + e.delta }], activity: { kind: 'thinking', label: 'Thinking…', since: last.startedAt } }
      }
      // Whitespace alone doesn't open a stretch of thinking.
      if (!e.delta.trim()) return seen
      return { ...seen, parts: [...parts, { kind: 'thinking', id: pid('think'), text: e.delta.replace(/^\s+/, ''), startedAt: now }], activity: { kind: 'thinking', label: 'Thinking…', since: now } }
    }
    case 'reasoning-end':
      return { ...seen, parts: closeThinking(parts, now), activity: reply.activity?.kind === 'thinking' ? { kind: 'waiting', label: 'Working…', since: now } : reply.activity }
    case 'text': {
      const closed = closeThinking(parts, now)
      const last = closed[closed.length - 1]
      const activity: Activity = reply.activity?.kind === 'answering' ? reply.activity : { kind: 'answering', label: 'Writing…', since: now }
      if (last?.kind === 'text') return { ...seen, parts: [...closed.slice(0, -1), { ...last, text: last.text + e.delta }], activity }
      const text = e.delta.replace(/^\s+/, '')
      return text ? { ...seen, parts: [...closed, { kind: 'text', id: pid('text'), text }], activity } : { ...seen, parts: closed }
    }
    case 'tool-input': {
      const closed = closeThinking(parts, now)
      const known = closed.find((p) => p.kind === 'tool' && p.id === e.callId) as ToolPart | undefined
      const title = toolTitle(e.tool)
      const next = known
        ? replace(closed, e.callId, (p) => ({ ...p, chars: e.chars }))
        : [...closed, { kind: 'tool' as const, id: e.callId, tool: e.tool, title, status: 'writing' as const, startedAt: now, chars: e.chars }]
      return { ...seen, parts: next, activity: { kind: 'writing', label: `Preparing: ${title}`, since: known?.startedAt ?? now } }
    }
    case 'tool-start': {
      const closed = closeThinking(parts, now)
      const title = toolTitle(e.tool)
      const running = { status: 'running' as const, startedAt: now, detail: inputDetail(e.input), input: inputText(e.input), chars: undefined }
      const next = closed.some((p) => p.kind === 'tool' && p.id === e.callId)
        ? replace(closed, e.callId, (p) => ({ ...p, ...running }))
        : [...closed, { kind: 'tool' as const, id: e.callId, tool: e.tool, title, ...running }]
      return { ...seen, parts: next, activity: { kind: 'tool', label: title, since: now } }
    }
    case 'tool-progress': {
      const target = latestTool(parts, e.tool)
      if (!target || target.status !== 'running') return reply
      return { ...seen, parts: replace(parts, target.id, (p) => ({ ...p, progress: e.message })) }
    }
    case 'tool-images': {
      const target = latestTool(parts, e.tool)
      if (!target) return reply
      return { ...seen, parts: replace(parts, target.id, (p) => ({ ...p, images: [...(p.images ?? []), ...e.images] })) }
    }
    case 'tool-end': {
      if (!parts.some((p) => p.kind === 'tool' && p.id === e.callId)) return seen
      const next = replace(parts, e.callId, (p) => ({
        ...p,
        status: e.ok ? 'done' : 'error',
        endedAt: now,
        progress: undefined,
        output: e.output ?? e.summary ?? p.output,
        detail: e.ok ? p.detail : (e.summary ?? p.detail),
      }))
      return { ...seen, parts: next, activity: afterTool(next, now) }
    }
    case 'done':
      return finish(seen, now, undefined, e.usage)
    case 'error':
      return finish(seen, now, { message: e.message, code: e.code })
  }
}

/** Ends a reply: nothing is left looking as if it were still running. */
export function finish<T extends Reply>(reply: T, now: number, error?: { message: string; code?: AgentErrorCode }, usage?: AgentUsage): T {
  const cancelled = error?.code === 'cancelled'
  const ended: StepStatus = cancelled ? 'stopped' : error ? 'error' : 'done'
  const closed = closeThinking(reply.parts ?? [], now).map((p) => (p.kind === 'tool' && (p.status === 'running' || p.status === 'writing') ? { ...p, status: ended, endedAt: now, progress: undefined, chars: undefined } : p))
  // An agent that fails often says why as its last words too (Claude Code's sign-in errors): once is enough.
  const last = closed[closed.length - 1]
  const parts = error && !cancelled && last?.kind === 'text' && last.text.trim() === error.message.trim() ? closed.slice(0, -1) : closed
  return { ...reply, parts, phase: 'done', activity: undefined, finishedAt: now, usage: usage ?? reply.usage, error: cancelled ? undefined : error, stopped: cancelled || reply.stopped }
}

/** The words of a reply (without its thinking and steps): for copying and for link previews. */
export function replyText(reply: Reply) {
  return (reply.parts ?? [])
    .filter((p): p is TextPart => p.kind === 'text')
    .map((p) => p.text.trim())
    .filter(Boolean)
    .join('\n\n')
}

/** Everything a reply did, as text: for "Copy all". */
export function transcriptText(reply: Reply) {
  return (reply.parts ?? [])
    .map((p) => {
      if (p.kind === 'text') return p.text.trim()
      if (p.kind === 'thinking') return `> Thinking\n${p.text.trim().replace(/^/gm, '> ')}`
      if (p.kind === 'note') return `_${p.text}_`
      return [`**${p.title}** (\`${p.tool}\`) — ${p.status}`, p.input ? `Input:\n\`\`\`json\n${p.input}\n\`\`\`` : '', p.output ? `Result:\n\`\`\`\n${p.output}\n\`\`\`` : ''].filter(Boolean).join('\n')
    })
    .filter(Boolean)
    .join('\n\n')
}

/** A reply saved by an older Lumen (intro, a list of calls, an outro), as a transcript. */
export function fromLegacy(m: { text?: string; reasoning?: string; thoughtMs?: number; outro?: string; calls?: { id: string; tool: string; title: string; detail?: string; status: string; pictures?: number }[] }): Part[] {
  const parts: Part[] = []
  if (m.reasoning) parts.push({ kind: 'thinking', id: pid('think'), text: m.reasoning, startedAt: 0, ms: m.thoughtMs ?? 0 })
  if (m.text) parts.push({ kind: 'text', id: pid('text'), text: m.text })
  for (const c of m.calls ?? []) parts.push({ kind: 'tool', id: c.id, tool: c.tool, title: c.title, detail: c.detail, status: c.status === 'done' ? 'done' : 'error', startedAt: 0, pictures: c.pictures })
  if (m.outro) parts.push({ kind: 'text', id: pid('text'), text: m.outro })
  return parts
}

/** "1.2k", "34.5k", "1.1M": token counts as people read them. */
export function compact(n: number) {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

/** A line about what a turn used: "34k tokens in (31k from cache) · 812 out · 6 steps · 48 s". */
export function usageLine(reply: Reply & { startedAt?: number }) {
  const u = reply.usage
  const bits: string[] = []
  if (u?.inputTokens) bits.push(`${compact(u.inputTokens)} tokens in${u.cachedTokens ? ` (${compact(u.cachedTokens)} from cache)` : ''}`)
  if (u?.outputTokens) bits.push(`${compact(u.outputTokens)} out`)
  if (u?.steps && u.steps > 1) bits.push(`${u.steps} steps`)
  if (u?.costUsd) bits.push(`$${u.costUsd < 0.01 ? u.costUsd.toFixed(4) : u.costUsd.toFixed(2)}`)
  if (reply.startedAt && reply.finishedAt && reply.finishedAt > reply.startedAt) bits.push(duration(reply.finishedAt - reply.startedAt))
  return bits.join(' · ')
}

/** "8 s", "1 m 12 s". */
export function duration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} m ${s % 60} s`
}
