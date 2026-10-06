import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '', commandLine: { appendSwitch: () => {} }, getGPUFeatureStatus: () => ({}) } }))

const { devicesFrom, rendererName } = await import('./gpu')

describe('graphics cards', () => {
  it('reads the card out of the renderer string', () => {
    expect(rendererName('ANGLE (Intel, Intel(R) Arc(TM) B390 GPU (0x0000B080) Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('Intel(R) Arc(TM) B390 GPU')
    expect(rendererName('ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 (0x00002786) Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('NVIDIA GeForce RTX 4070')
    expect(rendererName('ANGLE (AMD, AMD Radeon RX 7800 XT (0x0000747E) Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('AMD Radeon RX 7800 XT')
    expect(rendererName(undefined)).toBe('')
  })

  it('lists each real card once, the one in use first', () => {
    // What Windows reports on a laptop with one card: it twice, the software renderer, a nameless device.
    const one = devicesFrom(
      [
        { active: true, vendorId: 0x8086, deviceId: 0xb080, deviceString: 'Intel(R) Arc(TM) B390 GPU', driverVersion: '32.0.101.8509' },
        { active: false, vendorId: 0x8086, deviceId: 0xb080, deviceString: 'Intel(R) Arc(TM) B390 GPU', driverVersion: '32.0.101.8509' },
        { active: false, vendorId: 0x1414, deviceId: 0x8c, deviceString: 'Microsoft Basic Render Driver', driverVersion: '10.0.26100.9278' },
        { active: false, vendorId: 0x8086, deviceId: 0xb03e, driverVersion: '0.0.0.0' },
      ],
      'ANGLE (Intel, Intel(R) Arc(TM) B390 GPU (0x0000B080) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    )
    expect(one).toEqual([{ vendor: 'Intel', name: 'Intel(R) Arc(TM) B390 GPU', driver: '32.0.101.8509', active: true }])

    // A laptop with two: running on the integrated one.
    const two = devicesFrom([
      { active: false, vendorId: 0x10de, deviceString: 'NVIDIA GeForce RTX 4060 Laptop GPU', driverVersion: '32.0.15.6094' },
      { active: true, vendorId: 0x8086, deviceString: 'Intel(R) Iris(R) Xe Graphics', driverVersion: '31.0.101.5186' },
      { active: false, vendorId: 0x1414, deviceString: 'Microsoft Basic Render Driver' },
    ])
    expect(two.map((d) => `${d.vendor}:${d.active}`)).toEqual(['Intel:true', 'NVIDIA:false'])
    expect(devicesFrom([{ active: true, vendorId: 0x1002, deviceString: 'AMD Radeon RX 6600' }])[0]).toMatchObject({ vendor: 'AMD', name: 'AMD Radeon RX 6600', active: true })
  })

  it('still says so when Lumen runs on the software renderer', () => {
    const soft = devicesFrom([{ active: true, vendorId: 0x1414, deviceString: 'Microsoft Basic Render Driver' }])
    expect(soft).toEqual([{ vendor: 'Microsoft', name: 'Microsoft Basic Render Driver', driver: undefined, active: true }])
    // No names at all: the renderer string names the card in use.
    expect(devicesFrom([{ active: true, vendorId: 0x10de, deviceId: 0x2786 }], 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 (0x00002786) Direct3D11 vs_5_0 ps_5_0, D3D11)')[0].name).toBe('NVIDIA GeForce RTX 4070')
  })
})
