import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { GpuDevice, GpuInfo, GraphicsSettings } from '../shared/app'

/**
 * Graphics: which card Lumen runs on, and what Chromium accelerates on it.
 * Laptops with two cards start apps on the power-saving one unless Windows is
 * told otherwise; the user can ask for the fast one here. The choice has to be
 * made before Chromium starts its GPU process, so it is read straight from
 * disk at launch and changing it needs a restart.
 */

const FILE = 'lumen-graphics.json'

const VENDORS: Record<number, string> = {
  0x10de: 'NVIDIA',
  0x1002: 'AMD',
  0x1022: 'AMD',
  0x8086: 'Intel',
  0x5143: 'Qualcomm',
  0x106b: 'Apple',
  0x1414: 'Microsoft',
}

const file = () => path.join(app.getPath('userData'), FILE)

export function graphicsSettings(): GraphicsSettings {
  let saved: Partial<GraphicsSettings> = {}
  try {
    saved = JSON.parse(fs.readFileSync(file(), 'utf8')) as Partial<GraphicsSettings>
  } catch {
    /* defaults */
  }
  return {
    gpu: saved.gpu === 'power-saving' || saved.gpu === 'high-performance' ? saved.gpu : 'system',
    ignoreBlocklist: saved.ignoreBlocklist === true,
  }
}

export function setGraphicsSettings(patch: Partial<GraphicsSettings>): GraphicsSettings {
  const next = { ...graphicsSettings() }
  if (patch.gpu === 'high-performance' || patch.gpu === 'power-saving' || patch.gpu === 'system') next.gpu = patch.gpu
  if (typeof patch.ignoreBlocklist === 'boolean') next.ignoreBlocklist = patch.ignoreBlocklist
  fs.mkdirSync(path.dirname(file()), { recursive: true })
  fs.writeFileSync(file(), JSON.stringify(next, null, 2))
  return next
}

/** What this launch was started with (the settings may have changed since). */
let applied: GraphicsSettings | null = null

/** Call before the app is ready. */
export function applyGraphicsSettings() {
  const s = graphicsSettings()
  applied = s
  if (s.gpu === 'high-performance') app.commandLine.appendSwitch('force_high_performance_gpu')
  else if (s.gpu === 'power-saving') app.commandLine.appendSwitch('force_low_power_gpu')
  // For a card Chromium has stopped trusting (usually an old driver): use it anyway.
  if (s.ignoreBlocklist) app.commandLine.appendSwitch('ignore-gpu-blocklist')
}

export interface RawDevice {
  active?: boolean
  vendorId?: number
  deviceId?: number
  vendorString?: string
  deviceString?: string
  driverVendor?: string
  driverVersion?: string
}

/** "ANGLE (Intel, Intel(R) Arc(TM) B390 GPU (0x0000B0A0) Direct3D11 vs_5_0 ps_5_0, D3D11)" → "Intel(R) Arc(TM) B390 GPU". */
export function rendererName(glRenderer: string | undefined) {
  if (!glRenderer) return ''
  const inner = /^ANGLE \((.*)\)$/.exec(glRenderer.trim())?.[1] ?? glRenderer
  const parts = inner.split(',').map((p) => p.trim())
  const name = parts.length >= 2 ? parts[1] : parts[0]
  return name
    .replace(/\s*\(0x[0-9a-f]+\)/gi, '')
    .replace(/\s+Direct3D.*$/i, '')
    .replace(/\s+(OpenGL|Vulkan|Metal).*$/i, '')
    .trim()
}

/**
 * The real graphics cards in Chromium's adapter list. Windows reports more
 * than there are: the same card once per output, its own software renderer,
 * and nameless helper devices — none of which is a card to choose between.
 */
export function devicesFrom(raw: RawDevice[], glRenderer?: string): GpuDevice[] {
  const active = rendererName(glRenderer)
  const cards = new Map<string, GpuDevice>()
  for (const d of raw) {
    const device: GpuDevice = {
      vendor: VENDORS[d.vendorId ?? 0] ?? d.vendorString ?? d.driverVendor ?? 'Unknown',
      name: d.deviceString || (d.active && active) || `Device ${(d.deviceId ?? 0).toString(16)}`,
      driver: d.driverVersion && d.driverVersion !== '0.0.0.0' ? d.driverVersion : undefined,
      active: Boolean(d.active),
    }
    const notACard = /Basic Render|SwiftShader|WARP|llvmpipe|Remote Display|Virtual Display/i.test(device.name) || /^Device [0-9a-f]+$/.test(device.name)
    // Listed all the same when it's what Lumen is running on: that's worth knowing.
    if (notACard && !device.active) continue
    const key = `${device.vendor}|${device.name}`
    const seen = cards.get(key)
    if (seen) seen.active ||= device.active
    else cards.set(key, device)
  }
  return [...cards.values()].sort((a, b) => Number(b.active) - Number(a.active))
}

export async function gpuInfo(): Promise<GpuInfo> {
  const settings = graphicsSettings()
  const startedWith = applied ?? settings
  let devices: GpuDevice[] = []
  try {
    const info = (await app.getGPUInfo('complete')) as { gpuDevice?: RawDevice[]; auxAttributes?: { glRenderer?: string } }
    devices = devicesFrom(info.gpuDevice ?? [], info.auxAttributes?.glRenderer)
  } catch {
    /* no GPU process (software rendering) */
  }
  return {
    devices,
    features: app.getGPUFeatureStatus() as unknown as Record<string, string>,
    settings,
    restartNeeded: settings.gpu !== startedWith.gpu || settings.ignoreBlocklist !== startedWith.ignoreBlocklist,
  }
}
