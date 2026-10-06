import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { app, dialog, type BrowserWindow } from 'electron'
import { APP_IPC } from '../shared/app'
import {
  clipStatusBody,
  INGEST_DEFAULT_PORT,
  INGEST_FORMATS,
  INGEST_PATH,
  INGEST_QUALITIES,
  INGEST_REQUEST_BYTES,
  ingestFileBase,
  IngestError,
  ingestQuality,
  metaSummary,
  maxFrameBytes,
  parseClipRequest,
  rawFrameBytes,
  type IngestClip,
  type IngestQuality,
  type IngestResult,
  type IngestSession,
  type IngestState,
} from '../shared/ingest'
import { abortExport, beginFile } from './export'
import { ensureDir, MEDIA_SCHEME, mediaRoot, readJson, writeJson } from './integrations/paths'

/**
 * The frame-ingest receiver. Another app on this computer (GS Cinematic Studio
 * in the game's browser, say) posts a clip, then its frames one at a time, as
 * raw pixels over loopback HTTP. Frames go straight on to the editor's encoder,
 * which pulls them from here; nothing is kept beyond a couple of frames, and a
 * sender that is faster than the encoder simply waits for its answer.
 *
 * It listens on 127.0.0.1 only and needs a bearer token. Browser pages can call
 * it (the sender is one), so every answer carries CORS headers — the token is
 * what protects it.
 */

const SETTINGS = 'lumen-ingest.json'
/** Frames waiting for the encoder, per clip. */
const QUEUE_FRAMES = 2
/** How long a frame may wait for room before the sender is told the encoder is stuck. */
const PUT_TIMEOUT = 120_000
/** A clip with no activity for this long is given up on. */
const IDLE_TIMEOUT = 10 * 60_000
/** How long the encoder's request for the next frame stays open before it asks again. */
const POLL_WAIT = 20_000
const MAX_ACTIVE = 6
const KEEP_FINISHED = 40

interface Settings {
  enabled?: boolean
  port?: number
  token?: string
  quality?: IngestQuality
  folder?: string
}

interface Frame {
  index: number
  data: Buffer
}

/** Frames on their way from a sender to the encoder: bounded, so a fast sender waits. */
export class FrameQueue {
  private frames: Frame[] = []
  private takers: ((f: Frame | 'end' | 'aborted' | null) => void)[] = []
  private room: (() => void)[] = []
  private state: 'open' | 'finished' | 'aborted' = 'open'

  constructor(private readonly capacity = QUEUE_FRAMES) {}

  get aborted() {
    return this.state === 'aborted'
  }

  /** Queues a frame, waiting while the queue is full. False if the queue was aborted, or still full after `timeoutMs`. */
  async put(frame: Frame, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (this.state === 'open' && this.frames.length >= this.capacity) {
      const left = deadline - Date.now()
      if (left <= 0) return false
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer)
          resolve()
        }
        const timer = setTimeout(() => {
          this.room = this.room.filter((r) => r !== done)
          resolve()
        }, left)
        this.room.push(done)
      })
    }
    if (this.state !== 'open') return false
    const taker = this.takers.shift()
    if (taker) taker(frame)
    else this.frames.push(frame)
    return true
  }

  /** The next frame; 'end' once finished and empty; 'aborted'; or null when nothing came within `waitMs`. */
  take(waitMs: number): Promise<Frame | 'end' | 'aborted' | null> {
    if (this.state === 'aborted') return Promise.resolve('aborted')
    const frame = this.frames.shift()
    if (frame) {
      this.room.shift()?.()
      return Promise.resolve(frame)
    }
    if (this.state === 'finished') return Promise.resolve('end')
    return new Promise((resolve) => {
      const taker = (f: Frame | 'end' | 'aborted' | null) => {
        clearTimeout(timer)
        resolve(f)
      }
      const timer = setTimeout(() => {
        this.takers = this.takers.filter((t) => t !== taker)
        resolve(null)
      }, waitMs)
      this.takers.push(taker)
    })
  }

  /** No more frames are coming; what's queued is still handed out. */
  finish() {
    if (this.state !== 'open') return
    this.state = 'finished'
    if (!this.frames.length) for (const t of this.takers.splice(0)) t('end')
  }

  abort() {
    this.state = 'aborted'
    this.frames = []
    for (const t of this.takers.splice(0)) t('aborted')
    for (const r of this.room.splice(0)) r()
  }
}

