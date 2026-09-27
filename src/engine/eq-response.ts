/**
 * The frequency response of a channel EQ, for drawing its curve. The filters
 * are the Web Audio spec's biquads (Audio EQ Cookbook), so the curve is exactly
 * what the mixer applies.
 */
import type { EqSettings } from '@/editor/types'

interface Coeffs {
  b0: number
  b1: number
  b2: number
  a0: number
  a1: number
  a2: number
}

const SAMPLE_RATE = 48000

function shelf(kind: 'low' | 'high', freq: number, gain: number, fs: number): Coeffs {
  const A = Math.pow(10, gain / 40)
  const w0 = (2 * Math.PI * freq) / fs
  const cos = Math.cos(w0)
  // Web Audio's shelves use a slope of 1.
  const alpha = (Math.sin(w0) / 2) * Math.SQRT2
  const k = 2 * Math.sqrt(A) * alpha
  return kind === 'low'
    ? { b0: A * (A + 1 - (A - 1) * cos + k), b1: 2 * A * (A - 1 - (A + 1) * cos), b2: A * (A + 1 - (A - 1) * cos - k), a0: A + 1 + (A - 1) * cos + k, a1: -2 * (A - 1 + (A + 1) * cos), a2: A + 1 + (A - 1) * cos - k }
    : { b0: A * (A + 1 + (A - 1) * cos + k), b1: -2 * A * (A - 1 + (A + 1) * cos), b2: A * (A + 1 + (A - 1) * cos - k), a0: A + 1 - (A - 1) * cos + k, a1: 2 * (A - 1 - (A + 1) * cos), a2: A + 1 - (A - 1) * cos - k }
}

function peaking(freq: number, gain: number, q: number, fs: number): Coeffs {
  const A = Math.pow(10, gain / 40)
  const w0 = (2 * Math.PI * freq) / fs
  const alpha = Math.sin(w0) / (2 * q)
  const cos = Math.cos(w0)
  return { b0: 1 + alpha * A, b1: -2 * cos, b2: 1 - alpha * A, a0: 1 + alpha / A, a1: -2 * cos, a2: 1 - alpha / A }
}

/** Web Audio's highpass takes its Q in dB; the mixer uses -3.01 dB, a flat Butterworth. */
export const LOW_CUT_Q_DB = -3.0103

function highpass(freq: number, qDb: number, fs: number): Coeffs {
  const w0 = (2 * Math.PI * freq) / fs
  const alpha = Math.sin(w0) / (2 * Math.pow(10, qDb / 20))
  const cos = Math.cos(w0)
  return { b0: (1 + cos) / 2, b1: -(1 + cos), b2: (1 + cos) / 2, a0: 1 + alpha, a1: -2 * cos, a2: 1 - alpha }
}

function magnitudeDb(c: Coeffs, freq: number, fs: number) {
  const w = (2 * Math.PI * freq) / fs
  const [c1, s1, c2, s2] = [Math.cos(w), Math.sin(w), Math.cos(2 * w), Math.sin(2 * w)]
  const nr = c.b0 + c.b1 * c1 + c.b2 * c2
  const ni = -(c.b1 * s1 + c.b2 * s2)
  const dr = c.a0 + c.a1 * c1 + c.a2 * c2
  const di = -(c.a1 * s1 + c.a2 * s2)
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di))
}

/** The EQ's gain in dB at each frequency. */
export function eqResponse(eq: EqSettings, freqs: number[], fs = SAMPLE_RATE): number[] {
  const stages: Coeffs[] = [shelf('low', eq.lowFreq, eq.lowGain, fs), peaking(eq.midFreq, eq.midGain, eq.midQ, fs), shelf('high', eq.highFreq, eq.highGain, fs)]
  if (eq.lowCut > 0) stages.unshift(highpass(eq.lowCut, LOW_CUT_Q_DB, fs))
  return freqs.map((f) => stages.reduce((sum, s) => sum + magnitudeDb(s, f, fs), 0))
}

/** Log-spaced frequencies from 20 Hz to 20 kHz. */
export function logFrequencies(count: number, lo = 20, hi = 20000) {
  return Array.from({ length: count }, (_, i) => lo * Math.pow(hi / lo, i / (count - 1)))
}
