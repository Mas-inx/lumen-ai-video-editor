import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, powerSaveBlocker, screen, session, type DesktopCapturerSource } from 'electron'
import { ALL_FORMATS, Conversion, FilePathSource, FilePathTarget, Input, Mp4OutputFormat, Output } from 'mediabunny'
import {
  CAPTURE_HOTKEYS,
  CAPTURE_IPC,
  cleanRecordingName,
  type AppAudioFormat,
  type CaptureFolderState,
  type CaptureHelperState,
  type CaptureHotkey,
  type CaptureSessionState,
  type CaptureSource,
  type CursorEvent,
  type Rect,
  type RecoverableRecording,
} from '../shared/capture'
import { abortExport, beginFile, finishExport } from './export'
import { ensureDir, userDir } from './integrations/paths'

/**
 * Screen recording, the main process's half: which screens and windows there
 * are, handing Chromium's capture the one that was picked, the recordings'
 * files, the keys that work while another app is in front, and the helper
 * that hears one app and watches the cursor (native/capture-helper).
 *
 * The picture and its encoding live in the editor (src/capture).
 */

// ─── Where recordings go ─────────────────────────────────────────────────

const settingsFile = () => path.join(userDir(), 'capture.json')
const defaultFolder = () => path.join(app.getPath('videos'), 'Lumen Recordings')

function readSettings(): { folder?: string } {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) as { folder?: unknown }
    return typeof raw.folder === 'string' && raw.folder ? { folder: raw.folder } : {}
  } catch {
    return {}
  }
}

function writeSettings(s: { folder?: string }) {
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2))
  } catch {
    /* the default is used next time */
  }
}

/** The recordings folder, made if it isn't there. A chosen folder that has gone (an unplugged drive) falls back to the default. */
function folder() {
  const chosen = readSettings().folder
  if (chosen) {
    try {
      return ensureDir(chosen)
    } catch {
      /* fall through */
    }
  }
  return ensureDir(defaultFolder())
}

export function captureFolder(): CaptureFolderState {
  const dir = folder()
  return { folder: dir, isDefault: path.resolve(dir) === path.resolve(defaultFolder()) }
}

export async function pickCaptureFolder(win: BrowserWindow | null): Promise<CaptureFolderState> {
  const opts: Electron.OpenDialogOptions = { title: 'Where recordings are saved', buttonLabel: 'Save recordings here', defaultPath: folder(), properties: ['openDirectory', 'createDirectory'] }
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  if (!res.canceled && res.filePaths[0]) writeSettings({ folder: res.filePaths[0] })
  return captureFolder()
}

export function resetCaptureFolder(): CaptureFolderState {
  writeSettings({})
  return captureFolder()
}

export async function captureFree(): Promise<number | null> {
  try {
    const s = await fs.promises.statfs(folder())
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return null
  }
}

// ─── The helper ──────────────────────────────────────────────────────────

const HELPER = 'lumen-capture-helper.exe'

function helperPath(): string | null {
  if (process.platform !== 'win32') return null
  const file = app.isPackaged ? path.join(process.resourcesPath, 'bin', HELPER) : path.join(app.getAppPath(), 'native', 'bin', HELPER)
  return fs.existsSync(file) ? file : null
}

/** Runs the helper for one answer. */
function ask<T>(args: string[], timeout = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const file = helperPath()
    if (!file) return reject(new Error('The capture helper isn’t installed.'))
    execFile(file, args, { timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error(helperError(String(stderr)) ?? err.message))
      try {
        resolve(JSON.parse(String(stdout)) as T)
      } catch {
        reject(new Error('The capture helper answered with something unreadable.'))
      }
    })
  })
}

/** The helper says what went wrong as a line of JSON on its error stream. */
function helperError(stderr: string): string | undefined {
  for (const line of stderr.split(/\r?\n/).reverse()) {
    try {
      const said = JSON.parse(line) as { error?: unknown }
      if (typeof said.error === 'string') return said.error
    } catch {
      /* not that line */
    }
  }
  return undefined
}

let helper: Promise<CaptureHelperState> | null = null

export function helperState(): Promise<CaptureHelperState> {
  helper ??= (async (): Promise<CaptureHelperState> => {
    if (process.platform !== 'win32') return { available: false, appAudio: false, cursor: true, reason: 'One app’s sound and click data are recorded on Windows only.' }
    if (!helperPath()) return { available: false, appAudio: false, cursor: true, reason: 'The capture helper is missing from this build, so one app’s sound and clicks can’t be recorded.' }
    try {
      const v = await ask<{ processLoopback?: boolean }>(['version'])
      return { available: true, appAudio: v.processLoopback === true, cursor: true, ...(v.processLoopback ? {} : { reason: 'Recording one app’s sound needs Windows 11, or Windows 10 build 20348 or later.' }) }
    } catch (err) {
      return { available: false, appAudio: false, cursor: true, reason: `The capture helper didn’t start (${err instanceof Error ? err.message : String(err)}).` }
    }
  })()
  return helper
}

