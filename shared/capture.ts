/**
 * Screen recording, the parts both sides agree on: what can be recorded, the
 * settings of a recording, and the arithmetic that turns them into a size and
 * a bitrate.
 *
 * The picture comes from Chromium's capture (Windows Graphics Capture for a
 * window, desktop duplication for a screen) and is encoded as it arrives by
 * the same encoders an export uses — the graphics card's when it has one that
 * works, the processor's otherwise. A small helper (native/capture-helper)
 * adds what Chromium can't give: the sound of one app, and the cursor's
 * position and clicks as data.
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export type CaptureSourceKind = 'screen' | 'window'

/** Something that can be recorded: a whole screen, or one window. */
export interface CaptureSource {
  /** Chromium's id for it: `screen:<n>:0` or `window:<hwnd>:0`. */
  id: string
  kind: CaptureSourceKind
  /** A window's title, or "Screen 1". */
  name: string
  /** Pixels of what is captured, when known (a screen's are; a window's are once the helper has measured it). */
  width?: number
  height?: number
  /** Where it is on the desktop, in pixels — what cursor positions are measured against. */
  bounds?: Rect
  /** Screens: how many pixels one layout unit is. */
  scale?: number
  primary?: boolean
  /** Screens: the monitor's refresh rate. */
  hz?: number
  /** Windows: the window handle, its process and that process's file name ("FiveM_GTAProcess.exe"). */
  hwnd?: number
  pid?: number
  process?: string
  minimized?: boolean
  /** One of Lumen's own windows. */
  own?: boolean
  /** A small picture of it (a data URL), when asked for. */
  thumbnail?: string
  /** The app's icon (a data URL). */
  icon?: string
}

export type CaptureCodec = 'avc' | 'hevc' | 'av1'

/** Which sound goes into the recording's own track. */
export type CaptureAudio = 'off' | 'system' | 'app'

/** `native`, or the short side of the frame in pixels (2160 is 4K): smaller sources are scaled up to it, larger ones down. */
export type CaptureResolution = 'native' | number

export type CaptureRate = { mode: 'quality'; quality: number } | { mode: 'bitrate'; mbps: number }

export interface CaptureSettings {
  sourceId: string
  /** Part of the source to record, in its pixels. Null records all of it. */
  region: Rect | null
  resolution: CaptureResolution
  fps: number
  codec: CaptureCodec
  /** Try the graphics card's encoder first. */
  hardware: boolean
  rate: CaptureRate
  /** A key frame at least this often, in seconds: lower scrubs faster, higher makes smaller files. */
  keyframeSeconds: number
  /** The mouse pointer is part of the picture. */
  cursor: boolean
  /** Where the pointer is and when it clicks, kept as data beside the picture (for zooms and highlights later). */
  cursorData: boolean
  audio: CaptureAudio
  /** A microphone's device id, recorded as its own clip; null for none. */
  mic: string | null
  /** A camera's device id, recorded as its own clip; null for none. */
  webcam: string | null
  /** The camera clip's height. */
  webcamHeight: number
  /** Seconds counted down before recording starts. */
  countdown: number
  /** Lumen's own window doesn't appear in a screen recording. */
  hideLumen: boolean
  /** Lumen gets out of the way while recording. */
  minimize: boolean
  /** Where the clips go when the recording ends. */
  place: 'timeline' | 'library'
  /**
   * How the file's colours are labelled: `standard` (sRGB — what games and most
   * apps mean), or `display` (the screen's own wide gamut — what apps that
   * manage colour, like browsers, really showed on such a screen).
   */
  colour: 'standard' | 'display'
}

export const CAPTURE_FPS = [24, 25, 30, 50, 60] as const
export const CAPTURE_RESOLUTIONS: { value: CaptureResolution; label: string }[] = [
  { value: 'native', label: 'Native' },
  { value: 2160, label: '4K' },
  { value: 1440, label: '1440p' },
  { value: 1080, label: '1080p' },
  { value: 720, label: '720p' },
]

