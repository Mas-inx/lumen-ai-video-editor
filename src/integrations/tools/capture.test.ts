import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CaptureSource } from '@shared/capture'
import type { Asset } from '@/editor/types'

// Pictures need a real canvas; the tools' plumbing doesn't.
vi.mock('@/engine/stills', () => ({
  timelineStills: async () => [],
  mediaStills: async () => [],
  contactSheet: () => ({ width: 1248, height: 180 }),
  canvasBase64: () => 'SlBFRw==',
}))

const { agentTools, runAgentTool } = await import('../agent-tools')
const { findSource, gameWindow, allowAgentCapture } = await import('./capture')
const { clipClicks } = await import('@/capture/click-actions')
const { useEditor, getProject } = await import('@/editor/store')
const { createEmptyProject } = await import('@/editor/new-project')
const { createClip } = await import('@/editor/defaults')
const { propAt } = await import('@/editor/keyframes')

type Json = Record<string, any>

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = await runAgentTool(name, args)
  const text = res.content.find((c) => c.type === 'text')
  return { ...res, json: (res.isError ? { error: text && 'text' in text ? text.text : '' } : res.structuredContent) as Json }
}

const sources: CaptureSource[] = [
  { id: 'screen:0:0', kind: 'screen', name: 'Screen 1', width: 3840, height: 2160, primary: true },
  { id: 'screen:1:0', kind: 'screen', name: 'Screen 2', width: 1920, height: 1080 },
  { id: 'window:100:0', kind: 'window', name: 'FiveM', hwnd: 100, pid: 1, process: 'FiveM.exe', width: 900, height: 600 },
  { id: 'window:101:0', kind: 'window', name: 'FiveM® by Cfx.re - Goonsquad RP', hwnd: 101, pid: 2, process: 'FiveM_b3258_GTAProcess.exe', width: 2560, height: 1440 },
  { id: 'window:102:0', kind: 'window', name: 'Lumen docs - Google Chrome', hwnd: 102, pid: 3, process: 'chrome.exe', width: 1600, height: 900 },
  { id: 'window:103:0', kind: 'window', name: 'Inbox - Google Chrome', hwnd: 103, pid: 3, process: 'chrome.exe', width: 2000, height: 1200 },
  { id: 'window:104:0', kind: 'window', name: 'Notes', hwnd: 104, pid: 4, process: 'notepad.exe', width: 800, height: 600, minimized: true },
]

describe('finding what an agent means', () => {
  it('takes an id as it is', () => {
    expect(findSource(sources, 'window:102:0').name).toBe('Lumen docs - Google Chrome')
  })

  it('knows screens by number, and the primary one by default', () => {
    expect(findSource(sources, 'screen').id).toBe('screen:0:0')
    expect(findSource(sources, 'Screen 2').id).toBe('screen:1:0')
    expect(findSource(sources, 'monitor 1').id).toBe('screen:0:0')
    expect(() => findSource(sources, 'screen 3')).toThrow(/no screen 3/)
  })

  it('matches words against a window’s title and its app, the app first and the larger window before the smaller', () => {
    expect(findSource(sources, 'chrome').id).toBe('window:103:0')
    expect(findSource(sources, 'chrome lumen').id).toBe('window:102:0')
    expect(findSource(sources, 'goonsquad').id).toBe('window:101:0')
    expect(findSource(sources, 'GTAProcess').id).toBe('window:101:0')
  })

  it('says why when nothing matches, or when the window is minimized', () => {
    expect(() => findSource(sources, 'blender')).toThrow(/No screen or window matches “blender”/)
    expect(() => findSource(sources, 'notepad')).toThrow(/minimized/)
    expect(() => findSource(sources, '  ')).toThrow(/Say what to record/)
  })

  it('picks the game’s own window, not its launcher', () => {
    expect(gameWindow(sources).id).toBe('window:101:0')
    expect(gameWindow(sources, 'chrome lumen').id).toBe('window:102:0')
    expect(() => gameWindow(sources.filter((s) => !/fivem/i.test(s.process ?? '')))).toThrow(/game’s window wasn’t found/)
  })
})

