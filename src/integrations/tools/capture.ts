/**
 * Screen recording for agents: find a screen or a window, record it (picture,
 * its sound, the microphone, the camera, the pointer's clicks), and get the
 * clips on the timeline — then zoom on the clicks or highlight them. One tool
 * films a GS Cinematic Studio take from start to finish.
 *
 * Looking at the screen is the user's to allow: the first of these tools an
 * agent calls asks once, for the session.
 */
import { type CaptureAudio, type CaptureCodec, type CaptureResolution, type CaptureSettings, type CaptureSource, type Rect } from '@shared/capture'
import { highlightClicks, zoomOnClicks } from '@/capture/click-actions'
import { addMarker, isRecording, recorderBusy, refreshSources, startRecording, stopRecording, togglePause, useRecorder, type RecordingResult } from '@/capture/recorder'
import { getProject } from '@/editor/store'
import { canvasBase64, contactSheet } from '@/engine/stills'
import { requestApproval } from '@/integrations/approvals'
import { api, useIntegrations } from '@/integrations/store'
import { desktop } from '@/lib/platform'
import { bool, clampNum, clipById, int, list, num, number, obj, oneOf, str, text, toFrame, waitSeconds, withImages, type AgentTool, type ToolArgs, type ToolContext, type ToolImage } from './kit'

// ─── Asking first ────────────────────────────────────────────────────────

let allowed = false

/** Tests and the user's own "always allow" skip the question. */
export function allowAgentCapture(on: boolean) {
  allowed = on
}

/** `what` finishes the sentence "The AI wants to …". */
async function permit(what: string) {
  if (!desktop) throw new Error('Recording needs Lumen’s desktop app.')
  if (allowed) return
  const ok = await requestApproval({
    title: 'Let the AI see and record your screen?',
    detail: `${what}. If you allow it, it can list your screens and open windows (with small pictures of them) and record any of them, with sound, until you close Lumen.`,
    requester: 'The AI',
    note: 'A recording is saved on this computer and added to the project. A red dot in the title bar shows whenever one is running, and you can stop it there.',
    confirm: 'Allow for this session',
    deny: 'Don’t allow',
  })
  if (!ok) throw new Error('The user didn’t allow screen recording. Ask them before trying again.')
  allowed = true
}

// ─── Finding what to record ──────────────────────────────────────────────

const describe = (s: CaptureSource) => ({
  source: s.id,
  kind: s.kind,
  name: s.own ? 'Lumen (this editor)' : s.name,
  ...(s.width && s.height ? { size: `${s.width}x${s.height}` } : {}),
  ...(s.process ? { app: s.process } : {}),
  ...(s.primary ? { primary: true } : {}),
  ...(s.hz ? { refresh_hz: s.hz } : {}),
  ...(s.minimized ? { minimized: true } : {}),
})

/**
 * The source an agent means: an id from the list, "screen" / "screen 2", or
 * words from a window's title or its app's file name ("fivem", "chrome").
 */
export function findSource(sources: CaptureSource[], wanted: string): CaptureSource {
  const q = wanted.trim().toLowerCase()
  if (!q) throw new Error('Say what to record: a source id from list_capture_sources, “screen”, or words from a window’s title.')
  const exact = sources.find((s) => s.id === wanted.trim())
  if (exact) return exact
  const screens = sources.filter((s) => s.kind === 'screen')
  const nth = /^(?:screen|display|monitor)\s*(\d+)?$/.exec(q)
  if (nth || q === 'primary' || q === 'entire screen' || q === 'desktop') {
    const pick = nth?.[1] ? screens[Number(nth[1]) - 1] : (screens.find((s) => s.primary) ?? screens[0])
    if (!pick) throw new Error(`There is no ${wanted}. Screens: ${screens.length}.`)
    return pick
  }
  const windows = sources.filter((s) => s.kind === 'window' && !s.minimized)
  const words = q.split(/\s+/)
  const score = (s: CaptureSource) => {
    const app = (s.process ?? '').toLowerCase()
    const title = s.name.toLowerCase()
    if (!words.every((w) => app.includes(w) || title.includes(w))) return 0
    // The app's own name is a surer match than a word in a title; bigger windows before small ones.
    return (words.some((w) => app.includes(w)) ? 2 : 1) * 1e9 + (s.width ?? 0) * (s.height ?? 0)
  }
  const best = windows.map((s) => ({ s, n: score(s) })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n)[0]
  if (best) return best.s
  const hidden = sources.find((s) => s.kind === 'window' && s.minimized && words.every((w) => (s.process ?? '').toLowerCase().includes(w) || s.name.toLowerCase().includes(w)))
  if (hidden) throw new Error(`“${hidden.name}” is minimized, and a minimized window has nothing to record. Ask the user to bring it back.`)
  throw new Error(`No screen or window matches “${wanted}”. Call list_capture_sources to see what is there.`)
}

