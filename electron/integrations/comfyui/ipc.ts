import { COMFY_IPC, type ComfyMediaInput, type ComfyOverride, type ComfyRunRequest, type ComfyUploadSource } from '../../../shared/comfyui'
import { comfyStatus, configureComfy, importWorkflowFile, importWorkflowJson, listWorkflows, removeWorkflow, renameWorkflow, runComfyWorkflow, uploadToComfy } from './index'

type Handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => R) => void

type Loose = Record<string, unknown>

const obj = (v: unknown): Loose => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Loose) : {})
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined)
const finite = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const value = (v: unknown) => (typeof v === 'string' ? v.slice(0, 100_000) : typeof v === 'boolean' ? v : finite(v))

function cleanRun(input: unknown): ComfyRunRequest {
  const r = obj(input)
  const workflowId = str(r.workflowId, 64)
  if (!workflowId) throw new Error('Say which workflow to run.')
  const overrides = (Array.isArray(r.overrides) ? r.overrides : []).slice(0, 200).flatMap((o): ComfyOverride[] => {
    const x = obj(o)
    const node = str(x.node, 64)
    const input = str(x.input, 128)
    const v = value(x.value)
    return node && input && v !== undefined ? [{ node, input, value: v }] : []
  })
  const media = (Array.isArray(r.media) ? r.media : []).slice(0, 16).flatMap((m): ComfyMediaInput[] => {
    const x = obj(m)
    const file = obj(x.file)
    const node = str(x.node, 64)
    const input = str(x.input, 128)
    const filename = str(file.filename, 255)
    if (!node || !input || !filename) return []
    const trim = obj(x.trim)
    const from = finite(trim.from)
    const to = finite(trim.to)
    return [{ node, input, file: { filename, subfolder: str(file.subfolder, 255) ?? '', type: str(file.type, 16) ?? 'input' }, ...(from !== undefined && to !== undefined && to > from ? { trim: { from, to, fps: finite(trim.fps) } } : {}) }]
  })
  const seed = r.seed === 'random' || r.seed === 'keep' ? r.seed : finite(r.seed)
  const text = (v: unknown) => str(v, 20_000)
  return {
    workflowId,
    prompt: text(r.prompt),
    negative: text(r.negative),
    seed,
    steps: finite(r.steps),
    cfg: finite(r.cfg),
    denoise: finite(r.denoise),
    width: finite(r.width),
    height: finite(r.height),
    overrides,
    media,
    outputs: (Array.isArray(r.outputs) ? r.outputs : []).slice(0, 64).map((v) => str(v, 64)).filter((v): v is string => Boolean(v)),
    name: str(r.name, 120),
  }
}

function cleanUpload(input: unknown): ComfyUploadSource {
  const s = obj(input)
  if (s.kind === 'bytes' && s.data instanceof Uint8Array && s.data.byteLength <= 512 * 1024 * 1024) return { kind: 'bytes', data: s.data, fileName: str(s.fileName, 120) || 'frame.png' }
  if (s.kind === 'media' && typeof s.url === 'string') return { kind: 'media', url: s.url.slice(0, 4096) }
  throw new Error('Send ComfyUI a rendered picture or a file from the project.')
}

/** ComfyUI's IPC, checked like the rest: only plain values of sane sizes reach the main process. */
export function registerComfyIpc(handle: Handle) {
  handle(COMFY_IPC.status, (refresh?: boolean) => comfyStatus(refresh === true))
  handle(COMFY_IPC.configure, (patch: unknown) => {
    const p = obj(patch)
    const header = p.header === null ? null : p.header === undefined ? undefined : { name: str(obj(p.header).name, 64) ?? '', value: str(obj(p.header).value, 8192) ?? '' }
    return configureComfy({ url: p.url === null ? null : str(p.url, 2048), header })
  })
  handle(COMFY_IPC.workflows, () => listWorkflows())
  handle(COMFY_IPC.importFile, (file?: string) => importWorkflowFile(typeof file === 'string' && file ? file : undefined))
  handle(COMFY_IPC.importJson, (json: string, name?: string) => {
    if (typeof json !== 'string' || !json.trim()) throw new Error('Paste the workflow’s JSON.')
    if (json.length > 32 * 1024 * 1024) throw new Error('That is too large to be a workflow.')
    return importWorkflowJson(json, str(name, 120))
  })
  handle(COMFY_IPC.rename, (id: string, name: string) => renameWorkflow(String(id), String(name ?? '')))
  handle(COMFY_IPC.remove, (id: string) => removeWorkflow(String(id)))
  handle(COMFY_IPC.upload, (source: unknown) => uploadToComfy(cleanUpload(source)))
  handle(COMFY_IPC.run, (req: unknown) => runComfyWorkflow(cleanRun(req)))
}
