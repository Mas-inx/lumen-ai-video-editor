/**
 * Measuring the rendered edit for the edit check (editor/quality.ts): the mix,
 * rendered block by block — levels every 20 ms, loudness, clipped samples — and
 * frames drawn small exactly as the export draws them, plus the box the
 * compositor records for every title and caption. Nothing here touches the
 * live preview.
 */
import { clipEnd } from '@/editor/ops'
import type { FrameSample, SoundMeasure, TextBox } from '@/editor/quality'
import type { Clip, Project } from '@/editor/types'
import { AnalysisCancelled } from './analysis'
import { levelFrames, prepareAudio, renderMix } from './audio-engine'
import { renderFrame } from './compositor'
import { LoudnessMeter } from './loudness'
import { withVideoFrames } from './media'
import { FrameFeeder } from './stills'

interface Progress {
  onProgress?: (done: number) => void
  signal?: AbortSignal
}

const breathe = () => new Promise((r) => setTimeout(r, 0))

/** The mix of timeline seconds [from, to), measured: rendered 20 seconds at a time, so a long edit never sits in memory whole. */
export async function measureSound(project: Project, from: number, to: number, opts: Progress = {}): Promise<SoundMeasure> {
  await prepareAudio(project)
  const rate = 48000
  const meter = new LoudnessMeter(rate)
  const levels: Float32Array[] = []
  const clipped: [number, number][] = []
  for (let t = from; t < to; t += 20) {
    if (opts.signal?.aborted) throw new AnalysisCancelled()
    const b = Math.min(to, t + 20)
    const mix = await renderMix(project, t, b, { sampleRate: rate })
    const channels = Array.from({ length: mix.numberOfChannels }, (_, c) => mix.getChannelData(c))
    meter.push(channels)
    levels.push(levelFrames(mix))
    const win = Math.round(rate / 2)
    for (let i = 0; i < mix.length; i += win) {
      let n = 0
      for (const ch of channels) for (let k = i, e = Math.min(mix.length, i + win); k < e; k++) if (ch[k] >= 0.999 || ch[k] <= -0.999) n++
      if (n) clipped.push([t + i / rate, n])
    }
    opts.onProgress?.((b - from) / Math.max(1e-9, to - from))
    await breathe()
  }
  const r = meter.result()
  const all = new Float32Array(levels.reduce((n, l) => n + l.length, 0))
  let o = 0
  for (const l of levels) {
    all.set(l, o)
    o += l.length
  }
  return { from, levels: all, lufs: r.lufs, peakDb: r.peakDb, clipped }
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)

/** Frames of the timeline drawn 96 pixels wide, as the export draws them: how bright, and a coarse picture to compare. */
export async function measurePicture(project: Project, frames: number[], opts: Progress = {}): Promise<FrameSample[]> {
  const w = 96
  const h = even((w * project.settings.height) / project.settings.width)
  const feeder = new FrameFeeder(project, w, h)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  const out: FrameSample[] = []
  try {
    await document.fonts.ready
    for (const [n, frame] of frames.entries()) {
      if (opts.signal?.aborted) throw new AnalysisCancelled()
      await feeder.prepare(frame)
      withVideoFrames(feeder.frame, () => renderFrame(ctx, project, frame))
      const px = ctx.getImageData(0, 0, w, h).data
      const hist = new Uint32Array(256)
      const grid = new Float64Array(16 * 9)
      const cells = new Uint32Array(16 * 9)
      let sum = 0
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4
          const l = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]
          sum += l
          hist[Math.min(255, Math.round(l))]++
          const cell = Math.min(8, Math.floor((y * 9) / h)) * 16 + Math.min(15, Math.floor((x * 16) / w))
          grid[cell] += l
          cells[cell]++
        }
      }
      let peak = 255
      for (let v = 0, seen = 0, need = w * h * 0.98; v < 256; v++) {
        seen += hist[v]
        if (seen >= need) {
          peak = v
          break
        }
      }
      out.push({ frame, luma: sum / (w * h), peak, grid: Array.from(grid, (g, i) => (cells[i] ? g / cells[i] : 0)) })
      opts.onProgress?.((n + 1) / frames.length)
      if (n % 8 === 7) await breathe()
    }
  } finally {
    feeder.dispose()
  }
  return out
}

/** A frame where a title has settled: past its entrance, before its exit. */
function settled(clip: Clip) {
  const into = clip.animation.in.preset !== 'none' ? clip.animation.in.duration : 0
  const outOf = clip.duration - (clip.animation.out.preset !== 'none' ? clip.animation.out.duration : 0)
  return Math.min(clipEnd(clip) - 1, clip.start + Math.floor((into + Math.max(into, outOf)) / 2))
}

/** Where every title and caption sits on screen, as the compositor draws it (project pixels). Text alone, so no video is decoded. */
export async function measureTextBoxes(project: Project): Promise<Record<string, TextBox>> {
  const width = Math.min(960, project.settings.width)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = Math.max(2, Math.round((width * project.settings.height) / project.settings.width))
  const ctx = canvas.getContext('2d')!
  await document.fonts.ready
  const visible = new Set(project.tracks.filter((t) => t.kind === 'video' && !t.hidden).map((t) => t.id))
  const out: Record<string, TextBox> = {}
  for (const clip of Object.values(project.clips)) {
    if (clip.kind !== 'text' || !visible.has(clip.trackId)) continue
    // Drawn on its own, with frames that never come from the live players.
    const view: Project = { ...project, clips: { [clip.id]: clip } }
    const { bounds } = withVideoFrames(
      () => null,
      () => renderFrame(ctx, view, settled(clip)),
    )
    const b = bounds.get(clip.id)
    if (b) out[clip.id] = { cx: b.cx, cy: b.cy, w: b.w, h: b.h, rotation: b.rotation }
  }
  return out
}
