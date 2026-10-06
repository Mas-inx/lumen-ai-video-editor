/// <reference lib="webworker" />
/**
 * The ingest encoder. It pulls a clip's frames from the receiver in the main
 * process (off the editor's thread), converts each to the master's colour
 * (Y′CbCr 4:4:4, BT.709) and encodes it once: VP9 with full colour resolution,
 * in software, so it works and looks the same on every graphics card. Large
 * clips get a small H.264 proxy from the same frames. The files' bytes go back
 * to the page, which writes them to disk.
 */
import { CanvasSource, EncodedPacket, EncodedVideoPacketSource, Mp4OutputFormat, Output, QUALITY_HIGH, StreamTarget, type StreamTargetChunk } from 'mediabunny'
import { codecLabel, INGEST_PROXY_HEIGHT, ingestQuality, MASTER_COLOR, MASTER_COLOR_RGB, rawFrameBytes, vp9Codec, type IngestClip, type MasterPixels } from '@shared/ingest'
import { avcLevel } from '@/engine/codec-strings'
import { toGbr, toI420, toI444 } from './ingest-convert'

export type IngestToWorker = { type: 'start'; clip: IngestClip; nextUrl: string; proxy: boolean } | { type: 'written'; id: number } | { type: 'cancel' }

export type IngestFromWorker =
  | { type: 'write'; id: number; file: 'master' | 'proxy'; position: number; data: Uint8Array }
  | { type: 'progress'; encoded: number }
  | { type: 'done'; frames: number; codec: string; label: string; proxy: { width: number; height: number } | null }
  | { type: 'error'; message: string; cancelled: boolean }

const scope = self as unknown as DedicatedWorkerGlobalScope
const post = (msg: IngestFromWorker, transfer: Transferable[] = []) => scope.postMessage(msg, transfer)

class Cancelled extends Error {}

const abort = new AbortController()
let nextWrite = 1
const written = new Map<number, () => void>()

/** A file on the page's side: each chunk is posted there and waits for its write. */
function fileSink(file: 'master' | 'proxy') {
  return new WritableStream<StreamTargetChunk>({
    write: (chunk) =>
      new Promise<void>((resolve) => {
        const id = nextWrite++
        written.set(id, resolve)
        // The muxer reuses its buffer: copy the bytes out before they travel.
        const data = chunk.data.slice()
        post({ type: 'write', id, file, position: chunk.position, data }, [data.buffer])
      }),
  })
}

interface Plan {
  kind: 'vp9' | 'avc'
  pixels: MasterPixels
  config: VideoEncoderConfig
  /** Fixed quantizer per frame, or null for a bitrate. */
  quantizer: number | null
  /** What goes in the file's sample entry. */
  codec: string
  label: string
}

const supported = async (config: VideoEncoderConfig) => (await VideoEncoder.isConfigSupported(config).catch(() => null))?.supported === true

/**
 * The best master this computer can encode: VP9 4:4:4 (as RGB when it's to be
 * lossless, so every pixel comes back exactly), then 4:2:0, then H.264 at a
 * high bitrate.
 */
async function choose(clip: IngestClip): Promise<Plan> {
  const { width, height, fps } = clip
  const quantizer = ingestQuality(clip.quality).quantizer
  const order: MasterPixels[] = clip.quality === 'lossless' ? ['rgb', 'yuv444', 'yuv420'] : ['yuv444', 'yuv420']
  for (const pixels of order) {
    const codec = vp9Codec(width, height, fps, pixels)
    const config: VideoEncoderConfig = { codec, width, height, framerate: fps, bitrateMode: 'quantizer', latencyMode: 'quality', hardwareAcceleration: 'prefer-software' }
    if (await supported(config)) return { kind: 'vp9', pixels, config, quantizer, codec, label: codecLabel(pixels, clip.quality) }
  }
  const bitrate = Math.min(240_000_000, Math.round(width * height * fps * (clip.quality === 'compact' ? 0.25 : 0.5)))
  const codec = `avc1.6400${avcLevel(width, height, fps, bitrate).toString(16).padStart(2, '0')}`
  for (const hardwareAcceleration of ['prefer-hardware', 'prefer-software'] as const) {
    const config: VideoEncoderConfig = { codec, width, height, framerate: fps, bitrate, bitrateMode: 'variable', latencyMode: 'quality', hardwareAcceleration, avc: { format: 'avc' } }
    if (await supported(config)) return { kind: 'avc', pixels: 'yuv420', config, quantizer: null, codec, label: codecLabel('yuv420', clip.quality, 'avc') }
  }
  throw new Error(`This computer has no video encoder for ${width}×${height} at ${fps} fps.`)
}

