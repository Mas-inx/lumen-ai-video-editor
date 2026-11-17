import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { BrowserWindow, dialog } from 'electron'
import { COMFY_DEFAULT_URL, type ComfyFileRef, type ComfyRun, type ComfyRunRequest, type ComfyStatus, type ComfyUploadSource, type ComfyWorkflowInfo } from '../../../shared/comfyui'
import { isPrivateHost, type GeneratedAsset } from '../../../shared/integrations'
import { createJob, failJob, finishJob, isCancelled, updateJob } from '../jobs'
import { jobDir, mediaPath, mediaRoot, mediaUrl, readJson, writeJson } from '../paths'
import { getSecret, secretHint, setSecret } from '../secrets'
import { ComfyClient, ComfyError, type ComfyMessage, type ComfySocket } from './client'
import { removeStored, renameStored, saveStored, storedWorkflow, storedWorkflows, type Stored } from './library'
import { analyze, applyRun, checkPrompt, collectOutputs, ConvertError, EXPORT_HELP, fileKind, imageInfo, outcome, parseWorkflow, pngText, RunProgress, uiToApi, type ApiPrompt, type HistoryEntry, type NodeDef, type NodeDefs } from './workflow'

/**
 * ComfyUI, natively: the user's own ComfyUI — on this computer or their
 * network — runs the workflows they keep in Lumen, on their own graphics card.
 * Lumen uploads the project's footage as inputs, follows each run over the
 * websocket and downloads everything it saves into the media library. It
 * talks only to the address the user set, with their auth header (kept
 * encrypted) when there is one; nothing else is contacted.
 */

const SETTINGS = 'comfyui.json'
const HEADER_SECRET = 'comfyui-header'

interface Settings {
  url?: string
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))
const list = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`)

// ─── Where it is ─────────────────────────────────────────────────────────

const baseUrl = () => readJson<Settings>(SETTINGS, {}).url ?? COMFY_DEFAULT_URL

/** This computer, the local network or a VPN may use plain http; anywhere else needs https. */
function localHost(hostname: string) {
  if (isPrivateHost(hostname)) return true
  if (hostname.startsWith('[')) return /^\[(f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):/i.test(hostname)
  return !hostname.includes('.') || /\.(lan|home|internal|home\.arpa|localdomain)$/i.test(hostname)
}

/** The address as Lumen keeps it: http(s), no credentials, query or trailing slash (a path is fine, for ComfyUI behind a proxy). */
export function normalizeUrl(input: string): string {
  let text = input.trim()
  if (!text) return COMFY_DEFAULT_URL
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new Error(`“${input.trim()}” isn’t an address. ComfyUI’s is usually ${COMFY_DEFAULT_URL}.`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('ComfyUI’s address starts with http:// or https://.')
  if (url.username || url.password) throw new Error('Leave the user name and password out of the address — put them in the auth header instead (Authorization: Basic …).')
  if (url.protocol === 'http:' && !localHost(url.hostname)) throw new Error(`Plain http only works for ComfyUI on this computer or your local network. For ${url.hostname}, use its https:// address.`)
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

const RESERVED_HEADERS = /^(host|content-length|content-type|transfer-encoding|connection|upgrade|origin|sec-websocket-.*)$/i

function checkHeader(h: { name: string; value: string }) {
  const name = String(h.name ?? '').trim()
  const value = String(h.value ?? '').trim()
  if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(name)) throw new Error('That isn’t a header name — it’s usually Authorization.')
  if (RESERVED_HEADERS.test(name)) throw new Error(`Lumen sets ${name} itself; ComfyUI’s login header is usually Authorization.`)
  if (!value || /[\r\n]/.test(value) || value.length > 8192) throw new Error('The header needs a value, on one line.')
  return { name, value }
}

function storedHeader(): { name: string; value: string } | null {
  try {
    const h = JSON.parse(getSecret(HEADER_SECRET) ?? 'null') as { name?: unknown; value?: unknown } | null
    return h && typeof h.name === 'string' && typeof h.value === 'string' ? { name: h.name, value: h.value } : null
  } catch {
    return null
  }
}

function client() {
  const h = storedHeader()
  return new ComfyClient(baseUrl(), h ? { [h.name]: h.value } : {})
}

