/// <reference lib="webworker" />
/**
 * The recorder's encoder: one worker per file being recorded (the screen with
 * its sound, the camera, the microphone). Frames arrive from Chromium's
 * capture as they are made; each is cropped and scaled inside the encoder (no
 * canvas in the way, so 4K at 60 keeps up) and written at a constant frame
 * rate — a frame that never came is the one before it again.
 *
 * The file is a fragmented MP4, so what has been recorded survives a crash and
 * nothing piles up in memory. An encoder that stops part-way (a driver reset,
 * a game changing the display mode) or a window that changes size ends the
 * file there and the recording carries on in the next one, on the next encoder
 * that works.
 */
import { AudioSample, AudioSampleSource, canEncodeAudio, EncodedPacket, EncodedVideoPacketSource, Mp4OutputFormat, Output, StreamTarget, type StreamTargetChunk } from 'mediabunny'
import { captureFrame, type CaptureCodec, type CaptureRate, type CaptureResolution, type Rect } from '@shared/capture'
import { codecString } from '@/engine/codec-strings'
import { CODECS_FOR, describeEncoder, HAS_SOFTWARE, tryEncoderConfig, videoBitrate, type Acceleration, type ExportVideoCodec } from '@/engine/encoders'

export interface VideoJob {
  frames: ReadableStream<VideoFrame>
  /** Part of the source to record, in its pixels; null for all of it. */
  region: Rect | null
  resolution: CaptureResolution
  fps: number
  codec: CaptureCodec
  hardware: boolean
  rate: CaptureRate
  keyframeSeconds: number
  /**
   * What the file says its colours are. Capture hands over the screen's own
   * numbers labelled as something else; this is the label that is true.
   */
  color?: { primaries: 'bt709' | 'smpte432'; transfer: 'bt709' | 'iec61966-2-1' }
}

export type AudioJob =
  /** A microphone or the system's sound, from Chromium. */
  | { kind: 'track'; samples: ReadableStream<AudioData> }
  /** One app's sound from the helper: interleaved 32-bit floats arriving as `pcm` messages. `t` is the first sample's time on the page's clock. */
  | { kind: 'pcm'; sampleRate: number; channels: number; t: number }

export interface RecordJob {
  role: 'screen' | 'webcam' | 'mic'
  video?: VideoJob
  audio?: AudioJob
  /** The page's clock as it sent this (performance.timeOrigin + performance.now()): every time in these messages is on it. */
  clock: number
  /** Test runs: this encoder fails after so many frames, to prove the recording carries on. */
  failAfter?: { codec: ExportVideoCodec; acceleration: Acceleration; frames: number }
}

export interface VideoReady {
  srcWidth: number
  srcHeight: number
  width: number
  height: number
  crop: Rect
  /** "H.264 on the graphics card" */
  encoder: string
  codec: ExportVideoCodec
  acceleration: Acceleration
  bitrate: number
  /** Why this isn't the encoder that was asked for, when it isn't. */
  note?: string
}

/** One finished file of a recording. */
export interface SegmentInfo {
  file: number
  /** Where it starts on the recording, in seconds. */
  from: number
  seconds: number
  frames: number
  width?: number
  height?: number
  fps?: number
  encoder?: string
  hasAudio: boolean
  /** The part of the source it shows. */
  crop?: Rect
  srcWidth?: number
  srcHeight?: number
}

export interface WorkerStats {
  seconds: number
  frames: number
  sourceFps: number
  repeated: number
  dropped: number
  bytes: number
  bitrate: number
  level: number
  /** Milliseconds it takes to hand the encoder a frame (a running average). */
  passMs: number
}

export type CaptureToWorker =
  | { type: 'start'; job: RecordJob }
  | { type: 'go'; at: number }
  | { type: 'pause'; at: number }
  | { type: 'resume'; at: number }
  | { type: 'stop'; at: number }
  | { type: 'abort' }
  | { type: 'written'; id: number }
  | { type: 'pcm'; data: Uint8Array }

