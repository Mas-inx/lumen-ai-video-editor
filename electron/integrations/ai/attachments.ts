import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { ATTACHMENT_LIMITS, type AttachmentContent, type AttachmentInput, type AttachmentKind, type ChatAttachment } from '../../../shared/ai'
import { ensureDir, userDir } from '../paths'

/**
 * Files attached to chat messages: pasted pictures, dropped documents, files
 * picked from disk. Each is kept under its conversation (copilot/attachments/
 * <conversation>/) so a later turn, or an agent calling read_attachment, can
 * still open it. Pictures and PDFs go to the model as they are; text files and
 * Word documents as their text.
 */

const root = () => ensureDir(path.join(userDir(), 'copilot', 'attachments'))
const safe = (s: string) => s.replace(/[^\w-]/g, '').slice(0, 120)
const dirOf = (conversationId: string) => path.join(root(), safe(conversationId))

const IMAGE_MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }

/** Extensions read as plain text. */
const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.xml', '.yaml', '.yml', '.toml', '.ini', '.log', '.srt', '.vtt', '.ass', '.edl', '.fcpxml',
  '.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.lua', '.sh', '.ps1', '.bat', '.c', '.h', '.cpp', '.cs', '.java', '.go', '.rs', '.rb', '.php', '.sql', '.tex', '.rtf',
]) // prettier-ignore

const MB = (bytes: number) => `${Math.round(bytes / 104857.6) / 10} MB`

/** What a file is to a model, from its name and type; null when Lumen can't hand it over. */
export function attachmentKind(name: string, mime = ''): { kind: AttachmentKind; mime: string } | 'docx' | null {
  const ext = path.extname(name).toLowerCase()
  if (IMAGE_MIME[ext]) return { kind: 'image', mime: IMAGE_MIME[ext] }
  if (/^image\/(png|jpeg|webp|gif)$/.test(mime)) return { kind: 'image', mime }
  if (ext === '.pdf' || mime === 'application/pdf') return { kind: 'pdf', mime: 'application/pdf' }
  if (ext === '.docx' || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx'
  if (TEXT_EXT.has(ext) || mime.startsWith('text/') || mime === 'application/json') return { kind: 'text', mime: 'text/plain' }
  return null
}

// ─── Word documents ──────────────────────────────────────────────────────

/** One file out of a zip archive (a .docx is one), or null when it isn't there. */
export function unzipEntry(zip: Buffer, name: string): Buffer | null {
  // The directory at the end lists every file and where its data starts.
  let end = -1
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      end = i
      break
    }
  }
  if (end < 0) return null
  const count = zip.readUInt16LE(end + 10)
  let p = zip.readUInt32LE(end + 16)
  for (let n = 0; n < count && p + 46 <= zip.length; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) return null
    const method = zip.readUInt16LE(p + 10)
    const packed = zip.readUInt32LE(p + 20)
    const nameLength = zip.readUInt16LE(p + 28)
    const extra = zip.readUInt16LE(p + 30)
    const comment = zip.readUInt16LE(p + 32)
    const local = zip.readUInt32LE(p + 42)
    if (zip.toString('utf8', p + 46, p + 46 + nameLength) === name) {
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
      const data = zip.subarray(start, start + packed)
      if (method === 0) return Buffer.from(data)
      if (method === 8) return zlib.inflateRawSync(data, { maxOutputLength: 64 * 1024 * 1024 })
      return null
    }
    p += 46 + nameLength + extra + comment
  }
  return null
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '’' }

/** The text of a Word document: paragraphs, line breaks and tabs, without the formatting. */
export function docxText(file: Buffer): string {
  const xml = unzipEntry(file, 'word/document.xml')?.toString('utf8')
  if (!xml) throw new Error('That Word document couldn’t be read. Save it as PDF or text and attach that.')
  return xml
    .replace(/<w:p[ >][\s\S]*?<\/w:p>/g, (para) => {
      const text = para
        .replace(/<w:tab\b[^>]*\/>/g, '\t')
        .replace(/<w:(?:br|cr)\b[^>]*\/>/g, '\n')
        .replace(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<[^>]+>/g, (_tag, run: string | undefined) => run ?? '')
      return `${text}\n`
    })
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|apos);/g, (_m, name: string) => XML_ENTITIES[name])
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ─── Saving and reading ──────────────────────────────────────────────────

