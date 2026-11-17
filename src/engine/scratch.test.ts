import { describe, expect, it, vi } from 'vitest'

// Canvases, faked: just their size.
vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0 }) })

const { SCRATCH_FRAMES, onScratchReleased, scratchCanvas, sweepScratch } = await import('./scratch')

describe('scratch canvases', () => {
  it('are reused while frames need them, and let go once they have not for a while', () => {
    const released: unknown[] = []
    const off = onScratchReleased((c) => released.push(c))
    const layer = scratchCanvas('layer@0', 1920, 1080)
    const nested = scratchCanvas('nested@1', 1920, 1080)
    for (let f = 0; f < SCRATCH_FRAMES + 5; f++) {
      // The top level draws every frame; the nested timeline stopped being on screen.
      expect(scratchCanvas('layer@0', 1920, 1080)).toBe(layer)
      sweepScratch()
    }
    expect(released).toEqual([nested])
    expect(nested).toMatchObject({ width: 0, height: 0 })
    expect(layer).toMatchObject({ width: 1920, height: 1080 })
    // Needed again, it's a new one.
    expect(scratchCanvas('nested@1', 640, 360)).not.toBe(nested)
    off()
  })

  it('follow the size they are asked for', () => {
    const c = scratchCanvas('mask@0', 1280, 720)
    expect(scratchCanvas('mask@0', 3840, 2160)).toBe(c)
    expect(c).toMatchObject({ width: 3840, height: 2160 })
  })
})
