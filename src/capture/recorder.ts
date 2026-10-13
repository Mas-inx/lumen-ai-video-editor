/**
 * The recorder: one recording at a time, started from the record window, a
 * key, or an AI tool. It asks Chromium for the picture, hands the frames to an
 * encoder worker per file (the screen with its sound, the camera, the
 * microphone), and when it stops turns the files into clips — in the media
 * library, and on the timeline lined up with each other.
 */
import { toast } from 'sonner'
import { create } from 'zustand'
import {
  buildCursorTrack,
  cleanRecordingName,
  DEFAULT_CAPTURE,
  pausedAt,
  recordingName,
  recordingSeconds,
  type CaptureAudio,
  type CaptureHelperState,
  type CaptureSettings,
  type CaptureSource,
  type CursorEvent,
  type RecordedFile,
  type RecordingClock,
  type RecordingMarker,
  type RecordingPhase,
  type RecordingStats,
  type Rect,
} from '@shared/capture'
import { parseCues } from '@/editor/cues'
import { DEFAULT_TRANSFORM } from '@/editor/defaults'
import { placeAsset } from '@/editor/placement'
import { usePlayback } from '@/editor/playback'
import { dispatch, getProject, useEditor, type ActionSource } from '@/editor/store'
import type { Asset, AssetCue } from '@/editor/types'
import { useUI } from '@/editor/ui-store'
import { probeMedia } from '@/engine/decode'
import { uid } from '@/lib/id'
import { desktop } from '@/lib/platform'
import { analyzeAssets } from '@/project/media-import'
import type { CaptureFromWorker, CaptureToWorker, RecordJob, SegmentInfo, VideoReady, WorkerStats } from './capture.worker'

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
/** The one clock every time in a recording is on. */
const clockNow = () => performance.timeOrigin + performance.now()

const ZERO_STATS: RecordingStats = { seconds: 0, frames: 0, sourceFps: 0, repeated: 0, dropped: 0, bytes: 0, bitrate: 0, levels: {} }

export interface RecorderState {
  phase: RecordingPhase
  settings: CaptureSettings
  sources: CaptureSource[]
  /** The record window is open. */
  open: boolean
  /** The picked source's live picture: what a recording would show. */
  stream: MediaStream | null
  /** A small, slow copy of it for looking at: showing every frame at full size would take time from the recording. */
  preview: MediaStream | null
  /** The source's real size in pixels, read from its first frame. */
  sourceSize: { width: number; height: number } | null
  /** What the encoder settled on once it saw the picture: the real sizes and which encoder. */
  ready: VideoReady | null
  /** Seconds left of the countdown. */
  countdown: number
  stats: RecordingStats
  markers: RecordingMarker[]
  /** Things worth knowing that happened on the way (an encoder that was passed over, a sound that fell back). */
  notes: string[]
  error: string | null
  name: string
  helper: CaptureHelperState | null
  /** Who started the recording that is running. */
  by: ActionSource
}

const SETTINGS_KEY = 'lumen.capture'

function loadSettings(): CaptureSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Partial<CaptureSettings>
    // A region belongs to the source it was drawn on, at the size it had then.
    return { ...DEFAULT_CAPTURE, sourceId: '', ...saved, region: null }
  } catch {
    return { ...DEFAULT_CAPTURE, sourceId: '' }
  }
}

function saveSettings(s: CaptureSettings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...s, region: null }))
  } catch {
    /* private storage */
  }
}

export const useRecorder = create<RecorderState>(() => ({
  phase: 'idle',
  settings: loadSettings(),
  sources: [],
  open: false,
  stream: null,
  preview: null,
  sourceSize: null,
  ready: null,
  countdown: 0,
  stats: ZERO_STATS,
  markers: [],
  notes: [],
  error: null,
  name: '',
  helper: null,
  by: 'user',
}))

const get = useRecorder.getState
const set = useRecorder.setState

export const isRecording = () => get().phase === 'recording' || get().phase === 'paused'
export const recorderBusy = () => get().phase !== 'idle'

// ─── Sources and the live picture ────────────────────────────────────────

export async function refreshSources(thumbnails = true): Promise<CaptureSource[]> {
  if (!desktop) return []
  const [sources, helper] = await Promise.all([desktop.capture.sources({ thumbnails, icons: thumbnails }), get().helper ?? desktop.capture.helper()])
  set({ sources, helper })
  return sources
}

export const sourceById = (id: string) => get().sources.find((s) => s.id === id) ?? null

/** What makes one capture stream different from another: change any of these and Chromium has to be asked again. */
const streamKey = (s: CaptureSettings, audio: CaptureAudio) => `${s.sourceId}|${s.cursor ? 'c' : '-'}|${audio === 'system' ? 's' : '-'}|${Math.min(60, s.fps)}`
let previewKey = ''
let previewing: Promise<MediaStream> | null = null

/**
 * The sound that will really be recorded. One app's sound needs a window (a
 * whole screen has no single app) and the helper on a version of Windows that
 * can do it; otherwise it is everything the computer plays.
 */
export function effectiveAudio(settings: CaptureSettings, source: CaptureSource | null, helper: CaptureHelperState | null): { audio: CaptureAudio; note?: string } {
  if (settings.audio !== 'app') return { audio: settings.audio }
  if (source?.kind !== 'window') return { audio: 'system', note: 'A whole screen isn’t one app, so everything the computer plays is recorded.' }
  if (!helper?.appAudio) return { audio: 'system', note: `${helper?.reason ?? 'One app’s sound can’t be recorded here.'} Everything the computer plays is recorded instead.` }
  return { audio: 'app' }
}

