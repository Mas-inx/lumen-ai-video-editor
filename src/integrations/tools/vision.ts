/**
 * The AI's eyes: exact frames of the edit, contact sheets of the whole timeline,
 * frames of any media file, and the editor window itself. Frames come from the
 * same renderer as export, so what the model sees is what the viewer will get.
 */
import { projectDuration } from '@/editor/ops'
import { usePlayback } from '@/editor/playback'
import { getProject } from '@/editor/store'
import type { Project } from '@/editor/types'
import { useUI } from '@/editor/ui-store'
import { clipsDrawnAt } from '@/engine/compositor'
import { canvasBase64, contactSheet, mediaStills, timelineStills } from '@/engine/stills'
import { desktop } from '@/lib/platform'
import { assetById, clampNum, frameArg, int, list, num, number, obj, rangeArg, seconds, str, timecode, trackName, withImages, type AgentTool } from './kit'

/** "0:12.5" — tenths, so cells a second apart still read differently. */
export function label(sec: number) {
  const m = Math.floor(sec / 60)
  return `${m}:${(sec - m * 60).toFixed(1).padStart(4, '0')}`
}

const WIDTH = num('Image width in pixels (256–1920, default 1024). Wider shows more detail but costs more tokens.', { minimum: 256, maximum: 1920 })
const AT = {
  time_seconds: num('Timeline time in seconds (default: the playhead)', { minimum: 0 }),
  frame: int('Timeline frame, instead of time_seconds', { minimum: 0 }),
}

/** What's on screen at a frame, top layer first. */
function onScreen(project: Project, frame: number) {
  return clipsDrawnAt(project, frame)
    .reverse()
    .map(({ clip }) => {
      const asset = clip.assetId ? project.assets[clip.assetId] : undefined
      return {
        clip_id: clip.id,
        name: clip.name,
        kind: clip.kind,
        track: trackName(clip.trackId),
        ...(clip.text ? { text: clip.text.content } : {}),
        ...(asset?.source.missing ? { offline: true } : {}),
        ...(clip.effects.length ? { effects: clip.effects.map((e) => e.kind) } : {}),
      }
    })
}

function lastFrame(project: Project) {
  const end = projectDuration(project)
  if (end <= 0) throw new Error('The timeline is empty — there’s nothing to look at yet. Use get_media_frames to look at media in the library.')
  return end - 1
}

