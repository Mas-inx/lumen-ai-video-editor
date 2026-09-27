/**
 * Mixer buses: every track feeds its own channel — EQ → compressor → limiter →
 * fader → pan — and every channel feeds the master bus, built the same way.
 * The same graph plays live and renders the export, so the mix you hear is the
 * mix you get. Channels meter themselves for the mixer's level meters.
 */
import type { BusMix, Project } from '@/editor/types'
import { LOW_CUT_Q_DB } from './eq-response'

export const dbToGain = (db: number) => (db <= -60 ? 0 : Math.pow(10, db / 20))

/**
 * DynamicsCompressorNode adds its own make-up gain, (1 / gain at full scale)^0.6
 * (Web Audio spec). Taking it back out makes "make-up" mean exactly what it says,
 * and a limiter's ceiling a real ceiling.
 */
export function autoMakeupDb(threshold: number, ratio: number) {
  const atFullScale = threshold + (0 - threshold) / ratio
  return -0.6 * Math.min(0, atFullScale)
}

export interface Meter {
  left: AnalyserNode
  right: AnalyserNode
  buffer: Float32Array<ArrayBuffer>
}

export interface Bus {
  input: GainNode
  fader: GainNode
  /** Balance: each side's level, so panning never sums the two sides into one. */
  balance: { split: ChannelSplitterNode; left: GainNode; right: GainNode; merge: ChannelMergerNode }
  /** Nodes between input and fader; rebuilt when processors are added or removed. */
  chain: AudioNode[]
  shape: string
  compressor: DynamicsCompressorNode | null
  /** The limiter's first stage (it's two 20:1 stages, so about 400:1). */
  limiter: DynamicsCompressorNode | null
  meter: Meter | null
}

const shapeOf = (mix?: BusMix) =>
  [mix?.eq?.enabled ? (mix.eq.lowCut > 0 ? 'eq+hp' : 'eq') : '', mix?.compressor?.enabled ? 'comp' : '', mix?.limiter?.enabled ? 'lim' : ''].join('|')

/** Whether a mix does anything that carries state from one moment to the next (compressor, limiter). */
export const hasDynamics = (mix?: BusMix) => Boolean(mix?.compressor?.enabled || mix?.limiter?.enabled)

export function createBus(ctx: BaseAudioContext, dest: AudioNode, mix: BusMix | undefined, metered: boolean): Bus {
  // Everything runs in stereo from the channel input on, so a mono source keeps its
  // level (both sides at full) and pans like any other.
  const input = ctx.createGain()
  input.channelCount = 2
  input.channelCountMode = 'explicit'
  input.channelInterpretation = 'speakers'
  const fader = ctx.createGain()
  const balance = { split: ctx.createChannelSplitter(2), left: ctx.createGain(), right: ctx.createGain(), merge: ctx.createChannelMerger(2) }
  fader.connect(balance.split)
  balance.split.connect(balance.left, 0)
  balance.split.connect(balance.right, 1)
  balance.left.connect(balance.merge, 0, 0)
  balance.right.connect(balance.merge, 0, 1)
  balance.merge.connect(dest)
  let meter: Meter | null = null
  if (metered) {
    const splitter = ctx.createChannelSplitter(2)
    const left = ctx.createAnalyser()
    const right = ctx.createAnalyser()
    for (const a of [left, right]) {
      a.fftSize = 2048
      a.smoothingTimeConstant = 0
    }
    balance.merge.connect(splitter)
    splitter.connect(left, 0)
    splitter.connect(right, 1)
    meter = { left, right, buffer: new Float32Array(2048) }
  }
  const bus: Bus = { input, fader, balance, chain: [], shape: '∅', compressor: null, limiter: null, meter }
  applyMix(ctx, bus, mix, true)
  return bus
}