let pngCanvas: OffscreenCanvas | null = null

/** A PNG frame as raw RGBA, top row first. */
async function decodePng(bytes: Uint8Array, width: number, height: number) {
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/png' }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
  try {
    if (bitmap.width !== width || bitmap.height !== height) throw new Error(`A PNG frame is ${bitmap.width}×${bitmap.height}, but the clip is ${width}×${height}.`)
    pngCanvas ??= new OffscreenCanvas(width, height)
    const ctx = pngCanvas.getContext('2d', { willReadFrequently: true })!
    ctx.globalCompositeOperation = 'copy'
    ctx.drawImage(bitmap, 0, 0)
    const { data } = ctx.getImageData(0, 0, width, height)
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  } finally {
    bitmap.close()
  }
}

/** The small H.264 copy the preview plays for large clips. */
async function openProxy(clip: IngestClip) {
  const height = Math.min(INGEST_PROXY_HEIGHT, clip.height) & ~1
  const width = Math.max(2, Math.round((clip.width * height) / clip.height / 2) * 2)
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d', { alpha: false })!
  ctx.imageSmoothingQuality = 'high'
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: new StreamTarget(fileSink('proxy'), { chunked: true, chunkSize: 2 * 1024 * 1024 }) })
  // A key frame every second keeps scrubbing snappy.
  const source = new CanvasSource(canvas, { codec: 'avc', bitrate: QUALITY_HIGH, keyFrameInterval: 1, latencyMode: 'quality' })
  output.addVideoTrack(source, { frameRate: clip.fps })
  await output.start()
  const flip = clip.origin === 'bottom-left' && clip.format !== 'png'
  return {
    width,
    height,
    /** Takes the raw frame's buffer with it. */
    async add(raw: Uint8Array, index: number) {
      const frame = new VideoFrame(raw, { format: clip.format === 'bgra' ? 'BGRX' : 'RGBX', codedWidth: clip.width, codedHeight: clip.height, timestamp: 0, transfer: [raw.buffer] } as VideoFrameBufferInit)
      if (flip) ctx.setTransform(1, 0, 0, -1, 0, height)
      ctx.drawImage(frame, 0, 0, width, height)
      frame.close()
      await source.add(index / clip.fps, 1 / clip.fps)
    },
    async finish() {
      source.close()
      await output.finalize()
    },
    cancel: () => output.cancel().catch(() => {}),
  }
}

