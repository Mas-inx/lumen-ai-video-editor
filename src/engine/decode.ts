/**
 * Real media decoding (WebCodecs through Mediabunny): probing imported files,
 * poster frames, filmstrip thumbnails, frame-exact video reads for export and
 * full audio decodes for playback, waveforms and the export mix.
 *
 * Media is read straight from disk over lumen-media:// with byte ranges, so
 * multi-gigabyte files never have to be loaded into memory.
 */
import { ALL_FORMATS, AudioBufferSink, CanvasSink, Input, UrlSource, type InputVideoTrack, type WrappedCanvas } from 'mediabunny'

export type MediaKind = 'video' | 'audio' | 'image'

export interface ProbeResult {
  kind: MediaKind
  duration?: number
  width?: number
  height?: number
  fps?: number
  hasAudio: boolean
  /** JPEG data URL of a representative frame (videos). */
  poster?: string
  videoCodec?: string | null
  audioCodec?: string | null
}

export class MediaError extends Error {}

/** Opens a media file for reading (byte ranges over lumen-media://). */
export const openInput = (url: string) =>
  new Input({
    source: new UrlSource(url, { maxCacheSize: 48 * 1024 * 1024, parallelism: 2, getRetryDelay: (n) => (n < 2 ? 0.2 : null) }),
    formats: ALL_FORMATS,
  })

export function kindFromMime(mime: string): MediaKind | null {
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('image/')) return 'image'
  return null
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.decoding = 'async'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new MediaError('This image format isn’t supported.'))
    img.src = url
  })
}

const round3 = (n: number) => Math.round(n * 1000) / 1000

/** Reads everything the editor needs to know about a media file. */
export async function probeMedia(url: string, mime: string): Promise<ProbeResult> {
  const kind = kindFromMime(mime)
  if (kind === 'image') {
    const img = await loadImage(url)
    return { kind, width: img.naturalWidth, height: img.naturalHeight, hasAudio: false }
  }
  const input = openInput(url)
  try {
    const [video, audio] = await Promise.all([input.getPrimaryVideoTrack(), input.getPrimaryAudioTrack()])
    const audioOk = audio ? await audio.canDecode() : false
    if (video && kind !== 'audio') {
      if (!(await video.canDecode())) {
        throw new MediaError(`This video uses ${video.codec ? video.codec.toUpperCase() : 'a codec'} that this computer can’t decode.`)
      }
      const duration = await input.computeDuration()
      const fps = await video
        .computeFrameRateMetrics()
        .then((m) => m.bestGuessFrameRate)
        .catch(() => undefined)
      const sink = new CanvasSink(video, { width: 480 })
      const posterAt = Math.min(1, duration / 3)
      const wrapped = await sink.getCanvas(posterAt).catch(() => null)
      const poster = wrapped ? toJpeg(wrapped.canvas) : undefined
      return {
        kind: 'video',
        duration: round3(duration),
        width: video.displayWidth,
        height: video.displayHeight,
        fps: fps ? Math.round(fps * 1000) / 1000 : undefined,
        hasAudio: audioOk,
        poster,
        videoCodec: video.codec,
        audioCodec: audio?.codec ?? null,
      }
    }
    if (!audio) throw new MediaError('This file has no audio or video Lumen can read.')
    if (!audioOk) throw new MediaError(`This audio uses ${audio.codec ? audio.codec.toUpperCase() : 'a codec'} that this computer can’t decode.`)
    const duration = await input.computeDuration([audio])
    return { kind: 'audio', duration: round3(duration), hasAudio: true, audioCodec: audio.codec }
  } catch (err) {
    if (err instanceof MediaError) throw err
    // Not a container Mediabunny knows: let the browser try (e.g. unusual audio files).
    if (kind === 'audio') {
      const buffer = await decodeWithBrowser(url)
      if (buffer) return { kind: 'audio', duration: round3(buffer.duration), hasAudio: true }
    }
    throw new MediaError('Lumen can’t read this file. It may be damaged or in a format that isn’t supported.')
  } finally {
    input.dispose()
  }
}

