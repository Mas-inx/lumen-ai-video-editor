/**
 * Lining recordings up by their sound (multicam): each recording becomes an
 * onset envelope (how sharply its loudness rises, 100 times a second), the
 * envelopes are cross-correlated with an FFT to find the offset, and the match
 * is refined at 1 kHz — to about a millisecond, well inside a frame.
 */
import type { Asset } from '@/editor/types'
import { speechAudio } from './audio-engine'

// ─── FFT ─────────────────────────────────────────────────────────────────

/** In-place iterative radix-2 FFT (length a power of two); `inverse` without the 1/n scale. */
export function fft(re: Float64Array, im: Float64Array, inverse = false) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    const half = len >> 1
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < half; k++) {
        const a = i + k
        const b = a + half
        const xr = re[b] * cr - im[b] * ci
        const xi = re[b] * ci + im[b] * cr
        re[b] = re[a] - xr
        im[b] = im[a] - xi
        re[a] += xr
        im[a] += xi
        const t = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = t
      }
    }
  }
}

/**
 * Cross-correlation c[k] = Σ a[n + k]·b[n] for every lag k from −(|b|−1) to |a|−1,
 * returned with index k + |b| − 1.
 */
export function crossCorrelate(a: Float32Array, b: Float32Array): Float64Array {
  const size = 1 << Math.ceil(Math.log2(a.length + b.length))
  const ar = new Float64Array(size)
  const ai = new Float64Array(size)
  const br = new Float64Array(size)
  const bi = new Float64Array(size)
  ar.set(a)
  // b reversed, so the product of spectra is a correlation.
  for (let i = 0; i < b.length; i++) br[i] = b[b.length - 1 - i]
  fft(ar, ai)
  fft(br, bi)
  for (let i = 0; i < size; i++) {
    const r = ar[i] * br[i] - ai[i] * bi[i]
    const im = ar[i] * bi[i] + ai[i] * br[i]
    ar[i] = r
    ai[i] = im
  }
  fft(ar, ai, true)
  const out = new Float64Array(a.length + b.length - 1)
  for (let i = 0; i < out.length; i++) out[i] = ar[i] / size
  return out
}

// ─── Envelopes ───────────────────────────────────────────────────────────

/**
 * Onset strength at `rate` Hz: log loudness per window, its rises kept,
 * normalized to zero mean and unit spread (so a quiet camera mic matches a loud one).
 */
export function onsetEnvelope(samples: Float32Array, sampleRate: number, rate: number): Float32Array {
  const hop = sampleRate / rate
  const n = Math.max(1, Math.floor(samples.length / hop))
  const level = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * hop)
    const b = Math.min(samples.length, Math.floor((i + 1) * hop))
    let sum = 0
    for (let k = a; k < b; k++) sum += samples[k] * samples[k]
    level[i] = Math.log10(1e-6 + Math.sqrt(sum / Math.max(1, b - a)))
  }
  const out = new Float32Array(n)
  for (let i = 1; i < n; i++) out[i] = Math.max(0, level[i] - level[i - 1])
  let mean = 0
  for (const v of out) mean += v
  mean /= n
  let spread = 0
  for (const v of out) spread += (v - mean) ** 2
  spread = Math.sqrt(spread / n) || 1
  for (let i = 0; i < n; i++) out[i] = (out[i] - mean) / spread
  return out
}

export interface SyncResult {
  /** Seconds after the reference starts that this recording starts (negative: it started earlier). */
  offset: number
  /** How clearly the sound matched (peak height in standard deviations; above ~8 is solid). */
  confidence: number
}

/** Where `b` lines up against `a`, from their envelopes at `rate` Hz. */
export function envelopeOffset(a: Float32Array, b: Float32Array, rate: number): SyncResult {
  const c = crossCorrelate(a, b)
  let best = 0
  for (let i = 1; i < c.length; i++) if (c[i] > c[best]) best = i
  let mean = 0
  for (const v of c) mean += v
  mean /= c.length
  let spread = 0
  for (const v of c) spread += (v - mean) ** 2
  spread = Math.sqrt(spread / c.length) || 1
  // Lag k: a[n + k] matches b[n] — b's start sits k samples into a.
  const lag = best - (b.length - 1)
  return { offset: lag / rate, confidence: (c[best] - mean) / spread }
}

/** Refines an offset by searching ±`reach` seconds around it with finer envelopes. */
export function refineOffset(a: Float32Array, b: Float32Array, rate: number, coarse: number, reach: number) {
  const center = Math.round(coarse * rate)
  const span = Math.max(1, Math.round(reach * rate))
  let bestLag = center
  let bestScore = -Infinity
  for (let lag = center - span; lag <= center + span; lag++) {
    // Overlap of a[n + lag] and b[n].
    const n0 = Math.max(0, -lag)
    const n1 = Math.min(b.length, a.length - lag)
    if (n1 - n0 < rate) continue
    let s = 0
    for (let n = n0; n < n1; n++) s += a[n + lag] * b[n]
    s /= n1 - n0
    if (s > bestScore) {
      bestScore = s
      bestLag = lag
    }
  }
  return bestLag / rate
}

/** A recording's sound as mono samples (16 kHz — plenty for timing). */
async function monoSamples(asset: Asset): Promise<{ data: Float32Array; rate: number }> {
  const buf = await speechAudio(asset)
  if (!buf) throw new Error(`“${asset.name}” has no sound to sync by.`)
  if (buf.numberOfChannels === 1) return { data: buf.getChannelData(0), rate: buf.sampleRate }
  const data = new Float32Array(buf.length)
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c)
    for (let i = 0; i < data.length; i++) data[i] += ch[i] / buf.numberOfChannels
  }
  return { data, rate: buf.sampleRate }
}

/**
 * Offsets of every recording against the first, from their sound.
 * The reference gets offset 0, confidence Infinity.
 */
export async function syncByAudio(assets: Asset[], onProgress?: (done: number, total: number) => void): Promise<SyncResult[]> {
  if (assets.length < 2) throw new Error('Pick at least two recordings to sync.')
  const total = assets.length * 2
  let done = 0
  const tick = () => onProgress?.(++done, total)
  const ref = await monoSamples(assets[0])
  const refCoarse = onsetEnvelope(ref.data, ref.rate, 100)
  const refFine = onsetEnvelope(ref.data, ref.rate, 1000)
  tick()
  const out: SyncResult[] = [{ offset: 0, confidence: Infinity }]
  for (const asset of assets.slice(1)) {
    const s = await monoSamples(asset)
    tick()
    const coarse = envelopeOffset(refCoarse, onsetEnvelope(s.data, s.rate, 100), 100)
    const fine = refineOffset(refFine, onsetEnvelope(s.data, s.rate, 1000), 1000, coarse.offset, 0.03)
    out.push({ offset: Math.round(fine * 1000) / 1000, confidence: Math.round(coarse.confidence * 10) / 10 })
    tick()
    await new Promise((r) => setTimeout(r, 0))
  }
  return out
}