interface HelperWindow {
  hwnd: number
  pid: number
  process: string
  title: string
  rect: Rect
  client: Rect
  minimized: boolean
}

async function helperWindows(): Promise<Map<number, HelperWindow>> {
  const out = new Map<number, HelperWindow>()
  if (!helperPath()) return out
  try {
    for (const w of await ask<HelperWindow[]>(['windows'])) out.set(w.hwnd, w)
  } catch {
    /* the list still works without it */
  }
  return out
}

export async function windowInfo(hwnd: number): Promise<Pick<CaptureSource, 'hwnd' | 'pid' | 'process' | 'bounds' | 'minimized'> | null> {
  if (!Number.isFinite(hwnd) || !helperPath()) return null
  try {
    const w = await ask<HelperWindow>(['window', '--hwnd', String(Math.trunc(hwnd))])
    return { hwnd: w.hwnd, pid: w.pid, process: w.process, bounds: w.rect, minimized: w.minimized }
  } catch {
    return null
  }
}

/** Brings another app's window to the front, or Lumen itself when no window is named. */
export async function focusWindow(win: BrowserWindow | null, hwnd?: number): Promise<boolean> {
  if (hwnd === undefined || !Number.isFinite(hwnd)) {
    if (!win || win.isDestroyed()) return false
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    return win.isFocused()
  }
  if (!helperPath()) return false
  try {
    return (await ask<{ focused?: boolean }>(['focus', '--hwnd', String(Math.trunc(hwnd))])).focused === true
  } catch {
    return false
  }
}

// ─── What can be recorded ────────────────────────────────────────────────

const hwndOf = (id: string) => (id.startsWith('window:') ? Number(id.split(':')[1]) : NaN)

/** A display's place on the desktop in pixels. */
function displayPixels(d: Electron.Display): Rect {
  if (process.platform === 'win32') {
    const r = screen.dipToScreenRect(null, d.bounds)
    return { x: r.x, y: r.y, width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) }
  }
  return { x: Math.round(d.bounds.x * d.scaleFactor), y: Math.round(d.bounds.y * d.scaleFactor), width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) }
}

/** Chromium's sources as last listed: what `arm` picks from. */
let listed = new Map<string, DesktopCapturerSource>()

export async function listSources(opts: { thumbnails?: boolean; icons?: boolean } = {}): Promise<CaptureSource[]> {
  const [found, windows] = await Promise.all([
    desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: opts.thumbnails ? { width: 480, height: 300 } : { width: 0, height: 0 }, fetchWindowIcons: opts.icons === true }),
    helperWindows(),
  ])
  listed = new Map(found.map((s) => [s.id, s]))
  const displays = screen.getAllDisplays()
  const primary = screen.getPrimaryDisplay().id
  const own = new Set(BrowserWindow.getAllWindows().map((w) => hwndOf(w.getMediaSourceId())))
  const picture = (s: DesktopCapturerSource) => (opts.thumbnails && !s.thumbnail.isEmpty() ? { thumbnail: `data:image/jpeg;base64,${s.thumbnail.toJPEG(78).toString('base64')}` } : {})
  const out: CaptureSource[] = []
  let screens = 0
  for (const s of found) {
    if (s.id.startsWith('screen:')) {
      screens++
      // One screen has no display id on some systems: it is the only display there is.
      const d = displays.find((x) => String(x.id) === s.display_id) ?? (displays.length === 1 ? displays[0] : undefined)
      const bounds = d ? displayPixels(d) : undefined
      out.push({
        id: s.id,
        kind: 'screen',
        name: found.filter((x) => x.id.startsWith('screen:')).length > 1 ? `Screen ${screens}` : 'Entire screen',
        ...(bounds ? { width: bounds.width, height: bounds.height, bounds } : {}),
        ...(d ? { scale: d.scaleFactor, primary: d.id === primary, hz: Math.round(d.displayFrequency) || undefined } : {}),
        ...picture(s),
      })
    } else {
      const hwnd = hwndOf(s.id)
      const w = windows.get(hwnd)
      out.push({
        id: s.id,
        kind: 'window',
        name: s.name,
        hwnd,
        ...(w ? { pid: w.pid, process: w.process, width: w.rect.width, height: w.rect.height, bounds: w.rect, minimized: w.minimized } : {}),
        ...(own.has(hwnd) ? { own: true } : {}),
        ...picture(s),
        ...(opts.icons && s.appIcon && !s.appIcon.isEmpty() ? { icon: s.appIcon.resize({ height: 32 }).toDataURL() } : {}),
      })
    }
  }
  return out
}