function toJpeg(canvas: HTMLCanvasElement | OffscreenCanvas) {
  if (canvas instanceof HTMLCanvasElement) return canvas.toDataURL('image/jpeg', 0.82)
  const c = document.createElement('canvas')
  c.width = canvas.width
  c.height = canvas.height
  c.getContext('2d')!.drawImage(canvas, 0, 0)
  return c.toDataURL('image/jpeg', 0.82)
}

// ─── Filmstrips ──────────────────────────────────────────────────────────

export interface Filmstrip {
  /** Source seconds of each thumbnail. */
  times: number[]
  frames: (ImageBitmap | null)[]
  width: number
  height: number
  done: boolean
}

const filmstrips = new Map<string, Filmstrip>()
const filmstripListeners = new Set<() => void>()
const filmstripQueue: { key: string; url: string; duration: number }[] = []
let filmstripBusy = false

export function onFilmstrip(fn: () => void) {
  filmstripListeners.add(fn)
  return () => void filmstripListeners.delete(fn)
}

const THUMB_H = 90

/** Thumbnails across a video (roughly one per second, at most 180), generated in the background. */
export function getFilmstrip(key: string, url: string, duration: number): Filmstrip | null {
  const hit = filmstrips.get(key)
  if (hit) return hit
  if (!filmstripQueue.some((q) => q.key === key)) {
    filmstripQueue.push({ key, url, duration })
    void pumpFilmstrips()
  }
  return null
}

async function pumpFilmstrips() {
  if (filmstripBusy) return
  filmstripBusy = true
  try {
    while (filmstripQueue.length) {
      const job = filmstripQueue.shift()!
      await buildFilmstrip(job.key, job.url, job.duration).catch((err) => console.warn('Filmstrip failed', err))
    }
  } finally {
    filmstripBusy = false
  }
}

async function buildFilmstrip(key: string, url: string, duration: number) {
  const input = openInput(url)
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track || !(await track.canDecode())) return
    const aspect = track.displayWidth / Math.max(1, track.displayHeight)
    const height = THUMB_H
    const width = Math.max(16, Math.round(height * aspect))
    const count = Math.max(2, Math.min(180, Math.ceil(duration)))
    const step = duration / count
    const times = Array.from({ length: count }, (_, i) => Math.min(duration - 0.001, i * step + step / 2))
    const strip: Filmstrip = { times, frames: times.map(() => null), width, height, done: false }
    filmstrips.set(key, strip)
    const sink = new CanvasSink(track, { width, height, fit: 'cover', poolSize: 2 })
    let i = 0
    let lastNotify = 0
    for await (const wrapped of sink.canvasesAtTimestamps(times)) {
      if (wrapped) strip.frames[i] = await createImageBitmap(wrapped.canvas)
      i++
      const now = performance.now()
      if (now - lastNotify > 120) {
        lastNotify = now
        filmstripListeners.forEach((fn) => fn())
      }
    }
    strip.done = true
    filmstripListeners.forEach((fn) => fn())
  } finally {
    input.dispose()
  }
}

/**
 * Frames of a video at each of `times` (seconds), scaled to fit maxWidth × maxHeight.
 * The canvases are copies the caller owns; null where a frame couldn't be decoded.
 */
export async function framesAt(url: string, times: number[], maxWidth: number, maxHeight: number): Promise<(HTMLCanvasElement | null)[]> {
  const input = openInput(url)
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track || !(await track.canDecode())) return times.map(() => null)
    const scale = Math.min(1, maxWidth / track.displayWidth, maxHeight / track.displayHeight)
    const width = Math.max(2, Math.round(track.displayWidth * scale))
    const height = Math.max(2, Math.round(track.displayHeight * scale))
    const sink = new CanvasSink(track, { width, height, fit: 'fill', poolSize: 2 })
    const out: (HTMLCanvasElement | null)[] = []
    for await (const wrapped of sink.canvasesAtTimestamps(times)) {
      if (!wrapped) {
        out.push(null)
        continue
      }
      const copy = document.createElement('canvas')
      copy.width = width
      copy.height = height
      copy.getContext('2d')!.drawImage(wrapped.canvas, 0, 0)
      out.push(copy)
    }
    return out
  } finally {
    input.dispose()
  }
}

