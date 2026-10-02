/**
 * Finding the beat: tempo, beat times and downbeats of a piece of music, so
 * cuts, punch-ins and motion graphics can land on it.
 *
 * 1. Onset strength — how much new sound starts at each moment — from the
 *    spectral flux of a short-time spectrum (mono, at about 11 kHz).
 * 2. Tempo — the beat period that best explains the onsets, by autocorrelation,
 *    with a gentle preference for 70–180 BPM (where music usually lives).
 * 3. Beats — dynamic programming (after Ellis, 2007): the sequence of onset
 *    peaks that stays closest to that period.
 * 4. Downbeats — assuming 4/4, the beat phase with the most low-end energy.
 */

export interface BeatGrid {
  bpm: number
  /** Beat times in seconds (source time). */
  times: number[]
  /** The first beat of each bar (4/4), seconds. */
  downbeats: number[]
  /** 0..1: how clearly periodic the music is (low for speech or ambient sound). */
  confidence: number
}

const N = 512 // analysis window (about 46 ms at 11 kHz)
const HOP = 128 // about 11.6 ms between frames

// ─── FFT (radix 2, in place) ─────────────────────────────────────────────

function fftTables(n: number) {
  const rev = new Uint32Array(n)
  const bits = Math.log2(n)
  for (let i = 0; i < n; i++) {
    let r = 0
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b)
    rev[i] = r
  }
  const cos = new Float32Array(n / 2)
  const sin = new Float32Array(n / 2)
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((-2 * Math.PI * i) / n)
    sin[i] = Math.sin((-2 * Math.PI * i) / n)
  }
  return { rev, cos, sin }
}

function fft(re: Float32Array, im: Float32Array, t: ReturnType<typeof fftTables>) {
  const n = re.length
  for (let i = 0; i < n; i++) {
    const j = t.rev[i]
    if (j > i) {
      const r = re[i]
      re[i] = re[j]
      re[j] = r
      const m = im[i]
      im[i] = im[j]
      im[j] = m
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1
    const step = n / size
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const c = t.cos[k * step]
        const s = t.sin[k * step]
        const a = start + k
        const b = a + half
        const tr = re[b] * c - im[b] * s
        const ti = re[b] * s + im[b] * c
        re[b] = re[a] - tr
        im[b] = im[a] - ti
        re[a] += tr
        im[a] += ti
      }
    }
  }
}

// ─── Onsets ──────────────────────────────────────────────────────────────

/** Mono, low-passed and decimated to about 11 kHz. */
function prepare(channels: Float32Array[], sampleRate: number) {
  const factor = Math.max(1, Math.round(sampleRate / 11025))
  const len = Math.floor(channels[0].length / factor)
  const out = new Float32Array(len)
  for (let i = 0; i < len; i++) {
    let s = 0
    for (let k = 0; k < factor; k++) for (const ch of channels) s += ch[i * factor + k]
    out[i] = s / (factor * channels.length)
  }
  return { samples: out, rate: sampleRate / factor }
}

interface Envelope {
  /** Onset strength per frame, normalized. */
  onset: Float32Array
  /** Low-end (kick) flux per frame. */
  low: Float32Array
  /** Frames per second. */
  fps: number
}

async function onsetEnvelope(samples: Float32Array, rate: number, yieldEvery = 2000): Promise<Envelope> {
  const frames = Math.max(0, Math.floor((samples.length - N) / HOP))
  const t = fftTables(N)
  const win = new Float32Array(N)
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1))
  const re = new Float32Array(N)
  const im = new Float32Array(N)
  const bins = N / 2
  const lowBins = Math.max(2, Math.round((160 / rate) * N))
  let prev = new Float32Array(bins)
  let cur = new Float32Array(bins)
  const onset = new Float32Array(frames)
  const low = new Float32Array(frames)
  for (let f = 0; f < frames; f++) {
    const o = f * HOP
    for (let i = 0; i < N; i++) {
      re[i] = samples[o + i] * win[i]
      im[i] = 0
    }
    fft(re, im, t)
    let flux = 0
    let lflux = 0
    for (let k = 1; k < bins; k++) {
      // Log-compressed magnitude: loud and quiet onsets both count.
      const m = Math.log1p(100 * Math.hypot(re[k], im[k]))
      cur[k] = m
      const d = m - prev[k]
      if (d > 0) {
        flux += d
        if (k <= lowBins) lflux += d
      }
    }
    onset[f] = flux
    low[f] = lflux
    const swap = prev
    prev = cur
    cur = swap
    if (f % yieldEvery === yieldEvery - 1) await new Promise((r) => setTimeout(r, 0))
  }
  // Remove the slow trend and keep the peaks.
  const fps = rate / HOP
  const span = Math.max(1, Math.round(fps * 0.4))
  const out = new Float32Array(frames)
  let acc = 0
  const prefix = new Float64Array(frames + 1)
  for (let i = 0; i < frames; i++) prefix[i + 1] = prefix[i] + onset[i]
  for (let i = 0; i < frames; i++) {
    const a = Math.max(0, i - span)
    const b = Math.min(frames, i + span + 1)
    const mean = (prefix[b] - prefix[a]) / (b - a)
    out[i] = Math.max(0, onset[i] - mean)
    acc += out[i] * out[i]
  }
  const rms = Math.sqrt(acc / Math.max(1, frames)) || 1
  for (let i = 0; i < frames; i++) out[i] /= rms
  return { onset: out, low, fps }
}