interface Live {
  clip: IngestClip
  queue: FrameQueue
  master?: { id: string; path: string }
  proxy?: { id: string; path: string } | null
  /** A PUT for this clip is being read. */
  busy: boolean
  /** Bytes of the last accepted frame (a resend of it is answered again, not refused). */
  lastBytes: number
  idle?: NodeJS.Timeout
}

const clips = new Map<string, Live>()
/** Master files being written, so two clips with one name don't collide. */
const reserved = new Set<string>()
/** Clips the sender deleted while their file was being finished: clip id → the file to remove if it still appears. */
const discarded = new Map<string, string>()
let server: http.Server | null = null
let port = 0
let lastError: string | undefined
let editor: BrowserWindow | null = null
/** The editor's encoder has said it is listening. */
let attached = false
/** Started for an agent this session, not by the user's switch. */
let sessionOnly = false

// ─── Settings ────────────────────────────────────────────────────────────

function settings(): Settings & { token: string } {
  const s = readJson<Settings>(SETTINGS, {})
  if (!s.token) {
    s.token = randomBytes(24).toString('base64url')
    writeJson(SETTINGS, s)
  }
  return s as Settings & { token: string }
}

const defaultFolder = () => path.join(mediaRoot(), 'ingest')

function folder() {
  const custom = settings().folder
  if (custom) {
    try {
      return ensureDir(custom)
    } catch {
      /* the drive is gone: fall back to Lumen's own folder */
    }
  }
  return ensureDir(defaultFolder())
}

export function ingestState(): IngestState {
  const s = settings()
  const running = Boolean(server)
  return {
    running,
    port: running ? port : (s.port ?? INGEST_DEFAULT_PORT),
    url: running ? `http://127.0.0.1:${port}${INGEST_PATH}` : undefined,
    token: s.token,
    error: lastError,
    quality: ingestQuality(s.quality).id,
    folder: s.folder || defaultFolder(),
    // A clip's cue sheet stays here: the editor gets it once, with the clip, not with every progress note.
    clips: [...clips.values()].map((l) => ({ ...l.clip, meta: metaSummary(l.clip.meta) })).sort((a, b) => b.createdAt - a.createdAt),
  }
}

let emitTimer: NodeJS.Timeout | null = null
let emittedAt = 0

/** Tells the editor what changed — at once for state changes, at most a few times a second for frame counts. */
function emit(now = true) {
  const send = () => {
    emitTimer = null
    emittedAt = Date.now()
    if (editor && !editor.isDestroyed()) editor.webContents.send(APP_IPC.ingestEvent, ingestState())
  }
  if (now) {
    if (emitTimer) clearTimeout(emitTimer)
    return send()
  }
  if (emitTimer) return
  emitTimer = setTimeout(send, Math.max(0, 200 - (Date.now() - emittedAt)))
}

// ─── Clips ───────────────────────────────────────────────────────────────

function touch(live: Live) {
  live.clip.updatedAt = Date.now()
  if (live.idle) clearTimeout(live.idle)
  live.idle = undefined
  if (live.clip.status === 'receiving') {
    live.idle = setTimeout(() => failClip(live.clip.id, 'No frames arrived for 10 minutes, so this clip was given up on.'), IDLE_TIMEOUT)
    live.idle.unref?.()
  }
}

function discardFiles(live: Live) {
  if (live.master) {
    abortExport(live.master.id)
    reserved.delete(live.master.path.toLowerCase())
  }
  if (live.proxy) abortExport(live.proxy.id)
}