/** Keeps a file for a conversation. Throws, in words for the user, when it's a kind or size a message can't take. */
export function saveAttachment(conversationId: string, input: AttachmentInput): ChatAttachment {
  if (!safe(conversationId)) throw new Error('No chat to attach to.')
  const name = path.basename(String(input.name)).slice(0, 120) || 'file'
  const what = attachmentKind(name, input.mime)
  if (!what) throw new Error(`“${name}” isn’t something a message can carry. Attach pictures, PDFs, Word documents or text files; add video and audio through Media.`)
  const size = input.data.byteLength
  const kind = what === 'docx' ? 'text' : what.kind
  // A Word file is mostly packaging: its limit is on the document, its text is checked below.
  const limit = what === 'docx' ? ATTACHMENT_LIMITS.pdf : ATTACHMENT_LIMITS[kind]
  if (size > limit) throw new Error(`“${name}” is ${MB(size)}: more than the ${MB(limit)} a message takes for this kind of file.`)
  let bytes = Buffer.from(input.data.buffer, input.data.byteOffset, input.data.byteLength)
  let chars: number | undefined
  if (kind === 'text') {
    const text = what === 'docx' ? docxText(bytes) : bytes.toString('utf8').replace(/^﻿/, '')
    if (text.includes('\u0000')) throw new Error(`“${name}” isn’t a text file.`)
    bytes = Buffer.from(text, 'utf8')
    // Never cut a document short without saying so: it's taken whole or not at all.
    if (bytes.length > ATTACHMENT_LIMITS.text) throw new Error(`“${name}” holds ${MB(bytes.length)} of text: more than the ${MB(ATTACHMENT_LIMITS.text)} a message takes. Attach the part you need.`)
    chars = text.length
  }
  const id = `att_${randomUUID().replace(/-/g, '').slice(0, 12)}`
  const meta: ChatAttachment = { id, name, mime: what === 'docx' ? 'text/plain' : what.mime, size: bytes.length, kind, ...(chars !== undefined ? { chars } : {}) }
  const dir = ensureDir(dirOf(conversationId))
  fs.writeFileSync(path.join(dir, `${id}.bin`), bytes)
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(meta))
  return meta
}

/** An attachment's details and bytes, or null when it's gone (the chat was deleted). */
export function readAttachment(conversationId: string, id: string): { meta: ChatAttachment; bytes: Buffer } | null {
  if (!safe(conversationId) || !/^att_[0-9a-f]{12}$/.test(id)) return null
  try {
    const dir = dirOf(conversationId)
    const meta = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8')) as ChatAttachment
    return { meta, bytes: fs.readFileSync(path.join(dir, `${id}.bin`)) }
  } catch {
    return null
  }
}

/** An attachment as an agent tool or the chat reads it back. */
export function attachmentContent(conversationId: string, id: string): AttachmentContent | null {
  const found = readAttachment(conversationId, id)
  if (!found) return null
  const { meta, bytes } = found
  if (meta.kind === 'text') return { meta, text: bytes.toString('utf8') }
  if (meta.kind === 'image') return { meta, data: bytes.toString('base64') }
  return { meta }
}

export function removeAttachment(conversationId: string, id: string) {
  if (!safe(conversationId) || !/^att_[0-9a-f]{12}$/.test(id)) return
  for (const ext of ['bin', 'json']) fs.rmSync(path.join(dirOf(conversationId), `${id}.${ext}`), { force: true })
}

export function forgetAttachments(conversationId: string) {
  if (safe(conversationId)) fs.rmSync(dirOf(conversationId), { recursive: true, force: true })
}
