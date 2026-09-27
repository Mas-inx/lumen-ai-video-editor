/**
 * Acting on the editor beyond single commands: undo/redo, selection, playback,
 * saving, exporting (the user picks the file), one-step titles, and batches of
 * commands that apply all together or not at all.
 */
import { toast } from 'sonner'
import { commands, type CommandName } from '@/editor/commands'
import { clipEnd, projectDuration } from '@/editor/ops'
import { playback, usePlayback } from '@/editor/playback'
import { TITLE_PRESETS } from '@/editor/presets'
import { dispatch, getProject, rollbackTo, savepoint, useEditor } from '@/editor/store'
import { useUI } from '@/editor/ui-store'
import { openSequenceName, withSequenceOpen } from '@/editor/sequences'
import { timelineCues } from '@/editor/subtitles'
import { canAlpha, CODECS_FOR, codecSupport, ExportCancelled, exportRunning, FORMAT_INFO, runExport, type ExportFormat, type ExportSettings, type ExportVideoCodec } from '@/engine/export'
import { queueExport } from '@/engine/render-queue'
import { desktop } from '@/lib/platform'
import { saveProject, saveProjectAs, useSession } from '@/project/session'
import { bool, clampNum, int, list, num, number, obj, oneOf, seconds, str, text, toFrame, trackById, type AgentTool } from './kit'

const ai = { source: 'ai' as const }
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)

/** 'clip_update' or 'clip.update' → the command's registry name. */
function commandName(name: string): CommandName | null {
  const dotted = name.includes('.') ? name : name.replace('_', '.')
  return dotted in commands ? (dotted as CommandName) : null
}

function titlesTrack(): string {
  const p = getProject()
  const existing = p.tracks.find((t) => t.role === 'titles' && !t.locked) ?? p.tracks.find((t) => t.kind === 'video' && t.role !== 'main' && t.role !== 'captions' && !t.locked)
  if (existing) return existing.id
  const res = dispatch('track.add', { kind: 'video', name: 'Titles', index: 0, role: 'titles' }, ai)
  if (!res.ok) throw new Error(res.error)
  return res.result as string
}

