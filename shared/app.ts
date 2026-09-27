/**
 * The desktop app surface the editor uses for files: importing media from disk,
 * project files, autosave/recovery and writing exports. Everything touching the
 * file system happens in the main process; the editor only ever sees paths the
 * user picked (or that a project it opened references).
 */

/** A media file on disk the editor may read, served as `url` (lumen-media://file/…). */
export interface MediaFileInfo {
  path: string
  url: string
  name: string
  size: number
  mime: string
  /** Last-modified time (ms) — part of cache keys for thumbnails and waveforms. */
  mtime: number
}

export interface RecentProject {
  path: string
  name: string
  openedAt: number
  exists: boolean
}

export interface OpenedProject {
  path: string
  /** The project document, with every media path resolved and registered. */
  text: string
  /** Asset ids whose media couldn't be found (moved or deleted). */
  missing: string[]
}

export interface RecoveryInfo {
  text: string
  savedAt: number
  /** The project file the unsaved changes belong to, if it had been saved before. */
  path: string | null
  name: string
}

export type CloseChoice = 'save' | 'discard' | 'cancel'

/** save — the project was saved; auto — a snapshot taken while editing; restore — taken just before restoring an older version. */
export type VersionKind = 'save' | 'auto' | 'restore'

export interface ProjectVersion {
  id: string
  savedAt: number
  kind: VersionKind
  name: string
  clips: number
  /** Timeline length */
  seconds: number
  /** Bytes */
  size: number
}

export interface CollectResult {
  /** The collected project file. */
  path: string
  folder: string
  files: number
  bytes: number
  /** Media that couldn't be found, so wasn't copied. */
  missing: string[]
}

export interface CollectProgress {
  done: number
  total: number
  /** The file being copied ('' when finished). */
  file: string
}

export type MediaFolder = 'snapshots' | 'recordings' | 'sfx' | 'generated'

export interface ExportHandle {
  id: string
  path: string
}

/** A destination chosen now and written later (the render queue). */
export interface ExportTarget {
  token: string
  path: string
  /** An image sequence: a folder of numbered frames. */
  folder: boolean
}

export interface ExportRequest {
  defaultName: string
  extension: string
  filterName: string
  /** An image sequence: frames go into a folder of their own. */
  folder?: boolean
}

/**
 * Updates from the GitHub Releases page.
 * unsupported — a development build (only the installed app updates itself).
 */
export type UpdateStatus = 'unsupported' | 'idle' | 'checking' | 'up-to-date' | 'downloading' | 'ready' | 'error'

export interface UpdateState {
  status: UpdateStatus
  /** The version running now. */
  current: string
  /** The newer version found (while it downloads, and once it's ready to install). */
  version?: string
  /** Download progress, 0..1. */
  progress?: number
  /** The release's notes, as plain text. */
  notes?: string
  error?: string
  /** When the last check finished (ms). */
  checkedAt?: number
}

export const APP_IPC = {
  pickMedia: 'lumen:files:pick-media',
  registerMedia: 'lumen:files:register',
  relinkMedia: 'lumen:files:relink',
  revealFile: 'lumen:files:reveal',
  openFile: 'lumen:files:open',
  saveMedia: 'lumen:files:save-media',
  mediaUrlForPath: 'lumen:files:url-for-path',

  projectOpen: 'lumen:project:open',
  projectSave: 'lumen:project:save',
  projectSaveAs: 'lumen:project:save-as',
  projectRecent: 'lumen:project:recent',
  projectForget: 'lumen:project:forget',
  projectAutosave: 'lumen:project:autosave',
  projectRecovery: 'lumen:project:recovery',
  projectDiscardRecovery: 'lumen:project:discard-recovery',
  projectState: 'lumen:project:state',
  projectStartup: 'lumen:project:startup',
  projectVersions: 'lumen:project:versions',
  projectReadVersion: 'lumen:project:read-version',
  projectSnapshot: 'lumen:project:snapshot',
  projectCollect: 'lumen:project:collect',
  proxyBegin: 'lumen:files:proxy-begin',
  confirmDiscard: 'lumen:project:confirm-discard',
  closeWindow: 'lumen:app:close-window',

  exportBegin: 'lumen:export:begin',
  exportPick: 'lumen:export:pick',
  exportOpen: 'lumen:export:open',
  exportForget: 'lumen:export:forget',
  exportFrame: 'lumen:export:frame',
  exportSidecar: 'lumen:export:sidecar',
  exportWrite: 'lumen:export:write',
  exportFinish: 'lumen:export:finish',
  exportAbort: 'lumen:export:abort',
  exportProgress: 'lumen:export:progress',

  captureWindow: 'lumen:app:capture-window',

  updateState: 'lumen:update:state',
  updateCheck: 'lumen:update:check',
  updateInstall: 'lumen:update:install',

  /** main → renderer */
  openRequest: 'lumen:project:open-request',
  saveBeforeClose: 'lumen:project:save-before-close',
  updateEvent: 'lumen:update:event',
  collectProgress: 'lumen:project:collect-progress',
} as const

