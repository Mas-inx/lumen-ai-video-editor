import { BrowserWindow, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { APP_IPC, type MediaFolder } from '../shared/app'
import path from 'node:path'
import { collectProject } from './collect'
import { abortExport, beginExport, beginFile, finishExport, writeExport } from './export'
import { mediaRoot } from './integrations/paths'
import { listVersions } from './versions'
import { openPath, pickMedia, register, relink, reveal, saveMedia, urlForPath } from './files'
import { closeNow, confirmDiscard, forgetRecent, openProject, openVersion, readRecovery, recentProjects, saveProject, saveProjectAs, setProjectState, snapshotVersion, writeRecovery } from './project'
import { checkForUpdates, installUpdate, updateState } from './updater'

const FOLDERS: MediaFolder[] = ['snapshots', 'recordings', 'sfx', 'generated']

/** File, project and export IPC — only the editor's own page may call it. */
export function registerAppIpc(isTrustedUrl: (url: string) => boolean, getStartupFile: () => string | null) {
  const trusted = (event: IpcMainInvokeEvent | IpcMainEvent) => isTrustedUrl(event.senderFrame?.url ?? '')
  const winOf = (event: IpcMainInvokeEvent | IpcMainEvent) => BrowserWindow.fromWebContents(event.sender)
  const handle = <A extends unknown[], R>(channel: string, fn: (win: BrowserWindow | null, ...args: A) => R) => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!trusted(event)) throw new Error('Blocked: untrusted sender')
      return fn(winOf(event), ...(args as A))
    })
  }
  const on = <A extends unknown[]>(channel: string, fn: (win: BrowserWindow, ...args: A) => void) => {
    ipcMain.on(channel, (event, ...args: unknown[]) => {
      const win = winOf(event)
      if (trusted(event) && win) fn(win, ...(args as A))
    })
  }
  const str = (v: unknown) => (typeof v === 'string' ? v : '')

  handle(APP_IPC.pickMedia, (win) => pickMedia(win))
  handle(APP_IPC.registerMedia, (_win, paths: unknown) => register(Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string') : []))
  handle(APP_IPC.relinkMedia, (win, name: unknown) => relink(win, str(name)))
  handle(APP_IPC.revealFile, (_win, target: unknown) => reveal(str(target)))
  handle(APP_IPC.openFile, (_win, target: unknown) => openPath(str(target)))
  handle(APP_IPC.saveMedia, (_win, folder: unknown, name: unknown, data: unknown) => {
    if (!FOLDERS.includes(folder as MediaFolder)) throw new Error('Unknown media folder')
    if (!(data instanceof Uint8Array)) throw new Error('Expected bytes')
    return saveMedia(folder as MediaFolder, str(name) || 'media', data)
  })
  handle(APP_IPC.mediaUrlForPath, (_win, p: unknown) => (str(p) ? urlForPath(str(p)) : null))
  handle(APP_IPC.proxyBegin, (_win, key: unknown) => {
    const name = str(key).replace(/[^\w-]/g, '').slice(0, 120)
    if (!name) throw new Error('Bad proxy name')
    return beginFile(path.join(mediaRoot(), 'proxies', `${name}.mp4`))
  })

  handle(APP_IPC.projectOpen, (win, file?: unknown) => openProject(win, typeof file === 'string' && file ? file : undefined))
  handle(APP_IPC.projectSave, (_win, file: unknown, text: unknown) => saveProject(str(file), str(text)))
  handle(APP_IPC.projectSaveAs, (win, name: unknown, text: unknown) => saveProjectAs(win, str(name), str(text)))
  handle(APP_IPC.projectRecent, () => recentProjects())
  handle(APP_IPC.projectForget, (_win, file: unknown) => forgetRecent(str(file)))
  handle(APP_IPC.projectAutosave, (_win, snap: unknown) => {
    const s = snap as { text?: unknown; path?: unknown; name?: unknown } | null
    writeRecovery(s && typeof s.text === 'string' ? { text: s.text, path: typeof s.path === 'string' ? s.path : null, name: str(s.name) || 'Untitled' } : null)
  })
  handle(APP_IPC.projectRecovery, () => readRecovery())
  handle(APP_IPC.projectDiscardRecovery, () => writeRecovery(null))
  handle(APP_IPC.projectStartup, () => getStartupFile())
  handle(APP_IPC.projectVersions, (_win, projectId: unknown) => listVersions(str(projectId)))
  handle(APP_IPC.projectReadVersion, (_win, projectId: unknown, versionId: unknown, projectPath: unknown) => openVersion(str(projectId), str(versionId), str(projectPath) || null))
  handle(APP_IPC.projectSnapshot, (_win, snap: unknown) => {
    const s = (snap ?? {}) as { text?: unknown; path?: unknown; kind?: unknown }
    if (typeof s.text !== 'string') return
    const kind = s.kind === 'restore' ? 'restore' : 'auto'
    snapshotVersion({ text: s.text, path: typeof s.path === 'string' ? s.path : null, kind })
  })
  handle(APP_IPC.projectCollect, (win, name: unknown, text: unknown) => collectProject(win, str(text), str(name) || 'Untitled', (file, t) => saveProject(file, t)))
  handle(APP_IPC.confirmDiscard, (win, name: unknown) => confirmDiscard(win, str(name) || 'Untitled'))
  on(APP_IPC.projectState, (win, state: unknown) => setProjectState(win, (state ?? {}) as Record<string, unknown>))
  on(APP_IPC.closeWindow, (win) => closeNow(win))

  handle(APP_IPC.exportBegin, (win, opts: unknown) => {
    const o = (opts ?? {}) as { defaultName?: unknown; extension?: unknown; filterName?: unknown }
    return beginExport(win, { defaultName: str(o.defaultName), extension: str(o.extension), filterName: str(o.filterName) })
  })
  handle(APP_IPC.exportWrite, (_win, id: unknown, position: unknown, data: unknown) => writeExport(str(id), Number(position), data as Uint8Array))
  handle(APP_IPC.exportFinish, (_win, id: unknown) => finishExport(str(id)))
  handle(APP_IPC.exportAbort, (_win, id: unknown) => abortExport(str(id)))
  on(APP_IPC.exportProgress, (win, value: unknown) => {
    const v = typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : -1
    win.setProgressBar(v)
  })

  // What the user sees — for the Copilot's editor screenshots. Only this window, never the screen.
  handle(APP_IPC.captureWindow, async (win, maxWidth: unknown) => {
    if (!win || win.isDestroyed()) throw new Error('No editor window')
    const image = await win.webContents.capturePage()
    const width = Math.round(Math.min(2560, Math.max(320, typeof maxWidth === 'number' && Number.isFinite(maxWidth) ? maxWidth : 1600)))
    const scaled = image.getSize().width > width ? image.resize({ width, quality: 'good' }) : image
    return scaled.toJPEG(82).toString('base64')
  })

  handle(APP_IPC.updateState, () => updateState())
  handle(APP_IPC.updateCheck, () => checkForUpdates())
  handle(APP_IPC.updateInstall, () => installUpdate())
}
