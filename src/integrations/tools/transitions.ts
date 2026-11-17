/**
 * Smart transitions for agents: transitions that read the two shots at a cut
 * (subjects, the camera's motion, how the frames line up, their colours) and
 * carry one into the other, chosen per cut and timed to the music's beat.
 */
import { TRANSITIONS } from '@/editor/presets'
import type { TransitionAlign, TransitionKind } from '@/editor/types'
import { autoTransitions, smartTransition, type SmartTransitionResult } from '@/project/transition-actions'
import { bool, clipById, num, number, obj, oneOf, rangeArg, seconds, str, text, toFrame, type AgentTool } from './kit'

const SMART = TRANSITIONS.filter((t) => t.smart).map((t) => t.kind)

const KINDS_DOC = 'morph (both frames warp along how their content lines up while they cross — best when the shots are framed alike), through (zoom into the outgoing shot’s subject and out of the incoming one’s), whip (a motion-blurred whip pan in the camera’s own direction — for moving shots), luma (the incoming shot appears through its brightest parts first), match (the incoming shot starts in the outgoing one’s colours and eases into its own — for shots that differ in colour)'

const report = (r: SmartTransitionResult) => ({
  clip_id: r.clipId,
  at_seconds: seconds(clipById(r.clipId).start),
  kind: r.kind,
  why: r.reason,
  seconds: seconds(r.duration),
  align: r.align,
  ...(r.beat !== undefined ? { shots_swap_on_beat_at_seconds: seconds(r.beat) } : {}),
})

export const TRANSITION_TOOLS: AgentTool[] = [
  {
    name: 'smart_transition',
    description: [
      `Put a smart transition on the cut before a clip. Lumen first reads the two shots at the cut — where each one's subject is, how the camera moves, how the outgoing frame lines up with the incoming one, how their colours differ — and the transition carries that across: ${KINDS_DOC}.`,
      'kind "auto" (default) picks the one that suits the cut and says why. Unless seconds or align is given, it is timed so the shots swap on a nearby beat of the music (centred on the cut, or starting or ending at it). One undo step. Check it with get_frame at the cut.',
    ].join(' '),
    inputSchema: obj(
      {
        clip_id: str('The clip after the cut'),
        kind: oneOf('Which transition (default auto)', ['auto', ...SMART]),
        seconds: num('Length (default: timed to a nearby beat, else the cut’s current length or 0.7 s)'),
        align: oneOf('Where it sits on the cut: before ends at it, center straddles it, after starts at it', ['before', 'center', 'after']),
        on_beat: bool('Time it so the shots swap on a nearby beat (default true)'),
      },
      ['clip_id'],
    ),
    run: async (a) => {
      const clipId = text(a, 'clip_id') ?? ''
      clipById(clipId)
      const kind = (text(a, 'kind') ?? 'auto') as TransitionKind | 'auto'
      if (kind !== 'auto' && !SMART.includes(kind)) throw new Error(`kind is auto or one of ${SMART.join(', ')} — other transitions go through clip_setTransition.`)
      const secs = number(a, 'seconds')
      const res = await smartTransition(clipId, kind, {
        ...(secs !== undefined ? { duration: Math.max(2, toFrame(secs)) } : {}),
        ...(text(a, 'align') ? { align: text(a, 'align') as TransitionAlign } : {}),
        onBeat: a.on_beat !== false,
        source: 'ai',
      })
      return report(res)
    },
  },
  {
    name: 'auto_transitions',
    description: [
      `Choose a transition for every cut between picture clips on the open timeline (or between from_seconds and to_seconds): each cut is read and gets the smart transition that suits it — ${KINDS_DOC} — timed so the shots swap on the music's beat where there is one.`,
      'Cuts that already have a transition keep it unless replace is true. One undo step. Returns each cut with the transition chosen and why. Use it for montages and B-roll sequences; a talking-head edit usually reads better with plain cuts.',
    ].join(' '),
    inputSchema: obj({
      from_seconds: num('Start of the stretch (default: the start)'),
      to_seconds: num('End of the stretch (default: the end)'),
      replace: bool('Also replace transitions that are already there (default false)'),
      on_beat: bool('Time them to the music’s beat (default true)'),
    }),
    run: async (a, ctx) => {
      const [from, to] = rangeArg(a)
      const res = await autoTransitions({
        from,
        to,
        replace: a.replace === true,
        onBeat: a.on_beat !== false,
        source: 'ai',
        signal: ctx?.signal,
        onProgress: (done, total) => ctx?.progress?.(`Read ${done} of ${total} cuts`),
      })
      return { placed: res.placed.map(report), skipped: res.skipped }
    },
  },
]
