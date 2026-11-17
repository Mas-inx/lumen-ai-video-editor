import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Asset, Project, SpeechSegment } from '@/editor/types'
import type { FrameSample, SoundMeasure, TextBox } from '@/editor/quality'

// Rendering and decoding need a browser: the measured picture and sound are stand-ins here.
const measured: { sound?: SoundMeasure; frames?: FrameSample[]; boxes?: Record<string, TextBox> } = {}
const calls: string[] = []
vi.mock('@/engine/edit-check', () => ({
  measureSound: async (_p: Project, from: number, to: number) => {
    calls.push(`sound ${from}–${to}`)
    return measured.sound ?? { from, levels: [], lufs: -14, peakDb: -3, clipped: [] }
  },
  measurePicture: async (_p: Project, frames: number[]) => {
    calls.push(`picture ${frames.length}`)
    return measured.frames ?? []
  },
  measureTextBoxes: async () => measured.boxes ?? {},
}))
vi.mock('@/engine/audio-engine', async (original) => ({
  ...(await original<typeof import('@/engine/audio-engine')>()),
  // Nothing decodes in Node: speech is known from transcripts.
  loadAudio: async () => null,
  activeRegionsStreamed: async () => null,
}))

const { agentTools, runAgentTool } = await import('../agent-tools')
const { useEditor, getProject } = await import('@/editor/store')
const { createEmptyProject } = await import('@/editor/new-project')
const { createClip } = await import('@/editor/defaults')

type Json = Record<string, any>

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = await runAgentTool(name, args)
  const text = res.content.find((c) => c.type === 'text')
  return { ...res, json: (res.isError ? { error: text && 'text' in text ? text.text : '' } : res.structuredContent) as Json }
}

/** A phrase whose words the transcriber timed: each word 0.3 s with 0.1 s between. */
function said(start: number, text: string): SpeechSegment {
  let t = start
  const words = text.split(' ').map((w) => {
    const x = { start: t, end: t + 0.3, text: w }
    t += 0.4
    return x
  })
  return { start, end: words[words.length - 1].end, text, words }
}

function load(transcript: SpeechSegment[] | null) {
  const p = createEmptyProject('Review')
  const asset: Asset = {
    id: 'asset_talk',
    name: 'Talk',
    kind: 'audio',
    duration: 15,
    hasAudio: true,
    source: { type: 'file', url: 'lumen-media://file/talk.wav', mime: 'audio/wav', fileName: 'talk.wav', size: 1 },
    ...(transcript ? { transcript } : {}),
    addedAt: 1,
  }
  p.assets[asset.id] = asset
  const voice = createClip({ kind: 'audio', trackId: p.tracks.find((t) => t.name === 'Voice')!.id, start: 0, duration: 450, assetId: asset.id, name: 'Talk' })
  p.clips[voice.id] = voice
  useEditor.getState().loadProject(p)
  return voice
}

const TAKES = [said(0, 'Hello everyone.'), said(1.5, 'So the first thing we—'), said(4, 'So the first thing we need is a plan.'), said(8.5, 'We built it in twenty days.'), said(11.5, 'We built it in thirty days.')]

beforeEach(() => {
  calls.length = 0
  delete measured.sound
  delete measured.frames
  delete measured.boxes
})

describe('review tools', () => {
  it('are registered with object schemas', () => {
    const tools = agentTools()
    for (const name of ['find_repeated_takes', 'remove_speech', 'check_quality']) {
      const tool = tools.find((t) => t.name === name)
      expect(tool, name).toBeDefined()
      expect(tool!.inputSchema.type).toBe('object')
    }
  })
})

describe('find_repeated_takes', () => {
  it('groups the takes with times in seconds, the take to keep, why and how sure — and lists every sentence', async () => {
    load(TAKES)
    const res = await call('find_repeated_takes')
    expect(res.json.groups).toHaveLength(2)
    const [restart, differ] = res.json.groups
    expect(restart).toMatchObject({ kind: 'restart', keep: 2, sure: true, track: 'Voice' })
    expect(restart.takes.map((t: Json) => [t.take, t.text, t.start_seconds])).toEqual([
      [1, 'So the first thing we—', 1.5],
      [2, 'So the first thing we need is a plan.', 4],
    ])
    expect(differ).toMatchObject({ kind: 'similar', sure: false })
    expect(differ.reason).toMatch(/“twenty” where take 2 has “thirty”/)
    expect(res.json.sure_groups).toBe(1)
    expect(res.json.sentences.map((s: Json) => s.text)).toEqual(['Hello everyone.', 'So the first thing we—', 'So the first thing we need is a plan.', 'We built it in twenty days.', 'We built it in thirty days.'])
    expect(res.json.sentences[1]).toMatchObject({ id: restart.takes[0].sentence_id, start_seconds: 1.5, track: 'Voice' })
  })

  it('says to transcribe first when nothing is', async () => {
    load(null)
    const res = await call('find_repeated_takes')
    expect(res.isError).toBe(true)
    expect(res.json.error).toMatch(/transcribe_media for: asset_talk \(Talk\)/)
  })
})

