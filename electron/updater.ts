import { app, type BrowserWindow } from 'electron'
import electronUpdater, { type UpdateInfo } from 'electron-updater'
import { APP_IPC, type UpdateState } from '../shared/app'

/**
 * Updates from the GitHub Releases page. electron-updater reads latest.yml
 * from the newest release, downloads the new installer in the background
 * (only the changed blocks when it can, checked against the release's
 * SHA-512) and installs it silently when Lumen restarts — at once if the user
 * says so, otherwise the next time they quit.
 *
 * LUMEN_UPDATE_URL points the updater at another feed (a folder served over
 * HTTP with latest.yml and an installer) to try the whole flow locally.
 */

const { autoUpdater } = electronUpdater

const FIRST_CHECK = 10_000
const CHECK_EVERY = 4 * 60 * 60_000

let state: UpdateState = { status: 'idle', current: app.getVersion() }
let window: () => BrowserWindow | null = () => null
let started = false

function set(patch: Partial<UpdateState>) {
  state = { ...state, ...patch }
  const win = window()
  if (win && !win.isDestroyed()) win.webContents.send(APP_IPC.updateEvent, state)
}

export const updateState = () => state

/** GitHub release notes arrive as HTML; the editor shows them as text. */
export function notesOf(info: Pick<UpdateInfo, 'releaseNotes'>) {
  const raw = Array.isArray(info.releaseNotes) ? info.releaseNotes.map((n) => n.note ?? '').join('\n\n') : (info.releaseNotes ?? '')
  const text = raw
    .replace(/<\/(p|li|h\d|div)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '’')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text ? text.slice(0, 4000) : undefined
}

export function friendly(err: unknown) {
  const message = err instanceof Error ? err.message : String(err)
  if (/ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ERR_CONNECTION|ERR_NETWORK/i.test(message)) return 'Couldn’t reach GitHub — check your connection and try again.'
  if (/latest\.yml|No published versions|HttpError: 404|status 404/i.test(message)) return 'The Releases page has no update for this version yet.'
  if (/sha512 checksum mismatch/i.test(message)) return 'The download didn’t match the release’s checksum, so it was discarded. Try again later.'
  return message.split('\n')[0].slice(0, 240)
}

/** Starts watching for updates. Development builds report "unsupported" (only an installed app updates itself). */
export function initUpdater(getWindow: () => BrowserWindow | null) {
  window = getWindow
  if (started) return
  started = true
  const feed = process.env.LUMEN_UPDATE_URL
  if (!app.isPackaged && !feed) {
    set({ status: 'unsupported' })
    return
  }
  if (feed) {
    autoUpdater.setFeedURL({ provider: 'generic', url: feed })
    autoUpdater.forceDevUpdateConfig = !app.isPackaged
  }
  autoUpdater.logger = null
  autoUpdater.autoDownload = true
  // A test feed installs only when asked, never just because the app quit.
  autoUpdater.autoInstallOnAppQuit = !feed
  autoUpdater.allowPrerelease = false

  autoUpdater.on('checking-for-update', () => set({ status: 'checking', error: undefined }))
  autoUpdater.on('update-not-available', () => set({ status: 'up-to-date', checkedAt: Date.now(), version: undefined, progress: undefined }))
  autoUpdater.on('update-available', (info) => set({ status: 'downloading', version: info.version, notes: notesOf(info), progress: 0, checkedAt: Date.now() }))
  autoUpdater.on('download-progress', (p) => set({ status: 'downloading', progress: Math.min(1, Math.max(0, p.percent / 100)) }))
  autoUpdater.on('update-downloaded', (info) => set({ status: 'ready', version: info.version, notes: notesOf(info) ?? state.notes, progress: 1 }))
  autoUpdater.on('error', (err) => {
    // A failed download keeps the version it was after, so the editor can say which.
    if (state.status !== 'ready') set({ status: 'error', error: friendly(err), checkedAt: Date.now() })
  })

  // Automated test runs stay off the network unless they bring their own feed.
  if (process.env.LUMEN_USER_DATA && !feed) return
  setTimeout(() => void checkForUpdates(), FIRST_CHECK)
  setInterval(() => void checkForUpdates(), CHECK_EVERY).unref()
}

/** Checks now; a newer version starts downloading by itself. */
export async function checkForUpdates(): Promise<UpdateState> {
  if (!started || state.status === 'unsupported' || state.status === 'checking' || state.status === 'downloading' || state.status === 'ready') return state
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    set({ status: 'error', error: friendly(err), checkedAt: Date.now() })
  }
  return state
}

/** Quits and installs the downloaded version silently, then reopens Lumen. Unsaved work still gets its prompt first. */
export function installUpdate() {
  if (state.status !== 'ready') return false
  setImmediate(() => autoUpdater.quitAndInstall(true, true))
  return true
}