export const DEFAULT_CAPTURE: Omit<CaptureSettings, 'sourceId'> = {
  region: null,
  resolution: 'native',
  fps: 60,
  codec: 'avc',
  hardware: true,
  rate: { mode: 'quality', quality: 60 },
  keyframeSeconds: 2,
  cursor: true,
  cursorData: true,
  audio: 'system',
  mic: null,
  webcam: null,
  webcamHeight: 720,
  countdown: 3,
  hideLumen: true,
  minimize: false,
  place: 'timeline',
  colour: 'standard',
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/** The largest frame recorded: 4K in either direction. Past this, encoders on most graphics cards stop. */
export const MAX_CAPTURE_SIDE = 3840

/**
 * A region made to fit its source and to start and end on even pixels (video
 * is stored in 2×2 blocks). Null when it covers the whole source or is too
 * small to be a picture.
 */
export function fitRegion(region: Rect | null | undefined, srcWidth: number, srcHeight: number): Rect | null {
  if (!region) return null
  const x = clamp(Math.floor(region.x / 2) * 2, 0, Math.max(0, srcWidth - 2))
  const y = clamp(Math.floor(region.y / 2) * 2, 0, Math.max(0, srcHeight - 2))
  const width = Math.floor(clamp(region.width, 0, srcWidth - x) / 2) * 2
  const height = Math.floor(clamp(region.height, 0, srcHeight - y) / 2) * 2
  if (width < 16 || height < 16) return null
  if (x === 0 && y === 0 && width >= Math.floor(srcWidth / 2) * 2 && height >= Math.floor(srcHeight / 2) * 2) return null
  return { x, y, width, height }
}

export interface CaptureFrame {
  /** The part of the source that is recorded (all of it when there is no region), on even pixels. */
  crop: Rect
  /** The size of the file's picture. */
  width: number
  height: number
  /** The picture is resized on its way to the file. */
  scaled: boolean
}

/**
 * What a recording's picture is: the part of the source taken, and the size it
 * is stored at. A resolution names the short side (2160 is 4K), keeps the
 * source's shape, and never lets either side pass 3840.
 */
export function captureFrame(srcWidth: number, srcHeight: number, region: Rect | null | undefined, resolution: CaptureResolution): CaptureFrame {
  const fitted = fitRegion(region, srcWidth, srcHeight)
  const crop = fitted ?? { x: 0, y: 0, width: Math.floor(srcWidth / 2) * 2, height: Math.floor(srcHeight / 2) * 2 }
  let width = crop.width
  let height = crop.height
  if (resolution !== 'native') {
    const k = Math.max(16, resolution) / Math.min(width, height)
    width = even(width * k)
    height = even(height * k)
  }
  // Whatever was asked, nothing wider or taller than 4K's long side.
  const over = Math.max(width, height) / MAX_CAPTURE_SIDE
  if (over > 1) {
    width = even(width / over)
    height = even(height / over)
  }
  return { crop, width, height, scaled: width !== crop.width || height !== crop.height }
}

/** "3240×2160" */
export const sizeLabel = (width: number, height: number) => `${width}×${height}`

/** What a resolution choice comes to for a source, for menus: "4K · 3840×2160". */
export function resolutionLabel(resolution: CaptureResolution, srcWidth: number, srcHeight: number, region?: Rect | null) {
  const f = captureFrame(srcWidth, srcHeight, region, resolution)
  const name = CAPTURE_RESOLUTIONS.find((r) => r.value === resolution)?.label ?? `${resolution}p`
  return `${name} · ${sizeLabel(f.width, f.height)}`
}

const pad = (n: number) => String(n).padStart(2, '0')

/** "Recording 2026-10-13 21.45.10" — sorts by time and is a legal file name everywhere. */
export function recordingName(at: Date, label = 'Recording') {
  return `${label} ${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}.${pad(at.getMinutes())}.${pad(at.getSeconds())}`
}

/** A name a person or an agent gave a recording, made safe to be a file name. */
export function cleanRecordingName(name: string) {
  return name
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/, '')
    .trim()
    .slice(0, 80)
}

