/**
 * Reviewing an edit: repeated takes in the speech (and cutting them, or any
 * speech, without cutting words), and the check that says whether the edit is
 * finished — problems in the timeline, the rendered picture and the sound, with
 * fixes as commands for batch_edit.
 */
import { projectDuration } from '@/editor/ops'
import { checkEdit, sampleFrames, verdict, type FrameSample, type QualityIssue, type SoundMeasure, type TextBox } from '@/editor/quality'
import { findRetakes, spokenSentences, SURE, type RetakeGroup, type Sentence } from '@/editor/retakes'
import { untranscribed } from '@/editor/smart'
import { planSpeechCuts, removeSpeech, takesToRemove, type PlannedCut, type SpeechRemoval } from '@/editor/speech-cuts'
import { getProject } from '@/editor/store'
import { useUI } from '@/editor/ui-store'
import { measurePicture, measureSound, measureTextBoxes } from '@/engine/edit-check'
import { bool, clampNum, list, num, number, obj, rangeArg, seconds, strings, trackName, type AgentTool } from './kit'

const sec = (t: number) => Math.round(t * 100) / 100

function groupLine(g: RetakeGroup, sentences: Map<string, Sentence>) {
  return {
    group_id: g.id,
    kind: g.kind,
    takes: g.takes.map((t, i) => ({
      take: i + 1,
      sentence_id: t.sentenceId,
      text: t.text,
      start_seconds: sec(t.start),
      end_seconds: sec(t.end),
      ...(t.words ? { words: t.words } : {}),
    })),
    keep: g.keep + 1,
    confidence: g.confidence,
    sure: g.confidence >= SURE,
    reason: g.reason,
    ...(g.asides.length ? { asides: g.asides.map((id) => ({ sentence_id: id, text: sentences.get(id)?.text ?? '' })) } : {}),
    ...(g.stumble ? { in_sentence: g.stumble.sentence } : {}),
    track: trackName(g.lane),
  }
}

const cutLine = (c: PlannedCut & { join?: number; next?: { text: string; start: number } }) => ({
  from_seconds: seconds(c.from),
  to_seconds: seconds(c.to),
  seconds: seconds(c.to - c.from),
  removed: c.text,
  ...(c.join !== undefined ? { join_at_seconds: seconds(c.join) } : {}),
  ...(c.next ? { next: { text: c.next.text, now_starts_at_seconds: sec(c.next.start) } } : {}),
  ...(c.notes.length ? { notes: c.notes } : {}),
})

function issueLine(i: QualityIssue) {
  return {
    id: i.id,
    severity: i.severity,
    check: i.check,
    at_seconds: seconds(i.frame),
    ...(i.end !== undefined ? { until_seconds: seconds(i.end) } : {}),
    problem: i.message,
    suggestion: i.suggestion,
    ...(i.clipIds?.length ? { clip_ids: i.clipIds.slice(0, 20) } : {}),
    ...(i.fix?.commands.length ? { fix: { label: i.fix.label, commands: i.fix.commands.map((c) => ({ command: c.command.replace('.', '_'), input: c.input })) } } : {}),
  }
}