async function acquire(settings: CaptureSettings, audio: CaptureAudio): Promise<MediaStream> {
  if (!desktop) throw new Error('Recording needs the desktop app.')
  await desktop.capture.arm(settings.sourceId, audio === 'system')
  try {
    return await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: Math.min(60, settings.fps), max: 60 }, cursor: settings.cursor ? 'always' : 'never' } as MediaTrackConstraints,
      // The sound as it is: no echo cancelling or levelling meant for calls.
      audio: audio === 'system' ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, sampleRate: 48000 } : false,
    })
  } catch (err) {
    throw new Error(`Couldn’t start capturing that ${settings.sourceId.startsWith('screen') ? 'screen' : 'window'} (${message(err)}). If it is a window, check it isn’t minimized.`)
  }
}

const frames = (track: MediaStreamTrack): ReadableStream<VideoFrame> => new MediaStreamTrackProcessor({ track: track as MediaStreamVideoTrack }).readable
const sound = (track: MediaStreamTrack): ReadableStream<AudioData> => new MediaStreamTrackProcessor({ track: track as MediaStreamAudioTrack }).readable

const stopStream = (stream: MediaStream | null | undefined) => stream?.getTracks().forEach((t) => t.stop())

/** Puts a newly started picture in the store, with its small copy for looking at and its real size. */
function show(stream: MediaStream | null) {
  stopStream(get().preview)
  if (!stream) return set({ stream: null, preview: null, sourceSize: null })
  const video = stream.getVideoTracks()[0]
  const small = video.clone()
  void small.applyConstraints({ width: { max: 1280 }, height: { max: 1280 }, frameRate: { max: 20 } }).catch(() => {})
  // What an earlier recording settled on says nothing about this picture.
  set({ stream, preview: new MediaStream([small]), sourceSize: null, ready: null, error: null })
  measureSource()
}

/**
 * Reads the source's real size from one of its frames (what the track says
 * about a window's size isn't its size). Called again when the picture
 * changes shape: a window that was resized. A region drawn on the old size
 * doesn't mean the same place any more, so it is let go.
 */
export function measureSource() {
  const stream = get().stream
  const video = stream?.getVideoTracks()[0]
  if (!stream || !video || video.readyState !== 'live') return
  const probe = video.clone()
  const reader = frames(probe).getReader()
  void reader
    .read()
    .then(({ value }) => {
      if (value && get().stream === stream) {
        const was = get().sourceSize
        const size = { width: value.displayWidth, height: value.displayHeight }
        if (!was || was.width !== size.width || was.height !== size.height) {
          set({ sourceSize: size })
          if (was && get().settings.region && get().phase === 'idle') updateSettings({ region: null })
        }
      }
      value?.close()
    })
    .catch(() => {})
    .finally(() => {
      void reader.cancel().catch(() => {})
      probe.stop()
    })
}

/** Makes the live picture match the settings (asking Chromium again only when it has to). */
export async function syncPreview(): Promise<MediaStream | null> {
  const { settings, helper, phase } = get()
  if (phase !== 'idle' || !settings.sourceId) return get().stream
  const source = sourceById(settings.sourceId)
  if (!source) return get().stream
  const { audio } = effectiveAudio(settings, source, helper)
  const key = streamKey(settings, audio)
  if (key === previewKey && (previewing || get().stream?.active)) return previewing ?? get().stream
  previewKey = key
  const old = get().stream
  const mine = (previewing = acquire(settings, audio))
  try {
    const stream = await mine
    // Another change came in while this one was starting.
    if (previewing !== mine) {
      stopStream(stream)
      return previewing
    }
    stopStream(old)
    show(stream)
    return stream
  } catch (err) {
    if (previewing === mine) {
      previewKey = ''
      stopStream(old)
      show(null)
      set({ error: message(err) })
    }
    return null
  } finally {
    if (previewing === mine) previewing = null
  }
}

export function updateSettings(patch: Partial<CaptureSettings>) {
  const settings = { ...get().settings, ...patch }
  // A region is in the pixels of the source it was drawn on.
  if (patch.sourceId !== undefined && patch.sourceId !== get().settings.sourceId) settings.region = patch.region ?? null
  set({ settings })
  saveSettings(settings)
  if (get().open) void syncPreview()
}

function tellMain() {
  const { open, phase, settings } = get()
  const recording = phase === 'recording' || phase === 'paused' || phase === 'countdown'
  const source = sourceById(settings.sourceId)
  // Hiding Lumen is for screens; a recording OF Lumen has to show it.
  desktop?.capture.session({ armed: open, recording, hideLumen: settings.hideLumen && source?.kind === 'screen', minimize: settings.minimize && !source?.own })
}

export async function openRecorder() {
  if (!desktop) return
  set({ open: true, error: null })
  tellMain()
  const sources = await refreshSources()
  const { settings } = get()
  if (!sources.some((s) => s.id === settings.sourceId)) {
    const first = sources.find((s) => s.kind === 'screen' && s.primary) ?? sources.find((s) => s.kind === 'screen') ?? sources[0]
    if (first) updateSettings({ sourceId: first.id, region: null })
  } else void syncPreview()
}

export function closeRecorder() {
  set({ open: false })
  tellMain()
  if (get().phase === 'idle') {
    stopStream(get().stream)
    previewKey = ''
    show(null)
    set({ ready: null })
  }
}

// ─── One file being recorded ─────────────────────────────────────────────

type Role = RecordedFile['role']

interface OpenFile {
  id: string
  path: string
}

