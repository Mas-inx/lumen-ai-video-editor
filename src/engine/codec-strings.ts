/**
 * Codec strings that say what the video really needs. A level has to cover the
 * frame rate as well as the picture size: 4K at 60 fps is H.264 level 5.2, not
 * the 5.1 that 4K at 30 gets. A level that's too low makes strict encoders
 * refuse the settings and leaves a file labelled below what it contains.
 */
import { vp9Level } from '@shared/ingest'

export type LeveledCodec = 'avc' | 'hevc' | 'av1' | 'vp9'

/** H.264: [level × 10, macroblocks per second, macroblocks per frame, kbit/s for the Main profile]. */
const AVC_LEVELS: [number, number, number, number][] = [
  [30, 40500, 1620, 10000],
  [31, 108000, 3600, 14000],
  [32, 216000, 5120, 20000],
  [40, 245760, 8192, 20000],
  [41, 245760, 8192, 50000],
  [42, 522240, 8704, 50000],
  [50, 589824, 22080, 135000],
  [51, 983040, 36864, 240000],
  [52, 2073600, 36864, 240000],
  [60, 4177920, 139264, 240000],
  [61, 8355840, 139264, 480000],
  [62, 16711680, 139264, 800000],
]

/** The lowest H.264 level for this picture, frame rate and bitrate (High profile carries 1.25× the Main bitrate). */
export function avcLevel(width: number, height: number, fps: number, bitrate: number) {
  const mbs = Math.ceil(width / 16) * Math.ceil(height / 16)
  const kbps = bitrate / 1000
  return (AVC_LEVELS.find(([, rate, size, max]) => mbs <= size && mbs * fps <= rate && kbps <= max * 1.25) ?? AVC_LEVELS[AVC_LEVELS.length - 1])[0]
}

/** HEVC: [level × 30, luma picture size, luma samples per second, Main tier kbit/s, High tier kbit/s (0: none)]. */
const HEVC_LEVELS: [number, number, number, number, number][] = [
  [90, 552960, 16588800, 6000, 0],
  [93, 983040, 33177600, 10000, 0],
  [120, 2228224, 66846720, 12000, 30000],
  [123, 2228224, 133693440, 20000, 50000],
  [150, 8912896, 267386880, 25000, 100000],
  [153, 8912896, 534773760, 40000, 160000],
  [156, 8912896, 1069547520, 60000, 240000],
  [180, 35651584, 1069547520, 60000, 240000],
  [183, 35651584, 2139095040, 120000, 480000],
  [186, 35651584, 4278190080, 240000, 800000],
]

/** The lowest HEVC level that holds the picture and frame rate, in the Main tier when the bitrate fits it. */
export function hevcLevel(width: number, height: number, fps: number, bitrate: number): { level: number; tier: 'L' | 'H' } {
  const size = width * height
  const kbps = bitrate / 1000
  const fits = HEVC_LEVELS.filter(([, picture, rate]) => size <= picture && size * fps <= rate)
  const row = fits[0] ?? HEVC_LEVELS[HEVC_LEVELS.length - 1]
  if (kbps <= row[3]) return { level: row[0], tier: 'L' }
  if (row[4] && kbps <= row[4]) return { level: row[0], tier: 'H' }
  // Too many bits for this level in either tier: the next level whose Main tier takes them, else the High tier.
  const higher = fits.find(([, , , main]) => kbps <= main)
  return higher ? { level: higher[0], tier: 'L' } : { level: row[0], tier: row[4] ? 'H' : 'L' }
}

/** AV1: [seq_level_idx, picture size, display samples per second, Main tier Mbit/s, High tier Mbit/s (0: none)]. */
const AV1_LEVELS: [number, number, number, number, number][] = [
  [0, 147456, 4423680, 1.5, 0],
  [1, 278784, 8363520, 3, 0],
  [4, 665856, 19975680, 6, 0],
  [5, 1065024, 31950720, 10, 0],
  [8, 2359296, 70778880, 12, 30],
  [9, 2359296, 141557760, 20, 50],
  [12, 8912896, 267386880, 30, 100],
  [13, 8912896, 534773760, 40, 160],
  [14, 8912896, 1069547520, 60, 240],
  [16, 35651584, 1069547520, 60, 240],
  [17, 35651584, 2139095040, 100, 480],
  [18, 35651584, 4278190080, 160, 800],
]

export function av1Level(width: number, height: number, fps: number, bitrate: number): { level: number; tier: 'M' | 'H' } {
  const size = width * height
  const mbps = bitrate / 1e6
  const row = AV1_LEVELS.find(([, picture, rate]) => size <= picture && size * fps <= rate) ?? AV1_LEVELS[AV1_LEVELS.length - 1]
  return { level: row[0], tier: mbps > row[3] && row[4] ? 'H' : 'M' }
}

const hex2 = (n: number) => n.toString(16).padStart(2, '0')

/**
 * The full codec string for an 8-bit 4:2:0 export: H.264 High, HEVC Main, AV1
 * Main or VP9 profile 0, at the level this size, frame rate and bitrate need.
 */
export function codecString(codec: LeveledCodec, width: number, height: number, fps: number, bitrate: number) {
  if (codec === 'avc') return `avc1.6400${hex2(avcLevel(width, height, fps, bitrate))}`
  if (codec === 'hevc') {
    const { level, tier } = hevcLevel(width, height, fps, bitrate)
    return `hev1.1.6.${tier}${level}.B0`
  }
  if (codec === 'av1') {
    const { level, tier } = av1Level(width, height, fps, bitrate)
    return `av01.0.${String(level).padStart(2, '0')}${tier}.08`
  }
  return `vp09.00.${String(vp9Level(width, height, fps)).padStart(2, '0')}.08`
}
