import { ArrowUp, AudioLines, Brain, Check, ChevronRight, CircleAlert, CircleX, History, Image as ImageIcon, LoaderCircle, Mic, Paperclip, Pencil, PlugZap, Plus, RotateCcw, Square, Trash, Upload, Video, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { create } from 'zustand'
import { AiSparkle } from '@/components/brand'
import { IconButton } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { agentTools } from '@/integrations/agent-tools'
import { useEditor } from '@/editor/store'
import { useUI } from '@/editor/ui-store'
import { signInLocal, useAi } from '@/integrations/ai'
import { openIntegrations, useIntegrations } from '@/integrations/store'
import { cn } from '@/lib/cn'
import { pickAndImport } from '@/project/media-import'
import { assetThumb } from '@/features/assets/shared'
import { BrainPicker } from './BrainPicker'
import { EffortPicker } from './EffortPicker'
import type { WebPreview } from '@shared/integrations'
import { api } from '@/integrations/store'
import { CopyButton, linksIn, Markdown } from './Markdown'
import {
  attach,
  canUndoAll,
  chatTitle,
  deleteChat,
  detach,
  mergeChats,
  newChat,
  openChat,
  renameChat,
  sendPrompt,
  stopCopilot,
  undoMessage,
  useAttachments,
  useCopilot,
  type Chat,
  type Message,
  type ToolCall,
} from './store'
import { STARTERS } from './suggestions'
import { useVoiceInput } from './voice'

export function CopilotPanel() {
  const messages = useCopilot((s) => s.messages)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Stick to the bottom as replies stream in.
  const last = messages[messages.length - 1]
  const streamKey = last
    ? `${last.id}:${last.shown}:${last.outroShown}:${last.outro?.length}:${last.reasoning?.length}:${last.calls?.map((c) => `${c.status}${c.images?.length ?? ''}`).join()}:${last.phase}:${last.status}`
    : ''
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [streamKey])

  return (
    <div className="flex h-full flex-col">
      <StatusBar />
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {messages.length === 0 ? (
          <Welcome />
        ) : (
          <div className="space-y-5 pt-4">
            {messages.map((m) => (m.role === 'user' ? <UserBubble key={m.id} message={m} /> : <AssistantMessage key={m.id} message={m} />))}
          </div>
        )}
      </div>
      <Composer />
      <PictureViewer />
    </div>
  )
}

function StatusBar() {
  const servers = useIntegrations((s) => s.servers)
  const tools = useMemo(() => agentTools(servers), [servers])
  const hasMessages = useCopilot((s) => s.messages.length > 0)
  const busy = useCopilot((s) => s.busy)
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-4 text-2xs">
      <BrainPicker />
      <EffortPicker />
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className="ml-auto flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 font-medium text-fg-3 transition-colors hover:bg-white/[0.06] hover:text-fg">
            <PlugZap className="size-3" />
            {tools.length} tools
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80 p-0">
          <div className="border-b border-line px-3.5 py-3">
            <div className="text-sm font-semibold text-fg">Editor tools</div>
            <p className="mt-0.5 text-xs leading-relaxed text-fg-3">Every edit in Lumen is a typed command. Copilot’s models, your local agents and any MCP client use these same tools.</p>
          </div>
          <div className="max-h-72 overflow-y-auto p-1.5">
            {tools.map((t) => (
              <div key={t.name} className="rounded-md px-2 py-1.5 hover:bg-white/[0.04]">
                <div className="font-mono text-[11px] text-accent-2">{t.name}</div>
                <div className="line-clamp-2 text-2xs leading-snug text-fg-4">{t.description}</div>
              </div>
            ))}
          </div>
        </PopoverContent>
      </Popover>
      <ChatsMenu />
      <IconButton size="xs" label={busy ? 'Wait for the reply (or stop it) to start a new chat' : 'New chat'} disabled={busy || !hasMessages} onClick={newChat}>
        <Plus />
      </IconButton>
    </div>
  )
}

