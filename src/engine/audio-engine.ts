/**
 * The audio engine. One scheduling routine drives both live playback (an
 * AudioContext following the playback clock) and the export mixdown (an
 * OfflineAudioContext per block), so what you hear is exactly what you get.
 *
 * Per clip: decoded source (optionally reversed / denoised) → optional voice
 * enhancement chain → gain (volume, keyframes, fades) → track → master.
 */
import { PEAKS_PER_SECOND } from '@/editor/defaults'
import { propAt } from '@/editor/keyframes'
import { clipEnd } from '@/editor/ops'
import { isRamped, sourceFrameAt, speedAt } from '@/editor/timing'
import type { Asset, Clip, Project } from '@/editor/types'
import { decodeAudio } from './decode'

// ─── Decoded sources ─────────────────────────────────────────────────────

type Entry = { url: string; buffer: AudioBuffer | null; promise: Promise<AudioBuffer | null> }
const decoded = new Map<string, Entry>()
const derived = new Map<string, Promise<AudioBuffer | null>>()
const readyListeners = new Set<(assetId: string) => void>()

export function onAudioReady(fn: (assetId: string) => void) {
  readyListeners.add(fn)
  return () => void readyListeners.delete(fn)
}

/** Assets whose sound the engine can play. */
export function audioSourceUrl(asset: Asset | undefined): string | null {
  if (!asset || asset.source.type !== 'file' || asset.source.missing) return null
  if (asset.kind === 'audio') return asset.source.url
  if (asset.kind === 'video' && asset.hasAudio !== false) return asset.source.url
  return null
}

/** Starts (or joins) decoding an asset's audio. */
export function loadAudio(asset: Asset): Promise<AudioBuffer | null> {
  const url = audioSourceUrl(asset)
  if (!url) return Promise.resolve(null)
  const hit = decoded.get(asset.id)
  if (hit && hit.url === url) return hit.promise
  const entry: Entry = { url, buffer: null, promise: Promise.resolve(null) }
  entry.promise = decodeAudio(url).then(
    (buffer) => {
      entry.buffer = buffer
      readyListeners.forEach((fn) => fn(asset.id))
      return buffer
    },
    (err) => {
      console.warn(`Couldn’t decode audio for ${asset.name}`, err)
      return null
    },
  )
  decoded.set(asset.id, entry)
  return entry.promise
}

/** The decoded buffer if it's ready (never blocks). */
export function audioBuffer(asset: Asset): AudioBuffer | null {
  const hit = decoded.get(asset.id)
  return hit && hit.url === audioSourceUrl(asset) ? hit.buffer : null
}

/** Frees decoded audio for assets that left the project. */
export function pruneAudio(keep: Set<string>) {
  for (const id of decoded.keys()) if (!keep.has(id)) decoded.delete(id)
  for (const key of derived.keys()) if (!keep.has(key.split('|')[0])) derived.delete(key)
  for (const key of settled.keys()) if (!keep.has(key.split('|')[0])) settled.delete(key)
}

function reversed(src: AudioBuffer) {
  const out = new AudioBuffer({ length: src.length, numberOfChannels: src.numberOfChannels, sampleRate: src.sampleRate })
  for (let c = 0; c < src.numberOfChannels; c++) {
    const a = src.getChannelData(c)
    const b = out.getChannelData(c)
    for (let i = 0, n = a.length; i < n; i++) b[i] = a[n - 1 - i]
  }
  return out
}

let rnnoise: Promise<{ createDenoiseState(): { processFrame(f: Float32Array): number; destroy(): void }; frameSize: number }> | null = null

/** RNNoise (recurrent-network noise suppression), applied offline to the whole recording. */
async function denoised(src: AudioBuffer): Promise<AudioBuffer> {
  rnnoise ??= import('@shiguredo/rnnoise-wasm').then((m) => m.Rnnoise.load())
  const rn = await rnnoise
  // RNNoise runs at 48 kHz on 480-sample frames of 16-bit-scaled floats.
  const rate = 48000
  const length = Math.ceil(src.duration * rate)
  const ctx = new OfflineAudioContext({ numberOfChannels: src.numberOfChannels, length, sampleRate: rate })
  const node = ctx.createBufferSource()
  node.buffer = src
  node.connect(ctx.destination)
  node.start()
  const at48 = await ctx.startRendering()
  const out = new AudioBuffer({ length, numberOfChannels: at48.numberOfChannels, sampleRate: rate })
  const frame = new Float32Array(rn.frameSize)
  for (let c = 0; c < at48.numberOfChannels; c++) {
    const input = at48.getChannelData(c)
    const output = out.getChannelData(c)
    const state = rn.createDenoiseState()
    try {
      for (let i = 0; i < length; i += rn.frameSize) {
        frame.fill(0)
        const n = Math.min(rn.frameSize, length - i)
        for (let j = 0; j < n; j++) frame[j] = input[i + j] * 32768
        state.processFrame(frame)
        for (let j = 0; j < n; j++) output[i + j] = frame[j] / 32768
      }
    } finally {
      state.destroy()
    }
    // Yield between channels so the UI stays responsive on long recordings.
    await new Promise((r) => setTimeout(r, 0))
  }
  return out
}

