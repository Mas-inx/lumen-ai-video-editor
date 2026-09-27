/**
 * The audio engine. One scheduling routine drives both live playback (an
 * AudioContext following the playback clock) and the export mixdown (an
 * OfflineAudioContext per block), so what you hear is exactly what you get.
 *
 * Per clip: decoded source (optionally reversed / denoised) → optional voice
 * enhancement chain → gain (volume, keyframes, fades, crossfades) → its
 * track's channel (EQ, compressor, limiter, fader, pan) → the master bus.
 * A nested timeline plays through a mix of its own, into a gain stage for the
 * clip that plays it (its volume, fades and crossfades), into that clip's track.
 */
import { PEAKS_PER_SECOND } from '@/editor/defaults'
import { propAt } from '@/editor/keyframes'
import { adjacentAfter, adjacentBefore, clipEnd } from '@/editor/ops'
import { sequenceView } from '@/editor/sequences'
import { isRamped, sourceFrameAt, speedAt } from '@/editor/timing'
import type { Asset, Clip, Project } from '@/editor/types'
import { decodeAudio, openAudioStream, type AudioStream } from './decode'
import { createBus, createGraph, dbToGain, disposeGraph, hasDynamics, readMeter, updateGraph, type MixGraph } from './mixer'
import { resample } from './wav'

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
  for (const [id, s] of streams) {
    if (keep.has(id)) continue
    void s.stream.then((st) => st?.close())
    streams.delete(id)
  }
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

// ─── Long recordings ─────────────────────────────────────────────────────

/** Past this length a file isn't decoded whole: playback, export and analysis read it a window at a time. */
export const STREAM_OVER_SECONDS = 10 * 60

export const isLongAudio = (asset: Asset | undefined) => Boolean(asset && (asset.duration ?? 0) > STREAM_OVER_SECONDS)

const streams = new Map<string, { url: string; stream: Promise<AudioStream | null> }>()

/** A long file's reader (opened once per file). */
export function audioStream(asset: Asset): Promise<AudioStream | null> {
  const url = audioSourceUrl(asset)
  if (!url) return Promise.resolve(null)
  const hit = streams.get(asset.id)
  if (hit && hit.url === url) return hit.stream
  void hit?.stream.then((old) => old?.close())
  const stream = openAudioStream(url)
  streams.set(asset.id, { url, stream })
  return stream
}

/** Source seconds [s0, s1) of a long file, reversed or denoised as the clip needs, with the second it starts at. */
async function streamChunk(asset: Asset, clip: Clip, s0: number, s1: number): Promise<{ buffer: AudioBuffer; start: number } | null> {
  const stream = await audioStream(asset)
  if (!stream) return null
  const a = Math.max(0, s0)
  const b = Math.min(stream.duration, s1)
  let buffer = await stream.read(a, b)
  if (!buffer) return null
  if (clip.audio.denoise) buffer = await denoised(buffer)
  if (clip.reverse) buffer = reversed(buffer)
  return { buffer, start: a }
}

/** The source seconds a clip plays during timeline window [a, b), with a little room either side. */
function sourceSpan(project: Project, clip: Clip, a: number, b: number): [number, number] {
  const fps = project.settings.fps
  const cs = clip.start / fps
  const at = (T: number) => sourceFrameAt(clip, (T - cs) * fps) / fps
  const x = at(a)
  const y = at(b)
  return [Math.min(x, y) - 0.05, Math.max(x, y) + 0.05]
}

/** Reads a long file a minute at a time. */
async function* minutes(stream: AudioStream, step = 60) {
  for (let t = 0; t < stream.duration; t += step) {
    const buffer = await stream.read(t, Math.min(stream.duration, t + step))
    if (buffer) yield { t, buffer }
    // Let the editor breathe between windows.
    await new Promise((r) => setTimeout(r, 0))
  }
}

/**
 * Speech-ready audio (16 kHz mono) for transcription and the like. Short files
 * come back as decoded; long ones are streamed and mixed down a minute at a time,
 * so an hour takes about 230 MB instead of well over a gigabyte.
 */
export async function speechAudio(asset: Asset): Promise<AudioBuffer | null> {
  if (!isLongAudio(asset)) return loadAudio(asset)
  const stream = await audioStream(asset)
  if (!stream) return null
  const rate = 16000
  const total = Math.max(1, Math.ceil(stream.duration * rate))
  const out = new AudioBuffer({ length: total, numberOfChannels: 1, sampleRate: rate })
  for await (const { t, buffer } of minutes(stream)) {
    const mono = await resample(buffer, rate, 1)
    const at = Math.round(t * rate)
    const n = Math.max(0, Math.min(mono.length, total - at))
    if (n) out.copyToChannel(mono.getChannelData(0).subarray(0, n), 0, at)
  }
  return out
}

