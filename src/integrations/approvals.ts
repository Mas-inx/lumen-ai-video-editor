import { create } from 'zustand'

/**
 * Anything an agent may only do with the user's explicit yes waits here:
 * running agent-written code on this machine (Blender scripts), or looking at
 * and recording the screen.
 */
export interface Approval {
  id: string
  title: string
  detail: string
  code?: string
  requester: string
  /** What the small print and the two buttons say, when it isn't code being run. */
  note?: string
  confirm?: string
  deny?: string
  resolve: (ok: boolean) => void
}

export const useApprovals = create<{ queue: Approval[] }>(() => ({ queue: [] }))

export function requestApproval(req: Omit<Approval, 'id' | 'resolve'>, timeoutMs = 5 * 60_000): Promise<boolean> {
  return new Promise((resolve) => {
    const id = crypto.randomUUID()
    const timer = setTimeout(() => settle(false), timeoutMs)
    function settle(ok: boolean) {
      clearTimeout(timer)
      useApprovals.setState((s) => ({ queue: s.queue.filter((a) => a.id !== id) }))
      resolve(ok)
    }
    useApprovals.setState((s) => ({ queue: [...s.queue, { ...req, id, resolve: settle }] }))
  })
}
