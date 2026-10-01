import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isPrivateHost, MCP_CATALOG, type McpAgentResult, type McpServerState } from '@shared/integrations'

// Connected MCP servers' tools become agent tools: the desktop bridge and the approval prompt are stand-ins here.
const answer = vi.fn<(id: string, tool: string, args: Record<string, unknown>) => Promise<McpAgentResult>>()
let approve = true
const asked: string[] = []
vi.mock('./store', async (original) => ({ ...(await original<typeof import('./store')>()), api: { mcp: { callForAgent: (...a: [string, string, Record<string, unknown>]) => answer(...a) } } }))
vi.mock('./approvals', () => ({
  requestApproval: async (req: { title: string }) => {
    asked.push(req.title)
    return approve
  },
}))

const { agentTools, runAgentTool, mcpToolName } = await import('./agent-tools')
const { useIntegrations } = await import('./store')

function studio(over: Partial<McpServerState> = {}, agent?: boolean): McpServerState {
  return {
    config: { id: 'gs-cinematic-studio', name: 'GS Cinematic Studio', transport: 'http', url: 'http://127.0.0.1:30120/gs-cinematic-studio/mcp', enabled: true, preset: 'gs-cinematic-studio', agentTools: agent },
    status: 'connected',
    tools: [
      { name: 'studio_status', title: 'Studio status', description: 'Start here.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
      { name: 'screenshot', description: 'A JPEG of the game.', inputSchema: { type: 'object', properties: { width: { type: 'integer' } } } },
      { name: 'delete_project', description: 'Delete a project.', inputSchema: { type: 'object', properties: { project_id: { type: 'string' } } }, annotations: { destructiveHint: true } },
    ],
    ...over,
  }
}

const setServers = (...list: McpServerState[]) => useIntegrations.setState({ servers: Object.fromEntries(list.map((s) => [s.config.id, s])) })
const names = () => agentTools().map((t) => t.name)

beforeEach(() => {
  answer.mockReset()
  approve = true
  asked.length = 0
  setServers()
})

describe('MCP server tools for agents', () => {
  it('lists the tools of connected servers, named <server>__<tool>', () => {
    const builtIn = agentTools().length
    setServers(studio())
    expect(names()).toContain('gs-cinematic-studio__studio_status')
    expect(agentTools().length).toBe(builtIn + 3)
    const t = agentTools().find((x) => x.name === 'gs-cinematic-studio__studio_status')!
    expect(t.description).toBe('[GS Cinematic Studio] Studio status: Start here.')
    expect(t.inputSchema).toEqual({ type: 'object', properties: {} })
  })

  it('leaves out disconnected servers and servers the user keeps from agents', () => {
    setServers(studio({ status: 'disconnected' }))
    expect(names().some((n) => n.startsWith('gs-cinematic-studio__'))).toBe(false)
    setServers(studio({}, false))
    expect(names().some((n) => n.startsWith('gs-cinematic-studio__'))).toBe(false)
  })

  it('makes names every model provider accepts', () => {
    expect(mcpToolName('my server.v2', 'do/thing')).toBe('my_server_v2__do_thing')
    expect(mcpToolName('s'.repeat(50), 't'.repeat(50))).toHaveLength(64)
  })

  it('calls the server and hands back JSON and pictures', async () => {
    setServers(studio())
    answer.mockResolvedValue({ isError: false, text: ['{"width":640}'], images: [{ data: 'QUJD', mimeType: 'image/jpeg' }, { data: 'x', mimeType: 'image/svg+xml' }], links: [] })
    const res = await runAgentTool('gs-cinematic-studio__screenshot', { width: 640 })
    expect(answer).toHaveBeenCalledWith('gs-cinematic-studio', 'screenshot', { width: 640 })
    expect(res.isError).toBeFalsy()
    expect(res.structuredContent).toEqual({ width: 640 })
    expect(res.content.filter((c) => c.type === 'image')).toEqual([{ type: 'image', data: 'QUJD', mimeType: 'image/jpeg' }])
  })

  it('passes the server’s error text on as a tool error', async () => {
    setServers(studio())
    answer.mockResolvedValue({ isError: true, text: ['No director has remote control on.'], images: [], links: [] })
    const res = await runAgentTool('gs-cinematic-studio__studio_status', {})
    expect(res.isError).toBe(true)
    expect(res.content[0]).toEqual({ type: 'text', text: 'No director has remote control on.' })
  })

  it('asks the user before a tool that can’t be undone', async () => {
    setServers(studio())
    answer.mockResolvedValue({ isError: false, text: ['{"deleted":"p1"}'], images: [], links: [] })
    approve = false
    const declined = await runAgentTool('gs-cinematic-studio__delete_project', { project_id: 'p1' })
    expect(declined.isError).toBe(true)
    expect(answer).not.toHaveBeenCalled()
    approve = true
    const ok = await runAgentTool('gs-cinematic-studio__delete_project', { project_id: 'p1' })
    expect(ok.isError).toBeFalsy()
    expect(asked).toHaveLength(2)
    await runAgentTool('gs-cinematic-studio__studio_status', {})
    expect(asked).toHaveLength(2)
  })
})

describe('GS Cinematic Studio in the catalog', () => {
  it('connects by address and token', () => {
    const e = MCP_CATALOG.find((c) => c.id === 'gs-cinematic-studio')!
    expect(e.transport).toBe('http')
    expect(e.auth).toBe('key')
    expect(e.keyHeader).toBe('Authorization')
    expect(e.keyPrefix).toBe('Bearer ')
    expect(e.urlHint).toBeTruthy()
  })

  it('allows plain http only on this computer or a private network', () => {
    for (const h of ['localhost', '127.0.0.1', '[::1]', '192.168.1.20', '10.0.0.5', '172.20.1.1', '100.101.102.103', 'gameserver.local']) expect(isPrivateHost(h)).toBe(true)
    for (const h of ['8.8.8.8', '172.32.0.1', '100.128.0.1', 'example.com', 'users.cfx.re']) expect(isPrivateHost(h)).toBe(false)
  })
})
