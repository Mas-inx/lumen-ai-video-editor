import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComfyAPI, ComfyInput, ComfyRunRequest, ComfyUploadSource, ComfyWorkflowInfo } from '@shared/comfyui'
import type { Job } from '@shared/integrations'
import type { Asset, Project } from '@/editor/types'

// Frames need a real canvas; here they are stand-ins, so what reaches ComfyUI can be checked in Node.
vi.mock('@/engine/stills', () => ({
  timelineStills: async (_p: Project, frames: number[], width: number) => frames.map(() => ({ width, height: Math.round((width * 9) / 16), what: 'timeline' })),
  mediaStills: async (_a: Asset, times: number[], width: number) => times.map(() => ({ width, height: Math.round((width * 9) / 16), what: 'media' })),
  contactSheet: () => ({ width: 1248, height: 180 }),
  canvasBase64: () => 'iVBORw==',
}))

const { agentTools, runAgentTool } = await import('../agent-tools')
const { pickMediaInput } = await import('./comfyui')
const { setComfyBridge } = await import('@/integrations/comfyui')
const { useIntegrations } = await import('@/integrations/store')
const { useEditor, getProject, dispatch } = await import('@/editor/store')
const { usePlayback } = await import('@/editor/playback')
const { createEmptyProject } = await import('@/editor/new-project')
const { createClip } = await import('@/editor/defaults')

type Json = Record<string, any>

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = await runAgentTool(name, args)
  const text = res.content.find((c) => c.type === 'text')
  return { ...res, json: (res.isError ? { error: text && 'text' in text ? text.text : '' } : res.structuredContent) as Json }
}

const input = (node: string, name: string, role: ComfyInput['role'], value: ComfyInput['value'], title = 'Node'): ComfyInput => ({ node, input: name, role, label: role, title, classType: title, value })

const TXT2IMG: ComfyWorkflowInfo = {
  id: 'wf_00000001',
  name: 'SDXL stills',
  importedAt: 1,
  format: 'api',
  nodes: 7,
  inputs: [input('6', 'text', 'prompt', 'a bottle', 'CLIP Text Encode'), input('7', 'text', 'negative', 'watermark'), input('3', 'seed', 'seed', 5, 'KSampler'), input('3', 'steps', 'steps', 20, 'KSampler')],
  outputs: [{ node: '9', classType: 'SaveImage', title: 'Save Image', kind: 'image' }],
}

const RESTYLE: ComfyWorkflowInfo = {
  id: 'wf_00000002',
  name: 'Restyle footage',
  importedAt: 2,
  format: 'ui',
  nodes: 12,
  inputs: [input('6', 'text', 'prompt', 'anime style'), input('10', 'image', 'image', 'style.png', 'Load Image'), input('11', 'image', 'image', 'mask.png', 'Load Mask'), input('12', 'video', 'video', 'in.mp4', 'Load Video')],
  outputs: [{ node: '20', classType: 'VHS_VideoCombine', title: 'Video Combine', kind: 'video' }],
}

const status = async () => ({ url: 'http://127.0.0.1:8188', connected: true, version: '0.3.68', devices: [{ name: 'NVIDIA GeForce RTX 4090', type: 'cuda', vramTotal: 24 * 1024 ** 3, vramFree: 20 * 1024 ** 3 }], queue: { running: 0, pending: 1 }, checkedAt: Date.now() })