/** What the preload exposes as `window.lumen.app`. */
export interface AppAPI {
  files: {
    /** Native "Import media" dialog. */
    pickMedia(): Promise<MediaFileInfo[]>
    /** Registers dropped files (by path) so the editor may read them. */
    register(paths: string[]): Promise<MediaFileInfo[]>
    /** The absolute path of a File from a drop or <input> (Electron only). */
    pathForFile(file: File): string
    /** Lets the user point a missing asset at its new location. */
    relink(name: string): Promise<MediaFileInfo | null>
    reveal(path: string): Promise<void>
    /** Opens a file in the system's default app (e.g. a finished export). */
    open(path: string): Promise<void>
    /** Saves bytes the editor produced (snapshot, recording…) into Lumen's media library. */
    saveMedia(folder: MediaFolder, fileName: string, data: Uint8Array): Promise<MediaFileInfo>
    urlForPath(path: string): Promise<MediaFileInfo | null>
    /** Opens a proxy file in Lumen's media folder for streamed writes (then export.write / finish / abort). */
    beginProxy(key: string): Promise<ExportHandle>
  }
  project: {
    /** Opens a project file — with a dialog when no path is given. Null if cancelled. */
    open(path?: string): Promise<OpenedProject | null>
    save(path: string, text: string): Promise<{ path: string }>
    /** Save dialog, then save. Null if cancelled. */
    saveAs(suggestedName: string, text: string): Promise<{ path: string } | null>
    recent(): Promise<RecentProject[]>
    forget(path: string): Promise<RecentProject[]>
    /** Writes the crash-recovery copy (null clears it). */
    autosave(snapshot: { text: string; path: string | null; name: string } | null): Promise<void>
    recovery(): Promise<RecoveryInfo | null>
    discardRecovery(): Promise<void>
    /** Keeps the window title and close-confirmation in sync with the editor. */
    setState(state: { name: string; path: string | null; dirty: boolean }): void
    /** A project file Lumen was launched with (double-clicked .lumen file). */
    startupFile(): Promise<string | null>
    /** Native "Save changes?" prompt. */
    confirmDiscard(name: string): Promise<CloseChoice>
    onOpenRequest(cb: (path: string) => void): () => void
    /** The window is closing with unsaved changes and the user chose "Save". */
    onSaveBeforeClose(cb: () => void): () => void
    /** Closes the window without asking again (after saving). */
    closeWindow(): void
    /** Every stored version of a project, newest first. */
    versions(projectId: string): Promise<ProjectVersion[]>
    /** A stored version, with its media resolved like an opened project. */
    readVersion(projectId: string, versionId: string, projectPath: string | null): Promise<OpenedProject>
    /** Stores a version of the current state (auto snapshots, and before restoring). */
    snapshot(snap: { text: string; path: string | null; kind: VersionKind }): Promise<void>
    /** Copies the project and all its media into one folder the user picks. Null if cancelled. */
    collect(name: string, text: string): Promise<CollectResult | null>
    onCollectProgress(cb: (p: CollectProgress) => void): () => void
  }
  export: {
    /** Save dialog (or folder picker, for image sequences) and open the file. Null if cancelled. */
    begin(opts: ExportRequest): Promise<ExportHandle | null>
    /** Only asks where an export goes; `open` it when it's time to write. Null if cancelled. */
    pick(opts: ExportRequest): Promise<ExportTarget | null>
    open(token: string): Promise<ExportHandle>
    /** Lets go of a picked destination that won't be written. */
    forget(token: string): Promise<void>
    write(id: string, position: number, data: Uint8Array): Promise<void>
    /** One numbered PNG of an image-sequence export (index from 0). */
    writeFrame(id: string, index: number, data: Uint8Array): Promise<void>
    /** Captions (.srt / .vtt) saved next to a file exported this session. Returns the caption file's path. */
    sidecar(exportPath: string, extension: 'srt' | 'vtt', text: string): Promise<string>
    finish(id: string): Promise<{ path: string; size: number }>
    /** Stops an export and deletes the partial file. */
    abort(id: string): Promise<void>
    /** Taskbar progress (0..1), or null to clear. */
    progress(value: number | null): void
  }
  window: {
    /** A JPEG (base64) of the editor window as the user sees it, at most `maxWidth` wide. */
    capture(maxWidth: number): Promise<string>
  }
  updates: {
    state(): Promise<UpdateState>
    /** Checks the Releases page now (a newer version then downloads in the background). */
    check(): Promise<UpdateState>
    /** Restarts into the downloaded version. False when there's nothing ready to install. */
    install(): Promise<boolean>
    onState(cb: (state: UpdateState) => void): () => void
  }
}