function variant(asset: Asset, clip: Clip, base: AudioBuffer): Promise<AudioBuffer | null> | AudioBuffer {
  const denoise = clip.audio.denoise
  if (!denoise && !clip.reverse) return base
  const key = variantKey(asset, clip)
  let p = derived.get(key)
  if (!p) {
    p = (async () => {
      let b = base
      if (denoise) b = await denoised(b)
      if (clip.reverse) b = reversed(b)
      return b
    })().catch((err) => {
      console.warn('Audio processing failed', err)
      return null
    })
    derived.set(key, p)
    void p.then(() => readyListeners.forEach((fn) => fn(asset.id)))
  }
  return p
}

const variantKey = (asset: Asset, clip: Clip) => `${asset.id}|${audioSourceUrl(asset)}|${clip.audio.denoise ? 'dn' : ''}|${clip.reverse ? 'rev' : ''}`

const settled = new Map<string, AudioBuffer | null>()

/** The buffer a clip plays right now (sync), or null while it's still being prepared. */
function clipBufferNow(asset: Asset, clip: Clip): AudioBuffer | null {
  const base = audioBuffer(asset)
  if (!base) return null
  const v = variant(asset, clip, base)
  if (v instanceof AudioBuffer) return v
  const key = variantKey(asset, clip)
  if (settled.has(key)) return settled.get(key) ?? null
  void v.then((b) => settled.set(key, b))
  return null
}

async function clipBuffer(asset: Asset, clip: Clip): Promise<AudioBuffer | null> {
  const base = await loadAudio(asset)
  if (!base) return null
  return await variant(asset, clip, base)
}

// ─── Scheduling ──────────────────────────────────────────────────────────

const dbToGain = (db: number) => (db <= -60 ? 0 : Math.pow(10, db / 20))

/** Whether a clip makes sound at all: freeze frames and video whose sound was detached are silent, and while any track is soloed only soloed tracks play. */
export function isAudible(project: Project, clip: Clip) {
  if (clip.kind !== 'audio' && clip.kind !== 'video') return false
  if (clip.freeze || (clip.kind === 'video' && clip.audio.detached)) return false
  const track = project.tracks.find((t) => t.id === clip.trackId)
  if (!track || track.muted) return false
  if (!track.solo && project.tracks.some((t) => t.solo)) return false
  return Boolean(clip.assetId && audioSourceUrl(project.assets[clip.assetId]))
}

/** Gain of a clip (volume, keyframes and fades) at a local frame. */
export function clipGainAt(clip: Clip, local: number) {
  let g = dbToGain(propAt(clip, 'volume', local))
  const { fadeIn, fadeOut } = clip.audio
  if (fadeIn > 0 && local < fadeIn) g *= Math.max(0, local / fadeIn)
  if (fadeOut > 0 && local > clip.duration - fadeOut) g *= Math.max(0, (clip.duration - local) / fadeOut)
  return g
}

/** Voice clean-up: rumble filter, presence lift, gentle compression, make-up gain. */
function enhanceChain(ctx: BaseAudioContext, into: AudioNode): AudioNode {
  const hp = ctx.createBiquadFilter()
  hp.type = 'highpass'
  hp.frequency.value = 80
  hp.Q.value = 0.7
  const mud = ctx.createBiquadFilter()
  mud.type = 'peaking'
  mud.frequency.value = 280
  mud.Q.value = 1
  mud.gain.value = -2.5
  const presence = ctx.createBiquadFilter()
  presence.type = 'peaking'
  presence.frequency.value = 3200
  presence.Q.value = 0.9
  presence.gain.value = 3
  const air = ctx.createBiquadFilter()
  air.type = 'highshelf'
  air.frequency.value = 10000
  air.gain.value = 2
  const comp = ctx.createDynamicsCompressor()
  comp.threshold.value = -22
  comp.knee.value = 8
  comp.ratio.value = 3
  comp.attack.value = 0.004
  comp.release.value = 0.2
  const makeup = ctx.createGain()
  makeup.gain.value = dbToGain(3)
  hp.connect(mud).connect(presence).connect(air).connect(comp).connect(makeup).connect(into)
  return hp
}

interface Scheduled {
  source: AudioBufferSourceNode
  nodes: AudioNode[]
}

/**
 * Schedules the part of `clip` that falls inside timeline window [from, to) seconds,
 * starting at context time `at` (which corresponds to timeline time `from`).
 */