async function thumbnails(sources: CaptureSource[]): Promise<ToolImage[]> {
  const cells: { image: HTMLCanvasElement; label: string }[] = []
  for (const s of sources) {
    if (!s.thumbnail) continue
    try {
      const bitmap = await createImageBitmap(await (await fetch(s.thumbnail)).blob())
      // Every cell the same shape, so the sheet lines up.
      const canvas = document.createElement('canvas')
      canvas.width = 480
      canvas.height = 270
      const g = canvas.getContext('2d')!
      g.fillStyle = '#000'
      g.fillRect(0, 0, 480, 270)
      const k = Math.min(480 / bitmap.width, 270 / bitmap.height)
      g.drawImage(bitmap, (480 - bitmap.width * k) / 2, (270 - bitmap.height * k) / 2, bitmap.width * k, bitmap.height * k)
      bitmap.close()
      cells.push({ image: canvas, label: `${cells.length + 1} · ${(s.own ? 'Lumen' : s.name).slice(0, 38)}` })
    } catch {
      /* no picture of this one */
    }
    if (cells.length >= 12) break
  }
  return cells.length ? [{ data: canvasBase64(contactSheet(cells)), mimeType: 'image/jpeg' }] : []
}

// ─── Settings from arguments ─────────────────────────────────────────────

const RESOLUTIONS: Record<string, CaptureResolution> = { native: 'native', '4k': 2160, '2160p': 2160, '1440p': 1440, '1080p': 1080, '720p': 720 }
const CODECS: Record<string, CaptureCodec> = { h264: 'avc', avc: 'avc', hevc: 'hevc', h265: 'hevc', av1: 'av1' }

function regionArg(a: ToolArgs): Rect | null | undefined {
  const r = a.region
  if (r === null) return null
  if (!r || typeof r !== 'object') return undefined
  const { x, y, width, height } = r as Record<string, unknown>
  if (![x, y, width, height].every((v) => typeof v === 'number' && Number.isFinite(v))) throw new Error('A region is { x, y, width, height } in the source’s pixels.')
  return { x: x as number, y: y as number, width: width as number, height: height as number }
}

/** A microphone or camera by name: true takes the first there is, words pick one by its label. */
async function device(kind: 'audioinput' | 'videoinput', wanted: unknown): Promise<string | null | undefined> {
  if (wanted === undefined) return undefined
  if (wanted === false || wanted === null) return null
  const all = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
  const what = kind === 'audioinput' ? 'microphone' : 'camera'
  if (!all.length) throw new Error(`This computer has no ${what}.`)
  if (wanted === true) return all[0].deviceId
  const q = String(wanted).toLowerCase()
  const found = all.find((d) => d.deviceId === wanted || d.label.toLowerCase().includes(q))
  if (!found) throw new Error(`No ${what} matches “${String(wanted)}”. There ${all.length === 1 ? 'is' : 'are'}: ${all.map((d) => d.label).join('; ')}.`)
  return found.deviceId
}