// ─── Scheduling ──────────────────────────────────────────────────────────

/** Whether a clip's track lets it be heard: not muted, and soloed while any track is. */
function trackHeard(project: Project, clip: Clip) {
  const track = project.tracks.find((t) => t.id === clip.trackId)
  if (!track || track.muted) return false
  return track.solo || !project.tracks.some((t) => t.solo)
}

/** Whether a clip makes sound at all: freeze frames and video whose sound was detached are silent, and while any track is soloed only soloed tracks play. */
export function isAudible(project: Project, clip: Clip) {
  if (clip.kind !== 'audio' && clip.kind !== 'video') return false
  if (clip.freeze || (clip.kind === 'video' && clip.audio.detached) || clip.sequenceId) return false
  if (!trackHeard(project, clip)) return false
  return Boolean(clip.assetId && audioSourceUrl(project.assets[clip.assetId]))
}

/** A nested clip is heard at normal speed, forwards (its timeline's mix isn't re-timed). */
function nestHeard(project: Project, clip: Clip) {
  if (!clip.sequenceId || (clip.kind !== 'audio' && clip.kind !== 'video')) return false
  if (clip.freeze || clip.reverse || clip.speed !== 1 || isRamped(clip) || (clip.kind === 'video' && clip.audio.detached)) return false
  return trackHeard(project, clip)
}

const MAX_NESTING = 8

/** Every clip whose sound is heard, nested timelines opened up — each with the timeline it's on. */
export function audioLeaves(project: Project, level = 0, out: { clip: Clip; view: Project }[] = []) {
  for (const clip of Object.values(project.clips)) {
    if (isAudible(project, clip)) out.push({ clip, view: project })
    else if (level < MAX_NESTING && nestHeard(project, clip)) {
      const inner = sequenceView(project, clip.sequenceId!)
      if (inner && inner !== project) audioLeaves(inner, level + 1, out)
    }
  }
  return out
}

/** Gain of a clip (volume, keyframes and fades) at a local frame. */
export function clipGainAt(clip: Clip, local: number) {
  let g = dbToGain(propAt(clip, 'volume', Math.min(local, clip.duration)))
  const { fadeIn, fadeOut } = clip.audio
  if (fadeIn > 0 && local < fadeIn) g *= Math.max(0, local / fadeIn)
  if (fadeOut > 0 && local > clip.duration - fadeOut) g *= Math.max(0, (clip.duration - local) / fadeOut)
  return g
}

/**
 * How a clip's sound meets its neighbours: a transition (on any track) is an
 * equal-power crossfade. The incoming clip fades in over the transition; the
 * outgoing one plays on past its end, into its handle, fading out.
 */
export function crossfades(project: Project, clip: Clip): { fadeIn: number; tail: number } {
  const fadeIn = clip.transitionIn && adjacentBefore(project, clip) ? Math.min(clip.transitionIn.duration, clip.duration) : 0
  const next = adjacentAfter(project, clip)
  const tail = next?.transitionIn ? Math.min(next.transitionIn.duration, next.duration) : 0
  return { fadeIn, tail }
}