class Track {
  readonly worker: Worker
  readonly files = new Map<number, Promise<OpenFile>>()
  readonly segments: SegmentInfo[] = []
  readonly ready: Promise<VideoReady | undefined>
  readonly done: Promise<void>
  stats: WorkerStats | null = null
  failed: string | null = null

  constructor(
    readonly role: Role,
    private readonly name: string,
    private readonly extension: 'mp4' | 'm4a',
    job: RecordJob,
    transfer: Transferable[],
    onNote: (text: string) => void,
  ) {
    this.worker = new Worker(new URL('./capture.worker.ts', import.meta.url), { type: 'module', name: `record-${role}` })
    let readyOk: (v: VideoReady | undefined) => void = () => {}
    let readyFail: (e: Error) => void = () => {}
    let doneOk: () => void = () => {}
    let doneFail: (e: Error) => void = () => {}
    this.ready = new Promise((ok, no) => ((readyOk = ok), (readyFail = no)))
    this.done = new Promise((ok, no) => ((doneOk = ok), (doneFail = no)))
    // Nobody may be waiting on these yet.
    this.ready.catch(() => {})
    this.done.catch(() => {})
    const broke = (text: string) => {
      this.failed ??= text
      const err = new Error(text)
      readyFail(err)
      doneFail(err)
    }
    this.worker.onmessage = (e: MessageEvent<CaptureFromWorker>) => {
      const msg = e.data
      if (msg.type === 'write') {
        this.file(msg.file)
          .then((f) => desktop!.export.write(f.id, msg.position, msg.data))
          .then(
            () => this.send({ type: 'written', id: msg.id }),
            (err: unknown) => broke(`Couldn’t write the recording: ${message(err)}`),
          )
      } else if (msg.type === 'ready') readyOk(msg.video)
      else if (msg.type === 'segment') this.segments.push(msg.info)
      else if (msg.type === 'stats') this.stats = msg.stats
      else if (msg.type === 'note') onNote(msg.message)
      else if (msg.type === 'done') doneOk()
      else if (msg.type === 'error') broke(msg.message)
    }
    this.worker.onerror = (e) => broke(e.message || 'The encoder stopped unexpectedly.')
    this.worker.postMessage({ type: 'start', job } satisfies CaptureToWorker, transfer)
  }

  send(msg: CaptureToWorker, transfer: Transferable[] = []) {
    this.worker.postMessage(msg, transfer)
  }

  /** A file is made the first time something is written to it: "name", then "name part 2" if the recording had to start a new one. */
  private file(index: number) {
    let f = this.files.get(index)
    if (!f) {
      const label = this.role === 'webcam' ? ' camera' : this.role === 'mic' ? ' microphone' : ''
      f = desktop!.capture.begin(`${this.name}${label}${index ? ` part ${index + 1}` : ''}`, this.extension)
      this.files.set(index, f)
    }
    return f
  }

  /** Closes its files and says what each is. */
  async finish(): Promise<{ file: RecordedFile; segment: SegmentInfo }[]> {
    const out: { file: RecordedFile; segment: SegmentInfo }[] = []
    for (const segment of [...this.segments].sort((a, b) => a.file - b.file)) {
      const open = this.files.get(segment.file)
      if (!open) continue
      const { id } = await open
      // Nothing worth keeping: a file that was opened and never got a frame.
      if (segment.seconds <= 0 || (segment.fps && !segment.frames)) {
        await desktop!.capture.discard(id).catch(() => {})
        continue
      }
      const done = await desktop!.capture.finish(id)
      out.push({
        segment,
        file: { role: this.role, path: done.path, bytes: done.size, seconds: segment.seconds, width: segment.width, height: segment.height, fps: segment.fps, frames: segment.frames, encoder: segment.encoder, hasAudio: segment.hasAudio, ...(done.fragmented ? { fragmented: true } : {}) },
      })
    }
    // Files that never became a finished segment.
    const kept = new Set(this.segments.map((s) => s.file))
    for (const [index, open] of this.files) if (!kept.has(index)) await open.then((f) => desktop!.capture.discard(f.id)).catch(() => {})
    this.worker.terminate()
    return out
  }

  async discard() {
    this.send({ type: 'abort' })
    for (const open of this.files.values()) await open.then((f) => desktop!.capture.discard(f.id)).catch(() => {})
    this.worker.terminate()
  }
}

// ─── A recording ─────────────────────────────────────────────────────────

interface Session {
  name: string
  source: CaptureSource
  settings: CaptureSettings
  audio: CaptureAudio
  clock: RecordingClock
  /** The system's clock minus the recording's, for times the helper stamps. */
  wall: number
  tracks: Track[]
  cursor: CursorEvent[]
  /** Streams this recording opened and closes (the microphone, the camera). */
  streams: MediaStream[]
  /** The source's picture. */
  display: MediaStream
  keys: string[]
  cancelled: boolean
  timers: ReturnType<typeof setInterval>[]
  maxTimer?: ReturnType<typeof setTimeout>
  ended?: () => void
}

let session: Session | null = null
let stopping: Promise<RecordingResult | null> | null = null
let listening = false