async function settingsFrom(a: ToolArgs, source: CaptureSource): Promise<Partial<CaptureSettings>> {
  const out: Partial<CaptureSettings> = { sourceId: source.id }
  const region = regionArg(a)
  out.region = region ?? null
  const resolution = text(a, 'resolution')?.toLowerCase()
  if (resolution) {
    if (!(resolution in RESOLUTIONS)) throw new Error(`resolution is one of: ${Object.keys(RESOLUTIONS).join(', ')}.`)
    out.resolution = RESOLUTIONS[resolution]
  }
  const fps = number(a, 'fps')
  if (fps !== undefined) out.fps = Math.round(clampNum(fps, 5, 60))
  const codec = text(a, 'codec')?.toLowerCase()
  if (codec) {
    if (!(codec in CODECS)) throw new Error('codec is h264, hevc or av1.')
    out.codec = CODECS[codec]
  }
  if (typeof a.hardware === 'boolean') out.hardware = a.hardware
  const mbps = number(a, 'bitrate_mbps')
  const quality = number(a, 'quality')
  if (mbps !== undefined) out.rate = { mode: 'bitrate', mbps: clampNum(mbps, 0.5, 400) }
  else if (quality !== undefined) out.rate = { mode: 'quality', quality: clampNum(quality, 10, 100) }
  const key = number(a, 'keyframe_seconds')
  if (key !== undefined) out.keyframeSeconds = clampNum(key, 0.5, 10)
  const audio = text(a, 'audio')
  if (audio) {
    if (!['off', 'system', 'app'].includes(audio)) throw new Error('audio is off, system (everything the computer plays) or app (only the recorded window’s app).')
    out.audio = audio as CaptureAudio
  }
  const mic = await device('audioinput', a.microphone)
  if (mic !== undefined) out.mic = mic
  const cam = await device('videoinput', a.camera)
  if (cam !== undefined) out.webcam = cam
  if (typeof a.cursor === 'boolean') out.cursor = a.cursor
  if (typeof a.click_data === 'boolean') out.cursorData = a.click_data
  // An agent starts at once unless it asks for a countdown.
  out.countdown = Math.round(clampNum(number(a, 'countdown_seconds') ?? 0, 0, 30))
  if (typeof a.hide_lumen === 'boolean') out.hideLumen = a.hide_lumen
  if (typeof a.minimize_lumen === 'boolean') out.minimize = a.minimize_lumen
  return out
}

// ─── What a tool says back ───────────────────────────────────────────────

function status() {
  const { phase, stats, markers, notes, name, ready, error } = useRecorder.getState()
  return {
    recording: phase === 'recording' || phase === 'paused',
    phase,
    ...(name && phase !== 'idle' ? { name } : {}),
    seconds: Math.round(stats.seconds * 10) / 10,
    frames: stats.frames,
    source_fps: stats.sourceFps,
    frames_skipped: stats.dropped,
    megabytes: Math.round(stats.bytes / 1e5) / 10,
    ...(ready ? { picture: `${ready.width}x${ready.height}`, encoder: ready.encoder } : {}),
    ...(markers.length ? { markers } : {}),
    ...(notes.length ? { notes } : {}),
    ...(error && phase === 'idle' ? { last_error: error } : {}),
  }
}

function report(r: RecordingResult) {
  const fps = getProject().settings.fps
  const clips = getProject().clips
  return {
    name: r.name,
    seconds: Math.round(r.seconds * 100) / 100,
    files: r.files.map((f) => ({
      what: f.role === 'screen' ? 'the recording' : f.role === 'webcam' ? 'the camera' : 'the microphone',
      path: f.path,
      megabytes: Math.round(f.bytes / 1e5) / 10,
      seconds: Math.round(f.seconds * 100) / 100,
      ...(f.width && f.height ? { size: `${f.width}x${f.height}`, fps: f.fps, frames: f.frames, encoder: f.encoder } : {}),
      ...(f.role === 'screen' ? { has_sound: Boolean(f.hasAudio) } : {}),
    })),
    media: r.assets.map((a) => ({ asset_id: a.id, what: a.role, name: a.name, seconds: Math.round(a.seconds * 100) / 100 })),
    clips: r.clips.map((c) => ({ clip_id: c.id, asset_id: c.assetId, what: c.role, at_seconds: Math.round((clips[c.id]?.start ?? 0) / fps * 100) / 100, seconds: Math.round((clips[c.id]?.duration ?? 0) / fps * 100) / 100 })),
    ...(r.markers.length ? { markers: r.markers } : {}),
    clicks: r.clicks,
    ...(r.notes.length ? { notes: r.notes } : {}),
    ...(r.clicks ? { next: 'zoom_on_clicks and highlight_clicks use the click data on the recording’s clip.' } : {}),
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true })
  })