export type CaptureFromWorker =
  | { type: 'ready'; video?: VideoReady }
  | { type: 'write'; id: number; file: number; position: number; data: Uint8Array }
  | { type: 'segment'; info: SegmentInfo }
  | { type: 'stats'; stats: WorkerStats }
  | { type: 'note'; message: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

const scope = self as unknown as DedicatedWorkerGlobalScope
const post = (msg: CaptureFromWorker, transfer: Transferable[] = []) => scope.postMessage(msg, transfer)
const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

// ─── Time ────────────────────────────────────────────────────────────────

/** This worker's clock minus the page's. */
let skew = 0
const now = () => performance.timeOrigin + performance.now() - skew

let startAt = Infinity
let stopAt = Infinity
/** Stretches that were paused, on the page's clock; an open one has `to` at infinity. */
const pauses: { from: number; to: number }[] = []

const isPaused = (t: number) => pauses.some((p) => t >= p.from && t < p.to)

/** Seconds on the recording for a time on the page's clock (pauses taken out). */
function clipSeconds(t: number) {
  let paused = 0
  for (const p of pauses) if (t > p.from) paused += Math.min(t, p.to) - p.from
  return (t - startAt - paused) / 1000
}

/**
 * Capture stamps its frames on a clock of its own. The smallest gap seen
 * between a frame's stamp and its arrival is the difference between the two
 * clocks (plus the quickest delivery, a few milliseconds).
 */
class ClockMatch {
  private least = Infinity
  /** A stamp (ms on the source's clock) as a time on the page's clock. */
  at(stamp: number) {
    const gap = now() - stamp
    if (gap < this.least) this.least = gap
    return stamp + this.least
  }
}

// ─── Files ───────────────────────────────────────────────────────────────

let nextWrite = 1
const written = new Map<number, () => void>()
let bytes = 0
let videoBytes = 0

/** A file on the page's side: each piece is posted there and waits for its write. */
function fileSink(file: number) {
  return new WritableStream<StreamTargetChunk>({
    write: (chunk) =>
      new Promise<void>((resolve) => {
        const id = nextWrite++
        written.set(id, resolve)
        // The muxer reuses its buffer: copy the bytes out before they travel.
        const data = chunk.data.slice()
        bytes += data.byteLength
        post({ type: 'write', id, file, position: chunk.position, data }, [data.buffer])
      }),
  })
}

// ─── Encoders ────────────────────────────────────────────────────────────

interface Plan {
  codec: ExportVideoCodec
  acceleration: Acceleration
  bitrate: number
  config: VideoEncoderConfig
}

const planKey = (p: Pick<Plan, 'codec' | 'acceleration'>) => `${p.codec}|${p.acceleration}`
/** Encoders that failed during this recording. */
const failed = new Set<string>()

/**
 * Encoders to try, in order. Recording has to keep up with the screen, so any
 * graphics-card encoder comes before the processor's when the card is wanted:
 * the codec asked for, then the others, then the same on the processor.
 */
export function captureCandidates(codec: CaptureCodec, hardware: boolean): { codec: ExportVideoCodec; acceleration: Acceleration }[] {
  const codecs: ExportVideoCodec[] = [codec, ...CODECS_FOR.mp4.filter((c) => c !== codec)]
  const on = (acceleration: Acceleration) => codecs.filter((c) => acceleration === 'prefer-hardware' || HAS_SOFTWARE[c]).map((c) => ({ codec: c, acceleration }))
  return hardware ? [...on('prefer-hardware'), ...on('prefer-software')] : [...on('prefer-software'), ...on('prefer-hardware')]
}

function captureConfig(codec: ExportVideoCodec, acceleration: Acceleration, width: number, height: number, fps: number, bitrate: number): VideoEncoderConfig {
  return {
    codec: codecString(codec, width, height, fps, bitrate),
    width,
    height,
    bitrate,
    bitrateMode: 'variable',
    framerate: fps,
    // Frames are encoded as they come and never queue up behind a look-ahead.
    latencyMode: 'realtime',
    hardwareAcceleration: acceleration,
    ...(codec === 'avc' ? { avc: { format: 'avc' as const } } : {}),
    ...(codec === 'hevc' ? { hevc: { format: 'hevc' } } : {}),
  } as VideoEncoderConfig
}

/** The first encoder that really encodes at this size (tried with frames), and what was passed over on the way. */
async function choosePlan(job: VideoJob, width: number, height: number): Promise<{ plan: Plan | null; note?: string; tried: string[] }> {
  const tried: string[] = []
  const wanted = captureCandidates(job.codec, job.hardware)
  for (const c of wanted) {
    if (failed.has(planKey(c))) continue
    // A bitrate given in megabits is for the codec asked for; quality works it out per codec.
    const bitrate = job.rate.mode === 'bitrate' ? Math.round(Math.min(400, Math.max(0.5, job.rate.mbps)) * 1e6) : videoBitrate(width, height, job.fps, c.codec, job.rate.quality)
    const config = captureConfig(c.codec, c.acceleration, width, height, job.fps, bitrate)
    const result = await tryEncoderConfig(config, job.fps)
    if (result.ok) {
      const first = wanted[0]
      const note = c.codec === first.codec && c.acceleration === first.acceleration ? undefined : `${describeEncoder(first)} isn’t available at ${width}×${height}, so this is ${describeEncoder(c)}.`
      return { plan: { ...c, bitrate, config }, note, tried }
    }
    tried.push(`${describeEncoder(c)}: ${result.error ?? 'failed'}`)
  }
  return { plan: null, tried }
}

/**
 * An encoder, running. It is made as soon as the picture's size is known and
 * given a frame to chew on, so the first frame of the recording doesn't wait
 * for a graphics card to wake up. What it makes of that frame is thrown away:
 * packets come out in the order frames went in, so it is the first one.
 */
interface Coder {
  plan: Plan
  encoder: VideoEncoder
  /** How to decode what it makes: sent with its first packet, kept for the file's first. */
  decoderConfig?: VideoDecoderConfig
  sink: ((chunk: EncodedVideoChunk) => void) | null
  /** Packets still to come from warm-up frames. */
  warming: number
  failure: Error | null
}

function openCoder(plan: Plan): Coder {
  let failAfter = job.failAfter && job.failAfter.codec === plan.codec && job.failAfter.acceleration === plan.acceleration ? job.failAfter.frames : Infinity
  const coder: Coder = { plan, sink: null, warming: 0, failure: null, encoder: null as unknown as VideoEncoder }
  coder.encoder = new VideoEncoder({
    output: (chunk, meta) => {
      coder.decoderConfig ??= meta?.decoderConfig
      if (coder.warming > 0) return void coder.warming--
      if (!coder.sink) return
      if (--failAfter < 0) return void (coder.failure ??= new Error('The encoder stopped (test).'))
      coder.sink(chunk)
    },
    error: (err) => {
      coder.failure ??= new Error(err.message || 'The encoder stopped.')
    },
  })
  try {
    coder.encoder.configure(plan.config)
  } catch (err) {
    coder.failure = err instanceof Error ? err : new Error(String(err))
  }
  return coder
}

function closeCoder(coder: Coder | null) {
  try {
    if (coder && coder.encoder.state !== 'closed') coder.encoder.close()
  } catch {
    /* closed by its own error */
  }
}

// ─── A file being written ────────────────────────────────────────────────

interface Segment {
  file: number
  /** Where on the recording it starts, in seconds. */
  from: number
  output: Output
  started: Promise<void>
  video?: {
    source: EncodedVideoPacketSource
    coder: Coder
    srcWidth: number
    srcHeight: number
    width: number
    height: number
    crop: Rect
    cropped: boolean
    /** The next frame of the file to write. */
    next: number
    lastKey: number
    first: boolean
    encoded: number
    muxing: Promise<unknown>
  }
  audio?: {
    source: AudioSampleSource
    /** Sound frames written. */
    frames: number
    rate: number
    adding: Promise<unknown>
  }
}

let job: RecordJob
let phase: 'armed' | 'rolling' | 'stopping' | 'done' = 'armed'
let segment: Segment | null = null
let files = 0
let fatal = false

/** What the picture will be, settled when the first frame shows the source's real size, with the encoder for it. */
let shape: { srcWidth: number; srcHeight: number; width: number; height: number; crop: Rect; cropped: boolean; coder: Coder } | null = null
let audioCodec: 'aac' | 'opus' = 'aac'

let last: VideoFrame | null = null
let repeated = 0
let dropped = 0
let arrived = 0
let totalFrames = 0
let level = 0

function fail(text: string) {
  if (fatal) return
  fatal = true
  post({ type: 'error', message: text })
}

function openSegment(from: number): Segment {
  const file = files++
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 1 }), target: new StreamTarget(fileSink(file)) })
  const seg: Segment = { file, from, output, started: Promise.resolve() }
  if (job.video && shape) {
    const { coder } = shape
    const source = new EncodedVideoPacketSource(coder.plan.codec)
    output.addVideoTrack(source, { frameRate: job.video.fps })
    const video: NonNullable<Segment['video']> = { source, ...shape, next: 0, lastKey: -Infinity, first: true, encoded: 0, muxing: Promise.resolve() }
    coder.sink = (chunk) => {
      const packet = EncodedPacket.fromEncodedChunk(chunk)
      videoBytes += chunk.byteLength
      // The file's first packet says how to decode all of them, and what its colours are.
      const color = job.video!.color
      // (TypeScript's list of primaries stops short of Display P3.)
      const config = coder.decoderConfig && color ? ({ ...coder.decoderConfig, colorSpace: { ...coder.decoderConfig.colorSpace, ...color } } as VideoDecoderConfig) : coder.decoderConfig
      const meta = video.first && config ? { decoderConfig: config } : undefined
      video.first = false
      video.muxing = video.muxing
        .then(() => seg.started)
        .then(() => source.add(packet, meta))
        .then(() => {
          video.encoded++
        })
        .catch((err: unknown) => {
          coder.failure ??= err instanceof Error ? err : new Error(String(err))
        })
    }
    seg.video = video
  }
  if (job.audio) {
    const rate = job.audio.kind === 'pcm' ? job.audio.sampleRate : 48000
    const source = new AudioSampleSource({ codec: audioCodec, bitrate: audioCodec === 'aac' ? 192_000 : 160_000 })
    output.addAudioTrack(source)
    seg.audio = { source, frames: 0, rate, adding: Promise.resolve() }
  }
  seg.started = output.start()
  seg.started.catch((err: unknown) => fail(`Couldn’t start the file: ${message(err)}`))
  return seg
}