export const VISION_TOOLS: AgentTool[] = [
  {
    name: 'get_frame',
    description:
      'See the video. Renders the timeline at one moment exactly as the export will look — every track, effect, title and transition — and returns it as an image, with the clips on screen (top layer first). Defaults to the playhead. Use it to check framing, text and looks, and to verify visual edits after making them.',
    inputSchema: obj({ ...AT, width: WIDTH }),
    run: async (a) => {
      const p = getProject()
      const requested = frameArg(a)
      const frame = Math.min(requested, lastFrame(p))
      const width = Math.round(clampNum(number(a, 'width') ?? 1024, 256, 1920))
      const [canvas] = await timelineStills(p, [frame], width)
      return withImages(
        {
          frame,
          time_seconds: seconds(frame),
          timecode: timecode(frame),
          image: `${canvas.width}x${canvas.height}`,
          on_screen: onScreen(p, frame),
          ...(requested !== frame ? { note: `Frame ${requested} is past the end; showing the last frame.` } : {}),
        },
        [{ data: canvasBase64(canvas), mimeType: 'image/jpeg' }],
      )
    },
  },
  {
    name: 'get_contact_sheet',
    description:
      'Watch the whole edit — or a stretch of it — at a glance: evenly spaced frames laid out in one labelled grid image (each cell shows its number and time). Far cheaper than many get_frame calls: use it to understand a video before editing and to review the result afterwards.',
    inputSchema: obj({
      count: int('How many frames (4–36, default 12)', { minimum: 4, maximum: 36 }),
      from_seconds: num('Start of the stretch (default 0)', { minimum: 0 }),
      to_seconds: num('End of the stretch (default: the end of the timeline)', { minimum: 0 }),
    }),
    run: async (a) => {
      const p = getProject()
      lastFrame(p)
      const [from, to] = rangeArg(a)
      if (to <= from) throw new Error('That stretch is empty — check from_seconds / to_seconds against get_project’s duration.')
      const count = Math.round(clampNum(number(a, 'count') ?? 12, 4, 36))
      const n = Math.min(count, to - from)
      // Sample the middle of each slice, so fades at the very start or end don't read as black.
      const frames = Array.from({ length: n }, (_, i) => Math.min(to - 1, Math.floor(from + ((i + 0.5) * (to - from)) / n)))
      const stills = await timelineStills(p, frames, 640)
      const sheet = contactSheet(stills.map((image, i) => ({ image, label: `${i + 1} · ${label(frames[i] / p.settings.fps)}` })))
      return withImages(
        {
          from_seconds: seconds(from),
          to_seconds: seconds(to),
          image: `${sheet.width}x${sheet.height}`,
          frames: frames.map((f, i) => ({
            cell: i + 1,
            frame: f,
            time_seconds: seconds(f),
            on_screen: onScreen(p, f).map((c) => (c.text ? `${c.name}: “${c.text}”` : c.name)),
          })),
        },
        [{ data: canvasBase64(sheet), mimeType: 'image/jpeg' }],
      )
    },
  },
  {
    name: 'get_media_frames',
    description:
      'Look inside a media file from the library before using it: frames of a video (evenly spaced, or at given source times) as one labelled image, or the picture itself for an image. Use it to pick the right shot or moment, e.g. before place_asset or clip_trim.',
    inputSchema: obj(
      {
        asset_id: str('Media id (from get_project or find_media)'),
        count: int('Evenly spaced frames to show (1–24, default 8). Ignored when times_seconds is given.', { minimum: 1, maximum: 24 }),
        times_seconds: list('Exact source times to show, in seconds', { type: 'number', minimum: 0 }, { maxItems: 24 }),
        width: WIDTH,
      },
      ['asset_id'],
    ),
    run: async (a) => {
      const asset = assetById(String(a.asset_id))
      if (asset.kind === 'audio') throw new Error(`“${asset.name}” is audio — it has no pictures. Use get_transcript for what’s said, or analyze_audio to hear it.`)
      const given = Array.isArray(a.times_seconds) ? (a.times_seconds as unknown[]).map(Number).filter((t) => Number.isFinite(t) && t >= 0).slice(0, 24) : []
      if (asset.kind === 'image') {
        const [still] = await mediaStills(asset, [0], Math.round(clampNum(number(a, 'width') ?? 1024, 256, 1920)))
        return withImages({ asset_id: asset.id, name: asset.name, kind: 'image', size: asset.width ? `${asset.width}x${asset.height}` : undefined }, [{ data: canvasBase64(still), mimeType: 'image/jpeg' }])
      }
      const duration = asset.duration ?? 0
      if (asset.kind === 'video' && duration <= 0) throw new Error(`“${asset.name}” has no known length yet — try again in a moment.`)
      const count = Math.round(clampNum(number(a, 'count') ?? 8, 1, 24))
      const times = given.length ? given.map((t) => Math.min(t, duration)) : Array.from({ length: count }, (_, i) => ((i + 0.5) * duration) / count)
      const single = times.length === 1
      const stills = await mediaStills(asset, times, single ? Math.round(clampNum(number(a, 'width') ?? 1024, 256, 1920)) : 640)
      const image = single ? stills[0] : contactSheet(stills.map((s, i) => ({ image: s, label: `${i + 1} · ${label(times[i])}` })))
      return withImages(
        {
          asset_id: asset.id,
          name: asset.name,
          kind: asset.kind,
          duration_seconds: duration,
          ...(asset.width ? { size: `${asset.width}x${asset.height}` } : {}),
          image: `${image.width}x${image.height}`,
          frames: times.map((t, i) => ({ cell: i + 1, source_seconds: Math.round(t * 1000) / 1000 })),
        },
        [{ data: canvasBase64(image), mimeType: 'image/jpeg' }],
      )
    },
  },
  {
    name: 'get_editor_screenshot',
    description:
      'A screenshot of Lumen’s own window — the editor as the user sees it right now: timeline, panels, inspector, open dialogs. Use it when the user points at something on screen or to check the UI state; for the video itself use get_frame.',
    inputSchema: obj({ width: num('Image width in pixels (640–2560, default 1600)', { minimum: 640, maximum: 2560 }) }),
    run: async (a) => {
      if (!desktop) throw new Error('Screenshots need the desktop app.')
      const data = await desktop.window.capture(Math.round(clampNum(number(a, 'width') ?? 1600, 640, 2560)))
      const playhead = usePlayback.getState().frame
      return withImages(
        { captured: 'Lumen window', project: getProject().name, playhead: timecode(playhead), selected_clips: useUI.getState().selection },
        [{ data, mimeType: 'image/jpeg' }],
      )
    },
  },
]