describe('remove_speech', () => {
  it('keeps the chosen take, cuts between words in one undo step, and says what follows the join', async () => {
    load(TAKES)
    const { json: found } = await call('find_repeated_takes', { sentences: false })
    const steps = useEditor.getState().past.length
    const res = await call('remove_speech', { takes: [{ group_id: found.groups[0].group_id, keep: 2 }] })
    expect(res.isError).toBeFalsy()
    expect(res.json.cuts).toHaveLength(1)
    const [cut] = res.json.cuts
    // From just before “So” (1.46 s) to a breath before the full take (3.9 s).
    expect(cut).toMatchObject({ from_seconds: 1.467, to_seconds: 3.9, removed: 'So the first thing we—', join_at_seconds: 1.467 })
    expect(cut.next).toEqual({ text: 'So the first thing we need is a plan.', now_starts_at_seconds: 1.57 })
    expect(res.json.repetition_left).toEqual([expect.objectContaining({ kind: 'similar' })])
    expect(useEditor.getState().past).toHaveLength(steps + 1)
    expect(useEditor.getState().past.at(-1)).toMatchObject({ label: 'Cut speech', source: 'ai' })
  })

  it('plans without changing anything on a dry run, and cuts every sure group with sure_takes', async () => {
    load(TAKES)
    const before = JSON.stringify(getProject())
    const plan = await call('remove_speech', { sure_takes: true, dry_run: true })
    expect(plan.json).toMatchObject({ dry_run: true, cuts: [expect.objectContaining({ removed: 'So the first thing we—' })] })
    expect(JSON.stringify(getProject())).toBe(before)
    const res = await call('remove_speech', { sure_takes: true })
    expect(res.json.cuts).toHaveLength(1)
  })

  it('moves a range off the middle of a word, and explains a stale group id', async () => {
    load(TAKES)
    // “Hello” is 0.0–0.3 s and “everyone.” 0.4–0.7 s. Starting two thirds into “Hello” takes it whole…
    const most = await call('remove_speech', { ranges: [[0.1, 0.75]], dry_run: true })
    expect(most.json.cuts).toEqual([{ from_seconds: 0, to_seconds: 0.767, seconds: 0.767, removed: 'Hello everyone.', notes: ['Took all of “Hello” at 0:00.0: the range went through it.'] }])
    // …starting near its end leaves it whole, a breath clear of it.
    const little = await call('remove_speech', { ranges: [[0.2, 0.75]], dry_run: true })
    expect(little.json.cuts).toEqual([{ from_seconds: 0.367, to_seconds: 0.767, seconds: 0.4, removed: 'everyone.', notes: ['Kept “Hello” at 0:00.0 whole: the range only clipped it.'] }])
    const stale = await call('remove_speech', { takes: [{ group_id: 'g-zzzz@1', keep: 1 }] })
    expect(stale.json.error).toMatch(/No group g-zzzz@1 now — the timeline changed since\. Call find_repeated_takes again/)
    const nothing = await call('remove_speech', {})
    expect(nothing.json.error).toMatch(/Nothing to cut/)
  })
})

describe('check_quality', () => {
  it('reports problems with times, severities and fixes as commands batch_edit runs — and whether the edit is finished', async () => {
    const voice = load(TAKES)
    measured.sound = { from: 0, levels: Array.from({ length: 750 }, () => -30), lufs: -25, peakDb: -8, clipped: [] }
    const res = await call('check_quality')
    expect(calls).toEqual(['sound 0–15', 'picture 30'])
    expect(res.json.finished).toBe(true)
    expect(res.json.summary).toMatch(/warning/)
    const loud = res.json.issues.find((i: Json) => i.check === 'loudness')
    // Peaks at −8 dBFS raised 11 dB would clip: a limiter comes with it.
    expect(loud).toMatchObject({ severity: 'warning', at_seconds: 0, fix: { label: 'Raise the master 11 dB (with a limiter)', commands: [{ command: 'mix_update', input: { target: 'master', patch: { volume: 11, limiter: { enabled: true, ceiling: -1 } } } }] } })
    // A timeline of sound alone has no picture to miss.
    expect(res.json.issues.some((i: Json) => i.check === 'gap')).toBe(false)
    expect(res.json.loudness_lufs).toBe(-25)
    // The fix runs as it is.
    const fixed = await call('batch_edit', { commands: loud.fix.commands })
    expect(fixed.json).toMatchObject({ applied: 1, failed: 0 })
    expect(getProject().master?.volume).toBe(11)
    expect(getProject().clips[voice.id]).toBeDefined()
  })

  it('critical issues mean the edit isn’t finished; the timeline alone can be checked', async () => {
    load(TAKES)
    const p = getProject()
    useEditor.getState().loadProject({ ...p, assets: { ...p.assets, asset_talk: { ...p.assets.asset_talk, source: { ...(p.assets.asset_talk.source as Extract<Asset['source'], { type: 'file' }>), missing: true } } } })
    const res = await call('check_quality', { picture: false, sound: false })
    expect(calls).toEqual([])
    expect(res.json).toMatchObject({ finished: false, checked: ['the timeline only'] })
    expect(res.json.summary).toMatch(/Critical issues mean the edit isn’t finished/)
    expect(res.json.issues[0]).toMatchObject({ severity: 'critical', check: 'offline' })
  })
})