// ─── GS Cinematic Studio ─────────────────────────────────────────────────

interface StudioTake {
  ok?: boolean
  status?: string
  job_id?: string
  started_at_unix_ms?: number
  ended_at_unix_ms?: number
  duration_seconds?: number
  frames?: number
  fps?: number
  cues?: unknown
  scene?: { id?: string; name?: string }
  error?: string
  [key: string]: unknown
}

/** The game's own window: the one drawing GTA, not FiveM's launcher or its tools. */
export function gameWindow(sources: CaptureSource[], wanted?: string): CaptureSource {
  if (wanted) return findSource(sources, wanted)
  for (const q of ['gtaprocess', 'fivem', 'redm', 'gta5', 'grand theft auto']) {
    try {
      return findSource(sources, q)
    } catch {
      /* the next name */
    }
  }
  throw new Error('The game’s window wasn’t found. Start the game (windowed or borderless), or say which window with `window`: list_capture_sources shows them.')
}

/** A connected MCP server that has the studio's take tool. */
function studio(serverId?: string) {
  const servers = Object.values(useIntegrations.getState().servers).filter((s) => s.status === 'connected' && s.tools.some((t) => t.name === 'film_take'))
  const found = serverId ? servers.find((s) => s.config.id === serverId || s.config.name === serverId) : servers[0]
  if (!found) throw new Error('GS Cinematic Studio isn’t connected, or its version has no film_take tool yet. Connect it in Integrations, with a director’s game under remote control.')
  return found
}

async function callStudio(serverId: string, tool: string, args: Record<string, unknown>): Promise<StudioTake> {
  if (!api) throw new Error('MCP tools need the desktop app.')
  const r = await api.mcp.callForAgent(serverId, tool, args)
  if (r.isError) throw new Error(r.text.join('\n') || 'The studio reported an error.')
  if (r.structured && typeof r.structured === 'object') return r.structured as StudioTake
  try {
    return JSON.parse(r.text.join('\n')) as StudioTake
  } catch {
    return { ok: false, error: r.text.join('\n') }
  }
}

