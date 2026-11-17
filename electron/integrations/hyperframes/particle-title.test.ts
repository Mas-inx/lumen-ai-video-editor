import os from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { PARTICLE_DIRECTIONS, PARTICLE_STYLES } from '../../../shared/motion'

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }))

const { buildTemplate, templateDuration } = await import('./templates')

const FRAME = { width: 1920, height: 1080, duration: 5.5 }
const build = (params: Record<string, unknown>, frame = FRAME) => buildTemplate('particle-title', params, frame)

const script = (html: string) => /<script>\n([\s\S]*?)<\/script>/.exec(html)![1]
const config = (html: string) => JSON.parse(/const C = (\{.*?\});\n/.exec(html)![1]) as Record<string, unknown>
const markup = (html: string) => html.replace(/<script[^>]*>[\s\S]*?<\/script>/g, '').replace(/url\('data:[^']*'\)/g, '')

type Call = unknown[]

/**
 * Runs the page's script with canvases that record every drawing call, text
 * with simple metrics, glyphs whose ink is a coarse checkerboard (or nothing),
 * and a stand-in GSAP. `frame(t)` sets the timeline's clock and returns what
 * was drawn for that moment.
 */
async function run(html: string, { ink = true } = {}) {
  const calls: Call[] = []
  let made = 0
  const canvas = () => {
    const id = `canvas${made++}`
    const state: Record<string, unknown> = { font: '10px sans-serif' }
    const px = () => Number(/([\d.]+)px/.exec(String(state.font))?.[1] ?? 10)
    const gradient = (...args: unknown[]) => ({ addColorStop: (...stop: unknown[]) => calls.push([id, 'stop', ...stop]), args })
    const methods: Record<string, (...args: never[]) => unknown> = {
      measureText: (text: string) => ({ width: text.length * px() * 0.5, actualBoundingBoxLeft: 0, actualBoundingBoxRight: text.length * px() * 0.5, actualBoundingBoxAscent: px() * 0.7, actualBoundingBoxDescent: px() * 0.2 }),
      getImageData: (x: number, y: number, w: number, h: number) => {
        const data = new Uint8ClampedArray(w * h * 4)
        if (ink) for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if ((((x + i) >> 3) + ((y + j) >> 3)) % 2 === 0) data[(j * w + i) * 4 + 3] = 255
        return { data }
      },
      createLinearGradient: (...args: never[]) => gradient('linear', ...args),
      createRadialGradient: (...args: never[]) => gradient('radial', ...args),
    }
    const name = (v: unknown) => (v && typeof v === 'object' && 'id' in v ? (v as { id: string }).id : v)
    const ctx = new Proxy(state, {
      get: (t, k: string) => methods[k] ?? (k in t ? t[k] : (...args: unknown[]) => void calls.push([id, k, ...args.map(name)])),
      set: (t, k: string, v) => {
        t[k] = v
        calls.push([id, `${k}=`, typeof v === 'object' ? 'gradient' : v])
        return true
      },
    })
    return { id, width: 0, height: 0, style: {}, getContext: () => ctx }
  }
  class Path2D {
    id = 'path'
    ops: unknown[] = []
    moveTo(...a: number[]) {
      this.ops.push('M', ...a)
    }
    lineTo(...a: number[]) {
      this.ops.push('L', ...a)
    }
  }
  const main = canvas()
  const after = { style: {} as Record<string, string> }
  const document = {
    getElementById: () => main,
    createElement: () => canvas(),
    querySelector: (sel: string) => (sel === '.after' && html.includes('class="after"') ? after : null),
    fonts: { load: () => Promise.resolve([]) },
  }
  const tweens: { target: unknown; vars: Record<string, unknown>; at: number }[] = []
  const tl = {
    to: (target: unknown, vars: Record<string, unknown>, at: number) => (tweens.push({ target, vars, at }), tl),
    set: (target: unknown, vars: Record<string, unknown>, at: number) => (tweens.push({ target, vars: { ...vars, duration: 0 }, at }), tl),
  }
  const gsap = { timeline: () => tl, set: () => {}, config: () => {} }
  const window: Record<string, any> = { devicePixelRatio: 1 }
  new Function('window', 'document', 'gsap', 'Path2D', script(html))(window, document, gsap, Path2D)
  await window.__hf.buildReady.particleTitle
  const clock = tweens.find((t) => 'now' in (t.target as object))!.target as { t: number }
  return {
    tweens,
    after,
    frame(t: number) {
      calls.length = 0
      clock.t = t
      // Paths are drawn by reference: record what they held.
      return JSON.stringify(calls, (_k, v) => (v instanceof Path2D ? v.ops : v))
    },
  }
}

/**
 * Whether a frame put particles on the page's canvas (canvas0) — sprites (canvas4 on), squares or spark strokes — or the
 * solid title (the type layer, canvas1, or its masked copy, canvas2).
 */
const drew = (frame: string) => ({
  particles: /\["canvas0","drawImage","canvas(?:[4-9]|\d\d)"|\["canvas0","fillRect"|\["canvas0","stroke"/.test(frame),
  title: /\["canvas0","drawImage","canvas[12]"/.test(frame),
})

describe('particle title pages', () => {
  it('build for every style and direction, with what the page needs to draw', () => {
    for (const style of PARTICLE_STYLES) {
      for (const direction of PARTICLE_DIRECTIONS) {
        const html = build({ title: 'Make it count', subtitle: 'A film', style, direction })
        expect(html.startsWith('<!doctype html>')).toBe(true)
        expect(html).toContain('<canvas id="pt"></canvas>')
        expect(html).toContain('window.__timelines["lumen"] = tl;')
        expect(html).toContain('window.__hf.buildReady.particleTitle')
        expect(config(html)).toMatchObject({ style, direction, title: 'Make it count', subtitle: true })
        expect(() => new Function(script(html))).not.toThrow()
      }
    }
  })

  it('fill in what isn’t given, and keep what is', () => {
    expect(config(build({}))).toMatchObject({ title: 'Your Title', style: 'dust', direction: 'everywhere', color: '#ffffff', accent: '#d6ee00', family: "'Bricolage Grotesque', 'Geist', sans-serif", seed: 1, lines: null, subtitle: false })
    expect(config(build({ style: 'embers' }))).toMatchObject({ direction: 'below' })
    expect(config(build({ style: 'nope', direction: 'up', color: 'red', accent: '#12345', font: 'comic' }))).toMatchObject({ style: 'dust', direction: 'everywhere', color: '#ffffff', accent: '#12345', family: "'Bricolage Grotesque', 'Geist', sans-serif" })
    expect(config(build({ title: 'Signal | lost', font: 'wide', color: '#111' }))).toMatchObject({ lines: ['Signal', 'lost'], title: 'Signal lost', family: "'Archivo', 'Geist', sans-serif", weight: 820, color: '#111' })
    expect(config(build({ title: 'x'.repeat(300) })).title).toHaveLength(120)
    expect(config(build({ seed: -42.4 })).seed).toBe(42)
    expect(config(build({ seed: 'abc' })).seed).toBe(1)
  })

  it('escape the subtitle and keep the title out of the markup', () => {
    const html = build({ title: '</script><script>alert(1)</script>', subtitle: '<b>Bold</b> & "quoted"' })
    expect(markup(html)).toContain('&lt;b&gt;Bold&lt;/b&gt; &amp; &quot;quoted&quot;')
    expect(markup(html)).not.toContain('<b>')
    expect(html.match(/<script/g)!.length).toBe(html.match(/<\/script>/g)!.length)
    expect(() => new Function(script(html))).not.toThrow()
  })

  it('are the same page for the same params, and use only the timeline’s time and the seed', () => {
    const params = { title: 'Into the fire', style: 'embers', seed: 7 }
    expect(build(params)).toBe(build({ ...params }))
    expect(build({ ...params, seed: 8 }).replaceAll('"seed":8', '"seed":7')).toBe(build(params))
    expect(script(build(params))).not.toMatch(/Math\.random|Date\.now|new Date|performance\.now|requestAnimationFrame|setTimeout|setInterval/)
  })

  it('last long enough to gather, be read and scatter', () => {
    expect(templateDuration('particle-title', { title: 'Go' })).toBe(5.5)
    expect(templateDuration('particle-title', { title: 'Make it count', subtitle: 'A film about the small decisions we make every day' })).toBeGreaterThan(6.5)
  })
})

describe('particle title drawing', () => {
  it('draws any moment from the time alone: the same frame however it is reached, and on every load', async () => {
    for (const style of PARTICLE_STYLES) {
      const html = build({ title: 'Make it count', subtitle: 'A film', style })
      const a = await run(html)
      const mid = a.frame(1.1)
      expect(drew(mid).particles, style).toBe(true)
      expect(a.frame(4.9)).not.toBe(mid)
      expect(a.frame(0.3)).not.toBe(mid)
      expect(a.frame(1.1)).toBe(mid)
      const b = await run(html)
      expect(b.frame(1.1)).toBe(mid)
    }
  })

  it('scatters differently with another seed', async () => {
    const one = await run(build({ title: 'Seeded', seed: 1 }))
    const two = await run(build({ title: 'Seeded', seed: 2 }))
    expect(one.frame(0.6)).not.toBe(two.frame(0.6))
  })

  it('starts and ends on an empty frame, and holds on the solid title', async () => {
    for (const style of PARTICLE_STYLES) {
      const page = await run(build({ title: 'Make it count', style }))
      const first = drew(page.frame(0))
      const hold = drew(page.frame(3.4))
      const last = drew(page.frame(FRAME.duration))
      expect(first, style).toEqual({ particles: false, title: false })
      expect(hold.title, style).toBe(true)
      expect(last, style).toEqual({ particles: false, title: false })
    }
  })

  it('places the subtitle under the title it laid out', async () => {
    const page = await run(build({ title: 'Make it count', subtitle: 'A film' }))
    expect(Number.parseFloat(page.after.style.top)).toBeGreaterThan(FRAME.height / 2 - 100)
    // Shown as it wipes in, wiped out, and hidden once out.
    expect(page.tweens.filter((t) => t.target === '.sub .mask > span').map((t) => t.vars.yPercent ?? t.vars.visibility)).toEqual(['visible', 0, -110, 'hidden'])
  })

  it('copes with a title that has no ink to sample', async () => {
    for (const style of PARTICLE_STYLES) {
      const page = await run(build({ title: 'Blank', style }), { ink: false })
      expect(drew(page.frame(1)).particles, style).toBe(false)
      expect(drew(page.frame(3.4)).title, style).toBe(true)
    }
  })

  it('fits short clips and a vertical frame: gathered before it scatters, and gone by the end', async () => {
    for (const frame of [
      { width: 1920, height: 1080, duration: 1 },
      { width: 1920, height: 1080, duration: 2 },
      { width: 1080, height: 1920, duration: 5.5 },
    ]) {
      for (const style of PARTICLE_STYLES) {
        const page = await run(build({ title: 'A longer title that will need more than one line', subtitle: 'Sub', style }, frame))
        const label = `${style} ${frame.width}x${frame.height} ${frame.duration}s`
        expect(Math.max(...page.tweens.map((t) => t.at + Number(t.vars.duration ?? 0))), label).toBeLessThanOrEqual(frame.duration + 1e-9)
        // Shortly before the exit begins, the title is solid type.
        expect(drew(page.frame(frame.duration * 0.72)).title, label).toBe(true)
        expect(drew(page.frame(frame.duration)), label).toEqual({ particles: false, title: false })
      }
    }
  })
})
