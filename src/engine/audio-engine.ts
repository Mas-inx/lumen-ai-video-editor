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
import { clipEnd, transitionLead } from '@/editor/ops'
import { sequenceView } from '@/editor/sequences'
import { isRamped, sourceFrameAt, speedAt } from '@/editor/timing'
import type { Asset, Clip, Project } from '@/editor/types'
import { limiter } from '@/lib/limiter'
import { Lru } from '@/lib/lru'
import { bufferStream, decodeAudio, openAudioStream, type AudioStream } from './decode'
import { createBus, createGraph, dbToGain, disposeGraph, hasDynamics, readMeter, updateGraph, type MixGraph } from './mixer'
import { resample } from './wav'

// ─── Decoded sources ─────────────────────────────────────────────────────
// Short files are decoded whole, and kept while there's room: up to a budget of
// decoded samples, the least recently used going first (they're decoded again
// when they're needed again). Longer files stream (see below).

type Entry = { url: string; buffer: AudioBuffer | null; promise: Promise<AudioBuffer | null> }

/** Bytes of decoded audio kept at most — about 23 minutes of 48 kHz stereo. */
export const DECODED_BUDGET = 512 * 1024 * 1024

/** Bytes a second of decoded audio takes, before it's decoded and its rate is known (48 kHz stereo). */
const BYTES_PER_SECOND = 48000 * 2 * 4

/** Decoded sound by asset id, and the reversed or denoised copies clips play by variant key (`asset id|…`). */
const decoded = new Lru<string, Entry>({ budget: DECODED_BUDGET, size: (e) => (e.buffer ? e.buffer.length * e.buffer.numberOfChannels * 4 : 0) })
const readyListeners = new Set<(assetId: string) => void>()

/** Whole-file decodes run a few at a time — the sound playback or an export needs next first, then what's nearest the playhead. */
const decodes = limiter(3)

/** The priority of whatever needs sound now: playback, exports, analysis. Prefetching ranks after it, by distance from the playhead. */
const NOW = 0

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