export const REVIEW_TOOLS: AgentTool[] = [
  {
    name: 'find_repeated_takes',
    description:
      'Find repeated takes in the speech on the timeline. The transcript is split into sentences, and lines a voice said more than once are grouped: restart (a false start that stops and starts again), repeat (said twice word for word), similar (said again with small changes), stumble (words said twice in a row inside a sentence, e.g. “we can — we can do this”). Each group lists its takes (sentence ids, text, timeline seconds), the take to keep (1-based), why, and a confidence 0–1. sure (confidence ≥ 0.75) means cutting the other takes loses nothing; below that the takes differ, or the repetition looks deliberate (emphasis, a rhetorical triple, a call to action at the start and the end) — judge it yourself or ask, and keep both when unsure. A take that says something the others don’t is never the one suggested to go. Only wording is compared: the sentences list (ids, text, times) lets you find the same line said again in other words. Cut with remove_speech. Speech must be transcribed first (transcribe_media).',
    inputSchema: obj({
      from_seconds: num('Only takes from here on', { minimum: 0 }),
      to_seconds: num('Only takes up to here', { minimum: 0 }),
      sentences: bool('Also list the sentences, for finding paraphrased repeats (default true)'),
    }),
    run: async (a) => {
      const p = getProject()
      const all = spokenSentences(p)
      const missing = untranscribed(p).map((id) => `${id} (${p.assets[id]?.name})`)
      if (!all.length) throw new Error(missing.length ? `Nothing on the timeline is transcribed yet — call transcribe_media for: ${missing.join(', ')}.` : 'There’s no speech on the timeline.')
      const from = number(a, 'from_seconds') ?? 0
      const to = number(a, 'to_seconds') ?? Infinity
      const byId = new Map(all.map((s) => [s.id, s]))
      const groups = findRetakes(all).filter((g) => g.takes.some((t) => t.end > from && t.start < to))
      const listed = all.filter((s) => s.end > from && s.start < to)
      return {
        groups: groups.map((g) => groupLine(g, byId)),
        sure_groups: groups.filter((g) => g.confidence >= SURE).length,
        ...(a.sentences !== false
          ? {
              sentences: listed.slice(0, 600).map((s) => ({ id: s.id, text: s.text, start_seconds: sec(s.start), end_seconds: sec(s.end), track: trackName(s.lane) })),
              ...(listed.length > 600 ? { sentences_more: `${listed.length - 600} more — ask again with from_seconds ${sec(listed[600].start)}` } : {}),
            }
          : {}),
        ...(missing.length ? { untranscribed: missing } : {}),
        next: groups.length ? 'Cut with remove_speech: takes [{ group_id, keep }] keeps one take of a group, sentence_ids cuts whole sentences, sure_takes cuts every sure group.' : 'No repeated takes found by wording; read the sentences for lines said again in other words.',
      }
    },
  },
  {
    name: 'remove_speech',
    description:
      'Cut speech out of the timeline safely, as one undo step: takes of a repeated-take group (keep one: the others and the asides between them go), whole sentences by id, or timeline ranges in seconds. Cuts land in the gaps between words, never inside one, with a breath kept either side; a range that would split a word is moved to the nearest gap (and says so), and a cut through another voice is refused. Like remove_pauses, the whole timeline closes up — captions, B-roll, markers, effects and keyframes stay in sync; music beds play on through the joins. Returns each cut (what was removed, where the join landed and what is said right after it now), what was refused and why, and the repeats still left around the cuts. dry_run plans the cuts without changing anything.',
    inputSchema: obj({
      takes: list(
        'Groups from find_repeated_takes to resolve: keep is the take number to keep (1-based)',
        { type: 'object', properties: { group_id: { type: 'string' }, keep: { type: 'integer', minimum: 1 } }, required: ['group_id', 'keep'] },
        { maxItems: 200 },
      ),
      sentence_ids: list('Sentences to cut whole (ids from find_repeated_takes)', { type: 'string' }, { maxItems: 500 }),
      ranges: list('Timeline stretches to cut, [from_seconds, to_seconds] each', { type: 'array', items: { type: 'number', minimum: 0 }, minItems: 2, maxItems: 2 }, { maxItems: 200 }),
      sure_takes: bool('Also cut every group find_repeated_takes is sure of (confidence ≥ 0.75), keeping its suggested take'),
      dry_run: bool('Only plan the cuts and report them'),
    }),
    run: async (a, ctx) => {
      const p = getProject()
      const sentences = spokenSentences(p)
      const groups = findRetakes(sentences)
      const choices: Record<string, number | 'all'> = {}
      const unknown: string[] = []
      if (a.sure_takes === true) for (const g of groups) if (g.confidence >= SURE) choices[g.id] = g.keep
      for (const item of Array.isArray(a.takes) ? (a.takes as { group_id?: unknown; keep?: unknown }[]) : []) {
        const g = groups.find((x) => x.id === String(item?.group_id))
        const keep = Number(item?.keep) - 1
        if (!g) unknown.push(String(item?.group_id))
        else if (!g.takes[keep]) throw new Error(`Group ${g.id} has takes 1–${g.takes.length}; keep ${item.keep} isn’t one of them.`)
        else choices[g.id] = keep
      }
      if (unknown.length) throw new Error(`No group ${unknown.join(', ')} now — the timeline changed since. Call find_repeated_takes again for current ids.`)
      const fromTakes = takesToRemove(groups, choices)
      const ranges = (Array.isArray(a.ranges) ? a.ranges : []).map((r) => (Array.isArray(r) ? [Number(r[0]), Number(r[1])] : [NaN, NaN]) as [number, number]).filter((r) => r.every(Number.isFinite))
      const req: SpeechRemoval = { sentences: [...(fromTakes.sentences ?? []), ...strings(a, 'sentence_ids')], words: fromTakes.words, ranges }
      if (!req.sentences!.length && !req.words!.length && !ranges.length) throw new Error('Nothing to cut: give takes, sentence_ids, ranges or sure_takes.')
      if (a.dry_run === true) {
        const plan = await planSpeechCuts(p, req)
        return { dry_run: true, cuts: plan.cuts.map(cutLine), seconds: seconds(plan.cuts.reduce((s, c) => s + c.to - c.from, 0)), ...(plan.refused.length ? { refused: plan.refused } : {}) }
      }
      ctx?.progress?.('Cutting between the words…')
      const r = await removeSpeech(req, { label: 'Cut speech' })
      if (!r.cuts.length) throw new Error(`Nothing was cut. ${r.refused.map((x) => `${x.what}: ${x.reason}`).join(' · ')}`)
      const byId = new Map(spokenSentences(getProject()).map((s) => [s.id, s]))
      useUI.getState().markAiTouched(Object.values(getProject().clips).filter((c) => r.cuts.some((k) => c.start === k.join || c.start + c.duration === k.join)).map((c) => c.id))
      return {
        cuts: r.cuts.map(cutLine),
        seconds_removed: sec(r.seconds),
        timeline_seconds: seconds(projectDuration(getProject())),
        ...(r.refused.length ? { refused: r.refused } : {}),
        repetition_left: r.remaining.length ? r.remaining.map((g) => groupLine(g, byId)) : 'none around the cuts',
      }
    },
  },
  {
    name: 'check_quality',
    description:
      'Check the edit for problems before you call it done — run it after editing. Looks at the timeline (gaps and black under sound, offline media, clips running past their media, hidden or muted tracks), captions (overlapping, too short to read, staying on after their words, shown while nobody speaks), titles and captions against the frame and its title-safe area (measured where the compositor draws them), the rendered picture (black or frozen stretches, sampled from real frames), the sound (clipping, loudness against the target, sound that cuts off or jumps in at a cut, silence where the transcript has words) and the picture’s fit (small media blown up, letterboxing on the main track, a canvas the wrong shape for the footage). Each issue has its timeline time, a severity and a suggested fix; many carry a fix as commands to run with batch_edit (a fix that cuts time moves what follows it, so check again before running another one). Critical issues mean the edit isn’t finished: fix them, then check again. Rendering the picture and sound takes a few seconds per minute of video.',
    inputSchema: obj({
      from_seconds: num('Only check from here', { minimum: 0 }),
      to_seconds: num('Only check up to here', { minimum: 0 }),
      picture: bool('Render frames and titles to check them (default true)'),
      sound: bool('Render the mix to check it (default true)'),
      target_lufs: num('Loudness to aim for (default −14, online video; −16 podcasts, −23 broadcast)', { minimum: -36, maximum: -6 }),
    }),
    run: async (a, ctx) => {
      const p = getProject()
      const fps = p.settings.fps
      const range = rangeArg(a)
      const whole = range[0] === 0 && range[1] === projectDuration(p)
      const target = clampNum(number(a, 'target_lufs') ?? -14, -36, -6)
      const measured: string[] = []
      let sound: SoundMeasure | undefined
      let frames: FrameSample[] | undefined
      let boxes: Record<string, TextBox> | undefined
      if (projectDuration(p) > 0 && range[1] > range[0]) {
        if (a.sound !== false) {
          sound = await measureSound(p, range[0] / fps, range[1] / fps, { signal: ctx?.signal, onProgress: (x) => ctx?.progress?.(`Listening to the mix… ${Math.round(x * 100)}%`) })
          measured.push(`the mix, ${sec((range[1] - range[0]) / fps)} s`)
        }
        if (a.picture !== false) {
          const at = sampleFrames(p, range)
          frames = await measurePicture(p, at, { signal: ctx?.signal, onProgress: (x) => ctx?.progress?.(`Watching the picture… ${Math.round(x * 100)}%`) })
          boxes = await measureTextBoxes(p)
          measured.push(`${at.length} frames, one every ${sec((range[1] - range[0]) / fps / Math.max(1, at.length))} s`, `${Object.keys(boxes).length} titles and captions`)
        }
      }
      const issues = checkEdit(p, { sound, frames, boxes, target }, whole ? undefined : range)
      const v = verdict(issues)
      return {
        finished: v.finished,
        summary: v.text,
        issues: issues.slice(0, 80).map(issueLine),
        ...(issues.length > 80 ? { more_issues: issues.length - 80 } : {}),
        checked: measured.length ? measured : ['the timeline only'],
        ...(sound ? { loudness_lufs: sound.lufs === null ? null : Math.round(sound.lufs * 10) / 10, peak_dbfs: Math.round(sound.peakDb * 10) / 10 } : {}),
      }
    },
  },
]