function prune() {
  const finished = [...clips.values()].filter((l) => l.clip.status === 'done' || l.clip.status === 'error').sort((a, b) => b.clip.updatedAt - a.clip.updatedAt)
  for (const old of finished.slice(KEEP_FINISHED)) clips.delete(old.clip.id)
}

export function failClip(id: string, message: string) {
  const live = clips.get(id)
  if (!live || live.clip.status === 'done' || live.clip.status === 'error') return
  live.clip.status = 'error'
  live.clip.error = String(message || 'The clip could not be encoded.').slice(0, 500)
  live.queue.abort()
  discardFiles(live)
  touch(live)
  prune()
  emit()
}

function removeClip(id: string) {
  const live = clips.get(id)
  if (!live) return
  if (live.idle) clearTimeout(live.idle)
  if (live.clip.status !== 'done') {
    live.queue.abort()
    discardFiles(live)
    // The editor may be writing the last bytes right now; its file is removed when it reports in.
    if (live.master) {
      discarded.set(id, live.master.path)
      if (discarded.size > 200) discarded.delete(discarded.keys().next().value!)
    }
  }
  clips.delete(id)
  emit()
}

/** A file name nothing else has: `name.mp4`, then `name (2).mp4`… */
function freeFile(dir: string, base: string, ext: string) {
  for (let n = 1; n < 10_000; n++) {
    const candidate = path.join(dir, `${base}${n === 1 ? '' : ` (${n})`}${ext}`)
    const key = candidate.toLowerCase()
    if (!reserved.has(key) && !fs.existsSync(candidate) && !fs.existsSync(`${candidate}.partial`)) {
      reserved.add(key)
      return candidate
    }
  }
  throw new Error('Couldn’t find a free file name for the clip.')
}

// ─── The editor's side (over IPC and the media protocol) ─────────────────

/** The editor's encoder is listening. Clips it wasn't there for can't be picked up again. */
export function attachEditor(): IngestState {
  for (const live of clips.values()) {
    if (live.clip.status === 'receiving' || live.clip.status === 'assembling') failClip(live.clip.id, 'The editor restarted while this clip was arriving. Send it again.')
  }
  attached = true
  return ingestState()
}

/** Opens a clip's files for the encoder and tells it where its frames come from. */
export function openSession(id: string, wantProxy: boolean): IngestSession {
  const live = clips.get(String(id))
  if (!live || live.queue.aborted) throw new Error('That clip is no longer arriving.')
  if (!live.master) {
    const dir = folder()
    live.master = beginFile(freeFile(dir, ingestFileBase(live.clip.name), '.mp4'))
    live.proxy = wantProxy ? beginFile(path.join(mediaRoot(), 'proxies', `ingest-${live.clip.id}.mp4`)) : null
  }
  return { clip: live.clip, nextUrl: `${MEDIA_SCHEME}://ingest/${live.clip.id}/next`, master: live.master, proxy: live.proxy ?? null }
}

export function reportProgress(id: string, encoded: number) {
  const live = clips.get(String(id))
  if (!live || !Number.isFinite(encoded)) return
  live.clip.encoded = Math.max(live.clip.encoded, Math.floor(encoded))
  emit(false)
}

/**
 * The editor wrote the file. Returns false if the sender deleted the clip
 * meanwhile — the file is then removed and nothing is added to the library.
 */
export function completeClip(id: string, result: IngestResult): boolean {
  const live = clips.get(String(id))
  const file = live?.master?.path ?? discarded.get(String(id))
  discarded.delete(String(id))
  if (!live || live.clip.status === 'error' || live.queue.aborted || !file) {
    // Only ever a file this receiver opened itself.
    if (file) fs.rmSync(file, { force: true })
    return false
  }
  reserved.delete(file.toLowerCase())
  Object.assign(live.clip, {
    status: 'done',
    assetId: String(result.assetId),
    path: file,
    bytes: Number(result.bytes) || 0,
    codec: String(result.codec),
    durationSeconds: Number(result.durationSeconds) || 0,
    encoded: live.clip.received,
  })
  touch(live)
  prune()
  emit()
  return true
}