/** The main process, as far as these tools see it. */
const comfy: { uploads: ComfyUploadSource[]; runs: ComfyRunRequest[]; then: (job: Job) => void; api: ComfyAPI } = {
  uploads: [] as ComfyUploadSource[],
  runs: [] as ComfyRunRequest[],
  /** What happens to a run once it is queued. */
  then: (_job: Job) => {},
  api: {
    status,
    configure: status,
    workflows: async () => [TXT2IMG, RESTYLE],
    importFile: async () => null,
    importJson: async () => TXT2IMG,
    rename: async () => [TXT2IMG, RESTYLE],
    remove: async () => [TXT2IMG, RESTYLE],
    upload: async (source: ComfyUploadSource) => {
      comfy.uploads.push(source)
      return { filename: `lumen_${comfy.uploads.length}.${source.kind === 'bytes' ? 'png' : source.url.split('.').pop()}`, subfolder: 'lumen', type: 'input' }
    },
    run: async (req: ComfyRunRequest) => {
      comfy.runs.push(req)
      const job: Job = { id: `job_${comfy.runs.length}`, integration: 'comfyui', title: 'SDXL stills', status: 'running', progress: -1, startedAt: Date.now() }
      setTimeout(() => comfy.then(job), 5)
      return { job, seeds: { '3.seed': 42 }, notes: [] }
    },
  },
}

/** The run ends with one image, which the editor brings into the project (what store.ts does on the job's last event). */
function finishWithImage(job: Job) {
  const asset: Asset = { id: `asset_${job.id}`, name: 'Generated', kind: 'image', width: 1024, height: 1024, source: { type: 'file', url: `lumen-media://local/comfyui/${job.id}/a.png`, mime: 'image/png', fileName: 'a.png', size: 1 }, generated: true, addedAt: Date.now() }
  dispatch('asset.add', { asset })
  useIntegrations.setState((s) => ({
    jobs: { ...s.jobs, [job.id]: { ...job, status: 'done', progress: 1, message: '1 image', assets: [{ name: 'Generated', kind: 'image', source: asset.source as never, provenance: { integration: 'comfyui', tool: 'SDXL stills' } }] } },
    imported: { ...s.imported, [job.id]: [asset.id] },
  }))
}

beforeEach(() => {
  const p = createEmptyProject('ComfyUI')
  const footage: Asset = { id: 'asset_footage', name: 'Beach', kind: 'video', duration: 10, width: 1920, height: 1080, fps: 30, hasAudio: true, source: { type: 'file', url: 'lumen-media://file/beach.mp4', mime: 'video/mp4', fileName: 'beach.mp4', size: 1 }, addedAt: 1 }
  const still: Asset = { id: 'asset_still', name: 'Poster', kind: 'image', width: 800, height: 600, source: { type: 'file', url: 'lumen-media://file/poster.png', mime: 'image/png', fileName: 'poster.png', size: 1 }, addedAt: 2 }
  p.assets = { [footage.id]: footage, [still.id]: still }
  // Two seconds into the footage, one second into the timeline, four seconds long.
  const clip = createClip({ kind: 'video', trackId: p.tracks.find((t) => t.kind === 'video' && !t.role)!.id, start: 30, duration: 120, assetId: footage.id, inPoint: 60, name: 'Beach' })
  clip.id = 'clip_beach'
  p.clips = { [clip.id]: clip }
  useEditor.getState().loadProject(p)
  usePlayback.setState({ frame: 90 })
  useIntegrations.setState({ jobs: {}, imported: {} })
  comfy.uploads = []
  comfy.runs = []
  comfy.then = finishWithImage
  setComfyBridge(comfy.api)
})

