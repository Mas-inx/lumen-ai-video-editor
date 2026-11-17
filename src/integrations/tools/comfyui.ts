/**
 * ComfyUI for agents: the user's own ComfyUI runs the workflows they keep in
 * Lumen's library, on their own graphics card — nothing is spent. Agents check
 * it, read what each workflow lets them set, and run one with the project's
 * footage as its input; everything it saves lands in the media, and what it
 * shows as text (captions, tags, analysis) comes back to them.
 */
import { COMFY_MEDIA_ROLES, type ComfyInput, type ComfyMediaKind, type ComfyOverride, type ComfyRun, type ComfyWorkflowInfo } from '@shared/comfyui'
import type { Job } from '@shared/integrations'
import { usePlayback } from '@/editor/playback'
import { getProject } from '@/editor/store'
import { requestApproval } from '@/integrations/approvals'
import { comfyAvailable, importComfyJson, importComfyWorkflow, loadComfyWorkflows, placeComfyResults, placeWhenDone, refreshComfy, renameComfyWorkflow, runComfy, useComfy, waitForComfy, type ComfyMediaChoice, type ComfySource } from '@/integrations/comfyui'
import { useIntegrations } from '@/integrations/store'
import { assetById, bool, clipById, int, list, num, number, obj, str, text, toFrame, waitSeconds, type AgentTool, type ToolArgs } from './kit'

const LIBRARY_EMPTY = 'Lumen’s ComfyUI library is empty: the user adds workflows in Integrations › ComfyUI (in ComfyUI, Workflow › Export (API)), or add one with comfyui_import_workflow.'

function need() {
  if (!comfyAvailable()) throw new Error('ComfyUI needs Lumen’s desktop app.')
}

/** Node ids are strings; agents send them as numbers too. */
const id = (a: ToolArgs, key: string) => (typeof a[key] === 'number' ? String(a[key]) : text(a, key))

const shown = (v: ComfyInput['value']) => (typeof v === 'string' && v.length > 2000 ? `${v.slice(0, 2000)}…` : v)

function describeWorkflow(w: ComfyWorkflowInfo) {
  return {
    id: w.id,
    name: w.name,
    nodes: w.nodes,
    inputs: w.inputs.map((i) => ({
      node: i.node,
      input: i.input,
      role: i.role,
      label: i.label,
      ...(i.label !== i.title ? { node_title: i.title } : {}),
      value: shown(i.value),
      ...(i.min !== undefined ? { min: i.min } : {}),
      ...(i.max !== undefined ? { max: i.max } : {}),
      ...(i.integer ? { whole_numbers: true } : {}),
    })),
    outputs: w.outputs.map((o) => ({ node: o.node, kind: o.kind, title: o.title })),
    ...(w.missing?.length ? { missing_nodes: w.missing, note: 'The user’s ComfyUI doesn’t have these custom nodes, so this workflow won’t run until they’re installed.' } : {}),
  }
}

async function findWorkflow(ref: string | undefined): Promise<ComfyWorkflowInfo> {
  const all = await loadComfyWorkflows()
  if (!all.length) throw new Error(LIBRARY_EMPTY)
  const known = all.map((w) => `${w.id} (${w.name})`).join(', ')
  if (!ref) throw new Error(`Say which workflow: ${known}.`)
  const lower = ref.toLowerCase()
  const partial = all.filter((w) => w.name.toLowerCase().includes(lower))
  const hit = all.find((w) => w.id === ref) ?? all.find((w) => w.name.toLowerCase() === lower) ?? (partial.length === 1 ? partial[0] : undefined)
  if (!hit) throw new Error(`No workflow “${ref}” in Lumen’s ComfyUI library. It has: ${known}.`)
  return hit
}

/** The kinds of input a source fits, best first: a video's footage goes to a video input before one of its frames goes to an image input. */
function kindsFor(source: ComfySource): ComfyMediaKind[] {
  if (source.from === 'timeline') return ['image']
  const p = getProject()
  const assetId = source.from === 'asset' ? source.assetId : p.clips[source.clipId]?.assetId
  const kind = assetId ? p.assets[assetId]?.kind : undefined
  return kind === 'video' ? ['video', 'image', 'audio'] : kind === 'audio' ? ['audio'] : ['image']
}