/** Nearest ready thumbnail for a source time. */
export function filmstripFrame(strip: Filmstrip, t: number): ImageBitmap | null {
  if (!strip.times.length) return null
  const step = strip.times.length > 1 ? strip.times[1] - strip.times[0] : 1
  let i = Math.round((t - strip.times[0]) / step)
  i = Math.max(0, Math.min(strip.times.length - 1, i))
  for (let d = 0; d < strip.times.length; d++) {
    const a = strip.frames[i - d]
    if (a) return a
    const b = strip.frames[i + d]
    if (b) return b
  }
  return null
}

// ─── Frame-exact video reads (export) ────────────────────────────────────

/**
 * Reads the frames of one video file in presentation order. `frameAt(t)` returns
 * the frame showing at source time t; calls with increasing t stream through the
 * decoder, a jump backwards (or far ahead) seeks.
 */
export class VideoReader {
  private input: Input
  private sink: Promise<CanvasSink | null>
  private iter: AsyncGenerator<WrappedCanvas, void, unknown> | null = null
  private current: WrappedCanvas | null = null
  private upcoming: WrappedCanvas | null | undefined = undefined
  private ended = false
  private lastT = -Infinity

  constructor(url: string, maxWidth: number, maxHeight: number) {
    this.input = openInput(url)
    this.sink = this.input.getPrimaryVideoTrack().then(async (track: InputVideoTrack | null) => {
      if (!track || !(await track.canDecode())) return null
      const scale = Math.min(1, maxWidth / track.displayWidth, maxHeight / track.displayHeight)
      const width = Math.max(2, Math.round(track.displayWidth * scale))
      const height = Math.max(2, Math.round(track.displayHeight * scale))
      return new CanvasSink(track, { width, height, fit: 'fill', poolSize: 4 })
    })
  }

  private async restart(t: number) {
    await this.iter?.return()
    const sink = await this.sink
    this.iter = sink ? sink.canvases(Math.max(0, t)) : null
    this.current = null
    this.upcoming = undefined
    this.ended = !this.iter
  }

  async frameAt(t: number): Promise<HTMLCanvasElement | OffscreenCanvas | null> {
    if (!this.iter || t < this.lastT - 1e-6 || t - this.lastT > 4) await this.restart(t)
    this.lastT = t
    if (!this.iter) return null
    const eps = 1e-4
    while (!this.ended) {
      if (this.upcoming === undefined) {
        const r = await this.iter.next()
        this.upcoming = r.done ? null : r.value
        if (r.done) this.ended = true
      }
      if (this.upcoming && this.upcoming.timestamp <= t + eps) {
        this.current = this.upcoming
        this.upcoming = undefined
        continue
      }
      break
    }
    // Before the first frame (or past the end): show the nearest frame we have.
    return (this.current ?? this.upcoming ?? null)?.canvas ?? null
  }

  dispose() {
    void this.iter?.return()
    this.input.dispose()
  }
}

// ─── Audio ───────────────────────────────────────────────────────────────

let decodeCtx: OfflineAudioContext | null = null

async function decodeWithBrowser(url: string): Promise<AudioBuffer | null> {
  try {
    const res = await fetch(url)
    const size = Number(res.headers.get('content-length') ?? 0)
    if (size > 400 * 1024 * 1024) return null
    decodeCtx ??= new OfflineAudioContext(2, 1, 48000)
    return await decodeCtx.decodeAudioData(await res.arrayBuffer())
  } catch {
    return null
  }
}

/**
 * Decodes the whole audio track of a file (audio or video) into one AudioBuffer
 * at its native sample rate. Returns null when the file has no decodable audio.
 */
