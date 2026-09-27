import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Asset, Project } from '@/editor/types'

// Rendering needs a real canvas; here stills are stand-ins so the tool plumbing can be tested in Node.
vi.mock('@/engine/stills', () => ({
  timelineStills: async (_p: Project, frames: number[], width: number) => frames.map(() => ({ width, height: Math.round((width * 9) / 16) })),
  mediaStills: async (_a: Asset, times: number[], width: number) => times.map(() => ({ width, height: Math.round((width * 9) / 16) })),
  contactSheet: (cells: unknown[]) => ({ width: 1248, height: 180 * Math.ceil(cells.length / 3) }),
  canvasBase64: () => 'SlBFRw==',
}))

// The timeline mix: a stereo tone at −23 dBFS with two seconds of silence in the middle.
const RATE = 48000
function toneWithGap(seconds: number, gapFrom: number, gapTo: number) {
  const a = Math.pow(10, -23 / 20)
  const data = Float32Array.from({ length: seconds * RATE }, (_, i) => {
    const t = i / RATE
    return t >= gapFrom && t < gapTo ? 0 : a * Math.sin(2 * Math.PI * 997 * t)
  })
  return { sampleRate: RATE, length: data.length, duration: seconds, numberOfChannels: 2, getChannelData: () => data } as unknown as AudioBuffer
}
vi.mock('@/engine/audio-engine', async (original) => ({
  ...(await original<typeof import('@/engine/audio-engine')>()),
  prepareAudio: async () => {},
  renderMix: async (_p: Project, from: number, to: number) => toneWithGap(Math.round(to - from), 3, 5),
}))

const { agentTools, runAgentTool } = await import('../agent-tools')
const { onToolImages } = await import('./events')
const { useEditor, getProject, dispatch } = await import('@/editor/store')
const { createEmptyProject } = await import('@/editor/new-project')
const { createClip } = await import('@/editor/defaults')

type Json = Record<string, any>

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = await runAgentTool(name, args)
  const text = res.content.find((c) => c.type === 'text')
  return { ...res, json: (res.isError ? { error: text && 'text' in text ? text.text : '' } : res.structuredContent) as Json }
}

const trackId = (name: string) => getProject().tracks.find((t) => t.name === name)!.id

function voiceAsset(): Asset {
  return {
    id: 'asset_voice',
    name: 'Interview',
    kind: 'audio',
    duration: 10,
    hasAudio: true,
    source: { type: 'file', url: 'lumen-media://file/interview.wav', mime: 'audio/wav', fileName: 'interview.wav', size: 1 },
    transcript: [
      { start: 0.5, end: 2.5, text: 'We drove up to the mountains' },
      { start: 4, end: 6, text: 'The light was perfect' },
    ],
    addedAt: 1,
  }
}

beforeEach(() => {
  const p = createEmptyProject('Tools')
  const asset = voiceAsset()
  p.assets[asset.id] = asset
  const voice = createClip({ kind: 'audio', trackId: p.tracks.find((t) => t.name === 'Voice')!.id, start: 0, duration: 300, assetId: asset.id, name: 'Interview' })
  p.clips[voice.id] = voice
  useEditor.getState().loadProject(p)
})

describe('the registry', () => {
  it('has unique names and a description and object schema for every tool', () => {
    const tools = agentTools()
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length)
    for (const t of tools) {
      expect(t.description.length, t.name).toBeGreaterThan(20)
      expect(t.inputSchema.type, t.name).toBe('object')
    }
    for (const name of ['get_frame', 'get_contact_sheet', 'get_media_frames', 'get_editor_screenshot', 'get_clips_at', 'get_clip', 'find_media', 'get_transcript', 'analyze_audio', 'get_history', 'list_catalog', 'batch_edit', 'add_title', 'undo', 'redo', 'select_clips', 'playback', 'save_project', 'export_video', 'timeline_removeRange']) {
      expect(tools.some((t) => t.name === name), name).toBe(true)
    }
  })

  it('answers unknown tools with an error, not a crash', async () => {
    const res = await runAgentTool('get_everything', {})
    expect(res.isError).toBe(true)
  })
})

