/**
 * Lumen's built-in sound effects, synthesized with Web Audio (no samples, no
 * licences to worry about). Each one renders to a real 48 kHz WAV the first
 * time it's used and is then an ordinary file in the media library.
 */

export interface SfxDef {
  id: string
  name: string
  category: 'Transitions' | 'Impacts' | 'UI & accents' | 'Atmosphere'
  description: string
  duration: number
  render: (ctx: OfflineAudioContext, out: AudioNode) => void
}

const RATE = 48000

// ─── Building blocks ─────────────────────────────────────────────────────

function mulberry(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function noise(ctx: BaseAudioContext, seconds: number, seed = 1) {
  const rnd = mulberry(seed)
  const buf = ctx.createBuffer(2, Math.max(1, Math.ceil(seconds * ctx.sampleRate)), ctx.sampleRate)
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c)
    for (let i = 0; i < d.length; i++) d[i] = rnd() * 2 - 1
  }
  const src = ctx.createBufferSource()
  src.buffer = buf
  return src
}

/** Exponentially decaying stereo noise — a plausible small-room / hall impulse response. */
function reverb(ctx: BaseAudioContext, seconds: number, decay: number) {
  const rnd = mulberry(7)
  const len = Math.ceil(seconds * ctx.sampleRate)
  const ir = ctx.createBuffer(2, len, ctx.sampleRate)
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c)
    for (let i = 0; i < len; i++) d[i] = (rnd() * 2 - 1) * Math.pow(1 - i / len, decay)
  }
  const conv = ctx.createConvolver()
  conv.buffer = ir
  return conv
}

/** out ← dry + wet(reverb) */
function withSpace(ctx: BaseAudioContext, out: AudioNode, wet: number, seconds = 1.6, decay = 3) {
  const input = ctx.createGain()
  const dry = ctx.createGain()
  dry.gain.value = 1
  const send = ctx.createGain()
  send.gain.value = wet
  const verb = reverb(ctx, seconds, decay)
  input.connect(dry).connect(out)
  input.connect(send).connect(verb).connect(out)
  return input
}

function env(param: AudioParam, points: [number, number][], curve: 'lin' | 'exp' = 'lin') {
  const [t0, v0] = points[0]
  param.setValueAtTime(Math.max(curve === 'exp' ? 0.0001 : 0, v0), t0)
  for (const [t, v] of points.slice(1)) {
    if (curve === 'exp') param.exponentialRampToValueAtTime(Math.max(0.0001, v), t)
    else param.linearRampToValueAtTime(v, t)
  }
}

function osc(ctx: BaseAudioContext, type: OscillatorType, freq: number) {
  const o = ctx.createOscillator()
  o.type = type
  o.frequency.value = freq
  return o
}

function softClip(ctx: BaseAudioContext, drive = 2) {
  const curve = new Float32Array(1024)
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1
    curve[i] = Math.tanh(x * drive) / Math.tanh(drive)
  }
  const ws = ctx.createWaveShaper()
  ws.curve = curve
  ws.oversample = '2x'
  return ws
}

function bell(ctx: BaseAudioContext, out: AudioNode, at: number, freq: number, level: number, decay: number) {
  const carrier = osc(ctx, 'sine', freq)
  const mod = osc(ctx, 'sine', freq * 1.4)
  const index = ctx.createGain()
  env(index.gain, [
    [at, freq * 1.2],
    [at + decay * 0.6, 1],
  ], 'exp')
  mod.connect(index).connect(carrier.frequency)
  const amp = ctx.createGain()
  env(amp.gain, [
    [at, 0.0001],
    [at + 0.004, level],
    [at + decay, 0.0001],
  ], 'exp')
  carrier.connect(amp).connect(out)
  const partial = osc(ctx, 'sine', freq * 2.76)
  const pAmp = ctx.createGain()
  env(pAmp.gain, [
    [at, 0.0001],
    [at + 0.003, level * 0.18],
    [at + decay * 0.35, 0.0001],
  ], 'exp')
  partial.connect(pAmp).connect(out)
  for (const o of [carrier, mod, partial]) {
    o.start(at)
    o.stop(at + decay + 0.05)
  }
}

function thump(ctx: BaseAudioContext, out: AudioNode, at: number, from: number, to: number, level: number, decay: number) {
  const o = osc(ctx, 'sine', from)
  o.frequency.setValueAtTime(from, at)
  o.frequency.exponentialRampToValueAtTime(to, at + Math.min(0.12, decay * 0.5))
  const g = ctx.createGain()
  env(g.gain, [
    [at, 0.0001],
    [at + 0.003, level],
    [at + decay, 0.0001],
  ], 'exp')
  o.connect(g).connect(out)
  o.start(at)
  o.stop(at + decay + 0.02)
}