describe('the ComfyUI tools', () => {
  it('are registered, each saying what it does', () => {
    const tools = agentTools()
    for (const name of ['comfyui_status', 'comfyui_list_workflows', 'comfyui_run_workflow', 'comfyui_import_workflow']) expect(tools.some((t) => t.name === name), name).toBe(true)
    const run = tools.find((t) => t.name === 'comfyui_run_workflow')!
    expect(run.inputSchema).toMatchObject({ required: ['workflow'] })
    expect(run.description).toMatch(/asset_ids/)
    expect(run.description).toMatch(/get_job/)
  })

  it('need the desktop app', async () => {
    setComfyBridge(undefined)
    expect((await call('comfyui_status')).json.error).toBe('ComfyUI needs Lumen’s desktop app.')
    expect((await call('comfyui_run_workflow', { workflow: 'x' })).json.error).toBe('ComfyUI needs Lumen’s desktop app.')
  })

  it('comfyui_status says what ComfyUI runs on, in GB', async () => {
    const res = await call('comfyui_status')
    expect(res.json).toMatchObject({ connected: true, version: '0.3.68', devices: [{ name: 'NVIDIA GeForce RTX 4090', memory_gb: 24, free_gb: 20 }], queue: { running: 0, pending: 1 }, workflows: 2 })
  })

  it('comfyui_list_workflows lists what each workflow lets you set, and finds one by name', async () => {
    const all = await call('comfyui_list_workflows')
    expect(all.json.workflows.map((w: Json) => w.id)).toEqual(['wf_00000001', 'wf_00000002'])
    expect(all.json.workflows[0].inputs[0]).toMatchObject({ node: '6', input: 'text', role: 'prompt', value: 'a bottle' })
    const one = await call('comfyui_list_workflows', { workflow: 'restyle' })
    expect(one.json.workflows.map((w: Json) => w.name)).toEqual(['Restyle footage'])
    expect((await call('comfyui_list_workflows', { workflow: 'nope' })).json.error).toMatch(/No workflow “nope”.*wf_00000001 \(SDXL stills\)/)
  })
})

