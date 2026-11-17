/**
 * ComfyUI, the parts both sides agree on: where it is, the workflows the user
 * keeps in Lumen, what each one lets you change and what it makes, and a run.
 *
 * ComfyUI runs on its own (usually on this computer, port 8188). The main
 * process talks to its HTTP API and websocket — only ever at the address the
 * user gave — and the editor sees the results as jobs, like any render.
 */
import type { Job } from './integrations'

export const COMFY_DEFAULT_URL = 'http://127.0.0.1:8188'

/** A graphics card (or the processor) ComfyUI runs on. */
export interface ComfyDevice {
  name: string
  /** cuda, cpu, mps, xpu… */
  type: string
  /** bytes */
  vramTotal?: number
  vramFree?: number
}

export interface ComfyStatus {
  /** The address Lumen talks to. */
  url: string
  /** An auth header is stored (encrypted): its name, and the value's last characters. */
  header?: { name: string; hint?: string }
  connected: boolean
  version?: string
  python?: string
  pytorch?: string
  devices: ComfyDevice[]
  /** Runs ComfyUI is working on and has waiting, everyone's. */
  queue?: { running: number; pending: number }
  /** Why it isn't connected, and what to do about it. */
  error?: string
  checkedAt: number
}

// ─── Workflows ───────────────────────────────────────────────────────────

/** What an input is for. */
export type ComfyInputRole = 'prompt' | 'negative' | 'text' | 'seed' | 'steps' | 'cfg' | 'denoise' | 'width' | 'height' | 'frames' | 'batch' | 'fps' | 'image' | 'video' | 'audio'

export type ComfyMediaKind = 'image' | 'video' | 'audio'

export const COMFY_MEDIA_ROLES: readonly ComfyInputRole[] = ['image', 'video', 'audio']

/** Something a workflow lets you change, found by reading its graph. */
export interface ComfyInput {
  /** Where it is: the node's id and the input's name — what an override names. */
  node: string
  input: string
  role: ComfyInputRole
  /** What to call it: "Prompt", "Negative prompt", "Seed", "Image"… */
  label: string
  /** The node's title in ComfyUI, or its type. */
  title: string
  classType: string
  /** The value saved in the workflow. */
  value: string | number | boolean | null
  min?: number
  max?: number
  step?: number
  /** Whole numbers only. */
  integer?: boolean
}

export type ComfyOutputKind = 'image' | 'video' | 'audio' | '3d' | 'text' | 'preview' | 'file'

/** A node whose results come back: a saver, a preview, a text display. */
export interface ComfyOutput {
  node: string
  classType: string
  title: string
  kind: ComfyOutputKind
}

export interface ComfyWorkflowInfo {
  id: string
  name: string
  importedAt: number
  /** The file it came from. */
  source?: string
  /** api: ComfyUI's Export (API) · png: the workflow inside an image ComfyUI saved · ui: converted from ComfyUI's own format */
  format: 'api' | 'png' | 'ui'
  nodes: number
  inputs: ComfyInput[]
  outputs: ComfyOutput[]
  /** Node types the connected ComfyUI doesn't have — custom nodes to install. Known once ComfyUI has been reached. */
  missing?: string[]
}

// ─── Runs ────────────────────────────────────────────────────────────────

/** A file in ComfyUI's input, output or temp folder. */
export interface ComfyFileRef {
  filename: string
  subfolder: string
  type: string
}

export interface ComfyOverride {
  node: string
  input: string
  value: string | number | boolean
}

/** A file from the project, already in ComfyUI's input folder, for one of the workflow's media inputs. */
export interface ComfyMediaInput {
  node: string
  input: string
  file: ComfyFileRef
  /** The stretch of its source a clip uses (seconds), for loaders that can skip to it (Video Helper Suite's). */
  trim?: { from: number; to: number; fps?: number }
}

export interface ComfyRunRequest {
  workflowId: string
  /** Text for every positive prompt in the workflow. */
  prompt?: string
  /** Text for every negative prompt. */
  negative?: string
  /** One seed for every seed input; 'random' (the default) draws a new one for each, 'keep' leaves the workflow's own. */
  seed?: number | 'random' | 'keep'
  steps?: number
  cfg?: number
  denoise?: number
  width?: number
  height?: number
  /** Any input by node id and name; these win over everything above. */
  overrides?: ComfyOverride[]
  media?: ComfyMediaInput[]
  /** Keep only what these output nodes make (default: everything saved; previews only when nothing is). */
  outputs?: string[]
  /** What to call the results in the media. */
  name?: string
}

export interface ComfyRun {
  job: Job
  /** The seed each seed input got, by "node.input". */
  seeds: Record<string, number>
  /** What was asked for but didn't apply, or was applied with a caveat. */
  notes: string[]
}

export type ComfyUploadSource =
  /** Bytes the editor made (a rendered frame). */
  | { kind: 'bytes'; data: Uint8Array; fileName: string }
  /** A media file the editor may read (its lumen-media:// URL). */
  | { kind: 'media'; url: string }

// ─── IPC ─────────────────────────────────────────────────────────────────

export const COMFY_IPC = {
  status: 'lumen:comfyui:status',
  configure: 'lumen:comfyui:configure',
  workflows: 'lumen:comfyui:workflows',
  importFile: 'lumen:comfyui:import-file',
  importJson: 'lumen:comfyui:import-json',
  rename: 'lumen:comfyui:rename',
  remove: 'lumen:comfyui:remove',
  upload: 'lumen:comfyui:upload',
  run: 'lumen:comfyui:run',
} as const

/** What the preload exposes as `window.lumen.integrations.comfyui`. */
export interface ComfyAPI {
  /** The connection: version, graphics cards, queue. Checks again when asked to, or when the last check is a few seconds old. */
  status(refresh?: boolean): Promise<ComfyStatus>
  /** Saves the address (null: the default) and/or the auth header (null removes it), then checks the connection. */
  configure(patch: { url?: string | null; header?: { name: string; value: string } | null }): Promise<ComfyStatus>
  workflows(): Promise<ComfyWorkflowInfo[]>
  /** Imports a .json workflow or a .png ComfyUI saved; without a path a file dialog asks. Null when the dialog is cancelled. */
  importFile(path?: string): Promise<ComfyWorkflowInfo | null>
  /** Imports a workflow from its JSON (API format, or ComfyUI's own format, converted). */
  importJson(json: string, name?: string): Promise<ComfyWorkflowInfo>
  rename(id: string, name: string): Promise<ComfyWorkflowInfo[]>
  remove(id: string): Promise<ComfyWorkflowInfo[]>
  /** Puts a file in ComfyUI's input folder (under lumen/) and says what a workflow calls it. */
  upload(source: ComfyUploadSource): Promise<ComfyFileRef>
  /** Queues a run and resolves once ComfyUI has accepted it — progress and the results arrive as job events. */
  run(req: ComfyRunRequest): Promise<ComfyRun>
}

/** How a workflow names a file in ComfyUI's input folder ("lumen/frame.png"). */
export const comfyInputName = (file: ComfyFileRef) => (file.subfolder ? `${file.subfolder}/${file.filename}` : file.filename)