/** Closes a file: what is in the encoder is written out unless the encoder is what broke. */
async function closeSegment(seg: Segment, until: number) {
  const v = seg.video
  if (v) {
    if (!v.coder.failure) {
      try {
        await v.coder.encoder.flush()
      } catch (err) {
        v.coder.failure ??= err instanceof Error ? err : new Error(String(err))
      }
    }
    await v.muxing
    v.coder.sink = null
    closeCoder(v.coder)
    v.source.close()
  }
  if (seg.audio) {
    const a = seg.audio
    // The system sends nothing while nothing plays: the track is made as long as the picture.
    const missing = v && job.video ? Math.round((v.next / job.video.fps - a.frames / a.rate) * a.rate) : 0
    if (missing > a.rate * 0.02) {
      const channels = job.audio?.kind === 'pcm' ? job.audio.channels : 2
      const sample = new AudioSample({ data: new Float32Array(missing * channels), format: 'f32', numberOfChannels: channels, sampleRate: a.rate, timestamp: a.frames / a.rate })
      a.frames += missing
      a.adding = a.adding
        .then(() => seg.started)
        .then(() => a.source.add(sample))
        .catch(() => {})
        .finally(() => sample.close())
    }
    await a.adding.catch(() => {})
    a.source.close()
  }
  await seg.started.catch(() => {})
  await seg.output.finalize()
  const fps = job.video?.fps
  const frames = v ? v.encoded : 0
  // A picture's length is the frames it has places for (a skipped one still takes its time).
  const seconds = v && fps ? v.next / fps : seg.audio ? seg.audio.frames / seg.audio.rate : Math.max(0, until - seg.from)
  post({
    type: 'segment',
    info: {
      file: seg.file,
      from: seg.from,
      seconds,
      frames,
      hasAudio: Boolean(seg.audio && seg.audio.frames > 0),
      ...(v ? { width: v.width, height: v.height, fps, encoder: describeEncoder(v.coder.plan), crop: v.crop, srcWidth: v.srcWidth, srcHeight: v.srcHeight } : {}),
    },
  })
}