// ─── Node definitions ────────────────────────────────────────────────────

const DEFS_TTL = 10 * 60_000
const defCache = new Map<string, { at: number; def: NodeDef | null }>()
const defKey = (base: string, type: string) => `${base}\n${type}`
const typesOf = (prompt: ApiPrompt) => [...new Set(Object.values(prompt).map((n) => n.class_type))]

/** What's known about these node types from earlier asks, without asking again. */
function cachedDefs(base: string, types: string[]): NodeDefs {
  const out: NodeDefs = {}
  for (const t of types) {
    const hit = defCache.get(defKey(base, t))
    if (hit) out[t] = hit.def
  }
  return out
}

/** Asks ComfyUI about the types it hasn't described lately. Ones it didn't have are asked again: they may have been installed since. */
async function fetchDefs(c: ComfyClient, types: string[]): Promise<NodeDefs> {
  const now = Date.now()
  const want = types.filter((t) => {
    const hit = defCache.get(defKey(c.base, t))
    return !hit?.def || now - hit.at > DEFS_TTL
  })
  for (let i = 0; i < want.length; i += 8) {
    await Promise.all(
      want.slice(i, i + 8).map(async (t) => {
        const def = await c.nodeDef(t)
        if (def !== undefined) defCache.set(defKey(c.base, t), { at: Date.now(), def })
      }),
    )
  }
  return cachedDefs(c.base, types)
}

// ─── Status ──────────────────────────────────────────────────────────────

let last: ComfyStatus | null = null

const deviceName = (name: string) =>
  name
    .replace(/^[a-z]+:\d+\s+/i, '')
    .replace(/\s*:\s*(cudaMallocAsync|native)$/i, '')
    .trim() || name

const bytes = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined)

export async function comfyStatus(refresh = false): Promise<ComfyStatus> {
  const url = baseUrl()
  if (!refresh && last?.url === url && Date.now() - last.checkedAt < 5000) return last
  const h = storedHeader()
  const header = h ? { header: { name: h.name, hint: secretHint(h.value) } } : {}
  const c = client()
  try {
    const stats = await c.systemStats()
    if (!stats || typeof stats !== 'object' || (!stats.system && !stats.devices)) throw new ComfyError(`Something answered at ${url}, but it isn’t ComfyUI.`)
    const queue = await c.queue().catch(() => null)
    // The node types the library's workflows use: listed next, their inputs and missing nodes are known.
    await fetchDefs(c, [...new Set(storedWorkflows().flatMap((w) => typesOf(w.prompt)))]).catch(() => {})
    last = {
      url,
      ...header,
      connected: true,
      ...(stats.system?.comfyui_version ? { version: stats.system.comfyui_version } : {}),
      ...(stats.system?.python_version ? { python: stats.system.python_version.split(' ')[0] } : {}),
      ...(stats.system?.pytorch_version ? { pytorch: stats.system.pytorch_version } : {}),
      devices: (Array.isArray(stats.devices) ? stats.devices : []).map((d) => ({ name: deviceName(String(d.name ?? d.type ?? 'Device')), type: String(d.type ?? ''), vramTotal: bytes(d.vram_total), vramFree: bytes(d.vram_free) })),
      ...(queue ? { queue: { running: queue.queue_running?.length ?? 0, pending: queue.queue_pending?.length ?? 0 } } : {}),
      checkedAt: Date.now(),
    }
  } catch (err) {
    last = { url, ...header, connected: false, devices: [], error: message(err), checkedAt: Date.now() }
  }
  return last
}

export async function configureComfy(patch: { url?: string | null; header?: { name: string; value: string } | null }): Promise<ComfyStatus> {
  // Both are checked before either is kept.
  const url = patch.url === undefined ? undefined : patch.url === null ? COMFY_DEFAULT_URL : normalizeUrl(patch.url)
  const header = patch.header ? checkHeader(patch.header) : patch.header
  if (url !== undefined) writeJson(SETTINGS, { ...readJson<Settings>(SETTINGS, {}), url: url === COMFY_DEFAULT_URL ? undefined : url })
  if (header !== undefined) setSecret(HEADER_SECRET, header ? JSON.stringify(header) : null)
  return comfyStatus(true)
}

