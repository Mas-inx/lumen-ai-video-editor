import fs from 'node:fs'
import path from 'node:path'
import type { ModelMessage } from 'ai'
import { ensureDir, userDir } from '../paths'

/**
 * Copilot conversations on disk, so they outlive the window:
 * - copilot/chats/<project id>.json — each project's chats as the editor shows them;
 * - copilot/history/<conversation id>.json — what an API model remembers of a chat;
 * - copilot/sessions.json — the Claude Code session / Codex thread behind each chat.
 */

const root = () => ensureDir(path.join(userDir(), 'copilot'))
const safe = (s: string) => s.replace(/[^\w-]/g, '').slice(0, 120)
const MAX_CHATS_BYTES = 24 * 1024 * 1024

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

function writeJson(file: string, value: unknown) {
  ensureDir(path.dirname(file))
  const partial = `${file}.${process.pid}.part`
  fs.writeFileSync(partial, JSON.stringify(value))
  fs.renameSync(partial, file)
}

// ─── Chats (per project) ─────────────────────────────────────────────────

const chatsFile = (projectId: string) => path.join(root(), 'chats', `${safe(projectId)}.json`)

export function loadChats(projectId: string): unknown[] {
  if (!safe(projectId)) return []
  const data = readJson<{ chats?: unknown }>(chatsFile(projectId))
  return Array.isArray(data?.chats) ? data.chats : []
}

export function saveChats(projectId: string, chats: unknown) {
  if (!safe(projectId) || !Array.isArray(chats)) return
  const text = JSON.stringify({ chats })
  if (text.length > MAX_CHATS_BYTES) throw new Error('These chats are too large to keep — delete some old ones.')
  ensureDir(path.join(root(), 'chats'))
  const file = chatsFile(projectId)
  const partial = `${file}.${process.pid}.part`
  fs.writeFileSync(partial, text)
  fs.renameSync(partial, file)
}

// ─── Model history (per conversation) ────────────────────────────────────

const historyFile = (conversationId: string) => path.join(root(), 'history', `${safe(conversationId)}.json`)

export function readHistory(conversationId: string): ModelMessage[] | null {
  if (!safe(conversationId)) return null
  const data = readJson<ModelMessage[]>(historyFile(conversationId))
  return Array.isArray(data) ? data : null
}

export function writeHistory(conversationId: string, messages: ModelMessage[]) {
  if (!safe(conversationId)) return
  try {
    writeJson(historyFile(conversationId), messages)
  } catch {
    // Remembering is best-effort: the conversation still works this session.
  }
}

export function deleteHistory(conversationId: string) {
  if (safe(conversationId)) fs.rmSync(historyFile(conversationId), { force: true })
}

// ─── Local agent sessions ────────────────────────────────────────────────

const sessionsFile = () => path.join(root(), 'sessions.json')

export function loadSessions(): Map<string, string> {
  const data = readJson<Record<string, unknown>>(sessionsFile()) ?? {}
  return new Map(Object.entries(data).filter((e): e is [string, string] => typeof e[1] === 'string'))
}

let sessionTimer: ReturnType<typeof setTimeout> | undefined
export function saveSessions(sessions: Map<string, string>) {
  clearTimeout(sessionTimer)
  sessionTimer = setTimeout(() => {
    try {
      // The newest few hundred are plenty.
      writeJson(sessionsFile(), Object.fromEntries([...sessions].slice(-400)))
    } catch {
      // Best-effort.
    }
  }, 500)
}