/** Brings a bus in line with `mix`: params glide while playing; processors added or removed rewire the chain. */
export function applyMix(ctx: BaseAudioContext, bus: Bus, mix: BusMix | undefined, immediate = false) {
  const shape = shapeOf(mix)
  if (shape !== bus.shape) {
    bus.input.disconnect()
    for (const n of bus.chain) n.disconnect()
    bus.chain = []
    bus.compressor = null
    bus.limiter = null
    if (mix?.eq?.enabled) {
      const f = (type: BiquadFilterType) => {
        const b = ctx.createBiquadFilter()
        b.type = type
        return b
      }
      if (mix.eq.lowCut > 0) bus.chain.push(f('highpass'))
      bus.chain.push(f('lowshelf'), f('peaking'), f('highshelf'))
    }
    if (mix?.compressor?.enabled) {
      bus.compressor = ctx.createDynamicsCompressor()
      bus.chain.push(bus.compressor, ctx.createGain())
    }
    if (mix?.limiter?.enabled) {
      // Web Audio's ratio stops at 20:1; two stages in a row hold a ceiling to a few hundredths of a dB.
      bus.limiter = ctx.createDynamicsCompressor()
      bus.chain.push(bus.limiter, ctx.createGain(), ctx.createDynamicsCompressor(), ctx.createGain())
    }
    let prev: AudioNode = bus.input
    for (const n of bus.chain) prev = prev.connect(n)
    prev.connect(bus.fader)
    bus.shape = shape
    immediate = true
  }

  const set = (param: AudioParam, value: number) => {
    if (immediate) param.value = value
    else param.setTargetAtTime(value, ctx.currentTime, 0.015)
  }
  let i = 0
  const eq = mix?.eq
  if (eq?.enabled) {
    if (eq.lowCut > 0) {
      const hp = bus.chain[i++] as BiquadFilterNode
      set(hp.frequency, eq.lowCut)
      set(hp.Q, LOW_CUT_Q_DB)
    }
    const [low, mid, high] = [bus.chain[i++], bus.chain[i++], bus.chain[i++]] as BiquadFilterNode[]
    set(low.frequency, eq.lowFreq)
    set(low.gain, eq.lowGain)
    set(mid.frequency, eq.midFreq)
    set(mid.gain, eq.midGain)
    set(mid.Q, eq.midQ)
    set(high.frequency, eq.highFreq)
    set(high.gain, eq.highGain)
  }
  const comp = mix?.compressor
  if (comp?.enabled && bus.compressor) {
    const c = bus.compressor
    set(c.threshold, comp.threshold)
    set(c.ratio, comp.ratio)
    set(c.knee, 0)
    set(c.attack, comp.attack / 1000)
    set(c.release, comp.release / 1000)
    i++
    set((bus.chain[i++] as GainNode).gain, dbToGain(comp.makeup - autoMakeupDb(comp.threshold, comp.ratio)))
  }
  const lim = mix?.limiter
  if (lim?.enabled && bus.limiter) {
    // Each stage's own make-up gain comes back out before the next one hears it.
    for (let stage = 0; stage < 2; stage++) {
      const l = bus.chain[i++] as DynamicsCompressorNode
      set(l.threshold, lim.ceiling)
      set(l.ratio, 20)
      set(l.knee, 0)
      set(l.attack, 0.001)
      set(l.release, 0.08)
      set((bus.chain[i++] as GainNode).gain, dbToGain(-autoMakeupDb(lim.ceiling, 20)))
    }
  }
  set(bus.fader.gain, dbToGain(mix?.volume ?? 0))
  // Equal-power balance: the far side fades out, the near side stays put.
  const pan = mix?.pan ?? 0
  set(bus.balance.left.gain, pan > 0 ? Math.cos((pan * Math.PI) / 2) : 1)
  set(bus.balance.right.gain, pan < 0 ? Math.cos((-pan * Math.PI) / 2) : 1)
}

export function disposeBus(bus: Bus) {
  const b = bus.balance
  for (const n of [bus.input, ...bus.chain, bus.fader, b.split, b.left, b.right, b.merge, ...(bus.meter ? [bus.meter.left, bus.meter.right] : [])]) n.disconnect()
}

/** Peak levels in dBFS (left, right) over the last few milliseconds, -Infinity for silence. */
export function readMeter(meter: Meter): [number, number] {
  const peak = (a: AnalyserNode) => {
    a.getFloatTimeDomainData(meter.buffer)
    let p = 0
    for (let i = 0; i < meter.buffer.length; i++) {
      const v = Math.abs(meter.buffer[i])
      if (v > p) p = v
    }
    return p > 0 ? 20 * Math.log10(p) : -Infinity
  }
  return [peak(meter.left), peak(meter.right)]
}

/** The mixer channels a project needs: one per track, plus the master. */
export interface MixGraph {
  master: Bus
  tracks: Map<string, Bus>
}

export function createGraph(ctx: BaseAudioContext, project: Project, dest: AudioNode, metered: boolean): MixGraph {
  const master = createBus(ctx, dest, project.master, metered)
  const tracks = new Map<string, Bus>()
  for (const t of project.tracks) tracks.set(t.id, createBus(ctx, master.input, t.mix, metered))
  return { master, tracks }
}

/** Follows mix changes in place (faders, pan, processors) without interrupting playback. */
export function updateGraph(ctx: BaseAudioContext, graph: MixGraph, project: Project) {
  applyMix(ctx, graph.master, project.master)
  for (const t of project.tracks) {
    const bus = graph.tracks.get(t.id)
    if (bus) applyMix(ctx, bus, t.mix)
    else graph.tracks.set(t.id, createBus(ctx, graph.master.input, t.mix, Boolean(graph.master.meter)))
  }
}

export function disposeGraph(graph: MixGraph) {
  for (const b of graph.tracks.values()) disposeBus(b)
  disposeBus(graph.master)
}