// ─── The library ─────────────────────────────────────────────────────────

function info(w: Stored, defs: NodeDefs): ComfyWorkflowInfo {
  const a = analyze(w.prompt, defs)
  return {
    id: w.id,
    name: w.name,
    importedAt: w.importedAt,
    ...(w.source ? { source: w.source } : {}),
    format: w.format,
    nodes: Object.keys(w.prompt).length,
    inputs: a.inputs,
    outputs: a.outputs,
    ...(a.missing.length ? { missing: a.missing } : {}),
  }
}

export const listWorkflows = (): ComfyWorkflowInfo[] => storedWorkflows().map((w) => info(w, cachedDefs(baseUrl(), typesOf(w.prompt))))

const MAX_IMPORT = 32 * 1024 * 1024

/** A workflow from a file: JSON (either format), or a PNG ComfyUI saved — it carries the run's prompt. Without a path, a dialog asks. */
export async function importWorkflowFile(file?: string): Promise<ComfyWorkflowInfo | null> {
  if (!file) {
    const win = BrowserWindow.getFocusedWindow()
    const opts: Electron.OpenDialogOptions = { title: 'Import a ComfyUI workflow', buttonLabel: 'Import', properties: ['openFile'], filters: [{ name: 'ComfyUI workflows', extensions: ['json', 'png'] }] }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || !res.filePaths[0]) return null
    file = res.filePaths[0]
  }
  const ext = path.extname(file).toLowerCase()
  if (ext !== '.json' && ext !== '.png') throw new Error('Import a workflow saved as .json (Export (API) in ComfyUI), or a .png that ComfyUI saved.')
  let stat: fs.Stats
  try {
    stat = fs.statSync(file)
  } catch {
    throw new Error(`There’s no file at ${file}.`)
  }
  if (!stat.isFile()) throw new Error(`${file} isn’t a file.`)
  if (stat.size > MAX_IMPORT) throw new Error('That file is over 32 MB — too large to be a workflow.')
  const data = fs.readFileSync(file)
  const name = path.basename(file, path.extname(file))
  if (ext === '.png') {
    const text = pngText(data)
    if (text.prompt) return importText(text.prompt, name, path.basename(file), 'png')
    if (text.workflow) return importText(text.workflow, name, path.basename(file), 'png')
    throw new Error('That image doesn’t carry a ComfyUI workflow. ComfyUI keeps one in the PNGs it saves (unless it runs with --disable-metadata).')
  }
  return importText(data.toString('utf8'), name, path.basename(file))
}

export const importWorkflowJson = (json: string, name?: string) => importText(json, name?.trim() || 'Workflow')

async function importText(text: string, name: string, source?: string, from?: 'png'): Promise<ComfyWorkflowInfo> {
  const read = parseWorkflow(text)
  let prompt: ApiPrompt
  let format: Stored['format'] = from ?? 'api'
  let defs: NodeDefs = {}
  if (read.kind === 'api') prompt = read.prompt
  else {
    const types = [...new Set(read.graph.nodes.map((n) => n?.type).filter((t): t is string => typeof t === 'string'))]
    try {
      defs = await fetchDefs(client(), types)
    } catch (err) {
      throw new Error(`This is ComfyUI’s own workflow format, which Lumen converts using your ComfyUI’s node definitions — and ComfyUI can’t be reached right now (${message(err)}). Start it and import again, or import the API version instead. ${EXPORT_HELP}`)
    }
    try {
      prompt = uiToApi(read.graph, defs)
    } catch (err) {
      if (err instanceof ConvertError) throw new Error(`Lumen can’t convert this workflow exactly: ${err.message}. ${EXPORT_HELP}`)
      throw err
    }
    format = from ?? 'ui'
  }
  checkPrompt(prompt)
  const stored = saveStored({ name, source, format, prompt })
  return info(stored, { ...cachedDefs(baseUrl(), typesOf(stored.prompt)), ...defs })
}

export function renameWorkflow(id: string, name: string) {
  renameStored(id, name)
  return listWorkflows()
}

export function removeWorkflow(id: string) {
  removeStored(id)
  return listWorkflows()
}

// ─── Inputs ──────────────────────────────────────────────────────────────

