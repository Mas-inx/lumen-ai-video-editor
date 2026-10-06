import { describe, expect, it } from 'vitest'
import { repairAvcConfig } from './codec-repair'

const hexBytes = (hex: string) => new Uint8Array(hex.match(/../g)!.map((b) => parseInt(b, 16)))

// The record GS Cinematic Studio's renders carry (FiveM's browser): constraint byte 0x03 where the SPS says 0xC0,
// and a second SPS and PPS from a later key frame.
const STUDIO = hexBytes('01420329ffe200106742c0298c8d403c0113f2c03c2211a800106742c0294323500f0044fcb00f08846a02000468ce3c8000046848e3c8')

describe('repairing H.264 configs', () => {
  it('restates a reversed constraint byte from the SPS', () => {
    const fixed = repairAvcConfig({ codec: 'avc1.420329', codedWidth: 1920, codedHeight: 1080, description: STUDIO })
    expect(fixed.codec).toBe('avc1.42c029')
    expect(fixed.codedWidth).toBe(1920)
    const record = fixed.description as Uint8Array
    expect([...record.subarray(0, 6)]).toEqual([0x01, 0x42, 0xc0, 0x29, 0xff, 0xe2])
    // Everything after the header is as it was, and the file's own bytes aren't touched.
    expect([...record.subarray(4)]).toEqual([...STUDIO.subarray(4)])
    expect(STUDIO[2]).toBe(0x03)
  })

  it('reads a record handed over as an ArrayBuffer or a view into one', () => {
    const padded = new Uint8Array(STUDIO.length + 8)
    padded.set(STUDIO, 4)
    expect(repairAvcConfig({ codec: 'avc1.420329', description: padded.subarray(4, 4 + STUDIO.length) }).codec).toBe('avc1.42c029')
    expect(repairAvcConfig({ codec: 'avc1.420329', description: STUDIO.buffer.slice(0) }).codec).toBe('avc1.42c029')
  })

  it('clears the reserved bits when there is no SPS to read', () => {
    expect(repairAvcConfig({ codec: 'avc1.420328' })).toEqual({ codec: 'avc1.420028' })
    expect(repairAvcConfig({ codec: 'avc3.640333', description: new Uint8Array([1, 2, 3]) }).codec).toBe('avc3.640033')
  })

  it('leaves valid configs alone', () => {
    for (const codec of ['avc1.42c029', 'avc1.640034', 'avc1.4d401f', 'hev1.1.6.L153.B0', 'vp09.01.50.08.03.01.01.01.00', 'av01.0.13M.08']) {
      const config = { codec, description: STUDIO }
      expect(repairAvcConfig(config)).toBe(config)
    }
  })
})
