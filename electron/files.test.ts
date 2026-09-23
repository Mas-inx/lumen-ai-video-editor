import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

type Handler = (req: Request) => Promise<Response>
const env = vi.hoisted(() => ({ root: '', handler: null as ((req: Request) => Promise<Response>) | null }))

vi.mock('electron', () => ({
  app: { getPath: (name: string) => path.join(env.root, name), getVersion: () => '1.0.0' },
  dialog: {},
  BrowserWindow: class {},
  net: {},
  shell: {},
  protocol: {
    handle: (_scheme: string, fn: Handler) => {
      env.handler = fn
    },
  },
}))

env.root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-files-test-'))
const { fileInfo, registerMediaProtocol, saveMedia, urlFor } = await import('./files')
registerMediaProtocol()
const serve = (url: string, init?: RequestInit) => env.handler!(new Request(url, init))

afterAll(() => fs.rmSync(env.root, { recursive: true, force: true }))

const bytes = Uint8Array.from({ length: 100 }, (_, i) => i)
const file = path.join(env.root, 'Footage', 'clip.mp4')
fs.mkdirSync(path.dirname(file), { recursive: true })
fs.writeFileSync(file, bytes)

describe('lumen-media protocol', () => {
  it('only serves files the editor was given', async () => {
    const res = await serve(urlFor(file))
    expect(res.status).toBe(404)
  })

  it('serves registered files whole, with their type', async () => {
    const info = fileInfo(file)!
    expect(info).toMatchObject({ name: 'clip.mp4', size: 100, mime: 'video/mp4' })
    const res = await serve(info.url)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('video/mp4')
    expect(res.headers.get('content-length')).toBe('100')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes)
  })

  it('answers byte ranges for seeking', async () => {
    const url = fileInfo(file)!.url
    const res = await serve(url, { headers: { Range: 'bytes=10-19' } })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 10-19/100')
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19])

    const open = await serve(url, { headers: { Range: 'bytes=95-' } })
    expect(open.headers.get('content-range')).toBe('bytes 95-99/100')

    const suffix = await serve(url, { headers: { Range: 'bytes=-3' } })
    expect(Array.from(new Uint8Array(await suffix.arrayBuffer()))).toEqual([97, 98, 99])

    const past = await serve(url, { headers: { Range: 'bytes=100-' } })
    expect(past.status).toBe(416)
    expect(past.headers.get('content-range')).toBe('bytes */100')
  })

  it('answers HEAD and CORS preflight without a body', async () => {
    const url = fileInfo(file)!.url
    const head = await serve(url, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe('100')
    const pre = await serve(url, { method: 'OPTIONS' })
    expect(pre.status).toBe(204)
    expect(pre.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('saves generated media into the library and serves it', async () => {
    const info = saveMedia('generated', 'Sunset shot.png', Uint8Array.from([1, 2, 3]))
    expect(info.path.startsWith(path.join(env.root, 'userData', 'media', 'generated'))).toBe(true)
    expect(info.name).toMatch(/^Sunset shot-[0-9a-f]{8}\.png$/)
    const res = await serve(info.url)
    expect(res.status).toBe(200)
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([1, 2, 3])
  })

  it('never escapes the media library', async () => {
    fs.writeFileSync(path.join(env.root, 'userData', 'secret.txt'), 'nope')
    const res = await serve('lumen-media://local/..%2F..%2Fsecret.txt')
    expect(res.status).toBe(404)
  })
})
