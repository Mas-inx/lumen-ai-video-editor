import { randomUUID } from 'node:crypto'
import { BrowserWindow, ipcMain } from 'electron'
import { IPC, type BridgeRequest, type BridgeResponse, type BridgeTool, type BridgeToolResult } from '../../shared/integrations'

/**
 * Round-trips into the editor window. The editor owns the tool definitions
 * and runs them through its undoable command system; both Lumen's MCP server
 * and the Copilot's agent runtime call them through here.
 */

let editor: BrowserWindow | null = null
const pending = new Map<string, { resolve: (r: BridgeResponse) => void; timer: NodeJS.Timeout }>()

export function initEditorRpc(win: BrowserWindow, isTrustedUrl: (url: string) => boolean) {
  editor = win
  win.on('closed', () => {
    if (editor === win) editor = null
  })
  ipcMain.removeAllListeners(IPC.bridgeResponse)
  ipcMain.on(IPC.bridgeResponse, (event, res: BridgeResponse) => {
    if (!isTrustedUrl(event.senderFrame?.url ?? '')) return
    const p = pending.get(res?.id)
    if (!p) return
    pending.delete(res.id)
    clearTimeout(p.timer)
    p.resolve(res)
  })
}

export const editorWindow = () => (editor && !editor.isDestroyed() ? editor : null)

export function askEditor(req: Omit<BridgeRequest, 'id'>, timeoutMs: number): Promise<BridgeResponse> {
  const win = editorWindow()
  if (!win) return Promise.resolve({ id: '', ok: false, error: 'Lumen’s editor window isn’t open.' })
  const id = randomUUID()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve({ id, ok: false, error: 'Lumen didn’t answer in time.' })
    }, timeoutMs)
    pending.set(id, { resolve, timer })
    win.webContents.send(IPC.bridgeRequest, { ...req, id })
  })
}

export async function editorTools(): Promise<BridgeTool[]> {
  const res = await askEditor({ method: 'tools' }, 15_000)
  if (!res.ok) throw new Error(res.error)
  return res.result as BridgeTool[]
}

/** The editor's standing instructions for agents (the skills that are switched on). */
export async function editorInstructions(): Promise<string> {
  const res = await askEditor({ method: 'instructions' }, 5_000)
  return res.ok && typeof res.result === 'string' ? res.result : ''
}

/** Runs one of the editor's tools. `runId` ties the call to a Copilot turn, so stopping the turn stops the work. */
export async function callEditorTool(tool: string, args: Record<string, unknown>, timeoutMs = 20 * 60_000, runId?: string): Promise<BridgeToolResult> {
  const res = await askEditor({ method: 'call', tool, args, ...(runId ? { runId } : {}) }, timeoutMs)
  return res.ok ? (res.result as BridgeToolResult) : { content: [{ type: 'text', text: res.error ?? 'Failed' }], isError: true }
}