/** The helper's streams arrive for whichever recording is running. */
function listen() {
  if (listening || !desktop) return
  listening = true
  desktop.capture.onAudioChunk((key, data) => {
    const s = session
    if (!s || !s.keys.includes(key)) return
    // The bytes are this message's own: they can go to the worker without a copy.
    const copy = data.buffer.byteLength === data.byteLength ? data : data.slice()
    s.tracks.find((t) => t.role === 'screen')?.send({ type: 'pcm', data: copy }, [copy.buffer])
  })
  desktop.capture.onCursorEvents((key, events) => {
    if (session?.keys.includes(key)) session.cursor.push(...events)
  })
  desktop.capture.onStreamEnded((key, reason) => {
    if (!session?.keys.includes(key) || !key.startsWith('audio')) return
    if (reason !== 'ended' && isRecording()) note(`The app’s sound stopped: ${reason}`)
  })
  desktop.capture.onHotkey((key) => {
    if (key === 'toggle') {
      if (isRecording()) void stopRecording().catch(() => {})
      else if (get().phase === 'idle' && get().open) void startRecording().catch(() => {})
    } else if (key === 'pause') togglePause()
    else if (key === 'marker') addMarker()
  })
}

function note(text: string) {
  set((s) => (s.notes.includes(text) ? s : { notes: [...s.notes, text] }))
}

export interface StartOptions {
  settings?: Partial<CaptureSettings>
  name?: string
  /** Stops by itself after this long. */
  maxSeconds?: number
  by?: ActionSource
  /** Test runs only: see the worker. */
  failAfter?: RecordJob['failAfter']
}

/** A screen that shows more colours than sRGB (most laptop panels made since 2021). */
export const wideGamutDisplay = () => typeof matchMedia === 'function' && matchMedia('(color-gamut: p3)').matches

/**
 * What a recording says its colours are. Capture hands over the numbers the
 * screen was sent. Read as standard colours they are what a game or any app
 * that doesn't manage colour meant; on a wide-gamut screen, apps that do
 * manage colour (browsers, design tools) have already converted to the
 * screen's own, and only labelling the file that way shows them as they looked.
 */
function captureColor(settings: CaptureSettings): NonNullable<NonNullable<RecordJob['video']>['color']> {
  return settings.colour === 'display' && wideGamutDisplay() ? { primaries: 'smpte432', transfer: 'iec61966-2-1' } : { primaries: 'bt709', transfer: 'bt709' }
}


/** Starts a recording with the current settings (or these). Resolves once it is rolling. */
export async function startRecording(opts: StartOptions = {}): Promise<{ name: string; ready: VideoReady | null; notes: string[] }> {
  if (!desktop) throw new Error('Recording needs the desktop app.')
  if (get().phase !== 'idle') throw new Error('A recording is already running. Stop it first.')
  listen()
  if (opts.settings) updateSettings(opts.settings)
  const settings = get().settings
  let source = sourceById(settings.sourceId)
  if (!source) {
    await refreshSources(false)
    source = sourceById(settings.sourceId)
  }
  if (!source) throw new Error('Pick a screen or a window to record first.')
  const helper = get().helper ?? (await desktop.capture.helper())
  const { audio, note: audioNote } = effectiveAudio(settings, source, helper)
  const name = cleanRecordingName(opts.name ?? '') || recordingName(new Date())
  set({ phase: 'preparing', error: null, notes: audioNote ? [audioNote] : [], markers: [], stats: ZERO_STATS, ready: null, name, by: opts.by ?? 'user', helper })

  const s: Session = { name, source, settings, audio, clock: { startAt: Infinity, pauses: [] }, wall: Date.now() - clockNow(), tracks: [], cursor: [], streams: [], display: null as unknown as MediaStream, keys: [], cancelled: false, timers: [] }
  session = s
  try {
    // The picture: the one already showing when it matches, a fresh one otherwise.
    const key = streamKey(settings, audio)
    let display = key === previewKey ? await (previewing ?? Promise.resolve(get().stream)) : null
    if (!display?.active || display.getVideoTracks()[0]?.readyState !== 'live') {
      previewKey = key
      stopStream(get().stream)
      display = await acquire(settings, audio)
      show(display)
    }
    s.display = display
    const video = display.getVideoTracks()[0]
    const job: RecordJob = {
      role: 'screen',
      clock: clockNow(),
      video: { frames: frames(video.clone()), region: settings.region, resolution: settings.resolution, fps: settings.fps, codec: settings.codec, hardware: settings.hardware, rate: settings.rate, keyframeSeconds: settings.keyframeSeconds, color: captureColor(settings) },
      ...(opts.failAfter ? { failAfter: opts.failAfter } : {}),
    }
    const transfer: Transferable[] = [job.video!.frames]

    if (audio === 'system') {
      const track = display.getAudioTracks()[0]
      if (track) {
        const samples = sound(track.clone())
        job.audio = { kind: 'track', samples }
        transfer.push(samples)
      } else note('The system’s sound wasn’t available, so the recording has none.')
    } else if (audio === 'app') {
      const audioKey = `audio-${uid('rec')}`
      s.keys.push(audioKey)
      try {
        const format = await desktop.capture.startAppAudio(audioKey, { hwnd: source.hwnd, pid: source.pid })
        job.audio = { kind: 'pcm', sampleRate: format.sampleRate, channels: format.channels, t: format.t - s.wall }
      } catch (err) {
        note(`${message(err)} The recording has no sound of its own.`)
      }
    }
    if (settings.cursorData) {
      const cursorKey = `cursor-${uid('rec')}`
      s.keys.push(cursorKey)
      await desktop.capture.startCursor(cursorKey, { hwnd: source.hwnd, hz: 120 }).catch(() => {})
    }
    s.tracks.push(new Track('screen', name, 'mp4', job, transfer, note))

    if (settings.webcam) {
      try {
        const cam = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: settings.webcam }, height: { ideal: settings.webcamHeight }, frameRate: { ideal: 30 } } })
        s.streams.push(cam)
        const camFrames = frames(cam.getVideoTracks()[0])
        const camFps = Math.min(60, Math.round(cam.getVideoTracks()[0].getSettings().frameRate ?? 30)) || 30
        s.tracks.push(
          new Track('webcam', name, 'mp4', { role: 'webcam', clock: clockNow(), video: { frames: camFrames, region: null, resolution: 'native', fps: camFps, codec: 'avc', hardware: settings.hardware, rate: { mode: 'quality', quality: 72 }, keyframeSeconds: 2 } }, [camFrames], note),
        )
      } catch (err) {
        note(`The camera couldn’t be opened (${message(err)}), so it isn’t recorded.`)
      }
    }
    if (settings.mic) {
      try {
        const mic = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: settings.mic }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
        s.streams.push(mic)
        const samples = sound(mic.getAudioTracks()[0])
        s.tracks.push(new Track('mic', name, 'm4a', { role: 'mic', clock: clockNow(), audio: { kind: 'track', samples } }, [samples], note))
      } catch (err) {
        note(`The microphone couldn’t be opened (${message(err)}), so it isn’t recorded.`)
      }
    }

    // Each encoder says when it has seen the picture and is running.
    const settled = await Promise.race([Promise.all(s.tracks.map((t) => t.ready)), sleep(15_000).then(() => null)])
    if (!settled) throw new Error(`No picture arrived from “${source.name}”. If it is a window, bring it back from the taskbar: a minimized window has nothing to record.`)
    const ready = settled[0] ?? null
    if (ready?.note) note(ready.note)
    set({ ready })

    for (let n = Math.max(0, Math.round(settings.countdown)); n > 0; n--) {
      set({ phase: 'countdown', countdown: n })
      tellMain()
      await sleep(1000)
      if (s.cancelled) throw new Cancelled()
    }
    if (s.cancelled) throw new Cancelled()

    s.clock.startAt = clockNow() + 20
    for (const t of s.tracks) t.send({ type: 'go', at: s.clock.startAt })
    set({ phase: 'recording', countdown: 0 })
    tellMain()

    s.timers.push(setInterval(() => report(s), 250))
    s.timers.push(setInterval(() => void watchDisk(s), 5000))
    if (opts.maxSeconds && opts.maxSeconds > 0) s.maxTimer = setTimeout(() => void stopRecording().catch(() => {}), opts.maxSeconds * 1000)
    // The window closing (or the screen going away) ends the recording with what it has.
    s.ended = () => {
      if (session === s && isRecording()) {
        note(source.kind === 'window' ? 'The window closed, so the recording ended there.' : 'The screen went away, so the recording ended there.')
        void stopRecording().catch(() => {})
      }
    }
    video.addEventListener('ended', s.ended)
    // A broken encoder with nothing to fall back on ends it too.
    for (const t of s.tracks) {
      t.done.catch((err: unknown) => {
        if (session !== s || !isRecording()) return
        if (t.role === 'screen') {
          set({ error: message(err) })
          void stopRecording().catch(() => {})
        } else note(`${t.role === 'webcam' ? 'The camera' : 'The microphone'} stopped: ${message(err)}`)
      })
    }
    return { name, ready, notes: get().notes }
  } catch (err) {
    await abandon(s)
    if (err instanceof Cancelled) throw new Error('The recording was cancelled before it started.')
    set({ error: message(err) })
    throw err
  }
}

