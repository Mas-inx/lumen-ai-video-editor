/**
 * Tools for timelines, subtitles and reading the footage: SRT / WebVTT in and
 * out, scene detection, multicam synced by sound, stabilization, motion
 * tracking and the render queue. (Creating, opening and nesting timelines are
 * editor commands — sequence_create, sequence_open, clip_nest, clip_unnest,
 * multicam_switch…)
 */
import { usePlayback } from '@/editor/playback'
import { allSequences, clipsLength, openSequenceId } from '@/editor/sequences'
import { getProject } from '@/editor/store'
import { formatCues, importSubtitles, timelineCues } from '@/editor/subtitles'
import { useUI } from '@/editor/ui-store'
import { clearFinished, queueCounts, startQueue, useRenderQueue } from '@/engine/render-queue'
import { desktop } from '@/lib/platform'
import { multicamFromAssets, scenesInClip, stabilizeClip, trackMotion } from '@/project/analysis-actions'
import { saveSubtitles } from '@/project/subtitle-files'
import { dispatch } from '@/editor/store'
import { assetById, bool, clampNum, clipById, frameArg, list, num, number, obj, oneOf, seconds, str, text, toFrame, type AgentTool } from './kit'

const ai = { source: 'ai' as const }

export const FOOTAGE_TOOLS: AgentTool[] = [
  {
    name: 'list_timelines',
    description:
      'Every timeline (sequence) in the project: id, name, size, frame rate, length, whether it is open, whether it is a multicam timeline, and which timelines play it (nested). Switch with sequence_open; make one with sequence_create.',
    inputSchema: obj({}),
    run: async () => {
      const p = getProject()
      const open = openSequenceId(p)
      const all = allSequences(p)
      return {
        open_timeline_id: open,
        timelines: all.map((s) => ({
          id: s.id,
          name: s.name,
          open: s.id === open,
          size: `${s.settings.width}x${s.settings.height}`,
          fps: s.settings.fps,
          duration_seconds: Math.round((clipsLength(s.clips) / s.settings.fps) * 100) / 100,
          clips: Object.keys(s.clips).length,
          ...(s.multicam ? { multicam: true, angles: s.tracks.filter((t) => t.kind === 'video').map((t, i) => ({ angle: i + 1, track_id: t.id, name: t.name })) } : {}),
          nested_in: all.filter((o) => Object.values(o.clips).some((c) => c.sequenceId === s.id)).map((o) => o.id),
        })),
      }
    },
  },
  {
    name: 'import_subtitles',
    description:
      'Bring an SRT or WebVTT subtitle file onto the open timeline as caption clips (styled like add_captions). Give a file path, or the subtitle text itself. offset_seconds shifts every cue; replace takes over the existing Captions track instead of adding a new one.',
    inputSchema: obj({
      path: str('Absolute path of an .srt or .vtt file'),
      text: str('Or the subtitle text (SRT or WebVTT)'),
      offset_seconds: num('Shift every caption by this much (default 0)'),
      replace: bool('Replace the captions already on the Captions track'),
    }),
    run: async (a) => {
      let body = text(a, 'text')
      let name: string | undefined
      if (!body) {
        const path = text(a, 'path')
        if (!path) throw new Error('Give path (an .srt / .vtt file) or text.')
        if (!desktop) throw new Error('Reading files needs the desktop app.')
        const info = await desktop.files.urlForPath(path)
        if (!info) throw new Error(`Can’t read ${path} — check the path.`)
        body = await (await fetch(info.url)).text()
        name = info.name.replace(/\.[^.]+$/, '')
      }
      const r = importSubtitles(body, { name, offset: number(a, 'offset_seconds'), replace: a.replace === true, source: 'ai' })
      return { captions_added: r.added, cues_in_file: r.cues, track_id: r.trackId }
    },
  },
  {
    name: 'export_subtitles',
    description:
      'The captions on the open timeline (text clips on caption tracks) as SRT or WebVTT. By default the user picks where to save the file in a Save dialog; with save false the text is just returned.',
    inputSchema: obj({ format: oneOf('srt (default) or vtt', ['srt', 'vtt']), file_name: str('Suggested file name'), save: bool('Save a file (default true); false returns the text only') }),
    run: async (a) => {
      const format = text(a, 'format') === 'vtt' ? 'vtt' : 'srt'
      const cues = timelineCues(getProject())
      if (!cues.length) throw new Error('There are no captions on the timeline — add_captions or import_subtitles first.')
      if (a.save === false) return { format, cues: cues.length, text: formatCues(cues, format).slice(0, 20000) }
      const r = await saveSubtitles(format, text(a, 'file_name'))
      return r ? { saved: true, path: r.path, cues: r.cues } : { saved: false, reason: 'The user closed the Save dialog.' }
    },
  },
  {
    name: 'detect_scenes',
    description:
      'Find the shot changes (scene cuts) in a video clip by comparing its frames, then split the clip at each cut (default), add markers there, or just report them. sensitivity 0–100 (default 50; higher finds subtler cuts). One undo step.',
    inputSchema: obj(
      {
        clip_id: str('A video clip on the timeline'),
        action: oneOf('What to do at the cuts (default split)', ['split', 'markers', 'none']),
        sensitivity: num('0–100 (default 50)', { minimum: 0, maximum: 100 }),
      },
      ['clip_id'],
    ),
    run: async (a) => {
      const clip = clipById(String(a.clip_id))
      const action = (text(a, 'action') ?? 'split') as 'split' | 'markers' | 'none'
      const r = await scenesInClip(clip.id, { action, sensitivity: number(a, 'sensitivity'), source: 'ai' })
      if (r.clipIds) useUI.getState().markAiTouched(r.clipIds)
      return { cuts: r.cuts.length, cuts_seconds: r.cuts.map(seconds), applied: r.applied, ...(r.clipIds ? { clip_ids: r.clipIds } : {}) }
    },
  },
  {
    name: 'create_multicam',
    description:
      'Make a multicam clip from recordings of the same moment (two or more video assets): lines them up by their sound (or by the start of each file), puts each camera on its own angle, keeps one camera’s sound, and places the multicam clip on the main track. Returns the offsets found and how confidently each matched (above ~8 is solid). Then cut between cameras with multicam_switch.',
    inputSchema: obj(
      {
        asset_ids: list('The camera recordings (video assets)', { type: 'string' }, { minItems: 2, maxItems: 16 }),
        sync: oneOf('Line up by their sound (default) or by the start of each file', ['sound', 'start']),
        audio_asset_id: str('Whose sound to use (default: the longest recording with sound)'),
        name: str('Name for the multicam timeline'),
        at_seconds: num('Where on the timeline (default: the playhead)', { minimum: 0 }),
        place: bool('Put the multicam clip on the timeline (default true)'),
      },
      ['asset_ids'],
    ),
    run: async (a) => {
      const ids = (a.asset_ids as unknown[]).map(String)
      ids.forEach((id) => assetById(id))
      const audioId = text(a, 'audio_asset_id')
      const audio = audioId ? ids.indexOf(audioId) : undefined
      if (audioId && audio === -1) throw new Error('audio_asset_id must be one of asset_ids.')
      const start = number(a, 'at_seconds') !== undefined ? toFrame(number(a, 'at_seconds')!) : usePlayback.getState().frame
      if (text(a, 'sync') === 'start') {
        const res = dispatch('multicam.create', { name: text(a, 'name'), angles: ids.map((assetId) => ({ assetId, offset: 0 })), audio: audio ?? 0, place: a.place !== false, start }, ai)
        if (!res.ok) throw new Error(res.error)
        const r = res.result as { sequenceId: string; clipId: string | null }
        return { timeline_id: r.sequenceId, clip_id: r.clipId, synced_by: 'start' }
      }
      const r = await multicamFromAssets(ids, { name: text(a, 'name'), audio, place: a.place !== false, start, source: 'ai' })
      if (r.clipId) useUI.getState().markAiTouched([r.clipId])
      return {
        timeline_id: r.sequenceId,
        clip_id: r.clipId,
        synced_by: 'sound',
        angles: r.sync.map((s, i) => ({ angle: i + 1, asset_id: s.assetId, name: s.name, offset_seconds: s.offset, confidence: Number.isFinite(s.confidence) ? s.confidence : 'reference' })),
      }
    },
  },
  {
    name: 'stabilize_clip',
    description:
      'Smooth the camera shake out of a video clip: measures the shake frame by frame, then shifts, turns and zooms each frame back onto a smooth path (zooming just enough to hide the edges). smoothness_seconds (default 1): more is steadier, like a tripod; less keeps intentional moves. Undo removes it.',
    inputSchema: obj(
      { clip_id: str('A video clip on the timeline'), smoothness_seconds: num('0.2–4 (default 1)', { minimum: 0.2, maximum: 4 }), keep_level: bool('Also hold the horizon level (default true)') },
      ['clip_id'],
    ),
    run: async (a) => {
      const clip = clipById(String(a.clip_id))
      const r = await stabilizeClip(clip.id, { smooth: number(a, 'smoothness_seconds'), rotation: a.keep_level !== false, source: 'ai' })
      useUI.getState().markAiTouched([clip.id])
      return { stabilized: true, zoom_percent: Math.round((r.zoom - 1) * 1000) / 10, frames_measured: r.frames }
    },
  },
  {
    name: 'track_motion',
    description:
      'Make a clip (a title, sticker, image or picture-in-picture) — or one of its masks — follow something moving in the footage under it. Give the box around the thing to follow on a frame where it is visible: box_fraction as fractions of the frame (x, y = its centre from the top-left, 0–1; width, height 0–1 — read them off get_frame), or box in project pixels from the frame centre. direction forward (default), backward or both. Tracking the mask of an adjustment layer with blur makes a moving blur (hide a face or a plate).',
    inputSchema: obj(
      {
        clip_id: str('The clip that should follow (or whose mask should)'),
        mask_id: str('Track this mask of the clip instead of the clip itself'),
        box_fraction: {
          ...obj({ x: num('Centre, 0–1 from the left'), y: num('Centre, 0–1 from the top'), width: num('0–1 of the frame width'), height: num('0–1 of the frame height') }, ['x', 'y', 'width', 'height']),
          description: 'The area around what to follow, as fractions of the frame: { x, y, width, height }',
        },
        box: {
          ...obj({ x: num('Centre x, project pixels from the frame centre'), y: num('Centre y, project pixels from the frame centre'), width: num('Pixels'), height: num('Pixels') }, ['x', 'y', 'width', 'height']),
          description: 'Or the same area in project pixels from the frame centre',
        },
        time_seconds: num('The frame the box is on (default: the playhead)', { minimum: 0 }),
        direction: oneOf('Which way to track from there (default forward)', ['forward', 'backward', 'both']),
        source_clip_id: str('The video to read (default: the video under the clip, or the clip itself for its masks)'),
      },
      ['clip_id'],
    ),
    run: async (a) => {
      const clip = clipById(String(a.clip_id))
      const { width: PW, height: PH } = getProject().settings
      const f = a.box_fraction as { x: number; y: number; width: number; height: number } | undefined
      const px = a.box as { x: number; y: number; width: number; height: number } | undefined
      const box = f ? { x: (f.x - 0.5) * PW, y: (f.y - 0.5) * PH, width: f.width * PW, height: f.height * PH } : px
      if (!box) throw new Error('Give box_fraction (or box): the area around what to follow.')
      const frame = frameArg(a)
      const r = await trackMotion({
        targetId: clip.id,
        maskId: text(a, 'mask_id'),
        box: { x: box.x, y: box.y, width: Math.max(8, box.width), height: Math.max(8, box.height) },
        direction: (text(a, 'direction') ?? 'forward') as 'forward' | 'backward' | 'both',
        frame,
        sourceId: text(a, 'source_clip_id'),
        source: 'ai',
      })
      useUI.getState().markAiTouched([clip.id])
      return { tracked_frames: r.frames, from_seconds: seconds(r.from), to_seconds: seconds(r.to), ...(r.lost ? { note: 'Lost sight of it before the end of the clip.' } : {}) }
    },
  },
  {
    name: 'render_queue',
    description:
      'The render queue (exports lined up with their files chosen; add to it with export_video queue: true): list the jobs and their progress, start rendering them one after another, or clear the finished ones.',
    inputSchema: obj({ action: oneOf('What to do (default list)', ['list', 'start', 'clear_finished']), wait_seconds: num('With start: wait up to this long for the queue to finish (max 600, default 0)', { minimum: 0, maximum: 600 }) }),
    run: async (a) => {
      const action = text(a, 'action') ?? 'list'
      if (action === 'clear_finished') clearFinished()
      if (action === 'start') {
        if (!desktop) throw new Error('Rendering needs the desktop app.')
        const done = startQueue()
        const wait = clampNum(number(a, 'wait_seconds') ?? 0, 0, 600)
        if (wait > 0) await Promise.race([done, new Promise((r) => setTimeout(r, wait * 1000))])
      }
      const { jobs, active } = useRenderQueue.getState()
      const c = queueCounts(jobs)
      return {
        rendering: active,
        waiting: c.queued,
        jobs: jobs.map((j) => ({ id: j.id, name: j.label, detail: j.detail, status: j.status, progress: Math.round(j.progress * 100) / 100, file: j.result?.path ?? j.target.path, ...(j.error ? { error: j.error } : {}) })),
      }
    },
  },
]
