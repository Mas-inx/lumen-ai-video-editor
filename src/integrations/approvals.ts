import { create } from 'zustand'

/**
 * Anything that would run agent-written code on this machine (Blender
 * scripts) waits here for the user's explicit yes.
 */
export interface Approval {
  id: string
  title: string
  detail: string
  code?: string
  requester: string
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
