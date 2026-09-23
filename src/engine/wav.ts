/** PCM WAV encoding and resampling helpers (transcription uploads, recordings, generated sounds). */

/** Resamples (and mixes down) an AudioBuffer with an OfflineAudioContext. */
export async function resample(buffer: AudioBuffer, sampleRate: number, channels = buffer.numberOfChannels, from = 0, to = buffer.duration): Promise<AudioBuffer> {
  const duration = Math.max(0.01, Math.min(buffer.duration, to) - Math.max(0, from))
  const ctx = new OfflineAudioContext({ numberOfChannels: channels, length: Math.max(1, Math.ceil(duration * sampleRate)), sampleRate })
  const src = ctx.createBufferSource()
  src.buffer = buffer
  src.connect(ctx.destination)
  src.start(0, Math.max(0, from), duration)
  return ctx.startRendering()
}

/** 16-bit PCM WAV bytes. */
export function encodeWav(buffer: AudioBuffer): Uint8Array<ArrayBuffer> {
  const channels = buffer.numberOfChannels
  const frames = buffer.length
  const bytes = frames * channels * 2
  const out = new ArrayBuffer(44 + bytes)
  const v = new DataView(out)
  const str = (o: number, t: string) => {
    for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i))
  }
  str(0, 'RIFF')
  v.setUint32(4, 36 + bytes, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, channels, true)
  v.setUint32(24, buffer.sampleRate, true)
  v.setUint32(28, buffer.sampleRate * channels * 2, true)
  v.setUint16(32, channels * 2, true)
  v.setUint16(34, 16, true)
  str(36, 'data')
  v.setUint32(40, bytes, true)
  const data = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c))
  let o = 44
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const s = Math.max(-1, Math.min(1, data[c][i]))
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true)
      o += 2
    }
  }
  return new Uint8Array(out)
}

/** Mono 16 kHz WAV of a buffer (optionally a time range) — the format speech services want. */
export async function speechWav(buffer: AudioBuffer, from = 0, to = buffer.duration) {
  return encodeWav(await resample(buffer, 16000, 1, from, to))
}