// ─── The cursor, as data ─────────────────────────────────────────────────

export type MouseButton = 'left' | 'right' | 'middle'

export interface CursorClick {
  /** Seconds from the start of the clip. */
  t: number
  /** Where, as fractions of the recorded picture (0..1 from the top left). */
  x: number
  y: number
  button: MouseButton
  /** How long the button was held, in seconds (a drag is a long one). */
  held?: number
}

/**
 * Where the pointer was through a recording. Positions are fractions of the
 * recorded picture, so they survive scaling; a position outside 0..1 means the
 * pointer had left the recorded area.
 */
export interface CursorTrack {
  /** Flat triples: time (s), x, y — one each time the pointer had moved, at most `rate` a second. */
  moves: number[]
  clicks: CursorClick[]
  /** Samples a second at most. */
  rate: number
}

/** One event of the helper's cursor stream (see native/capture-helper). Times are Unix milliseconds. */
export type CursorEvent =
  | { e: 'start'; t: number; hz: number; screen: Rect }
  | { e: 'move'; t: number; x: number; y: number }
  | { e: 'down' | 'up'; t: number; x: number; y: number; button: MouseButton }
  | { e: 'shape'; t: number; shape: string; visible: boolean }
  | { e: 'window'; t: number; rect?: Rect; client?: Rect; minimized?: boolean; foreground?: boolean; gone?: boolean }

const round4 = (n: number) => Math.round(n * 10000) / 10000
const round3 = (n: number) => Math.round(n * 1000) / 1000

/**
 * Builds a clip's cursor track from the raw events.
 *
 * `area(t)` says where the recorded picture was on the desktop at a time
 * (a screen never moves; a window can), `toClip(t)` turns a Unix time into
 * seconds on the clip (pauses taken out), or null for a time that isn't on it.
 */
export function buildCursorTrack(events: CursorEvent[], area: (t: number) => Rect | null, toClip: (t: number) => number | null, rate = 30): CursorTrack {
  const moves: number[] = []
  const clicks: CursorClick[] = []
  const down = new Map<MouseButton, CursorClick>()
  const gap = 1 / rate
  let lastT = -Infinity
  let lastX = NaN
  let lastY = NaN
  const place = (e: { t: number; x: number; y: number }) => {
    const box = area(e.t)
    const t = toClip(e.t)
    if (!box || t === null || box.width <= 0 || box.height <= 0) return null
    return { t: round3(t), x: round4((e.x - box.x) / box.width), y: round4((e.y - box.y) / box.height) }
  }
  const keep = (p: { t: number; x: number; y: number }, force = false) => {
    if (!force && (p.t - lastT < gap || (Math.abs(p.x - lastX) < 0.0008 && Math.abs(p.y - lastY) < 0.0008))) return
    // A position already written for this instant is replaced, not doubled.
    if (p.t === lastT && moves.length >= 3) moves.length -= 3
    moves.push(p.t, p.x, p.y)
    lastT = p.t
    lastX = p.x
    lastY = p.y
  }
  for (const e of events) {
    if (e.e === 'move') {
      const p = place(e)
      if (p) keep(p)
    } else if (e.e === 'down') {
      const p = place(e)
      if (!p) continue
      keep(p, true)
      const click: CursorClick = { ...p, button: e.button }
      down.set(e.button, click)
      clicks.push(click)
    } else if (e.e === 'up') {
      const p = place(e)
      const click = down.get(e.button)
      down.delete(e.button)
      if (p) keep(p, true)
      if (click && p && p.t > click.t) click.held = round3(p.t - click.t)
    }
  }
  return { moves, clicks, rate }
}

/** Where the pointer was at a time on the clip (the last sample at or before it), or null before the first. */
export function cursorAt(track: CursorTrack, t: number): { x: number; y: number } | null {
  const m = track.moves
  let lo = 0
  let hi = m.length / 3 - 1
  if (hi < 0 || m[0] > t) return null
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (m[mid * 3] <= t) lo = mid
    else hi = mid - 1
  }
  return { x: m[lo * 3 + 1], y: m[lo * 3 + 2] }
}

