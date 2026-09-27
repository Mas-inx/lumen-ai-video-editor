import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, nativeTheme, protocol, shell } from 'electron'
import { APP_IPC } from '../shared/app'
import { registerAppIpc } from './app-ipc'
import { abortAllExports } from './export'
import { registerMediaProtocol } from './files'
import { registerIntegrationIpc } from './integrations/ipc'
import { registerJobListener } from './integrations/jobs'
import { disconnectAll } from './integrations/mcp'
import { MEDIA_SCHEME } from './integrations/paths'
import { initBridge, stopBridge } from './integrations/server'
import { guardClose, projectFromArgv } from './project'
import { initUpdater } from './updater'

const isMac = process.platform === 'darwin'
const devServerUrl = process.env.VITE_DEV_SERVER_URL
const indexHtml = path.join(import.meta.dirname, '../dist/index.html')

// Must match --color-canvas in src/styles/index.css so there is no flash on open
// and the native window controls blend into the custom title bar.
const CANVAS = '#080807'
const TITLEBAR_HEIGHT = 44

// Imported, rendered and downloaded media is served as lumen-media://…
protocol.registerSchemesAsPrivileged([
  { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
])

// Automated tests run against their own profile, never the user's.
if (process.env.LUMEN_USER_DATA) app.setPath('userData', process.env.LUMEN_USER_DATA)

// One editor at a time: opening a .lumen file while Lumen runs hands it to the open window.
if (!app.requestSingleInstanceLock()) app.quit()

let mainWindow: BrowserWindow | null = null
let startupFile = projectFromArgv(process.argv)

/** The editor itself — the only page allowed to use the app and integration IPC. */
function isTrustedUrl(url: string) {
  if (devServerUrl) return url.startsWith(new URL(devServerUrl).origin)
  return url.startsWith(pathToFileURL(indexHtml).href)
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1120,
    minHeight: 700,
    show: false,
    title: 'Lumen',
    backgroundColor: CANVAS,
    titleBarStyle: 'hidden',
    ...(isMac
      ? { trafficLightPosition: { x: 16, y: 15 } }
      : { titleBarOverlay: { color: CANVAS, symbolColor: '#a2a39b', height: TITLEBAR_HEIGHT } }),
    webPreferences: {
      preload: path.join(import.meta.dirname, 'preload.mjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      // Playback keeps going while the window is in the background (exports too).
      backgroundThrottling: false,
      // Sound plays the moment you press play (no gesture gate for the audio engine).
      autoplayPolicy: 'no-user-gesture-required',
      // Automated test runs get the editor's debug handle in production builds too.
      additionalArguments: process.env.LUMEN_USER_DATA ? ['--lumen-test'] : [],
    },
  })
  mainWindow = win

  registerJobListener(win)
  initBridge(win, isTrustedUrl)
  guardClose(win)
  // Show the editor as soon as its page has loaded. 'ready-to-show' alone isn't
  // enough: it waits for a visible first paint, but the start screen fades in with
  // animations that only run once the window is on screen — so it never fires.
  let revealed = false
  const reveal = () => {
    if (revealed || win.isDestroyed()) return
    revealed = true
    win.maximize()
    win.show()
  }
  win.once('ready-to-show', reveal)
  win.webContents.once('did-finish-load', reveal)
  win.webContents.once('did-fail-load', reveal)
  setTimeout(reveal, 4000)
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  // Links always open in the user's browser, never inside the editor window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!isTrustedUrl(url)) e.preventDefault()
  })

  if (devServerUrl) void win.loadURL(devServerUrl)
  else void win.loadFile(indexHtml)
}

function openInWindow(file: string) {
  if (!mainWindow) {
    startupFile = file
    if (app.isReady()) createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
  mainWindow.webContents.send(APP_IPC.openRequest, file)
}

app.on('second-instance', (_e, argv) => {
  const file = projectFromArgv(argv)
  if (file) openInWindow(file)
  else if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

// macOS: double-clicked .lumen files arrive as events rather than argv.
app.on('open-file', (e, file) => {
  e.preventDefault()
  openInWindow(file)
})

nativeTheme.themeSource = 'dark'
app.setAppUserModelId('app.lumen.editor')

void app.whenReady().then(() => {
  registerMediaProtocol()
  registerIntegrationIpc(isTrustedUrl)
  registerAppIpc(isTrustedUrl, () => {
    const file = startupFile
    startupFile = null
    return file
  })
  createWindow()
  initUpdater(() => mainWindow)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (!isMac) app.quit()
})

app.on('before-quit', () => {
  abortAllExports()
  void disconnectAll()
  void stopBridge(false)
})