/** The media input an item goes into: the one named, or the workflow's only input of the kind it fits. */
export function pickMediaInput(inputs: ComfyInput[], kinds: ComfyMediaKind[], node?: string, input?: string): ComfyInput {
  const media = inputs.filter((i) => COMFY_MEDIA_ROLES.includes(i.role))
  const name = (i: ComfyInput) => `node ${i.node} (${i.title}, ${i.role})`
  if (!media.length) throw new Error('This workflow has no image, video or audio input — run it without media.')
  if (node) {
    const on = media.filter((i) => i.node === node && (!input || i.input === input))
    if (!on.length) throw new Error(`Node ${node}${input ? `’s “${input}”` : ''} isn’t one of the workflow’s media inputs: ${media.map(name).join(', ')}.`)
    return on[0]
  }
  for (const kind of kinds) {
    const fits = media.filter((i) => i.role === kind)
    if (fits.length === 1) return fits[0]
    if (fits.length > 1) throw new Error(`This workflow has ${fits.length} ${kind} inputs — say which with node: ${fits.map(name).join(', ')}.`)
  }
  throw new Error(`This workflow has no input that takes ${kinds.length === 1 ? (kinds[0] === 'video' ? 'a video' : `an ${kinds[0]}`) : 'that'} — its media inputs: ${media.map(name).join(', ')}.`)
}

function mediaChoices(w: ComfyWorkflowInfo, a: ToolArgs): ComfyMediaChoice[] {
  const items = Array.isArray(a.media) ? (a.media as ToolArgs[]) : []
  const used = new Set<string>()
  return items.map((m) => {
    const source: ComfySource = text(m, 'asset_id')
      ? { from: 'asset', assetId: assetById(text(m, 'asset_id')!).id, seconds: number(m, 'time_seconds') }
      : text(m, 'clip_id')
        ? { from: 'clip', clipId: clipById(text(m, 'clip_id')!).id }
        : { from: 'timeline', frame: number(m, 'timeline_seconds') !== undefined ? toFrame(number(m, 'timeline_seconds')!) : usePlayback.getState().frame }
    const target = pickMediaInput(w.inputs, kindsFor(source), id(m, 'node'), text(m, 'input'))
    const key = `${target.node}.${target.input}`
    if (used.has(key)) throw new Error(`Two media items go into node ${target.node} (${target.title}) — give each one its own node.`)
    used.add(key)
    return { node: target.node, input: target.input, kind: target.role as ComfyMediaKind, source }
  })
}

