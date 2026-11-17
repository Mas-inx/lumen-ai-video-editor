import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job } from '../../../shared/integrations'

const env = vi.hoisted(() => ({ root: '' }))

vi.mock('electron', () => ({
  app: { getPath: (name: string) => path.join(env.root, name), getVersion: () => '1.0.0' },
  safeStorage: { isEncryptionAvailable: () => false },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  BrowserWindow: { getFocusedWindow: () => null },
  net: {},
  shell: {},
}))

env.root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-comfyui-test-'))
afterAll(() => fs.rmSync(env.root, { recursive: true, force: true }))

type Json = Record<string, any>

// ─── A ComfyUI that lives in this test ───────────────────────────────────

/** A PNG header with a size and a colour type (6 has alpha). */
function png(colorType = 6) {
  const out = Buffer.alloc(8 + 25 + 12)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(out, 0)
  out.writeUInt32BE(13, 8)
  out.write('IHDR', 12, 'latin1')
  out.writeUInt32BE(640, 16)
  out.writeUInt32BE(360, 20)
  out.set([8, colorType, 0, 0, 0], 24)
  out.writeUInt32BE(0, 33)
  out.write('IEND', 37, 'latin1')
  return out
}

class FakeSocket {
  static sockets: FakeSocket[] = []
  static refuse = false
  readonly OPEN = 1
  readyState = 0
  private listeners: Record<string, ((e: { data?: unknown }) => void)[]> = {}
  constructor(
    readonly url: URL | string,
    readonly init?: { headers?: Record<string, string> },
  ) {
    FakeSocket.sockets.push(this)
    queueMicrotask(() => {
      if (FakeSocket.refuse) return this.emit('error', {})
      this.readyState = 1
      this.emit('open', {})
    })
  }
  addEventListener(type: string, fn: (e: { data?: unknown }) => void) {
    ;(this.listeners[type] ??= []).push(fn)
  }
  private emit(type: string, e: { data?: unknown }) {
    for (const fn of this.listeners[type] ?? []) fn(e)
  }
  send(type: string, data: Json) {
    this.emit('message', { data: JSON.stringify({ type, data }) })
  }
  close() {
    if (this.readyState === 3) return
    this.readyState = 3
    this.emit('close', {})
  }
}