// ─── Picture ─────────────────────────────────────────────────────────────

const frameClock = new ClockMatch()

/** Works out the picture for a source of this size, finds an encoder for it and starts it on `frame`. */
async function settle(srcWidth: number, srcHeight: number, frame: VideoFrame | null): Promise<boolean> {
  const v = job.video!
  const f = captureFrame(srcWidth, srcHeight, v.region, v.resolution)
  const cropped = f.crop.x !== 0 || f.crop.y !== 0 || f.crop.width !== srcWidth || f.crop.height !== srcHeight
  const { plan, note, tried } = await choosePlan(v, f.width, f.height)
  if (!plan) {
    fail(`No video encoder on this computer takes ${f.width}×${f.height} at ${v.fps} fps.${tried.length ? ` Tried: ${tried.join('; ')}.` : ''} Try a smaller resolution or a lower frame rate.`)
    return false
  }
  const coder = openCoder(plan)
  shape = { srcWidth, srcHeight, width: f.width, height: f.height, crop: f.crop, cropped, coder }
  // Warm it up: what this frame becomes is thrown away.
  if (frame && frame.format !== null && frame.displayWidth === srcWidth && frame.displayHeight === srcHeight) {
    coder.warming++
    pass(coder, frame, 0, true, cropped ? f.crop : null)
    if (coder.failure) coder.warming = 0
  }
  post({ type: 'ready', video: { srcWidth, srcHeight, width: f.width, height: f.height, crop: f.crop, encoder: describeEncoder(plan), codec: plan.codec, acceleration: plan.acceleration, bitrate: plan.bitrate, note } })
  return true
}