export async function decodeAudio(url: string): Promise<AudioBuffer | null> {
  const input = openInput(url)
  try {
    const track = await input.getPrimaryAudioTrack()
    if (!track) return null
    if (!(await track.canDecode())) return await decodeWithBrowser(url)
    const sampleRate = track.sampleRate
    const channels = Math.max(1, Math.min(2, track.numberOfChannels))
    const parts: { buffer: AudioBuffer; timestamp: number }[] = []
    let end = 0
    let start = Infinity
    for await (const chunk of new AudioBufferSink(track).buffers()) {
      parts.push({ buffer: chunk.buffer, timestamp: chunk.timestamp })
      start = Math.min(start, chunk.timestamp)
      end = Math.max(end, chunk.timestamp + chunk.buffer.duration)
    }
    if (!parts.length) return null
    // Timestamps are relative to the file; anything before 0 is encoder priming.
    const origin = Math.min(0, start)
    const length = Math.max(1, Math.ceil((end - origin) * sampleRate))
    const out = new AudioBuffer({ length, numberOfChannels: channels, sampleRate })
    for (const { buffer, timestamp } of parts) {
      const offset = Math.round((timestamp - origin) * sampleRate)
      for (let c = 0; c < channels; c++) {
        const src = buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1))
        const room = length - offset
        if (room <= 0) continue
        out.copyToChannel(room >= src.length ? src : src.subarray(0, room), c, Math.max(0, offset))
      }
    }
    if (origin < 0) {
      // Drop the priming samples so the buffer starts at media time 0.
      const skip = Math.round(-origin * sampleRate)
      const trimmed = new AudioBuffer({ length: Math.max(1, length - skip), numberOfChannels: channels, sampleRate })
      for (let c = 0; c < channels; c++) trimmed.copyToChannel(out.getChannelData(c).subarray(skip), c)
      return trimmed
    }
    return out
  } catch (err) {
    console.warn('Audio decode failed, trying the browser decoder', err)
    return await decodeWithBrowser(url)
  } finally {
    input.dispose()
  }
}

// ─── Streaming audio ─────────────────────────────────────────────────────

/**
 * A long recording read a window at a time instead of decoded whole — an hour
 * of stereo audio is well over a gigabyte once decoded. Playback, export,
 * waveforms and analysis read just the stretch they need.
 */
export interface AudioStream {
  sampleRate: number
  channels: number
  /** Seconds */
  duration: number
  /** Decoded audio for source seconds [from, to), clamped to the file; sample 0 is `from`. */
  read(from: number, to: number): Promise<AudioBuffer | null>
  close(): void
}

export async function openAudioStream(url: string): Promise<AudioStream | null> {
  const input = openInput(url)
  try {
    const track = await input.getPrimaryAudioTrack()
    if (!track || !(await track.canDecode())) {
      input.dispose()
      return null
    }
    const sink = new AudioBufferSink(track)
    const duration = await track.computeDuration()
    const sampleRate = track.sampleRate
    const channels = Math.max(1, Math.min(2, track.numberOfChannels))
    // Reads share one decoder, so they queue rather than interleave.
    let queue: Promise<unknown> = Promise.resolve()
    const read = (from: number, to: number) => {
      const job = queue.then(async () => {
        const a = Math.max(0, from)
        const b = Math.min(duration, to)
        if (b - a <= 0) return null
        const length = Math.max(1, Math.round((b - a) * sampleRate))
        const out = new AudioBuffer({ length, numberOfChannels: channels, sampleRate })
        for await (const chunk of sink.buffers(a, b)) {
          const offset = Math.round((chunk.timestamp - a) * sampleRate)
          for (let c = 0; c < channels; c++) {
            const src = chunk.buffer.getChannelData(Math.min(c, chunk.buffer.numberOfChannels - 1))
            const skip = Math.max(0, -offset)
            const at = Math.max(0, offset)
            const n = Math.min(src.length - skip, length - at)
            if (n > 0) out.copyToChannel(src.subarray(skip, skip + n), c, at)
          }
        }
        return out
      })
      queue = job.catch(() => {})
      return job
    }
    return { sampleRate, channels, duration, read, close: () => input.dispose() }
  } catch (err) {
    console.warn('Couldn’t open the audio for streaming', err)
    input.dispose()
    return null
  }
}
