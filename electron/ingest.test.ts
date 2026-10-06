import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IngestClip, IngestState } from '../shared/ingest'

const env = vi.hoisted(() => ({ root: '', sent: [] as { channel: string; payload: unknown }[] }))

vi.mock('electron', () => ({
  app: { getPath: (name: string) => path.join(env.root, name), getVersion: () => '9.9.9' },
  dialog: {},
  BrowserWindow: class {},
}))

env.root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-ingest-test-'))
const ingest = await import('./ingest')
const { finishExport } = await import('./export')

afterAll(async () => {
  await ingest.stopIngest(false)
  fs.rmSync(env.root, { recursive: true, force: true })
})

/** A stand-in for the editor window: collects what the receiver tells it. */
const editor = {
  isDestroyed: () => false,
  on: () => editor,
  webContents: { send: (channel: string, payload: unknown) => void env.sent.push({ channel, payload }), on: () => {} },
}

let base = ''
let token = ''

beforeAll(async () => {
  ingest.initIngest(editor as never)
  const state = await ingest.startIngest(false)
  expect(state.running).toBe(true)
  base = state.url!
  token = state.token
})

beforeEach(() => {
  env.sent.length = 0
  ingest.attachEditor()
})

const auth = () => ({ Authorization: `Bearer ${token}` })
const call = (method: string, route: string, body?: unknown, headers: Record<string, string> = auth()) =>
  fetch(base + route, {
    method,
    headers: { ...headers, ...(body !== undefined && !(body instanceof Uint8Array) ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : body instanceof Uint8Array ? (body as unknown as Blob) : JSON.stringify(body),
  })

const W = 16
const H = 16
const frame = (value: number) => new Uint8Array(W * H * 4).fill(value)

async function newClip(extra: Record<string, unknown> = {}) {
  const res = await call('POST', '/clips', { name: 'shot_01', width: W, height: H, fps: 30, frames: 3, format: 'rgba', ...extra })
  expect(res.status).toBe(201)
  return ((await res.json()) as { clip_id: string }).clip_id
}

/** What the editor's encoder does: take frames until the clip ends. */
async function drainAsEncoder(id: string) {
  const got: { index: number; first: number; bytes: number }[] = []
  for (;;) {
    const res = await ingest.serveIngest(new Request(`lumen-media://ingest/${id}/next`))
    if (res.status === 202) continue
    if (res.status !== 200) return { got, end: res.status }
    const data = new Uint8Array(await res.arrayBuffer())
    got.push({ index: Number(res.headers.get('x-frame-index')), first: data[0], bytes: data.byteLength })
  }
}

describe('the frame-ingest receiver', () => {
  it('answers browser preflights without a token, and nothing else', async () => {
    const pre = await call('OPTIONS', '/clips/x/frames/0', undefined, { Origin: 'https://cfx-nui-gs-cinematic-studio', 'Access-Control-Request-Method': 'PUT' })
    expect(pre.status).toBe(204)
    expect(pre.headers.get('access-control-allow-origin')).toBe('*')
    expect(pre.headers.get('access-control-allow-methods')).toContain('PUT')
    expect(pre.headers.get('access-control-allow-headers')).toContain('Authorization')
    expect(pre.headers.get('access-control-allow-private-network')).toBe('true')

    const denied = await call('GET', '/health', undefined, {})
    expect(denied.status).toBe(401)
    expect(denied.headers.get('access-control-allow-origin')).toBe('*')
    expect(((await denied.json()) as { error: string }).error).toBe('unauthorized')
    expect((await call('GET', '/health', undefined, { Authorization: 'Bearer nope' })).status).toBe(401)

    const health = (await (await call('GET', '/health')).json()) as { ok: boolean; app: string; version: string; formats: string[] }
    expect(health).toMatchObject({ ok: true, app: 'lumen', version: '9.9.9' })
    expect(health.formats).toEqual(expect.arrayContaining(['rgba', 'png']))
  })

  it('takes a clip’s frames in order and hands them to the encoder', async () => {
    const id = await newClip({ meta: { source: 'gs-cinematic-studio', shot: '04' } })
    const announced = env.sent.find((m) => (m.payload as IngestClip | undefined)?.id === id)?.payload as IngestClip
    expect(announced).toMatchObject({ name: 'shot_01', width: W, height: H, fps: 30, status: 'receiving', quality: 'master', meta: { source: 'gs-cinematic-studio', shot: '04' } })

    const session = ingest.openSession(id, false)
    expect(session.nextUrl).toBe(`lumen-media://ingest/${id}/next`)
    expect(session.master.path.endsWith('shot_01.mp4')).toBe(true)
    expect(session.proxy).toBeNull()

    const encoder = drainAsEncoder(id)
    for (let i = 0; i < 3; i++) expect((await call('PUT', `/clips/${id}/frames/${i}`, frame(10 + i))).status).toBe(204)
    expect(((await (await call('GET', `/clips/${id}`)).json()) as { status: string; received: number }).received).toBe(3)

    const fin = await call('POST', `/clips/${id}/finish`, { frames: 3 })
    expect(fin.status).toBe(202)
    expect(await fin.json()).toEqual({ status: 'assembling' })
    expect(await encoder).toEqual({ got: [0, 1, 2].map((i) => ({ index: i, first: 10 + i, bytes: W * H * 4 })), end: 204 })

    // The editor writes the file and reports in.
    const written = finishExport(session.master.id)
    expect(ingest.completeClip(id, { assetId: 'asset_1', path: written.path, bytes: 1234, codec: 'VP9 4:4:4', durationSeconds: 0.1 })).toBe(true)
    expect(await (await call('GET', `/clips/${id}`)).json()).toMatchObject({ status: 'done', received: 3, frames: 3, asset_id: 'asset_1', path: written.path, duration_seconds: 0.1, codec: 'VP9 4:4:4', bytes: 1234 })
  })

  it('refuses frames of the wrong size, out of order, or after the end', async () => {
    const id = await newClip()
    ingest.openSession(id, false)
    const short = await call('PUT', `/clips/${id}/frames/0`, new Uint8Array(100))
    expect(short.status).toBe(400)
    expect(await short.json()).toMatchObject({ error: 'bad_frame_size', expected: W * H * 4, got: 100 })

    const skipped = await call('PUT', `/clips/${id}/frames/1`, frame(1))
    expect(skipped.status).toBe(409)
    expect(await skipped.json()).toMatchObject({ error: 'out_of_order', expected: 0 })

    expect((await call('PUT', `/clips/${id}/frames/0`, frame(1))).status).toBe(204)
    // The same frame again (the sender never saw the answer): accepted, not counted twice.
    expect((await call('PUT', `/clips/${id}/frames/0`, frame(1))).status).toBe(204)
    expect(((await (await call('GET', `/clips/${id}`)).json()) as { received: number }).received).toBe(1)

    const mismatch = await call('POST', `/clips/${id}/finish`, { frames: 3 })
    expect(mismatch.status).toBe(409)
    expect(await mismatch.json()).toMatchObject({ error: 'frame_count_mismatch', received: 1 })
    expect((await call('POST', `/clips/${id}/finish`, { frames: 1 })).status).toBe(202)
    expect((await call('PUT', `/clips/${id}/frames/1`, frame(2))).status).toBe(409)
    expect((await call('PUT', '/clips/nope/frames/0', frame(1))).status).toBe(404)
  })

  it('checks what a clip asks for', async () => {
    const bad = async (patch: Record<string, unknown>) => {
      const res = await call('POST', '/clips', { name: 'x', width: W, height: H, fps: 30, frames: 1, ...patch })
      return [res.status, ((await res.json()) as { error: string }).error]
    }
    expect(await bad({ width: 15 })).toEqual([400, 'bad_size'])
    expect(await bad({ width: 17 })).toEqual([400, 'bad_size'])
    expect(await bad({ width: 20000 })).toEqual([400, 'too_large'])
    expect(await bad({ fps: 0 })).toEqual([400, 'bad_fps'])
    expect(await bad({ format: 'jpeg' })).toEqual([400, 'bad_format'])
    expect(await bad({ quality: 'best' })).toEqual([400, 'bad_quality'])
    const res = await fetch(`${base}/clips`, { method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json' }, body: '{not json' })
    expect(res.status).toBe(400)
  })

  it('makes a fast sender wait for the encoder instead of piling frames up', async () => {
    const id = await newClip({ frames: 6 })
    ingest.openSession(id, false)
    let answered = 0
    const puts = (async () => {
      for (let i = 0; i < 4; i++) {
        expect((await call('PUT', `/clips/${id}/frames/${i}`, frame(i))).status).toBe(204)
        answered++
      }
    })()
    await new Promise((r) => setTimeout(r, 250))
    // Two frames fit in the queue; the third waits for the encoder to take one.
    expect(answered).toBe(2)
    const first = await ingest.serveIngest(new Request(`lumen-media://ingest/${id}/next`))
    expect(first.headers.get('x-frame-index')).toBe('0')
    await new Promise((r) => setTimeout(r, 150))
    expect(answered).toBe(3)
    const rest = drainAsEncoder(id)
    await puts
    await call('POST', `/clips/${id}/finish`, { frames: 4 })
    expect((await rest).got.map((g) => g.index)).toEqual([1, 2, 3])
  })

  it('discards everything when the sender deletes a clip', async () => {
    const id = await newClip()
    const session = ingest.openSession(id, true)
    expect(session.proxy).not.toBeNull()
    await call('PUT', `/clips/${id}/frames/0`, frame(1))
    expect(fs.existsSync(`${session.master.path}.partial`)).toBe(true)
    const waiting = ingest.serveIngest(new Request(`lumen-media://ingest/${id}/next`)).then(() => ingest.serveIngest(new Request(`lumen-media://ingest/${id}/next`)))

    expect((await call('DELETE', `/clips/${id}`)).status).toBe(204)
    expect((await waiting).status).toBe(410)
    expect(fs.existsSync(`${session.master.path}.partial`)).toBe(false)
    expect(fs.existsSync(`${session.proxy!.path}.partial`)).toBe(false)
    expect((await call('GET', `/clips/${id}`)).status).toBe(404)
    // If the editor had just finished the file, it is told to drop it.
    expect(ingest.completeClip(id, { assetId: 'a', path: session.master.path, bytes: 1, codec: 'x', durationSeconds: 1 })).toBe(false)
  })

  it('keeps a long cue sheet with the clip, and out of the lists', async () => {
    // A long scene: about 200 KB of cues, more than an ordinary request may be.
    const cues = Array.from({ length: 1500 }, (_, i) => ({ at: i / 10, frame: 440 + i * 3, kind: 'speech', speaker: 'Boss', text: `Line ${i}: ${'you are late '.repeat(6)}`, seconds: 1.5 }))
    expect(JSON.stringify(cues).length).toBeGreaterThan(150_000)
    const id = await newClip({ meta: { source: 'gs-cinematic-studio', shot: 'Arrival', samples: 8, cues } })
    // The editor gets all of it, once, with the clip…
    const announced = env.sent.find((m) => (m.payload as IngestClip).id === id)?.payload as IngestClip
    expect(announced.meta.cues).toHaveLength(1500)
    expect(ingest.openSession(id, false).clip.meta).toEqual({ source: 'gs-cinematic-studio', shot: 'Arrival', samples: 8, cues })
    // …while what is sent with every progress note only counts it.
    expect(ingest.ingestState().clips.find((c) => c.id === id)?.meta).toEqual({ source: 'gs-cinematic-studio', shot: 'Arrival', samples: 8, cues: 1500 })
    expect((await call('DELETE', `/clips/${id}`)).status).toBe(204)

    const tooBig = await call('POST', '/clips', { name: 'x', width: W, height: H, fps: 30, meta: { junk: 'x'.repeat(3 * 1024 * 1024) } })
    expect(tooBig.status).toBe(413)
  })

  it('gives two clips with one name their own files, and needs the editor', async () => {
    const a = ingest.openSession(await newClip({ name: 'Shot: 1/2?' }), false)
    const b = ingest.openSession(await newClip({ name: 'Shot: 1/2?' }), false)
    expect(path.basename(a.master.path)).toBe('Shot 1 2.mp4')
    expect(path.basename(b.master.path)).toBe('Shot 1 2 (2).mp4')

    // The editor reloaded: clips that were arriving can't be picked up again.
    const state: IngestState = ingest.attachEditor()
    expect(state.clips.filter((c) => c.status === 'error').length).toBeGreaterThanOrEqual(2)
    const late = await call('PUT', `/clips/${a.clip.id}/frames/0`, frame(1))
    expect(late.status).toBe(409)
    expect(((await late.json()) as { error: string }).error).toBe('clip_failed')
  })
})