const PROTOCOL_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'X-Frame-Index, X-Frames',
  'Cache-Control': 'no-store',
}

/** `lumen-media://ingest/<clip>/next`: the encoder's long poll for its next frame. */
export async function serveIngest(req: Request): Promise<Response> {
  const [id, what] = new URL(req.url).pathname.split('/').filter(Boolean)
  const live = clips.get(id ?? '')
  if (!live || what !== 'next') return new Response(null, { status: 410, headers: PROTOCOL_HEADERS })
  const item = await live.queue.take(POLL_WAIT)
  // Nothing yet: the encoder asks again.
  if (item === null) return new Response(null, { status: 202, headers: PROTOCOL_HEADERS })
  if (item === 'aborted') return new Response(null, { status: 410, headers: PROTOCOL_HEADERS })
  if (item === 'end') return new Response(null, { status: 204, headers: { ...PROTOCOL_HEADERS, 'X-Frames': String(live.clip.received) } })
  return new Response(new Uint8Array(item.data.buffer, item.data.byteOffset, item.data.byteLength), {
    status: 200,
    headers: { ...PROTOCOL_HEADERS, 'Content-Type': 'application/octet-stream', 'Content-Length': String(item.data.byteLength), 'X-Frame-Index': String(item.index) },
  })
}

// ─── HTTP ────────────────────────────────────────────────────────────────

const CORS = { 'Access-Control-Allow-Origin': '*' }
const PREFLIGHT = {
  ...CORS,
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Private-Network': 'true',
  'Access-Control-Max-Age': '600',
}

function authorized(header: string | undefined, token: string) {
  const given = Buffer.from(header?.replace(/^Bearer\s+/i, '') ?? '')
  const want = Buffer.from(token)
  return given.length === want.length && timingSafeEqual(given, want)
}

/** Reads and throws away a body, so the answer reaches a sender that is still uploading. */
function drain(req: http.IncomingMessage) {
  return new Promise<void>((resolve) => {
    if (req.readableEnded) return resolve()
    req.on('end', resolve).on('error', () => resolve()).on('close', resolve)
    req.resume()
  })
}

function readJsonBody(req: http.IncomingMessage, limit = 65536): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size <= limit) chunks.push(c)
    })
    req.on('end', () => {
      if (size > limit) return reject(new IngestError(413, 'too_large', 'That request body is too large.'))
      if (!size) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new IngestError(400, 'bad_json', 'The request body isn’t valid JSON.'))
      }
    })
    req.on('error', () => reject(new IngestError(400, 'bad_request', 'The request was cut off.')))
  })
}

/** One frame's bytes, checked for size as they arrive. `exact` is known for raw frames. */
function readFrame(req: http.IncomingMessage, exact: number | null, max: number, describe: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const whole = exact !== null ? Buffer.allocUnsafe(exact) : null
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      if (whole) {
        if (size + c.length <= whole.length) c.copy(whole, size)
      } else if (size + c.length <= max) chunks.push(c)
      size += c.length
    })
    req.on('end', () => {
      if (exact !== null && size !== exact) return reject(new IngestError(400, 'bad_frame_size', `${describe} is exactly ${exact} bytes; this one was ${size}.`, { expected: exact, got: size }))
      if (size > max) return reject(new IngestError(413, 'too_large', `That frame is ${size} bytes, more than a frame of this clip can be.`, { max }))
      if (!size) return reject(new IngestError(400, 'empty_frame', 'The frame has no bytes.'))
      resolve(whole ?? Buffer.concat(chunks, size))
    })
    req.on('error', () => reject(new IngestError(400, 'bad_request', 'The frame was cut off.')))
  })
}