class Cancelled extends Error {}

/** Lets go of everything a recording that never rolled (or was thrown away) was holding. */
async function abandon(s: Session) {
  for (const t of s.timers) clearInterval(t)
  if (s.maxTimer) clearTimeout(s.maxTimer)
  for (const key of s.keys) void desktop?.capture.stopStream(key)
  await Promise.all(s.tracks.map((t) => t.discard().catch(() => {})))
  for (const stream of s.streams) stopStream(stream)
  if (s.ended) s.display?.getVideoTracks()[0]?.removeEventListener('ended', s.ended)
  if (session === s) session = null
  set({ phase: 'idle', countdown: 0, stats: ZERO_STATS, ready: null })
  tellMain()
  if (!get().open) {
    stopStream(get().stream)
    previewKey = ''
    show(null)
  }
}

function report(s: Session) {
  const screen = s.tracks.find((t) => t.role === 'screen')?.stats
  const mic = s.tracks.find((t) => t.role === 'mic')?.stats
  let bytes = 0
  for (const t of s.tracks) bytes += t.stats?.bytes ?? 0
  const t = clockNow()
  set((st) => ({
    stats: {
      seconds: Math.max(0, recordingSeconds(s.clock, t)),
      frames: screen?.frames ?? 0,
      sourceFps: screen?.sourceFps ?? 0,
      repeated: screen?.repeated ?? 0,
      dropped: screen?.dropped ?? 0,
      bytes,
      bitrate: screen?.bitrate ?? 0,
      encodeMs: screen?.passMs,
      levels: { ...(s.audio !== 'off' ? { audio: screen?.level ?? 0 } : {}), ...(mic ? { mic: mic.level } : {}) },
      free: st.stats.free,
    },
  }))
}

/** A recording stops itself before the disk is full, so the file can still be finished. */
const LOW_DISK = 400 * 1024 * 1024

async function watchDisk(s: Session) {
  const free = await desktop?.capture.free()
  if (session !== s || free === null || free === undefined) return
  set((st) => ({ stats: { ...st.stats, free } }))
  if (free < LOW_DISK && isRecording()) {
    note('The disk is almost full, so the recording stopped while there was room to finish the file.')
    void stopRecording().catch(() => {})
  }
}