/** Gain at a local frame including crossfades; past the clip's end (in its handle) it fades out. */
function mixGainAt(clip: Clip, local: number, xf: { fadeIn: number; tail: number }) {
  if (local >= clip.duration) {
    if (!xf.tail) return 0
    const t = Math.min(1, (local - clip.duration) / xf.tail)
    return clipGainAt(clip, clip.duration - 1e-6) * Math.cos((t * Math.PI) / 2)
  }
  let g = clipGainAt(clip, local)
  if (xf.fadeIn && local < xf.fadeIn) g *= Math.sin((Math.max(0, local / xf.fadeIn) * Math.PI) / 2)
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
 * `bufferStart` is the source second the buffer begins at (a streamed chunk of a long file).
 */
function scheduleClip(ctx: BaseAudioContext, dest: AudioNode, project: Project, clip: Clip, buffer: AudioBuffer, from: number, to: number, at: number, bufferStart = 0): Scheduled | null {
  const fps = project.settings.fps
  const xf = crossfades(project, clip)
  const cs = clip.start / fps
  const ce = (clipEnd(clip) + xf.tail) / fps
  const a = Math.max(cs, from)
  const b = Math.min(ce, to)
  if (b - a <= 1e-4) return null
  const localAt = (T: number) => (T - cs) * fps
  const srcAt = (T: number) => sourceFrameAt(clip, localAt(T)) / fps - bufferStart
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
  if (!animated && !clip.audio.fadeIn && !clip.audio.fadeOut && !xf.fadeIn && !xf.tail) {
    gain.gain.setValueAtTime(clipGainAt(clip, localAt(a)), when)
  } else {
    const steps = Math.max(2, Math.min(24000, Math.ceil(dur * 60)))
    const curve = new Float32Array(steps)
    for (let i = 0; i < steps; i++) curve[i] = mixGainAt(clip, localAt(a + (dur * i) / (steps - 1)), xf)
    gain.gain.setValueCurveAtTime(curve, when, Math.max(0.001, dur))
  }

  const start = Math.max(0, offset)
  const lead = offset < 0 ? -offset / speed : 0
  source.start(when + lead, start, Math.max(0.001, span - (start - offset)))
  return { source, nodes }
}

/** Where a clip's sound goes: its track's channel. */
const channelFor = (graph: MixGraph, clip: Clip) => graph.tracks.get(clip.trackId)?.input ?? graph.master.input

/** Timeline seconds a clip is heard for, crossfade tail included. */
function audibleSpan(project: Project, clip: Clip): [number, number] {
  const fps = project.settings.fps
  return [clip.start / fps, (clipEnd(clip) + crossfades(project, clip).tail) / fps]
}

/** A clip whose sound is heard, where it goes, and how its timeline lines up with the one being played. */
interface Voice {
  clip: Clip
  /** The timeline the clip is on (a nested one for clips inside nests). */
  view: Project
  dest: AudioNode
  /** Seconds added to a time on the clip's timeline give the time on the played one. */
  offset: number
  /** The stretch of the played timeline it can be heard in (inside its nested clip). */
  window: [number, number]
}

/** Played-timeline seconds a voice is heard for. */
function voiceSpan(v: Voice): [number, number] {
  const [a, b] = audibleSpan(v.view, v.clip)
  return [Math.max(v.window[0], a + v.offset), Math.min(v.window[1], b + v.offset)]
}

/** Schedules the part of a voice inside played window [from, to), `at` being the context time of `from`. */
function scheduleVoice(ctx: BaseAudioContext, v: Voice, buffer: AudioBuffer, from: number, to: number, at: number, bufferStart = 0) {
  const a = Math.max(from, v.window[0])
  const b = Math.min(to, v.window[1])
  if (b - a <= 1e-4) return null
  return scheduleClip(ctx, v.dest, v.view, v.clip, buffer, a - v.offset, b - v.offset, at + (a - from), bufferStart)
}

/** Nodes made for nested timelines while scheduling — torn down with the rest. */
interface NestNodes {
  graphs: MixGraph[]
  gains: GainNode[]
}

/**
 * Every voice of `project`, nested timelines opened up: each nested clip gets a
 * gain stage (its volume, fades and crossfades, automated from `clock`) fed by
 * a mix of its timeline's own tracks.
 */
function voices(ctx: BaseAudioContext, project: Project, graph: MixGraph, clock: { from: number; at: number }, nodes: NestNodes): Voice[] {
  const out: Voice[] = []
  const walk = (view: Project, channel: (clip: Clip) => AudioNode, offset: number, window: [number, number], level: number) => {
    const fps = view.settings.fps
    for (const clip of Object.values(view.clips)) {
      if (isAudible(view, clip)) {
        out.push({ clip, view, dest: channel(clip), offset, window })
        continue
      }
      if (level >= MAX_NESTING || !nestHeard(view, clip)) continue
      const inner = sequenceView(view, clip.sequenceId!)
      if (!inner || inner === view) continue
      const xf = crossfades(view, clip)
      const t0 = clip.start / fps + offset
      const t1 = (clipEnd(clip) + xf.tail) / fps + offset
      const w: [number, number] = [Math.max(window[0], t0), Math.min(window[1], t1)]
      if (w[1] - w[0] <= 1e-4) continue
      const gain = ctx.createGain()
      gain.connect(channel(clip))
      nodes.gains.push(gain)
      const a = Math.max(w[0], clock.from)
      if (w[1] > a) {
        const local = (T: number) => (T - offset) * fps - clip.start
        if (!clip.keyframes.volume?.length && !clip.audio.fadeIn && !clip.audio.fadeOut && !xf.fadeIn && !xf.tail) gain.gain.value = clipGainAt(clip, 0)
        else {
          const dur = w[1] - a
          const steps = Math.max(2, Math.min(24000, Math.ceil(dur * 60)))
          const curve = new Float32Array(steps)
          for (let i = 0; i < steps; i++) curve[i] = mixGainAt(clip, local(a + (dur * i) / (steps - 1)), xf)
          gain.gain.setValueCurveAtTime(curve, clock.at + (a - clock.from), Math.max(0.001, dur))
        }
      }
      const sub = createGraph(ctx, inner, gain, false)
      nodes.graphs.push(sub)
      walk(inner, (c) => channelFor(sub, c), offset + (clip.start - clip.inPoint) / fps, w, level + 1)
    }
  }
  walk(project, (c) => channelFor(graph, c), 0, [-Infinity, Infinity], 0)
  return out
}

function disposeNest(nodes: NestNodes) {
  for (const g of nodes.graphs) disposeGraph(g)
  for (const n of nodes.gains) n.disconnect()
  nodes.graphs = []
  nodes.gains = []
}

// ─── Live playback ───────────────────────────────────────────────────────

let ctx: AudioContext | null = null
/** Monitor level (the transport's volume and mute): after the master bus, never exported. */
let monitor: GainNode | null = null
let graph: MixGraph | null = null
let active: Scheduled[] = []
let running: { from: number; at: number; project: Project } | null = null
let masterLevel = 0.8

/** Long recordings play in chunks decoded just ahead of the playhead. */
interface Streamer {
  voice: Voice
  asset: Asset
  /** Played-timeline second scheduled up to. */
  until: number
  busy: boolean
}
let streamers: Streamer[] = []
/** Mixes of nested timelines for the current playback. */
const liveNest: NestNodes = { graphs: [], gains: [] }
let streamTimer: ReturnType<typeof setInterval> | undefined
let generation = 0
const LOOKAHEAD = 12
const CHUNK = 8

function topUpStreams() {
  if (!running || !ctx || !graph) return
  const gen = generation
  const nowT = running.from + (ctx.currentTime - running.at)
  for (const s of streamers) {
    if (s.busy) continue
    const [, end] = voiceSpan(s.voice)
    if (s.until >= end - 1e-3 || s.until > nowT + LOOKAHEAD) continue
    s.busy = true
    const a = Math.max(s.until, nowT)
    const b = Math.min(end, a + CHUNK)
    const v = s.voice
    const [s0, s1] = sourceSpan(v.view, v.clip, a - v.offset, b - v.offset)
    void streamChunk(s.asset, v.clip, s0, s1)
      .then((chunk) => {
        if (gen !== generation || !running || !ctx || !graph) return
        s.until = b
        if (!chunk) return
        // A decode that ran late joins in where playback is now, still in sync.
        const now = running.from + (ctx.currentTime - running.at) + 0.03
        const from = Math.max(a, now)
        const scheduled = scheduleVoice(ctx, v, chunk.buffer, from, b, running.at + (from - running.from), chunk.start)
        if (scheduled) active.push(scheduled)
      })
      .catch((err) => console.warn('Streaming audio failed', err))
      .finally(() => {
        s.busy = false
        if (gen === generation) topUpStreams()
      })
  }
}

function context() {
  if (!ctx) {
    ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 })
    monitor = ctx.createGain()
    monitor.gain.value = masterLevel
    monitor.connect(ctx.destination)
  }
  return ctx
}