describe('vision tools', () => {
  it('return the picture as an image block and show it to the UI', async () => {
    const seen: string[] = []
    const off = onToolImages((tool, images) => seen.push(`${tool}:${images.length}`))
    const res = await call('get_frame', { time_seconds: 2 })
    off()
    expect(res.content.map((c) => c.type)).toEqual(['text', 'image'])
    expect(res.content[1]).toMatchObject({ type: 'image', mimeType: 'image/jpeg', data: 'SlBFRw==' })
    expect(res.json).toMatchObject({ frame: 60, time_seconds: 2, image: '1024x576' })
    expect(seen).toEqual(['get_frame:1'])
  })

  it('clamp past the end and explain it', async () => {
    const res = await call('get_frame', { time_seconds: 99 })
    expect(res.json).toMatchObject({ frame: 299 })
    expect(res.json.note).toMatch(/past the end/)
  })

  it('sample a contact sheet from the middle of each slice', async () => {
    const res = await call('get_contact_sheet', { count: 4 })
    expect(res.json.frames.map((f: Json) => f.frame)).toEqual([37, 112, 187, 262])
    expect(res.content.filter((c) => c.type === 'image')).toHaveLength(1)
  })

  it('refuse to look at an empty timeline, pointing at the media instead', async () => {
    useEditor.getState().loadProject(createEmptyProject('Empty'))
    const res = await call('get_frame')
    expect(res.isError).toBe(true)
    expect(res.json.error).toMatch(/get_media_frames/)
  })

  it('explain that audio has no pictures', async () => {
    const res = await call('get_media_frames', { asset_id: 'asset_voice' })
    expect(res.isError).toBe(true)
    expect(res.json.error).toMatch(/is audio — it has no pictures.*get_transcript/)
    const missing = await call('get_media_frames', { asset_id: 'nope' })
    expect(missing.json.error).toMatch(/No media with id “nope”.*asset_voice \(Interview\)/)
  })
})

describe('inspection tools', () => {
  it('get_clips_at applies keyframes at that exact frame', async () => {
    const r = dispatch('clip.add', { trackId: trackId('Titles'), kind: 'text', start: 0, duration: 90 })
    const id = (r as { result: string }).result
    dispatch('keyframe.set', { clipId: id, prop: 'opacity', frame: 0, value: 0 })
    dispatch('keyframe.set', { clipId: id, prop: 'opacity', frame: 60, value: 1 })
    const res = await call('get_clips_at', { time_seconds: 1 })
    const title = res.json.clips.find((c: Json) => c.clip_id === id)
    expect(title.transform.opacity).toBeCloseTo(0.5, 2)
    expect(res.json.clips.find((c: Json) => c.kind === 'audio')).toMatchObject({ asset_id: 'asset_voice', source_seconds: 1 })
  })

  it('get_clip returns every property and flags missing ids', async () => {
    const voice = Object.values(getProject().clips)[0]
    const res = await call('get_clip', { clip_ids: [voice.id, 'ghost'] })
    expect(res.json.clips[0]).toMatchObject({ id: voice.id, audio: { volume: 0 }, source_in_seconds: 0, source_out_seconds: 10 })
    expect(res.json.missing).toEqual(['ghost'])
  })

  it('find_media searches inside transcripts', async () => {
    const res = await call('find_media', { query: 'light perfect' })
    expect(res.json.found).toBe(1)
    expect(res.json.media[0].said).toEqual([{ start: 4, end: 6, text: 'The light was perfect' }])
    expect((await call('find_media', { query: 'volcano' })).json.found).toBe(0)
  })

  it('get_transcript maps speech to the timeline', async () => {
    const res = await call('get_transcript')
    expect(res.json.lines.map((l: Json) => [l.start, l.text])).toEqual([
      [0.5, 'We drove up to the mountains'],
      [4, 'The light was perfect'],
    ])
    const media = await call('get_transcript', { asset_id: 'asset_voice', from_seconds: 3 })
    expect(media.json.lines).toHaveLength(1)
  })

  it('analyze_audio measures loudness and finds the silence', async () => {
    const res = await call('analyze_audio')
    expect(res.json.loudness_lufs).toBeCloseTo(-23, 0)
    expect(res.json.silences).toEqual([[3, 5]])
    expect(res.json.advice.join(' ')).toMatch(/Quieter than online video usually is.*raise it by about 9 dB/)
  })

  it('list_catalog gives exact ids', async () => {
    const res = await call('list_catalog', { section: 'transitions' })
    expect(Object.keys(res.json)).toEqual(['transitions'])
    expect(res.json.transitions.some((t: Json) => t.kind === 'dissolve')).toBe(true)
  })
})