// ─── Handing Chromium the source ─────────────────────────────────────────

let armed: { source: DesktopCapturerSource; audio: boolean; at: number } | null = null

/** The next capture request from the editor gets this source. Good for one request, for ten seconds. */
export async function arm(sourceId: string, systemAudio: boolean) {
  let source = listed.get(sourceId)
  if (!source) {
    await listSources()
    source = listed.get(sourceId)
  }
  if (!source) throw new Error('That screen or window isn’t there any more. Pick it again.')
  armed = { source, audio: systemAudio, at: Date.now() }
}

// ─── Streams from the helper ─────────────────────────────────────────────

interface Stream {
  stop(reason?: string): void
}

const streams = new Map<string, Stream>()
let editor: BrowserWindow | null = null

const toEditor = (channel: string, ...args: unknown[]) => {
  if (editor && !editor.isDestroyed()) editor.webContents.send(channel, ...args)
}

function endStream(key: string, reason: string) {
  if (!streams.delete(key)) return
  toEditor(CAPTURE_IPC.streamEnded, key, reason)
}

/** Asks a helper to stop, and makes sure it has. */
function quit(child: ChildProcessWithoutNullStreams) {
  try {
    child.stdin.end('stop\n')
  } catch {
    /* already gone */
  }
  const timer = setTimeout(() => child.kill(), 1200)
  child.once('exit', () => clearTimeout(timer))
}

/** One sound frame: two channels of 32-bit samples. */
const FRAME_BYTES = 8

export function startAppAudio(key: string, target: { hwnd?: number; pid?: number }): Promise<AppAudioFormat> {
  return new Promise((resolve, reject) => {
    const file = helperPath()
    if (!file) return reject(new Error('The capture helper isn’t installed, so one app’s sound can’t be recorded.'))
    const who = Number.isFinite(target.pid) ? ['--pid', String(Math.trunc(target.pid!))] : Number.isFinite(target.hwnd) ? ['--hwnd', String(Math.trunc(target.hwnd!))] : null
    if (!who) return reject(new Error('Pick a window to record its sound.'))
    streams.get(key)?.stop()
    const child = spawn(file, ['audio', ...who], { windowsHide: true })
    let header: Buffer | null = Buffer.alloc(0)
    let pending: Buffer[] = []
    let carry = Buffer.alloc(0)
    let errors = ''
    let settled = false
    // A few sends a second, each a whole number of frames.
    const flush = () => {
      if (!pending.length) return
      const all = Buffer.concat(carry.length ? [carry, ...pending] : pending)
      pending = []
      const whole = all.length - (all.length % FRAME_BYTES)
      carry = whole < all.length ? Buffer.from(all.subarray(whole)) : Buffer.alloc(0)
      if (whole) toEditor(CAPTURE_IPC.audioChunk, key, new Uint8Array(all.buffer, all.byteOffset, whole))
    }
    const timer = setInterval(flush, 40)
    child.stdout.on('data', (data: Buffer) => {
      if (header) {
        header = Buffer.concat([header, data])
        const end = header.indexOf(10)
        if (end < 0) return
        const line = header.subarray(0, end).toString('utf8')
        const rest = header.subarray(end + 1)
        header = null
        try {
          const format = JSON.parse(line) as AppAudioFormat
          settled = true
          resolve(format)
        } catch {
          settled = true
          reject(new Error('The capture helper answered with something unreadable.'))
          return quit(child)
        }
        if (rest.length) pending.push(Buffer.from(rest))
      } else pending.push(data)
    })
    child.stderr.on('data', (data: Buffer) => (errors = (errors + data.toString('utf8')).slice(-4000)))
    child.on('error', (err) => {
      if (!settled) reject(new Error(`The capture helper didn’t start (${err.message}).`))
      settled = true
    })
    child.on('exit', () => {
      clearInterval(timer)
      flush()
      const said = helperError(errors)
      if (!settled) reject(new Error(said ?? 'This app’s sound couldn’t be recorded.'))
      settled = true
      endStream(key, said ?? (/process-exited/.test(errors) ? 'The app closed.' : 'ended'))
    })
    streams.set(key, { stop: () => quit(child) })
  })
}