function rebuildGraph(project: Project) {
  if (graph) disposeGraph(graph)
  graph = createGraph(context(), project, monitor!, true)
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
    rebuildGraph(project)
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
    generation++
    streamers = []
    clearInterval(streamTimer)
    streamTimer = undefined
    for (const s of active) {
      try {
        s.source.stop()
      } catch {
        /* never started */
      }
      s.nodes.forEach((n) => n.disconnect())
    }
    active = []
    disposeNest(liveNest)
  },

  /** The project changed while playing: pick up the new mix from where we are. */
  refresh(project: Project) {
    if (!running || !ctx) return
    const t = running.from + (ctx.currentTime - running.at)
    this.stopAll()
    rebuildGraph(project)
    const at = ctx.currentTime + 0.02
    running = { from: t + 0.02, at, project }
    scheduleAll(project, running.from, at)
  },

  /** Only mixer settings changed: faders, pan and processing follow without a restart. */
  updateMix(project: Project) {
    if (!ctx || !graph) return
    updateGraph(ctx, graph, project)
    if (running) running.project = project
  },

  setVolume(volume: number, muted: boolean) {
    masterLevel = muted ? 0 : volume
    if (monitor && ctx) monitor.gain.setTargetAtTime(masterLevel, ctx.currentTime, 0.015)
  },

  /** Live peak levels (dBFS, left and right) of a track's channel or the master, while playing. */
  levels(target: 'master' | string): [number, number] | null {
    if (!running || !graph) return null
    const bus = target === 'master' ? graph.master : graph.tracks.get(target)
    return bus?.meter ? readMeter(bus.meter) : null
  },

  /** Gain reduction (dB, 0 or below) a channel's compressor and limiter are applying right now. */
  reduction(target: 'master' | string): { compressor: number; limiter: number } | null {
    if (!running || !graph) return null
    const bus = target === 'master' ? graph.master : graph.tracks.get(target)
    if (!bus) return null
    return { compressor: bus.compressor?.reduction ?? 0, limiter: bus.limiter?.reduction ?? 0 }
  },
}