const UPLOADABLE = /^\.(png|jpe?g|webp|gif|bmp|mp4|m4v|mov|webm|mkv|avi|wav|mp3|flac|ogg|opus|m4a|aac)$/

/** A file for ComfyUI's input folder, named for its content (so sending the same thing twice reuses it). Only project media and what the editor rendered can be sent. */
export async function uploadToComfy(source: ComfyUploadSource): Promise<ComfyFileRef> {
  let blob: Blob
  let name: string
  if (source.kind === 'bytes') {
    const ext = path.extname(source.fileName).toLowerCase() || '.png'
    if (!UPLOADABLE.test(ext)) throw new Error(`ComfyUI’s loaders can’t take ${ext} files.`)
    name = `lumen_${createHash('sha1').update(source.data).digest('hex').slice(0, 16)}${ext}`
    blob = new Blob([new Uint8Array(source.data)])
  } else {
    const abs = mediaPath(source.url)
    if (!abs) throw new Error('Lumen only sends ComfyUI files from the project’s media.')
    let stat: fs.Stats
    try {
      stat = fs.statSync(abs)
    } catch {
      throw new Error(`${path.basename(abs)} isn’t on disk any more.`)
    }
    const ext = path.extname(abs).toLowerCase()
    if (!UPLOADABLE.test(ext)) throw new Error(`ComfyUI’s loaders can’t take ${ext || 'these'} files.`)
    name = `lumen_${createHash('sha1').update(`${abs}|${stat.size}|${stat.mtimeMs}`).digest('hex').slice(0, 16)}${ext}`
    blob = await fs.openAsBlob(abs)
  }
  return client().upload(blob, name, 'lumen')
}

// ─── Runs ────────────────────────────────────────────────────────────────

/** What Lumen can play, by extension (as its importer takes them). */
const PLAYABLE: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
}

/** Results that aren't media but are worth keeping: 3D models (for Blender, say) and data. Anything else a run lists stays in ComfyUI. */
const KEPT = /\.(json|txt|csv|srt|vtt|latent|npz)$/i

interface Run {
  jobId: string
  promptId: string
  client: ComfyClient
  socket: ComfySocket | null
  signal: AbortSignal
  workflow: Stored
  req: ComfyRunRequest
  prompt: ApiPrompt
  seeds: Record<string, number>
}