function need(id: string | undefined): Live {
  const live = clips.get(id ?? '')
  if (!live) throw new IngestError(404, 'no_such_clip', 'There’s no clip with that id (it may have been deleted).')
  return live
}

async function putFrame(req: http.IncomingMessage, live: Live, indexText: string) {
  const clip = live.clip
  const index = /^\d+$/.test(indexText) ? Number(indexText) : NaN
  if (!Number.isSafeInteger(index)) throw new IngestError(400, 'bad_index', 'The frame index must be a whole number, counting from 0.')
  if (clip.status !== 'receiving') {
    throw new IngestError(409, clip.status === 'error' ? 'clip_failed' : 'not_receiving', clip.status === 'error' ? `This clip failed: ${clip.error}` : 'This clip is already finished — it takes no more frames.')
  }
  const raw = clip.format !== 'png'
  const exact = raw ? rawFrameBytes(clip.width, clip.height) : null
  const declared = Number(req.headers['content-length'])
  // The frame just accepted, sent again (a retry after a dropped answer): fine, nothing to do.
  if (index === clip.received - 1 && (!Number.isFinite(declared) || declared === live.lastBytes)) return void (await drain(req))
  if (index !== clip.received) {
    throw new IngestError(409, 'out_of_order', `Frames must arrive in order: expected frame ${clip.received}, got ${index}.`, { expected: clip.received })
  }
  if (clip.frames && index >= clip.frames) throw new IngestError(409, 'too_many_frames', `This clip was announced with ${clip.frames} frames.`, { expected: clip.frames })
  if (live.busy) throw new IngestError(409, 'busy', 'Another frame of this clip is still arriving — send them one at a time.')
  if (exact !== null && Number.isFinite(declared) && declared !== exact) {
    throw new IngestError(400, 'bad_frame_size', `A ${clip.width}×${clip.height} ${clip.format} frame is exactly ${exact} bytes; this one is ${declared}.`, { expected: exact, got: declared })
  }
  live.busy = true
  try {
    const data = await readFrame(req, exact, maxFrameBytes(clip), `A ${clip.width}×${clip.height} ${clip.format} frame`)
    if (!(await live.queue.put({ index, data }, PUT_TIMEOUT))) {
      if (live.queue.aborted) throw new IngestError(409, live.clip.status === 'error' ? 'clip_failed' : 'no_such_clip', live.clip.error ? `This clip failed: ${live.clip.error}` : 'This clip was deleted.')
      failClip(clip.id, 'Lumen’s encoder stopped taking frames.')
      throw new IngestError(503, 'encoder_stalled', 'Lumen’s encoder stopped taking frames. Check that the editor window is open and responding, then send the clip again.')
    }
    clip.received = index + 1
    live.lastBytes = data.byteLength
    touch(live)
    emit(false)
  } finally {
    live.busy = false
  }
}

function createClip(body: unknown): IngestClip {
  if (!editor || editor.isDestroyed() || !attached) {
    throw new IngestError(503, 'editor_unavailable', 'Lumen’s editor isn’t ready to receive clips. Open Lumen’s window and try again.')
  }
  const active = [...clips.values()].filter((l) => l.clip.status === 'receiving' || l.clip.status === 'assembling').length
  if (active >= MAX_ACTIVE) throw new IngestError(429, 'too_many_clips', `Lumen is already receiving ${active} clips — finish or delete one first.`)
  const request = parseClipRequest(body, { quality: ingestQuality(settings().quality).id })
  const now = Date.now()
  const clip: IngestClip = { ...request, id: randomUUID(), status: 'receiving', received: 0, encoded: 0, createdAt: now, updatedAt: now }
  const live: Live = { clip, queue: new FrameQueue(), busy: false, lastBytes: 0 }
  clips.set(clip.id, live)
  touch(live)
  editor.webContents.send(APP_IPC.ingestClip, clip)
  emit()
  return clip
}