// ─── Tempo ───────────────────────────────────────────────────────────────

/** The beat period in envelope frames (fractional), and how strong it is. */
export function estimatePeriod(onset: Float32Array, fps: number, minBpm = 60, maxBpm = 200) {
  const minLag = Math.floor((fps * 60) / maxBpm)
  const maxLag = Math.ceil((fps * 60) / minBpm)
  const n = onset.length
  let energy = 0
  for (let i = 0; i < n; i++) energy += onset[i] * onset[i]
  const ac = new Float32Array(maxLag + 2)
  for (let lag = minLag; lag <= maxLag + 1 && lag < n; lag++) {
    let s = 0
    for (let i = lag; i < n; i++) s += onset[i] * onset[i - lag]
    ac[lag] = s / Math.max(1, n - lag)
  }
  let best = minLag
  let bestScore = -Infinity
  for (let lag = minLag; lag <= maxLag && lag < n; lag++) {
    const bpm = (fps * 60) / lag
    // A log-normal preference centred on 120 BPM, about an octave wide.
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 1, 2))
    const score = ac[lag] * (0.5 + prior)
    if (score > bestScore) {
      bestScore = score
      best = lag
    }
  }
  // Sub-frame precision from the peak's neighbours.
  const y0 = ac[best - 1] ?? ac[best]
  const y1 = ac[best]
  const y2 = ac[best + 1] ?? ac[best]
  const denom = y0 - 2 * y1 + y2
  const shift = denom !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / denom)) : 0
  const mean = energy / Math.max(1, n)
  const confidence = mean > 0 ? Math.max(0, Math.min(1, (y1 / mean - 0.2) / 0.8)) : 0
  return { period: best + shift, confidence }
}

// ─── Beats ───────────────────────────────────────────────────────────────

/** The most plausible beat frames given the onsets and a period (dynamic programming). */
export function trackBeats(onset: Float32Array, period: number, tightness = 100): number[] {
  const n = onset.length
  if (n < 4 || !(period > 1)) return []
  // Smooth the onsets a little around each frame (beats are a few frames wide).
  const radius = Math.max(1, Math.round(period / 16))
  const local = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let k = -radius; k <= radius; k++) {
      const j = i + k
      if (j >= 0 && j < n) s += onset[j] * Math.exp(-0.5 * ((k / (radius / 2 || 1)) ** 2))
    }
    local[i] = s
  }
  const score = new Float32Array(n)
  const back = new Int32Array(n).fill(-1)
  const lo = Math.round(period / 2)
  const hi = Math.round(period * 2)
  for (let t = 0; t < n; t++) {
    let best = 0
    let arg = -1
    for (let tau = t - hi; tau <= t - lo; tau++) {
      if (tau < 0) continue
      const penalty = tightness * Math.pow(Math.log((t - tau) / period), 2)
      const v = score[tau] - penalty
      if (arg < 0 || v > best) {
        best = v
        arg = tau
      }
    }
    score[t] = local[t] + (arg >= 0 ? Math.max(0, best) : 0)
    back[t] = arg >= 0 && best > 0 ? arg : -1
  }
  // End on the best-scoring frame in the last period, then follow the links back.
  let end = n - 1
  let top = -Infinity
  for (let t = Math.max(0, n - Math.round(period)); t < n; t++)
    if (score[t] > top) {
      top = score[t]
      end = t
    }
  const beats: number[] = []
  for (let t = end; t >= 0; t = back[t]) {
    beats.push(t)
    if (back[t] < 0) break
  }
  beats.reverse()
  // Drop a weak first beat that's only there as the chain's start.
  return beats
}

/** Which beat (0–3) starts the bar: the phase with the most low-end punch. */
export function downbeatPhase(beats: number[], low: Float32Array) {
  const sums = [0, 0, 0, 0]
  beats.forEach((b, i) => {
    let v = 0
    for (let k = -1; k <= 1; k++) v += low[b + k] ?? 0
    sums[i % 4] += v
  })
  return sums.indexOf(Math.max(...sums))
}

/** Tempo, beats and downbeats of decoded audio (seconds from the start of `channels`). */
export async function detectBeats(channels: Float32Array[], sampleRate: number, opts: { maxSeconds?: number } = {}): Promise<BeatGrid> {
  const limit = Math.floor(sampleRate * (opts.maxSeconds ?? 15 * 60))
  const clipped = channels.map((c) => (c.length > limit ? c.subarray(0, limit) : c))
  const { samples, rate } = prepare(clipped, sampleRate)
  const env = await onsetEnvelope(samples, rate)
  if (env.onset.length < env.fps * 2) return { bpm: 0, times: [], downbeats: [], confidence: 0 }
  const { period, confidence } = estimatePeriod(env.onset, env.fps)
  const frames = trackBeats(env.onset, period)
  const toSec = (f: number) => Math.round(((f * HOP + N / 2) / rate) * 1000) / 1000
  const times = frames.map(toSec)
  const phase = downbeatPhase(frames, env.low)
  return {
    bpm: Math.round(((env.fps * 60) / period) * 10) / 10,
    times,
    downbeats: times.filter((_, i) => i % 4 === phase),
    confidence: Math.round(confidence * 100) / 100,
  }
}
