import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import type { BlenderInfo, BlenderLiveResult, BlenderRenderRequest, GeneratedAsset, Job } from '../../../shared/integrations'
import { createJob, failJob, finishJob, isCancelled, setCanceller, updateJob } from '../jobs'
import { jobDir, mediaUrl, packageFile, readJson, workDir, writeJson } from '../paths'
import runnerSource from './runner.py?raw'

/**
 * Blender, two ways:
 *  - headless renders: `blender -b` runs runner.py against a JSON spec and
 *    writes a transparent PNG sequence into Lumen's media library;
 *  - live control: when Blender is open with the BlenderMCP add-on, bpy code
 *    is sent to its socket (localhost:9876) and runs in the user's scene.
 */

const SETTINGS = 'blender.json'
const LIVE_PORT = 9876
const exe = process.platform === 'win32' ? 'blender.exe' : 'blender'

interface Settings {
  path?: string
}

function versionKey(dir: string) {
  const m = dir.match(/(\d+)\.(\d+)(?:\.(\d+))?/)
  return m ? Number(m[1]) * 10_000 + Number(m[2]) * 100 + Number(m[3] ?? 0) : 0
}

function candidates(): string[] {
  const list: string[] = []
  const custom = readJson<Settings>(SETTINGS, {}).path
  if (custom) list.push(custom)
  if (process.env.LUMEN_BLENDER) list.push(process.env.LUMEN_BLENDER)
  if (process.platform === 'win32') {
    for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'C:\\Program Files']) {
      if (!root) continue
      const base = path.join(root, 'Blender Foundation')
      try {
        const dirs = fs.readdirSync(base).filter((d) => /blender/i.test(d))
        dirs.sort((a, b) => versionKey(b) - versionKey(a))
        list.push(...dirs.map((d) => path.join(base, d, exe)))
      } catch {
        /* not installed here */
      }
    }
    list.push('C:\\Program Files (x86)\\Steam\\steamapps\\common\\Blender\\blender.exe')
  } else if (process.platform === 'darwin') {
    list.push('/Applications/Blender.app/Contents/MacOS/Blender', path.join(os.homedir(), 'Applications/Blender.app/Contents/MacOS/Blender'))
  } else {
    list.push('/usr/bin/blender', '/usr/local/bin/blender', '/snap/bin/blender')
  }
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) if (dir) list.push(path.join(dir, exe))
  return [...new Set(list)].filter((p) => {
    try {
      return fs.statSync(p).isFile()
    } catch {
      return false
    }
  })
}

function readVersion(file: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(file, ['--version'], { timeout: 30_000, windowsHide: true }, (_err, stdout) => {
      resolve(stdout?.match(/Blender\s+(\d+\.\d+(?:\.\d+)?)/)?.[1])
    })
  })
}

