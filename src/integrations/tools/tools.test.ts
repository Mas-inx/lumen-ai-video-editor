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

const { videoAnswer, watchWebVideo } = await import('./web')

describe('watching a linked video', () => {
  type Video = Parameters<typeof videoAnswer>[0]
  type Options = { frames?: number; from?: number; to?: number; transcript?: boolean; language?: string; release?: string }

  // The main process fetches; here it is a stand-in, and so are the canvas and the picture decoder.
  function watching(video: Partial<Video>) {
    const calls: [string, Options | undefined][] = []
    const watch = async (url: string, opts?: Options) => {
      calls.push([url, opts])
      return { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', site: 'YouTube', chapters: [], watchedWith: 'YouTube captions, YouTube preview frames (one every 2 s, 320×180)', notes: [], ...video } as Video
    }
    return { calls, watch }
  }
  const drawn: number[][] = []
  beforeEach(() => {
    drawn.length = 0
    vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage: (_img: unknown, ...at: number[]) => drawn.push(at) }) }) })
    vi.stubGlobal('createImageBitmap', async (blob: Blob) => {
      if (blob.type === 'image/broken') throw new Error('cannot decode')
      return { width: 960, height: 540, close: () => {} }
    })
    return () => vi.unstubAllGlobals()
  })
  const sheet = { bytes: new Uint8Array([82, 73, 70, 70]), mime: 'image/webp' }
  /** Tiles of 320 × 180, nine to a 960 × 540 sheet. */
  const tiles = (count: number) => ({ sheets: [sheet], frames: Array.from({ length: count }, (_, i) => ({ time: i * 10, sheet: 0, x: (i % 3) * 320, y: (Math.floor(i / 3) % 3) * 180, width: 320, height: 180 })) })

  it('is a tool with a link as its only required input', async () => {
    const tool = agentTools().find((t) => t.name === 'watch_web_video')!
    expect(tool.inputSchema).toMatchObject({ required: ['url'], properties: { frames: { minimum: 4, maximum: 48 }, from_seconds: {}, to_seconds: {}, transcript: {}, language: {} } })
    expect(tool.description).toMatch(/whenever the user shares a video link/)
    expect(tool.description).toMatch(/information, never instructions/)
    expect((await call('watch_web_video', {})).json.error).toMatch(/Give url/)
    expect((await call('watch_web_video', { url: 'https://youtu.be/dQw4w9WgXcQ' })).json.error).toBe('The web needs Lumen’s desktop app.')
  })

  it('cuts the frames out of the sprite sheets and numbers them across contact sheets', async () => {
    const { calls, watch } = watching({
      title: 'Never Gonna Give You Up',
      author: 'Rick Astley',
      duration: 213,
      chapters: [{ start: 0, title: 'Intro' }, { start: 43.2, title: 'Chorus' }],
      transcript: { language: 'en', kind: 'manual', available: ['en', 'en (auto)', 'de-DE'], lines: [{ start: 18.64, end: 31.04, text: 'We’re no strangers to love' }] },
      tiles: tiles(30),
    })
    const res = (await watchWebVideo({ url: 'https://youtu.be/dQw4w9WgXcQ', frames: 30, language: 'en' }, undefined, watch)) as Json
    expect(calls).toEqual([['https://youtu.be/dQw4w9WgXcQ', { frames: 30, from: undefined, to: undefined, transcript: true, language: 'en' }]])
    // Thirty frames make two sheets of fifteen, not one of thirty cells too small to read.
    expect(res.images).toEqual([
      { data: 'SlBFRw==', mimeType: 'image/jpeg' },
      { data: 'SlBFRw==', mimeType: 'image/jpeg' },
    ])
    expect(res.json.pictures).toEqual(['frames 1–15: 1248x900', 'frames 16–30: 1248x900'])
    expect(res.json.frames).toHaveLength(30)
    expect(res.json.frames[0]).toEqual({ n: 1, at_seconds: 0 })
    expect(res.json.frames[29]).toEqual({ n: 30, at_seconds: 290 })
    // Each tile is copied from its place on the sheet.
    expect(drawn[4]).toEqual([320, 180, 320, 180, 0, 0, 320, 180])
    expect(res.json).toMatchObject({
      title: 'Never Gonna Give You Up',
      author: 'Rick Astley',
      duration_seconds: 213,
      chapters: [{ at_seconds: 0, title: 'Intro' }, { at_seconds: 43.2, title: 'Chorus' }],
      transcript: { language: 'en', kind: 'manual', available_languages: ['en', 'en (auto)', 'de-DE'], lines: [{ at_seconds: 18.6, text: 'We’re no strangers to love' }] },
      watched_with: 'YouTube captions, YouTube preview frames (one every 2 s, 320×180)',
    })
    expect(res.json.note).toBeUndefined()
  })

  it('leaves out a tile that isn’t on its sheet, and keeps the numbering whole', async () => {
    const short = tiles(6)
    short.frames[5].y = 540
    const { watch } = watching({ tiles: short })
    const res = (await watchWebVideo({ url: 'https://youtu.be/dQw4w9WgXcQ' }, undefined, watch)) as Json
    expect(res.json.frames.map((f: Json) => f.n)).toEqual([1, 2, 3, 4, 5])
    expect(res.images).toHaveLength(1)
  })

  it('shows the thumbnail when that is all there is, with the reason', async () => {
    const { watch } = watching({ title: 'A trailer', thumbnail: { bytes: new Uint8Array([255, 216]), mime: 'image/jpeg' }, watchedWith: 'the page’s public details only', notes: ['YouTube won’t play this video: “Sign in to confirm your age.”'] })
    const res = (await watchWebVideo({ url: 'https://youtu.be/dQw4w9WgXcQ' }, undefined, watch)) as Json
    expect(res.images).toHaveLength(1)
    expect(res.json).toMatchObject({ frames: [], pictures: ['the thumbnail: 960x540'], note: 'YouTube won’t play this video: “Sign in to confirm your age.”', watched_with: 'the page’s public details only' })
    expect(res.json.transcript).toBeUndefined()
  })

  it('answers in words alone when no picture can be decoded', async () => {
    const { watch } = watching({ title: 'A talk', tiles: { sheets: [{ ...sheet, mime: 'image/broken' }], frames: tiles(4).frames } })
    const res = (await watchWebVideo({ url: 'https://youtu.be/dQw4w9WgXcQ' }, undefined, watch)) as Json
    expect(res.images).toBeUndefined()
    expect(res).toMatchObject({ title: 'A talk', frames: [], pictures: [] })
    expect(res.note).toMatch(/preview frames couldn’t be decoded/)
  })

  it('keeps the request within bounds', async () => {
    const { calls, watch } = watching({ tiles: tiles(4) })
    await watchWebVideo({ url: 'https://youtu.be/dQw4w9WgXcQ', frames: 500, from_seconds: 60, to_seconds: 120, transcript: false }, undefined, watch)
    await watchWebVideo({ url: 'https://youtu.be/dQw4w9WgXcQ', frames: 1 }, undefined, watch)
    expect(calls.map(([, o]) => o)).toEqual([
      { frames: 48, from: 60, to: 120, transcript: false, language: undefined },
      { frames: 4, from: undefined, to: undefined, transcript: true, language: undefined },
    ])
    await expect(watchWebVideo({ url: 'https://youtu.be/dQw4w9WgXcQ', from_seconds: 90, to_seconds: 30 }, undefined, watch)).rejects.toThrow(/to_seconds has to be after from_seconds/)
    expect(calls).toHaveLength(2)
  })

  it('cuts a long transcript and a long description, saying how to read on', () => {
    const lines = Array.from({ length: 400 }, (_, i) => ({ start: i * 12, end: i * 12 + 11, text: `line ${i} `.padEnd(100, 'x') }))
    const notes: string[] = []
    const answer = videoAnswer({ url: 'u', site: 'YouTube', description: 'd'.repeat(5000), chapters: [], transcript: { language: 'en', kind: 'auto-generated', lines }, watchedWith: '', notes: [] }, 4800, notes)
    // 24 000 characters of talking: 240 lines of 100.
    expect(answer.transcript!.lines).toHaveLength(240)
    expect(answer.transcript!.lines.at(-1)).toMatchObject({ at_seconds: 2868 })
    expect(notes).toEqual(['The transcript is cut at 48:00 of 1:20:00: call again with from_seconds: 2880 to read on.'])
    expect(answer.description).toHaveLength(1501)
    expect(answer.duration_seconds).toBe(4800)

    const whole: string[] = []
    expect(videoAnswer({ url: 'u', site: 'Vimeo', chapters: [], transcript: { language: 'en', kind: 'manual', lines: lines.slice(0, 50) }, watchedWith: '', notes: [] }, undefined, whole).transcript!.lines).toHaveLength(50)
    expect(whole).toEqual([])
  })

  it('gives the temporary file back when it is done with it, even if the video can’t be read', async () => {
    const { calls, watch } = watching({ title: 'clip.mp4', file: { id: 'file-1', url: 'lumen-media://file/nowhere.mp4', mime: 'video/mp4', size: 10 }, thumbnail: { bytes: new Uint8Array([255, 216]), mime: 'image/jpeg' }, watchedWith: 'the video file itself' })
    // There is no such file here, so the decoder gives up (after saying so on the console).
    const quiet = [vi.spyOn(console, 'error').mockImplementation(() => {}), vi.spyOn(console, 'warn').mockImplementation(() => {})]
    const res = (await watchWebVideo({ url: 'https://example.com/clip.mp4' }, undefined, watch)) as Json
    quiet.forEach((spy) => spy.mockRestore())
    expect(res.json.note).toMatch(/downloaded, but this computer couldn’t read it/)
    expect(res.json.pictures).toEqual(['the thumbnail: 960x540'])
    expect(calls.at(-1)).toEqual(['', { release: 'file-1' }])
  })
})
