/**
 * What a screen recording's click data is used for on the timeline: zooms that
 * push in on each click, and a pulse drawn where the pointer clicked. Both are
 * ordinary keyframes and clips afterwards — move them, change them, undo them.
 */
import type { CursorClick } from '@shared/capture'
import { DEFAULT_TEXT, DEFAULT_TRANSFORM } from '@/editor/defaults'
import { propAt } from '@/editor/keyframes'
import { dispatch, getProject, useEditor, type ActionSource } from '@/editor/store'
import type { Clip } from '@/editor/types'
import { zoomKeys, type ZoomOptions } from './autozoom'

/** A clip's clicks that fall inside it, with the timeline frame each lands on. */
export function clipClicks(clip: Clip): { click: CursorClick; frame: number }[] {
  const project = getProject()
  const asset = clip.assetId ? project.assets[clip.assetId] : undefined
  if (!asset?.cursor) return []
  const fps = project.settings.fps
  const out: { click: CursorClick; frame: number }[] = []
  for (const click of asset.cursor.clicks) {
    const local = Math.round(click.t * fps) - clip.inPoint
    if (local >= 0 && local < clip.duration) out.push({ click, frame: local })
  }
  return out
}

function recordingClip(clipId: string) {
  const project = getProject()
  const clip = project.clips[clipId]
  if (!clip) throw new Error(`There’s no clip ${clipId}.`)
  const asset = clip.assetId ? project.assets[clip.assetId] : undefined
  if (!asset?.cursor) throw new Error('This clip has no click data. Clicks are kept when a screen recording is made with “Clicks” on.')
  if (clip.speed !== 1 || clip.reverse || clip.keyframes.speed?.length) throw new Error('Clicks can only be followed on a clip at normal speed. Set its speed back to 100% first.')
  if (!asset.width || !asset.height) throw new Error('The recording’s size isn’t known.')
  return { project, clip, asset, cursor: asset.cursor, width: asset.width, height: asset.height }
}

export interface ZoomResult {
  zooms: { from_seconds: number; to_seconds: number; clicks: number; at: { x: number; y: number } }[]
  keyframes: number
}

/**
 * Puts zooms on a recording's clicks (replacing the clip's own size and
 * position animation). With `clear`, only takes them off.
 */
export function zoomOnClicks(clipId: string, opts: ZoomOptions & { clear?: boolean } = {}, source: ActionSource = 'user'): ZoomResult {
  const { project, clip, cursor, width, height } = recordingClip(clipId)
  const fps = project.settings.fps
  // What the clip is at rest: its first value of each, before any zoom was put on it.
  const base = { scale: clip.keyframes.scale?.[0]?.value ?? clip.transform.scale, x: clip.keyframes.x?.[0]?.value ?? clip.transform.x, y: clip.keyframes.y?.[0]?.value ?? clip.transform.y }
  const keys = opts.clear
    ? { scale: [], x: [], y: [], spans: [] }
    : zoomKeys(cursor, { duration: clip.duration, inPoint: clip.inPoint, fps, ...base, mediaWidth: width, mediaHeight: height, frameWidth: project.settings.width, frameHeight: project.settings.height }, opts)
  if (!opts.clear && !keys.spans.length) throw new Error('There are no clicks inside this clip to zoom on.')
  let count = 0
  useEditor.getState().transaction(opts.clear ? 'Remove zooms on clicks' : 'Zoom on clicks', source, () => {
    for (const prop of ['scale', 'x', 'y'] as const) {
      if (clip.keyframes[prop]?.length) dispatch('keyframe.clear', { clipId, prop }, { source })
      for (const k of keys[prop]) {
        if (dispatch('keyframe.set', { clipId, prop, frame: k.frame, value: k.value, easing: k.easing }, { source }).ok) count++
      }
    }
  })
  return {
    zooms: keys.spans.map((s) => ({
      from_seconds: Math.round(((clip.start + Math.round(s.from * fps) - clip.inPoint) / fps) * 100) / 100,
      to_seconds: Math.round(((clip.start + Math.round(s.to * fps) - clip.inPoint) / fps) * 100) / 100,
      clicks: s.looks.length,
      at: { x: s.looks[0].x, y: s.looks[0].y },
    })),
    keyframes: count,
  }
}

export interface HighlightOptions {
  /** The pulse's colour. */
  color?: string
  /** Its size at its largest, as a fraction of the frame's height. */
  size?: number
  /** How long each lasts, in seconds. */
  seconds?: number
  buttons?: CursorClick['button'][]
}

/**
 * Draws a pulse where each click landed: a short dot that grows and fades,
 * on a track of its own above the recording. It follows the clip's zooms, so
 * add those first.
 */
export function highlightClicks(clipId: string, opts: HighlightOptions = {}, source: ActionSource = 'user'): { highlights: number; track_id: string } {
  const { project, clip, width, height } = recordingClip(clipId)
  const fps = project.settings.fps
  const buttons = new Set(opts.buttons ?? ['left'])
  const clicks = clipClicks(clip).filter(({ click }) => buttons.has(click.button) && click.x >= 0 && click.x <= 1 && click.y >= 0 && click.y <= 1)
  if (!clicks.length) throw new Error('There are no clicks inside this clip to highlight.')
  const fit = Math.min(project.settings.width / width, project.settings.height / height)
  const length = Math.max(4, Math.round((opts.seconds ?? 0.5) * fps))
  const size = Math.round(project.settings.height * Math.min(0.4, Math.max(0.02, opts.size ?? 0.09)))
  let made = 0
  let trackId = ''
  useEditor.getState().transaction('Highlight clicks', source, () => {
    const track = dispatch('track.add', { kind: 'video', name: 'Clicks' }, { source })
    if (!track.ok) return
    trackId = track.result as string
    clicks.forEach(({ click, frame }, i) => {
      // Where that point of the picture is in the frame just then, zooms included.
      const scale = propAt(clip, 'scale', frame)
      const x = (click.x - 0.5) * width * fit * scale + propAt(clip, 'x', frame)
      const y = (click.y - 0.5) * height * fit * scale + propAt(clip, 'y', frame)
      // Clicks in quick succession: each pulse ends where the next begins.
      const next = clicks[i + 1]?.frame
      const duration = Math.max(2, Math.min(length, next !== undefined ? next - frame : length))
      const res = dispatch(
        'clip.add',
        {
          trackId,
          kind: 'text',
          start: clip.start + frame,
          duration,
          name: 'Click',
          // The glyph's own height is about 0.7 of its font size.
          patch: { text: { ...DEFAULT_TEXT, content: '●', size: Math.round(size / 0.7), color: opts.color ?? '#ffd400', shadow: 0, weight: 400 }, transform: { ...DEFAULT_TRANSFORM, x: Math.round(x), y: Math.round(y), scale: 0.45, opacity: 0.75 } },
        },
        { source },
      )
      if (!res.ok) return
      const id = res.result as string
      dispatch('keyframe.set', { clipId: id, prop: 'scale', frame: 0, value: 0.45, easing: 'cubic-out' }, { source })
      dispatch('keyframe.set', { clipId: id, prop: 'scale', frame: duration - 1, value: 1 }, { source })
      dispatch('keyframe.set', { clipId: id, prop: 'opacity', frame: 0, value: 0.75, easing: 'ease-in' }, { source })
      dispatch('keyframe.set', { clipId: id, prop: 'opacity', frame: duration - 1, value: 0 }, { source })
      made++
    })
  })
  if (!made) throw new Error('The highlights couldn’t be added.')
  return { highlights: made, track_id: trackId }
}