/** Starts (or joins) decoding an asset's audio. `priority` orders it among the decodes waiting (lower is sooner). */
export function loadAudio(asset: Asset, priority = NOW): Promise<AudioBuffer | null> {
  const url = audioSourceUrl(asset)
  if (!url) return Promise.resolve(null)
  const hit = decoded.get(asset.id)
  if (hit && hit.url === url) {
    if (!hit.buffer) decodes.raise(url, priority)
    return hit.promise
  }
  const entry: Entry = { url, buffer: null, promise: Promise.resolve(null) }
  entry.promise = decodes.run(() => decodeAudio(url), priority, url).then(
    (buffer) => {
      entry.buffer = buffer
      // Counted against the budget now that its size is known (unless it was let go meanwhile).
      if (decoded.peek(asset.id) === entry) decoded.measure(asset.id)
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

/** Frees decoded audio and streams for assets that left the project. */
export function pruneAudio(keep: Set<string>) {
  for (const [id, s] of streams) {
    if (keep.has(id)) continue
    live.delete(id)
    void s.stream.then((st) => st?.close())
    streams.delete(id)
  }
  decoded.prune((key) => keep.has(key.split('|')[0]))
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

/**
 * The copy of `base` a clip plays — reversed, denoised — or `base` itself. A
 * copy that's ready comes back as a buffer; one still being made, as a promise.
 */
function variant(asset: Asset, clip: Clip, base: AudioBuffer): Promise<AudioBuffer | null> | AudioBuffer {
  const denoise = clip.audio.denoise
  if (!denoise && !clip.reverse) return base
  const key = variantKey(asset, clip)
  const hit = decoded.get(key)
  if (hit) return hit.buffer ?? hit.promise
  const entry: Entry = { url: key, buffer: null, promise: Promise.resolve(null) }
  entry.promise = (async () => {
    let b = base
    if (denoise) b = await denoised(b)
    if (clip.reverse) b = reversed(b)
    return b
  })()
    .catch((err) => {
      console.warn('Audio processing failed', err)
      return null
    })
    .then((b) => {
      entry.buffer = b
      if (decoded.peek(key) === entry) decoded.measure(key)
      // Settled before anyone hears it's ready, so playback picks it up straight away.
      readyListeners.forEach((fn) => fn(asset.id))
      return b
    })
  decoded.set(key, entry)
  return entry.promise
}

const variantKey = (asset: Asset, clip: Clip) => `${asset.id}|${audioSourceUrl(asset)}|${clip.audio.denoise ? 'dn' : ''}|${clip.reverse ? 'rev' : ''}`

/** The buffer a clip plays right now (sync), or null while it's still being prepared. */
function clipBufferNow(asset: Asset, clip: Clip): AudioBuffer | null {
  const base = audioBuffer(asset)
  if (!base) return null
  const v = variant(asset, clip, base)
  return v instanceof AudioBuffer ? v : null
}

async function clipBuffer(asset: Asset, clip: Clip): Promise<AudioBuffer | null> {
  const base = await loadAudio(asset)
  if (!base) return null
  return await variant(asset, clip, base)
}

// ─── Long recordings ─────────────────────────────────────────────────────

/**
 * Past this length a file isn't decoded whole: playback, export and analysis
 * read it a window at a time. (A minute of 48 kHz stereo is 23 MB decoded; ten
 * minutes would be 230 MB per file, which a media-heavy project can't afford.)
 */
export const STREAM_OVER_SECONDS = 60

/** Whether a file this many seconds long is streamed rather than decoded whole. */
export const streamsAudio = (duration: number | undefined) => (duration ?? 0) > STREAM_OVER_SECONDS

export const isLongAudio = (asset: Asset | undefined) => Boolean(asset && streamsAudio(asset.duration))

/** A file the streaming reader can't open (only the browser's decoder can) is decoded whole instead, up to this long. */
const WHOLE_FALLBACK_SECONDS = 10 * 60

/**
 * Readers this many files keep open at once (each holds at most its 8 MB read
 * cache); the others let go of theirs until they're read again. Plenty for every
 * long recording that plays at the same moment.
 */
const LIVE_STREAMS = 24

const streams = new Map<string, { url: string; stream: Promise<AudioStream | null> }>()
const live = new Lru<string, AudioStream>({ max: LIVE_STREAMS, evict: (s) => s.rest() })

/** A long file's reader (opened once per file). Opening it, and every read, put it among the live ones. */
export function audioStream(asset: Asset): Promise<AudioStream | null> {
  const url = audioSourceUrl(asset)
  if (!url) return Promise.resolve(null)
  const hit = streams.get(asset.id)
  if (hit && hit.url === url) return hit.stream
  if (hit) {
    live.delete(asset.id)
    void hit.stream.then((old) => old?.close())
  }
  const stream: Promise<AudioStream | null> = openAudioStream(url).then(async (opened) => {
    if (!opened && (asset.duration ?? 0) <= WHOLE_FALLBACK_SECONDS) {
      // Not a file the streaming reader knows: decoded whole (as every file once was), and read the same way.
      const whole = await decodes.run(() => decodeAudio(url), NOW, url)
      opened = whole ? bufferStream(whole) : null
    }
    if (!opened) return null
    const inner = opened
    // Only while it's still this asset's reader (not one replaced or let go meanwhile).
    const touch = () => {
      if (streams.get(asset.id)?.stream === stream) live.set(asset.id, tracked)
    }
    const tracked: AudioStream = {
      ...inner,
      read: (from, to) => {
        touch()
        return inner.read(from, to)
      },
    }
    touch()
    return tracked
  })
  streams.set(asset.id, { url, stream })
  return stream
}

/** Streamed denoising starts this much earlier than what's heard, so the network has settled there and chunks join seamlessly. */
const DENOISE_LEAD = 1

/** Source seconds [s0, s1) of a long file, reversed or denoised as the clip needs, with the second it starts at. */
async function streamChunk(asset: Asset, clip: Clip, s0: number, s1: number): Promise<{ buffer: AudioBuffer; start: number } | null> {
  const stream = await audioStream(asset)
  if (!stream) return null
  // RNNoise works in 10 ms frames: starting on that grid puts every chunk's frames in the same places.
  const a = Math.max(0, clip.audio.denoise ? Math.floor((s0 - DENOISE_LEAD) * 100) / 100 : s0)
  const b = Math.min(stream.duration, s1)
  let buffer = await stream.read(a, b)
  if (!buffer) return null
  if (clip.audio.denoise) buffer = await denoised(buffer)
  if (clip.reverse) buffer = reversed(buffer)
  return { buffer, start: a }
}

/**
 * The source seconds a clip plays during timeline window [a, b), with a little room either side.
 * A read decodes from where it starts with a fresh decoder, so the room before is enough for any
 * codec to settle (Opus asks for 80 ms) and what's heard matches the file decoded whole.
 */
function sourceSpan(project: Project, clip: Clip, a: number, b: number): [number, number] {
  const fps = project.settings.fps
  const cs = clip.start / fps
  const at = (T: number) => sourceFrameAt(clip, (T - cs) * fps) / fps
  const x = at(a)
  const y = at(b)
  return [Math.min(x, y) - 0.1, Math.max(x, y) + 0.05]
}

/** Reads a long file a minute at a time (up to `until` seconds). */
async function* minutes(stream: AudioStream, until = Infinity, step = 60) {
  const end = Math.min(stream.duration, until)
  for (let t = 0; t < end; t += step) {
    const buffer = await stream.read(t, Math.min(end, t + step))
    if (buffer) yield { t, buffer }
    // Let the editor breathe between windows.
    await new Promise((r) => setTimeout(r, 0))
  }
}

/**
 * Hands a long file to `use` a minute at a time (up to `until` seconds), for
 * analysis that never needs all of it at once. False when it can't be read.
 */
export async function eachMinute(asset: Asset, use: (buffer: AudioBuffer, t: number) => void | Promise<void>, until = Infinity): Promise<boolean> {
  const stream = await audioStream(asset)
  if (!stream) return false
  for await (const { t, buffer } of minutes(stream, until)) await use(buffer, t)
  return true
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

/** A heard clip and the seconds of the played timeline it sounds in (through the nested clips it's inside). */
export interface AudioSpan {
  clip: Clip
  view: Project
  from: number
  to: number
  /** Seconds added to a time on the clip's timeline give the time on the played one. */
  offset: number
}

/** Every heard clip with the stretch of the played timeline it sounds in — `voices` without building anything. */
export function audioSpans(project: Project): AudioSpan[] {
  const out: AudioSpan[] = []
  const walk = (view: Project, offset: number, window: [number, number], level: number) => {
    const fps = view.settings.fps
    for (const clip of Object.values(view.clips)) {
      const nested = !isAudible(view, clip)
      if (nested && (level >= MAX_NESTING || !nestHeard(view, clip))) continue
      const [a, b] = audibleSpan(view, clip)
      const w: [number, number] = [Math.max(window[0], a + offset), Math.min(window[1], b + offset)]
      if (w[1] - w[0] <= 1e-4) continue
      if (!nested) {
        out.push({ clip, view, from: w[0], to: w[1], offset })
        continue
      }
      const inner = sequenceView(view, clip.sequenceId!)
      if (inner && inner !== view) walk(inner, offset + (clip.start - clip.inPoint) / fps, w, level + 1)
    }
  }
  walk(project, 0, [-Infinity, Infinity], 0)
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
export interface Crossfades {
  /** Frames from the clip's start over which it is still fading in. */
  fadeIn: number
  /** Frames it plays on past its end, fading out. */
  tail: number
  /** Frames of its fade-in that fell before its start (a transition that begins ahead of the cut): it comes in part-way up. */
  inLead?: number
  /** Frames before its end where its fade-out already starts. */
  outLead?: number
}

/** A timeline's clips by track and the frame they start or end on (built once per version of its clips). */
const edges = new WeakMap<Record<string, Clip>, { starts: Map<string, Clip[]>; ends: Map<string, Clip[]> }>()

/** The clip right before or after `clip` on its track — as adjacentBefore / adjacentAfter, without going through every clip each time. */
function neighbour(project: Project, clip: Clip, side: 'before' | 'after') {
  let e = edges.get(project.clips)
  if (!e) {
    e = { starts: new Map(), ends: new Map() }
    const add = (map: Map<string, Clip[]>, key: string, c: Clip) => {
      const list = map.get(key)
      if (list) list.push(c)
      else map.set(key, [c])
    }
    for (const c of Object.values(project.clips)) {
      add(e.starts, `${c.trackId}|${c.start}`, c)
      add(e.ends, `${c.trackId}|${clipEnd(c)}`, c)
    }
    edges.set(project.clips, e)
  }
  const list = side === 'before' ? e.ends.get(`${clip.trackId}|${clip.start}`) : e.starts.get(`${clip.trackId}|${clipEnd(clip)}`)
  return list?.find((c) => c.id !== clip.id)
}

export function crossfades(project: Project, clip: Clip): Crossfades {
  const own = clip.transitionIn && neighbour(project, clip, 'before') ? clip.transitionIn : null
  const inLead = own ? Math.min(transitionLead(own), own.duration) : 0
  const fadeIn = own ? Math.min(own.duration - inLead, clip.duration) : 0
  const next = neighbour(project, clip, 'after')
  const after = next?.transitionIn
  const outLead = after ? Math.min(transitionLead(after), clip.duration) : 0
  const tail = next && after ? Math.min(after.duration - transitionLead(after), next.duration) : 0
  return { fadeIn, tail, ...(inLead ? { inLead } : {}), ...(outLead ? { outLead } : {}) }
}

/** Gain at a local frame including crossfades; past the clip's end (in its handle) it fades out. */
function mixGainAt(clip: Clip, local: number, xf: Crossfades) {
  const outLead = xf.outLead ?? 0
  const inLead = xf.inLead ?? 0
  // The whole fade-out: from `outLead` frames before the end to `tail` frames past it.
  const out = xf.tail + outLead
  if (local >= clip.duration) {
    if (!xf.tail) return 0
    const t = Math.min(1, (local - clip.duration + outLead) / out)
    return clipGainAt(clip, clip.duration - 1e-6) * Math.cos((t * Math.PI) / 2)
  }
  let g = clipGainAt(clip, local)
  if (outLead && local > clip.duration - outLead) g *= Math.cos((((local - (clip.duration - outLead)) / out) * Math.PI) / 2)
  if (xf.fadeIn && local < xf.fadeIn) g *= Math.sin((Math.max(0, (local + inLead) / (xf.fadeIn + inLead)) * Math.PI) / 2)
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
  if (!animated && !clip.audio.fadeIn && !clip.audio.fadeOut && !xf.fadeIn && !xf.tail && !xf.outLead) {
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
 * a mix of its timeline's own tracks — only for nested clips heard `within` the
 * stretch being played or rendered.
 */
function voices(ctx: BaseAudioContext, project: Project, graph: MixGraph, clock: { from: number; at: number }, nodes: NestNodes, within: [number, number] = [-Infinity, Infinity]): Voice[] {
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
        if (!clip.keyframes.volume?.length && !clip.audio.fadeIn && !clip.audio.fadeOut && !xf.fadeIn && !xf.tail && !xf.outLead) gain.gain.value = clipGainAt(clip, 0)
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
  walk(project, (c) => channelFor(graph, c), 0, within, 0)
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
/** Sources scheduled that haven't finished playing. */
const active = new Set<Scheduled>()
let running: { from: number; at: number; project: Project } | null = null
let masterLevel = 1

/**
 * Short files' voices wait here until the playhead is near (and their sound is
 * decoded): only what's about to play holds nodes and buffers.
 */
let waiting: { voice: Voice; asset: Asset; start: number }[] = []

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

type Chunk = { buffer: AudioBuffer; start: number }

/**
 * The first chunk of each long recording sounding where the playhead rests,
 * decoded ahead: pressing play there starts them on time rather than a moment
 * late. Keyed by exactly what's read, so anything edited since isn't used.
 */
let cues: { key: string; chunk: Promise<Chunk | null> }[] = []
const cueKey = (asset: Asset, clip: Clip, s0: number, s1: number) => `${variantKey(asset, clip)}|${s0}|${s1}`

function takeCue(asset: Asset, clip: Clip, s0: number, s1: number) {
  const i = cues.findIndex((c) => c.key === cueKey(asset, clip, s0, s1))
  return i < 0 ? null : cues.splice(i, 1)[0].chunk
}

/** Keeps a scheduled source until it has played; then its nodes, and with them its buffer (a streamed chunk's own), are let go. */
function track(s: Scheduled | null) {
  if (!s) return
  active.add(s)
  s.source.onended = () => {
    if (!active.delete(s)) return
    // A moment later, so whatever is still inside the voice's processing (a compressor's lookahead) gets out first.
    setTimeout(() => s.nodes.forEach((n) => n.disconnect()), 250)
  }
}

/** Schedules what's coming up: waiting voices once they're near, and the next chunk of each long recording. */
function topUp() {
  if (!running || !ctx || !graph) return
  const nowT = running.from + (ctx.currentTime - running.at)
  if (waiting.length) scheduleWaiting(nowT)
  topUpStreams(nowT)
}

function scheduleWaiting(nowT: number) {
  const r = running!
  const c = ctx!
  // On time, a voice is placed exactly; one that's late (its sound was still decoding) joins in where playback is now.
  const from = Math.max(r.from, r.from + (c.currentTime + 0.02 - r.at))
  waiting = waiting.filter((w) => {
    if (w.start > nowT + LOOKAHEAD) return true
    const buffer = clipBufferNow(w.asset, w.voice.clip)
    if (!buffer) {
      void clipBuffer(w.asset, w.voice.clip) // ready → onAudioReady → topUp
      return true
    }
    track(scheduleVoice(c, w.voice, buffer, from, Infinity, r.at + (from - r.from)))
    return false
  })
}

function topUpStreams(nowT: number) {
  const gen = generation
  for (const s of streamers) {
    if (s.busy) continue
    const [, end] = voiceSpan(s.voice)
    if (s.until >= end - 1e-3 || s.until > nowT + LOOKAHEAD) continue
    s.busy = true
    const a = Math.max(s.until, nowT)
    const b = Math.min(end, a + CHUNK)
    const v = s.voice
    const [s0, s1] = sourceSpan(v.view, v.clip, a - v.offset, b - v.offset)
    void (takeCue(s.asset, v.clip, s0, s1) ?? streamChunk(s.asset, v.clip, s0, s1))
      .then((chunk) => {
        if (gen !== generation || !running || !ctx || !graph) return
        s.until = b
        if (!chunk) return
        // A decode that ran late joins in where playback is now, still in sync.
        const now = running.from + (ctx.currentTime - running.at) + 0.03
        const from = Math.max(a, now)
        track(scheduleVoice(ctx, v, chunk.buffer, from, b, running.at + (from - running.from), chunk.start))
      })
      .catch((err) => console.warn('Streaming audio failed', err))
      .finally(() => {
        s.busy = false
        if (gen === generation) topUp()
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
    cues = []
    return at
  },

  /** Playback will start at timeline second `at` (the playhead rests there, or a loop comes back to it): decodes the first chunk long recordings play from there. */
  cue(project: Project, at: number) {
    cues = []
    for (const s of audioSpans(project)) {
      // Sounding there, or starting too soon after to be read in time once play is pressed.
      if (s.from >= at + 0.5 || at >= s.to) continue
      const asset = s.view.assets[s.clip.assetId!]
      if (!isLongAudio(asset)) continue
      // The same stretch playback asks for first when it starts at `at` (see topUpStreams).
      const a = Math.max(at, s.from)
      const [s0, s1] = sourceSpan(s.view, s.clip, a - s.offset, Math.min(s.to, a + CHUNK) - s.offset)
      cues.push({ key: cueKey(asset, s.clip, s0, s1), chunk: streamChunk(asset, s.clip, s0, s1).catch(() => null) })
    }
  },

  stop() {
    running = null
    this.stopAll()
  },

  stopAll() {
    generation++
    streamers = []
    waiting = []
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
    active.clear()
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

  /** The preview volume, as a gain (0..1). Only what the speakers get: exports never pass through it. */
  setMonitor(gain: number) {
    masterLevel = gain
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
  for (const v of voices(ctx, project, graph, { from, at }, liveNest, [from, Infinity])) {
    const [start, end] = voiceSpan(v)
    if (end <= from || end - start <= 1e-4) continue
    const asset = v.view.assets[v.clip.assetId!]
    if (isLongAudio(asset)) streamers.push({ voice: v, asset, until: Math.max(from, start), busy: false })
    else waiting.push({ voice: v, asset, start })
  }
  topUp()
  if (waiting.length || streamers.length) streamTimer = setInterval(topUp, 500)
}

// Sound that finishes decoding mid-play joins in at the current position.
onAudioReady(() => topUp())

// ─── Getting sound ready ─────────────────────────────────────────────────

/** Long files' readers are opened ahead of time when their sound is this close to the playhead (seconds). */
const OPEN_AHEAD = 30

/** The stretch of the played timeline a span is away from second `at`. */
const away = (s: AudioSpan, at: number) => Math.max(0, s.from - at, at - s.to)

/**
 * Gets sound ready before it's played: short files are decoded nearest the
 * playhead first, a few at a time, as many as the decoded-audio budget holds;
 * long ones have their readers opened once they're close.
 */
export function prefetchAudio(project: Project, at: number) {
  const spans = audioSpans(project).sort((a, b) => away(a, at) - away(b, at))
  const seen = new Set<string>()
  const wanted: string[] = []
  let bytes = 0
  for (const s of spans) {
    const asset = s.view.assets[s.clip.assetId!]
    if (!asset || seen.has(asset.id)) continue
    seen.add(asset.id)
    const distance = away(s, at)
    if (isLongAudio(asset)) {
      if (distance < OPEN_AHEAD) void audioStream(asset)
      continue
    }
    bytes += (asset.duration ?? 0) * BYTES_PER_SECOND
    // Past what the budget keeps, decoding ahead would only push out what's nearer; that decodes when its turn comes.
    if (bytes > DECODED_BUDGET * 0.75) continue
    void loadAudio(asset, NOW + 1 + distance)
    wanted.push(asset.id)
  }
  // Decodes start nearest first; in the cache, the nearest are also the last to be let go.
  for (let i = wanted.length - 1; i >= 0; i--) decoded.get(wanted[i])
}

// ─── Export mixdown ──────────────────────────────────────────────────────

/**
 * Decodes (and processes) the sound an export starts with. Long recordings are
 * read block by block while exporting; short files are got ready in timeline
 * order as far as the decoded-audio budget goes, and the rest decode when the
 * export reaches them.
 */
export async function prepareAudio(project: Project, onProgress?: (done: number, total: number) => void) {
  const leaves = audioSpans(project)
    .filter(({ clip, view }) => !isLongAudio(view.assets[clip.assetId!]))
    .sort((a, b) => a.from - b.from)
  const fits = new Map<string, boolean>()
  let bytes = 0
  const ready = leaves.filter(({ clip, view }) => {
    const asset = view.assets[clip.assetId!]
    const key = variantKey(asset, clip)
    if (!fits.has(key)) {
      bytes += (asset.duration ?? 0) * BYTES_PER_SECOND * (clip.audio.denoise || clip.reverse ? 2 : 1)
      fits.set(key, bytes <= DECODED_BUDGET * 0.75)
    }
    return fits.get(key)
  })
  let done = 0
  for (const { clip, view } of ready) {
    await clipBuffer(view.assets[clip.assetId!], clip)
    onProgress?.(++done, ready.length)
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
  // Only what's heard in this block gets nodes (a nested timeline elsewhere gets no mix of its own).
  for (const v of voices(off, project, mix, { from: start, at: 0 }, { graphs: [], gains: [] }, [start, to])) {
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