export function togglePause() {
  const s = session
  if (!s) return
  const at = clockNow()
  if (get().phase === 'recording') {
    s.clock.pauses.push({ from: at, to: Infinity })
    for (const t of s.tracks) t.send({ type: 'pause', at })
    set({ phase: 'paused' })
  } else if (get().phase === 'paused') {
    const open = s.clock.pauses.find((p) => p.to === Infinity)
    if (open) open.to = at
    for (const t of s.tracks) t.send({ type: 'resume', at })
    set({ phase: 'recording' })
  }
}

/** Marks this moment of the recording; it comes out as a cue on the clip. */
export function addMarker(label?: string) {
  const s = session
  if (!s || !isRecording()) return null
  const marker: RecordingMarker = { t: Math.round(Math.max(0, recordingSeconds(s.clock, clockNow())) * 1000) / 1000, ...(label ? { label: label.slice(0, 120) } : {}) }
  set((st) => ({ markers: [...st.markers, marker] }))
  return marker
}

// ─── Stopping, and what comes of it ──────────────────────────────────────

export interface StopOptions {
  /** Where the clips go (default: the recording's own setting). `none` keeps the files only. */
  place?: 'timeline' | 'library' | 'none'
  /** Timeline frame to put the clips at (default: the playhead). */
  atFrame?: number
  /** Use only this stretch on the timeline, given as Unix times (milliseconds) — the media keeps everything. */
  trimFromUnixMs?: number
  trimToUnixMs?: number
  /** The same, as seconds from the start of the recording. */
  trimFromSeconds?: number
  trimToSeconds?: number
  /** A cue sheet for the picture: seconds from the trimmed start (or from the recording's start when nothing is trimmed). */
  cues?: unknown
  /** Throw the recording away. */
  discard?: boolean
  source?: ActionSource
}

export interface RecordingResult {
  name: string
  seconds: number
  files: RecordedFile[]
  assets: { id: string; role: Role; name: string; seconds: number; path: string }[]
  clips: { id: string; assetId: string; role: Role }[]
  markers: RecordingMarker[]
  clicks: number
  notes: string[]
}

export function stopRecording(opts: StopOptions = {}): Promise<RecordingResult | null> {
  if (stopping) return stopping
  const s = session
  if (!s) return Promise.reject(new Error('No recording is running.'))
  // Still counting down or getting ready: there is nothing to keep yet.
  if (!isRecording()) {
    s.cancelled = true
    return Promise.resolve(null)
  }
  stopping = finish(s, opts).finally(() => {
    stopping = null
  })
  return stopping
}

async function finish(s: Session, opts: StopOptions): Promise<RecordingResult | null> {
  const at = clockNow()
  for (const p of s.clock.pauses) if (p.to === Infinity) p.to = at
  for (const t of s.timers) clearInterval(t)
  if (s.maxTimer) clearTimeout(s.maxTimer)
  if (s.ended) s.display.getVideoTracks()[0]?.removeEventListener('ended', s.ended)
  set({ phase: 'finishing' })
  // Lumen comes back and can be seen again while the files are finished.
  tellMain()
  for (const key of s.keys) void desktop!.capture.stopStream(key)

  if (opts.discard) {
    await abandon(s)
    return null
  }
  const busy = toast.loading('Finishing the recording', { description: s.name, duration: Infinity })
  try {
    for (const t of s.tracks) t.send({ type: 'stop', at })
    // An encoder that has already failed still has files worth finishing.
    await Promise.race([Promise.all(s.tracks.map((t) => t.done.catch(() => {}))), sleep(60_000)])
    const made: { role: Role; file: RecordedFile; segment: SegmentInfo }[] = []
    for (const t of s.tracks) for (const m of await t.finish()) made.push({ role: t.role, ...m })
    for (const stream of s.streams) stopStream(stream)
    if (!made.some((m) => m.role === 'screen')) throw new Error(get().error ?? 'Nothing was recorded.')

    const { assets, clips, clicks } = await addToProject(s, made, opts)
    const seconds = Math.max(0, recordingSeconds(s.clock, at))
    const result: RecordingResult = { name: s.name, seconds, files: made.map((m) => m.file), assets, clips, markers: get().markers, clicks, notes: get().notes }
    const where = clips.length ? 'on the timeline' : assets.length ? 'in the media library' : 'saved'
    toast.success(`Recorded ${formatSeconds(seconds)}`, {
      id: busy,
      description: `${s.name} · ${where}${get().notes.length ? ` · ${get().notes.length} note${get().notes.length > 1 ? 's' : ''}` : ''}`,
      duration: 7000,
      action: assets.length ? { label: 'Show', onClick: () => useUI.getState().setLeftTab('media') } : { label: 'Open folder', onClick: () => void desktop!.files.reveal(made[0].file.path) },
    })
    return result
  } catch (err) {
    toast.error('The recording couldn’t be finished', { id: busy, description: message(err), duration: 10_000 })
    set({ error: message(err) })
    for (const stream of s.streams) stopStream(stream)
    throw err
  } finally {
    if (session === s) session = null
    set({ phase: 'idle', countdown: 0, ready: null })
    tellMain()
    measureSource()
    if (!get().open) {
      stopStream(get().stream)
      previewKey = ''
      show(null)
    }
  }
}

const formatSeconds = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min` : s >= 60 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${Math.round(s * 10) / 10} s`)

