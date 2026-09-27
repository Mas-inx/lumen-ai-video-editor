import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { AgentEvent } from '../shared/ai'
import { APP_IPC, type AppAPI, type CollectProgress, type UpdateState } from '../shared/app'
import { IPC, type BridgeRequest, type BridgeState, type IntegrationsAPI, type Job, type McpServerState } from '../shared/integrations'

// The only surface the renderer sees: typed methods, never raw ipcRenderer.

const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args)

function subscribe<T>(channel: string, cb: (payload: T) => void) {
  const listener = (_e: IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => void ipcRenderer.removeListener(channel, listener)
}

const integrations: IntegrationsAPI = {
  blender: {
    detect: () => invoke(IPC.blenderDetect),
    setPath: (path) => invoke(IPC.blenderSetPath, path),
    render: (req) => invoke(IPC.blenderRender, req),
    runLive: (code) => invoke(IPC.blenderLive, code),
  },
  motion: {
    render: (req) => invoke(IPC.motionRender, req),
  },
  mcp: {
    list: () => invoke(IPC.mcpList),
    save: (config) => invoke(IPC.mcpSave, config),
    remove: (id) => invoke(IPC.mcpRemove, id),
    connect: (id) => invoke(IPC.mcpConnect, id),
    disconnect: (id) => invoke(IPC.mcpDisconnect, id),
    signOut: (id) => invoke(IPC.mcpSignOut, id),
    call: (serverId, tool, args) => invoke(IPC.mcpCall, serverId, tool, args),
  },
  media: {
    importUrl: (url, name, provenance) => invoke(IPC.mediaImportUrl, url, name, provenance),
    reveal: (url) => invoke(IPC.mediaReveal, url),
  },
  jobs: {
    list: () => invoke(IPC.jobsList),
    cancel: (id) => invoke(IPC.jobsCancel, id),
  },
  elevenlabs: {
    state: () => invoke(IPC.elevenState),
    setKey: (key) => invoke(IPC.elevenSetKey, key),
    voices: (search) => invoke(IPC.elevenVoices, search),
    speak: (req) => invoke(IPC.elevenSpeak, req),
    soundEffect: (req) => invoke(IPC.elevenSfx, req),
    music: (req) => invoke(IPC.elevenMusic, req),
    transcribe: (wav, name, languageCode) => invoke(IPC.elevenTranscribe, wav, name, languageCode),
  },
  ai: {
    providers: () => invoke(IPC.aiProviders),
    setProvider: (id, patch) => invoke(IPC.aiSetProvider, id, patch),
    models: (id, refresh) => invoke(IPC.aiModels, id, refresh),
    signInOpenRouter: () => invoke(IPC.aiSignInOpenRouter),
    localAgents: (refresh) => invoke(IPC.aiLocalAgents, refresh),
    signInLocal: (id) => invoke(IPC.aiSignInLocal, id),
    run: (req) => invoke(IPC.aiRun, req),
    stop: (runId) => invoke(IPC.aiStop, runId),
    forget: (conversationId) => invoke(IPC.aiForget, conversationId),
    transcribe: (wav, language) => invoke(IPC.aiTranscribe, wav, language),
    mediaModels: (provider, refresh) => invoke(IPC.aiMediaModels, provider, refresh),
    generateImage: (req) => invoke(IPC.aiGenerateImage, req),
    generateVideo: (req) => invoke(IPC.aiGenerateVideo, req),
    onEvent: (cb) => subscribe<AgentEvent>(IPC.aiEvent, cb),
  },
  bridge: {
    state: () => invoke(IPC.bridgeState),
    setEnabled: (on) => invoke(IPC.bridgeSetEnabled, on),
    regenerateToken: () => invoke(IPC.bridgeRegenerate),
    serve: (handler) =>
      subscribe<BridgeRequest>(IPC.bridgeRequest, (req) => {
        handler(req).then(
          (result) => ipcRenderer.send(IPC.bridgeResponse, { id: req.id, ok: true, result }),
          (err: unknown) => ipcRenderer.send(IPC.bridgeResponse, { id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) }),
        )
      }),
    onState: (cb) => subscribe<BridgeState>(IPC.bridgeEvent, cb),
  },
  onJob: (cb) => subscribe<Job>(IPC.jobEvent, cb),
  onMcp: (cb) => subscribe<McpServerState>(IPC.mcpEvent, cb),
}