describe('control tools', () => {
  it('batch_edit applies everything as one undo step', async () => {
    const res = await call('batch_edit', {
      commands: [
        { command: 'track_add', input: { id: 'track_broll', kind: 'video', name: 'B-roll' } },
        { command: 'clip.add', input: { id: 'clip_card', trackId: 'track_broll', kind: 'text', start: 0, duration: 30 } },
        { command: 'marker_add', input: { frame: 15, label: 'Card' } },
      ],
      label: 'Build the opening',
    })
    expect(res.json).toMatchObject({ applied: 3, failed: 0 })
    expect(getProject().clips.clip_card.trackId).toBe('track_broll')
    const past = useEditor.getState().past
    expect(past.at(-1)).toMatchObject({ label: 'Build the opening', source: 'ai' })
    await call('undo')
    expect(getProject().clips.clip_card).toBeUndefined()
    expect(getProject().tracks.some((t) => t.id === 'track_broll')).toBe(false)
  })

  it('batch_edit changes nothing when a step fails', async () => {
    const before = JSON.stringify(getProject())
    const steps = useEditor.getState().past.length
    const res = await call('batch_edit', {
      commands: [
        { command: 'marker_add', input: { frame: 1 } },
        { command: 'clip_update', input: { ids: ['ghost'], patch: { name: 'x' } } },
      ],
    })
    expect(res.isError).toBe(true)
    expect(res.json.error).toMatch(/Step 2 \(clip_update\) failed.*Nothing was changed/)
    expect(JSON.stringify(getProject())).toBe(before)
    expect(useEditor.getState().past).toHaveLength(steps)
  })

  it('batch_edit rejects unknown commands before touching anything', async () => {
    const res = await call('batch_edit', { commands: [{ command: 'marker_add', input: { frame: 1 } }, { command: 'make_it_pop', input: {} }] })
    expect(res.json.error).toMatch(/Unknown command #2 “make_it_pop”/)
    expect(getProject().markers).toHaveLength(0)
  })

  it('add_title styles from a preset, scaled and placed in seconds', async () => {
    const res = await call('add_title', { text: 'Day one', at_seconds: 2, duration_seconds: 3, preset: 'cinematic', position: 'bottom' })
    const clip = getProject().clips[res.json.clip_id]
    expect(clip).toMatchObject({ kind: 'text', start: 60, duration: 90, trackId: trackId('Titles') })
    expect(clip.text).toMatchObject({ content: 'Day one', uppercase: true, size: 104 })
    expect(clip.transform.y).toBeGreaterThan(0)
    expect(res.json).toMatchObject({ start_seconds: 2, end_seconds: 5 })
  })

  it('add_title leaves nothing behind when it fails', async () => {
    const steps = useEditor.getState().past.length
    const res = await call('add_title', { text: 'Hi', track_id: 'no_such_track' })
    expect(res.json.error).toMatch(/No track with id “no_such_track”/)
    expect(useEditor.getState().past).toHaveLength(steps)
  })

  it('undo and redo report what they did, and get_history shows who did it', async () => {
    await call('add_title', { text: 'One' })
    const history = await call('get_history')
    expect(history.json.undo[0]).toMatchObject({ label: 'Title “One”', by: 'ai' })
    expect((await call('undo')).json.undone).toEqual(['Title “One”'])
    expect((await call('redo')).json.redone).toEqual(['Title “One”'])
    useEditor.getState().loadProject(createEmptyProject('Fresh'))
    expect((await call('undo')).json.error).toBe('Nothing to undo.')
  })
})

describe('timeline and footage tools', () => {
  it('are all registered, with the timeline commands', () => {
    const names = new Set(agentTools().map((t) => t.name))
    for (const name of ['list_timelines', 'import_subtitles', 'export_subtitles', 'detect_scenes', 'create_multicam', 'stabilize_clip', 'track_motion', 'render_queue', 'sequence_create', 'sequence_open', 'sequence_duplicate', 'clip_nest', 'clip_unnest', 'multicam_create', 'multicam_switch']) {
      expect(names.has(name), name).toBe(true)
    }
  })

  it('import_subtitles lays SRT text as captions and export_subtitles reads them back', async () => {
    const res = await call('import_subtitles', { text: '1\n00:00:01,000 --> 00:00:02,000\nHello\n\n2\n00:00:03,000 --> 00:00:04,500\nWorld\n', offset_seconds: 1 })
    expect(res.json).toMatchObject({ captions_added: 2, cues_in_file: 2 })
    const out = await call('export_subtitles', { format: 'vtt', save: false })
    expect(out.json.text).toBe('WEBVTT\n\n00:00:02.000 --> 00:00:03.000\nHello\n\n00:00:04.000 --> 00:00:05.500\nWorld\n')
    expect((await call('import_subtitles', {})).json.error).toMatch(/Give path/)
  })

  it('list_timelines and get_project show every timeline', async () => {
    const created = await call('sequence_create', { name: 'Shorts', settings: { width: 1080, height: 1920 }, open: false })
    const id = created.json.result as string
    const list = await call('list_timelines')
    expect(list.json.timelines.map((t: Json) => [t.name, t.open, t.size])).toEqual([
      ['Main timeline', true, '1920x1080'],
      ['Shorts', false, '1080x1920'],
    ])
    const project = await call('get_project')
    expect(project.json.timeline).toMatchObject({ name: 'Main timeline' })
    expect(project.json.other_timelines).toEqual([{ id, name: 'Shorts' }])
    await call('sequence_open', { id })
    expect((await call('get_project')).json.timeline).toMatchObject({ id, name: 'Shorts' })
  })

  it('track_motion needs a box and explains what it follows', async () => {
    const r = dispatch('clip.add', { trackId: trackId('Titles'), kind: 'text', start: 0, duration: 90 })
    const id = (r as { result: string }).result
    expect((await call('track_motion', { clip_id: id })).json.error).toMatch(/box_fraction/)
    expect((await call('track_motion', { clip_id: id, box_fraction: { x: 0.5, y: 0.5, width: 0.1, height: 0.1 } })).json.error).toMatch(/no video under this clip/)
  })
})