export const CONTROL_TOOLS: AgentTool[] = [
  {
    name: 'batch_edit',
    description:
      'Run several editing commands as ONE undo step. atomic (default true): if any command fails, everything is rolled back and nothing changes — so a multi-step edit never lands half-done. Each item is { command, input } where command is a command tool name (e.g. "clip_update" or "clip.update") and input is exactly what that tool takes. To refer to something created earlier in the batch, give it an id yourself (clip_add and track_add accept id).',
    inputSchema: obj(
      {
        commands: list(
          'The commands, in order',
          { type: 'object', properties: { command: { type: 'string' }, input: { type: 'object' } }, required: ['command', 'input'] },
          { minItems: 1, maxItems: 200 },
        ),
        label: str('What the History shows for this step'),
        atomic: bool('All or nothing (default true)'),
      },
      ['commands'],
    ),
    run: async (a) => {
      const items = Array.isArray(a.commands) ? (a.commands as { command?: unknown; input?: unknown }[]) : []
      const atomic = a.atomic !== false
      // Check every name first, so a typo never leaves a partial edit behind.
      const unknown = items.map((c, i) => (commandName(String(c?.command ?? '')) ? null : `#${i + 1} “${String(c?.command)}”`)).filter(Boolean)
      if (unknown.length) throw new Error(`Unknown command ${unknown.join(', ')}. Use the command tool names, e.g. clip_update, clip_move, effect_add.`)
      const results: { index: number; command: string; ok: boolean; result?: unknown; error?: string }[] = []
      let failure: { index: number; error: string } | null = null
      useEditor.getState().transaction(text(a, 'label') ?? `AI edit (${items.length} steps)`, 'ai', () => {
        const mark = savepoint()
        for (const [index, item] of items.entries()) {
          const name = commandName(String(item.command))!
          const res = dispatch(name, (item.input ?? {}) as never, ai)
          if (res.ok) results.push({ index: index + 1, command: name, ok: true, result: res.result ?? null })
          else {
            results.push({ index: index + 1, command: name, ok: false, error: res.error })
            if (atomic) {
              failure = { index: index + 1, error: res.error }
              break
            }
          }
        }
        if (failure && mark) rollbackTo(mark)
      })
      if (failure) {
        const f = failure as { index: number; error: string }
        throw new Error(`Step ${f.index} (${String(items[f.index - 1].command)}) failed: ${f.error}. Nothing was changed — fix that step and send the batch again.`)
      }
      return { applied: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results }
    },
  },
  {
    name: 'add_title',
    description:
      'Add a text title in one step, styled from a title preset (see list_catalog → titles) and scaled to the canvas: on the titles track at a time in seconds, for a duration. Returns the clip id — fine-tune it with clip_update. For captions of speech use add_captions.',
    inputSchema: obj(
      {
        text: str('The words'),
        at_seconds: num('When it appears (default: the playhead)', { minimum: 0 }),
        duration_seconds: num('How long it stays (default: the preset’s length)', { minimum: 0.1 }),
        preset: oneOf('Style (default headline)', TITLE_PRESETS.map((t) => t.id)),
        position: oneOf('Where on screen (default center)', ['top', 'center', 'bottom', 'lower-third']),
        size: num('Text size in project pixels (default: the preset’s, scaled to the canvas)', { minimum: 8, maximum: 800 }),
        color: str('Text color, e.g. #ffffff'),
        track_id: str('Use this video track instead of the titles track'),
      },
      ['text'],
    ),
    run: async (a) => {
      const words = text(a, 'text')
      if (!words) throw new Error('text is required.')
      const content: string = words
      const p = getProject()
      const { width: W, height: H } = p.settings
      const preset = TITLE_PRESETS.find((t) => t.id === text(a, 'preset')) ?? TITLE_PRESETS.find((t) => t.id === 'headline') ?? TITLE_PRESETS[0]
      const scale = Math.min(W, H) / 1080
      const position = text(a, 'position') ?? 'center'
      const y = position === 'top' ? -H * 0.3 : position === 'bottom' ? H * 0.3 : position === 'lower-third' ? H * 0.28 : (preset.transform?.y ?? 0)
      const x = position === 'lower-third' ? -W * 0.2 : (preset.transform?.x ?? 0)
      const start = number(a, 'at_seconds') !== undefined ? toFrame(number(a, 'at_seconds')!) : usePlayback.getState().frame
      const duration = Math.max(1, toFrame(number(a, 'duration_seconds') ?? preset.duration))
      let clipId = ''
      const add = () => {
        const trackId = text(a, 'track_id') ? trackById(text(a, 'track_id')!).id : titlesTrack()
        const res = dispatch(
          'clip.add',
          {
            trackId,
            kind: 'text',
            start,
            duration,
            name: content.slice(0, 40),
            patch: {
              text: {
                ...preset.text,
                content,
                size: Math.round(number(a, 'size') ?? (preset.text.size ?? 96) * scale),
                ...(text(a, 'color') ? { color: text(a, 'color') } : {}),
                ...(position === 'lower-third' ? { align: 'left' as const } : {}),
              },
              transform: { ...preset.transform, x: Math.round(x), y: Math.round(y) },
              ...(preset.animation ? { animation: preset.animation } : {}),
            },
          },
          ai,
        )
        if (!res.ok) throw new Error(res.error)
        clipId = res.result as string
      }
      useEditor.getState().transaction(`Title “${words.slice(0, 24)}”`, 'ai', () => {
        const mark = savepoint()
        try {
          add()
        } catch (err) {
          // Don't leave a new, empty titles track behind.
          if (mark) rollbackTo(mark)
          throw err
        }
      })
      const clip = getProject().clips[clipId]
      return { clip_id: clipId, track_id: clip.trackId, start_seconds: seconds(clip.start), end_seconds: seconds(clipEnd(clip)), ...(clip.start !== start ? { note: 'Moved to the nearest free spot on the track.' } : {}) }
    },
  },
  {
    name: 'undo',
    description: 'Undo the most recent edits (one or more steps). Only undo your own work unless the user asks — check get_history first.',
    inputSchema: obj({ steps: int('How many steps (1–20, default 1)', { minimum: 1, maximum: 20 }) }),
    run: async (a) => {
      const undone: string[] = []
      for (let i = 0; i < Math.round(clampNum(number(a, 'steps') ?? 1, 1, 20)); i++) {
        const entry = useEditor.getState().undo()
        if (!entry) break
        undone.push(entry.label)
      }
      if (!undone.length) throw new Error('Nothing to undo.')
      return { undone }
    },
  },
  {
    name: 'redo',
    description: 'Redo edits that were just undone.',
    inputSchema: obj({ steps: int('How many steps (1–20, default 1)', { minimum: 1, maximum: 20 }) }),
    run: async (a) => {
      const redone: string[] = []
      for (let i = 0; i < Math.round(clampNum(number(a, 'steps') ?? 1, 1, 20)); i++) {
        const entry = useEditor.getState().redo()
        if (!entry) break
        redone.push(entry.label)
      }
      if (!redone.length) throw new Error('Nothing to redo.')
      return { redone }
    },
  },
  {
    name: 'select_clips',
    description: 'Select clips in the timeline so the user sees what you mean (the Inspector shows them). reveal also moves the playhead to the first one. An empty list clears the selection.',
    inputSchema: obj({ clip_ids: list('Clip ids (empty to clear)', { type: 'string' }, { maxItems: 200 }), reveal: bool('Move the playhead to the first selected clip') }, ['clip_ids']),
    run: async (a) => {
      const p = getProject()
      const ids = (Array.isArray(a.clip_ids) ? a.clip_ids.map(String) : []).filter((id) => p.clips[id])
      if (!ids.length) {
        useUI.getState().clearSelection()
        return { selected: 0 }
      }
      useUI.getState().select(ids)
      if (a.reveal === true) playback.seek(Math.min(...ids.map((id) => p.clips[id].start)))
      return { selected: ids.length, ...(ids.length < (a.clip_ids as unknown[]).length ? { missing: (a.clip_ids as unknown[]).map(String).filter((id) => !p.clips[id]) } : {}) }
    },
  },
  {
    name: 'playback',
    description: 'Play or pause the preview for the user, optionally from a time. (To look at the video yourself, use get_frame or get_contact_sheet.)',
    inputSchema: obj({ action: oneOf('What to do', ['play', 'pause']), from_seconds: num('Start playing from here', { minimum: 0 }) }, ['action']),
    run: async (a) => {
      if (a.action === 'pause') playback.pause()
      else {
        if (number(a, 'from_seconds') !== undefined) playback.seek(Math.min(toFrame(number(a, 'from_seconds')!), Math.max(0, projectDuration(getProject()) - 1)))
        playback.play()
      }
      const s = usePlayback.getState()
      return { playing: s.playing, time_seconds: seconds(s.frame) }
    },
  },
  {
    name: 'save_project',
    description: 'Save the project file. If it has never been saved — or as_new_file is true — the user picks where in a Save dialog.',
    inputSchema: obj({ as_new_file: bool('Save a copy under a new name / location') }),
    run: async (a) => {
      const ok = a.as_new_file === true ? await saveProjectAs() : await saveProject()
      const path = useSession.getState().path
      return ok ? { saved: true, path } : { saved: false, reason: 'The user cancelled, or the file couldn’t be written.' }
    },
  },
  {
    name: 'export_video',
    description:
      'Export the edit to a video (or audio) file. The user chooses where to save it in a Save dialog — nothing is written without them — and sees progress with a Cancel button. Waits for the export and returns the file path. Renders the open timeline (or timeline_id) whole unless from_seconds / to_seconds are given. loudness_lufs normalizes the mix to a target (−14 for YouTube and Spotify, −16 for Apple and podcasts, −23 for broadcast), with peaks held under −1 dBFS. png exports a folder of numbered frames; transparent keeps the alpha channel (png, or webm with vp9). captions_file saves the captions as .srt / .vtt next to the video; burn_captions false leaves them out of the picture. queue true adds it to the render queue instead of rendering now (see render_queue).',
    inputSchema: obj({
      format: oneOf('File type (default mp4)', ['mp4', 'mov', 'webm', 'gif', 'png', 'wav', 'm4a']),
      timeline_id: str('Export this timeline instead of the open one (ids from list_timelines)'),
      transparent: bool('Keep transparency: png frames, or webm with the vp9 codec'),
      captions_file: oneOf('Also save the captions as a subtitle file next to it', ['srt', 'vtt']),
      burn_captions: bool('Draw the captions into the picture (default true)'),
      queue: bool('Add to the render queue instead of rendering now'),
      resolution: int('Output size by its short side (default: the project’s own size)', { enum: [2160, 1440, 1080, 720, 480] }),
      fps: int('Frame rate (default: the project’s)', { enum: [24, 25, 30, 50, 60] }),
      quality: int('10–100 (default 72; 85+ is master quality)', { minimum: 10, maximum: 100 }),
      codec: oneOf('Video codec (default: the best this machine encodes for the format)', ['avc', 'hevc', 'av1', 'vp9']),
      from_seconds: num('Start of the part to export', { minimum: 0 }),
      to_seconds: num('End of the part to export', { minimum: 0 }),
      file_name: str('Suggested file name (default: the project name)'),
      loudness_lufs: num('Normalize the mix to this integrated loudness in LUFS (e.g. -14); omit to keep the mix as it is', { minimum: -36, maximum: -6 }),
    }),
    run: async (a) => {
      if (!desktop) throw new Error('Exporting needs the desktop app.')
      const queue = a.queue === true
      if (!queue && exportRunning()) throw new Error('An export is already running — wait for it to finish, then try again (or pass queue: true).')
      const p = text(a, 'timeline_id') ? withSequenceOpen(getProject(), text(a, 'timeline_id')!) : getProject()
      const end = projectDuration(p)
      if (end <= 0) throw new Error('The timeline is empty — add some clips first.')
      const format = (text(a, 'format') ?? 'mp4') as ExportFormat
      const info = FORMAT_INFO[format]
      if (!info) throw new Error(`Unknown format ${format}.`)
      const fromF = Math.min(end, toFrame(number(a, 'from_seconds') ?? 0))
      const toF = Math.min(end, toFrame(number(a, 'to_seconds') ?? end / p.settings.fps))
      if (toF <= fromF) throw new Error('That stretch is empty.')
      const fps = number(a, 'fps') ?? p.settings.fps
      const short = number(a, 'resolution')
      const k = short ? short / Math.min(p.settings.width, p.settings.height) : 1
      let width = even(p.settings.width * k)
      let height = even(p.settings.height * k)
      if (format === 'gif' && width > 720) {
        height = even((720 * height) / width)
        width = 720
      }
      let codec: ExportVideoCodec = 'avc'
      const transparent = a.transparent === true
      if (transparent && format !== 'png' && format !== 'webm') throw new Error('Transparency needs format png or webm.')
      if (format === 'mp4' || format === 'mov' || format === 'webm') {
        const support = await codecSupport(width, height, fps, true)
        const wanted = (transparent ? 'vp9' : text(a, 'codec')) as ExportVideoCodec | undefined
        const options = CODECS_FOR[format]
        if (wanted && !options.includes(wanted)) throw new Error(`${info.label} can’t carry ${wanted}; use one of ${options.join(', ')}.`)
        const pick = [wanted, ...options].find((c) => c && support[c]) as ExportVideoCodec | undefined
        if (!pick) throw new Error(`This computer can’t encode ${info.label} at ${width}×${height} — try a smaller resolution or another format.`)
        codec = pick
      }
      const captions = timelineCues(p).length > 0
      const settings: ExportSettings = {
        format,
        codec,
        width,
        height,
        fps,
        quality: Math.round(clampNum(number(a, 'quality') ?? 72, 10, 100)),
        hardware: true,
        range: [fromF, toF],
        ...(number(a, 'loudness_lufs') !== undefined ? { loudness: { lufs: clampNum(number(a, 'loudness_lufs')!, -36, -6), peak: -1 } } : {}),
        ...(transparent && canAlpha(format, codec) ? { alpha: true } : format === 'png' ? { alpha: false } : {}),
        ...(captions ? { burnCaptions: a.burn_captions !== false, sidecar: (text(a, 'captions_file') as 'srt' | 'vtt' | undefined) ?? null } : {}),
      }
      const request = { defaultName: text(a, 'file_name') ?? p.name, extension: info.extension, filterName: info.filter, folder: Boolean(info.folder) }
      if (queue) {
        const target = await desktop.export.pick(request)
        if (!target) return { queued: false, reason: 'The user closed the Save dialog without choosing a file.' }
        const job = queueExport({ label: `${text(a, 'file_name') ?? p.name} · ${openSequenceName(p)}`, detail: `${info.label} · ${width}×${height}`, project: p, settings, target })
        return { queued: true, job_id: job.id, path: target.path, note: 'Start the queue with render_queue action start (or the user can, from the Render queue dialog).' }
      }
      const handle = await desktop.export.begin(request)
      if (!handle) return { exported: false, reason: 'The user closed the Save dialog without choosing a file.' }
      const controller = new AbortController()
      const id = toast.loading('Exporting…', { description: 'Started by the Copilot', action: { label: 'Cancel', onClick: () => controller.abort() }, duration: Infinity })
      const t0 = performance.now()
      try {
        const res = await runExport(
          p,
          settings,
          handle,
          (prog) => {
            if (prog.phase === 'rendering' && prog.total) toast.loading(`Exporting… ${Math.round((prog.done / prog.total) * 100)}%`, { id, description: 'Started by the Copilot', action: { label: 'Cancel', onClick: () => controller.abort() }, duration: Infinity })
          },
          controller.signal,
        )
        toast.success('Export finished', { id, description: res.path, action: { label: 'Show', onClick: () => void desktop?.files.reveal(res.path) }, duration: 8000 })
        return {
          exported: true,
          path: res.path,
          ...(res.sidecar ? { captions_file: res.sidecar } : {}),
          size_mb: Math.round((res.size / 1e6) * 10) / 10,
          format,
          ...(info.video ? { size: `${width}x${height}`, fps, codec } : {}),
          seconds_of_video: seconds(toF - fromF),
          render_seconds: Math.round((performance.now() - t0) / 100) / 10,
        }
      } catch (err) {
        if (err instanceof ExportCancelled) {
          toast.dismiss(id)
          return { exported: false, reason: 'The user cancelled the export.' }
        }
        toast.error('Export failed', { id, description: err instanceof Error ? err.message : String(err), duration: 8000 })
        throw err
      }
    },
  },
]
