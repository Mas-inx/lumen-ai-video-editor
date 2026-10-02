/**
 * Playing rendered previews: while the timeline plays over rendered chunks,
 * the preview shows their decoded frames instead of compositing every layer.
 * Each chunk is decoded a few frames ahead of the playhead (hardware decoding,
 * off the main thread), and the next chunk starts decoding shortly before the
 * playhead gets there, so chunk boundaries don't hitch.
 */
import { ALL_FORMATS, Input, UrlSource, VideoSampleSink, type VideoSample } from 'mediabunny'
import type { Project } from '@/editor/types'
import { useUI } from '@/editor/ui-store'
import { chunkFrames, chunkKey, chunkSpan, useRenders } from './render-cache'

/** Frames decoded ahead of the playhead. */
const AHEAD = 6
/** Seconds before a chunk ends that the next one starts decoding. */
const PREFETCH = 0.8

class ChunkReader {
  private samples: VideoSample[] = []
  private input: Input
  private iter: AsyncGenerator<VideoSample, void, unknown> | null = null
  private ended = false
  private pumping = false
  private disposed = false
  /** The last time asked for (chunk seconds): asking for an earlier one means a fresh reader. */
  lastT = -Infinity

  constructor(
    readonly url: string,
    start: number,
  ) {
    this.input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS })
    void this.open(start)
  }

  private async open(start: number) {
    try {
      const track = await this.input.getPrimaryVideoTrack()
      if (!track || this.disposed) {
        this.ended = true
        return
      }
      this.iter = new VideoSampleSink(track).samples(Math.max(0, start))
      void this.pump()
    } catch {
      this.ended = true
    }
  }

  private async pump() {
    if (this.pumping || !this.iter) return
    this.pumping = true
    try {
      while (!this.disposed && !this.ended && this.samples.length < AHEAD) {
        const r = await this.iter.next()
        if (this.disposed) {
          r.value?.close()
          break
        }
        if (r.done) this.ended = true
        else this.samples.push(r.value)
      }
    } catch {
      this.ended = true
    } finally {
      this.pumping = false
    }
  }

  /** The frame showing at `t` (chunk seconds) if it's decoded yet. */
  at(t: number): VideoSample | null {
    const eps = 1e-4
    while (this.samples.length > 1 && this.samples[1].timestamp <= t + eps) this.samples.shift()!.close()
    void this.pump()
    const s = this.samples[0]
    return s && s.timestamp <= t + eps && t < s.timestamp + s.duration + eps ? s : null
  }

  dispose() {
    this.disposed = true
    for (const s of this.samples) s.close()
    this.samples = []
    void this.iter?.return().catch(() => {})
    this.input.dispose()
  }
}

/** Open readers by chunk index: the one playing and the next. */
const readers = new Map<number, ChunkReader>()

function reader(index: number, url: string, t: number) {
  let r = readers.get(index)
  if (r && (r.url !== url || t < r.lastT - 1e-3)) {
    r.dispose()
    readers.delete(index)
    r = undefined
  }
  if (!r) {
    r = new ChunkReader(url, t)
    readers.set(index, r)
  }
  return r
}

/** The URL of a chunk's render, if it has one. */
function renderedUrl(project: Project, index: number) {
  const key = chunkKey(project, index)
  return key ? useRenders.getState().files[key] : undefined
}

export interface RenderedFrame {
  sample: VideoSample
  /** The playhead is near the end of the rendered stretch: live playback takes over soon. */
  endingSoon: boolean
}

/**
 * The rendered frame for `frame` while playing, or null when that stretch
 * isn't rendered (or its frame isn't decoded yet): then the preview draws live.
 */
export function renderedFrame(project: Project, frame: number): RenderedFrame | null {
  if (!useUI.getState().usePreviews) return closeReaders()
  const fps = project.settings.fps
  const len = chunkFrames(fps)
  const index = Math.floor(frame / len)
  const url = renderedUrl(project, index)
  if (!url) return closeReaders()
  const t = (frame - index * len) / fps
  const r = reader(index, url, t)
  r.lastT = t
  const [, f1] = chunkSpan(project, index)
  const left = (f1 - frame) / fps
  let endingSoon = false
  if (left < PREFETCH) {
    const next = renderedUrl(project, index + 1)
    if (next) reader(index + 1, next, 0)
    else endingSoon = true
  }
  for (const [i, rd] of readers)
    if (i !== index && i !== index + 1) {
      rd.dispose()
      readers.delete(i)
    }
  const sample = r.at(t)
  return sample ? { sample, endingSoon } : null
}

/** Lets go of the decoders (playback stopped). */
export function closeReaders(): null {
  for (const r of readers.values()) r.dispose()
  readers.clear()
  return null
}