async function finishClip(req: http.IncomingMessage, live: Live) {
  const body = (await readJsonBody(req)) as { frames?: unknown } | null
  const clip = live.clip
  if (clip.status === 'error') throw new IngestError(409, 'clip_failed', `This clip failed: ${clip.error}`)
  // Finishing twice is harmless.
  if (clip.status !== 'receiving') return
  const count = body && typeof body === 'object' ? body.frames : undefined
  if (count !== undefined && count !== clip.received) {
    throw new IngestError(409, 'frame_count_mismatch', `You said ${String(count)} frames were sent; Lumen received ${clip.received}.`, { received: clip.received })
  }
  if (!clip.received) throw new IngestError(409, 'no_frames', 'This clip has no frames yet.')
  clip.status = 'assembling'
  live.queue.finish()
  touch(live)
  emit()
}

/** Every request to the receiver. Exported for tests. */
export async function handleIngestRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const json = (status: number, body: unknown) => res.writeHead(status, { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(body))
  const empty = (status: number) => res.writeHead(status, CORS).end()
  try {
    // Preflights carry no token: a browser sends them before it knows the request is allowed.
    if (req.method === 'OPTIONS') return void res.writeHead(204, PREFLIGHT).end()
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const host = (req.headers.host ?? '').replace(/:\d+$/, '')
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) throw new IngestError(403, 'forbidden', 'This endpoint only answers on this computer.')
    if (!url.pathname.startsWith(INGEST_PATH)) throw new IngestError(404, 'not_found', `The endpoints live under ${INGEST_PATH}.`)
    if (!authorized(req.headers.authorization, settings().token)) {
      throw new IngestError(401, 'unauthorized', 'Missing or wrong token. Send “Authorization: Bearer <token>” — copy the token from Lumen › Integrations › Frame ingest, or call ingest_start.')
    }
    const parts = url.pathname.slice(INGEST_PATH.length).split('/').filter(Boolean)
    const method = req.method ?? 'GET'
    const route = `${method} ${parts.map((p, i) => (i % 2 ? ':' : p)).join('/')}`

    if (route === 'GET health') {
      return void json(200, {
        ok: true,
        app: 'lumen',
        version: app.getVersion(),
        formats: INGEST_FORMATS,
        origins: ['top-left', 'bottom-left'],
        qualities: INGEST_QUALITIES.map((q) => q.id),
        quality: ingestQuality(settings().quality).id,
        ready: Boolean(editor && !editor.isDestroyed() && attached),
      })
    }
    if (route === 'GET clips') return void json(200, { clips: ingestState().clips.map(clipStatusBody) })
    if (route === 'POST clips') {
      const clip = createClip(await readJsonBody(req, INGEST_REQUEST_BYTES))
      return void json(201, { clip_id: clip.id, quality: clip.quality })
    }
    if (route === 'GET clips/:') return void json(200, clipStatusBody(need(parts[1]).clip))
    if (route === 'DELETE clips/:') {
      removeClip(need(parts[1]).clip.id)
      return void empty(204)
    }
    if (route === 'PUT clips/:/frames/:') {
      await putFrame(req, need(parts[1]), parts[3])
      return void empty(204)
    }
    if (route === 'POST clips/:/finish') {
      const live = need(parts[1])
      await finishClip(req, live)
      return void json(202, { status: live.clip.status })
    }
    throw new IngestError(parts.length ? 405 : 404, 'not_found', `There’s nothing at ${method} ${url.pathname}.`)
  } catch (err) {
    // The answer only reaches a sender that has finished uploading.
    await drain(req)
    if (res.headersSent) return void res.end()
    if (err instanceof IngestError) return void json(err.status, { error: err.code, message: err.message, ...err.extra })
    json(500, { error: 'internal', message: err instanceof Error ? err.message : String(err) })
  }
}

// ─── Starting and stopping ───────────────────────────────────────────────

function listen(srv: http.Server, at: number) {
  return new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err)
    srv.once('error', onError)
    srv.listen(at, '127.0.0.1', () => {
      srv.removeListener('error', onError)
      resolve()
    })
  })
}