function scheduleAll(project: Project, from: number, at: number) {
  if (!ctx || !graph) return
  for (const v of voices(ctx, project, graph, { from, at }, liveNest)) {
    const [start, end] = voiceSpan(v)
    if (end <= from || end - start <= 1e-4) continue
    const asset = v.view.assets[v.clip.assetId!]
    if (isLongAudio(asset)) {
      streamers.push({ voice: v, asset, until: Math.max(from, start), busy: false })
      continue
    }
    const buffer = clipBufferNow(asset, v.clip)
    if (buffer) {
      const s = scheduleVoice(ctx, v, buffer, from, Infinity, at)
      if (s) active.push(s)
    } else void clipBuffer(asset, v.clip) // ready later → onAudioReady → refresh
  }
  if (streamers.length) {
    topUpStreams()
    streamTimer = setInterval(topUpStreams, 500)
  }
}

// A source finishing decoding mid-play joins in at the current position.
onAudioReady(() => {
  if (running) audioEngine.refresh(running.project)
})

// ─── Export mixdown ──────────────────────────────────────────────────────

/** Makes sure every audible clip's audio is decoded (and processed) before an export. */
export async function prepareAudio(project: Project, onProgress?: (done: number, total: number) => void) {
  // Long recordings are read block by block while exporting, not decoded up front.
  const leaves = audioLeaves(project).filter(({ clip, view }) => !isLongAudio(view.assets[clip.assetId!]))
  let done = 0
  for (const { clip, view } of leaves) {
    await clipBuffer(view.assets[clip.assetId!], clip)
    onProgress?.(++done, leaves.length)
  }
}

export interface MixOptions {
  sampleRate?: number
  /** Extra gain after the master bus, dB (loudness normalization). */
  gainDb?: number
  /** A final peak ceiling after that gain, dBFS. */
  ceiling?: number
}

/**
 * Renders the mix of timeline seconds [from, to) as stereo. Compressors and
 * limiters remember what came before, so each block starts a second early and
 * that lead-in is dropped: renders made block by block join seamlessly.
 */
