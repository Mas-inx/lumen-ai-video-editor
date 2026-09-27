/**
 * Loudness the way streaming platforms measure it (ITU-R BS.1770 / EBU R128):
 * K-weighted, gated integrated loudness in LUFS, plus the loudest 3-second
 * stretch, sample peak, RMS and clipping. Plain JS over decoded samples, so it
 * runs on any clip or mix (and in tests).
 */

export interface LoudnessReport {
  /** Integrated loudness in LUFS (null for silence). YouTube and Spotify aim for about −14. */
  lufs: number | null
  /** Loudest 3-second window (short-term LUFS), or null when shorter than 3 s. */
  shortTermMax: number | null
  /** Sample peak in dBFS. */
  peakDb: number
  /** Overall RMS level in dBFS. */
  rmsDb: number
  /** Samples at full scale — audible distortion. */
  clipped: number
  seconds: number
}

interface Biquad {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

// The two K-weighting stages, designed for any sample rate (the same approach as pyloudnorm).
function highShelf(fs: number): Biquad {
  const A = Math.pow(10, 4 / 40)
  const w0 = (2 * Math.PI * 1500) / fs
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2)
  const cos = Math.cos(w0)
  const sq = 2 * Math.sqrt(A) * alpha
  const a0 = A + 1 - (A - 1) * cos + sq
  return {
    b0: (A * (A + 1 + (A - 1) * cos + sq)) / a0,
    b1: (-2 * A * (A - 1 + (A + 1) * cos)) / a0,
    b2: (A * (A + 1 + (A - 1) * cos - sq)) / a0,
    a1: (2 * (A - 1 - (A + 1) * cos)) / a0,
    a2: (A + 1 - (A - 1) * cos - sq) / a0,
  }
}

function highPass(fs: number): Biquad {
  const w0 = (2 * Math.PI * 38) / fs
  const alpha = Math.sin(w0) / (2 * 0.5)
  const cos = Math.cos(w0)
  const a0 = 1 + alpha
  return { b0: (1 + cos) / 2 / a0, b1: -(1 + cos) / a0, b2: (1 + cos) / 2 / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0 }
}

const loudness = (meanSquare: number) => -0.691 + 10 * Math.log10(meanSquare)
const db = (v: number) => (v > 0 ? 20 * Math.log10(v) : -Infinity)

/**
 * Measures loudness a block at a time, so a whole mix never has to sit in memory:
 * the K-weighting filters and 100 ms energy bins carry on across `push` calls.
 */
export class LoudnessMeter {
  private readonly step: number
  private readonly shelf: Biquad
  private readonly pass: Biquad
  /** Per channel: [s1x1, s1x2, s1y1, s1y2, s2x1, s2x2, s2y1, s2y2] */
  private readonly state: Float64Array[] = []
  private energy: number[] = []
  private samples = 0
  private peak = 0
  private sumSq = 0
  private clipped = 0
  private total = 0
  private channelCount = 0

  constructor(private readonly sampleRate: number) {
    this.step = Math.max(1, Math.round(sampleRate * 0.1))
    this.shelf = highShelf(sampleRate)
    this.pass = highPass(sampleRate)
  }

  push(channels: Float32Array[]) {
    const n = channels[0]?.length ?? 0
    const { shelf, pass, step } = this
    this.channelCount = Math.max(this.channelCount, channels.length)
    const bins = Math.ceil((this.samples + n) / step)
    while (this.energy.length < bins) this.energy.push(0)
    channels.forEach((x, c) => {
      const st = (this.state[c] ??= new Float64Array(8))
      let [s1x1, s1x2, s1y1, s1y2, s2x1, s2x2, s2y1, s2y2] = st
      let peak = this.peak
      let sumSq = 0
      let clipped = 0
      let total = 0
      for (let i = 0; i < n; i++) {
        const v = x[i]
        const a = v < 0 ? -v : v
        if (a > peak) peak = a
        if (a >= 0.999) clipped++
        sumSq += v * v
        const y1 = shelf.b0 * v + shelf.b1 * s1x1 + shelf.b2 * s1x2 - shelf.a1 * s1y1 - shelf.a2 * s1y2
        s1x2 = s1x1
        s1x1 = v
        s1y2 = s1y1
        s1y1 = y1
        const y2 = pass.b0 * y1 + pass.b1 * s2x1 + pass.b2 * s2x2 - pass.a1 * s2y1 - pass.a2 * s2y2
        s2x2 = s2x1
        s2x1 = y1
        s2y2 = s2y1
        s2y1 = y2
        this.energy[((this.samples + i) / step) | 0] += y2 * y2
        total += y2 * y2
      }
      st.set([s1x1, s1x2, s1y1, s1y2, s2x1, s2x2, s2y1, s2y2])
      this.peak = peak
      this.sumSq += sumSq
      this.clipped += clipped
      this.total += total
    })
    this.samples += n
  }

  result(): LoudnessReport {
    const { step, samples: n } = this
    // K-weighted energy per 100 ms, summed over channels; blocks are 4 of these (400 ms, 75% overlap).
    const subs = Math.floor(n / step)
    const energy = this.energy
    const blockMeans: number[] = []
    for (let b = 0; b + 4 <= subs; b++) blockMeans.push((energy[b] + energy[b + 1] + energy[b + 2] + energy[b + 3]) / (4 * step))
    let lufs: number | null = null
    if (blockMeans.length) {
      const absolute = blockMeans.filter((m) => m > 0 && loudness(m) > -70)
      if (absolute.length) {
        const relative = loudness(absolute.reduce((s, m) => s + m, 0) / absolute.length) - 10
        const gated = absolute.filter((m) => loudness(m) > relative)
        if (gated.length) lufs = loudness(gated.reduce((s, m) => s + m, 0) / gated.length)
      }
    } else if (this.total > 0 && n > 0) {
      lufs = loudness(this.total / n) // shorter than one 400 ms block: ungated
    }

    let shortTermMax: number | null = null
    let window = 0
    for (let b = 0; b < subs; b++) {
      window += energy[b]
      if (b >= 30) window -= energy[b - 30]
      if (b >= 29 && window > 0) shortTermMax = Math.max(shortTermMax ?? -Infinity, loudness(window / (30 * step)))
    }

    const samples = n * Math.max(1, this.channelCount)
    return {
      lufs: lufs !== null && Number.isFinite(lufs) ? lufs : null,
      shortTermMax,
      peakDb: db(this.peak),
      rmsDb: samples ? db(Math.sqrt(this.sumSq / samples)) : -Infinity,
      clipped: this.clipped,
      seconds: n / this.sampleRate,
    }
  }
}

export function measureLoudness(channels: Float32Array[], sampleRate: number): LoudnessReport {
  const meter = new LoudnessMeter(sampleRate)
  meter.push(channels)
  return meter.result()
}

/** Loudness of a decoded AudioBuffer. */
export function bufferLoudness(buffer: AudioBuffer) {
  return measureLoudness(
    Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c)),
    buffer.sampleRate,
  )
}
