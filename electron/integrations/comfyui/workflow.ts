import { inflateSync } from 'node:zlib'
import { comfyInputName, type ComfyFileRef, type ComfyInput, type ComfyInputRole, type ComfyMediaKind, type ComfyOutput, type ComfyOutputKind, type ComfyRunRequest } from '../../../shared/comfyui'

/**
 * ComfyUI workflows as data: reading one (the API format ComfyUI's Export (API)
 * writes, the prompt inside a PNG ComfyUI saved, or ComfyUI's own format,
 * converted with the node definitions of the ComfyUI it will run on), finding
 * what it lets you change and what it makes, applying a run's values,
 * following a run's progress and collecting the files it left. No network and
 * no disk: the client and the tests feed it plain JSON.
 */

export interface ApiNode {
  class_type: string
  inputs: Record<string, unknown>
  _meta?: { title?: string }
}

/** The API format: node id → node. A wired input is [source node id, output slot]. */
export type ApiPrompt = Record<string, ApiNode>
export type Wire = [string, number]

/** An input as ComfyUI's /object_info describes it: [type, or the list of choices; options]. */
export type InputSpec = [unknown, Record<string, unknown>?]

export interface NodeDef {
  input?: { required?: Record<string, InputSpec>; optional?: Record<string, InputSpec> }
  input_order?: { required?: string[]; optional?: string[] }
  output?: unknown[]
  output_node?: boolean
  display_name?: string
}

/** Node definitions by type: null when ComfyUI doesn't have the type; absent when it couldn't be asked. */
export type NodeDefs = Record<string, NodeDef | null>

export const isWire = (v: unknown): v is Wire => Array.isArray(v) && v.length === 2 && (typeof v[0] === 'string' || typeof v[0] === 'number') && typeof v[1] === 'number'

/** How to get a workflow out of ComfyUI in the API format, for when one can't be read or converted. */
export const EXPORT_HELP =
  'In ComfyUI, open the workflow and use Export (API) — in the Workflow menu (File in some versions); in the classic interface, turn on Dev mode in the settings and click Save (API Format). Then import the .json file it saves.'