/** What the fake ComfyUI's /object_info knows: the nodes the tests' workflows use. */
const BASE_DEFS: Record<string, Json> = {
  KSampler: {
    input: {
      required: {
        model: ['MODEL'],
        seed: ['INT', { min: 0, max: 18446744073709551615, control_after_generate: true }],
        steps: ['INT', { min: 1, max: 10000 }],
        cfg: ['FLOAT', { min: 0, max: 100 }],
        sampler_name: [['euler'], {}],
        scheduler: [['normal'], {}],
        positive: ['CONDITIONING'],
        negative: ['CONDITIONING'],
        latent_image: ['LATENT'],
        denoise: ['FLOAT', { min: 0, max: 1 }],
      },
    },
    output_node: false,
  },
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [['sd15.safetensors'], {}] } }, output: ['MODEL', 'CLIP', 'VAE'] },
  EmptyLatentImage: { input: { required: { width: ['INT', { min: 16, max: 16384 }], height: ['INT', { min: 16, max: 16384 }], batch_size: ['INT', { min: 1, max: 4096 }] } } },
  CLIPTextEncode: { input: { required: { text: ['STRING', { multiline: true }], clip: ['CLIP'] } }, output: ['CONDITIONING'], display_name: 'CLIP Text Encode (Prompt)' },
  VAEDecode: { input: { required: { samples: ['LATENT'], vae: ['VAE'] } } },
  SaveImage: { input: { required: { images: ['IMAGE'], filename_prefix: ['STRING', {}] } }, output_node: true, display_name: 'Save Image' },
  SaveGLB: { input: { required: { mesh: ['MESH'], filename_prefix: ['STRING', {}] } }, output_node: true },
  'ShowText|pysssss': { input: { required: { text: ['STRING', { forceInput: true }] } }, output_node: true },
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const comfy = {
  down: false,
  requests: [] as { method: string; url: URL; headers: Headers; body?: unknown }[],
  prompts: [] as { id: string; prompt: Json; client_id: string }[],
  running: [] as string[],
  pending: [] as string[],
  history: {} as Record<string, Json>,
  files: {} as Record<string, Uint8Array>,
  defs: {} as Record<string, Json>,
  reject: null as Json | null,
  /** What ComfyUI does once a prompt is queued. */
  onPrompt: (_id: string) => {},
  reset() {
    this.down = false
    this.requests = []
    this.prompts = []
    this.running = []
    this.pending = []
    this.history = {}
    this.files = {}
    this.reject = null
    this.defs = { ...BASE_DEFS }
    this.onPrompt = () => {}
    FakeSocket.sockets = []
    FakeSocket.refuse = false
  },
  async fetch(input: string | URL | Request, init: RequestInit = {}) {
    const url = new URL(String(input))
    const method = init.method ?? 'GET'
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body
    comfy.requests.push({ method, url, headers: new Headers(init.headers), body })
    if (comfy.down) throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })
    const route = `${method} ${url.pathname}`
    const item = (id: string, i: number) => [i, id, {}, {}, []]
    if (route === 'GET /system_stats')
      return json({
        system: { os: 'nt', comfyui_version: '0.3.68', python_version: '3.12.10 (tags/v3.12.10) [MSC v.1943 64 bit (AMD64)]', pytorch_version: '2.8.0+cu128' },
        devices: [{ name: 'cuda:0 NVIDIA GeForce RTX 4090 : cudaMallocAsync', type: 'cuda', index: 0, vram_total: 25757220864, vram_free: 24125636608 }],
      })
    if (route === 'GET /queue') return json({ queue_running: comfy.running.map(item), queue_pending: comfy.pending.map(item) })
    if (route === 'POST /queue') {
      comfy.pending = comfy.pending.filter((id) => !(body as Json).delete?.includes(id))
      return json({})
    }
    if (method === 'GET' && url.pathname.startsWith('/object_info/')) {
      const type = decodeURIComponent(url.pathname.slice('/object_info/'.length))
      return json(comfy.defs[type] ? { [type]: comfy.defs[type] } : {})
    }
    if (route === 'POST /prompt') {
      if (comfy.reject) return json(comfy.reject, 400)
      const id = `p${comfy.prompts.length + 1}`
      comfy.prompts.push({ id, ...(body as { prompt: Json; client_id: string }) })
      comfy.pending.push(id)
      setTimeout(() => comfy.onPrompt(id), 5)
      return json({ prompt_id: id, number: comfy.prompts.length, node_errors: {} })
    }
    if (method === 'GET' && url.pathname.startsWith('/history/')) {
      const id = url.pathname.slice('/history/'.length)
      return json(comfy.history[id] ? { [id]: comfy.history[id] } : {})
    }
    if (route === 'POST /interrupt') return new Response(null, { status: 200 })
    if (route === 'POST /upload/image') {
      const form = body as FormData
      const file = form.get('image') as File
      return json({ name: file.name, subfolder: form.get('subfolder'), type: form.get('type') })
    }
    if (route === 'GET /view') {
      const key = `${url.searchParams.get('type')}/${url.searchParams.get('subfolder')}/${url.searchParams.get('filename')}`
      const bytes = comfy.files[key]
      return bytes ? new Response(new Uint8Array(bytes), { headers: { 'content-type': 'application/octet-stream' } }) : new Response('not found', { status: 404 })
    }
    return new Response('not found', { status: 404 })
  },
}

vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => comfy.fetch(input, init))
vi.stubGlobal('WebSocket', FakeSocket)

const { comfyStatus, configureComfy, importWorkflowFile, importWorkflowJson, listWorkflows, normalizeUrl, removeWorkflow, renameWorkflow, runComfyWorkflow, uploadToComfy } = await import('./index')
const { cancelJob, getJob } = await import('../jobs')
const { mediaRoot, mediaUrl } = await import('../paths')