function recording(): Asset {
  return {
    id: 'asset_rec',
    name: 'Demo',
    kind: 'video',
    duration: 20,
    width: 1920,
    height: 1080,
    fps: 30,
    hasAudio: true,
    source: { type: 'file', url: 'lumen-media://file/demo.mp4', mime: 'video/mp4', fileName: 'demo.mp4', size: 1 },
    cursor: {
      rate: 30,
      moves: [0, 0.5, 0.5],
      clicks: [
        { t: 5, x: 0.25, y: 0.5, button: 'left', held: 0.08 },
        { t: 6, x: 0.75, y: 0.5, button: 'left' },
        { t: 9, x: 0.5, y: 0.5, button: 'right' },
        { t: 14, x: 0.5, y: 0.25, button: 'left' },
      ],
    },
    addedAt: 1,
  }
}

let clipId = ''

beforeEach(() => {
  const p = createEmptyProject('Recording')
  p.settings = { ...p.settings, width: 1920, height: 1080, fps: 30 }
  const asset = recording()
  p.assets[asset.id] = asset
  // The clip starts two seconds into the recording, one second into the timeline.
  // (Not on the main track, which closes up to the start.)
  const clip = createClip({ kind: 'video', trackId: p.tracks.find((t) => t.kind === 'video' && !t.role)!.id, start: 30, duration: 450, assetId: asset.id, inPoint: 60, name: 'Demo' })
  p.clips[clip.id] = clip
  clipId = clip.id
  useEditor.getState().loadProject(p)
  allowAgentCapture(false)
})