function click(ctx: BaseAudioContext, out: AudioNode, at: number, freq: number, level: number, length = 0.012, seed = 3) {
  const n = noise(ctx, length + 0.01, seed)
  const bp = ctx.createBiquadFilter()
  bp.type = 'bandpass'
  bp.frequency.value = freq
  bp.Q.value = 3
  const g = ctx.createGain()
  env(g.gain, [
    [at, level],
    [at + length, 0.0001],
  ], 'exp')
  n.connect(bp).connect(g).connect(out)
  n.start(at)
}

// ─── The pack ────────────────────────────────────────────────────────────

export const SFX: SfxDef[] = [
  {
    id: 'whoosh',
    name: 'Whoosh',
    category: 'Transitions',
    description: 'Fast air sweep for cuts',
    duration: 1,
    render(ctx, out) {
      const space = withSpace(ctx, out, 0.12, 0.9, 4)
      const n = noise(ctx, 1, 11)
      const bp = ctx.createBiquadFilter()
      bp.type = 'bandpass'
      bp.Q.value = 1.3
      env(bp.frequency, [
        [0, 350],
        [0.46, 3200],
        [0.95, 700],
      ], 'exp')
      const g = ctx.createGain()
      g.gain.setValueCurveAtTime(Float32Array.from({ length: 64 }, (_, i) => Math.pow(Math.sin((i / 63) * Math.PI), 2.2) * 0.9), 0, 0.95)
      const pan = ctx.createStereoPanner()
      env(pan.pan, [
        [0, -0.7],
        [0.95, 0.7],
      ])
      n.connect(bp).connect(g).connect(pan).connect(space)
      n.start(0)
    },
  },
  {
    id: 'swoosh',
    name: 'Soft swoosh',
    category: 'Transitions',
    description: 'Slow, airy pass-by',
    duration: 1.8,
    render(ctx, out) {
      const space = withSpace(ctx, out, 0.22, 1.4, 3)
      const n = noise(ctx, 1.8, 12)
      const lp = ctx.createBiquadFilter()
      lp.type = 'lowpass'
      lp.Q.value = 0.9
      env(lp.frequency, [
        [0, 180],
        [0.85, 2400],
        [1.7, 260],
      ], 'exp')
      const g = ctx.createGain()
      g.gain.setValueCurveAtTime(Float32Array.from({ length: 64 }, (_, i) => Math.pow(Math.sin((i / 63) * Math.PI), 1.6) * 0.8), 0, 1.75)
      const pan = ctx.createStereoPanner()
      env(pan.pan, [
        [0, 0.6],
        [1.75, -0.6],
      ])
      n.connect(lp).connect(g).connect(pan).connect(space)
      n.start(0)
    },
  },
  {
    id: 'riser',
    name: 'Riser',
    category: 'Transitions',
    description: 'Tension build into a drop',
    duration: 4,
    render(ctx, out) {
      const space = withSpace(ctx, out, 0.25, 2, 2.5)
      const n = noise(ctx, 4, 13)
      const hp = ctx.createBiquadFilter()
      hp.type = 'highpass'
      env(hp.frequency, [
        [0, 200],
        [3.95, 7000],
      ], 'exp')
      const ng = ctx.createGain()
      env(ng.gain, [
        [0, 0.02],
        [3.9, 0.55],
        [4, 0.0001],
      ], 'exp')
      n.connect(hp).connect(ng).connect(space)
      n.start(0)
      const lp = ctx.createBiquadFilter()
      lp.type = 'lowpass'
      env(lp.frequency, [
        [0, 700],
        [3.95, 9000],
      ], 'exp')
      const sg = ctx.createGain()
      env(sg.gain, [
        [0, 0.0001],
        [3.9, 0.22],
        [4, 0.0001],
      ], 'exp')
      lp.connect(sg).connect(space)
      for (const detune of [-9, 0, 11]) {
        const o = osc(ctx, 'sawtooth', 110)
        o.detune.value = detune
        env(o.frequency, [
          [0, 110],
          [3.95, 880],
        ], 'exp')
        o.connect(lp)
        o.start(0)
        o.stop(4)
      }
    },
  },
  {
    id: 'impact',
    name: 'Cinematic impact',
    category: 'Impacts',
    description: 'Deep boom with a tail',
    duration: 3,
    render(ctx, out) {
      const clip = softClip(ctx, 2.2)
      const space = withSpace(ctx, clip, 0.3, 2.6, 2.2)
      clip.connect(out)
      thump(ctx, space, 0, 120, 36, 1, 2.4)
      thump(ctx, space, 0, 60, 30, 0.7, 2.8)
      const n = noise(ctx, 0.6, 14)
      const lp = ctx.createBiquadFilter()
      lp.type = 'lowpass'
      env(lp.frequency, [
        [0, 4000],
        [0.5, 300],
      ], 'exp')
      const g = ctx.createGain()
      env(g.gain, [
        [0, 0.9],
        [0.55, 0.0001],
      ], 'exp')
      n.connect(lp).connect(g).connect(space)
      n.start(0)
    },
  },
  {
    id: 'hit',
    name: 'Punch hit',
    category: 'Impacts',
    description: 'Tight, punchy accent',
    duration: 0.6,
    render(ctx, out) {
      const comp = ctx.createDynamicsCompressor()
      comp.threshold.value = -12
      comp.ratio.value = 6
      comp.connect(out)
      thump(ctx, comp, 0, 190, 48, 1, 0.42)
      click(ctx, comp, 0, 4200, 0.8, 0.008, 15)
    },
  },
  {
    id: 'heartbeat',
    name: 'Heartbeat',
    category: 'Impacts',
    description: 'Lub-dub, for suspense',
    duration: 1.1,
    render(ctx, out) {
      const lp = ctx.createBiquadFilter()
      lp.type = 'lowpass'
      lp.frequency.value = 180
      lp.connect(out)
      thump(ctx, lp, 0.02, 70, 42, 1, 0.22)
      thump(ctx, lp, 0.3, 64, 40, 0.8, 0.24)
    },
  },
  {
    id: 'pop',
    name: 'Pop',
    category: 'UI & accents',
    description: 'Bubbly pop for text and stickers',
    duration: 0.2,
    render(ctx, out) {
      const o = osc(ctx, 'sine', 380)
      env(o.frequency, [
        [0, 380],
        [0.06, 980],
      ], 'exp')
      const g = ctx.createGain()
      env(g.gain, [
        [0, 0.0001],
        [0.004, 0.8],
        [0.14, 0.0001],
      ], 'exp')
      o.connect(g).connect(out)
      o.start(0)
      o.stop(0.2)
    },
  },
  {
    id: 'click',
    name: 'Click',
    category: 'UI & accents',
    description: 'Crisp interface click',
    duration: 0.08,
    render(ctx, out) {
      click(ctx, out, 0, 2600, 0.9, 0.018, 16)
      const o = osc(ctx, 'triangle', 1800)
      const g = ctx.createGain()
      env(g.gain, [
        [0, 0.35],
        [0.03, 0.0001],
      ], 'exp')
      o.connect(g).connect(out)
      o.start(0)
      o.stop(0.05)
    },
  },
  {
    id: 'ding',
    name: 'Ding',
    category: 'UI & accents',
    description: 'Clear bell for reveals',
    duration: 2.6,
    render(ctx, out) {
      bell(ctx, withSpace(ctx, out, 0.28, 2.2, 2.5), 0, 1318.5, 0.5, 2.4)
    },
  },
  {
    id: 'success',
    name: 'Success',
    category: 'UI & accents',
    description: 'Rising three-note chime',
    duration: 1.8,
    render(ctx, out) {
      const space = withSpace(ctx, out, 0.22, 1.6, 2.8)
      bell(ctx, space, 0, 1046.5, 0.32, 1.2)
      bell(ctx, space, 0.09, 1318.5, 0.32, 1.3)
      bell(ctx, space, 0.18, 1568, 0.36, 1.5)
    },
  },
  {
    id: 'notify',
    name: 'Notification',
    category: 'UI & accents',
    description: 'Two-tone message ping',
    duration: 1.2,
    render(ctx, out) {
      const space = withSpace(ctx, out, 0.18, 1.2, 3)
      bell(ctx, space, 0, 880, 0.35, 0.8)
      bell(ctx, space, 0.13, 1318.5, 0.35, 0.9)
    },
  },
  {
    id: 'shutter',
    name: 'Camera shutter',
    category: 'UI & accents',
    description: 'Mechanical snap for photos',
    duration: 0.4,
    render(ctx, out) {
      click(ctx, out, 0, 2400, 0.9, 0.03, 17)
      thump(ctx, out, 0, 140, 60, 0.35, 0.08)
      click(ctx, out, 0.11, 1800, 0.7, 0.04, 18)
      thump(ctx, out, 0.11, 120, 50, 0.3, 0.1)
    },
  },
  {
    id: 'glitch',
    name: 'Glitch',
    category: 'Transitions',
    description: 'Digital stutter for tech edits',
    duration: 0.7,
    render(ctx, out) {
      const rnd = mulberry(19)
      const crush = ctx.createWaveShaper()
      crush.curve = Float32Array.from({ length: 256 }, (_, i) => Math.round(((i / 255) * 2 - 1) * 6) / 6)
      crush.connect(out)
      let t = 0
      while (t < 0.62) {
        const len = 0.02 + rnd() * 0.05
        const pan = ctx.createStereoPanner()
        pan.pan.value = rnd() * 1.6 - 0.8
        const g = ctx.createGain()
        env(g.gain, [
          [t, 0.45],
          [t + len, 0.0001],
        ], 'exp')
        g.connect(pan).connect(crush)
        if (rnd() < 0.5) {
          const o = osc(ctx, 'square', 120 + rnd() * 1800)
          o.connect(g)
          o.start(t)
          o.stop(t + len)
        } else {
          const n = noise(ctx, len, 20 + Math.floor(t * 1000))
          n.connect(g)
          n.start(t)
        }
        t += len + rnd() * 0.02
      }
    },
  },
  {
    id: 'drone',
    name: 'Tension drone',
    category: 'Atmosphere',
    description: 'Dark bed for suspense (loops)',
    duration: 8,
    render(ctx, out) {
      const space = withSpace(ctx, out, 0.35, 3, 2)
      const lp = ctx.createBiquadFilter()
      lp.type = 'lowpass'
      lp.frequency.value = 320
      lp.Q.value = 2
      const lfo = osc(ctx, 'sine', 0.18)
      const depth = ctx.createGain()
      depth.gain.value = 180
      lfo.connect(depth).connect(lp.frequency)
      lfo.start(0)
      const g = ctx.createGain()
      env(g.gain, [
        [0, 0],
        [1.5, 0.3],
        [6.5, 0.3],
        [8, 0],
      ])
      lp.connect(g).connect(space)
      for (const [f, d] of [
        [55, 0],
        [55.35, 7],
        [82.4, -5],
      ]) {
        const o = osc(ctx, 'sawtooth', f)
        o.detune.value = d
        o.connect(lp)
        o.start(0)
        o.stop(8)
      }
      const n = noise(ctx, 8, 21)
      const bp = ctx.createBiquadFilter()
      bp.type = 'bandpass'
      bp.frequency.value = 900
      bp.Q.value = 0.7
      const ng = ctx.createGain()
      ng.gain.value = 0.03
      n.connect(bp).connect(ng).connect(g)
      n.start(0)
    },
  },
  {
    id: 'wind',
    name: 'Wind',
    category: 'Atmosphere',
    description: 'Outdoor wind bed (loops)',
    duration: 10,
    render(ctx, out) {
      const n = noise(ctx, 10, 22)
      const bp = ctx.createBiquadFilter()
      bp.type = 'bandpass'
      bp.Q.value = 0.6
      bp.frequency.value = 500
      const lfo = osc(ctx, 'sine', 0.11)
      const depth = ctx.createGain()
      depth.gain.value = 320
      lfo.connect(depth).connect(bp.frequency)
      lfo.start(0)
      const gust = osc(ctx, 'sine', 0.07)
      const gustDepth = ctx.createGain()
      gustDepth.gain.value = 0.12
      const g = ctx.createGain()
      g.gain.value = 0.26
      gust.connect(gustDepth).connect(g.gain)
      gust.start(0)
      const fade = ctx.createGain()
      env(fade.gain, [
        [0, 0],
        [1.2, 1],
        [8.8, 1],
        [10, 0],
      ])
      n.connect(bp).connect(g).connect(fade).connect(out)
      n.start(0)
    },
  },
]

/** Renders an effect to stereo 48 kHz. */
export async function renderSfx(def: SfxDef): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.ceil(def.duration * RATE), sampleRate: RATE })
  const master = ctx.createGain()
  master.gain.value = 0.9
  master.connect(ctx.destination)
  def.render(ctx, master)
  const buffer = await ctx.startRendering()
  // Normalise to −1 dBFS so every effect lands at a consistent level.
  let peak = 0
  for (let c = 0; c < buffer.numberOfChannels; c++) for (const v of buffer.getChannelData(c)) peak = Math.max(peak, Math.abs(v))
  if (peak > 0) {
    const k = 0.891 / peak
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const d = buffer.getChannelData(c)
      for (let i = 0; i < d.length; i++) d[i] *= k
    }
  }
  return buffer
}