/** The helper's cursor stream; without the helper, positions only (no clicks) from Electron. */
export function startCursor(key: string, target: { hwnd?: number; hz?: number }) {
  streams.get(key)?.stop()
  const hz = Math.min(240, Math.max(30, Math.round(Number(target.hz) || 120)))
  let batch: CursorEvent[] = []
  const flush = () => {
    if (!batch.length) return
    toEditor(CAPTURE_IPC.cursorEvents, key, batch)
    batch = []
  }
  const file = helperPath()
  if (!file) {
    let last = ''
    const tick = setInterval(() => {
      const dip = screen.getCursorScreenPoint()
      const p = process.platform === 'win32' ? screen.dipToScreenPoint(dip) : dip
      const at = `${p.x},${p.y}`
      if (at !== last) batch.push({ e: 'move', t: Date.now(), x: p.x, y: p.y })
      last = at
    }, 1000 / 60)
    const send = setInterval(flush, 100)
    streams.set(key, {
      stop: () => {
        clearInterval(tick)
        clearInterval(send)
        flush()
        endStream(key, 'ended')
      },
    })
    return
  }
  const args = ['cursor', '--hz', String(hz)]
  if (Number.isFinite(target.hwnd)) args.push('--hwnd', String(Math.trunc(target.hwnd!)))
  const child = spawn(file, args, { windowsHide: true })
  let text = ''
  child.stdout.on('data', (data: Buffer) => {
    text += data.toString('utf8')
    let end: number
    while ((end = text.indexOf('\n')) >= 0) {
      const line = text.slice(0, end).trim()
      text = text.slice(end + 1)
      if (!line) continue
      try {
        batch.push(JSON.parse(line) as CursorEvent)
      } catch {
        /* a torn line */
      }
    }
  })
  const send = setInterval(flush, 100)
  child.on('error', () => undefined)
  child.on('exit', () => {
    clearInterval(send)
    flush()
    endStream(key, 'ended')
  })
  streams.set(key, { stop: () => quit(child) })
}

export function stopStream(key: string) {
  streams.get(key)?.stop()
}

// ─── Files ───────────────────────────────────────────────────────────────

/** `name.mp4`, or `name 2.mp4` when that is taken (a file being written counts). */
function freeName(dir: string, base: string, ext: string) {
  for (let n = 1; n < 10_000; n++) {
    const file = path.join(dir, `${base}${n === 1 ? '' : ` ${n}`}.${ext}`)
    if (!fs.existsSync(file) && !fs.existsSync(`${file}.partial`)) return file
  }
  throw new Error('Couldn’t find a free file name for the recording.')
}

/** Files being written now: a crash leaves these behind, and they aren't offered for recovery while they're open. */
const writing = new Map<string, string>()

export function beginRecording(name: string, extension: string) {
  const ext = extension === 'm4a' ? 'm4a' : 'mp4'
  const handle = beginFile(freeName(folder(), cleanRecordingName(name) || 'Recording', ext), { keepOnQuit: true })
  writing.set(handle.id, handle.path)
  return handle
}

/**
 * A recording is written as a fragmented MP4, which survives a crash and needs
 * nothing kept in memory. This rewrites it as an ordinary MP4 — the same sound
 * and picture, not encoded again — which every player and editor reads.
 * False when that couldn't be done (the fragmented file stays, and still plays).
 */
async function finishFile(file: string): Promise<boolean> {
  const tmp = `${file}.finishing`
  const input = new Input({ source: new FilePathSource(file), formats: ALL_FORMATS })
  try {
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: new FilePathTarget(tmp) })
    const conversion = await Conversion.init({ input, output, showWarnings: false })
    if (!conversion.isValid || conversion.discardedTracks.length) throw new Error('not every track could be copied')
    await conversion.execute()
    input.dispose()
    await replace(tmp, file)
    return true
  } catch {
    input.dispose()
    await fs.promises.rm(tmp, { force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})
    return false
  }
}

/**
 * Puts `from` where `to` is, in one step, so there is never a moment with
 * neither. Windows refuses while either file is still being let go of, so it
 * is tried for a couple of seconds.
 */
async function replace(from: string, to: string) {
  for (let tries = 0; ; tries++) {
    try {
      fs.renameSync(from, to)
      return
    } catch (err) {
      if (tries >= 24) throw err
      await new Promise((r) => setTimeout(r, 100))
    }
  }
}

export async function finishRecording(id: string) {
  writing.delete(id)
  const done = finishExport(id)
  const ok = await finishFile(done.path)
  return { path: done.path, size: fs.statSync(done.path).size, fragmented: !ok }
}

