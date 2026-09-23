/**
 * The editor's half of Lumen's MCP server: the main process accepts agent
 * connections and forwards each request here, where tools run through the
 * same command system as the UI.
 */
import { create } from 'zustand'
import type { BridgeLogEntry, BridgeStatus } from '@shared/integrations'
import { agentTools, runAgentTool } from './agent-tools'
import { api } from './store'

interface BridgeStore {
  status: BridgeStatus
  log: BridgeLogEntry[]
  toolNames: string[]
}

export const useBridge = create<BridgeStore>(() => ({ status: { running: false, port: 47910 }, log: [], toolNames: [] }))

let started = false

export function startBridgeClient() {
  if (started || !api) return
  started = true
  useBridge.setState({ toolNames: agentTools().map((t) => t.name) })
  api.bridge.serve(async (req) => {
    if (req.method === 'tools') return agentTools().map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
    return runAgentTool(req.tool ?? '', req.args ?? {})
  })
  api.bridge.onState(({ status, log }) => useBridge.setState({ status, log }))
  void api.bridge.state().then(({ status, log }) => useBridge.setState({ status, log }))
}

export async function setBridgeEnabled(on: boolean) {
  if (!api) return
  const { status, log } = await api.bridge.setEnabled(on)
  useBridge.setState({ status, log })
  if (on && status.error) throw new Error(status.error)
}

export async function regenerateBridgeToken() {
  if (!api) return
  const { status, log } = await api.bridge.regenerateToken()
  useBridge.setState({ status, log })
}