function probeLive(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: LIVE_PORT })
    const done = (ok: boolean) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(400, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

let cached: Omit<BlenderInfo, 'live'> | null = null

export async function detectBlender(force = false): Promise<BlenderInfo> {
  if (!cached || force) {
    cached = { found: false }
    for (const file of candidates()) {
      const version = await readVersion(file)
      if (version) {
        cached = { found: true, path: file, version }
        break
      }
    }
  }
  return { ...cached, live: await probeLive() }
}

export async function setBlenderPath(file: string | null): Promise<BlenderInfo> {
  writeJson(SETTINGS, file ? { path: file } : {})
  return detectBlender(true)
}

// ─── Headless renders ────────────────────────────────────────────────────

const FONT_FILES: Record<string, [string, string]> = {
  sans: ['@fontsource/geist', 'files/geist-latin-800-normal.woff'],
  display: ['@fontsource/bricolage-grotesque', 'files/bricolage-grotesque-latin-800-normal.woff'],
  serif: ['@fontsource/instrument-serif', 'files/instrument-serif-latin-400-normal.woff'],
  'serif-italic': ['@fontsource/instrument-serif', 'files/instrument-serif-latin-400-italic.woff'],
}

/** Copies Lumen's title fonts next to the script: Blender can't read inside the app's asar. */
function stageFonts(dir: string) {
  const fonts: Record<string, string> = {}
  for (const [key, [pkg, file]] of Object.entries(FONT_FILES)) {
    try {
      const dest = path.join(dir, path.basename(file))
      fs.copyFileSync(packageFile(pkg, file), dest)
      fonts[key] = dest
    } catch {
      /* Blender falls back to its built-in font */
    }
  }
  return fonts
}

const TEMPLATE_TITLES: Record<string, string> = { title3d: '3D title', shapes: '3D motion background', script: 'Blender scene' }

export async function renderBlender(req: BlenderRenderRequest): Promise<Job> {
  const info = await detectBlender()
  if (!info.found || !info.path) throw new Error('Blender isn’t installed (or Lumen can’t find it). Install Blender 4.2+ or point Lumen at blender.exe in Integrations.')

  const label = req.name ?? (typeof req.params.text === 'string' ? `${req.params.text} — ${TEMPLATE_TITLES[req.template]}` : TEMPLATE_TITLES[req.template])
  const job = createJob('blender', label)
  const out = jobDir('blender', job.id)
  const work = workDir('blender', job.id)
  const transparent = req.transparent ?? req.template !== 'shapes'
  const spec = {
    template: req.template,
    params: req.params,
    script: req.script,
    width: req.width,
    height: req.height,
    fps: req.fps,
    duration: req.duration,
    quality: req.quality ?? 'standard',
    transparent,
    out,
    fonts: stageFonts(work),
  }
  const runnerPath = path.join(work, 'lumen_runner.py')
  const specPath = path.join(work, 'spec.json')
  fs.writeFileSync(runnerPath, runnerSource)
  fs.writeFileSync(specPath, JSON.stringify(spec))

  const child = spawn(info.path, ['-b', '--factory-startup', '-noaudio', '--python-exit-code', '1', '-P', runnerPath, '--', specPath], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  setCanceller(job.id, () => child.kill())
  updateJob(job.id, { message: 'Starting Blender…' })

  const log: string[] = []
  let error: string | undefined
  const onLine = (line: string) => {
    log.push(line)
    if (log.length > 60) log.shift()
    if (!line.startsWith('LUMEN ')) return
    try {
      const msg = JSON.parse(line.slice(6)) as { type: string; message?: string; frame?: number; total?: number }
      if (msg.type === 'status') updateJob(job.id, { message: msg.message })
      else if (msg.type === 'frame' && msg.total) updateJob(job.id, { progress: Math.min(0.99, msg.frame! / msg.total), message: `Rendering frame ${msg.frame} of ${msg.total}` })
      else if (msg.type === 'error') error = msg.message
    } catch {
      /* partial line */
    }
  }
  readline.createInterface({ input: child.stdout! }).on('line', onLine)
  readline.createInterface({ input: child.stderr! }).on('line', (l) => {
    log.push(l)
    if (log.length > 60) log.shift()
  })

  child.on('error', (err) => failJob(job.id, err))
  child.on('close', (code) => {
    if (isCancelled(job.id)) {
      fs.rmSync(out, { recursive: true, force: true })
      return
    }
    const frames = fs.existsSync(out) ? fs.readdirSync(out).filter((f) => /^frame_\d+\.png$/.test(f)).sort() : []
    if (code !== 0 || !frames.length) {
      failJob(job.id, error ?? (log.filter((l) => /error|exception/i.test(l)).slice(-3).join('\n') || `Blender exited with code ${code}`))
      return
    }
    const base = `${mediaUrl(out)}/`
    const asset: GeneratedAsset = {
      name: label,
      kind: 'video',
      source: {
        type: 'sequence',
        base,
        dir: out,
        pattern: 'frame_%04d.png',
        frameCount: frames.length,
        fps: req.fps,
        // Titles are fully formed by the end of their intro.
        poster: base + frames[Math.min(frames.length - 1, Math.floor(frames.length * 0.8))],
      },
      width: req.width,
      height: req.height,
      fps: req.fps,
      duration: frames.length / req.fps,
      alpha: transparent,
      provenance: { integration: 'blender', tool: req.template, prompt: req.prompt, params: req.script ? { ...req.params, script: req.script } : req.params },
    }
    finishJob(job.id, { assets: [asset], message: `${frames.length} frames` })
    fs.rmSync(work, { recursive: true, force: true })
  })
  return job
}

// ─── Live Blender (BlenderMCP add-on socket) ─────────────────────────────

/** Sends bpy code to the Blender window the user has open. */
export function runLive(code: string, timeoutMs = 60_000): Promise<BlenderLiveResult> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: LIVE_PORT })
    let buffer = ''
    const finish = (res: BlenderLiveResult) => {
      socket.destroy()
      resolve(res)
    }
    socket.setTimeout(timeoutMs, () => finish({ ok: false, error: 'Blender didn’t answer in time.' }))
    socket.once('error', () => finish({ ok: false, error: 'Blender isn’t listening. Open Blender and start the BlenderMCP add-on server (port 9876).' }))
    socket.once('connect', () => socket.write(JSON.stringify({ type: 'execute_code', params: { code } })))
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      try {
        const res = JSON.parse(buffer) as { status?: string; result?: unknown; message?: string }
        finish(res.status === 'success' ? { ok: true, result: res.result } : { ok: false, error: res.message ?? 'Blender reported an error.' })
      } catch {
        /* wait for the rest of the message */
      }
    })
  })
}