const TXT2IMG = {
  '3': { class_type: 'KSampler', inputs: { seed: 5, steps: 20, cfg: 8, sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd15.safetensors' } },
  '5': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a bottle', clip: ['4', 1] } },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: 'watermark', clip: ['4', 1] } },
  '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
  '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'ComfyUI', images: ['8', 0] } },
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function settled(id: string, ms = 6000): Promise<Job> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const job = getJob(id)
    if (job && job.status !== 'running') return job
    await sleep(15)
  }
  throw new Error(`job ${id} is still running: ${getJob(id)?.message}`)
}

/** The run finishing the way ComfyUI does it: progress on the websocket, then the history entry, then success. */
function finishWith(outputs: Json, files: Record<string, Uint8Array> = {}) {
  comfy.onPrompt = (id) => {
    const ws = FakeSocket.sockets.at(-1)!
    comfy.pending = comfy.pending.filter((p) => p !== id)
    comfy.running = [id]
    ws.send('status', { status: { exec_info: { queue_remaining: 1 } } })
    ws.send('execution_start', { prompt_id: id })
    ws.send('execution_cached', { nodes: ['4'], prompt_id: id })
    ws.send('executing', { node: '3', prompt_id: id })
    ws.send('progress', { value: 10, max: 20, node: '3', prompt_id: id })
    // Someone else's run says nothing about this one.
    ws.send('executing', { node: '99', prompt_id: 'someone-else' })
    Object.assign(comfy.files, files)
    comfy.history[id] = { prompt: [], outputs, status: { status_str: 'success', completed: true, messages: [] } }
    comfy.running = []
    ws.send('execution_success', { prompt_id: id })
  }
}

beforeEach(async () => {
  comfy.reset()
  await configureComfy({ url: null, header: null })
  comfy.requests = []
})

describe('where ComfyUI is', () => {
  it('takes http(s) addresses only, plain http only nearby', () => {
    expect(normalizeUrl('127.0.0.1:8188')).toBe('http://127.0.0.1:8188')
    expect(normalizeUrl('http://gpu-box:8188/')).toBe('http://gpu-box:8188')
    expect(normalizeUrl('http://192.168.1.20:8188')).toBe('http://192.168.1.20:8188')
    expect(normalizeUrl('https://comfy.example.com/proxy/?token=1#x')).toBe('https://comfy.example.com/proxy')
    expect(normalizeUrl('')).toBe('http://127.0.0.1:8188')
    expect(() => normalizeUrl('http://comfy.example.com')).toThrow(/Plain http only works for ComfyUI on this computer or your local network/)
    expect(() => normalizeUrl('ftp://127.0.0.1')).toThrow(/http:\/\/ or https:\/\//)
    expect(() => normalizeUrl('http://me:secret@127.0.0.1:8188')).toThrow(/auth header/)
  })

  it('reports the version, the graphics card and the queue', async () => {
    comfy.pending = ['x', 'y']
    const status = await comfyStatus(true)
    expect(status).toMatchObject({ url: 'http://127.0.0.1:8188', connected: true, version: '0.3.68', python: '3.12.10', pytorch: '2.8.0+cu128', queue: { running: 0, pending: 2 } })
    expect(status.devices).toEqual([{ name: 'NVIDIA GeForce RTX 4090', type: 'cuda', vramTotal: 25757220864, vramFree: 24125636608 }])
    // Asked again within a few seconds, it answers from what it knows.
    const n = comfy.requests.length
    await comfyStatus()
    expect(comfy.requests).toHaveLength(n)
  })

  it('says what to do when nothing answers', async () => {
    comfy.down = true
    const status = await comfyStatus(true)
    expect(status.connected).toBe(false)
    expect(status.error).toMatch(/Nothing is answering at http:\/\/127\.0\.0\.1:8188\. Start ComfyUI/)
    await configureComfy({ url: 'http://192.168.1.20:8188' })
    expect((await comfyStatus(true)).error).toMatch(/with --listen/)
  })

  it('keeps the auth header encrypted, sends it with every request and the websocket, and only ever talks to the address set', async () => {
    const status = await configureComfy({ url: 'http://127.0.0.1:8188', header: { name: 'Authorization', value: 'Bearer s3cret-token' } })
    expect(status.header).toEqual({ name: 'Authorization', hint: '…oken' })
    expect(fs.readFileSync(path.join(env.root, 'userData', 'comfyui.json'), 'utf8')).not.toContain('s3cret')
    const wf = await importWorkflowJson(JSON.stringify(TXT2IMG), 'Text to image')
    finishWith({ '9': { images: [{ filename: 'ComfyUI_00001_.png', subfolder: '', type: 'output' }] } }, { 'output//ComfyUI_00001_.png': png() })
    const run = await runComfyWorkflow({ workflowId: wf.id })
    await settled(run.job.id)
    expect(comfy.requests.length).toBeGreaterThan(3)
    for (const r of comfy.requests) {
      expect(r.url.origin).toBe('http://127.0.0.1:8188')
      expect(r.headers.get('authorization')).toBe('Bearer s3cret-token')
    }
    expect(String(FakeSocket.sockets[0].url)).toMatch(/^ws:\/\/127\.0\.0\.1:8188\/ws\?clientId=/)
    expect(FakeSocket.sockets[0].init?.headers).toEqual({ Authorization: 'Bearer s3cret-token' })
    await expect(configureComfy({ header: { name: 'Host', value: 'x' } })).rejects.toThrow(/Lumen sets Host itself/)
  })

  it('doesn’t follow redirects anywhere else, and says when ComfyUI refuses', async () => {
    const real = comfy.fetch
    comfy.fetch = async () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } })
    expect((await comfyStatus(true)).error).toMatch(/answered with a redirect to https:\/\/elsewhere\.example\/\. Lumen only talks to the address you set/)
    comfy.fetch = async () => new Response(null, { status: 401 })
    expect((await comfyStatus(true)).error).toMatch(/refused Lumen \(401\)\. If it’s behind a login, add its auth header/)
    comfy.fetch = real
  })
})