function ago(ms: number) {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`
  return new Date(ms).toLocaleDateString()
}

/** This project's chats: open one, rename it, delete it. */
function ChatsMenu() {
  const [open, setOpen] = useState(false)
  const busy = useCopilot((s) => s.busy)
  const current = useCopilot((s) => s.conversationId)
  const stored = useCopilot((s) => s.chats)
  const messages = useCopilot((s) => s.messages)
  const chats = open ? mergeChats(stored, messages, current) : []
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <IconButton size="xs" label="This project’s chats">
          <History />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center border-b border-line px-3.5 py-2.5">
          <div className="text-sm font-semibold text-fg">Chats</div>
          <span className="ml-1.5 text-2xs text-fg-4">in this project</span>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              newChat()
              setOpen(false)
            }}
            className="ml-auto flex items-center gap-1 rounded-md px-1.5 py-1 text-2xs font-medium text-fg-3 hover:bg-white/[0.06] hover:text-fg disabled:opacity-40"
          >
            <Plus className="size-3" /> New chat
          </button>
        </div>
        <div className="max-h-80 overflow-y-auto p-1.5">
          {chats.length === 0 && <div className="px-2 py-6 text-center text-xs text-fg-4">No chats yet — ask Copilot something.</div>}
          {chats.map((c) => (
            <ChatRow
              key={c.id}
              chat={c}
              active={c.id === current}
              disabled={busy}
              onOpen={() => {
                openChat(c.id)
                setOpen(false)
              }}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function ChatRow({ chat, active, disabled, onOpen }: { chat: Chat; active: boolean; disabled: boolean; onOpen: () => void }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  const turns = chat.messages.filter((m) => m.role === 'user').length
  if (editing)
    return (
      <form
        className="px-1 py-1"
        onSubmit={(e) => {
          e.preventDefault()
          renameChat(chat.id, name)
          setEditing(false)
        }}
      >
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Escape') setEditing(false)
          }}
          className="h-8 w-full rounded-md bg-white/[0.06] px-2 text-xs text-fg outline-none ring-1 ring-accent/50"
        />
      </form>
    )
  return (
    <div className={cn('group/chat flex items-center gap-1 rounded-lg px-2 py-1.5 hover:bg-white/[0.05]', active && 'bg-white/[0.06]')}>
      <button type="button" disabled={disabled && !active} onClick={onOpen} className="min-w-0 flex-1 text-left disabled:opacity-50">
        <div className={cn('truncate text-xs', active ? 'font-medium text-fg' : 'text-fg-2')}>{chatTitle(chat)}</div>
        <div className="text-[10.5px] text-fg-4">
          {ago(chat.updatedAt)} · {turns} {turns === 1 ? 'request' : 'requests'}
        </div>
      </button>
      <button
        type="button"
        aria-label="Rename chat"
        onClick={() => {
          setName(chatTitle(chat))
          setEditing(true)
        }}
        className="grid size-6 shrink-0 place-items-center rounded-md text-fg-4 opacity-0 transition-opacity group-hover/chat:opacity-100 hover:bg-white/[0.08] hover:text-fg-2"
      >
        <Pencil className="size-3" />
      </button>
      <button
        type="button"
        aria-label="Delete chat"
        disabled={disabled && active}
        onClick={() => deleteChat(chat.id)}
        className="grid size-6 shrink-0 place-items-center rounded-md text-fg-4 opacity-0 transition-opacity group-hover/chat:opacity-100 hover:bg-white/[0.08] hover:text-danger disabled:opacity-0"
      >
        <Trash className="size-3" />
      </button>
    </div>
  )
}

function Welcome() {
  return (
    <div className="flex min-h-full flex-col pt-8 pb-2">
      <div className="relative mx-auto mb-5 grid size-16 place-items-center">
        <div className="absolute inset-0 animate-aurora rounded-full bg-[conic-gradient(from_90deg,#d6ee00,#5ef2a6,#36d6f2,#d6ee00)] opacity-40 blur-xl" />
        <div className="relative grid size-14 place-items-center rounded-2xl bg-surface-3 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1),0_10px_30px_-8px_rgb(0_0_0/0.8)]">
          <AiSparkle className="size-7" />
        </div>
      </div>
      <h3 className="text-center text-xl font-semibold tracking-tight text-fg">What should we make?</h3>
      <p className="mx-auto mt-1.5 max-w-[250px] text-center text-sm leading-relaxed text-fg-3">Copilot edits your timeline directly. Every change is visible, and undoable in one step.</p>
      <RecentChats />
      <div className="mt-6 grid grid-cols-2 gap-2">
        {STARTERS.map((s, i) => (
          <motion.button
            key={s.title}
            type="button"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.04 * i, type: 'spring', stiffness: 400, damping: 30 }}
            onClick={() => void sendPrompt(s.prompt)}
            className="group rounded-xl bg-white/[0.035] p-3 text-left shadow-[inset_0_0_0_1px_rgb(255_255_255/0.05)] outline-none transition-[background-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:bg-white/[0.06] hover:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1)] focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            <div className="text-[12.5px] leading-snug font-medium text-fg">{s.title}</div>
            <div className="mt-0.5 text-2xs leading-snug text-fg-4 group-hover:text-fg-3">{s.subtitle}</div>
          </motion.button>
        ))}
      </div>
    </div>
  )
}

/** Earlier chats in this project, to pick one back up. */
function RecentChats() {
  const stored = useCopilot((s) => s.chats)
  const messages = useCopilot((s) => s.messages)
  const current = useCopilot((s) => s.conversationId)
  const chats = mergeChats(stored, messages, current).slice(0, 3)
  if (!chats.length) return null
  return (
    <div className="mt-6">
      <div className="mb-1.5 px-1 text-2xs font-semibold tracking-wider text-fg-4 uppercase">Carry on</div>
      <div className="space-y-1">
        {chats.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => openChat(c.id)}
            className="flex w-full items-center gap-2 rounded-lg bg-white/[0.03] px-3 py-2 text-left shadow-[inset_0_0_0_1px_rgb(255_255_255/0.05)] transition-colors hover:bg-white/[0.06]"
          >
            <History className="size-3.5 shrink-0 text-fg-4" />
            <span className="min-w-0 flex-1 truncate text-xs text-fg-2">{chatTitle(c)}</span>
            <span className="shrink-0 text-[10.5px] text-fg-4">{ago(c.updatedAt)}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function UserBubble({ message }: { message: Message }) {
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="group/user flex flex-col items-end gap-1.5">
      {message.context && message.context.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1">
          {message.context.map((c) => (
            <span key={c.id} className="rounded-md bg-white/[0.05] px-1.5 py-0.5 text-2xs text-fg-3">
              ◧ {c.name}
            </span>
          ))}
        </div>
      )}
      <div className="flex max-w-[88%] items-start gap-1">
        <CopyButton text={message.text} label="Copy request" className="mt-1 opacity-0 transition-opacity group-hover/user:opacity-100" />
        <div className="min-w-0 rounded-2xl rounded-br-md bg-white/[0.075] px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap text-fg shadow-[inset_0_0_0_1px_rgb(255_255_255/0.05)] [overflow-wrap:anywhere]">
          {message.text}
        </div>
      </div>
    </motion.div>
  )
}

/** The model's thinking: live while it streams, then folded away under "Thought for 12s". */
function Thinking({ message: m }: { message: Message }) {
  const live = Boolean(m.thinkingSince) && m.phase !== 'done'
  const [open, setOpen] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  // Follow the newest thoughts while they stream.
  useEffect(() => {
    const el = bodyRef.current
    if (el && live) el.scrollTop = el.scrollHeight
  }, [m.reasoning, live])
  if (!m.reasoning) return null
  const secs = Math.max(1, Math.round((m.thoughtMs ?? 0) / 1000))
  const shown = open || live
  return (
    <div className="mb-2">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex items-center gap-1.5 text-xs text-fg-3 transition-colors hover:text-fg-2">
        <Brain className="size-3.5" />
        {live ? (
          <span className="animate-shimmer bg-[linear-gradient(90deg,var(--color-fg-4)_30%,var(--color-fg)_50%,var(--color-fg-4)_70%)] bg-[length:200%_100%] bg-clip-text text-transparent">Thinking…</span>
        ) : (
          <span>{m.thoughtMs ? `Thought for ${secs}s` : 'Thoughts'}</span>
        )}
        <ChevronRight className={cn('size-3 transition-transform', shown && 'rotate-90')} />
      </button>
      {shown && (
        <div className="relative mt-1.5 border-l-2 border-line-2 pl-3">
          <div ref={bodyRef} className={cn('overflow-y-auto text-xs leading-relaxed text-fg-3', live ? 'max-h-24' : 'max-h-80')}>
            <Markdown text={m.reasoning} />
          </div>
          {!live && <CopyButton text={m.reasoning} label="Copy thinking" className="absolute -top-1 right-0" />}
        </div>
      )}
    </div>
  )
}

function AssistantMessage({ message: m }: { message: Message }) {
  const busy = useCopilot((s) => s.busy)
  const lastHistoryId = useEditor((s) => s.past[s.past.length - 1]?.id)
  const canUndo = !m.undone && (m.historyIds?.length ? lastHistoryId !== undefined && canUndoAll(m.historyIds) : Boolean(m.historyId) && lastHistoryId === m.historyId)
  const doneCalls = m.calls?.filter((c) => c.status === 'done').length ?? 0

  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="flex gap-2.5">
      <div className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-lg bg-surface-4 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]">
        <AiSparkle className="size-3.5" />
      </div>
      <div className="group/reply min-w-0 flex-1 text-sm leading-relaxed text-fg-2">
        {m.agent && <div className="mb-1 text-[10.5px] font-medium tracking-wide text-fg-4">{m.agent}</div>}
        <Thinking message={m} />
        {m.phase === 'thinking' && !m.reasoning && (
          <span className="animate-shimmer bg-[linear-gradient(90deg,var(--color-fg-4)_30%,var(--color-fg)_50%,var(--color-fg-4)_70%)] bg-[length:200%_100%] bg-clip-text text-transparent">
            {m.status ?? 'Thinking…'}
          </span>
        )}
        {m.text && <Markdown text={m.text.slice(0, m.shown)} />}

        {m.calls && m.calls.length > 0 && (
          <div className="mt-2.5 overflow-hidden rounded-xl bg-black/20 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]">
            <div className="flex h-8 items-center gap-2 border-b border-line px-3 text-2xs">
              <span className="font-medium text-fg-3">
                {m.phase === 'tools' ? 'Working on it' : m.undone ? 'Reverted' : m.historyIds?.length || m.historyId ? 'Edited timeline' : 'No changes made'}
              </span>
              <span className="text-fg-4 tabular">
                {doneCalls}/{m.calls.length}
              </span>
              {canUndo && !busy && (
                <button
                  type="button"
                  onClick={() => undoMessage(m.id)}
                  className="ml-auto flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-fg-3 transition-colors hover:bg-white/[0.07] hover:text-fg"
                >
                  <RotateCcw className="size-3" />
                  Undo all
                </button>
              )}
              {m.undone && <span className="ml-auto text-fg-4">Undone</span>}
            </div>
            <div className="p-1">
              <AnimatePresence initial={false}>
                {m.calls.map((c) => (
                  <CallRow key={c.id} call={c} undone={m.undone} />
                ))}
              </AnimatePresence>
            </div>
          </div>
        )}

        {m.outro && (
          <div className={cn(m.calls?.length || m.text ? 'mt-2.5' : '')}>
            <Markdown text={m.outro.slice(0, m.outroShown ?? m.outro.length)} />
          </div>
        )}

        {m.error && <AgentError error={m.error} />}

        {m.phase === 'done' && <LinkPreviews text={[m.text, m.outro].filter(Boolean).join('\n')} />}

        {m.phase === 'done' && (m.text || m.outro) && (
          <div className="mt-1 -ml-1 flex h-6 items-center opacity-0 transition-opacity group-hover/reply:opacity-100 focus-within:opacity-100">
            <CopyButton text={() => [m.text, m.outro].filter(Boolean).join('\n\n')} label="Copy reply" />
          </div>
        )}

        {m.phase === 'done' && m.suggestions && m.suggestions.length > 0 && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-3 flex flex-wrap gap-1.5">
            {m.suggestions.map((s) => (
              <button
                key={s}
                type="button"
                disabled={busy}
                onClick={() => void sendPrompt(s)}
                className="rounded-full bg-white/[0.04] px-2.5 py-1 text-xs text-fg-2 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.07)] transition-colors hover:bg-white/[0.08] hover:text-fg disabled:opacity-40"
              >
                {s}
              </button>
            ))}
          </motion.div>
        )}
      </div>
    </motion.div>
  )
}

const previews = new Map<string, Promise<WebPreview | null>>()

function previewOf(url: string) {
  let p = previews.get(url)
  if (!p) {
    p = api ? api.web.preview(url).catch(() => null) : Promise.resolve(null)
    previews.set(url, p)
  }
  return p
}

/** Cards for the pages a reply links to: title, site, a line of description and the page's picture. */
function LinkPreviews({ text }: { text: string }) {
  const urls = useMemo(() => linksIn(text).slice(0, 3), [text])
  const [cards, setCards] = useState<WebPreview[]>([])
  useEffect(() => {
    let alive = true
    void Promise.all(urls.map(previewOf)).then((list) => alive && setCards(list.filter((p): p is WebPreview => Boolean(p?.title))))
    return () => {
      alive = false
    }
  }, [urls])
  if (!cards.length) return null
  return (
    <div className="mt-2.5 space-y-1.5">
      {cards.map((c) => (
        <a
          key={c.url}
          href={c.url}
          target="_blank"
          rel="noreferrer noopener"
          className="flex overflow-hidden rounded-xl bg-white/[0.03] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.07)] transition-colors hover:bg-white/[0.06]"
        >
          {c.image && <img src={c.image} alt="" loading="lazy" className="h-[68px] w-[104px] shrink-0 object-cover" onError={(e) => (e.currentTarget.style.display = 'none')} />}
          <div className="min-w-0 flex-1 px-3 py-2">
            <div className="truncate text-[10.5px] text-fg-4">{c.site}</div>
            <div className="truncate text-xs font-medium text-fg">{c.title}</div>
            {c.description && <div className="line-clamp-1 text-[11px] text-fg-3">{c.description}</div>}
          </div>
        </a>
      ))}
    </div>
  )
}

/** What went wrong, with the one action that fixes it. */
function AgentError({ error }: { error: NonNullable<Message['error']> }) {
  const target = useAi((s) => s.target)
  const signingIn = useAi((s) => s.signingIn)
  let action: ReactNode = null
  if (error.code === 'no-brain')
    action = (
      <span className="inline-flex flex-wrap gap-x-3">
        <button type="button" onClick={() => openIntegrations('local-agents')} className="font-medium text-fg underline-offset-2 hover:underline">
          Use Claude Code or Codex
        </button>
        <button type="button" onClick={() => openIntegrations('ai-models')} className="font-medium text-fg underline-offset-2 hover:underline">
          Add an API key
        </button>
      </span>
    )
  else if (error.code === 'no-key' || error.code === 'auth')
    action = (
      <button type="button" onClick={() => openIntegrations('ai-models')} className="font-medium text-fg underline-offset-2 hover:underline">
        Open AI models
      </button>
    )
  else if (error.code === 'not-signed-in' && target?.kind === 'local')
    action = (
      <button type="button" disabled={signingIn[target.agent]} onClick={() => void signInLocal(target.agent)} className="font-medium text-fg underline-offset-2 hover:underline disabled:opacity-50">
        {signingIn[target.agent] ? 'Waiting for sign-in…' : 'Sign in'}
      </button>
    )
  else if (error.code === 'not-installed')
    action = (
      <button type="button" onClick={() => openIntegrations('local-agents')} className="font-medium text-fg underline-offset-2 hover:underline">
        Set up
      </button>
    )
  return (
    <div className="mt-2.5 flex gap-2 rounded-lg bg-danger/10 px-3 py-2 text-xs leading-relaxed text-danger shadow-[inset_0_0_0_1px_rgb(255_93_93/0.18)]">
      <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 break-words">
        {error.message} {action && <span className="ml-1 text-fg-2">{action}</span>}
      </div>
    </div>
  )
}

/** The picture being looked at full-size (a frame the AI saw). */
const usePicture = create<{ src: string | null }>(() => ({ src: null }))

function PictureViewer() {
  const src = usePicture((s) => s.src)
  const close = () => usePicture.setState({ src: null })
  useEffect(() => {
    if (!src) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [src])
  return (
    <AnimatePresence>
      {src && (
        <motion.button
          type="button"
          aria-label="Close picture"
          onClick={close}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[80] grid cursor-zoom-out place-items-center bg-black/80 p-8 backdrop-blur-sm"
        >
          <motion.img
            src={src}
            alt="What the Copilot looked at"
            initial={{ scale: 0.96 }}
            animate={{ scale: 1 }}
            className="max-h-full max-w-full rounded-xl shadow-2xl ring-1 ring-white/10"
            draggable={false}
          />
        </motion.button>
      )}
    </AnimatePresence>
  )
}

function CallRow({ call, undone }: { call: ToolCall; undone?: boolean }) {
  const icon: Record<ToolCall['status'], ReactNode> = {
    queued: <span className="size-1.5 rounded-full bg-fg-4" />,
    running: <LoaderCircle className="size-3.5 animate-spin text-accent-2" />,
    done: <Check className="size-3.5 text-ok" strokeWidth={2.5} />,
    error: <CircleX className="size-3.5 text-danger" />,
  }
  return (
    <motion.div
      layout
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: call.status === 'queued' ? 0.45 : 1, height: 'auto' }}
      className={cn('flex items-start gap-2.5 rounded-lg px-2 py-1.5', call.status === 'running' && 'bg-white/[0.04]', undone && 'opacity-50 line-through decoration-fg-4')}
    >
      <span className="mt-[3px] grid size-3.5 shrink-0 place-items-center">{icon[call.status]}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs text-fg">{call.title}</div>
        <div className="truncate font-mono text-[10px] text-fg-4">
          {call.tool}
          {call.detail && <span className="font-sans"> · {call.detail}</span>}
        </div>
        {!call.images?.length && call.pictures ? (
          <div className="mt-1 flex items-center gap-1 text-[10px] text-fg-4">
            <ImageIcon className="size-3" /> {call.pictures} picture{call.pictures === 1 ? '' : 's'} — not kept after a restart
          </div>
        ) : null}
        {call.images && call.images.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {call.images.map((src, i) => (
              <button
                key={i}
                type="button"
                title="What the Copilot looked at — click to enlarge"
                onClick={() => usePicture.setState({ src })}
                className="cursor-zoom-in overflow-hidden rounded-md ring-1 ring-white/10 transition-shadow hover:ring-accent/60"
              >
                <img src={src} alt="" className="block h-16 w-auto max-w-[220px] object-cover" draggable={false} />
              </button>
            ))}
          </div>
        )}
      </div>
    </motion.div>
  )
}

function Composer() {
  const draft = useCopilot((s) => s.draft)
  const setDraft = useCopilot((s) => s.setDraft)
  const busy = useCopilot((s) => s.busy)
  const selection = useUI((s) => s.selection)
  const names = useEditor((s) => selection.slice(0, 3).map((id) => s.project.clips[id]?.name).filter(Boolean).join('|'))
  const attachments = useAttachments((s) => s.items)
  const ref = useRef<HTMLTextAreaElement>(null)
  const voice = useVoiceInput((text) => {
    const current = useCopilot.getState().draft
    setDraft(current ? `${current.trimEnd()} ${text}` : text)
    ref.current?.focus()
  })

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.min(160, el.scrollHeight)}px`
  }, [draft])

  const submit = () => {
    if (!draft.trim() || busy) return
    void sendPrompt(draft)
  }

  return (
    <div className="shrink-0 p-3 pt-0">
      <div className="ring-ai rounded-2xl bg-surface-2 p-2 shadow-[0_-12px_30px_-18px_rgb(0_0_0/0.9)]">
        {attachments.length > 0 && (
          <div className="mb-1.5 flex flex-wrap items-center gap-1 px-1">
            {attachments.map((a) => (
              <span key={a.id} className="flex items-center gap-1 rounded-md bg-white/[0.06] py-0.5 pr-0.5 pl-1.5 text-2xs text-fg-2">
                <Paperclip className="size-2.5" /> {a.name}
                <button type="button" aria-label={`Remove ${a.name}`} onClick={() => detach(a.id)} className="grid size-4 place-items-center rounded text-fg-4 hover:text-fg-2">
                  <X className="size-2.5" />
                </button>
              </span>
            ))}
          </div>
        )}
        {names && (
          <div className="mb-1.5 flex flex-wrap items-center gap-1 px-1">
            {names.split('|').map((n) => (
              <span key={n} className="flex items-center gap-1 rounded-md bg-accent/12 px-1.5 py-0.5 text-2xs text-accent-2">
                ◧ {n}
              </span>
            ))}
            {selection.length > 3 && <span className="text-2xs text-fg-4">+{selection.length - 3} more</span>}
            <button type="button" aria-label="Clear selection" onClick={() => useUI.getState().clearSelection()} className="grid size-4 place-items-center rounded text-fg-4 hover:text-fg-2">
              <X className="size-3" />
            </button>
          </div>
        )}
        <textarea
          ref={ref}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          rows={1}
          placeholder={names ? 'What should I do with this?' : 'Ask Copilot to edit… e.g. “make it feel warmer”'}
          className="block max-h-40 min-h-[22px] w-full resize-none bg-transparent px-1.5 py-1 text-sm leading-relaxed text-fg outline-none placeholder:text-fg-4"
        />
        <div className="mt-1 flex items-center gap-0.5">
          <AttachMenu />
          <IconButton
            size="xs"
            label={voice.state === 'recording' ? 'Stop and transcribe' : voice.state === 'transcribing' ? 'Transcribing…' : 'Speak your request'}
            active={voice.state === 'recording'}
            disabled={voice.state === 'transcribing'}
            onClick={voice.toggle}
            className={cn(voice.state === 'recording' && 'animate-pulse-soft text-danger')}
          >
            {voice.state === 'transcribing' ? <LoaderCircle className="animate-spin" /> : <Mic />}
          </IconButton>
          <span className="ml-1 text-2xs text-fg-4">{voice.state === 'recording' ? 'Listening… click the mic to finish' : '↵ send · ⇧↵ new line'}</span>
          {busy ? (
            <button
              type="button"
              aria-label="Stop"
              onClick={stopCopilot}
              className="ml-auto grid size-7 place-items-center rounded-full bg-white/[0.1] text-fg transition-colors hover:bg-white/[0.16]"
            >
              <Square className="size-2.5" fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              aria-label="Send"
              onClick={submit}
              disabled={!draft.trim()}
              className={cn(
                'ml-auto grid size-7 place-items-center rounded-full transition-[background,transform,opacity] duration-200',
                draft.trim() ? 'bg-ai text-accent-fg shadow-[0_4px_14px_-4px_rgb(94_242_166/0.6)] hover:scale-105' : 'bg-white/[0.07] text-fg-4',
              )}
            >
              <ArrowUp className="size-4" strokeWidth={2.5} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/** Point Copilot at specific media from the library (or a new file from disk). */
function AttachMenu() {
  const assets = useEditor((s) => s.project.assets)
  const list = Object.values(assets).sort((a, b) => b.addedAt - a.addedAt)
  return (
    <Popover>
      <PopoverTrigger asChild>
        <IconButton size="xs" label="Attach media">
          <Paperclip />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-72 p-1.5">
        <div className="px-2 pt-1 pb-1.5 text-2xs font-semibold tracking-wider text-fg-4 uppercase">Attach from your media</div>
        <div className="max-h-64 overflow-y-auto">
          {list.length === 0 && <div className="px-2 py-3 text-xs text-fg-4">No media in this project yet.</div>}
          {list.map((a) => {
            const thumb = a.kind !== 'audio' ? assetThumb(a) : undefined
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => attach({ id: a.id, name: a.name, kind: 'asset' })}
                className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-xs text-fg-2 hover:bg-white/[0.06] hover:text-fg"
              >
                <span className="grid h-7 w-11 shrink-0 place-items-center overflow-hidden rounded-md bg-white/[0.05] text-fg-4 [&_svg]:size-3.5">
                  {thumb ? <img src={thumb} alt="" className="h-full w-full object-cover" /> : a.kind === 'audio' ? <AudioLines /> : a.kind === 'video' ? <Video /> : <ImageIcon />}
                </span>
                <span className="min-w-0 flex-1 truncate">{a.name}</span>
              </button>
            )
          })}
        </div>
        <button
          type="button"
          onClick={() =>
            void pickAndImport().then((added) => {
              for (const a of added) attach({ id: a.id, name: a.name, kind: 'asset' })
            })
          }
          className="mt-1 flex w-full items-center gap-2 rounded-lg border-t border-line px-2 pt-2 pb-1.5 text-xs text-fg-3 hover:text-fg"
        >
          <Upload className="size-3.5" /> Import a file and attach it…
        </button>
      </PopoverContent>
    </Popover>
  )
}
