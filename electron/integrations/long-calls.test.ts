import { beforeEach, describe, expect, it } from 'vitest'
import type { BridgeToolResult } from '../../shared/integrations'
import { collect, forgetCalls, pendingCalls, runWithin } from './long-calls'

const text = (r: BridgeToolResult) => {
  const first = r.content[0]
  return first.type === 'text' ? first.text : ''
}
const after = (ms: number, value: string): Promise<BridgeToolResult> => new Promise((resolve) => setTimeout(() => resolve({ content: [{ type: 'text', text: value }] }), ms))

describe('tool calls that outlast the client', () => {
  beforeEach(() => forgetCalls())

  it('answer directly when they are quick', async () => {
    const r = await runWithin('get_project', () => after(5, 'the project'), 200)
    expect(text(r)).toBe('the project')
    expect(pendingCalls()).toEqual([])
  })

  it('answer "running" with a call id, carry on, and hand the result over later', async () => {
    let finished = false
    const r = await runWithin('export_video', () => after(120, 'C:\\out.mp4').then((x) => ((finished = true), x)), 30)
    const body = JSON.parse(text(r)) as { status: string; call_id: string; tool: string; next: string }
    expect(body).toMatchObject({ status: 'running', tool: 'export_video' })
    expect(body.next).toContain('get_tool_result')
    expect(r.isError).toBeUndefined()
    expect(finished).toBe(false)
    expect(pendingCalls().map((c) => c.tool)).toEqual(['export_video'])

    // Still working: asking again answers running, with the same id.
    const again = JSON.parse(text(await collect({ call_id: body.call_id, wait_seconds: 0.01 }))) as { status: string; call_id: string }
    expect(again).toMatchObject({ status: 'running', call_id: body.call_id })

    // Waiting long enough gets the real result — and it can be read again.
    expect(text(await collect({ call_id: body.call_id, wait_seconds: 5 }))).toBe('C:\\out.mp4')
    expect(finished).toBe(true)
    expect(text(await collect({ call_id: body.call_id }))).toBe('C:\\out.mp4')
    expect(pendingCalls()).toEqual([])
  })

  it('turn a failure into an error result, also when it comes late', async () => {
    const quick = await runWithin('x', () => Promise.reject(new Error('No clips')), 50)
    expect(quick).toMatchObject({ isError: true })
    expect(text(quick)).toBe('No clips')

    const slow = await runWithin('y', () => new Promise<BridgeToolResult>((_, reject) => setTimeout(() => reject(new Error('Disk full')), 40)), 10)
    const { call_id } = JSON.parse(text(slow)) as { call_id: string }
    const late = await collect({ call_id, wait_seconds: 2 })
    expect(late).toMatchObject({ isError: true })
    expect(text(late)).toBe('Disk full')
  })

  it('say so when the call id is unknown', async () => {
    const r = await collect({ call_id: 'call_nope' })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('call_nope')
    expect((await collect({})).isError).toBe(true)
  })
})
