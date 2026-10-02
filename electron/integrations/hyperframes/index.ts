import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { session, type BrowserWindow } from 'electron'
import { exactOffscreenWindow } from '../../offscreen'
import type { GeneratedAsset, Job, MotionRenderRequest } from '../../../shared/integrations'
import { createJob, failJob, finishJob, isCancelled, setCanceller, updateJob } from '../jobs'
import { jobDir, mediaUrl, packageFile, workDir } from '../paths'
import { buildTemplate, fontFaces, TEMPLATE_NAMES, templateDuration } from './templates'

/**
 * HyperFrames rendering, natively inside Lumen: the composition loads in a
 * hidden, transparent, sandboxed Chromium window with the HyperFrames runtime
 * injected, then every frame is seeked with the runtime's own `renderSeek`
 * (the same frame-exact path its CLI renderer uses) and captured to PNG.
 * No FFmpeg or headless-Chrome download needed.
 */

const PARTITION = 'lumen-motion'
/** Remote hosts a composition may load from (fonts and common animation libraries). */
const ALLOWED_HOSTS = /(^|\.)(fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com)$/

let sessionReady = false

function renderSession() {
  const ses = session.fromPartition(PARTITION)
  if (!sessionReady) {
    sessionReady = true
    ses.webRequest.onBeforeRequest((details, cb) => {
      const url = new URL(details.url)
      if (url.protocol === 'file:' || url.protocol === 'data:' || url.protocol === 'blob:') return cb({})
      cb({ cancel: !(url.protocol === 'https:' && ALLOWED_HOSTS.test(url.hostname)) })
    })
    ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false))
  }
  return ses
}

/** Lumen's typefaces for a composition written from scratch (templates carry them already). */
function withFonts(html: string) {
  const style = `<style data-lumen-fonts>${fontFaces()}</style>`
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}\n${style}`) : style + html
}

/** Points GSAP (and its plugins) at the bundled copies instead of a CDN, and injects the runtime. */
function prepareHtml(html: string) {
  const gsapDir = path.dirname(packageFile('gsap', 'dist/gsap.min.js'))
  const local = (file: string) => pathToFileURL(path.join(gsapDir, file)).href
  let out = html.replace('__GSAP__', local('gsap.min.js'))
  out = out.replace(/<script([^>]*?)\ssrc=["']([^"']*gsap[^"']*)["']([^>]*)><\/script>/gi, (tag, pre: string, src: string, post: string) => {
    const file = src.split('/').pop()?.split('?')[0] ?? ''
    if (!/\.js$/.test(file)) return tag
    const name = /^gsap(\.min)?\.js$/i.test(file) ? 'gsap.min.js' : file.replace(/(\.min)?\.js$/i, '.min.js')
    return fs.existsSync(path.join(gsapDir, name)) ? `<script${pre} src="${local(name)}"${post}></script>` : tag
  })
  const runtime = pathToFileURL(packageFile('@hyperframes/core', 'dist/hyperframe.runtime.iife.js')).href
  const inject = `<script src="${runtime}"></script>
<script>
window.__lumenSeek = async (t) => {
  window.__player.renderSeek(t);
  const t0 = performance.now();
  while (window.__renderReady === false && performance.now() - t0 < 4000) await new Promise((r) => setTimeout(r, 4));
  if (document.fonts && document.fonts.status !== 'loaded') await document.fonts.ready;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return true;
};
</script>`
  return /<\/body>/i.test(out) ? out.replace(/<\/body>/i, `${inject}\n</body>`) : out + inject
}

async function waitFor(win: BrowserWindow, expr: string, timeoutMs: number) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (win.isDestroyed()) throw new Error('Renderer closed')
    if (await win.webContents.executeJavaScript(`Boolean(${expr})`)) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('The composition never became ready — check that it registers window.__timelines["<composition id>"].')
}

export async function renderMotion(req: MotionRenderRequest): Promise<Job> {
  const label = req.name ?? TEMPLATE_NAMES[req.template]
  const job = createJob('hyperframes', label)
  void run(job.id, req, label).catch((err) => failJob(job.id, err))
  return job
}

async function run(jobId: string, req: MotionRenderRequest, label: string) {
  const out = jobDir('hyperframes', jobId)
  const work = workDir('hyperframes', jobId)
  const { width, height, fps } = req
  let html: string
  if (req.template === 'custom') {
    if (!req.html) throw new Error('A custom motion graphic needs its HyperFrames HTML.')
    html = withFonts(req.html)
  } else {
    html = buildTemplate(req.template, req.params, { width, height, duration: req.duration ?? templateDuration(req.template, req.params) })
  }
  const htmlPath = path.join(work, 'composition.html')
  fs.writeFileSync(htmlPath, prepareHtml(html))

  updateJob(jobId, { message: 'Loading composition…' })
  // Exactly width×height on any display scaling (a plain window this size would be cut to the screen and render off centre).
  const { win } = exactOffscreenWindow(width, height, {
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    enableLargerThanScreen: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      session: renderSession(),
    },
  })
  setCanceller(jobId, () => {
    if (!win.isDestroyed()) win.destroy()
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  // Frames are stepped by seeking, so a fast paint clock only shortens the wait per frame.
  win.webContents.setFrameRate(240)

  try {
    await win.loadFile(htmlPath)
    await waitFor(win, 'window.__playerReady && window.__player', 20_000)
    const duration = req.duration ?? (req.template === 'custom' ? Number(await win.webContents.executeJavaScript('window.__player.getDuration()')) : templateDuration(req.template, req.params))
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('The composition has no duration.')
    const frames = Math.max(1, Math.round(duration * fps))
    updateJob(jobId, { message: `Rendering ${frames} frames` })

    for (let i = 0; i < frames; i++) {
      if (isCancelled(jobId) || win.isDestroyed()) return
      await win.webContents.executeJavaScript(`window.__lumenSeek(${i / fps})`)
      let image = await win.webContents.capturePage()
      const size = image.getSize()
      if (size.width !== width || size.height !== height) image = image.resize({ width, height, quality: 'best' })
      fs.writeFileSync(path.join(out, `frame_${String(i + 1).padStart(4, '0')}.png`), image.toPNG())
      updateJob(jobId, { progress: Math.min(0.99, (i + 1) / frames), message: `Frame ${i + 1} of ${frames}` })
    }

    const base = `${mediaUrl(out)}/`
    const asset: GeneratedAsset = {
      name: label,
      kind: 'video',
      source: { type: 'sequence', base, dir: out, pattern: 'frame_%04d.png', frameCount: frames, fps, poster: base + `frame_${String(Math.max(1, Math.floor(frames * 0.5))).padStart(4, '0')}.png` },
      width,
      height,
      fps,
      duration: frames / fps,
      alpha: true,
      provenance: { integration: 'hyperframes', tool: req.template, prompt: req.prompt, params: req.html ? { ...req.params, html: req.html } : req.params },
    }
    finishJob(jobId, { assets: [asset], message: `${frames} frames` })
  } finally {
    if (!win.isDestroyed()) win.destroy()
    fs.rmSync(work, { recursive: true, force: true })
    if (isCancelled(jobId)) fs.rmSync(out, { recursive: true, force: true })
  }
}
