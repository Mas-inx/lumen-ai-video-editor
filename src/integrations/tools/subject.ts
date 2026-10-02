/**
 * The subject of a shot, cut out on this computer: text behind a person, a
 * person on a new background, or the background with the person removed.
 */
import { getProject } from '@/editor/store'
import { cutOutSubject, textBehindSubject } from '@/project/subject'
import { obj, oneOf, str, text, type AgentTool } from './kit'

export const SUBJECT_TOOLS: AgentTool[] = [
  {
    name: 'cut_out_subject',
    description: [
      'Cut the subject out of a video or image clip with on-device AI segmentation (the model downloads once).',
      'mode "text-behind" (default): the clip at the bottom, a title above it (title_id, or a new bold one with `text`), and the subject cut out on top — the words sit behind the person.',
      'mode "cutout": the clip shows only its subject (put a new background on a track below).',
      'mode "remove": the clip shows everything but the subject.',
      'subject "person" (fast, runs on any computer) or "any" (the main subject — objects, animals; needs a GPU).',
      'It takes roughly the clip’s length on a GPU, longer on the CPU. Mattes are reused, so trying another title on the same clip is instant.',
    ].join(' '),
    inputSchema: obj(
      {
        clip_id: str('The video or image clip'),
        mode: oneOf('What to make (default text-behind)', ['text-behind', 'cutout', 'remove']),
        subject: oneOf('What to cut out (default person)', ['person', 'any']),
        text: str('text-behind: the words of a new title (1–3 words read best)'),
        title_id: str('text-behind: put this existing title behind the subject instead of adding one'),
      },
      ['clip_id'],
    ),
    run: async (a) => {
      const clipId = text(a, 'clip_id') ?? ''
      const subject = a.subject === 'any' ? 'any' : 'person'
      const mode = text(a, 'mode') ?? 'text-behind'
      if (mode === 'text-behind') {
        const res = await textBehindSubject(clipId, { subject, text: text(a, 'text'), titleId: text(a, 'title_id'), source: 'ai' })
        return { subject_clip_id: res.subjectClipId, title_clip_id: res.titleClipId, note: 'Edit the title (clip_update text) to change words, font or size; keep it big and behind the head for the effect to read.' }
      }
      await cutOutSubject(clipId, { subject, invert: mode === 'remove', source: 'ai' })
      return { clip_id: clipId, matte: getProject().clips[clipId]?.matte }
    },
  },
]