export function discardRecording(id: string) {
  writing.delete(id)
  abortExport(id)
}

/** Recordings a crash left unfinished in the recordings folder. */
export function recoverable(): RecoverableRecording[] {
  const dir = folder()
  const open = new Set([...writing.values()].map((p) => path.resolve(`${p}.partial`)))
  const out: RecoverableRecording[] = []
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!/\.(mp4|m4a)\.partial$/i.test(name)) continue
      const file = path.join(dir, name)
      if (open.has(path.resolve(file))) continue
      const stat = fs.statSync(file)
      // Too small to hold a second of anything.
      if (stat.size < 64 * 1024) continue
      out.push({ path: file, bytes: stat.size, modifiedAt: stat.mtimeMs })
    }
  } catch {
    /* no folder, nothing to recover */
  }
  return out.sort((a, b) => b.modifiedAt - a.modifiedAt)
}

/** Only files `recoverable` would list, so the editor can't point this at anything else. */
function leftover(file: string) {
  const abs = path.resolve(String(file))
  const found = recoverable().find((r) => path.resolve(r.path) === abs)
  if (!found) throw new Error('That recording isn’t there any more.')
  return abs
}

export async function recoverRecording(file: string) {
  const partial = leftover(file)
  const base = partial.slice(0, -'.partial'.length)
  const ext = path.extname(base).slice(1)
  const target = freeName(path.dirname(base), `${path.basename(base, `.${ext}`)} (recovered)`, ext)
  fs.renameSync(partial, target)
  const ok = await finishFile(target)
  return { path: target, size: fs.statSync(target).size, fragmented: !ok }
}

export function forgetRecording(file: string) {
  fs.rmSync(leftover(file), { force: true })
}

// ─── While recording ─────────────────────────────────────────────────────

let state: CaptureSessionState = { armed: false, recording: false, hideLumen: false, minimize: false }
let awake: number | null = null
let minimized = false
const registered = new Set<CaptureHotkey>()

function listen(key: CaptureHotkey, on: boolean) {
  const { accelerator } = CAPTURE_HOTKEYS[key]
  if (on && !registered.has(key)) {
    try {
      // Another app may already own the keys; the buttons still work.
      if (globalShortcut.register(accelerator, () => toEditor(CAPTURE_IPC.hotkey, key))) registered.add(key)
    } catch {
      /* not registered */
    }
  } else if (!on && registered.has(key)) {
    globalShortcut.unregister(accelerator)
    registered.delete(key)
  }
}

export function setSession(win: BrowserWindow | null, next: Partial<CaptureSessionState>) {
  const was = state
  state = { armed: next.armed === true, recording: next.recording === true, hideLumen: next.hideLumen === true, minimize: next.minimize === true }
  listen('toggle', state.armed || state.recording)
  listen('pause', state.recording)
  listen('marker', state.recording)

  // A long recording isn't cut short by the computer going to sleep.
  if (state.recording && awake === null) awake = powerSaveBlocker.start('prevent-display-sleep')
  else if (!state.recording && awake !== null) {
    powerSaveBlocker.stop(awake)
    awake = null
  }
  if (!win || win.isDestroyed()) return
  // Windows leaves a window marked like this out of every screen capture.
  win.setContentProtection(state.recording && state.hideLumen)
  if (state.recording && !was.recording && state.minimize && !win.isMinimized()) {
    win.minimize()
    minimized = true
  } else if (!state.recording && was.recording && minimized) {
    minimized = false
    if (win.isMinimized()) win.restore()
    win.focus()
  }
}

// ─── Start and stop ──────────────────────────────────────────────────────

export function initCapture(win: BrowserWindow, isTrustedUrl: (url: string) => boolean) {
  editor = win
  // Only the editor's own page, and only for the source it has just named.
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      const pick = armed
      armed = null
      const ok = pick !== null && Date.now() - pick.at < 10_000 && isTrustedUrl(request.frame?.url ?? '')
      if (!ok) return callback({})
      callback({ video: pick.source, ...(pick.audio && request.audioRequested ? { audio: 'loopback' as const } : {}) })
    },
    { useSystemPicker: false },
  )
  win.on('closed', () => {
    if (editor === win) editor = null
    stopCapture()
  })
}

/** Everything the recorder holds outside the editor's page is let go. */
export function stopCapture() {
  for (const s of [...streams.values()]) s.stop()
  for (const key of [...registered]) listen(key, false)
  if (awake !== null) {
    powerSaveBlocker.stop(awake)
    awake = null
  }
  // Half-written files stay where they are: they can be recovered next time.
  state = { armed: false, recording: false, hideLumen: false, minimize: false }
}