const words = (text: string | undefined, n = 5) => (text ?? '').replace(/[^\p{L}\p{N}\s'-]/gu, ' ').split(/\s+/).filter(Boolean).slice(0, n).join(' ')

const runTitle = (workflow: string, prompt?: string) => (words(prompt) ? `${workflow} · ${words(prompt)}` : workflow)

/**
 * Starts a run of a library workflow and answers once ComfyUI has queued it
 * (so a workflow ComfyUI won't take fails at once, saying why); the job then
 * follows it to the end and brings its files into the media library.
 */
export async function runComfyWorkflow(req: ComfyRunRequest): Promise<ComfyRun> {
  const workflow = storedWorkflow(req.workflowId)
  if (!workflow) {
    const all = storedWorkflows()
    throw new Error(all.length ? `There’s no workflow “${req.workflowId}” in Lumen’s ComfyUI library. It has: ${all.map((w) => `${w.id} (${w.name})`).join(', ')}.` : 'Lumen’s ComfyUI library is empty — import a workflow in Integrations › ComfyUI first.')
  }
  const c = client()
  const defs = await fetchDefs(c, typesOf(workflow.prompt))
  const analysis = analyze(workflow.prompt, defs)
  if (analysis.missing.length) throw new Error(`Your ComfyUI doesn’t have ${list(analysis.missing)}: custom nodes this workflow needs. Install them (ComfyUI-Manager finds missing nodes), restart ComfyUI and run it again.`)
  const applied = applyRun(workflow.prompt, req, analysis, defs)

  // Listen before queueing: a run that is all cached is over within milliseconds.
  const clientId = randomUUID()
  const early: ComfyMessage[] = []
  let listener: ((m: ComfyMessage) => void) | null = null
  const socket = await c.watch(clientId, (m) => (listener ? listener(m) : early.push(m)))
  let submitted: { id: string; warnings: string[] }
  try {
    submitted = await c.submit(applied.prompt, clientId)
  } catch (err) {
    socket?.close()
    throw err
  }

  const controller = new AbortController()
  const job = createJob('comfyui', runTitle(workflow.name, req.prompt), () => {
    controller.abort()
    socket?.close()
    void stopRun(c, submitted.id)
  })
  const run: Run = { jobId: job.id, promptId: submitted.id, client: c, socket, signal: controller.signal, workflow, req, prompt: applied.prompt, seeds: applied.seeds }
  const listen = (fn: (m: ComfyMessage) => void) => {
    listener = fn
    for (const m of early.splice(0)) fn(m)
  }
  void follow(run, listen)
    .catch((err) => {
      if (!isCancelled(job.id)) failJob(job.id, err)
    })
    .finally(() => {
      socket?.close()
      if (isCancelled(job.id)) fs.rmSync(path.join(mediaRoot(), 'comfyui', job.id), { recursive: true, force: true })
    })
  return { job, seeds: applied.seeds, notes: [...applied.notes, ...submitted.warnings] }
}

/** Interrupts the run if it is the one executing, or takes it out of the queue if it hasn't started — never someone else's. */
async function stopRun(c: ComfyClient, promptId: string) {
  try {
    const q = await c.queue()
    if (q.queue_running?.some((item) => item[1] === promptId)) await c.interrupt(promptId)
    else if (q.queue_pending?.some((item) => item[1] === promptId)) await c.dequeue(promptId)
  } catch {
    /* ComfyUI is gone: there's nothing left to stop */
  }
}

/** Progress from the websocket; the end from the run's history entry (polled, and at once when the websocket says it's over). */
async function follow(run: Run, listen: (fn: (m: ComfyMessage) => void) => void) {
  const progress = new RunProgress(run.prompt)
  let started = false
  let soon = 0
  let wake: (() => void) | null = null
  updateJob(run.jobId, { message: 'Queued in ComfyUI…' })
  listen((m) => {
    if (m.type === 'status') {
      const queued = Number((m.data.status as { exec_info?: { queue_remaining?: unknown } } | undefined)?.exec_info?.queue_remaining)
      if (!started && queued > 0) updateJob(run.jobId, { message: `Waiting in ComfyUI’s queue (${queued} queued)` })
      return
    }
    if (m.data.prompt_id !== undefined && m.data.prompt_id !== run.promptId) return
    const shown = progress.take(m.type, m.data)
    if (shown) {
      started = true
      updateJob(run.jobId, shown)
    }
    if (m.type === 'execution_success' || m.type === 'execution_error' || m.type === 'execution_interrupted' || (m.type === 'executing' && m.data.node == null)) {
      // ComfyUI writes the history entry just after saying so.
      soon = 24
      wake?.()
    }
  })

  let failures = 0
  let lost = 0
  for (let poll = 1; ; poll++) {
    let wait = run.socket?.isOpen() ? 4000 : 1500
    if (soon > 0) {
      soon--
      wait = 250
    }
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        wake = null
        run.signal.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, wait)
      wake = done
      run.signal.addEventListener('abort', done)
    })
    if (run.signal.aborted || isCancelled(run.jobId)) return
    let entry: HistoryEntry | undefined
    try {
      entry = await run.client.history(run.promptId)
      failures = 0
    } catch (err) {
      if (++failures >= 20) throw new Error(`ComfyUI stopped answering during the run: ${message(err)}`)
      continue
    }
    const result = outcome(entry)
    if (result.done && entry) {
      if (result.ok) return deliver(run, entry)
      if (result.interrupted && isCancelled(run.jobId)) return
      throw new Error(result.error)
    }
    // A run ComfyUI no longer has (it restarted) would never finish.
    if (!soon && poll % 8 === 0) {
      const q = await run.client.queue().catch(() => null)
      const queued = q && [...(q.queue_running ?? []), ...(q.queue_pending ?? [])].some((item) => item[1] === run.promptId)
      lost = q && !queued ? lost + 1 : 0
      if (lost >= 2) throw new Error('ComfyUI no longer has this run — it may have restarted. Run the workflow again.')
    }
  }
}