export const CAPTURE_TOOLS: AgentTool[] = [
  {
    name: 'list_capture_sources',
    description:
      'What can be recorded on this computer: every screen and every open window, with its id, size and the app it belongs to — and one picture of them all, numbered in the same order. Call it to find the window to record (a game, a browser, an app) before start_recording. The first call asks the user to allow screen recording for this session.',
    inputSchema: obj({ kind: oneOf('Only screens, or only windows', ['screen', 'window']), query: str('Only windows whose title or app name contains this'), pictures: bool('Include the picture (default true)') }),
    run: async (a) => {
      await permit('see what can be recorded')
      const all = await refreshSources(a.pictures !== false)
      const kind = text(a, 'kind')
      const q = text(a, 'query')?.toLowerCase()
      const shown = all.filter((s) => (!kind || s.kind === kind) && (!q || s.name.toLowerCase().includes(q) || (s.process ?? '').toLowerCase().includes(q)))
      const json = { sources: shown.map(describe), helper: useRecorder.getState().helper, recording: status().recording }
      const images = a.pictures === false ? [] : await thumbnails(shown)
      return images.length ? withImages(json, images) : json
    },
  },
  {
    name: 'start_recording',
    description:
      'Start recording a screen or a window into the project: picture at up to 4K and 60 fps on the graphics card’s encoder (the processor’s if there is none that works), with the sound of the whole computer or of just that window’s app, and optionally the microphone and the camera as clips of their own. Returns once it is rolling, with the real picture size and the encoder in use. Then do whatever should be filmed, and call stop_recording. `source` is an id from list_capture_sources, “screen”, or words from a window’s title or app (“fivem”, “chrome”). A resolution above the source’s scales the picture up; `region` records part of it. Set max_seconds for a recording that ends by itself.',
    inputSchema: obj(
      {
        source: str('What to record: a source id, “screen”, “screen 2”, or words from a window’s title or app name'),
        region: obj({ x: num('Left'), y: num('Top'), width: num('Width'), height: num('Height') }, ['x', 'y', 'width', 'height']),
        resolution: oneOf('The picture’s size by its short side (default native; 4k scales a smaller source up)', Object.keys(RESOLUTIONS)),
        fps: num('Frames a second, 5–60 (default 60)', { minimum: 5, maximum: 60 }),
        codec: oneOf('Video codec (default h264; another is used if this computer can’t encode it at this size)', ['h264', 'hevc', 'av1']),
        hardware: bool('Encode on the graphics card (default true)'),
        quality: num('10–100 (default 60): the bitrate is worked out from it', { minimum: 10, maximum: 100 }),
        bitrate_mbps: num('Or an exact video bitrate in megabits a second', { minimum: 0.5, maximum: 400 }),
        keyframe_seconds: num('A key frame at least this often (default 2)', { minimum: 0.5, maximum: 10 }),
        audio: oneOf('The recording’s own sound: off, system (everything the computer plays) or app (only the recorded window’s app — windows only)', ['off', 'system', 'app']),
        microphone: { description: 'true for the first microphone, or words from one’s name; false for none', type: ['boolean', 'string'] },
        camera: { description: 'true for the first camera, or words from one’s name; false for none', type: ['boolean', 'string'] },
        cursor: bool('The mouse pointer is in the picture (default true; false for games and films)'),
        click_data: bool('Keep the pointer’s clicks as data for zoom_on_clicks and highlight_clicks (default true)'),
        countdown_seconds: int('Seconds counted down first (default 0)', { minimum: 0, maximum: 30 }),
        max_seconds: num('Stop by itself after this long', { minimum: 1 }),
        name: str('A name for the recording'),
        hide_lumen: bool('Keep Lumen’s own window out of a screen recording (default true)'),
        minimize_lumen: bool('Minimize Lumen while recording'),
      },
      ['source'],
    ),
    run: async (a) => {
      await permit(`record “${text(a, 'source') ?? 'the screen'}”`)
      if (recorderBusy()) throw new Error('A recording is already running. Call stop_recording first (or recording_status to see it).')
      const source = findSource(await refreshSources(false), text(a, 'source') ?? '')
      const started = await startRecording({ settings: await settingsFrom(a, source), name: text(a, 'name'), maxSeconds: number(a, 'max_seconds'), by: 'ai' })
      const r = started.ready
      return {
        recording: started.name,
        source: describe(source),
        ...(r ? { picture: `${r.width}x${r.height}`, from: `${r.srcWidth}x${r.srcHeight}`, fps: useRecorder.getState().settings.fps, encoder: r.encoder, megabits: Math.round(r.bitrate / 1e5) / 10 } : {}),
        sound: useRecorder.getState().settings.audio,
        started_at_unix_ms: Date.now(),
        ...(started.notes.length ? { notes: started.notes } : {}),
        next: 'Do what should be recorded, then call stop_recording.',
      }
    },
  },
  {
    name: 'recording_status',
    description: 'Whether a recording is running and how it is going: seconds so far, frames, how many frames a second the source is sending, frames skipped, size, and anything worth knowing that happened. With wait_seconds it waits that long, or until the recording ends.',
    inputSchema: obj({ wait_seconds: num('Wait this long (or until it ends) before answering', { minimum: 0, maximum: 600 }) }),
    run: async (a, ctx) => {
      const wait = number(a, 'wait_seconds') ? waitSeconds(a, ctx, 0) : 0
      const until = performance.now() + wait * 1000
      while (performance.now() < until && recorderBusy() && !ctx?.signal?.aborted) {
        ctx?.progress?.(`Recording · ${Math.round(useRecorder.getState().stats.seconds)} s`)
        await sleep(Math.min(500, until - performance.now()), ctx?.signal)
      }
      return status()
    },
  },
  {
    name: 'pause_recording',
    description: 'Pause the running recording, or carry on with it. Paused time isn’t in the file.',
    inputSchema: obj({ paused: bool('true to pause, false to carry on (default: the other of what it is now)') }),
    run: async (a) => {
      if (!isRecording()) throw new Error('No recording is running.')
      const paused = useRecorder.getState().phase === 'paused'
      if (typeof a.paused !== 'boolean' || a.paused !== paused) togglePause()
      return status()
    },
  },
  {
    name: 'add_recording_marker',
    description: 'Mark this moment of the running recording. Markers come out as cues on the recording’s clip (and get_clip gives them at timeline seconds), so the edit can find the moments that mattered.',
    inputSchema: obj({ label: str('What happens here') }),
    run: async (a) => {
      const marker = addMarker(text(a, 'label'))
      if (!marker) throw new Error('No recording is running.')
      return { marker, markers: useRecorder.getState().markers.length }
    },
  },
  {
    name: 'stop_recording',
    description:
      'Stop the recording, finish its files and add them to the project: the recording on the timeline at the playhead (or at_seconds) with the camera in the corner above it and the microphone on a voice track beneath, all lined up — or only in the media library with place: "library". To keep only part of it on the timeline (the media keeps everything), give trim_start_seconds / trim_end_seconds from the recording’s start, or the same moments as Unix times. `cues` attaches a cue sheet to the clip. Returns the files, media and clips.',
    inputSchema: obj({
      place: oneOf('Where the clips go (default timeline)', ['timeline', 'library', 'none']),
      at_seconds: num('Timeline position for the clips (default: the playhead)', { minimum: 0 }),
      trim_start_seconds: num('Use the recording from this many seconds in', { minimum: 0 }),
      trim_end_seconds: num('…up to this many seconds in', { minimum: 0 }),
      trim_from_unix_ms: num('Use the recording from this moment (Unix milliseconds)'),
      trim_to_unix_ms: num('…up to this moment (Unix milliseconds)'),
      cues: list('What happens in the picture and when: { at (seconds from the trimmed start), kind, label… }', { type: 'object' }),
      discard: bool('Throw the recording away instead'),
    }),
    run: async (a, ctx) => {
      if (useRecorder.getState().phase === 'idle') throw new Error('No recording is running.')
      ctx?.progress?.('Finishing the recording…')
      const place = text(a, 'place') as 'timeline' | 'library' | 'none' | undefined
      const at = number(a, 'at_seconds')
      const result = await stopRecording({
        ...(place ? { place } : {}),
        ...(at !== undefined ? { atFrame: toFrame(at) } : {}),
        trimFromSeconds: number(a, 'trim_start_seconds'),
        trimToSeconds: number(a, 'trim_end_seconds'),
        trimFromUnixMs: number(a, 'trim_from_unix_ms'),
        trimToUnixMs: number(a, 'trim_to_unix_ms'),
        cues: a.cues,
        discard: a.discard === true,
        source: 'ai',
      })
      return result ? report(result) : { discarded: true }
    },
  },
  {
    name: 'zoom_on_clicks',
    description:
      'Zoom a screen recording in on where the pointer clicked: it pushes in just before each click, stays while the clicking goes on there (panning between clicks close together) and eases back out. Uses the click data the recording kept; the zooms are ordinary scale and position keyframes, so they can be changed or removed after. Replaces the clip’s own size and position animation. clear: true only takes the zooms off.',
    inputSchema: obj(
      {
        clip_id: str('The recording’s clip on the timeline'),
        zoom: num('How far in: 2 shows half the picture’s width (default 2)', { minimum: 1.1, maximum: 6 }),
        hold_seconds: num('How long it stays after the last click (default 1.6)', { minimum: 0.2, maximum: 15 }),
        lead_seconds: num('How long the push-in takes (default 0.45)', { minimum: 0.1, maximum: 3 }),
        group_seconds: num('Clicks this close together share one zoom (default 2.5)', { minimum: 0, maximum: 30 }),
        right_clicks: bool('Zoom on right clicks too'),
        clear: bool('Remove the zooms instead'),
      },
      ['clip_id'],
    ),
    run: async (a) => {
      const clip = clipById(String(a.clip_id))
      return zoomOnClicks(
        clip.id,
        { zoom: number(a, 'zoom'), hold: number(a, 'hold_seconds'), lead: number(a, 'lead_seconds'), group: number(a, 'group_seconds'), ...(a.right_clicks === true ? { buttons: ['left', 'right'] as const } : {}), clear: a.clear === true } as Parameters<typeof zoomOnClicks>[1],
        'ai',
      )
    },
  },
  {
    name: 'highlight_clicks',
    description: 'Draw a pulse where each click landed in a screen recording: a dot that grows and fades, as short title clips on a track of their own above it (so each can be moved or deleted). It follows the clip’s zooms, so call zoom_on_clicks first.',
    inputSchema: obj(
      {
        clip_id: str('The recording’s clip on the timeline'),
        color: str('Hex colour (default #ffd400)'),
        size: num('Largest size as a fraction of the frame’s height (default 0.09)', { minimum: 0.02, maximum: 0.4 }),
        seconds: num('How long each pulse lasts (default 0.5)', { minimum: 0.1, maximum: 3 }),
        right_clicks: bool('Right clicks too'),
      },
      ['clip_id'],
    ),
    run: async (a) => {
      const clip = clipById(String(a.clip_id))
      const color = text(a, 'color')
      if (color && !/^#[0-9a-f]{6}$/i.test(color)) throw new Error('color is a hex colour like #ffd400.')
      return highlightClicks(clip.id, { color, size: number(a, 'size'), seconds: number(a, 'seconds'), ...(a.right_clicks === true ? { buttons: ['left', 'right'] } : {}) }, 'ai')
    },
  },
  {
    name: 'record_studio_take',
    description:
      'Film a take of the open GS Cinematic Studio scene in real time and put it on the timeline: finds the game’s window, starts recording it (picture and only the game’s sound, no pointer), tells the studio to play the take cleanly (film_take: every panel and overlay hidden, a held first and last frame), stops, and trims the clip to exactly the take with the studio’s cue sheet attached. Needs the studio connected in Integrations with a director’s game under remote control, on this computer, with the game in a window or borderless. Use it for takes that should move and sound as the game does; render_export with ingest_start stays the frame-exact (silent, slower) way.',
    inputSchema: obj({
      target: oneOf('What to film (default the whole active scene)', ['scene', 'shot', 'range']),
      path_id: str('The shot, for target: shot (default the active shot)'),
      from_frame: int('First frame, for target: range', { minimum: 0 }),
      to_frame: int('Last frame, for target: range', { minimum: 0 }),
      window: str('Words from the game window’s title or app name (default: fivem)'),
      resolution: oneOf('The picture’s size (default native)', Object.keys(RESOLUTIONS)),
      fps: num('Frames a second (default 60)', { minimum: 5, maximum: 60 }),
      codec: oneOf('Video codec (default h264)', ['h264', 'hevc', 'av1']),
      quality: num('10–100 (default 80)', { minimum: 10, maximum: 100 }),
      audio: oneOf('The take’s sound (default app: only the game)', ['off', 'system', 'app']),
      preroll_seconds: num('Held first frame before the take plays (default 1)', { minimum: 0, maximum: 10 }),
      postroll_seconds: num('Held last frame after it (default 0.5)', { minimum: 0, maximum: 10 }),
      at_seconds: num('Timeline position for the clip (default: the playhead)', { minimum: 0 }),
      place: oneOf('Where the clip goes (default timeline)', ['timeline', 'library']),
      name: str('A name for the take'),
      server: str('Which connected studio, by name, when there are several'),
    }),
    run: (a, ctx) => recordStudioTake(a, ctx),
  },
]

/** One take, start to finish. A take that fails stops the recording and throws it away. */
export async function recordStudioTake(a: ToolArgs, ctx?: ToolContext) {
  const server = studio(text(a, 'server'))
  await permit('film a take of the game for GS Cinematic Studio')
  if (recorderBusy()) throw new Error('A recording is already running. Call stop_recording first.')
  const source = gameWindow(await refreshSources(false), text(a, 'window'))
  if (source.kind !== 'window') throw new Error('The game has to be a window: set it to windowed or borderless in its settings.')
  ctx?.progress?.('Starting the recorder…')
  const settings = await settingsFrom({ ...a, cursor: false, click_data: false, audio: text(a, 'audio') ?? 'app', quality: number(a, 'quality') ?? 80, countdown_seconds: 0 }, source)
  const started = await startRecording({ settings: { ...settings, hideLumen: false, minimize: false }, name: text(a, 'name') ?? `Take ${new Date().toLocaleTimeString([], { hour12: false }).replace(/:/g, '.')}`, by: 'ai' })
  try {
    // A game plays (and is heard) only while it is the active window.
    const front = await desktop!.capture.focus(source.hwnd).catch(() => false)
    ctx?.progress?.('Filming the take…')
    const args: Record<string, unknown> = { wait_seconds: 50 }
    for (const key of ['target', 'path_id', 'from_frame', 'to_frame', 'preroll_seconds', 'postroll_seconds']) if (a[key] !== undefined && a[key] !== null) args[key] = a[key]
    let take = await callStudio(server.config.id, 'film_take', args)
    // A long take answers "still running": ask until it is done.
    for (let i = 0; i < 400 && take.job_id && take.status && !['done', 'finished', 'completed', 'failed', 'error', 'cancelled'].includes(take.status); i++) {
      if (ctx?.signal?.aborted) {
        await callStudio(server.config.id, 'cancel_job', { job_id: take.job_id }).catch(() => {})
        throw new Error('Stopped.')
      }
      ctx?.progress?.(`Filming the take · ${Math.round(useRecorder.getState().stats.seconds)} s`)
      take = { ...take, ...(await callStudio(server.config.id, 'job_status', { job_id: take.job_id, wait_seconds: 20 })) }
    }
    const result = (take.result && typeof take.result === 'object' ? (take.result as StudioTake) : take) as StudioTake
    if (take.error || result.error || take.status === 'failed' || take.status === 'cancelled') throw new Error(`The studio didn’t finish the take: ${String(take.error ?? result.error ?? take.status)}`)
    if (typeof result.started_at_unix_ms !== 'number' || typeof result.ended_at_unix_ms !== 'number') throw new Error('The studio didn’t say when the take started and ended, so it can’t be trimmed. The recording was thrown away.')
    ctx?.progress?.('Finishing the recording…')
    void desktop!.capture.focus().catch(() => {})
    const at = number(a, 'at_seconds')
    const done = await stopRecording({
      place: (text(a, 'place') as 'timeline' | 'library' | undefined) ?? 'timeline',
      ...(at !== undefined ? { atFrame: toFrame(at) } : {}),
      trimFromUnixMs: result.started_at_unix_ms,
      trimToUnixMs: result.ended_at_unix_ms,
      cues: result.cues,
      source: 'ai',
    })
    if (!done) throw new Error('The recording was stopped before it began.')
    return {
      take: { scene: result.scene, seconds: result.duration_seconds, frames: result.frames, timeline_fps: result.fps, cues: Array.isArray(result.cues) ? result.cues.length : 0 },
      picture: started.ready ? `${started.ready.width}x${started.ready.height}` : undefined,
      encoder: started.ready?.encoder,
      ...(front ? {} : { game_window: 'Lumen couldn’t bring the game to the front. If the take is frozen or silent, turn off “Pause game on focus loss” in the game’s settings, or click the game before filming.' }),
      ...report(done),
    }
  } catch (err) {
    void desktop!.capture.focus().catch(() => {})
    if (recorderBusy()) await stopRecording({ discard: true }).catch(() => {})
    throw err
  }
}
