import { describe, expect, it, vi } from 'vitest'

// As in the desktop app: a window, and the integration API the chats are loaded and saved through.
const ai = vi.hoisted(() => {
  const g = globalThis as unknown as Record<string, unknown>
  g.window ??= globalThis
  g.addEventListener ??= () => {}
  return {
    loadChats: vi.fn(async (_projectId: string) => [] as unknown[]),
    saveChats: vi.fn(async () => {}),
    onEvent: vi.fn(),
    providers: vi.fn(async () => []),
    stop: vi.fn(async () => {}),
    detach: vi.fn(async () => {}),
    forget: vi.fn(async () => {}),
  }
})
vi.mock('@/integrations/store', async (original) => ({ ...(await original<typeof import('@/integrations/store')>()), api: { ai } }))

describe('Copilot chats in the desktop app', () => {
  it('open with the project Lumen starts with, so its chats are kept', async () => {
    const { useAttachments, useCopilot } = await import('./store')
    const { getProject } = await import('@/editor/store')
    await vi.waitFor(() => expect(useCopilot.getState().projectId).toBe(getProject().id))
    expect(ai.loadChats).toHaveBeenCalledWith(getProject().id)
    expect(useAttachments.getState().items).toEqual([])
  })
})