describe('the workflow library', () => {
  it('imports API-format JSON with what it lets you change, keeps the same workflow once, renames and removes', async () => {
    const wf = await importWorkflowJson(JSON.stringify(TXT2IMG), 'Text to image')
    expect(wf).toMatchObject({ name: 'Text to image', format: 'api', nodes: 7, outputs: [{ node: '9', kind: 'image' }] })
    expect(wf.id).toMatch(/^wf_[0-9a-f]{8}$/)
    expect(wf.inputs.map((i) => i.role)).toEqual(['prompt', 'negative', 'seed', 'steps', 'cfg', 'denoise', 'width', 'height', 'batch'])
    expect((await importWorkflowJson(JSON.stringify(TXT2IMG), 'Again')).id).toBe(wf.id)
    expect(renameWorkflow(wf.id, '  SD 1.5 \n stills ').find((w) => w.id === wf.id)?.name).toBe('SD 1.5 stills')
    expect(removeWorkflow(wf.id).some((w) => w.id === wf.id)).toBe(false)
    // Ids are never paths.
    expect(() => renameWorkflow('../../evil', 'x')).toThrow(/no workflow “\.\.\/\.\.\/evil”/)
    expect(() => removeWorkflow('../../evil')).toThrow(/isn’t a workflow id/)
  })

  it('reads the workflow inside a PNG ComfyUI saved', async () => {
    const text = Buffer.concat([Buffer.from('prompt\0', 'latin1'), Buffer.from(JSON.stringify({ ...TXT2IMG, '9': { ...TXT2IMG['9'], inputs: { ...TXT2IMG['9'].inputs, filename_prefix: 'png' } } }))])
    const chunk = Buffer.alloc(12 + text.length)
    chunk.writeUInt32BE(text.length, 0)
    chunk.write('tEXt', 4, 'latin1')
    text.copy(chunk, 8)
    const image = png()
    const file = path.join(env.root, 'ComfyUI_00042_.png')
    fs.writeFileSync(file, Buffer.concat([image.subarray(0, 33), chunk, image.subarray(33)]))
    const wf = await importWorkflowFile(file)
    expect(wf).toMatchObject({ name: 'ComfyUI_00042_', format: 'png', source: 'ComfyUI_00042_.png' })
    fs.writeFileSync(file, png())
    await expect(importWorkflowFile(file)).rejects.toThrow(/doesn’t carry a ComfyUI workflow/)
    await expect(importWorkflowFile(path.join(env.root, 'notes.txt'))).rejects.toThrow(/\.json/)
  })

  it('converts ComfyUI’s own format with the server’s node definitions — or says how to export the API version', async () => {
    const graph = {
      nodes: [
        { id: 1, type: 'CheckpointLoaderSimple', widgets_values: ['sd15.safetensors'] },
        { id: 2, type: 'CLIPTextEncode', inputs: [{ name: 'clip', type: 'CLIP', link: 1 }], widgets_values: ['a harbour at dawn'] },
      ],
      links: [[1, 1, 1, 2, 0, 'CLIP']],
    }
    const wf = await importWorkflowJson(JSON.stringify(graph), 'From the editor')
    expect(wf).toMatchObject({ format: 'ui', nodes: 2 })
    expect(wf.inputs[0]).toMatchObject({ node: '2', input: 'text', value: 'a harbour at dawn' })

    await expect(importWorkflowJson(JSON.stringify({ nodes: [{ id: 1, type: 'SetNode' }], links: [] }))).rejects.toThrow(/can’t convert this workflow exactly: your ComfyUI doesn’t have SetNode.*Export \(API\)/s)
    comfy.down = true
    await expect(importWorkflowJson(JSON.stringify({ ...graph, nodes: [...graph.nodes, { id: 3, type: 'UpscaleModelLoader' }] }))).rejects.toThrow(/ComfyUI’s own workflow format.*can’t be reached right now.*Export \(API\)/s)
  })
})

