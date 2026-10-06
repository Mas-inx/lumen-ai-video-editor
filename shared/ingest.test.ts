import { describe, expect, it } from 'vitest'
import { clipStatusBody, codecLabel, INGEST_META_BYTES, IngestError, ingestFileBase, maxFrameBytes, metaSummary, parseClipRequest, rawFrameBytes, vp9Codec, vp9Level, wantsIngestProxy, type IngestClip } from './ingest'

const parse = (body: unknown) => parseClipRequest(body, { quality: 'master' })
const codeOf = (body: unknown) => {
  try {
    parse(body)
    return null
  } catch (err) {
    return err instanceof IngestError ? `${err.status} ${err.code}` : 'threw'
  }
}

describe('ingest clip requests', () => {
  it('fill in what the sender leaves out', () => {
    expect(parse({ name: '  silhouette_arrival_04_valet ', width: 2560, height: 1440, fps: 30, frames: 100 })).toEqual({
      name: 'silhouette_arrival_04_valet',
      width: 2560,
      height: 1440,
      fps: 30,
      frames: 100,
      format: 'rgba',
      origin: 'top-left',
      quality: 'master',
      meta: {},
    })
    const full = parse({ width: 1080, height: 1920, fps: 59.94, format: 'bgra', origin: 'bottom-left', quality: 'lossless', meta: { source: 'gs-cinematic-studio', from: 440, nested: { no: 1 }, ok: true } })
    expect(full).toMatchObject({ name: 'Clip', frames: 0, format: 'bgra', origin: 'bottom-left', quality: 'lossless', meta: { source: 'gs-cinematic-studio', from: 440, nested: { no: 1 }, ok: true } })
  })

  it('keep what the sender says about a clip, cue sheet included', () => {
    const cues = [{ at: 1.5, frame: 485, kind: 'speech', speaker: 'Boss', text: 'You are late.', seconds: 1.5 }]
    const { meta } = parse({ width: 64, height: 36, fps: 30, meta: { source: 'gs-cinematic-studio', samples: 8, cues, fn: () => 1, nothing: undefined, bad: NaN } })
    expect(meta).toEqual({ source: 'gs-cinematic-studio', samples: 8, cues })
    // Lists of clips carry the short form: a list is counted.
    expect(metaSummary(meta)).toEqual({ source: 'gs-cinematic-studio', samples: 8, cues: 1 })
    // Too much is left out; the clip is still taken.
    const huge = parse({ width: 64, height: 36, fps: 30, meta: { shot: 'A', cues: Array.from({ length: 9000 }, (_, i) => ({ at: i, kind: 'marker', label: 'x'.repeat(80) })), small: [1, 2] } })
    expect(JSON.stringify(huge.meta.cues ?? '').length).toBeLessThanOrEqual(INGEST_META_BYTES)
    expect(huge.meta).toEqual({ shot: 'A', small: [1, 2] })
    expect(parse({ width: 64, height: 36, fps: 30, meta: ['not', 'an', 'object'] }).meta).toEqual({})
  })

  it('name what is wrong', () => {
    expect(codeOf(null)).toBe('400 bad_request')
    expect(codeOf({ width: 1920, height: 1081, fps: 30 })).toBe('400 bad_size')
    expect(codeOf({ width: 8, height: 8, fps: 30 })).toBe('400 bad_size')
    expect(codeOf({ width: 7680, height: 4322, fps: 30 })).toBe('400 too_large')
    expect(codeOf({ width: 1920, height: 1080, fps: 500 })).toBe('400 bad_fps')
    expect(codeOf({ width: 1920, height: 1080, fps: 30, frames: -1 })).toBe('400 bad_frames')
    expect(codeOf({ width: 1920, height: 1080, fps: 30, format: 'jpeg' })).toBe('400 bad_format')
    expect(codeOf({ width: 1920, height: 1080, fps: 30, origin: 'middle' })).toBe('400 bad_origin')
    expect(codeOf({ width: 1920, height: 1080, fps: 30, quality: 'ultra' })).toBe('400 bad_quality')
  })

  it('know how big a frame is', () => {
    expect(rawFrameBytes(1920, 1080)).toBe(8_294_400)
    expect(maxFrameBytes({ width: 3840, height: 2160, format: 'rgba' })).toBe(33_177_600)
    expect(maxFrameBytes({ width: 64, height: 36, format: 'png' })).toBeGreaterThan(rawFrameBytes(64, 36))
    expect(wantsIngestProxy(1920, 1080)).toBe(false)
    expect(wantsIngestProxy(2560, 1080)).toBe(true)
    expect(wantsIngestProxy(1440, 2560)).toBe(true)
  })

  it('make safe file names', () => {
    expect(ingestFileBase('silhouette_arrival_04_valet')).toBe('silhouette_arrival_04_valet')
    expect(ingestFileBase('a/b\\c:d*e?"f<g>h|i')).toBe('a b c d e f g h i')
    expect(ingestFileBase('trailing dots...')).toBe('trailing dots')
    expect(ingestFileBase('CON')).toBe('Clip')
    expect(ingestFileBase('   ')).toBe('Clip')
  })

  it('report status the way senders poll for it', () => {
    const clip: IngestClip = { id: 'c1', name: 'shot', width: 64, height: 36, fps: 30, frames: 30, format: 'rgba', origin: 'top-left', quality: 'master', meta: {}, status: 'receiving', received: 12, encoded: 10, createdAt: 1, updatedAt: 2 }
    expect(clipStatusBody(clip)).toEqual({ clip_id: 'c1', name: 'shot', status: 'receiving', received: 12, encoded: 10, frames: 30, quality: 'master' })
    expect(clipStatusBody({ ...clip, status: 'done', received: 30, encoded: 30, assetId: 'asset_1', path: 'C:\\clip.mp4', durationSeconds: 1, codec: 'VP9 4:4:4', bytes: 99 })).toMatchObject({
      status: 'done',
      asset_id: 'asset_1',
      path: 'C:\\clip.mp4',
      duration_seconds: 1,
      codec: 'VP9 4:4:4',
      bytes: 99,
    })
    expect(clipStatusBody({ ...clip, status: 'error', error: 'It broke' })).toMatchObject({ status: 'error', error: 'It broke' })
  })
})

