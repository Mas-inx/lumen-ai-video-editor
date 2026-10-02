/**
 * Subject effects built on mattes: cut a clip down to its subject (or remove
 * the subject), and "text behind subject" — the background, a title, and the
 * subject cut out on top of the title, so the words sit behind the person.
 */
import { placeTitle } from '@/editor/placement'
import { dispatch, getProject, useEditor, type ActionSource } from '@/editor/store'
import type { Clip } from '@/editor/types'
import { useUI } from '@/editor/ui-store'
import { subjectMatte, type MatteProgress, type Subject } from './segment'

export interface SubjectOptions {
  subject?: Subject
  onProgress?: (p: MatteProgress) => void
  signal?: AbortSignal
  source?: ActionSource
}

function pictureClip(clipId: string): Clip {
  const clip = getProject().clips[clipId]
  if (!clip) throw new Error(`There’s no clip ${clipId}.`)
  if (clip.kind !== 'video' && clip.kind !== 'image') throw new Error('Pick a video or image clip — that’s what the subject is cut out of.')
  if (clip.sequenceId) throw new Error('Open the nested timeline and cut out the subject of a clip inside it.')
  return clip
}

const ok = <R>(res: { ok: true; result?: unknown } | { ok: false; error: string }) => {
  if (!res.ok) throw new Error(res.error)
  return res.result as R
}

/** Cuts a clip down to its subject — or, with `invert`, removes the subject and keeps everything else. */
export async function cutOutSubject(clipId: string, opts: SubjectOptions & { invert?: boolean } = {}) {
  const clip = pictureClip(clipId)
  const matte = await subjectMatte(clip, opts.subject ?? 'person', opts)
  ok(dispatch('clip.update', { ids: [clipId], patch: { matte: { ...matte, ...(opts.invert ? { invert: true } : {}) } } }, { source: opts.source }))
}

/**
 * Text behind the subject. Uses the title given (`titleId`) or adds a bold one
 * with `text`, and stacks: the clip at the bottom, the title above it, and a
 * silent copy of the clip — cut down to its subject — on a new track on top.
 * One undo step.
 */
export async function textBehindSubject(clipId: string, opts: SubjectOptions & { text?: string; titleId?: string } = {}) {
  const clip = pictureClip(clipId)
  const matte = await subjectMatte(clip, opts.subject ?? 'person', opts)
  const source = opts.source ?? 'user'
  let subjectClipId = ''
  let titleClipId = ''
  useEditor.getState().transaction('Text behind subject', source, () => {
    const index = (trackId: string) => getProject().tracks.findIndex((t) => t.id === trackId)
    const base = getProject().clips[clipId]

    // The title: the one given, or a big bold one over the whole clip.
    const given = opts.titleId ? getProject().clips[opts.titleId] : undefined
    if (given && given.kind !== 'text') throw new Error('titleId has to be a title (text clip).')
    if (given) titleClipId = given.id
    else {
      const id = placeTitle('headline', base.start, { content: opts.text?.trim() || 'YOUR TEXT', source })
      if (!id) throw new Error('Couldn’t add the title.')
      titleClipId = id
      ok(dispatch('clip.trim', { id, edge: 'end', frame: base.start + base.duration }, { source }))
      // Behind the head: a little below the top of the subject, where it overlaps the letters.
      const box = getProject().assets[matte.assetId]?.matteOf?.box
      const H = getProject().settings.height
      const y = box ? Math.round((Math.min(0.6, Math.max(0.2, box.y + Math.min(0.16, box.h * 0.22))) - 0.5) * H) : 0
      ok(
        dispatch(
          'clip.update',
          { ids: [id], patch: { transform: { y }, text: { size: 230, weight: 800, uppercase: true, letterSpacing: -0.035 }, animation: { in: { preset: 'fade', duration: 12 }, out: { preset: 'fade', duration: 12 } } } },
          { source },
        ),
      )
    }

    // The title has to sit above the footage (lower index = higher up).
    let title = getProject().clips[titleClipId]
    if (index(title.trackId) > index(base.trackId)) {
      const above = ok<string>(dispatch('track.add', { kind: 'video', name: 'Titles', index: index(base.trackId) }, { source }))
      ok(dispatch('clip.move', { moves: [{ id: titleClipId, start: title.start, trackId: above }], mode: 'overwrite' }, { source }))
      title = getProject().clips[titleClipId]
    }

    // The subject on its own track right above the title: a silent copy of the clip, cut out.
    const top = ok<string>(dispatch('track.add', { kind: 'video', name: 'Subject', index: index(title.trackId) }, { source }))
    const [copy] = ok<string[]>(dispatch('clip.duplicate', { ids: [clipId] }, { source }))
    ok(dispatch('clip.move', { moves: [{ id: copy, start: base.start, trackId: top }], mode: 'overwrite' }, { source }))
    ok(dispatch('clip.update', { ids: [copy], patch: { matte, name: `${base.name} — subject`, audio: { volume: -60 } } }, { source }))
    subjectClipId = copy
  })
  useUI.getState().select([titleClipId])
  return { subjectClipId, titleClipId }
}
