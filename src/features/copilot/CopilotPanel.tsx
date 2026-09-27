import { ArrowUp, AudioLines, Check, CircleAlert, CircleX, Image as ImageIcon, LoaderCircle, Mic, Paperclip, PlugZap, RotateCcw, Square, Trash, Upload, Video, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { Fragment, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { create } from 'zustand'
import { AiSparkle } from '@/components/brand'
import { IconButton } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { agentTools } from '@/integrations/agent-tools'
import { useEditor } from '@/editor/store'
import { useUI } from '@/editor/ui-store'
import { signInLocal, useAi } from '@/integrations/ai'
import { openIntegrations } from '@/integrations/store'
import { cn } from '@/lib/cn'
import { pickAndImport } from '@/project/media-import'
import { assetThumb } from '@/features/assets/shared'
import { BrainPicker } from './BrainPicker'
import { EffortPicker } from './EffortPicker'
import { attach, canUndoAll, detach, sendPrompt, stopCopilot, undoMessage, useAttachments, useCopilot, type Message, type ToolCall } from './store'
import { STARTERS } from './suggestions'
import { useVoiceInput } from './voice'

export function CopilotPanel() {
  const messages = useCopilot((s) => s.messages)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Stick to the bottom as replies stream in.
  const last = messages[messages.length - 1]
  const streamKey = last ? `${last.id}:${last.shown}:${last.outroShown}:${last.outro?.length}:${last.calls?.map((c) => `${c.status}${c.images?.length ?? ''}`).join()}:${last.phase}:${last.status}` : ''
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
  const tools = useMemo(() => agentTools(), [])
  const clear = useCopilot((s) => s.clear)
  const hasMessages = useCopilot((s) => s.messages.length > 0)
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
      {hasMessages && (
        <IconButton size="xs" label="Clear conversation" onClick={clear}>
          <Trash />
        </IconButton>
      )}
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

function UserBubble({ message }: { message: Message }) {
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col items-end gap-1.5">
      {message.context && message.context.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1">
          {message.context.map((c) => (
            <span key={c.id} className="rounded-md bg-white/[0.05] px-1.5 py-0.5 text-2xs text-fg-3">
              ◧ {c.name}
            </span>
          ))}
        </div>
      )}
      <div className="max-w-[88%] rounded-2xl rounded-br-md bg-white/[0.075] px-3.5 py-2 text-sm leading-relaxed text-fg shadow-[inset_0_0_0_1px_rgb(255_255_255/0.05)]">{message.text}</div>
    </motion.div>
  )
}

/** Tiny markdown: **bold** and line breaks / bullets. */
function RichText({ text }: { text: string }) {
  return (
    <>
      {text.split('\n').map((line, i) => (
        <p key={i} className={cn(i > 0 && 'mt-1.5', line.startsWith('•') && 'pl-3 -indent-3')}>
          {line.split(/(\*\*[^*]+\*\*)/g).map((part, j) =>
            part.startsWith('**') && part.endsWith('**') ? (
              <strong key={j} className="font-semibold text-fg">
                {part.slice(2, -2)}
              </strong>
            ) : (
              <Fragment key={j}>{part}</Fragment>
            ),
          )}
        </p>
      ))}
    </>
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
      <div className="min-w-0 flex-1 text-sm leading-relaxed text-fg-2">
        {m.agent && <div className="mb-1 text-[10.5px] font-medium tracking-wide text-fg-4">{m.agent}</div>}
        {m.phase === 'thinking' && (
          <span className="animate-shimmer bg-[linear-gradient(90deg,var(--color-fg-4)_30%,var(--color-fg)_50%,var(--color-fg-4)_70%)] bg-[length:200%_100%] bg-clip-text text-transparent">
            {m.status ?? 'Thinking…'}
          </span>
        )}
        {m.text && <RichText text={m.text.slice(0, m.shown)} />}

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
            <RichText text={m.outro.slice(0, m.outroShown ?? m.outro.length)} />
          </div>
        )}

        {m.error && <AgentError error={m.error} />}

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