/** Where the recorded picture was on the desktop through the recording: a screen stays put, a window may have been moved. */
function areaOver(s: Session, segment: SegmentInfo): (t: number) => Rect | null {
  const crop = segment.crop
  const srcWidth = segment.srcWidth
  const srcHeight = segment.srcHeight
  if (!crop || !srcWidth || !srcHeight) return () => null
  const within = (outer: Rect): Rect => {
    const kx = outer.width / srcWidth
    const ky = outer.height / srcHeight
    return { x: outer.x + crop.x * kx, y: outer.y + crop.y * ky, width: crop.width * kx, height: crop.height * ky }
  }
  const moves = s.cursor.filter((e): e is Extract<CursorEvent, { e: 'window' }> => e.e === 'window' && Boolean(e.rect))
  if (s.source.kind === 'screen' || !moves.length) {
    const fixed = s.source.bounds ? within(s.source.bounds) : null
    return () => fixed
  }
  return (t) => {
    let at = moves[0]
    for (const m of moves) {
      if (m.t > t) break
      at = m
    }
    return within(at.rect!)
  }
}

async function addToProject(s: Session, made: { role: Role; file: RecordedFile; segment: SegmentInfo }[], opts: StopOptions) {
  const api = desktop!
  const place = opts.place ?? s.settings.place
  const source = opts.source ?? get().by
  const assets: RecordingResult['assets'] = []
  const clips: RecordingResult['clips'] = []
  let clicks = 0
  if (place === 'none') return { assets, clips, clicks }

  // Times the caller gave as Unix milliseconds, as seconds on the recording.
  const onClip = (unix: number | undefined) => (unix === undefined || !Number.isFinite(unix) ? undefined : recordingSeconds(s.clock, unix - s.wall))
  const trimFrom = Math.max(0, onClip(opts.trimFromUnixMs) ?? opts.trimFromSeconds ?? 0)
  const trimTo = onClip(opts.trimToUnixMs) ?? opts.trimToSeconds

  const built: { role: Role; asset: Asset; segment: SegmentInfo }[] = []
  for (const m of made) {
    const info = await api.files.urlForPath(m.file.path)
    if (!info) continue
    const probed = await probeMedia(info.url, info.mime).catch(() => null)
    const { segment } = m
    const seconds = segment.seconds || probed?.duration || 0
    if (seconds <= 0) continue
    const cues: AssetCue[] = []
    let cursor: Asset['cursor']
    if (m.role === 'screen') {
      for (const mk of get().markers) if (mk.t >= segment.from && mk.t <= segment.from + seconds) cues.push({ at: Math.round((mk.t - segment.from) * 1000) / 1000, kind: 'marker', label: mk.label ?? 'Marker' })
      // A sender's cue sheet counts from the start of the stretch that was asked for.
      for (const c of parseCues(opts.cues)) {
        const cueAt = c.at + trimFrom - segment.from
        if (cueAt >= 0 && cueAt <= seconds) cues.push({ ...c, at: Math.round(cueAt * 1000) / 1000 })
      }
      cues.sort((a, b) => a.at - b.at)
      if (s.settings.cursorData && s.keys.some((k) => k.startsWith('cursor'))) {
        const track = buildCursorTrack(s.cursor, areaOver(s, segment), (t) => {
          const ref = t - s.wall
          if (ref < s.clock.startAt || pausedAt(s.clock, ref)) return null
          const sec = recordingSeconds(s.clock, ref) - segment.from
          return sec >= 0 && sec <= seconds ? sec : null
        })
        // Kept even when the pointer did nothing: the clip then says "no clicks", not "no click data".
        cursor = track
        clicks += track.clicks.length
      }
    }
    const label = m.role === 'webcam' ? ' camera' : m.role === 'mic' ? ' microphone' : ''
    const part = made.filter((x) => x.role === m.role).length > 1 ? ` part ${segment.file + 1}` : ''
    const asset: Asset = {
      id: uid('asset'),
      name: `${s.name}${label}${part}`,
      kind: m.role === 'mic' ? 'audio' : 'video',
      duration: seconds,
      ...(m.role !== 'mic' ? { width: segment.width ?? probed?.width, height: segment.height ?? probed?.height, fps: segment.fps ?? probed?.fps } : {}),
      hasAudio: m.role === 'mic' ? true : segment.hasAudio,
      source: { type: 'file', url: info.url, path: info.path, mime: info.mime, fileName: info.name, size: info.size, mtime: info.mtime, poster: probed?.poster },
      ...(cues.length ? { cues } : {}),
      ...(cursor ? { cursor } : {}),
      provenance: {
        integration: 'lumen',
        tool: 'screen-recording',
        params: { role: m.role, source: s.source.name, kind: s.source.kind, ...(s.source.process ? { app: s.source.process } : {}), ...(segment.encoder ? { encoder: segment.encoder } : {}), ...(m.role === 'screen' ? { sound: s.audio } : {}) },
      },
      tags: ['recording', m.role === 'screen' ? 'screen' : m.role === 'webcam' ? 'camera' : 'voice'],
      addedAt: Date.now(),
    }
    built.push({ role: m.role, asset, segment })
  }
  if (!built.length) return { assets, clips, clicks }

  useEditor.getState().transaction(`Add ${s.name}`, source, () => {
    for (const b of built) {
      const res = dispatch('asset.add', { asset: b.asset }, { source })
      if (res.ok) assets.push({ id: b.asset.id, role: b.role, name: b.asset.name, seconds: b.asset.duration ?? 0, path: b.asset.source.type === 'file' ? (b.asset.source.path ?? '') : '' })
    }
    if (place !== 'timeline') return
    const project = getProject()
    const screens = built.filter((b) => b.role === 'screen')
    const first = screens[0]
    // An empty timeline takes the shape of what was recorded.
    if (first && !Object.keys(project.clips).length && first.asset.width && first.asset.height) {
      dispatch('project.update', { settings: { width: first.asset.width, height: first.asset.height, fps: Math.round(first.asset.fps ?? project.settings.fps) } }, { source })
    }
    const fps = getProject().settings.fps
    const at = Math.max(0, Math.round(opts.atFrame ?? usePlayback.getState().frame))
    // Each file in turn, where it happened on the recording; the camera and the microphone under the same times.
    const starts = new Map<number, number>()
    let cursorFrame = at
    for (const b of screens) {
      const from = b.segment.from
      const end = from + (b.asset.duration ?? 0)
      const cutFrom = Math.max(from, trimFrom)
      const cutTo = Math.min(end, trimTo ?? Infinity)
      if (cutTo <= cutFrom) continue
      const clip = placeAsset(b.asset.id, cursorFrame, { source, inPoint: Math.round((cutFrom - from) * fps), duration: Math.max(1, Math.round((cutTo - cutFrom) * fps)) })
      if (!clip) continue
      clips.push({ id: clip, assetId: b.asset.id, role: 'screen' })
      const placed = getProject().clips[clip]
      // Where second 0 of the recording would be on the timeline, by this clip.
      starts.set(b.segment.file, placed.start - Math.round(cutFrom * fps))
      cursorFrame = placed.start + placed.duration
    }
    const origin = starts.size ? Math.min(...starts.values()) : at - Math.round(trimFrom * fps)
    for (const b of built.filter((x) => x.role !== 'screen')) {
      const from = b.segment.from
      const end = from + (b.asset.duration ?? 0)
      const cutFrom = Math.max(from, trimFrom)
      const cutTo = Math.min(end, trimTo ?? Infinity)
      if (cutTo <= cutFrom) continue
      const p = getProject().settings
      // The camera sits in the bottom right corner, a quarter of the frame's height.
      const patch = b.role === 'webcam' && b.asset.width && b.asset.height ? { transform: cornerTransform(b.asset.width, b.asset.height, p.width, p.height) } : undefined
      const clip = placeAsset(b.asset.id, Math.max(0, origin + Math.round(cutFrom * fps)), { source, overlay: b.role === 'webcam', inPoint: Math.round((cutFrom - from) * fps), duration: Math.max(1, Math.round((cutTo - cutFrom) * fps)), ...(patch ? { patch } : {}) })
      if (clip) clips.push({ id: clip, assetId: b.asset.id, role: b.role })
    }
    if (clips.length > 1) dispatch('clip.group', { ids: clips.map((c) => c.id) }, { source })
  })
  void analyzeAssets(assets.map((a) => a.id))
  return { assets, clips, clicks }
}