function overridesOf(a: ToolArgs): ComfyOverride[] {
  return (Array.isArray(a.inputs) ? (a.inputs as ToolArgs[]) : []).map((o) => {
    const node = id(o, 'node')
    const input = text(o, 'input')
    const value = o.value
    if (!node || !input || (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean')) {
      throw new Error('Each of inputs is { node, input, value }: node and input from comfyui_list_workflows, value a string, a number or true / false.')
    }
    return { node, input, value }
  })
}

function runReport(job: Job, run: ComfyRun, w: ComfyWorkflowInfo, clips: string[], place: boolean) {
  const running = job.status === 'running'
  return {
    job_id: job.id,
    status: job.status,
    ...(running ? { progress: job.progress >= 0 ? Math.round(job.progress * 100) / 100 : null } : {}),
    message: job.message,
    ...(job.error ? { error: job.error } : {}),
    workflow: { id: w.id, name: w.name },
    ...(Object.keys(run.seeds).length ? { seeds: run.seeds } : {}),
    asset_ids: useIntegrations.getState().imported[job.id] ?? [],
    ...(clips.length ? { clip_ids: clips } : {}),
    ...(job.files?.length ? { files: job.files.map((f) => f.path) } : {}),
    ...(job.result?.text.length ? { text: job.result.text.join('\n\n').slice(0, 8000) } : {}),
    ...(run.notes.length ? { notes: run.notes } : {}),
    ...(running ? { next: `Still running in ComfyUI — check on it with get_job (job_id ${job.id}). What it saves lands in the media when it finishes${place ? ', and goes on the timeline' : ''}.` } : {}),
  }
}

const gb = (bytes?: number) => (bytes ? Math.round((bytes / 1024 ** 3) * 10) / 10 : undefined)

export const COMFYUI_TOOLS: AgentTool[] = [
  {
    name: 'comfyui_status',
    description:
      'Whether the user’s own ComfyUI is reachable, and what it runs on: its address and version, the graphics cards with their memory (GB, total and free), how many runs it has going and waiting, and how many workflows are in Lumen’s ComfyUI library. ComfyUI runs on the user’s hardware, so its runs cost nothing — prefer it for heavy image and video work when it’s connected. When it isn’t reachable, error says what to do.',
    inputSchema: obj({}),
    run: async () => {
      need()
      const s = (await refreshComfy(true))!
      const workflows = useComfy.getState().workflows.length
      return {
        connected: s.connected,
        url: s.url,
        ...(s.connected
          ? { version: s.version, devices: s.devices.map((d) => ({ name: d.name, type: d.type, memory_gb: gb(d.vramTotal), free_gb: gb(d.vramFree) })), ...(s.queue ? { queue: s.queue } : {}) }
          : { error: s.error }),
        ...(s.header ? { auth_header: s.header.name } : {}),
        workflows,
        ...(workflows ? {} : { note: LIBRARY_EMPTY }),
      }
    },
  },
  {
    name: 'comfyui_list_workflows',
    description:
      'The ComfyUI workflows in Lumen’s library, each with what it lets you set — inputs: { node, input, role, label, value, min, max }, role being prompt, negative, text, seed, steps, cfg, denoise, width, height, frames, batch, fps, image, video or audio (positive and negative prompts are told apart by the sampler input they reach) — and what it makes (outputs: { node, kind } with kind image, video, audio, 3d, text, preview or file). comfyui_run_workflow takes these: its prompt, negative_prompt, seed, steps, cfg, denoise, width and height set every input of that role; inputs sets any one by node and input; media fills the image, video and audio inputs.',
    inputSchema: obj({ workflow: str('Only this workflow (id or name)') }),
    run: async (a) => {
      need()
      // A fresh look at the server sharpens what's known about the workflows' nodes (ranges, custom text boxes, missing nodes).
      await refreshComfy(false).catch(() => null)
      const all = useComfy.getState().workflows
      if (text(a, 'workflow')) return { workflows: [describeWorkflow(await findWorkflow(text(a, 'workflow')))] }
      return { workflows: all.map(describeWorkflow), ...(all.length ? {} : { note: LIBRARY_EMPTY }) }
    },
  },
  {
    name: 'comfyui_run_workflow',
    description: [
      'Run one of the user’s ComfyUI workflows (see comfyui_list_workflows) on their ComfyUI and graphics card, and bring everything it saves — images, video, sound — into the project’s media; text it shows (captions, tags, analysis) comes back in text, and 3D models are saved on disk (files) for Blender or the like. Returns the new media ids (asset_ids).',
      'prompt and negative_prompt set the workflow’s prompts; the seed is new and random on every run unless you give one or keep_seed; steps, cfg, denoise, width and height set every input with that role; inputs sets any input by node id and input name.',
      'media fills image, video and audio inputs from the project: a media item (asset_id; time_seconds picks the frame of a video going into an image input), a clip on the timeline (clip_id: a video input gets the stretch of footage the clip uses where the loader can skip into a file, an image input gets the clip’s frame under the playhead), or a frame of the timeline as the export renders it (timeline_seconds; the default when an item names nothing else). Without node, an item goes into the workflow’s only input of its kind.',
      'place puts the results on the timeline one after another (default false). A run can take minutes: when it is still going after wait_seconds the answer says so with its job_id — check it with get_job; it still lands in the media (and on the timeline, when place is set). Errors from ComfyUI — a missing model, a custom node it lacks, the graphics card running out of memory — come back as they are, with what to do.',
    ].join('\n'),
    inputSchema: obj(
      {
        workflow: str('Workflow id or name (from comfyui_list_workflows)'),
        prompt: str('Text for the workflow’s positive prompt(s)'),
        negative_prompt: str('Text for its negative prompt(s)'),
        seed: int('Seed for every seed input (default: a new random one each run)', { minimum: 0 }),
        keep_seed: bool('Keep the seeds saved in the workflow instead'),
        steps: int('Sampling steps', { minimum: 1, maximum: 10000 }),
        cfg: num('CFG scale', { minimum: 0, maximum: 100 }),
        denoise: num('Denoise, 0–1 (how much an image-to-image or video-to-video run changes its input)', { minimum: 0, maximum: 1 }),
        width: int('Width of what it makes, in pixels', { minimum: 16, maximum: 16384 }),
        height: int('Height of what it makes, in pixels', { minimum: 16, maximum: 16384 }),
        inputs: list(
          'Set any input by node id and input name (from comfyui_list_workflows); these win over the settings above',
          {
            type: 'object',
            properties: { node: { type: 'string' }, input: { type: 'string' }, value: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] } },
            required: ['node', 'input', 'value'],
            additionalProperties: false,
          },
          { maxItems: 100 },
        ),
        media: list(
          'Project media for the workflow’s image, video and audio inputs',
          {
            type: 'object',
            properties: {
              node: str('The input’s node id (default: the workflow’s only input of that kind)'),
              input: str('The input’s name on that node'),
              asset_id: str('A media item (from get_project)'),
              time_seconds: num('For a video going into an image input: the moment to take (default 0)', { minimum: 0 }),
              clip_id: str('A clip on the timeline'),
              timeline_seconds: num('A frame of the timeline, in seconds (default: the playhead)', { minimum: 0 }),
            },
            additionalProperties: false,
          },
          { maxItems: 8 },
        ),
        output_nodes: list('Keep only what these output nodes make (default: everything saved; previews only when nothing is)', { type: 'string' }, { maxItems: 32 }),
        name: str('What to call the results in the media'),
        place: bool('Also put the results on the timeline, one after another (default false)'),
        at_seconds: num('Where to place them (default: the playhead)', { minimum: 0 }),
        wait_seconds: num('Seconds to wait for the run before answering (default 90, max 600; through Lumen’s MCP server at most 15)', { minimum: 0, maximum: 600 }),
      },
      ['workflow'],
    ),
    run: async (a, ctx) => {
      need()
      const w = await findWorkflow(text(a, 'workflow'))
      const media = mediaChoices(w, a)
      const at = number(a, 'at_seconds') !== undefined ? toFrame(number(a, 'at_seconds')!) : usePlayback.getState().frame
      if (media.length) ctx?.progress?.(`Sending ${media.length === 1 ? 'the media' : `${media.length} media items`} to ComfyUI…`)
      const run = await runComfy(
        {
          workflowId: w.id,
          prompt: text(a, 'prompt'),
          negative: text(a, 'negative_prompt'),
          seed: a.keep_seed === true ? 'keep' : (number(a, 'seed') ?? 'random'),
          steps: number(a, 'steps'),
          cfg: number(a, 'cfg'),
          denoise: number(a, 'denoise'),
          width: number(a, 'width'),
          height: number(a, 'height'),
          overrides: overridesOf(a),
          outputs: (Array.isArray(a.output_nodes) ? a.output_nodes : []).map(String),
          name: text(a, 'name'),
        },
        media,
      )
      const job = (await waitForComfy(run.job.id, waitSeconds(a, ctx, 90), ctx?.signal, ctx?.progress)) ?? run.job
      let clips: string[] = []
      if (a.place === true) {
        if (job.status === 'done') clips = placeComfyResults(job.id, at, 'ai')
        else if (job.status === 'running') placeWhenDone(job.id, at, 'ai')
      }
      return runReport(job, run, w, clips, a.place === true)
    },
  },
  {
    name: 'comfyui_import_workflow',
    description:
      'Add a ComfyUI workflow to Lumen’s library so comfyui_run_workflow can run it: its JSON — ComfyUI’s API format (Workflow › Export (API)) or its normal saved format, which Lumen converts using the connected ComfyUI’s node definitions — or a file on this computer (.json, or a .png ComfyUI saved: it carries its workflow). The user is asked first, since a workflow runs on their computer. Returns the workflow with what it lets you set.',
    inputSchema: obj({ json: str('The workflow’s JSON'), path: str('Or: the absolute path of a .json or .png file'), name: str('What to call it (default: the file’s name)') }),
    run: async (a) => {
      need()
      const json = text(a, 'json')
      const file = text(a, 'path')
      if (!json === !file) throw new Error('Give json (the workflow itself) or path (a .json or .png file) — one of them.')
      const ok = await requestApproval({
        title: 'Add a ComfyUI workflow to your library?',
        detail: file ? `add the workflow in ${file} to Lumen’s ComfyUI library` : `add a workflow${text(a, 'name') ? ` called “${text(a, 'name')}”` : ''} to Lumen’s ComfyUI library`,
        ...(json ? { code: json.length > 6000 ? `${json.slice(0, 6000)}\n…` : json } : {}),
        requester: 'An AI agent',
        note: 'Workflows run on your ComfyUI with your files and graphics card, and custom nodes can run code there. Only add workflows you’re comfortable running.',
        confirm: 'Add it',
        deny: 'Don’t add',
      })
      if (!ok) throw new Error('The user declined to add this workflow.')
      const name = text(a, 'name')
      const workflow = json ? await importComfyJson(json, name) : await importComfyWorkflow(file)
      if (!workflow) throw new Error('Nothing was imported.')
      if (file && name) await renameComfyWorkflow(workflow.id, name)
      return { workflow: describeWorkflow(useComfy.getState().workflows.find((w) => w.id === workflow.id) ?? workflow) }
    },
  },
]
