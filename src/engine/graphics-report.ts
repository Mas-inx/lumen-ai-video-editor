/**
 * What this computer's graphics can do for Lumen, found out rather than
 * assumed: the cards Chromium sees, what it accelerates on them, and whether
 * each video encoder really works at the sizes people export.
 */
import type { GpuInfo } from '@shared/app'
import { desktop } from '@/lib/platform'
import { CODEC_NAME, HAS_SOFTWARE, planFor, testEncoder, type ExportVideoCodec } from './encoders'

export type EncoderState = 'works' | 'fails' | 'none'

export interface EncoderCheck {
  codec: ExportVideoCodec
  size: string
  hardware: EncoderState
  software: EncoderState
  /** What the encoder said when it failed. */
  hardwareError?: string
  softwareError?: string
}

export const CHECK_SIZES = [
  { label: '1080p 60', width: 1920, height: 1080, fps: 60 },
  { label: '4K 60', width: 3840, height: 2160, fps: 60 },
] as const

export const CHECK_CODECS: ExportVideoCodec[] = ['avc', 'hevc', 'av1', 'vp9']

/** "No encoder here" reads differently from "there is one and it broke". */
const stateOf = (r: { ok: boolean; error?: string }): EncoderState => (r.ok ? 'works' : /^(No graphics-card encoder|Not available|This build has no)/.test(r.error ?? '') ? 'none' : 'fails')

/** Tries every encoder for real at 1080p 60 and 4K 60. `onRow` is called as each row is known. */
export async function checkEncoders(onRow?: (row: EncoderCheck) => void): Promise<EncoderCheck[]> {
  const rows: EncoderCheck[] = []
  for (const size of CHECK_SIZES) {
    for (const codec of CHECK_CODECS) {
      const run = (acceleration: 'prefer-hardware' | 'prefer-software') => testEncoder(planFor(codec, acceleration, size.width, size.height, size.fps, 72), size.width, size.height, size.fps)
      const hardware = await run('prefer-hardware')
      const software = HAS_SOFTWARE[codec] ? await run('prefer-software') : { ok: false, error: 'Not available' }
      const row: EncoderCheck = {
        codec,
        size: size.label,
        hardware: stateOf(hardware),
        software: HAS_SOFTWARE[codec] ? stateOf(software) : 'none',
        ...(hardware.ok || stateOf(hardware) === 'none' ? {} : { hardwareError: hardware.error }),
        ...(software.ok || stateOf(software) === 'none' ? {} : { softwareError: software.error }),
      }
      rows.push(row)
      onRow?.(row)
    }
  }
  return rows
}

const DECODE_CODECS: Record<string, string> = { 'H.264': 'avc1.640034', HEVC: 'hvc1.1.6.L153.B0', 'HEVC 10-bit': 'hvc1.2.4.L153.B0', VP9: 'vp09.00.51.08', AV1: 'av01.0.13M.08' }

/** Which decoders say they take 4K video (not tried, just asked). */
export async function decoderSupport() {
  const out: Record<string, { hardware: boolean; software: boolean }> = {}
  if (typeof VideoDecoder === 'undefined') return out
  for (const [name, codec] of Object.entries(DECODE_CODECS)) {
    const ask = async (hardwareAcceleration: 'prefer-hardware' | 'prefer-software') =>
      (await VideoDecoder.isConfigSupported({ codec, codedWidth: 3840, codedHeight: 2160, hardwareAcceleration }).catch(() => null))?.supported === true
    out[name] = { hardware: await ask('prefer-hardware'), software: await ask('prefer-software') }
  }
  return out
}

/** The card WebGL draws with, and how big a texture it takes. */
export function webglInfo() {
  try {
    const gl = document.createElement('canvas').getContext('webgl2')
    if (!gl) return { available: false as const }
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    const info = { available: true as const, renderer: String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)), maxTexture: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) }
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return info
  } catch {
    return { available: false as const }
  }
}

export interface GraphicsReport {
  gpu: GpuInfo | null
  webgl: ReturnType<typeof webglInfo>
  decoders: Awaited<ReturnType<typeof decoderSupport>>
  encoders: EncoderCheck[]
}

export async function graphicsReport(): Promise<GraphicsReport> {
  const gpu = desktop ? await desktop.system.gpu().catch(() => null) : null
  return { gpu, webgl: webglInfo(), decoders: await decoderSupport(), encoders: await checkEncoders() }
}

const mark = (s: EncoderState) => (s === 'works' ? 'works' : s === 'fails' ? 'FAILS' : 'none')

/** The report as text someone can paste when asking for help. */
export function reportText(r: GraphicsReport, versions: { app: string; electron?: string; chrome?: string }) {
  const lines = [`Lumen ${versions.app}${versions.electron ? ` · Electron ${versions.electron} · Chromium ${versions.chrome}` : ''}`, '']
  lines.push('Graphics cards:')
  for (const d of r.gpu?.devices ?? []) lines.push(`  ${d.active ? '*' : ' '} ${d.vendor} ${d.name}${d.driver ? ` (driver ${d.driver})` : ''}`)
  if (!r.gpu?.devices.length) lines.push('  (none reported)')
  if (r.gpu) lines.push(`  Asked for: ${r.gpu.settings.gpu}${r.gpu.settings.ignoreBlocklist ? ', ignoring the blocklist' : ''}`)
  lines.push('', `WebGL: ${r.webgl.available ? `${r.webgl.renderer} · textures up to ${r.webgl.maxTexture}px` : 'not available'}`)
  if (r.gpu) lines.push('', 'Chromium features:', ...Object.entries(r.gpu.features).map(([k, v]) => `  ${k}: ${v}`))
  lines.push('', 'Encoders (graphics card / processor):')
  for (const e of r.encoders) {
    lines.push(`  ${CODEC_NAME[e.codec].padEnd(6)} ${e.size.padEnd(9)} ${mark(e.hardware)} / ${mark(e.software)}${e.hardwareError ? `  — card: ${e.hardwareError}` : ''}${e.softwareError ? `  — processor: ${e.softwareError}` : ''}`)
  }
  lines.push('', 'Decoders at 4K (graphics card / processor):')
  for (const [name, d] of Object.entries(r.decoders)) lines.push(`  ${name.padEnd(12)} ${d.hardware ? 'yes' : 'no'} / ${d.software ? 'yes' : 'no'}`)
  return lines.join('\n')
}
