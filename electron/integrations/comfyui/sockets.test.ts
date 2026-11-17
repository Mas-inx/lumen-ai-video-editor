import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import { afterAll, describe, expect, it, vi } from 'vitest'

// The client over real sockets — Node's own fetch and WebSocket — against a
// stand-in ComfyUI on 127.0.0.1: what a mocked fetch can't show, like the auth
// header reaching the websocket, a file streaming up as multipart, and the
// progress the editor hears while a run goes.

const env = vi.hoisted(() => ({ root: '' }))

vi.mock('electron', () => ({
  app: { getPath: (name: string) => path.join(env.root, name), getVersion: () => '1.0.0' },
  safeStorage: { isEncryptionAvailable: () => false },
  dialog: {},
  BrowserWindow: { getFocusedWindow: () => null },
  net: {},
  shell: {},
}))

env.root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-comfyui-sockets-'))

/** A 2 × 2 RGBA PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGNgYGD4z8DAwMAAAA0EAQBq0CFNAAAAAElFTkSuQmCC', 'base64')

const DEFS: Record<string, object> = {
  KSampler: { input: { required: { seed: ['INT', { min: 0, max: 1000000 }], steps: ['INT', { min: 1, max: 100 }] } }, output_node: false },
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [['model.safetensors'], {}] } } },
  CLIPTextEncode: { input: { required: { text: ['STRING', { multiline: true }], clip: ['CLIP'] } } },
  SaveImage: { input: { required: { images: ['IMAGE'], filename_prefix: ['STRING', {}] } }, output_node: true },
  LoadImage: { input: { required: { image: [['photo.png'], { image_upload: true }] } } },
}

const seen = { auth: new Set<string>(), socketAuth: '', prompt: null as Record<string, { inputs: Record<string, unknown> }> | null, upload: { name: '', subfolder: '', bytes: 0 } }
const sockets = new Map<string, Duplex>()
const history: Record<string, unknown> = {}

/** One unmasked text frame, as a server sends it. */
function frame(text: string) {
  const payload = Buffer.from(text)
  const head = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff])
  return Buffer.concat([head, payload])
}

const tell = (clientId: string, type: string, data: object) => sockets.get(clientId)?.write(frame(JSON.stringify({ type, data })))

const server = http.createServer(async (req, res) => {
  seen.auth.add(String(req.headers.authorization))
  const url = new URL(req.url ?? '/', 'http://comfyui')
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const body = Buffer.concat(chunks)
  const json = (value: unknown, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))

  if (url.pathname === '/system_stats') return json({ system: { comfyui_version: '0.3.68', python_version: '3.12.10 (main)', pytorch_version: '2.8.0+cu128' }, devices: [{ name: 'cuda:0 NVIDIA GeForce RTX 4090 : cudaMallocAsync', type: 'cuda', vram_total: 1, vram_free: 1 }] })
  if (url.pathname === '/queue') return json({ queue_running: [], queue_pending: [] })
  if (url.pathname.startsWith('/object_info/')) {
    const type = decodeURIComponent(url.pathname.slice('/object_info/'.length))
    return json(DEFS[type] ? { [type]: DEFS[type] } : {})
  }
  if (url.pathname === '/prompt' && req.method === 'POST') {
    const { prompt, client_id } = JSON.parse(body.toString()) as { prompt: typeof seen.prompt; client_id: string }
    seen.prompt = prompt
    const id = 'prompt-1'
    json({ prompt_id: id, number: 1, node_errors: {} })
    setTimeout(() => {
      tell(client_id, 'status', { status: { exec_info: { queue_remaining: 1 } } })
      tell(client_id, 'execution_start', { prompt_id: id })
      tell(client_id, 'executing', { node: '3', prompt_id: id })
      for (let step = 1; step <= 4; step++) tell(client_id, 'progress', { value: step, max: 4, node: '3', prompt_id: id })
      history[id] = { outputs: { '9': { images: [{ filename: 'ComfyUI_00001_.png', subfolder: '', type: 'output' }] } }, status: { status_str: 'success', completed: true, messages: [] } }
      tell(client_id, 'execution_success', { prompt_id: id })
    }, 30)
    return
  }
  if (url.pathname.startsWith('/history/')) {
    const id = url.pathname.slice('/history/'.length)
    return json(history[id] ? { [id]: history[id] } : {})
  }
  if (url.pathname === '/upload/image' && req.method === 'POST') {
    const text = body.toString('latin1')
    seen.upload = { name: /filename="([^"]+)"/.exec(text)?.[1] ?? '', subfolder: /name="subfolder"\r\n\r\n([^\r]*)/.exec(text)?.[1] ?? '', bytes: body.length }
    return json({ name: seen.upload.name, subfolder: seen.upload.subfolder, type: 'input' })
  }
  if (url.pathname === '/view') return res.writeHead(200, { 'content-type': 'image/png' }).end(PNG)
  json({ error: 'not found' }, 404)
})