function scheduleClip(ctx: BaseAudioContext, dest: AudioNode, project: Project, clip: Clip, buffer: AudioBuffer, from: number, to: number, at: number): Scheduled | null {
  const fps = project.settings.fps
  const cs = clip.start / fps
  const ce = clipEnd(clip) / fps
  const a = Math.max(cs, from)
  const b = Math.min(ce, to)
  if (b - a <= 1e-4) return null
  const localAt = (T: number) => (T - cs) * fps
  const srcAt = (T: number) => sourceFrameAt(clip, localAt(T)) / fps
  // Reversed clips play a reversed copy forwards.
  const offset = clip.reverse ? buffer.duration - srcAt(a) : srcAt(a)
  const span = Math.abs(srcAt(b) - srcAt(a))
  if (offset >= buffer.duration || offset + span <= 0) return null
  const when = at + (a - from)
  const dur = b - a

  const source = ctx.createBufferSource()
  source.buffer = buffer
  const speed = speedAt(clip, localAt(a))
  source.playbackRate.value = speed
  if (isRamped(clip)) {
    // A speed ramp: the rate follows the ramp, so the sound stays locked to the picture.
    const steps = Math.max(2, Math.min(24000, Math.ceil(dur * 60)))
    const curve = new Float32Array(steps)
    for (let i = 0; i < steps; i++) curve[i] = speedAt(clip, localAt(a + (dur * i) / (steps - 1)))
    source.playbackRate.setValueCurveAtTime(curve, when, Math.max(0.001, dur))
  }
  const gain = ctx.createGain()
  const nodes: AudioNode[] = [source, gain]
  gain.connect(dest)
  if (clip.audio.enhance) {
    const head = enhanceChain(ctx, gain)
    source.connect(head)
    nodes.push(head)
  } else source.connect(gain)

  // Gain automation from the start of the scheduled part to its end.
  const animated = Boolean(clip.keyframes.volume?.length)
  if (!animated && !clip.audio.fadeIn && !clip.audio.fadeOut) {
    gain.gain.setValueAtTime(clipGainAt(clip, localAt(a)), when)
  } else {
    const steps = Math.max(2, Math.min(24000, Math.ceil(dur * 60)))
    const curve = new Float32Array(steps)
    for (let i = 0; i < steps; i++) curve[i] = clipGainAt(clip, localAt(a + (dur * i) / (steps - 1)))
    gain.gain.setValueCurveAtTime(curve, when, Math.max(0.001, dur))
  }

  const start = Math.max(0, offset)
  const lead = offset < 0 ? -offset / speed : 0
  source.start(when + lead, start, Math.max(0.001, span - (start - offset)))
  return { source, nodes }
}

// ─── Live playback ───────────────────────────────────────────────────────

let ctx: AudioContext | null = null
let master: GainNode | null = null
let active: Scheduled[] = []
let running: { from: number; at: number; project: Project } | null = null
let masterLevel = 0.8

function context() {
  if (!ctx) {
    ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 })
    master = ctx.createGain()
    master.gain.value = masterLevel
    master.connect(ctx.destination)
  }
  return ctx
}

export const audioEngine = {
  /** Seconds on the audio clock (drives the playback clock while audio runs). */
  now: () => (ctx ? ctx.currentTime : performance.now() / 1000),
  isRunning: () => Boolean(ctx && ctx.state === 'running'),

  /** Opens the audio device ahead of the first play, so pressing play is instant. */
  warm() {
    void context().resume()
  },

  /** Starts sound at timeline second `from`; returns the context time that corresponds to it. */
  start(project: Project, from: number): number {
    const c = context()
    void c.resume()
    this.stopAll()
    const at = c.currentTime + 0.04
    running = { from, at, project }
    scheduleAll(project, from, at)
    return at
  },

  stop() {
    running = null
    this.stopAll()
  },

  stopAll() {
    for (const s of active) {
      try {
        s.source.stop()
      } catch {
        /* never started */
      }
      s.nodes.forEach((n) => n.disconnect())
    }
    active = []
  },

  /** The project changed while playing: pick up the new mix from where we are. */
  refresh(project: Project) {
    if (!running || !ctx) return
    const t = running.from + (ctx.currentTime - running.at)
    this.stopAll()
    const at = ctx.currentTime + 0.02
    running = { from: t + 0.02, at, project }
    scheduleAll(project, running.from, at)
  },

  setVolume(volume: number, muted: boolean) {
    masterLevel = muted ? 0 : volume
    if (master && ctx) master.gain.setTargetAtTime(masterLevel, ctx.currentTime, 0.015)
  },
}