describe('inputs from the project', () => {
  it('uploads rendered frames into lumen/, named for their content', async () => {
    const ref = await uploadToComfy({ kind: 'bytes', data: Uint8Array.from([1, 2, 3]), fileName: 'frame.png' })
    expect(ref).toEqual({ filename: expect.stringMatching(/^lumen_[0-9a-f]{16}\.png$/), subfolder: 'lumen', type: 'input' })
    const form = comfy.requests.at(-1)!.body as FormData
    expect(form.get('overwrite')).toBe('true')
    expect((await uploadToComfy({ kind: 'bytes', data: Uint8Array.from([1, 2, 3]), fileName: 'other.png' })).filename).toBe(ref.filename)
  })

  it('sends files from the project’s media and nothing else', async () => {
    const file = path.join(mediaRoot(), 'imports', 'clip.mp4')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, Buffer.alloc(2048, 7))
    const ref = await uploadToComfy({ kind: 'media', url: mediaUrl(file) })
    expect(ref.filename).toMatch(/^lumen_[0-9a-f]{16}\.mp4$/)
    expect(((comfy.requests.at(-1)!.body as FormData).get('image') as File).size).toBe(2048)
    await expect(uploadToComfy({ kind: 'media', url: `lumen-media://file/${encodeURIComponent(path.join(env.root, 'secret.mp4'))}` })).rejects.toThrow(/only sends ComfyUI files from the project’s media/)
  })
})