server.on('upgrade', (req, socket) => {
  seen.socketAuth = String(req.headers.authorization)
  const clientId = new URL(req.url ?? '/', 'http://comfyui').searchParams.get('clientId') ?? ''
  const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
  socket.on('data', () => {})
  socket.on('error', () => {})
  sockets.set(clientId, socket)
})

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
const port = (server.address() as { port: number }).port

afterAll(() => {
  for (const socket of sockets.values()) socket.destroy()
  server.close()
  fs.rmSync(env.root, { recursive: true, force: true })
})

const { configureComfy, importWorkflowJson, runComfyWorkflow, uploadToComfy } = await import('./index')
const { getJob, registerJobListener } = await import('../jobs')
const { mediaRoot, mediaUrl } = await import('../paths')

describe('ComfyUI over real sockets', () => {
  it('uploads, runs and downloads, with the auth header on every request and the websocket, and progress as the editor hears it', async () => {
    const status = await configureComfy({ url: `http://127.0.0.1:${port}`, header: { name: 'Authorization', value: 'Bearer real-token' } })
    expect(status).toMatchObject({ connected: true, version: '0.3.68', devices: [{ name: 'NVIDIA GeForce RTX 4090' }] })

    // A file from the project streams up from disk.
    const footage = path.join(mediaRoot(), 'imports', 'footage.mp4')
    fs.mkdirSync(path.dirname(footage), { recursive: true })
    fs.writeFileSync(footage, Buffer.alloc(5 * 1024 * 1024, 1))
    const file = await uploadToComfy({ kind: 'media', url: mediaUrl(footage) })
    expect(file).toMatchObject({ subfolder: 'lumen', type: 'input' })
    expect(seen.upload).toMatchObject({ name: file.filename, subfolder: 'lumen' })
    expect(seen.upload.bytes).toBeGreaterThan(5 * 1024 * 1024)

    const workflow = await importWorkflowJson(
      JSON.stringify({
        '3': { class_type: 'KSampler', inputs: { seed: 1, steps: 20, positive: ['6', 0], negative: ['7', 0] } },
        '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model.safetensors' } },
        '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a', clip: ['4', 1] } },
        '7': { class_type: 'CLIPTextEncode', inputs: { text: 'b', clip: ['4', 1] } },
        '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'ComfyUI', images: ['3', 0] } },
        '10': { class_type: 'LoadImage', inputs: { image: 'photo.png' } },
      }),
      'Sockets',
    )

    // What the editor window hears about jobs.
    const heard: string[] = []
    registerJobListener({ on: () => {}, isDestroyed: () => false, webContents: { send: (_channel: string, job: { message?: string }) => job.message && heard.at(-1) !== job.message && heard.push(job.message) } } as never)
    const run = await runComfyWorkflow({ workflowId: workflow.id, prompt: 'a fox in the snow', steps: 12, media: [{ node: '10', input: 'image', file }] })
    const started = Date.now()
    while (getJob(run.job.id)?.status === 'running' && Date.now() - started < 8000) await new Promise((r) => setTimeout(r, 10))

    const job = getJob(run.job.id)!
    expect(job.status).toBe('done')
    expect(seen.prompt?.['6'].inputs.text).toBe('a fox in the snow')
    expect(seen.prompt?.['3'].inputs.steps).toBe(12)
    expect(seen.prompt?.['3'].inputs.seed).toBeLessThanOrEqual(1000000)
    expect(seen.prompt?.['10'].inputs.image).toBe(`lumen/${file.filename}`)
    expect(seen.socketAuth).toBe('Bearer real-token')
    expect([...seen.auth]).toEqual(['Bearer real-token'])
    expect(heard).toEqual(['Queued in ComfyUI…', 'Waiting in ComfyUI’s queue (1 queued)', 'Starting…', 'KSampler…', 'KSampler · step 1 of 4', 'KSampler · step 2 of 4', 'KSampler · step 3 of 4', 'KSampler · step 4 of 4', 'Downloading…', '1 image'])
    const image = job.assets![0]
    expect(image).toMatchObject({ kind: 'image', width: 2, height: 2, alpha: true })
    expect(fs.readFileSync(image.source.type === 'file' ? image.source.path! : '')).toEqual(PNG)
  }, 20_000)
})