/** A picture scaled to 28% of the frame's height and tucked into the bottom right corner. */
function cornerTransform(mediaWidth: number, mediaHeight: number, frameWidth: number, frameHeight: number) {
  const fit = Math.min(frameWidth / mediaWidth, frameHeight / mediaHeight)
  const scale = 0.28 / ((mediaHeight * fit) / frameHeight)
  const width = mediaWidth * fit * scale
  const height = mediaHeight * fit * scale
  const margin = Math.round(frameHeight * 0.035)
  return { ...DEFAULT_TRANSFORM, scale: Math.round(scale * 1000) / 1000, x: Math.round(frameWidth / 2 - margin - width / 2), y: Math.round(frameHeight / 2 - margin - height / 2) }
}

// ─── Recordings a crash left behind ──────────────────────────────────────

/** Looks for unfinished recordings and offers to finish them. Called once when the editor starts. */
export async function offerRecovery() {
  if (!desktop) return
  const left = await desktop.capture.recoverable().catch(() => [])
  if (!left.length) return
  const total = left.reduce((n, r) => n + r.bytes, 0)
  toast(`${left.length === 1 ? 'A recording wasn’t' : `${left.length} recordings weren’t`} finished`, {
    description: `Lumen closed while recording (${(total / 1e6).toFixed(0)} MB). What was recorded can be recovered.`,
    duration: Infinity,
    action: { label: 'Recover', onClick: () => void recover(left.map((r) => r.path)) },
    cancel: { label: 'Delete', onClick: () => void Promise.all(left.map((r) => desktop!.capture.forget(r.path).catch(() => {}))) },
  })
}

async function recover(paths: string[]) {
  const busy = toast.loading('Recovering the recording', { duration: Infinity })
  let done = 0
  for (const path of paths) {
    try {
      const file = await desktop!.capture.recover(path)
      const info = await desktop!.files.urlForPath(file.path)
      if (!info) continue
      const probed = await probeMedia(info.url, info.mime)
      const asset: Asset = {
        id: uid('asset'),
        name: info.name.replace(/\.[^.]+$/, ''),
        kind: probed.kind === 'audio' ? 'audio' : 'video',
        duration: probed.duration,
        width: probed.width,
        height: probed.height,
        fps: probed.fps,
        hasAudio: probed.hasAudio,
        source: { type: 'file', url: info.url, path: info.path, mime: info.mime, fileName: info.name, size: info.size, mtime: info.mtime, poster: probed.poster },
        provenance: { integration: 'lumen', tool: 'screen-recording', params: { recovered: true } },
        tags: ['recording'],
        addedAt: Date.now(),
      }
      if (dispatch('asset.add', { asset }, { label: `Recover ${asset.name}` }).ok) done++
    } catch {
      /* this one couldn't be read; the others may be */
    }
  }
  if (done) toast.success(`Recovered ${done === 1 ? 'the recording' : `${done} recordings`}`, { id: busy, description: 'In the media library.', action: { label: 'Show', onClick: () => useUI.getState().setLeftTab('media') } })
  else toast.error('Nothing could be recovered', { id: busy, description: 'The files were too short or damaged.' })
}