describe('runs', () => {
  it('queue the workflow with the run’s values, follow it, and bring what it saved into the media', async () => {
    const wf = await importWorkflowJson(JSON.stringify(TXT2IMG), 'Text to image')
    finishWith(
      { '9': { images: [{ filename: 'ComfyUI_00001_.png', subfolder: '', type: 'output' }, { filename: 'ComfyUI_00002_.png', subfolder: '', type: 'output' }] } },
      { 'output//ComfyUI_00001_.png': png(), 'output//ComfyUI_00002_.png': png(2) },
    )
    const run = await runComfyWorkflow({ workflowId: wf.id, prompt: 'a red fox in fresh snow', negative: 'blurry', seed: 1234, steps: 25 })
    expect(run.seeds).toEqual({ '3.seed': 1234 })
    expect(run.job).toMatchObject({ integration: 'comfyui', status: 'running', title: 'Text to image · a red fox in fresh' })
    const submitted = comfy.prompts[0]
    expect(submitted.prompt['6'].inputs.text).toBe('a red fox in fresh snow')
    expect(submitted.prompt['7'].inputs.text).toBe('blurry')
    expect(submitted.prompt['3'].inputs).toMatchObject({ seed: 1234, steps: 25 })
    expect(String(FakeSocket.sockets[0].url)).toContain(`clientId=${submitted.client_id}`)

    const job = await settled(run.job.id)
    expect(job.status).toBe('done')
    expect(job.message).toBe('2 images')
    expect(job.assets).toHaveLength(2)
    const [first, second] = job.assets!
    expect(first).toMatchObject({ name: 'Text to image — a red fox in fresh 1', kind: 'image', width: 640, height: 360, alpha: true, provenance: { integration: 'comfyui', tool: 'Text to image', prompt: 'a red fox in fresh snow', params: { workflow: wf.id, seeds: { '3.seed': 1234 }, negative: 'blurry', steps: 25 } } })
    expect(second.alpha).toBeUndefined()
    expect(first.source).toMatchObject({ type: 'file', mime: 'image/png', fileName: 'ComfyUI_00001_.png' })
    const saved = first.source.type === 'file' ? first.source.path! : ''
    expect(saved).toBe(path.join(mediaRoot(), 'comfyui', run.job.id, 'ComfyUI_00001_.png'))
    expect(fs.existsSync(saved)).toBe(true)
    // Progress came from the websocket.
    expect(FakeSocket.sockets[0].readyState).toBe(3)
  })

  it('draw a new seed each run by default, within the range the server gives', async () => {
    // Another address, so what it says about KSampler is asked afresh.
    comfy.defs.KSampler = { ...BASE_DEFS.KSampler, input: { required: { ...BASE_DEFS.KSampler.input.required, seed: ['INT', { min: 0, max: 1000 }] } } }
    await configureComfy({ url: 'http://comfy-box:8188' })
    const wf = await importWorkflowJson(JSON.stringify(TXT2IMG), 'Text to image')
    finishWith({})
    const a = await runComfyWorkflow({ workflowId: wf.id })
    await settled(a.job.id)
    const seed = comfy.prompts[0].prompt['3'].inputs.seed
    expect(a.seeds['3.seed']).toBe(seed)
    expect(seed).toBeGreaterThanOrEqual(0)
    expect(seed).toBeLessThanOrEqual(1000)
    expect(getJob(a.job.id)?.message).toBe('Finished — it saved nothing Lumen can bring in.')
  })

  it('keep 3D models as files and bring back the text a workflow shows; leave other files in ComfyUI', async () => {
    const wf = await importWorkflowJson(JSON.stringify({ ...TXT2IMG, '9': { class_type: 'SaveGLB', inputs: { filename_prefix: 'mesh/x', mesh: ['8', 0] } }, '10': { class_type: 'ShowText|pysssss', inputs: { text: ['8', 0] } } }), 'Mesh')
    finishWith({ '9': { '3d': [{ filename: 'x_00001_.glb', subfolder: 'mesh', type: 'output' }, { filename: 'tool.exe', subfolder: '', type: 'output' }] }, '10': { text: ['A low-poly fox.'] } }, { 'output/mesh/x_00001_.glb': Uint8Array.from([103, 108, 84, 70]) })
    const run = await runComfyWorkflow({ workflowId: wf.id })
    const job = await settled(run.job.id)
    expect(job.status).toBe('done')
    expect(job.assets).toEqual([])
    expect(job.files).toEqual([{ name: 'x_00001_.glb', path: path.join(mediaRoot(), 'comfyui', run.job.id, 'x_00001_.glb') }])
    expect(job.result?.text).toEqual(['A low-poly fox.'])
    expect(job.message).toBe('1 3D model · 1 text output')
    expect(comfy.requests.some((r) => r.url.searchParams.get('filename') === 'tool.exe')).toBe(false)
  })

  it('are followed by polling when the websocket can’t open', async () => {
    FakeSocket.refuse = true
    const wf = await importWorkflowJson(JSON.stringify(TXT2IMG), 'Text to image')
    comfy.onPrompt = (id) => {
      comfy.pending = []
      comfy.history[id] = { outputs: { '9': { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] } }, status: { status_str: 'success', completed: true, messages: [] } }
      comfy.files['output//a.png'] = png()
    }
    const run = await runComfyWorkflow({ workflowId: wf.id })
    const job = await settled(run.job.id)
    expect(job).toMatchObject({ status: 'done', message: '1 image' })
  })

  it('fail at once, saying why, when ComfyUI won’t take the workflow or lacks its nodes', async () => {
    const wf = await importWorkflowJson(JSON.stringify(TXT2IMG), 'Text to image')
    comfy.reject = { error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation' }, node_errors: { '4': { errors: [{ message: 'Value not in list', details: "ckpt_name: 'sd15.safetensors' not in []" }], class_type: 'CheckpointLoaderSimple' } } }
    await expect(runComfyWorkflow({ workflowId: wf.id })).rejects.toThrow(/won’t run this workflow: Prompt outputs failed validation\nCheckpointLoaderSimple \(node 4\): Value not in list/)
    expect(FakeSocket.sockets.every((s) => s.readyState === 3)).toBe(true)

    comfy.reject = null
    // The server has nothing called MysteryNode.
    const odd = await importWorkflowJson(JSON.stringify({ ...TXT2IMG, '10': { class_type: 'MysteryNode', inputs: {} } }), 'Odd')
    await expect(runComfyWorkflow({ workflowId: odd.id })).rejects.toThrow(/doesn’t have .*MysteryNode.*custom nodes this workflow needs/)
    await expect(runComfyWorkflow({ workflowId: 'wf_00000000' })).rejects.toThrow(/no workflow “wf_00000000” in Lumen’s ComfyUI library\. It has:/)
  })

  it('report a node’s failure with what ComfyUI said', async () => {
    const wf = await importWorkflowJson(JSON.stringify(TXT2IMG), 'Text to image')
    comfy.onPrompt = (id) => {
      const ws = FakeSocket.sockets.at(-1)!
      comfy.history[id] = { outputs: {}, status: { status_str: 'error', completed: false, messages: [['execution_error', { prompt_id: id, node_id: '3', node_type: 'KSampler', exception_message: 'Allocation on device' }]] } }
      ws.send('execution_error', { prompt_id: id, node_id: '3', node_type: 'KSampler', exception_message: 'Allocation on device' })
    }
    const run = await runComfyWorkflow({ workflowId: wf.id })
    const job = await settled(run.job.id)
    expect(job.status).toBe('error')
    expect(job.error).toBe('KSampler (node 3) failed: Allocation on device The graphics card ran out of memory: try a smaller size, fewer frames or a smaller batch.')
  })

  it('cancel by interrupting the run when it is executing, or taking it out of the queue when it isn’t', async () => {
    const wf = await importWorkflowJson(JSON.stringify(TXT2IMG), 'Text to image')
    comfy.onPrompt = (id) => {
      comfy.pending = comfy.pending.filter((p) => p !== id)
      comfy.running = [id]
    }
    const running = await runComfyWorkflow({ workflowId: wf.id })
    await sleep(30)
    cancelJob(running.job.id)
    for (let i = 0; i < 100 && !comfy.requests.some((r) => r.method === 'POST' && r.url.pathname === '/interrupt'); i++) await sleep(10)
    const interrupt = comfy.requests.find((r) => r.method === 'POST' && r.url.pathname === '/interrupt')
    expect(interrupt?.body).toEqual({ prompt_id: comfy.prompts[0].id })
    expect(getJob(running.job.id)?.status).toBe('cancelled')

    comfy.onPrompt = () => {}
    comfy.running = ['someone-else']
    const queued = await runComfyWorkflow({ workflowId: wf.id })
    cancelJob(queued.job.id)
    for (let i = 0; i < 100 && comfy.pending.length; i++) await sleep(10)
    expect(comfy.pending).toEqual([])
    expect(comfy.requests.filter((r) => r.url.pathname === '/interrupt')).toHaveLength(1)
    expect(fs.existsSync(path.join(mediaRoot(), 'comfyui', queued.job.id))).toBe(false)
  })

  it('list the library with what the server said about its nodes', async () => {
    await importWorkflowJson(JSON.stringify(TXT2IMG), 'Text to image')
    comfy.defs.KSampler = { ...BASE_DEFS.KSampler, input: { required: { ...BASE_DEFS.KSampler.input.required, steps: ['INT', { min: 1, max: 50 }] } } }
    await configureComfy({ url: 'http://localhost:8188' })
    const wf = listWorkflows().find((w) => w.name === 'Text to image')!
    expect(wf.inputs.find((i) => i.role === 'steps')).toMatchObject({ min: 1, max: 50 })
  })
})