const appApi: AppAPI = {
  files: {
    pickMedia: () => invoke(APP_IPC.pickMedia),
    register: (paths) => invoke(APP_IPC.registerMedia, paths),
    pathForFile: (file) => {
      try {
        return webUtils.getPathForFile(file)
      } catch {
        return ''
      }
    },
    relink: (name) => invoke(APP_IPC.relinkMedia, name),
    reveal: (path) => invoke(APP_IPC.revealFile, path),
    open: (path) => invoke(APP_IPC.openFile, path),
    saveMedia: (folder, fileName, data) => invoke(APP_IPC.saveMedia, folder, fileName, data),
    urlForPath: (path) => invoke(APP_IPC.mediaUrlForPath, path),
    beginProxy: (key) => invoke(APP_IPC.proxyBegin, key),
  },
  project: {
    open: (path) => invoke(APP_IPC.projectOpen, path),
    save: (path, text) => invoke(APP_IPC.projectSave, path, text),
    saveAs: (name, text) => invoke(APP_IPC.projectSaveAs, name, text),
    recent: () => invoke(APP_IPC.projectRecent),
    forget: (path) => invoke(APP_IPC.projectForget, path),
    autosave: (snapshot) => invoke(APP_IPC.projectAutosave, snapshot),
    recovery: () => invoke(APP_IPC.projectRecovery),
    discardRecovery: () => invoke(APP_IPC.projectDiscardRecovery),
    setState: (state) => ipcRenderer.send(APP_IPC.projectState, state),
    startupFile: () => invoke(APP_IPC.projectStartup),
    confirmDiscard: (name) => invoke(APP_IPC.confirmDiscard, name),
    onOpenRequest: (cb) => subscribe<string>(APP_IPC.openRequest, cb),
    onSaveBeforeClose: (cb) => subscribe<void>(APP_IPC.saveBeforeClose, () => cb()),
    closeWindow: () => ipcRenderer.send(APP_IPC.closeWindow),
    versions: (projectId) => invoke(APP_IPC.projectVersions, projectId),
    readVersion: (projectId, versionId, projectPath) => invoke(APP_IPC.projectReadVersion, projectId, versionId, projectPath),
    snapshot: (snap) => invoke(APP_IPC.projectSnapshot, snap),
    collect: (name, text) => invoke(APP_IPC.projectCollect, name, text),
    onCollectProgress: (cb) => subscribe<CollectProgress>(APP_IPC.collectProgress, cb),
  },
  export: {
    begin: (opts) => invoke(APP_IPC.exportBegin, opts),
    pick: (opts) => invoke(APP_IPC.exportPick, opts),
    open: (token) => invoke(APP_IPC.exportOpen, token),
    forget: (token) => invoke(APP_IPC.exportForget, token),
    write: (id, position, data) => invoke(APP_IPC.exportWrite, id, position, data),
    writeFrame: (id, index, data) => invoke(APP_IPC.exportFrame, id, index, data),
    sidecar: (exportPath, extension, text) => invoke(APP_IPC.exportSidecar, exportPath, extension, text),
    finish: (id) => invoke(APP_IPC.exportFinish, id),
    abort: (id) => invoke(APP_IPC.exportAbort, id),
    progress: (value) => ipcRenderer.send(APP_IPC.exportProgress, value),
  },
  window: {
    capture: (maxWidth) => invoke(APP_IPC.captureWindow, maxWidth),
  },
  updates: {
    state: () => invoke(APP_IPC.updateState),
    check: () => invoke(APP_IPC.updateCheck),
    install: () => invoke(APP_IPC.updateInstall),
    onState: (cb) => subscribe<UpdateState>(APP_IPC.updateEvent, cb),
  },
}

contextBridge.exposeInMainWorld('lumen', {
  isElectron: true,
  testMode: process.argv.includes('--lumen-test'),
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  },
  integrations,
  app: appApi,
})