// ─── A recording's own time ──────────────────────────────────────────────

/** When a recording started and the stretches it was paused, all on one clock (milliseconds). An open pause ends at infinity. */
export interface RecordingClock {
  startAt: number
  pauses: { from: number; to: number }[]
}

export const pausedAt = (clock: RecordingClock, t: number) => clock.pauses.some((p) => t >= p.from && t < p.to)

/** Seconds on the recording for a time on its clock: pauses are taken out. */
export function recordingSeconds(clock: RecordingClock, t: number) {
  let paused = 0
  for (const p of clock.pauses) if (t > p.from) paused += Math.min(t, p.to) - p.from
  return (t - clock.startAt - paused) / 1000
}

// ─── What a recording reports while it runs ──────────────────────────────

export type RecordingPhase = 'idle' | 'preparing' | 'countdown' | 'recording' | 'paused' | 'finishing'

export interface RecordingStats {
  /** Seconds recorded so far (pauses not counted). */
  seconds: number
  /** Frames written to the file. */
  frames: number
  /** Frames the source delivered in the last second. */
  sourceFps: number
  /** Frames repeated because the source had nothing new, and frames skipped because the encoder was behind. */
  repeated: number
  dropped: number
  /** Bytes written so far, all files together. */
  bytes: number
  /** Video bits per second over the last few seconds. */
  bitrate: number
  /** Milliseconds each frame takes to hand to the encoder (scaling the picture happens there). */
  encodeMs?: number
  /** Loudest sample since the last report, 0..1, per sound source. */
  levels: { audio?: number; mic?: number }
  /** Free space where the files are going, in bytes (undefined when unknown). */
  free?: number
}

/** A point of interest dropped while recording. */
export interface RecordingMarker {
  /** Seconds from the start of the recording. */
  t: number
  label?: string
}

/** What one finished file is. */
export interface RecordedFile {
  role: 'screen' | 'webcam' | 'mic'
  path: string
  bytes: number
  seconds: number
  width?: number
  height?: number
  fps?: number
  frames?: number
  /** "H.264 on the graphics card" */
  encoder?: string
  hasAudio?: boolean
  /** The file is a fragmented MP4: finishing it into an ordinary one failed (it still plays and edits). */
  fragmented?: boolean
}

/** A recording that was being written when Lumen last stopped unexpectedly. */
export interface RecoverableRecording {
  path: string
  bytes: number
  modifiedAt: number
}

export interface CaptureFolderState {
  /** Where recordings are written. */
  folder: string
  /** The default (inside the user's Videos folder). */
  isDefault: boolean
}

/** Whether the helper is there and what it can do on this version of Windows. */
export interface CaptureHelperState {
  available: boolean
  /** One app's sound can be recorded (Windows 10 build 20348 and later, and all of Windows 11). */
  appAudio: boolean
  /** Cursor positions and clicks can be recorded. */
  cursor: boolean
  /** Why it isn't available, in a sentence. */
  reason?: string
}

export const CAPTURE_IPC = {
  sources: 'lumen:capture:sources',
  arm: 'lumen:capture:arm',
  helper: 'lumen:capture:helper',
  folder: 'lumen:capture:folder',
  pickFolder: 'lumen:capture:pick-folder',
  resetFolder: 'lumen:capture:reset-folder',
  begin: 'lumen:capture:begin',
  finish: 'lumen:capture:finish',
  discard: 'lumen:capture:discard',
  free: 'lumen:capture:free',
  session: 'lumen:capture:session',
  appAudioStart: 'lumen:capture:app-audio-start',
  cursorStart: 'lumen:capture:cursor-start',
  streamStop: 'lumen:capture:stream-stop',
  recoverable: 'lumen:capture:recoverable',
  recover: 'lumen:capture:recover',
  forget: 'lumen:capture:forget',
  windowInfo: 'lumen:capture:window-info',
  focus: 'lumen:capture:focus',
  /** main → renderer */
  audioChunk: 'lumen:capture:audio-chunk',
  cursorEvents: 'lumen:capture:cursor-events',
  streamEnded: 'lumen:capture:stream-ended',
  hotkey: 'lumen:capture:hotkey',
} as const