describe('clicks on a clip', () => {
  it('are the ones inside it, at the clip’s own frames', () => {
    expect(clipClicks(getProject().clips[clipId]).map((c) => [c.click.t, c.frame])).toEqual([[5, 90], [6, 120], [9, 210], [14, 360]])
  })

  it('get_clip lists them at timeline seconds', async () => {
    const res = await call('get_clip', { clip_ids: [clipId] })
    const clip = res.json.clips[0]
    expect(clip.clicks.map((c: Json) => [c.at_seconds, c.x, c.y, c.button])).toEqual([[4, 0.25, 0.5, 'left'], [5, 0.75, 0.5, 'left'], [8, 0.5, 0.5, 'right'], [13, 0.5, 0.25, 'left']])
  })

  it('zoom_on_clicks pushes in on each group of clicks, as keyframes that can be undone', async () => {
    const res = await call('zoom_on_clicks', { clip_id: clipId })
    expect(res.isError).toBeFalsy()
    expect(res.json.zooms).toEqual([
      { from_seconds: 3.57, to_seconds: 7.2, clicks: 2, at: { x: 0.25, y: 0.5 } },
      { from_seconds: 12.57, to_seconds: 15.2, clicks: 1, at: { x: 0.5, y: 0.25 } },
    ])
    const clip = getProject().clips[clipId]
    // On the first click it is zoomed in and has brought the click to the middle.
    expect(propAt(clip, 'scale', 90)).toBe(2)
    expect(propAt(clip, 'x', 90)).toBe(960)
    // By the second it has glided across.
    expect(propAt(clip, 'x', 120)).toBe(-960)
    // Between the groups it is back to itself.
    expect(propAt(clip, 'scale', 300)).toBe(1)
    expect(propAt(clip, 'x', 300)).toBe(0)
    // The click near the top can't be centred without showing past the picture's edge.
    expect(propAt(clip, 'y', 360)).toBe(540)
    // One undo takes every zoom off.
    useEditor.getState().undo()
    expect(getProject().clips[clipId].keyframes.scale ?? []).toEqual([])
  })

  it('zooms again from the clip’s resting size, not from the last zoom, and clears', async () => {
    await call('zoom_on_clicks', { clip_id: clipId })
    const again = await call('zoom_on_clicks', { clip_id: clipId, zoom: 3, right_clicks: true })
    // The right click, on its own between the two groups, gets a zoom of its own.
    expect(again.json.zooms.map((z: Json) => z.clicks)).toEqual([2, 1, 1])
    const clip = getProject().clips[clipId]
    expect(propAt(clip, 'scale', 90)).toBe(3)
    expect(propAt(clip, 'scale', 210)).toBe(3)
    expect(propAt(clip, 'scale', 0)).toBe(1)
    const cleared = await call('zoom_on_clicks', { clip_id: clipId, clear: true })
    expect(cleared.json).toEqual({ zooms: [], keyframes: 0 })
    expect(getProject().clips[clipId].keyframes.scale ?? []).toEqual([])
    expect(getProject().clips[clipId].transform.scale).toBe(1)
  })

  it('highlight_clicks draws a pulse on each click, where the zoom has put it', async () => {
    await call('zoom_on_clicks', { clip_id: clipId })
    const res = await call('highlight_clicks', { clip_id: clipId, color: '#00e5ff' })
    expect(res.json.highlights).toBe(3)
    const p = getProject()
    const track = p.tracks.find((t) => t.id === res.json.track_id)!
    expect(track.name).toBe('Clicks')
    const pulses = Object.values(p.clips)
      .filter((c) => c.trackId === track.id)
      .sort((a, b) => a.start - b.start)
    expect(pulses.map((c) => [c.start, c.duration, c.kind])).toEqual([[120, 15, 'text'], [150, 15, 'text'], [390, 15, 'text']])
    expect(pulses[0].text?.content).toBe('●')
    expect(pulses[0].text?.color).toBe('#00e5ff')
    // The zoom has centred the first click, so its pulse is mid-frame; without the zoom it would be 480 px left.
    expect([pulses[0].transform.x, pulses[0].transform.y]).toEqual([0, 0])
    // It grows and fades.
    expect(propAt(pulses[0], 'scale', 0)).toBeLessThan(propAt(pulses[0], 'scale', 14))
    expect(propAt(pulses[0], 'opacity', 14)).toBe(0)
  })

  it('says what is wrong with a clip that has no clicks or isn’t at normal speed', async () => {
    const p = getProject()
    const voice = { ...recording(), id: 'asset_plain', cursor: undefined }
    useEditor.getState().loadProject({ ...p, assets: { ...p.assets, [voice.id]: voice }, clips: { ...p.clips, [clipId]: { ...p.clips[clipId], assetId: voice.id } } })
    expect((await call('zoom_on_clicks', { clip_id: clipId })).json.error).toMatch(/no click data/)
    useEditor.getState().loadProject({ ...p, clips: { ...p.clips, [clipId]: { ...p.clips[clipId], speed: 2 } } })
    expect((await call('highlight_clicks', { clip_id: clipId })).json.error).toMatch(/normal speed/)
    expect((await call('highlight_clicks', { clip_id: clipId, color: 'yellow' })).json.error).toMatch(/hex colour|normal speed/)
  })
})

describe('recording tools', () => {
  it('are in the registry with a source as the only thing start_recording needs', () => {
    const names = agentTools().map((t) => t.name)
    for (const name of ['list_capture_sources', 'start_recording', 'recording_status', 'pause_recording', 'add_recording_marker', 'stop_recording', 'zoom_on_clicks', 'highlight_clicks', 'record_studio_take']) expect(names, name).toContain(name)
    const start = agentTools().find((t) => t.name === 'start_recording')!
    expect(start.inputSchema).toMatchObject({ required: ['source'] })
    expect(start.description).toMatch(/4K and 60 fps/)
  })

  it('need the desktop app, and say plainly when nothing is recording', async () => {
    // No desktop bridge in a test: the question to the user is never even asked.
    expect((await call('list_capture_sources')).json.error).toMatch(/desktop app/)
    expect((await call('start_recording', { source: 'screen' })).json.error).toMatch(/desktop app/)
    expect((await call('stop_recording')).json.error).toBe('No recording is running.')
    expect((await call('pause_recording')).json.error).toBe('No recording is running.')
    expect((await call('add_recording_marker', { label: 'x' })).json.error).toBe('No recording is running.')
    expect((await call('recording_status')).json).toMatchObject({ recording: false, phase: 'idle', seconds: 0 })
    expect((await call('record_studio_take')).json.error).toMatch(/GS Cinematic Studio isn’t connected/)
  })
})