/** The encoder is behind: better to skip a frame than to fall further back (and frames it holds are frames the capture can't reuse). */
const overloaded = (seg: Segment) => (seg.video?.coder.encoder.encodeQueueSize ?? 0) > 3

/**
 * What handing the encoder a frame costs this thread, in milliseconds (a
 * running average). Resizing a picture happens here, so a recording scaled up
 * to 4K can take most of a frame's time per frame.
 */
let passCost = 0

/** Gives the encoder one picture, stamped with the time it has in the file (microseconds). */
function pass(coder: Coder, frame: VideoFrame, timestamp: number, keyFrame: boolean, crop: Rect | null) {
  const init: VideoFrameInit = { timestamp, duration: Math.round(1e6 / job.video!.fps) }
  if (crop) init.visibleRect = crop
  const began = performance.now()
  try {
    const out = new VideoFrame(frame, init)
    try {
      coder.encoder.encode(out, { keyFrame })
    } finally {
      out.close()
    }
  } catch (err) {
    coder.failure ??= err instanceof Error ? err : new Error(String(err))
  }
  const took = performance.now() - began
  passCost = passCost ? passCost * 0.9 + took * 0.1 : took
}

/**
 * Whether there is time to write a frame again when the source has gone
 * quiet: only when the encoder has nothing waiting.
 */
const canRepeat = (seg: Segment) => (seg.video?.coder.encoder.encodeQueueSize ?? 0) === 0

function encode(seg: Segment, frame: VideoFrame, slot: number) {
  const v = seg.video!
  const fps = job.video!.fps
  const keyEvery = Math.max(1, Math.round(job.video!.keyframeSeconds * fps))
  const keyFrame = slot - v.lastKey >= keyEvery
  if (keyFrame) v.lastKey = slot
  pass(v.coder, frame, Math.round((slot * 1e6) / fps), keyFrame, v.cropped ? v.crop : null)
  v.next = slot + 1
  totalFrames++
}

/**
 * While the source is quiet (a still window sends nothing), the last picture
 * is written again, so the file keeps its frame rate. With `pin`, the last of
 * them is written whatever it costs: it is what gives the file its length.
 * Returns how many places were left empty.
 *
 * This is only for a source that has stopped sending. A place missed while
 * frames are still arriving is left empty and the picture before it lasts
 * that much longer: on a graphics card shared with what is being recorded,
 * every repeat encoded is time taken from the next real frame.
 */