/** Starts the receiver. `persist` false starts it for this session only (an agent asked), leaving the user's switch alone. */
export async function startIngest(persist = true): Promise<IngestState> {
  if (server) {
    if (persist && sessionOnly) {
      sessionOnly = false
      writeJson(SETTINGS, { ...settings(), enabled: true })
      emit()
    }
    return ingestState()
  }
  const s = settings()
  const first = s.port ?? INGEST_DEFAULT_PORT
  const srv = http.createServer((req, res) => void handleIngestRequest(req, res))
  // Frames are large and senders keep one connection open for the whole clip.
  srv.keepAliveTimeout = 60_000
  srv.requestTimeout = 0
  let bound = 0
  // The usual port, the few after it, then any free one.
  for (const candidate of [first, first + 1, first + 2, first + 3, 0]) {
    try {
      await listen(srv, candidate)
      bound = (srv.address() as { port: number }).port
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' && (err as NodeJS.ErrnoException).code !== 'EACCES') {
        lastError = err instanceof Error ? err.message : String(err)
        emit()
        return ingestState()
      }
    }
  }
  if (!bound) {
    lastError = 'No free port to listen on.'
    emit()
    return ingestState()
  }
  server = srv
  port = bound
  lastError = undefined
  sessionOnly = !persist && !s.enabled
  if (persist) writeJson(SETTINGS, { ...s, enabled: true })
  emit()
  return ingestState()
}

export async function stopIngest(persist = true): Promise<IngestState> {
  const srv = server
  server = null
  sessionOnly = false
  for (const live of clips.values()) if (live.clip.status === 'receiving' || live.clip.status === 'assembling') failClip(live.clip.id, 'Frame ingest was switched off.')
  if (srv) {
    srv.closeAllConnections?.()
    await new Promise<void>((resolve) => srv.close(() => resolve()))
  }
  if (persist) writeJson(SETTINGS, { ...settings(), enabled: false })
  emit()
  return ingestState()
}

export function regenerateIngestToken(): IngestState {
  writeJson(SETTINGS, { ...settings(), token: randomBytes(24).toString('base64url') })
  emit()
  return ingestState()
}

export function setIngestOptions(opts: { quality?: unknown; folder?: unknown }): IngestState {
  const s = settings()
  if (INGEST_QUALITIES.some((q) => q.id === opts.quality)) s.quality = opts.quality as IngestQuality
  if (opts.folder === null || opts.folder === '') delete s.folder
  else if (typeof opts.folder === 'string') s.folder = path.resolve(opts.folder)
  writeJson(SETTINGS, s)
  emit()
  return ingestState()
}

/** Lets the user choose where masters are written (they are large; another drive is common). */
export async function pickIngestFolder(win: BrowserWindow | null): Promise<IngestState> {
  const opts: Electron.OpenDialogOptions = {
    title: 'Where should received clips be saved?',
    buttonLabel: 'Save clips here',
    defaultPath: ingestState().folder,
    properties: ['openDirectory', 'createDirectory'],
  }
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  if (res.canceled || !res.filePaths[0]) return ingestState()
  return setIngestOptions({ folder: res.filePaths[0] })
}

/** Wires the receiver to the editor window; starts it if it was on last time. */
export function initIngest(win: BrowserWindow) {
  editor = win
  attached = false
  const lost = () => {
    attached = false
    for (const live of clips.values()) if (live.clip.status === 'receiving' || live.clip.status === 'assembling') failClip(live.clip.id, 'Lumen’s editor closed while this clip was arriving.')
  }
  win.webContents.on('did-start-navigation', (_e, _url, _inPlace, isMainFrame) => {
    if (isMainFrame) lost()
  })
  win.webContents.on('render-process-gone', lost)
  win.on('closed', () => {
    lost()
    if (editor === win) editor = null
  })
  if (settings().enabled) void startIngest()
}