async function run(clip: IngestClip, nextUrl: string, wantProxy: boolean) {
  const { width, height, fps } = clip
  const plan = await choose(clip)
  const color = plan.pixels === 'rgb' ? MASTER_COLOR_RGB : MASTER_COLOR
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: new StreamTarget(fileSink('master'), { chunked: true, chunkSize: 8 * 1024 * 1024 }) })
  const source = new EncodedVideoPacketSource(plan.kind)
  output.addVideoTrack(source, { frameRate: fps })
  await output.start()
  const proxy = wantProxy ? await openProxy(clip).catch(() => null) : null

  let failure: Error | null = null
  let encoded = 0
  let first = true
  // Packets reach the file in order, one write at a time.
  let muxing: Promise<unknown> = Promise.resolve()
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      const packet = EncodedPacket.fromEncodedChunk(chunk)
      let packetMeta: EncodedVideoChunkMetadata | undefined
      if (first) {
        first = false
        // The file says exactly what the pixels are: the codec with its colour fields, and the same in the container.
        packetMeta = { decoderConfig: { ...(meta?.decoderConfig ?? {}), codec: plan.codec, codedWidth: width, codedHeight: height, colorSpace: color } }
      }
      muxing = muxing
        .then(() => source.add(packet, packetMeta))
        .then(() => {
          encoded++
        })
        .catch((err: unknown) => {
          failure ??= err instanceof Error ? err : new Error(String(err))
        })
    },
    error: (err) => {
      failure ??= new Error(`The encoder stopped: ${err.message}`)
    },
  })
  encoder.configure(plan.config)

  const frameMicros = 1e6 / fps
  const keyEvery = Math.max(1, Math.round(fps))
  const order = clip.format === 'bgra' ? 'bgra' : 'rgba'
  const flip = clip.origin === 'bottom-left' && clip.format !== 'png'
  const expected = rawFrameBytes(width, height)
  const convert = plan.pixels === 'rgb' ? toGbr : plan.pixels === 'yuv444' ? toI444 : toI420
  let index = 0
  let lastReport = 0
  try {
    for (;;) {
      if (failure) throw failure
      let res: Response
      try {
        res = await fetch(nextUrl, { cache: 'no-store', signal: abort.signal })
      } catch {
        throw new Cancelled()
      }
      // Nothing yet: ask again.
      if (res.status === 202) continue
      if (res.status === 204) break
      if (res.status !== 200) throw new Cancelled()
      const body = new Uint8Array(await res.arrayBuffer())
      const raw = clip.format === 'png' ? await decodePng(body, width, height) : body
      if (raw.byteLength !== expected) throw new Error(`Frame ${index} is ${raw.byteLength} bytes; a ${width}×${height} frame is ${expected}.`)

      const planes = convert(raw, width, height, order, flip)
      const frame = new VideoFrame(planes, {
        format: plan.pixels === 'yuv420' ? 'I420' : 'I444',
        codedWidth: width,
        codedHeight: height,
        timestamp: Math.round(index * frameMicros),
        duration: Math.round(frameMicros),
        colorSpace: color,
        transfer: [planes.buffer],
      } as VideoFrameBufferInit)
      const options: VideoEncoderEncodeOptions & { vp9?: { quantizer: number } } = { keyFrame: index % keyEvery === 0 }
      if (plan.quantizer !== null) options.vp9 = { quantizer: plan.quantizer }
      encoder.encode(frame, options)
      frame.close()
      if (proxy) await proxy.add(raw, index)
      index++

      // Frames never pile up inside the encoder: the sender waits instead.
      while (encoder.encodeQueueSize > 2 && !failure) await new Promise((r) => setTimeout(r, 2))
      const now = performance.now()
      if (now - lastReport > 250) {
        lastReport = now
        post({ type: 'progress', encoded })
      }
    }
    if (failure) throw failure
    if (!index) throw new Error('The clip has no frames.')
    await encoder.flush()
    await muxing
    if (failure) throw failure
    encoder.close()
    source.close()
    await output.finalize()
    let proxySize: { width: number; height: number } | null = null
    if (proxy) {
      try {
        await proxy.finish()
        proxySize = { width: proxy.width, height: proxy.height }
      } catch {
        // The master is what matters; a proxy can be made later.
        await proxy.cancel()
      }
    }
    post({ type: 'done', frames: index, codec: plan.codec, label: plan.label, proxy: proxySize })
  } catch (err) {
    try {
      if (encoder.state !== 'closed') encoder.close()
    } catch {
      /* already closed by its own error */
    }
    await output.cancel().catch(() => {})
    await proxy?.cancel()
    throw err
  }
}

scope.onmessage = (e: MessageEvent<IngestToWorker>) => {
  const msg = e.data
  if (msg.type === 'written') {
    written.get(msg.id)?.()
    written.delete(msg.id)
  } else if (msg.type === 'cancel') abort.abort()
  else if (msg.type === 'start') {
    run(msg.clip, msg.nextUrl, msg.proxy).catch((err: unknown) => {
      post({ type: 'error', message: err instanceof Cancelled ? 'Cancelled' : err instanceof Error ? err.message : String(err), cancelled: err instanceof Cancelled })
    })
  }
}