function fill(seg: Segment, upTo: number, pin = false): number {
  const v = seg.video!
  if (v.next >= upTo || v.coder.failure) return 0
  if (!last) {
    v.next = upTo
    return 0
  }
  let skipped = 0
  while (v.next < upTo && !v.coder.failure) {
    const final = pin && v.next === upTo - 1
    if (!final && !canRepeat(seg)) {
      // No time to repeat: the picture before simply lasts until the next one.
      const to = pin ? upTo - 1 : upTo
      skipped += to - v.next
      v.next = to
      continue
    }
    encode(seg, last, v.next)
    repeated++
  }
  return skipped
}

let rotating: Promise<void> | null = null
let resettling: Promise<void> | null = null

/** Ends the current file and starts the next: the encoder broke, or the source changed size. */
function rotate(why: 'encoder' | 'size', srcWidth: number, srcHeight: number) {
  if (rotating) return rotating
  const seg = segment!
  const at = clipSeconds(now())
  segment = null
  rotating = (async () => {
    const v = seg.video!
    if (why === 'encoder') {
      failed.add(planKey(v.coder.plan))
      post({ type: 'note', message: `${describeEncoder(v.coder.plan)} stopped (${message(v.coder.failure)}). The recording carries on in a new file with another encoder.` })
    } else post({ type: 'note', message: `The window changed size to ${srcWidth}×${srcHeight}. The recording carries on in a new file at the new size.` })
    await closeSegment(seg, at)
    if (!(await settle(srcWidth, srcHeight, last))) return
    if (phase === 'rolling') segment = openSegment(Math.max(at, clipSeconds(now())))
  })()
    .catch((err: unknown) => fail(message(err)))
    .finally(() => {
      rotating = null
    })
  return rotating
}

function onFrame(frame: VideoFrame) {
  arrived++
  const t = frameClock.at(frame.timestamp / 1000)
  const keep = () => {
    last?.close()
    last = frame
  }
  if (phase === 'armed' && shape && !resettling && (frame.displayWidth !== shape.srcWidth || frame.displayHeight !== shape.srcHeight)) {
    // The window was resized before the recording began: the picture is worked out again.
    const old = shape.coder
    resettling = settle(frame.displayWidth, frame.displayHeight, frame)
      .then(() => closeCoder(old))
      .catch((err: unknown) => fail(message(err)))
      .finally(() => {
        resettling = null
      })
  }
  if (phase !== 'rolling' || t < startAt || t >= stopAt || isPaused(t) || rotating) return keep()
  const seg = segment
  if (!seg?.video) return keep()
  const v = seg.video
  if (v.coder.failure) {
    void rotate('encoder', frame.displayWidth, frame.displayHeight)
    return keep()
  }
  if (frame.displayWidth !== v.srcWidth || frame.displayHeight !== v.srcHeight) {
    void rotate('size', frame.displayWidth, frame.displayHeight)
    return keep()
  }
  const place = (clipSeconds(t) - seg.from) * job.video!.fps
  let slot = Math.round(place)
  if (slot < v.next) {
    // More than a frame behind the next free place: the source is simply faster than the file's frame rate.
    if (place <= v.next - 1) return keep()
    // Frames don't arrive on an exact beat. One that rounds onto a taken place takes the next: it is a picture of its own, not a duplicate.
    slot = v.next
  }
  if (overloaded(seg)) {
    dropped++
    v.next = slot + 1
  } else encode(seg, frame, slot)
  keep()
}

async function readFrames(frames: ReadableStream<VideoFrame>) {
  const reader = frames.getReader()
  try {
    for (;;) {
      const { value: frame, done } = await reader.read()
      if (done || phase === 'done') {
        frame?.close()
        break
      }
      if (!shape && !fatal) {
        // The first frame says how big the source really is.
        if (!(await settle(frame.displayWidth, frame.displayHeight, frame))) {
          frame.close()
          break
        }
      }
      if (fatal) {
        frame.close()
        break
      }
      onFrame(frame)
    }
  } catch (err) {
    if (phase !== 'done') fail(`The picture stopped arriving: ${message(err)}`)
  } finally {
    await reader.cancel().catch(() => {})
  }
}

// ─── Sound ───────────────────────────────────────────────────────────────

const soundClock = new ClockMatch()
/** Sound this far from where the clock says it belongs is put right (silence added, or a piece left out). */
const SOUND_SLACK = 0.06