export async function renderMix(project: Project, from: number, to: number, opts: MixOptions = {}): Promise<AudioBuffer> {
  const sampleRate = opts.sampleRate ?? 48000
  const dynamic = hasDynamics(project.master) || project.tracks.some((t) => hasDynamics(t.mix)) || opts.ceiling !== undefined
  const lead = dynamic ? Math.min(from, 1) : 0
  const start = from - lead
  const length = Math.max(1, Math.round((to - start) * sampleRate))
  const off = new OfflineAudioContext({ numberOfChannels: 2, length, sampleRate })
  let out: AudioNode = off.destination
  if (opts.ceiling !== undefined) out = createBus(off, out, { volume: 0, pan: 0, limiter: { enabled: true, ceiling: opts.ceiling } }, false).input
  if (opts.gainDb) {
    const gain = off.createGain()
    gain.gain.value = dbToGain(opts.gainDb)
    gain.connect(out)
    out = gain
  }
  const mix = createGraph(off, project, out, false)
  for (const v of voices(off, project, mix, { from: start, at: 0 }, { graphs: [], gains: [] })) {
    const [a, b] = voiceSpan(v)
    if (b <= start || a >= to || b - a <= 1e-4) continue
    const asset = v.view.assets[v.clip.assetId!]
    if (isLongAudio(asset)) {
      const [s0, s1] = sourceSpan(v.view, v.clip, Math.max(a, start) - v.offset, Math.min(b, to) - v.offset)
      const chunk = await streamChunk(asset, v.clip, s0, s1)
      if (chunk) scheduleVoice(off, v, chunk.buffer, start, to, 0, chunk.start)
      continue
    }
    const buffer = await clipBuffer(asset, v.clip)
    if (buffer) scheduleVoice(off, v, buffer, start, to, 0)
  }
  const rendered = await off.startRendering()
  const skip = Math.round(lead * sampleRate)
  const keep = Math.max(1, Math.round((to - from) * sampleRate))
  let result = rendered
  if (skip || rendered.length !== keep) {
    result = new AudioBuffer({ length: keep, numberOfChannels: 2, sampleRate })
    for (let c = 0; c < 2; c++) result.getChannelData(c).set(rendered.getChannelData(c).subarray(skip, skip + keep))
  }
  if (opts.ceiling !== undefined) {
    // The limiter reacts in a millisecond; a hard stop at the ceiling catches whatever slips through.
    const max = dbToGain(opts.ceiling)
    for (let c = 0; c < 2; c++) {
      const d = result.getChannelData(c)
      for (let i = 0; i < d.length; i++) {
        if (d[i] > max) d[i] = max
        else if (d[i] < -max) d[i] = -max
      }
    }
  }
  return result
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

/** Waveform peaks of a long file, streamed a minute at a time. */
export async function computePeaksStreamed(asset: Asset): Promise<number[] | null> {
  const stream = await audioStream(asset)
  if (!stream) return null
  const n = Math.max(1, Math.ceil(stream.duration * PEAKS_PER_SECOND))
  const peaks = new Float32Array(n)
  let max = 0
  for await (const { t, buffer } of minutes(stream)) {
    const per = buffer.sampleRate / PEAKS_PER_SECOND
    const first = Math.round(t * PEAKS_PER_SECOND)
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c))
    for (let i = 0; first + i < n && i * per < buffer.length; i++) {
      const s = Math.floor(i * per)
      const e = Math.min(buffer.length, Math.floor((i + 1) * per))
      let p = 0
      for (const ch of channels) for (let j = s; j < e; j += 2) p = Math.max(p, Math.abs(ch[j]))
      peaks[first + i] = Math.max(peaks[first + i], p)
      max = Math.max(max, p)
    }
  }
  const k = max > 0 ? 1 / max : 1
  return Array.from(peaks, (p) => Math.round(p * k * 100) / 100)
}

/**
 * Where someone is speaking (or anything above the noise floor is happening),
 * as [start, end] source seconds, from short-term loudness with an adaptive threshold.
 */
export function activeRegions(buffer: AudioBuffer, opts: { minSilence?: number; minSound?: number } = {}): [number, number][] {
  return regionsFromLevels(levelFrames(buffer), opts)
}

const HOP = 0.02

/** Short-term level (dBFS) every 20 ms. */
export function levelFrames(buffer: Pick<AudioBuffer, 'sampleRate' | 'length' | 'numberOfChannels' | 'getChannelData'>): Float32Array {
  const win = Math.max(1, Math.round(HOP * buffer.sampleRate))
  const frames = Math.floor(buffer.length / win)
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c))
  const db = new Float32Array(frames)
  for (let f = 0; f < frames; f++) {
    let sum = 0
    for (const ch of channels) for (let j = f * win, e = j + win; j < e; j++) sum += ch[j] * ch[j]
    const rms = Math.sqrt(sum / (win * channels.length))
    db[f] = rms > 1e-9 ? 20 * Math.log10(rms) : -120
  }
  return db
}

/** activeRegions for a long file, streamed a minute at a time. */
export async function activeRegionsStreamed(asset: Asset, opts: { minSilence?: number; minSound?: number } = {}): Promise<[number, number][] | null> {
  const stream = await audioStream(asset)
  if (!stream) return null
  const parts: Float32Array[] = []
  for await (const { buffer } of minutes(stream)) parts.push(levelFrames(buffer))
  const db = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    db.set(p, o)
    o += p.length
  }
  return regionsFromLevels(db, opts)
}

/** Where there's sound, from 20 ms levels: a threshold between the noise floor and the typical level. */
export function regionsFromLevels(db: Float32Array, opts: { minSilence?: number; minSound?: number } = {}): [number, number][] {
  const minSilence = opts.minSilence ?? 0.35
  const minSound = opts.minSound ?? 0.12
  const hop = HOP
  const frames = db.length
  if (!frames) return []
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