describe('the master’s codec string', () => {
  it('carries the level the size and frame rate need', () => {
    expect(vp9Level(1920, 1080, 30)).toBe(40)
    expect(vp9Level(1920, 1080, 60)).toBe(41)
    expect(vp9Level(2560, 1440, 30)).toBe(50)
    expect(vp9Level(3840, 2160, 30)).toBe(50)
    expect(vp9Level(3840, 2160, 60)).toBe(51)
    expect(vp9Level(7680, 4320, 30)).toBe(60)
    expect(vp9Level(64, 36, 30)).toBe(10)
  })

  it('says 4:4:4, 8-bit, BT.709, limited range', () => {
    expect(vp9Codec(2560, 1440, 30)).toBe('vp09.01.50.08.03.01.01.01.00')
    expect(vp9Codec(3840, 2160, 60)).toBe('vp09.01.51.08.03.01.01.01.00')
    expect(vp9Codec(1920, 1080, 30, 'yuv420')).toBe('vp09.00.40.08.01.01.01.01.00')
  })

  it('says RGB, full range, for lossless masters', () => {
    expect(vp9Codec(2560, 1440, 30, 'rgb')).toBe('vp09.01.50.08.03.01.13.00.01')
    expect(codecLabel('rgb', 'lossless')).toBe('VP9 RGB 4:4:4 8-bit (lossless)')
    expect(codecLabel('yuv444', 'master')).toBe('VP9 4:4:4 8-bit (visually lossless)')
    expect(codecLabel('yuv420', 'compact', 'avc')).toContain('H.264')
  })
})