const list = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`)

function shortList(items: unknown[], max = 12) {
  const shown = items.slice(0, max).map(String).join(', ')
  return items.length > max ? `${shown}, … (${items.length} in all)` : shown
}

export function titleOf(prompt: ApiPrompt, id: string, defs?: NodeDefs) {
  const node = prompt[id]
  if (!node) return id
  return node._meta?.title || defs?.[node.class_type]?.display_name || node.class_type
}

const nodeList = (prompt: ApiPrompt, defs?: NodeDefs) => shortList(Object.keys(prompt).map((id) => `${id} (${titleOf(prompt, id, defs)})`), 30)

// ─── Reading ─────────────────────────────────────────────────────────────

export type ReadWorkflow = { kind: 'api'; prompt: ApiPrompt } | { kind: 'ui'; graph: UiGraph }

/** A workflow from its JSON: the API format, ComfyUI's own format (to convert), or a POST /prompt body. */
export function parseWorkflow(text: string): ReadWorkflow {
  let json: unknown
  try {
    json = JSON.parse(text.replace(/^﻿/, ''))
  } catch {
    throw new Error('That isn’t a ComfyUI workflow: it isn’t JSON.')
  }
  return readWorkflow(json)
}

export function readWorkflow(json: unknown, depth = 0): ReadWorkflow {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('That isn’t a ComfyUI workflow.')
  const o = json as Record<string, unknown>
  if (Array.isArray(o.nodes)) return { kind: 'ui', graph: o as unknown as UiGraph }
  // What some tools save: the body of a POST /prompt.
  if (depth === 0 && o.prompt && typeof o.prompt === 'object' && !Array.isArray(o.prompt)) return readWorkflow(o.prompt, 1)
  const prompt = apiPrompt(o)
  if (!prompt) throw new Error('That JSON isn’t a ComfyUI workflow: it has neither ComfyUI’s nodes nor an API-format prompt.')
  return { kind: 'api', prompt }
}

function apiPrompt(o: Record<string, unknown>): ApiPrompt | null {
  const entries = Object.entries(o)
  if (!entries.length) return null
  const out: ApiPrompt = {}
  for (const [id, value] of entries) {
    const n = value as Partial<ApiNode> | null
    if (!n || typeof n !== 'object' || typeof n.class_type !== 'string' || !n.inputs || typeof n.inputs !== 'object' || Array.isArray(n.inputs)) return null
    const inputs: Record<string, unknown> = {}
    for (const [name, v] of Object.entries(n.inputs)) inputs[name] = isWire(v) ? [String(v[0]), v[1]] : v
    out[String(id)] = { class_type: n.class_type, inputs, ...(typeof n._meta?.title === 'string' ? { _meta: { title: n._meta.title } } : {}) }
  }
  return out
}

/** A wire to a node that isn't there makes ComfyUI refuse the whole workflow: say so when it is imported. */
export function checkPrompt(prompt: ApiPrompt) {
  for (const [id, node] of Object.entries(prompt)) {
    for (const [name, v] of Object.entries(node.inputs)) {
      if (isWire(v) && !prompt[String(v[0])]) throw new Error(`The input “${name}” of node ${id} (${titleOf(prompt, id)}) is wired to node ${v[0]}, which isn’t in the workflow.`)
    }
  }
}

// ─── PNG and WebP ────────────────────────────────────────────────────────

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]
const isPng = (b: Uint8Array) => b.length > 8 && PNG_SIGNATURE.every((v, i) => b[i] === v)

function* pngChunks(b: Uint8Array) {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
  let at = 8
  while (at + 8 <= b.length) {
    const length = view.getUint32(at)
    const type = String.fromCharCode(b[at + 4], b[at + 5], b[at + 6], b[at + 7])
    const start = at + 8
    if (start + length > b.length) return
    yield { type, data: b.subarray(start, start + length) }
    if (type === 'IEND') return
    at = start + length + 4
  }
}

/** The text a PNG carries. ComfyUI keeps the API prompt under "prompt" and its own format under "workflow". */
export function pngText(b: Uint8Array): Record<string, string> {
  if (!isPng(b)) return {}
  const latin1 = new TextDecoder('latin1')
  const utf8 = new TextDecoder()
  const out: Record<string, string> = {}
  for (const { type, data } of pngChunks(b)) {
    if (type !== 'tEXt' && type !== 'zTXt' && type !== 'iTXt') continue
    const nul = data.indexOf(0)
    if (nul <= 0) continue
    const key = latin1.decode(data.subarray(0, nul))
    try {
      if (type === 'tEXt') out[key] = latin1.decode(data.subarray(nul + 1))
      else if (type === 'zTXt') out[key] = latin1.decode(inflateSync(data.subarray(nul + 2)))
      else {
        // iTXt: keyword, compressed?, method, language, translated keyword, text
        const compressed = data[nul + 1] === 1
        const language = data.indexOf(0, nul + 3)
        const translated = language < 0 ? -1 : data.indexOf(0, language + 1)
        if (translated < 0) continue
        const body = data.subarray(translated + 1)
        out[key] = utf8.decode(compressed ? inflateSync(body) : body)
      }
    } catch {
      /* a damaged chunk: skip it */
    }
  }
  return out
}

/** Size and transparency from an image's header — PNG and WebP, what ComfyUI saves. */
export function imageInfo(b: Uint8Array): { width: number; height: number; alpha: boolean } | null {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
  if (isPng(b) && b.length >= 33) {
    const colorType = b[25]
    let alpha = colorType === 4 || colorType === 6
    if (!alpha) {
      for (const chunk of pngChunks(b)) {
        if (chunk.type === 'tRNS') alpha = true
        if (chunk.type === 'tRNS' || chunk.type === 'IDAT') break
      }
    }
    return { width: view.getUint32(16), height: view.getUint32(20), alpha }
  }
  const tag = (at: number) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3])
  if (b.length >= 30 && tag(0) === 'RIFF' && tag(8) === 'WEBP') {
    const chunk = tag(12)
    if (chunk === 'VP8X') return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)), alpha: Boolean(b[20] & 0x10) }
    if (chunk === 'VP8L' && b[20] === 0x2f) {
      const bits = view.getUint32(21, true)
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff), alpha: Boolean((bits >>> 28) & 1) }
    }
    if (chunk === 'VP8 ') return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff, alpha: false }
  }
  return null
}

// ─── ComfyUI's own format ────────────────────────────────────────────────

interface UiInput {
  name: string
  type?: unknown
  link?: number | null
  widget?: { name?: string }
}

interface UiNode {
  id: number | string
  type: string
  mode?: number
  title?: string
  inputs?: UiInput[]
  outputs?: { name?: string; type?: unknown }[]
  widgets_values?: unknown
}

type UiLink = unknown[] | { id?: unknown; origin_id?: unknown; origin_slot?: unknown }

export interface UiGraph {
  nodes: UiNode[]
  links?: UiLink[]
  definitions?: { subgraphs?: unknown[] }
}

export class ConvertError extends Error {}

/** Nodes that exist only in ComfyUI's page — wiring helpers and notes — and never reach the server. */
const PAGE_ONLY = new Set(['Reroute', 'PrimitiveNode', 'Note', 'MarkdownNote'])
const MODE_MUTED = 2
const MODE_BYPASS = 4

type WidgetType = 'INT' | 'FLOAT' | 'STRING' | 'BOOLEAN' | 'COMBO'
type WidgetSlot = { kind: 'value'; name: string; type: WidgetType } | { kind: 'control' } | { kind: 'filter' } | { kind: 'upload' }

/** Whether ComfyUI's page draws an input as a widget (a value saved in the node), and which kind. */
function widgetType(spec: InputSpec | undefined): WidgetType | null {
  if (!Array.isArray(spec)) return null
  const [type, opts] = spec
  if (opts?.forceInput) return null
  if (Array.isArray(type)) return 'COMBO'
  return type === 'INT' || type === 'FLOAT' || type === 'STRING' || type === 'BOOLEAN' || type === 'COMBO' ? type : null
}

/** The page adds a "control after generate" widget after seeds (and anything that asks for one); choices get a filter too. */
function hasControl(name: string, spec: InputSpec, type: WidgetType) {
  const asked = spec[1]?.control_after_generate
  if (asked !== undefined) return Boolean(asked)
  return type === 'INT' && (name === 'seed' || name === 'noise_seed')
}

const uploads = (spec: InputSpec | undefined) => Boolean(spec?.[1]?.image_upload || spec?.[1]?.video_upload || spec?.[1]?.audio_upload || spec?.[1]?.animated_image_upload)

/** The orders a node's widget values can be saved in: the page appends an upload button after the required inputs of loaders. */
function layouts(def: NodeDef): WidgetSlot[][] {
  const required = def.input?.required ?? {}
  const optional = def.input?.optional ?? {}
  const orders: [string[], string[]][] = [[Object.keys(required), Object.keys(optional)]]
  if (def.input_order) orders.push([def.input_order.required ?? Object.keys(required), def.input_order.optional ?? Object.keys(optional)])
  const slots = (names: string[]) =>
    names.flatMap((name): WidgetSlot[] => {
      const spec = required[name] ?? optional[name]
      const type = widgetType(spec)
      if (!type) return []
      const slot: WidgetSlot = { kind: 'value', name, type }
      if (!hasControl(name, spec, type)) return [slot]
      return type === 'COMBO' ? [slot, { kind: 'control' }, { kind: 'filter' }] : [slot, { kind: 'control' }]
    })
  const upload = Object.values(required).some(uploads)
  const out: WidgetSlot[][] = []
  const seen = new Set<string>()
  for (const [r, o] of orders) {
    const a = slots(r)
    const b = slots(o)
    // Values past the end are ignored, so "upload last" is the same as no upload at all.
    for (const layout of upload ? [[...a, { kind: 'upload' } as WidgetSlot, ...b], [...a, ...b]] : [[...a, ...b]]) {
      const key = layout.map((s) => (s.kind === 'value' ? s.name : s.kind)).join(',')
      if (seen.has(key)) continue
      seen.add(key)
      out.push(layout)
    }
  }
  return out
}

const CONTROLS = new Set(['fixed', 'increment', 'decrement', 'randomize', 'increment-wrap'])

function fits(type: WidgetType, v: unknown) {
  if (type === 'INT') return typeof v === 'number' && Number.isFinite(v) && Math.round(v) === v
  if (type === 'FLOAT') return typeof v === 'number' && Number.isFinite(v)
  if (type === 'BOOLEAN') return typeof v === 'boolean'
  if (type === 'STRING') return typeof v === 'string'
  return typeof v === 'string' || typeof v === 'number'
}

/** Saved widget values onto inputs, if every value is of the kind its widget takes (so nothing is ever assigned off by one). */
function assign(values: unknown[], layout: WidgetSlot[]): Record<string, unknown> | null {
  const out: Record<string, unknown> = {}
  let i = 0
  for (const slot of layout) {
    if (i >= values.length) return null
    const v = values[i++]
    if (slot.kind === 'control') {
      if (typeof v !== 'string' || !CONTROLS.has(v)) return null
    } else if (slot.kind === 'filter' || slot.kind === 'upload') {
      if (v !== null && v !== undefined && typeof v !== 'string') return null
    } else if (fits(slot.type, v)) out[slot.name] = v
    else return null
  }
  return out
}

function widgetValues(node: UiNode, def: NodeDef): Record<string, unknown> {
  const values = node.widgets_values
  if (values && typeof values === 'object' && !Array.isArray(values)) {
    // Video Helper Suite saves its widgets by name.
    const out: Record<string, unknown> = {}
    const named = values as Record<string, unknown>
    for (const [name, spec] of Object.entries({ ...def.input?.required, ...def.input?.optional })) if (widgetType(spec) && name in named) out[name] = named[name]
    return out
  }
  const saved = Array.isArray(values) ? values : []
  for (const layout of layouts(def)) {
    const out = assign(saved, layout)
    if (out) return out
  }
  throw new ConvertError(`the settings saved on node ${node.id} (${node.title ?? node.type}) don’t line up with the inputs your ComfyUI says ${node.type} has`)
}

const sameType = (a: unknown, b: unknown) => a === '*' || b === '*' || String(a) === String(b)

/**
 * ComfyUI's own format → the API format, the way ComfyUI's page does it before
 * queueing: page-only nodes resolved (reroutes followed, primitives' values
 * put in place, bypassed nodes passing their input on, muted ones left out)
 * and saved widget values matched to inputs by the server's node definitions.
 * Anything it can't do exactly — subgraphs, group nodes, unknown nodes,
 * widgets that don't line up — is a ConvertError, never a guess.
 */
export function uiToApi(graph: UiGraph, defs: NodeDefs): ApiPrompt {
  if (graph.definitions?.subgraphs?.length) throw new ConvertError('it uses subgraphs')
  const nodes = new Map(graph.nodes.map((n) => [String(n.id), n]))
  const live = graph.nodes.filter((n) => typeof n.type === 'string' && !PAGE_ONLY.has(n.type) && n.mode !== MODE_MUTED && n.mode !== MODE_BYPASS)
  const groups = [...new Set(live.filter((n) => /^workflow[>/]/.test(n.type)).map((n) => n.type.replace(/^workflow[>/]/, '')))]
  if (groups.length) throw new ConvertError(`it uses group nodes (${list(groups)})`)
  const unknown = [...new Set(live.filter((n) => !defs[n.type]).map((n) => n.type))]
  if (unknown.length) throw new ConvertError(`your ComfyUI doesn’t have ${list(unknown)} — custom nodes that aren’t installed, or nodes that only exist in ComfyUI’s page`)

  const links = new Map<number, { origin: string; slot: number }>()
  for (const l of graph.links ?? []) {
    if (Array.isArray(l)) {
      if (typeof l[0] === 'number') links.set(l[0], { origin: String(l[1]), slot: Number(l[2]) })
    } else if (l && typeof l === 'object' && typeof l.id === 'number') links.set(l.id, { origin: String(l.origin_id), slot: Number(l.origin_slot) })
  }

  type Source = { wire: Wire } | { value: unknown } | null
  const source = (linkId: number, want: unknown, depth = 0): Source => {
    const link = links.get(linkId)
    const from = link && nodes.get(link.origin)
    if (!link || !from || depth > 64) return null
    if (from.type === 'Reroute') {
      const next = from.inputs?.[0]?.link
      return next == null ? null : source(next, want, depth + 1)
    }
    if (from.type === 'PrimitiveNode') return Array.isArray(from.widgets_values) && from.widgets_values.length ? { value: from.widgets_values[0] } : null
    if (from.mode === MODE_MUTED || PAGE_ONLY.has(from.type)) return null
    if (from.mode === MODE_BYPASS) {
      // A bypassed node hands on its input of the type asked for: the one in the same slot first.
      const ins = from.inputs ?? []
      const type = want ?? from.outputs?.[link.slot]?.type
      const through = [ins[link.slot], ...ins].find((i) => i && sameType(i.type, type))
      return through?.link == null ? null : source(through.link, want, depth + 1)
    }
    return { wire: [String(from.id), link.slot] }
  }

  const prompt: ApiPrompt = {}
  for (const node of live) {
    const def = defs[node.type]!
    const inputs = widgetValues(node, def)
    for (const input of node.inputs ?? []) {
      if (input.link == null) continue
      const from = source(input.link, input.type)
      if (!from) continue
      inputs[input.widget?.name ?? input.name] = 'wire' in from ? from.wire : from.value
    }
    prompt[String(node.id)] = { class_type: node.type, inputs, _meta: { title: node.title ?? def.display_name ?? node.type } }
  }
  if (!Object.keys(prompt).length) throw new ConvertError('it has no nodes to run')
  return prompt
}

// ─── What a workflow lets you change ─────────────────────────────────────

export interface Analysis {
  inputs: ComfyInput[]
  outputs: ComfyOutput[]
  /** Node types the server doesn't have. */
  missing: string[]
}

const specOf = (defs: NodeDefs | undefined, type: string, input: string): InputSpec | undefined => {
  const def = defs?.[type]
  return def?.input?.required?.[input] ?? def?.input?.optional?.[input]
}

/** Nodes that turn text into conditioning, or are named for prompts. */
const PROMPT_NODE = /TextEncode|CLIPText|Prompt|Conditioning/i
/** Inputs that hold prompt text on such nodes. */
const PROMPT_INPUT = /^(text|text_[gl]|clip_[lg]|t5xxl|umt5xxl|prompt|positive|negative|positive_prompt|negative_prompt|text_positive|text_negative|bert|mt5xl|llama|tags|lyrics|caption)$/i
/** Nodes that set up the size and length of what's made. */
const CANVAS_NODE = /empty|imagetovideo|imgtovideo|img2vid|texttovideo|resolution|aspect ?ratio/i
const SAVE_VIDEO_NODE = /VideoCombine|SaveVideo|SaveWEBM|SaveAnimated/i

const NUMBER_ROLES: { role: ComfyInputRole; input: RegExp; node?: RegExp }[] = [
  { role: 'seed', input: /^(seed|noise_seed)$/ },
  { role: 'steps', input: /^steps$/ },
  { role: 'cfg', input: /^cfg$/ },
  { role: 'denoise', input: /^denoise$/ },
  { role: 'width', input: /^width$/, node: CANVAS_NODE },
  { role: 'height', input: /^height$/, node: CANVAS_NODE },
  { role: 'frames', input: /^(length|video_frames|num_frames|frame_count|frames)$/, node: CANVAS_NODE },
  { role: 'batch', input: /^batch_size$/, node: CANVAS_NODE },
  { role: 'fps', input: /^(fps|frame_rate)$/, node: SAVE_VIDEO_NODE },
]

const INTEGER_ROLES = new Set<ComfyInputRole>(['seed', 'steps', 'width', 'height', 'frames', 'batch'])

export const ROLE_LABEL: Record<ComfyInputRole, string> = {
  prompt: 'Prompt',
  negative: 'Negative prompt',
  text: 'Text',
  seed: 'Seed',
  steps: 'Steps',
  cfg: 'CFG',
  denoise: 'Denoise',
  width: 'Width',
  height: 'Height',
  frames: 'Frames',
  batch: 'Batch size',
  fps: 'Frame rate',
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
}

const ROLE_ORDER: ComfyInputRole[] = ['prompt', 'negative', 'text', 'image', 'video', 'audio', 'seed', 'steps', 'cfg', 'denoise', 'width', 'height', 'frames', 'batch', 'fps']

/** Which of the project's media an input takes: by the upload flag ComfyUI gives loaders, else by the loaders everyone uses. */
function mediaKind(type: string, input: string, spec: InputSpec | undefined): ComfyMediaKind | null {
  const o = spec?.[1]
  if (o?.image_upload || o?.animated_image_upload) return 'image'
  if (o?.video_upload) return 'video'
  if (o?.audio_upload) return 'audio'
  if (spec) return null
  if (/^LoadImage(Mask)?$/.test(type) && input === 'image') return 'image'
  if (/^VHS_LoadVideo(FFmpeg)?$/.test(type) && input === 'video') return 'video'
  if (type === 'LoadVideo' && input === 'file') return 'video'
  if (/^(LoadAudio|VHS_LoadAudioUpload)$/.test(type) && input === 'audio') return 'audio'
  return null
}

function outputKind(type: string, def: NodeDef | null | undefined): ComfyOutputKind | null {
  if (def && !def.output_node) return null
  if (type === 'PreviewImage') return 'preview'
  if (SAVE_VIDEO_NODE.test(type)) return 'video'
  if (/^(Save|Preview).*Audio/i.test(type)) return 'audio'
  if (/^(Save|Preview).*(GLB|3D|Mesh)/i.test(type)) return '3d'
  if (/Show ?Text|Show ?String|Display ?Text|Display ?Any|Preview ?Any|Preview ?Text/i.test(type)) return 'text'
  if (/Image/i.test(type) && /Save|Preview/i.test(type)) return 'image'
  if (def?.output_node || /^(Save|Preview)/.test(type)) return 'file'
  return null
}

/** What an input name says about a prompt: "negative_prompt", "positive"… */
function nameRole(input: string): 'prompt' | 'negative' | null {
  if (/negative|^neg(_|$)/i.test(input)) return 'negative'
  if (/positive|^pos(_|$)/i.test(input)) return 'prompt'
  return null
}

/** The role a sampler, guider or conditioning node gives what arrives at this socket. */
function socketRole(input: string, type: string): 'prompt' | 'negative' | null {
  const named = nameRole(input)
  if (named) return named
  // Flux and other guidance-distilled models take one conditioning, through a guider.
  if (/Guider/.test(type) && /^(conditioning|cond\d?)$/.test(input)) return 'prompt'
  return null
}

interface Consumer {
  node: string
  input: string
}

/** Positive or negative, by following what a text node feeds until it reaches a positive or negative socket (through ControlNets, combines…). */
function downstreamRole(start: string, prompt: ApiPrompt, consumers: Map<string, Consumer[]>): 'prompt' | 'negative' | null {
  const seen = new Set([start])
  let frontier = [start]
  for (let depth = 0; depth < 12 && frontier.length; depth++) {
    const found = new Set<'prompt' | 'negative'>()
    const next: string[] = []
    for (const id of frontier) {
      for (const c of consumers.get(id) ?? []) {
        const role = socketRole(c.input, prompt[c.node].class_type)
        if (role) found.add(role)
        else if (!seen.has(c.node)) {
          seen.add(c.node)
          next.push(c.node)
        }
      }
    }
    // The nearest sampler decides; a text that reaches both at once is neither.
    if (found.size) return found.size === 1 ? [...found][0] : null
    frontier = next
  }
  return null
}

/** A wired input's value lives on the node it comes from, when that node holds just one value of the kind (a primitive, a seed node). */
function wiredSource(prompt: ApiPrompt, wire: Wire, kind: 'string' | 'number'): Consumer | null {
  const from = prompt[String(wire[0])]
  if (!from) return null
  const own = Object.entries(from.inputs).filter(([, v]) => typeof v === kind)
  return own.length === 1 ? { node: String(wire[0]), input: own[0][0] } : null
}

function isPromptText(type: string, input: string, spec: InputSpec | undefined) {
  if (spec) return widgetType(spec) === 'STRING' && (spec[1]?.multiline === true || (PROMPT_INPUT.test(input) && PROMPT_NODE.test(type)))
  return PROMPT_INPUT.test(input) && PROMPT_NODE.test(type)
}

function isPromptSocket(type: string, input: string, spec: InputSpec | undefined) {
  if (spec) return spec[0] === 'STRING' && (spec[1]?.multiline === true || PROMPT_INPUT.test(input))
  return PROMPT_INPUT.test(input) && PROMPT_NODE.test(type)
}

/**
 * What a workflow lets you change — its prompts (positive or negative, by
 * where they lead), seeds, steps, CFG, denoise, size, length and media
 * loaders — and what it makes. Works from the workflow alone; the server's
 * node definitions (when it could be asked) sharpen it with ranges, choices
 * and custom nodes' text boxes.
 */
export function analyze(prompt: ApiPrompt, defs?: NodeDefs): Analysis {
  const consumers = new Map<string, Consumer[]>()
  for (const [id, node] of Object.entries(prompt)) {
    for (const [input, v] of Object.entries(node.inputs)) {
      if (!isWire(v)) continue
      const from = String(v[0])
      consumers.set(from, [...(consumers.get(from) ?? []), { node: id, input }])
    }
  }
  const promptRole = (node: string, input: string): ComfyInputRole => nameRole(input) ?? downstreamRole(node, prompt, consumers) ?? 'text'

  const found = new Map<string, Omit<ComfyInput, 'label'>>()
  const add = (node: string, input: string, role: ComfyInputRole) => {
    const key = `${node}.${input}`
    if (found.has(key)) return
    const n = prompt[node]
    const spec = specOf(defs, n.class_type, input)
    const o = spec?.[1] ?? {}
    const value = n.inputs[input]
    const type = widgetType(spec)
    found.set(key, {
      node,
      input,
      role,
      title: titleOf(prompt, node, defs),
      classType: n.class_type,
      value: typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : null,
      ...(typeof o.min === 'number' ? { min: o.min } : {}),
      ...(typeof o.max === 'number' ? { max: Math.min(o.max, Number.MAX_SAFE_INTEGER) } : {}),
      ...(typeof o.step === 'number' ? { step: o.step } : {}),
      ...(type === 'INT' || (!type && INTEGER_ROLES.has(role)) ? { integer: true } : {}),
    })
  }

  for (const [id, node] of Object.entries(prompt)) {
    for (const [input, v] of Object.entries(node.inputs)) {
      const spec = specOf(defs, node.class_type, input)
      if (typeof v === 'string') {
        const media = mediaKind(node.class_type, input, spec)
        if (media) add(id, input, media)
        else if (isPromptText(node.class_type, input, spec)) add(id, input, promptRole(id, input))
        continue
      }
      if (isWire(v) && isPromptSocket(node.class_type, input, spec)) {
        const from = wiredSource(prompt, v, 'string')
        if (from) add(from.node, from.input, promptRole(id, input))
        continue
      }
      const rule = NUMBER_ROLES.find((r) => r.input.test(input) && (!r.node || r.node.test(node.class_type)))
      if (!rule) continue
      if (typeof v === 'number') add(id, input, rule.role)
      else if (isWire(v)) {
        const from = wiredSource(prompt, v, 'number')
        if (from) add(from.node, from.input, rule.role)
      }
    }
  }

  const sorted = [...found.values()].sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || Number(a.node) - Number(b.node) || a.node.localeCompare(b.node) || a.input.localeCompare(b.input))
  const label = (i: Omit<ComfyInput, 'label'>) => {
    if (i.role === 'text') return i.input === 'text' ? i.title : `${i.title} · ${i.input}`
    const peers = sorted.filter((x) => x.role === i.role)
    if (peers.length === 1) return ROLE_LABEL[i.role]
    const sameTitle = peers.filter((x) => x.title === i.title)
    const sameNode = sameTitle.filter((x) => x.node === i.node)
    return `${ROLE_LABEL[i.role]} · ${i.title}${sameNode.length > 1 ? ` ${i.input}` : sameTitle.length > 1 ? ` #${i.node}` : ''}`
  }
  const inputs = sorted.map((i) => ({ ...i, label: label(i) }))

  const outputs: ComfyOutput[] = []
  for (const [id, node] of Object.entries(prompt)) {
    const kind = outputKind(node.class_type, defs?.[node.class_type])
    if (kind) outputs.push({ node: id, classType: node.class_type, title: titleOf(prompt, id, defs), kind })
  }
  const missing = defs ? [...new Set(Object.values(prompt).map((n) => n.class_type))].filter((t) => defs[t] === null) : []
  return { inputs, outputs, missing }
}

// ─── Applying a run ──────────────────────────────────────────────────────

export interface Applied {
  prompt: ApiPrompt
  /** The seed each seed input got, by "node.input". */
  seeds: Record<string, number>
  notes: string[]
}

const describeInput = (i: ComfyInput) => `${i.node}.${i.input} (${i.title})`
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

function comboOptions(spec: InputSpec | undefined): unknown[] {
  if (Array.isArray(spec?.[0])) return spec[0] as unknown[]
  const options = spec?.[1]?.options
  return Array.isArray(options) ? options : []
}

function range(min: unknown, max: unknown) {
  if (typeof min === 'number' && typeof max === 'number') return `goes from ${min} to ${max}`
  return typeof min === 'number' ? `is at least ${min}` : `is at most ${max}`
}

/** A value for an input, checked against the node: it has to exist, be a value (not a wire), and be the kind and range the input takes. */
function valueFor(prompt: ApiPrompt, at: { node: string; input: string }, v: unknown, defs?: NodeDefs): unknown {
  const node = prompt[at.node]
  if (!node) throw new Error(`There’s no node ${at.node} in this workflow. Its nodes: ${nodeList(prompt, defs)}.`)
  const what = `“${at.input}” on node ${at.node} (${titleOf(prompt, at.node, defs)})`
  const spec = specOf(defs, node.class_type, at.input)
  const current = node.inputs[at.input]
  if (current === undefined && !spec) throw new Error(`Node ${at.node} (${titleOf(prompt, at.node, defs)}) has no input “${at.input}”. It has: ${Object.keys(node.inputs).join(', ') || 'none'}.`)
  if (isWire(current)) throw new Error(`${capital(what)} is wired to node ${current[0]} (${titleOf(prompt, String(current[0]), defs)}) — set the value there instead.`)
  const type = widgetType(spec) ?? (typeof current === 'number' ? 'NUMBER' : typeof current === 'boolean' ? 'BOOLEAN' : typeof current === 'string' ? 'STRING' : null)
  if (type === 'INT' || type === 'FLOAT' || type === 'NUMBER') {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
    if (!Number.isFinite(n)) throw new Error(`${capital(what)} takes a number.`)
    if (type === 'INT' && Math.round(n) !== n) throw new Error(`${capital(what)} takes whole numbers.`)
    const { min, max } = spec?.[1] ?? {}
    if ((typeof min === 'number' && n < min) || (typeof max === 'number' && n > max)) throw new Error(`${capital(what)} ${range(min, max)}.`)
    return n
  }
  if (type === 'BOOLEAN') {
    if (typeof v === 'boolean') return v
    if (v === 'true' || v === 'false') return v === 'true'
    throw new Error(`${capital(what)} takes true or false.`)
  }
  if (type === 'STRING') {
    if (typeof v === 'string') return v
    if (typeof v === 'number' || typeof v === 'boolean') return String(v)
    throw new Error(`${capital(what)} takes text.`)
  }
  if (type === 'COMBO') {
    const options = comboOptions(spec)
    const given = typeof v === 'string' || typeof v === 'number' ? v : String(v)
    // Loaders take files ComfyUI doesn't list yet (uploads); anything else has to be one of its choices.
    const match = options.find((o) => o === given || String(o) === String(given))
    if (options.length && match === undefined && !uploads(spec)) throw new Error(`${capital(what)} is one of: ${shortList(options)}.`)
    return match ?? given
  }
  return v
}

function randomSeed(i: ComfyInput, random: () => number) {
  const min = Math.max(0, Math.ceil(i.min ?? 0))
  // Without the server's definition, stay within what every seed input takes.
  const max = Math.max(min, Math.min(i.max ?? 0xffffffff, 2 ** 50))
  return min + Math.floor(random() * (max - min + 1))
}

/** Points a loader at the stretch of a clip, where it can skip into a file (Video Helper Suite's loaders can). */
function applyTrim(prompt: ApiPrompt, m: NonNullable<ComfyRunRequest['media']>[number], defs?: NodeDefs): string[] {
  const node = prompt[m.node]
  const trim = m.trim
  if (!node || !trim) return []
  const title = titleOf(prompt, m.node, defs)
  const set = (input: string) => typeof node.inputs[input] === 'number'
  const seconds = (s: number) => `${Math.round(s * 100) / 100} s`
  if (/^VHS_LoadVideo/.test(node.class_type) && set('skip_first_frames') && set('frame_load_cap')) {
    const forced = Number(node.inputs.force_rate) || 0
    const rate = forced > 0 ? forced : trim.fps
    if (rate) {
      const nth = Math.max(1, Math.round(Number(node.inputs.select_every_nth) || 1))
      node.inputs.skip_first_frames = Math.max(0, Math.round(trim.from * rate))
      node.inputs.frame_load_cap = Math.max(1, Math.round(((trim.to - trim.from) * rate) / nth))
      return [`${title} loads the ${seconds(trim.to - trim.from)} the clip uses, from ${seconds(trim.from)} into its file.`]
    }
  } else if (node.class_type === 'VHS_LoadAudioUpload' && set('start_time') && set('duration')) {
    node.inputs.start_time = Math.round(trim.from * 1000) / 1000
    node.inputs.duration = Math.round((trim.to - trim.from) * 1000) / 1000
    return [`${title} loads the ${seconds(trim.to - trim.from)} the clip uses, from ${seconds(trim.from)} into its file.`]
  }
  return [`${title} loads the whole file: it can’t start partway in, so the clip’s trim isn’t applied.`]
}

/**
 * GIFs and animated WebP come into an editor as stills. Video Helper Suite's
 * Video Combine saves GIF unless told otherwise, so it is asked for MP4 when
 * the server lists that format (an override of `format` still wins); savers
 * that only make animated pictures get a note.
 */
function preferVideo(prompt: ApiPrompt, req: ComfyRunRequest, defs?: NodeDefs): string[] {
  const notes: string[] = []
  const chosen = new Set((req.overrides ?? []).map((o) => `${o.node}.${o.input}`))
  for (const [id, node] of Object.entries(prompt)) {
    if ((req.outputs?.length && !req.outputs.includes(id)) || chosen.has(`${id}.format`)) continue
    const title = titleOf(prompt, id, defs)
    if (node.class_type === 'VHS_VideoCombine' && typeof node.inputs.format === 'string' && /^image\/(gif|webp)$/.test(node.inputs.format)) {
      const was = node.inputs.format === 'image/gif' ? 'a GIF' : 'animated WebP'
      if (comboOptions(specOf(defs, node.class_type, 'format')).includes('video/h264-mp4')) {
        node.inputs.format = 'video/h264-mp4'
        notes.push(`${title} saves an MP4 instead of ${was}, so it plays as video in Lumen.`)
      } else notes.push(`${title} saves ${was}, which Lumen shows as a still — set its format to an MP4 or WebM one in ComfyUI.`)
    } else if (/^SaveAnimated(WEBP|PNG)$/.test(node.class_type)) {
      notes.push(`${title} saves an animated ${node.class_type.endsWith('PNG') ? 'PNG' : 'WebP'}, which Lumen shows as a still — Save Video (or Video Combine with an MP4 format) makes video.`)
    }
  }
  return notes
}

/**
 * A run's values put into a copy of the workflow: prompts, seeds (new random
 * ones unless kept or given), steps, CFG, denoise and size by role, then
 * overrides by node and input, then media files. Every value is checked
 * against the workflow and the server's definitions first, with an error
 * that says what the input takes.
 */
export function applyRun(source: ApiPrompt, req: ComfyRunRequest, analysis: Analysis, defs?: NodeDefs, random: () => number = Math.random): Applied {
  const prompt = structuredClone(source)
  const notes: string[] = []
  const of = (role: ComfyInputRole) => analysis.inputs.filter((i) => i.role === role && prompt[i.node])
  const put = (at: { node: string; input: string }, v: unknown) => {
    const value = valueFor(prompt, at, v, defs)
    prompt[at.node].inputs[at.input] = value
  }

  if (req.prompt !== undefined) {
    const targets = of('prompt')
    if (!targets.length) {
      const texts = of('text')
      throw new Error(`This workflow has no prompt Lumen can find${texts.length ? `; it has text in ${texts.map(describeInput).join(', ')} — set one of those by node and input` : ''}.`)
    }
    for (const i of targets) put(i, req.prompt)
  }
  if (req.negative !== undefined) {
    const targets = of('negative')
    if (targets.length) for (const i of targets) put(i, req.negative)
    else notes.push('This workflow has no negative prompt, so the negative prompt wasn’t used.')
  }
  for (const role of ['steps', 'cfg', 'denoise', 'width', 'height'] as const) {
    const v = req[role]
    if (v === undefined) continue
    const targets = of(role)
    if (targets.length) for (const i of targets) put(i, v)
    else notes.push(`This workflow has no ${ROLE_LABEL[role].toLowerCase()} setting, so ${role} wasn’t used.`)
  }

  const seedInputs = of('seed')
  const mode = req.seed ?? 'random'
  for (const i of seedInputs) {
    if (mode === 'keep') continue
    put(i, mode === 'random' ? randomSeed(i, random) : mode)
  }
  if (typeof req.seed === 'number' && !seedInputs.length) notes.push('This workflow has no seed, so the seed wasn’t used.')

  notes.push(...preferVideo(prompt, req, defs))
  for (const o of req.overrides ?? []) put(o, o.value)
  for (const m of req.media ?? []) {
    put(m, comfyInputName(m.file))
    notes.push(...applyTrim(prompt, m, defs))
  }

  if (req.outputs?.length) {
    const known = new Set(analysis.outputs.map((o) => o.node))
    const wrong = req.outputs.filter((id) => !known.has(id))
    if (wrong.length) throw new Error(`${list(wrong.map((id) => `node ${id}`))} ${wrong.length > 1 ? 'aren’t outputs' : 'isn’t an output'}. The workflow’s outputs: ${analysis.outputs.map((o) => `${o.node} (${o.title})`).join(', ') || 'none'}.`)
  }

  const seeds: Record<string, number> = {}
  for (const i of seedInputs) {
    const v = prompt[i.node].inputs[i.input]
    if (typeof v === 'number') seeds[`${i.node}.${i.input}`] = v
  }
  return { prompt, seeds, notes }
}

// ─── Progress ────────────────────────────────────────────────────────────

/** A run's progress from ComfyUI's websocket: nodes done out of nodes to run, plus the running node's own steps. */
export class RunProgress {
  private started: string[] = []
  private cached = 0
  private step: { value: number; max: number } | null = null

  constructor(private prompt: ApiPrompt) {}

  /** One message about this run; what to show, or null when there's nothing new. */
  take(type: string, data: Record<string, unknown>): { progress: number; message: string } | null {
    if (type === 'execution_start') return { progress: 0, message: 'Starting…' }
    if (type === 'execution_cached') {
      this.cached = Array.isArray(data.nodes) ? data.nodes.filter((id) => this.prompt[String(id)]).length : 0
      return null
    }
    if (type === 'executing') {
      const id = this.nodeOf(data)
      if (!id) return null
      if (!this.started.includes(id)) this.started.push(id)
      this.step = null
      return { progress: this.fraction(), message: `${titleOf(this.prompt, id)}…` }
    }
    if (type === 'progress') {
      const value = Number(data.value)
      const max = Number(data.max)
      if (!(max > 0) || !Number.isFinite(value)) return null
      this.step = { value, max }
      const id = this.nodeOf(data) ?? this.started.at(-1)
      return { progress: this.fraction(), message: `${id ? titleOf(this.prompt, id) : 'Working'} · step ${value} of ${max}` }
    }
    return null
  }

  /** The node a message is about, as the workflow knows it (nodes ComfyUI expands report the one they came from). */
  private nodeOf(data: Record<string, unknown>) {
    for (const key of ['display_node', 'node']) {
      const v = data[key]
      if ((typeof v === 'string' || typeof v === 'number') && this.prompt[String(v)]) return String(v)
    }
    return null
  }

  private fraction() {
    const total = Math.max(1, Object.keys(this.prompt).length - this.cached)
    const done = Math.max(0, this.started.length - 1) + (this.step ? Math.min(1, this.step.value / this.step.max) : 0)
    return Math.min(0.98, done / total)
  }
}

// ─── Results ─────────────────────────────────────────────────────────────

export interface HistoryEntry {
  outputs?: Record<string, Record<string, unknown>>
  status?: { status_str?: string; completed?: boolean; messages?: unknown[] }
}

export type FileKind = 'image' | 'video' | 'audio' | '3d' | 'file'

export interface OutputFile extends ComfyFileRef {
  node: string
  kind: FileKind
}

const EXTENSIONS: [RegExp, FileKind][] = [
  [/\.(png|jpe?g|webp|gif|bmp|avif|tiff?)$/i, 'image'],
  [/\.(mp4|webm|mov|mkv|m4v|avi)$/i, 'video'],
  [/\.(wav|mp3|flac|ogg|opus|m4a|aac)$/i, 'audio'],
  [/\.(glb|gltf|obj|fbx|ply|stl|usdz?|splat|3mf)$/i, '3d'],
]

export const fileKind = (name: string): FileKind => EXTENSIONS.find(([re]) => re.test(name))?.[1] ?? 'file'

/**
 * The files a finished run left, from its history entry: whatever each output
 * node lists with a filename (images, gifs, videos, audio, 3D…), and the text
 * display nodes show. Previews only count when the workflow saved nothing.
 */
export function collectOutputs(entry: HistoryEntry, only?: string[]): { files: OutputFile[]; texts: { node: string; text: string }[] } {
  let files: OutputFile[] = []
  const texts: { node: string; text: string }[] = []
  const seen = new Set<string>()
  for (const [node, out] of Object.entries(entry.outputs ?? {})) {
    if ((only?.length && !only.includes(node)) || !out || typeof out !== 'object') continue
    for (const [key, items] of Object.entries(out)) {
      if (!Array.isArray(items)) continue
      for (const item of items.flat()) {
        if (item && typeof item === 'object' && typeof (item as { filename?: unknown }).filename === 'string') {
          const f = item as { filename: string; subfolder?: unknown; type?: unknown }
          const ref = { filename: f.filename, subfolder: typeof f.subfolder === 'string' ? f.subfolder : '', type: typeof f.type === 'string' ? f.type : 'output' }
          const id = `${ref.type}/${ref.subfolder}/${ref.filename}`
          if (seen.has(id)) continue
          seen.add(id)
          files.push({ ...ref, node, kind: fileKind(ref.filename) })
        } else if (typeof item === 'string' && item.trim() && /^(text|texts|string|value)$/i.test(key)) texts.push({ node, text: item })
      }
    }
  }
  if (!only?.length && files.some((f) => f.type === 'output')) files = files.filter((f) => f.type !== 'temp')
  return { files, texts }
}

export type Outcome = { done: false } | { done: true; ok: true } | { done: true; ok: false; error: string; interrupted?: boolean }

/** Whether a run is over, from its history entry (none until it is). */
export function outcome(entry: HistoryEntry | undefined): Outcome {
  if (!entry || typeof entry !== 'object') return { done: false }
  const status = entry.status
  const messages = Array.isArray(status?.messages) ? status.messages : []
  const find = (type: string) => (messages.find((m) => Array.isArray(m) && m[0] === type) as [string, Record<string, unknown>] | undefined)?.[1]
  if (status?.status_str === 'error') {
    if (find('execution_interrupted')) return { done: true, ok: false, interrupted: true, error: 'ComfyUI stopped this run: it was interrupted.' }
    const err = find('execution_error')
    return { done: true, ok: false, error: err ? executionError(err) : 'ComfyUI couldn’t finish this run.' }
  }
  if (status?.completed || status?.status_str === 'success' || (!status && entry.outputs)) return { done: true, ok: true }
  return { done: false }
}

/** A node's failure, as ComfyUI reports it (execution_error), in a sentence — with what to do when the graphics card ran out of memory. */
export function executionError(data: Record<string, unknown>) {
  const node = data.node_type ? `${data.node_type}${data.node_id !== undefined ? ` (node ${data.node_id})` : ''}` : 'A node'
  const message = String(data.exception_message ?? data.message ?? 'failed').trim().slice(0, 800)
  const memory = /out of memory|OutOfMemory|Allocation on device/i.test(message) ? ' The graphics card ran out of memory: try a smaller size, fewer frames or a smaller batch.' : ''
  return `${node} failed: ${message}${memory}`
}

/** What ComfyUI said when it refused a workflow (POST /prompt answering 400), in a few lines. */
export function promptError(body: unknown): string {
  const b = (body && typeof body === 'object' ? body : {}) as { error?: unknown; node_errors?: unknown }
  const e = (b.error && typeof b.error === 'object' ? b.error : { message: typeof b.error === 'string' ? b.error : undefined }) as { type?: string; message?: string; details?: string }
  if (e.type === 'prompt_no_outputs') return 'ComfyUI won’t run this workflow: it has no output node (Save Image, Video Combine…). Add one in ComfyUI and export the workflow again.'
  if (e.type === 'invalid_prompt' && /does not exist/i.test(e.message ?? '')) return `ComfyUI won’t run this workflow: ${e.message} Install that custom node (ComfyUI-Manager can find it), restart ComfyUI and try again.`
  const lines: string[] = []
  if (b.node_errors && typeof b.node_errors === 'object' && !Array.isArray(b.node_errors)) {
    for (const [id, n] of Object.entries(b.node_errors as Record<string, { errors?: { message?: string; details?: string }[]; class_type?: string }>)) {
      for (const err of n?.errors ?? []) lines.push(`${n.class_type ?? 'Node'} (node ${id}): ${err.message ?? 'not valid'}${err.details ? ` — ${err.details}` : ''}`.slice(0, 400))
    }
  }
  const head = e.message ? `ComfyUI won’t run this workflow: ${e.message}${e.details && !lines.length ? ` — ${e.details}` : ''}` : 'ComfyUI won’t run this workflow.'
  return [head, ...lines.slice(0, 8), ...(lines.length > 8 ? [`…and ${lines.length - 8} more.`] : [])].join('\n')
}