/** A file name in the job's folder that's free (ComfyUI's own names are kept, minus anything that isn't a plain name). */
function freePath(dir: string, filename: string) {
  const ext = path.extname(filename)
  const base = path.basename(filename, ext).replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_').slice(0, 80) || 'result'
  const safeExt = ext.replace(/[^.a-z0-9]/gi, '')
  let abs = path.join(dir, `${base}${safeExt}`)
  for (let n = 2; fs.existsSync(abs); n++) abs = path.join(dir, `${base} (${n})${safeExt}`)
  return abs
}

function readHead(abs: string, size = 1 << 16) {
  const fd = fs.openSync(abs, 'r')
  try {
    const buf = Buffer.alloc(size)
    return buf.subarray(0, fs.readSync(fd, buf, 0, size, 0))
  } finally {
    fs.closeSync(fd)
  }
}

function generated(run: Run, abs: string, mime: string, name: string): GeneratedAsset {
  const kind = mime.split('/')[0] as GeneratedAsset['kind']
  const head = kind === 'image' ? imageInfo(readHead(abs)) : null
  const { negative, steps, cfg, denoise, width, height, overrides } = run.req
  const params = Object.fromEntries(Object.entries({ workflow: run.workflow.id, seeds: Object.keys(run.seeds).length ? run.seeds : undefined, negative, steps, cfg, denoise, width, height, overrides: overrides?.length ? overrides : undefined }).filter(([, v]) => v !== undefined))
  return {
    name,
    kind,
    source: { type: 'file', url: mediaUrl(abs), path: abs, mime, fileName: path.basename(abs), size: fs.statSync(abs).size },
    ...(head ? { width: head.width, height: head.height } : {}),
    ...(head?.alpha ? { alpha: true } : {}),
    provenance: { integration: 'comfyui', tool: run.workflow.name, ...(run.req.prompt ? { prompt: run.req.prompt } : {}), params },
  }
}

function summary(assets: GeneratedAsset[], files: { name: string }[], texts: number) {
  const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
  const parts: string[] = []
  for (const [kind, one] of [['image', 'image'], ['video', 'video'], ['audio', 'sound']] as const) {
    const n = assets.filter((a) => a.kind === kind).length
    if (n) parts.push(count(n, one))
  }
  const models = files.filter((f) => fileKind(f.name) === '3d').length
  if (models) parts.push(count(models, '3D model'))
  if (files.length > models) parts.push(count(files.length - models, 'file'))
  if (texts) parts.push(count(texts, 'text output'))
  return parts.join(' · ') || 'Finished — it saved nothing Lumen can bring in.'
}

async function deliver(run: Run, entry: HistoryEntry) {
  const { files, texts } = collectOutputs(entry, run.req.outputs)
  const wanted = files.filter((f) => PLAYABLE[path.extname(f.filename).toLowerCase()] || f.kind === '3d' || KEPT.test(f.filename))
  const dir = jobDir('comfyui', run.jobId)
  const name = run.req.name?.trim().slice(0, 80) || (words(run.req.prompt) ? `${run.workflow.name} — ${words(run.req.prompt)}` : run.workflow.name)
  const many = wanted.filter((f) => PLAYABLE[path.extname(f.filename).toLowerCase()]).length > 1
  const assets: GeneratedAsset[] = []
  const kept: { name: string; path: string }[] = []
  for (const [i, file] of wanted.entries()) {
    if (run.signal.aborted) return
    updateJob(run.jobId, { progress: 0.99, message: wanted.length > 1 ? `Downloading ${i + 1} of ${wanted.length}…` : 'Downloading…' })
    const dest = freePath(dir, file.filename)
    await run.client.download(file, dest, run.signal)
    const mime = PLAYABLE[path.extname(dest).toLowerCase()]
    if (mime) assets.push(generated(run, dest, mime, many ? `${name} ${assets.length + 1}` : name))
    else kept.push({ name: path.basename(dest), path: dest })
  }
  if (run.signal.aborted || isCancelled(run.jobId)) return
  finishJob(run.jobId, {
    assets,
    ...(kept.length ? { files: kept } : {}),
    ...(texts.length ? { result: { isError: false, text: texts.map((t) => t.text), media: [], links: [] } } : {}),
    message: summary(assets, kept, texts.length),
  })
}