function scheduleAll(project: Project, from: number, at: number) {
  if (!ctx || !master) return
  for (const clip of Object.values(project.clips)) {
    if (!isAudible(project, clip)) continue
    const fps = project.settings.fps
    if (clipEnd(clip) / fps <= from) continue
    const asset = project.assets[clip.assetId!]
    const buffer = clipBufferNow(asset, clip)
    if (buffer) {
      const s = scheduleClip(ctx, master, project, clip, buffer, from, Infinity, at)
      if (s) active.push(s)
    } else void clipBuffer(asset, clip) // ready later → onAudioReady → refresh
  }
}

// A source finishing decoding mid-play joins in at the current position.
onAudioReady(() => {
  if (running) audioEngine.refresh(running.project)
})

// ─── Export mixdown ──────────────────────────────────────────────────────

/** Makes sure every audible clip's audio is decoded (and processed) before an export. */
export async function prepareAudio(project: Project, onProgress?: (done: number, total: number) => void) {
  const clips = Object.values(project.clips).filter((c) => isAudible(project, c))
  let done = 0
  for (const clip of clips) {
    await clipBuffer(project.assets[clip.assetId!], clip)
    onProgress?.(++done, clips.length)
  }
}

/** Renders the mix of timeline seconds [from, to) as stereo at `sampleRate`. */
export async function renderMix(project: Project, from: number, to: number, sampleRate = 48000): Promise<AudioBuffer> {
  const length = Math.max(1, Math.round((to - from) * sampleRate))
  const off = new OfflineAudioContext({ numberOfChannels: 2, length, sampleRate })
  const bus = off.createGain()
  bus.connect(off.destination)
  for (const clip of Object.values(project.clips)) {
    if (!isAudible(project, clip)) continue
    const fps = project.settings.fps
    if (clipEnd(clip) / fps <= from || clip.start / fps >= to) continue
    const buffer = await clipBuffer(project.assets[clip.assetId!], clip)
    if (buffer) scheduleClip(off, bus, project, clip, buffer, from, to, 0)
  }
  return off.startRendering()
}

// ─── Analysis ────────────────────────────────────────────────────────────

/** Normalized waveform peaks (0..1) at PEAKS_PER_SECOND. */
export function computePeaks(buffer: AudioBuffer): number[] {
  const n = Math.max(1, Math.ceil(buffer.duration * PEAKS_PER_SECOND))
  const size = buffer.length / n
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c))
  const peaks = new Array<number>(n)
  let max = 0
  for (let i = 0; i < n; i++) {
    const s = Math.floor(i * size)
    const e = Math.min(buffer.length, Math.floor((i + 1) * size))
    let p = 0
    for (const ch of channels) for (let j = s; j < e; j += 2) p = Math.max(p, Math.abs(ch[j]))
    peaks[i] = p
    max = Math.max(max, p)
  }
  const k = max > 0 ? 1 / max : 1
  return peaks.map((p) => Math.round(p * k * 100) / 100)
}

/**
 * Where someone is speaking (or anything above the noise floor is happening),
 * as [start, end] source seconds, from short-term loudness with an adaptive threshold.
 */
export function activeRegions(buffer: AudioBuffer, opts: { minSilence?: number; minSound?: number } = {}): [number, number][] {
  const minSilence = opts.minSilence ?? 0.35
  const minSound = opts.minSound ?? 0.12
  const hop = 0.02
  const win = Math.max(1, Math.round(hop * buffer.sampleRate))
  const frames = Math.floor(buffer.length / win)
  if (!frames) return []
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c))
  const db = new Float32Array(frames)
  for (let f = 0; f < frames; f++) {
    let sum = 0
    for (const ch of channels) for (let j = f * win, e = j + win; j < e; j++) sum += ch[j] * ch[j]
    const rms = Math.sqrt(sum / (win * channels.length))
    db[f] = rms > 1e-9 ? 20 * Math.log10(rms) : -120
  }
  // Threshold between the noise floor (10th percentile) and typical level (90th).
  const sorted = Float32Array.from(db).sort()
  const floor = sorted[Math.floor(frames * 0.1)]
  const level = sorted[Math.floor(frames * 0.9)]
  const threshold = Math.max(-60, Math.min(-28, floor + Math.max(6, (level - floor) * 0.35)))
  const regions: [number, number][] = []
  let startF = -1
  let quiet = 0
  const minQuietFrames = Math.round(minSilence / hop)
  for (let f = 0; f < frames; f++) {
    if (db[f] > threshold) {
      if (startF < 0) startF = f
      quiet = 0
    } else if (startF >= 0) {
      quiet++
      if (quiet >= minQuietFrames) {
        regions.push([startF * hop, (f - quiet + 1) * hop])
        startF = -1
        quiet = 0
      }
    }
  }
  if (startF >= 0) regions.push([startF * hop, (frames - quiet) * hop])
  return regions.filter(([a, b]) => b - a >= minSound)
}