describe('running a workflow', () => {
  it('passes the prompts, seed, settings and overrides on, waits, and answers with the new media', async () => {
    const res = await call('comfyui_run_workflow', { workflow: 'SDXL stills', prompt: 'a lighthouse', negative_prompt: 'fog', steps: 30, inputs: [{ node: 3, input: 'cfg', value: 6 }], output_nodes: ['9'] })
    expect(comfy.runs[0]).toMatchObject({ workflowId: 'wf_00000001', prompt: 'a lighthouse', negative: 'fog', seed: 'random', steps: 30, overrides: [{ node: '3', input: 'cfg', value: 6 }], outputs: ['9'], media: [] })
    expect(res.json).toMatchObject({ job_id: 'job_1', status: 'done', message: '1 image', asset_ids: ['asset_job_1'], seeds: { '3.seed': 42 }, workflow: { id: 'wf_00000001', name: 'SDXL stills' } })
    expect(res.json.next).toBeUndefined()

    await call('comfyui_run_workflow', { workflow: 'wf_00000001', keep_seed: true })
    await call('comfyui_run_workflow', { workflow: 'wf_00000001', seed: 7 })
    expect(comfy.runs.map((r) => r.seed)).toEqual(['random', 'keep', 7])
  })

  it('places the results on the timeline when asked, as the AI', async () => {
    const res = await call('comfyui_run_workflow', { workflow: 'SDXL stills', place: true, at_seconds: 8 })
    // A still without transparency goes in the story, which is magnetic: on an empty main track it starts at 0.
    const clip = getProject().clips[res.json.clip_ids[0]]
    expect(clip).toMatchObject({ assetId: 'asset_job_1', kind: 'image' })
    expect(getProject().tracks.find((t) => t.id === clip.trackId)?.role).toBe('main')
    expect(useEditor.getState().past.at(-1)).toMatchObject({ source: 'ai' })
  })

  it('answers while a long run is still going, saying how to check on it', async () => {
    comfy.then = () => {}
    const res = await call('comfyui_run_workflow', { workflow: 'SDXL stills', wait_seconds: 0.05 })
    expect(res.json).toMatchObject({ job_id: 'job_1', status: 'running', asset_ids: [] })
    expect(res.json.next).toMatch(/get_job \(job_id job_1\)/)
  })

  it('sends a clip’s footage with the stretch it uses, a media item as its file, and the timeline as a rendered frame', async () => {
    await call('comfyui_run_workflow', {
      workflow: 'Restyle footage',
      media: [{ clip_id: 'clip_beach' }, { asset_id: 'asset_still', node: '10' }, { node: '11', timeline_seconds: 2 }],
    })
    expect(comfy.uploads).toEqual([{ kind: 'media', url: 'lumen-media://file/beach.mp4' }, { kind: 'media', url: 'lumen-media://file/poster.png' }, { kind: 'bytes', data: expect.any(Uint8Array), fileName: 'frame.png' }])
    expect(comfy.runs[0].media).toEqual([
      { node: '12', input: 'video', file: { filename: 'lumen_1.mp4', subfolder: 'lumen', type: 'input' }, trim: { from: 2, to: 6, fps: 30 } },
      { node: '10', input: 'image', file: { filename: 'lumen_2.png', subfolder: 'lumen', type: 'input' } },
      { node: '11', input: 'image', file: { filename: 'lumen_3.png', subfolder: 'lumen', type: 'input' } },
    ])
  })

  it('a clip going into an image input sends its frame under the playhead', async () => {
    await call('comfyui_run_workflow', { workflow: 'Restyle footage', media: [{ clip_id: 'clip_beach', node: '10' }] })
    expect(comfy.uploads).toEqual([{ kind: 'bytes', data: expect.any(Uint8Array), fileName: 'frame.png' }])
    expect(comfy.runs[0].media?.[0]).toMatchObject({ node: '10', input: 'image' })
    expect(comfy.runs[0].media?.[0].trim).toBeUndefined()
  })

  it('says which input when it can’t tell, and what is wrong with a source', async () => {
    expect((await call('comfyui_run_workflow', { workflow: 'Restyle footage', media: [{ asset_id: 'asset_still' }] })).json.error).toMatch(/2 image inputs — say which with node: node 10 \(Load Image, image\), node 11 \(Load Mask, image\)/)
    expect((await call('comfyui_run_workflow', { workflow: 'Restyle footage', media: [{ asset_id: 'asset_still', node: '6' }] })).json.error).toMatch(/Node 6 isn’t one of the workflow’s media inputs/)
    expect((await call('comfyui_run_workflow', { workflow: 'SDXL stills', media: [{ asset_id: 'asset_still' }] })).json.error).toMatch(/no image, video or audio input/)
    expect((await call('comfyui_run_workflow', { workflow: 'Restyle footage', media: [{ asset_id: 'ghost' }] })).json.error).toMatch(/No media with id “ghost”/)
    expect((await call('comfyui_run_workflow', { workflow: 'Restyle footage', media: [{ node: '12', timeline_seconds: 1 }] })).json.error).toMatch(/A frame of the timeline can only go into an image input/)
    expect((await call('comfyui_run_workflow', { workflow: 'Restyle footage', media: [{ node: '10', asset_id: 'asset_still' }, { node: '10', clip_id: 'clip_beach' }] })).json.error).toMatch(/Two media items go into node 10/)
    expect((await call('comfyui_run_workflow', { workflow: 'SDXL stills', inputs: [{ node: '3', value: 1 }] })).json.error).toMatch(/Each of inputs is \{ node, input, value \}/)
    expect(comfy.runs).toHaveLength(0)
  })

  it('import asks for json or a path before asking the user anything', async () => {
    expect((await call('comfyui_import_workflow', {})).json.error).toMatch(/Give json .* or path/)
    expect((await call('comfyui_import_workflow', { json: '{}', path: 'C:\\x.json' })).json.error).toMatch(/one of them/)
  })
})

describe('choosing the media input', () => {
  const inputs = RESTYLE.inputs
  it('takes the only input of the kind a source fits, best kind first', () => {
    expect(pickMediaInput(inputs, ['video', 'image', 'audio']).node).toBe('12')
    expect(pickMediaInput(inputs, ['image'], '11').node).toBe('11')
    expect(pickMediaInput(inputs, ['image'], '10', 'image').node).toBe('10')
    expect(() => pickMediaInput(inputs, ['audio'])).toThrow(/no input that takes an audio — its media inputs: node 10/)
  })
})
