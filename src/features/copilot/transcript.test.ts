import { describe, expect, it } from 'vitest'
import type { AgentEventBody } from '@shared/ai'
import { applyEvent, compact, duration, finish, fromLegacy, replyText, usageLine, type LocalEvent, type Reply } from './transcript'

/** Feeds events a second apart, starting at t = 1000. */
function play(events: (AgentEventBody | LocalEvent)[], from: Reply = { phase: 'working' }) {
  let reply = from
  events.forEach((e, i) => (reply = applyEvent(reply, e, 1000 + i * 1000)))
  return reply
}

const shape = (reply: Reply) =>
  (reply.parts ?? []).map((p) => (p.kind === 'tool' ? `tool:${p.tool}:${p.status}` : p.kind === 'thinking' ? `thinking:${p.ms === undefined ? 'open' : p.ms}` : `${p.kind}:${p.text}`))

describe('a reply as a transcript', () => {
  it('keeps everything in the order it happened', () => {
    const reply = play([
      { type: 'step', index: 1 },
      { type: 'reasoning', delta: 'The user wants ' },
      { type: 'reasoning', delta: 'a title.' },
      { type: 'reasoning-end' },
      { type: 'text', delta: 'I’ll look first.' },
      { type: 'tool-input', callId: 'c1', tool: 'get_project', chars: 0 },
      { type: 'tool-start', callId: 'c1', tool: 'get_project', input: {} },
      { type: 'tool-end', callId: 'c1', tool: 'get_project', ok: true, output: '{"fps":30}' },
      { type: 'step', index: 2 },
      { type: 'reasoning', delta: 'Now add it.' },
      { type: 'tool-start', callId: 'c2', tool: 'add_title', input: { text: 'Hello', at_seconds: 2 } },
      { type: 'tool-end', callId: 'c2', tool: 'add_title', ok: true, summary: 'added' },
      { type: 'text', delta: '\n\nDone: a title at 2 s.' },
      { type: 'done', usage: { inputTokens: 34000, cachedTokens: 31000, outputTokens: 812, steps: 3 } },
    ])
    expect(shape(reply)).toEqual(['thinking:2000', 'text:I’ll look first.', 'tool:get_project:done', 'thinking:1000', 'tool:add_title:done', 'text:Done: a title at 2 s.'])
    expect(reply.phase).toBe('done')
    expect(reply.activity).toBeUndefined()
    expect(replyText(reply)).toBe('I’ll look first.\n\nDone: a title at 2 s.')
    const title = reply.parts!.find((p) => p.kind === 'tool' && p.tool === 'add_title')
    expect(title).toMatchObject({ title: 'Add a title', detail: 'text: Hello · at_seconds: 2', output: 'added' })
    expect(usageLine({ ...reply, startedAt: 1000 })).toBe('34k tokens in (31k from cache) · 812 out · 3 steps · 13 s')
  })

  it('always says what is going on', () => {
    const at = (events: (AgentEventBody | LocalEvent)[]) => play(events).activity
    expect(at([{ type: 'status', message: 'Getting the tools ready…' }])).toMatchObject({ kind: 'starting', label: 'Getting the tools ready…' })
    expect(at([{ type: 'step', index: 1 }])).toMatchObject({ kind: 'waiting', label: 'Asking the model…', since: 1000 })
    expect(at([{ type: 'step', index: 1 }, { type: 'reasoning', delta: 'hm' }])).toMatchObject({ kind: 'thinking', since: 2000 })
    // A long tool call being written is not silence: the step is there, growing.
    const writing = play([{ type: 'tool-input', callId: 'c1', tool: 'render_hyperframes_html', chars: 0 }, { type: 'tool-input', callId: 'c1', tool: 'render_hyperframes_html', chars: 5200 }])
    expect(writing.activity).toMatchObject({ kind: 'writing', label: 'Preparing: Render a HyperFrames composition', since: 1000 })
    expect(writing.parts).toMatchObject([{ kind: 'tool', status: 'writing', chars: 5200 }])
    // Running, with the tool's own progress on its step.
    const running = play([{ type: 'tool-start', callId: 'c1', tool: 'export_video', input: { format: 'mp4' } }, { type: 'tool-progress', tool: 'export_video', message: '45% — frame 120 of 260' }])
    expect(running.activity).toMatchObject({ kind: 'tool', label: 'Export the video' })
    expect(running.parts).toMatchObject([{ status: 'running', progress: '45% — frame 120 of 260' }])
    // Two tools at once: when one ends, the other is still what's happening.
    const two = play([{ type: 'tool-start', callId: 'a', tool: 'get_frame' }, { type: 'tool-start', callId: 'b', tool: 'get_transcript' }, { type: 'tool-end', callId: 'b', tool: 'get_transcript', ok: true }])
    expect(two.activity).toMatchObject({ kind: 'tool', label: 'Look at the video' })
    expect(play([{ type: 'tool-start', callId: 'a', tool: 'get_frame' }, { type: 'tool-end', callId: 'a', tool: 'get_frame', ok: true }]).activity).toMatchObject({ kind: 'waiting', label: 'Reading the result…' })
  })

  it('puts a tool’s pictures and failures on its own step', () => {
    const reply = play([
      { type: 'tool-start', callId: 'a', tool: 'get_frame', input: { time_seconds: 1 } },
      { type: 'tool-images', tool: 'get_frame', images: ['data:image/png;base64,AAA'] },
      { type: 'tool-end', callId: 'a', tool: 'get_frame', ok: true },
      { type: 'tool-start', callId: 'b', tool: 'clip_update', input: { ids: ['x'] } },
      { type: 'tool-end', callId: 'b', tool: 'clip_update', ok: false, summary: 'Clip not found', output: 'Clip not found' },
      { type: 'note', message: 'The provider didn’t answer. Trying again in 2 s — try 1 of 3.' },
    ])
    expect(reply.parts).toMatchObject([
      { kind: 'tool', tool: 'get_frame', status: 'done', images: ['data:image/png;base64,AAA'] },
      { kind: 'tool', tool: 'clip_update', status: 'error', detail: 'Clip not found', output: 'Clip not found' },
      { kind: 'note', text: 'The provider didn’t answer. Trying again in 2 s — try 1 of 3.' },
    ])
  })

  it('leaves nothing looking busy once it is stopped or has failed', () => {
    const working = play([{ type: 'reasoning', delta: 'thinking hard' }, { type: 'tool-input', callId: 'w', tool: 'batch_edit', chars: 40 }, { type: 'tool-start', callId: 'r', tool: 'export_video' }])
    const stopped = finish(working, 9000, { message: 'Stopped.', code: 'cancelled' })
    expect(shape(stopped)).toEqual(['thinking:1000', 'tool:batch_edit:stopped', 'tool:export_video:stopped'])
    expect(stopped).toMatchObject({ phase: 'done', stopped: true, error: undefined, activity: undefined })
    const failed = applyEvent(working, { type: 'error', message: 'The provider rejected the API key.', code: 'auth' }, 9000)
    expect(shape(failed)).toEqual(['thinking:1000', 'tool:batch_edit:error', 'tool:export_video:error'])
    expect(failed.error).toEqual({ message: 'The provider rejected the API key.', code: 'auth' })
  })

  it('says a failure once when the agent’s last words are the error', () => {
    const said = play([{ type: 'text', delta: 'Failed to authenticate: OAuth session expired' }, { type: 'error', message: 'Failed to authenticate: OAuth session expired', code: 'failed' }])
    expect(shape(said)).toEqual([])
    expect(said.error?.message).toBe('Failed to authenticate: OAuth session expired')
    const other = play([{ type: 'text', delta: 'I added the title.' }, { type: 'error', message: 'The connection dropped.', code: 'failed' }])
    expect(shape(other)).toEqual(['text:I added the title.'])
  })

  it('drops a request that was cut off before it was sent', () => {
    const reply = play([
      { type: 'step', index: 1 },
      { type: 'text', delta: 'I’ll add the' },
      { type: 'tool-input', callId: 'c1', tool: 'add_title', chars: 120 },
      { type: 'note', message: 'The provider didn’t answer. Trying again in 2 s — try 1 of 3.' },
      { type: 'step', index: 2 },
      { type: 'text', delta: 'I’ll add the title.' },
      { type: 'tool-start', callId: 'c2', tool: 'add_title', input: { text: 'Hello' } },
    ])
    expect(shape(reply)).toEqual(['text:I’ll add the', 'note:The provider didn’t answer. Trying again in 2 s — try 1 of 3.', 'text:I’ll add the title.', 'tool:add_title:running'])
  })

  it('reads replies saved by an older version', () => {
    const parts = fromLegacy({ text: 'On it.', reasoning: 'Plan…', thoughtMs: 4000, outro: 'Done.', calls: [{ id: 'c', tool: 'add_title', title: 'Add a title', status: 'done' }, { id: 'd', tool: 'export_video', title: 'Export the video', status: 'running', pictures: 2 }] })
    expect(shape({ parts })).toEqual(['thinking:4000', 'text:On it.', 'tool:add_title:done', 'tool:export_video:error', 'text:Done.'])
  })

  it('writes numbers the way people read them', () => {
    expect([compact(812), compact(1200), compact(34_400), compact(1_100_000)]).toEqual(['812', '1.2k', '34k', '1.1M'])
    expect([duration(800), duration(8000), duration(72_000)]).toEqual(['1 s', '8 s', '1 m 12 s'])
  })
})