function peak(data: Float32Array) {
  let p = 0
  for (let i = 0; i < data.length; i += 8) {
    const v = Math.abs(data[i])
    if (v > p) p = v
  }
  return p
}

/** Adds interleaved samples that start at `t` (page clock) to the file, in step with the picture. */
function addSound(samples: Float32Array, channels: number, rate: number, t: number) {
  const p = peak(samples)
  if (p > level) level = p
  const seg = segment
  if (phase !== 'rolling' || !seg?.audio || rotating) return
  const count = samples.length / channels
  const end = t + (count / rate) * 1000
  if (end <= startAt || t >= stopAt || isPaused(t)) return
  let data = samples
  // The first piece straddles the start: only what comes after it is kept.
  if (t < startAt) {
    const skip = Math.min(count, Math.ceil(((startAt - t) / 1000) * rate))
    data = samples.subarray(skip * channels)
    t += (skip / rate) * 1000
  }
  if (!data.length) return
  const a = seg.audio
  const want = clipSeconds(t) - seg.from
  const have = a.frames / a.rate
  if (have - want > SOUND_SLACK) return
  const pieces: Float32Array[] = []
  if (want - have > SOUND_SLACK) pieces.push(new Float32Array(Math.round((want - have) * a.rate) * channels))
  pieces.push(data)
  for (const piece of pieces) {
    const timestamp = a.frames / a.rate
    a.frames += piece.length / channels
    const sample = new AudioSample({ data: piece, format: 'f32', numberOfChannels: channels, sampleRate: rate, timestamp })
    a.adding = a.adding
      .then(() => seg.started)
      .then(() => a.source.add(sample))
      .catch((err: unknown) => fail(`The sound couldn’t be written: ${message(err)}`))
      .finally(() => sample.close())
  }
}

async function readSound(samples: ReadableStream<AudioData>) {
  const reader = samples.getReader()
  let scratch = new Float32Array(0)
  try {
    for (;;) {
      const { value: data, done } = await reader.read()
      if (done || phase === 'done') {
        data?.close()
        break
      }
      const channels = Math.min(2, data.numberOfChannels)
      const count = data.numberOfFrames
      const out = new Float32Array(count * channels)
      if (scratch.length < count) scratch = new Float32Array(count)
      for (let c = 0; c < channels; c++) {
        data.copyTo(scratch, { planeIndex: c, format: 'f32-planar' })
        for (let i = 0; i < count; i++) out[i * channels + c] = scratch[i]
      }
      const t = soundClock.at(data.timestamp / 1000)
      const rate = data.sampleRate
      data.close()
      if (segment?.audio && segment.audio.frames === 0) segment.audio.rate = rate
      addSound(out, channels, rate, t)
    }
  } catch (err) {
    if (phase !== 'done') post({ type: 'note', message: `The sound stopped arriving: ${message(err)}` })
  } finally {
    await reader.cancel().catch(() => {})
  }
}

/** Frames of the app's sound received so far: the stream never has gaps, so a count is a time. */
let pcmFrames = 0

function onPcm(bytesIn: Uint8Array) {
  if (job.audio?.kind !== 'pcm') return
  const { channels, sampleRate, t } = job.audio
  const usable = bytesIn.byteLength - (bytesIn.byteLength % (4 * channels))
  // The bytes may sit at any offset: copy them to where 32-bit floats can be read.
  const samples = new Float32Array(usable / 4)
  new Uint8Array(samples.buffer).set(bytesIn.subarray(0, usable))
  const at = t + (pcmFrames / sampleRate) * 1000
  pcmFrames += samples.length / channels
  addSound(samples, channels, sampleRate, at)
}

// ─── Running ─────────────────────────────────────────────────────────────

let beat: ReturnType<typeof setInterval> | null = null
let lastArrived = 0
let lastVideoBytes = 0
let lastStats = 0

/**
 * Frames that are overdue by this long are written as repeats (a still window
 * sends nothing). Long enough that a frame held up on its way here (a busy
 * graphics card can delay one by a tenth of a second or two) still finds its
 * place free.
 */
const LATE_MS = 500