export type CaptureHotkey = 'toggle' | 'pause' | 'marker'

/** Keys that work while another app has the keyboard. */
export const CAPTURE_HOTKEYS: Record<CaptureHotkey, { accelerator: string; label: string }> = {
  toggle: { accelerator: 'Control+Alt+R', label: 'Ctrl Alt R' },
  pause: { accelerator: 'Control+Alt+P', label: 'Ctrl Alt P' },
  marker: { accelerator: 'Control+Alt+M', label: 'Ctrl Alt M' },
}

/** What the main process is told about the recorder, so it can keep the computer awake, listen for the keys and stay out of the picture. */
export interface CaptureSessionState {
  /** The record window is open or a recording is running: the start/stop key listens. */
  armed: boolean
  recording: boolean
  /** Keep Lumen's window out of screen recordings. */
  hideLumen: boolean
  /** Lumen minimizes while recording and comes back after. */
  minimize: boolean
}

/** The header the helper's audio stream starts with. */
export interface AppAudioFormat {
  sampleRate: number
  channels: number
  format: 'f32le'
  pid: number
  /** Unix milliseconds of the first sample. */
  t: number
}

/** What the preload exposes as `window.lumen.app.capture`. */
export interface CaptureAPI {
  /** Screens and windows that can be recorded, with small pictures when asked. */
  sources(opts?: { thumbnails?: boolean; icons?: boolean }): Promise<CaptureSource[]>
  /** Says which source the next `getDisplayMedia` call gets (and whether it carries the system's sound). One call, one stream. */
  arm(sourceId: string, systemAudio: boolean): Promise<void>
  helper(): Promise<CaptureHelperState>
  folder(): Promise<CaptureFolderState>
  pickFolder(): Promise<CaptureFolderState>
  resetFolder(): Promise<CaptureFolderState>
  /** Opens a file in the recordings folder for streamed writes (then export.write, and capture.finish or capture.discard). */
  begin(name: string, extension: 'mp4' | 'm4a'): Promise<{ id: string; path: string }>
  /** Closes a recording's file and turns it into an ordinary MP4. */
  finish(id: string): Promise<{ path: string; size: number; fragmented: boolean }>
  discard(id: string): Promise<void>
  /** Free bytes where recordings go. */
  free(): Promise<number | null>
  session(state: CaptureSessionState): void
  /** Starts the sound of one app (by window or process); chunks arrive through onAudioChunk under `key`. */
  startAppAudio(key: string, target: { hwnd?: number; pid?: number }): Promise<AppAudioFormat>
  /** Starts the cursor's stream; events arrive through onCursorEvents under `key`. */
  startCursor(key: string, target: { hwnd?: number; hz?: number }): Promise<void>
  stopStream(key: string): Promise<void>
  /** A window's process and exact place on the desktop. */
  windowInfo(hwnd: number): Promise<Pick<CaptureSource, 'hwnd' | 'pid' | 'process' | 'bounds' | 'minimized'> | null>
  /** Brings a window to the front (a game has to be the active window to play); with no window, brings Lumen back. False when Windows wouldn't allow it. */
  focus(hwnd?: number): Promise<boolean>
  recoverable(): Promise<RecoverableRecording[]>
  /** Finishes a recording left behind by a crash. */
  recover(path: string): Promise<{ path: string; size: number; fragmented: boolean }>
  /** Deletes one. */
  forget(path: string): Promise<void>
  onAudioChunk(cb: (key: string, data: Uint8Array) => void): () => void
  onCursorEvents(cb: (key: string, events: CursorEvent[]) => void): () => void
  onStreamEnded(cb: (key: string, reason: string) => void): () => void
  onHotkey(cb: (key: CaptureHotkey) => void): () => void
}
