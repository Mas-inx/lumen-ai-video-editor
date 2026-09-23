/**
 * Waveform and speech data the UI reads. Peaks are measured from the decoded
 * audio when media is imported (see project/media-import) and stored with the
 * asset, so waveforms show instantly when a project reopens.
 */
import type { Asset, SpeechSegment } from '@/editor/types'

const cache = new WeakMap<number[], Float32Array>()

export function getPeaks(asset: Asset): Float32Array | null {
  if (!asset.peaks?.length) return null
  let hit = cache.get(asset.peaks)
  if (!hit) {
    hit = Float32Array.from(asset.peaks)
    cache.set(asset.peaks, hit)
  }
  return hit
}

/** Timed speech for an asset (from transcription or a generated voiceover). */
export function speechScript(asset: Asset | undefined): SpeechSegment[] {
  return asset?.transcript?.length ? asset.transcript : []
}