function heartbeat() {
  const t = now()
  const seg = segment
  if (phase === 'rolling' && seg?.video && !rotating && !isPaused(t)) {
    if (seg.video.coder.failure) void rotate('encoder', seg.video.srcWidth, seg.video.srcHeight)
    else fill(seg, Math.floor((clipSeconds(Math.min(t, stopAt) - LATE_MS) - seg.from) * job.video!.fps))
  }
  if (t - lastStats >= 500) {
    const span = (t - lastStats) / 1000
    post({
      type: 'stats',
      stats: {
        seconds: phase === 'armed' ? 0 : Math.max(0, clipSeconds(Math.min(t, stopAt))),
        frames: totalFrames,
        sourceFps: Math.round(((arrived - lastArrived) / span) * 10) / 10,
        repeated,
        dropped,
        bytes,
        bitrate: Math.round(((videoBytes - lastVideoBytes) * 8) / span),
        level,
        passMs: Math.round(passCost * 10) / 10,
      },
    })
    lastStats = t
    lastArrived = arrived
    lastVideoBytes = videoBytes
    level = 0
  }
}

async function start(j: RecordJob) {
  job = j
  skew = performance.timeOrigin + performance.now() - j.clock
  lastStats = now()
  if (j.audio) {
    const channels = j.audio.kind === 'pcm' ? j.audio.channels : 2
    audioCodec = (await canEncodeAudio('aac', { numberOfChannels: channels, sampleRate: 48000, bitrate: 192_000 }).catch(() => false)) ? 'aac' : 'opus'
  }
  // Once a frame: each beat repeats at most one frame, so a still picture keeps the full frame rate only while the encoder keeps up.
  beat = setInterval(heartbeat, Math.max(8, Math.floor(1000 / (j.video?.fps ?? 20))))
  if (j.video) void readFrames(j.video.frames)
  // Sound alone needs nothing settled first.
  else post({ type: 'ready' })
  if (j.audio?.kind === 'track') void readSound(j.audio.samples)
}

function go(at: number) {
  if (phase !== 'armed' || fatal) return
  if (job.video && !shape) return fail('The picture hadn’t arrived yet.')
  startAt = at
  phase = 'rolling'
  segment = openSegment(0)
}

async function stop(at: number) {
  if (phase === 'done' || phase === 'stopping') return
  const was = phase
  phase = 'stopping'
  stopAt = at
  // An open pause ends where the recording does.
  for (const p of pauses) if (p.to === Infinity) p.to = at
  if (beat) clearInterval(beat)
  try {
    if (rotating) await rotating
    const seg = segment
    segment = null
    if (was === 'rolling' && seg) {
      const end = clipSeconds(at)
      if (seg.video && !seg.video.coder.failure) fill(seg, Math.round((end - seg.from) * job.video!.fps), true)
      await closeSegment(seg, end)
    }
    phase = 'done'
    last?.close()
    last = null
    closeCoder(shape?.coder ?? null)
    if (!fatal) post({ type: 'done' })
  } catch (err) {
    phase = 'done'
    fail(message(err))
  }
}

scope.onmessage = (e: MessageEvent<CaptureToWorker>) => {
  const msg = e.data
  if (msg.type === 'written') {
    written.get(msg.id)?.()
    written.delete(msg.id)
  } else if (msg.type === 'pcm') onPcm(msg.data)
  else if (msg.type === 'start') start(msg.job).catch((err: unknown) => fail(message(err)))
  else if (msg.type === 'go') go(msg.at)
  else if (msg.type === 'pause') {
    if (phase === 'rolling' && !pauses.some((p) => p.to === Infinity)) pauses.push({ from: msg.at, to: Infinity })
  } else if (msg.type === 'resume') {
    const open = pauses.find((p) => p.to === Infinity)
    if (open) open.to = Math.max(open.from, msg.at)
    // The first picture after a pause starts a group of frames of its own.
    if (segment?.video) segment.video.lastKey = -Infinity
  } else if (msg.type === 'stop') void stop(msg.at)
  else if (msg.type === 'abort') {
    phase = 'done'
    if (beat) clearInterval(beat)
    void segment?.output.cancel().catch(() => {})
    segment = null
    closeCoder(shape?.coder ?? null)
    last?.close()
    last = null
  }
}
