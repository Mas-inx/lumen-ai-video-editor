/**
 * Cutting speech without cutting words. Every stretch of speech taken out of
 * the timeline — a take, a few words, a range in seconds — is placed in the
 * gaps between words: never inside one, with a breath kept either side, and
 * never through another voice. What had to change to get there is said; a
 * stretch that can't be cut cleanly is refused, with the reason.
 *
 * Where words only have their phrase's timing (Whisper on this computer), the
 * edges are an estimate, so they're moved to the quietest point of the sound
 * nearby before anything is cut.
 */
import { audioStream, isLongAudio, levelFrames, loadAudio } from '@/engine/audio-engine'
import { clipEnd } from './ops'
import { findRetakes, spokenSentences, type RetakeGroup } from './retakes'
import { rippleRemove, speechRegions, sourceRange, timelineWords, toTimeline, voiceClips, type TimelineWord } from './smart'
import { getProject, type ActionSource } from './store'
import { sourceFrameAt } from './timing'
import type { Asset, Clip, Project } from './types'

/** Seconds of quiet kept between a cut and the speech either side of it. */
export const BREATH = 0.1
/** A cut that takes words starts this close before the first of them. */
const LEAD = 0.04

export interface SpeechRemoval {
  /** Whole sentences, by id (see spokenSentences). */
  sentences?: string[]
  /** Some of a sentence's words: the first and the last, inclusive. */
  words?: { sentence: string; from: number; to: number }[]
  /** Timeline seconds [from, to): moved into the gaps between words. */
  ranges?: [number, number][]
}

export interface PlannedCut {
  /** Timeline frames [from, to). */
  from: number
  to: number
  /** The words it takes. */
  text: string
  /** The track whose words it takes (none for a stretch between words). */
  lane?: string
  /** What changed to keep words whole, and what to check by ear. */
  notes: string[]
}

export interface Refused {
  /** What was asked for, in words. */
  what: string
  reason: string
}

/** The words either side of each edge, and whether the edge's timing is only an estimate. */
interface Plan extends PlannedCut {
  around: { from: [TimelineWord?, TimelineWord?]; to: [TimelineWord?, TimelineWord?] }
  estimated: { from: boolean; to: boolean }
  /** The edges were given (a range), rather than placed around words. */
  asked?: boolean
}

/** "1:02.5" */
export const clock = (sec: number) => {
  const m = Math.floor(Math.max(0, sec) / 60)
  return `${m}:${(Math.max(0, sec) - m * 60).toFixed(1).padStart(4, '0')}`
}

const said = (words: TimelineWord[]) => words.map((w) => w.text).join(' ')

/** The frame nearest `t` inside [lo, hi] (seconds), or null when no frame falls inside. */
function frameIn(t: number, lo: number, hi: number, fps: number) {
  const eps = 1e-6
  let f = Math.round(t * fps)
  if (f < lo * fps - eps) f = Math.ceil(lo * fps - eps)
  if (f > hi * fps + eps) f = Math.floor(hi * fps + eps)
  return f >= lo * fps - eps && f <= hi * fps + eps ? f : null
}

/** Where an edge's timing comes from the transcriber, not from spreading a phrase over its words. */
const timedStart = (w: TimelineWord | undefined) => !w || w.timed || Boolean(w.phraseStart)
const timedEnd = (w: TimelineWord | undefined) => !w || w.timed || Boolean(w.phraseEnd)

/** The words said just before and just after a run of one voice's words — by anyone. */
function around(all: TimelineWord[], run: TimelineWord[]) {
  const first = run[0]
  const last = run[run.length - 1]
  const own = new Set(run)
  let prev: TimelineWord | undefined
  let next: TimelineWord | undefined
  for (const w of all) {
    if (own.has(w)) continue
    if (w.start < first.start && (!prev || w.end > prev.end)) prev = w
    if (w.start > last.start && (!next || w.start < next.start)) next = w
  }
  return { prev, next }
}

/**
 * The cut that takes words i..j of one voice: from just before the first (a
 * breath clear of whatever was said before it) to a breath before the next word
 * anyone says — so the pause before what goes stays and the one after it closes
 * up. `asked` keeps the edges someone gave, as far as the words allow.
 */
function placeWords(all: TimelineWord[], lane: TimelineWord[], i: number, j: number, fps: number, asked?: [number, number]): Plan | string {
  const first = lane[i]
  const last = lane[j]
  const { prev, next } = around(all, lane.slice(i, j + 1))
  const notes: string[] = []
  const gapBefore = prev ? Math.max(0, first.start - prev.end) : Infinity
  const aLo = prev ? prev.end + Math.min(BREATH, gapBefore / 2) : 0
  const aHi = first.start
  const aWant = asked ? Math.min(asked[0], aHi) : first.start - Math.min(LEAD, gapBefore / 2)
  const gapAfter = next ? Math.max(0, next.start - last.end) : Infinity
  const bLo = last.end
  const bHi = next ? next.start - Math.min(BREATH, gapAfter / 2) : Infinity
  const bWant = asked ? Math.max(asked[1], bLo) : next ? bHi : last.end + BREATH
  let from = frameIn(Math.max(aWant, aLo), aLo, aHi, fps)
  let to = frameIn(Math.min(bWant, bHi), bLo, bHi, fps)
  if (from === null) {
    from = Math.round((((prev?.end ?? aHi) + aHi) / 2) * fps)
    notes.push(`No pause before “${first.text}” at ${clock(first.start)} — check the cut by ear.`)
  }
  if (to === null) {
    to = Math.round(((bLo + (next?.start ?? bLo)) / 2) * fps)
    notes.push(`No pause after “${last.text}” at ${clock(last.end)} — check the cut by ear.`)
  }
  if (to <= from) return 'nothing is left to cut once the words either side are kept whole'
  return {
    from: Math.max(0, from),
    to,
    text: said(lane.slice(i, j + 1)),
    lane: first.lane,
    notes,
    around: { from: [prev, first], to: [last, next] },
    estimated: { from: !(timedEnd(prev) && timedStart(first)), to: !(timedEnd(last) && timedStart(next)) },
    ...(asked ? { asked: true } : {}),
  }
}

/**
 * A range someone gave in seconds, made safe: words it covers mostly are taken
 * whole, words it only clips are left whole, and a range between words keeps a
 * breath from them. Words of two voices at once can't be cut apart.
 */
function placeRange(words: TimelineWord[], lanes: Map<string, TimelineWord[]>, a: number, b: number, fps: number): Plan | string {
  const over = words.filter((w) => w.end > a && w.start < b)
  const taken = over.filter((w) => Math.min(b, w.end) - Math.max(a, w.start) >= (w.end - w.start) / 2)
  const notes = over.filter((w) => !taken.includes(w)).map((w) => `Kept “${w.text}” at ${clock(w.start)} whole: the range only clipped it.`)
  if (!taken.length) {
    // Between words: a pause, cut a breath clear of the speech either side.
    const inside = over.find((w) => w.start <= a && w.end >= b)
    if (inside) return `it falls inside the word “${inside.text}” at ${clock(inside.start)}`
    let lo = a
    let hi = b
    for (const w of words) {
      // Words that stick into the range, or end / start within a breath of it.
      if (w.start < a && w.end > a - BREATH) lo = Math.max(lo, w.end + BREATH)
      if (w.end > b && w.start < b + BREATH) hi = Math.min(hi, w.start - BREATH)
    }
    const from = Math.ceil(lo * fps - 1e-6)
    const to = Math.floor(hi * fps + 1e-6)
    if (to <= from) return 'there’s nothing between the words to cut once a breath is kept either side'
    return { from: Math.max(0, from), to, text: '', notes, around: { from: [undefined, undefined], to: [undefined, undefined] }, estimated: { from: false, to: false }, asked: true }
  }
  const voices = [...new Set(taken.map((w) => w.lane))]
  if (voices.length > 1) {
    const other = taken.find((w) => w.lane !== taken[0].lane)!
    return `two voices speak in it (“${taken[0].text}” and “${other.text}”) — cut one voice at a time`
  }
  const lane = lanes.get(voices[0])!
  const i = lane.indexOf(taken[0])
  const j = lane.indexOf(taken[taken.length - 1])
  for (const w of new Set([lane[i], lane[j]])) if (w.start < a || w.end > b) notes.push(`Took all of “${w.text}” at ${clock(w.start)}: the range went through it.`)
  const plan = placeWords(words, lane, i, j, fps, [a, b])
  if (typeof plan !== 'string') plan.notes.unshift(...notes)
  return plan
}

/**
 * Voices without a transcript, heard from their sound: each stretch of it stands
 * in for words nobody may cut into (the whole clip, when its sound can't be read).
 */
async function untranscribedSpeech(project: Project): Promise<Map<TimelineWord, string>> {
  const fps = project.settings.fps
  const out = new Map<TimelineWord, string>()
  const add = (clip: Clip, a: number, b: number) => out.set({ start: a, end: b, text: '[speech, not transcribed]', clipId: clip.id, lane: clip.trackId, assetId: clip.assetId!, source: 0, timed: true, phraseStart: true, phraseEnd: true }, clip.name)
  for (const clip of voiceClips(project)) {
    const asset = project.assets[clip.assetId!]
    if (asset.transcript?.length || clip.reverse) continue
    const speech = await speechRegions(project, clip)
    if (!speech) {
      add(clip, clip.start / fps, clipEnd(clip) / fps)
      continue
    }
    const [s0, s1] = sourceRange(project, clip)
    for (const [x, y] of speech.regions) if (y > s0 && x < s1) add(clip, toTimeline(project, clip, Math.max(x, s0)) / fps, toTimeline(project, clip, Math.min(y, s1)) / fps)
  }
  return out
}

/** Sound levels (dB every 20 ms) of a stretch of media from `s0` (source seconds). */
async function levelsAround(asset: Asset, s0: number, s1: number): Promise<Float32Array | null> {
  const a = Math.max(0, s0)
  if (s1 <= a) return null
  if (isLongAudio(asset)) {
    const stream = await audioStream(asset)
    const buffer = stream ? await stream.read(a, s1) : null
    return buffer ? levelFrames(buffer) : null
  }
  const buffer = await loadAudio(asset)
  if (!buffer) return null
  const i0 = Math.floor(a * buffer.sampleRate)
  const i1 = Math.min(buffer.length, Math.ceil(s1 * buffer.sampleRate))
  if (i1 <= i0) return null
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c).subarray(i0, i1))
  return levelFrames({ sampleRate: buffer.sampleRate, length: i1 - i0, numberOfChannels: channels.length, getChannelData: (c: number) => channels[c] })
}

/**
 * Moves an edge whose timing is only an estimate into the pause the sound has
 * between the words around it, the way placeWords would with real timings: a
 * breath clear of the speech either side, and — for a take — just before what
 * comes next. Where the voice never drops, the edge stays and the cut is
 * flagged to check by ear.
 */
async function settleInSound(project: Project, plan: Plan, edge: 'from' | 'to') {
  const fps = project.settings.fps
  const [left, right] = plan.around[edge]
  const word = (edge === 'from' ? right : left) ?? left ?? right
  const clip = word ? project.clips[word.clipId] : undefined
  const asset = clip?.assetId ? project.assets[clip.assetId] : undefined
  if (!clip || !asset) return
  const t = plan[edge] / fps
  const lo = Math.max(t - 0.4, left ? (left.start + left.end) / 2 : -Infinity, clip.start / fps)
  const hi = Math.min(t + 0.4, right ? (right.start + right.end) / 2 : Infinity, clipEnd(clip) / fps)
  if (hi - lo < 0.06) return
  const src = (T: number) => sourceFrameAt(clip, T * fps - clip.start) / fps
  const s0 = Math.min(src(lo), src(hi))
  const db = await levelsAround(asset, s0, Math.max(src(lo), src(hi)) + 0.02)
  if (!db?.length) return
  const steps: { T: number; v: number }[] = []
  for (let T = lo; T <= hi + 1e-9; T += 0.02) steps.push({ T, v: db[Math.min(db.length - 1, Math.max(0, Math.floor((src(T) - s0) / 0.02)))] })
  const quiet = Math.min(...steps.map((s) => s.v))
  const loud = Math.max(...steps.map((s) => s.v))
  if (loud - quiet < 10) {
    plan.notes.push(`The voice doesn’t pause at ${clock(t)} — check the cut by ear.`)
    return
  }
  // The pause: the quiet stretch around the quietest moment (nearest the estimate).
  const still = (s: { v: number }) => s.v <= quiet + 6
  let k = steps.reduce((best, s, i) => (still(s) && Math.abs(s.T - t) < Math.abs(steps[best].T - t) ? i : best), steps.findIndex(still))
  let a = k
  while (a > 0 && still(steps[a - 1])) a--
  while (k < steps.length - 1 && still(steps[k + 1])) k++
  const qs = steps[a].T
  const qe = steps[k].T + 0.02
  const breath = Math.min(BREATH, (qe - qs) / 2)
  const at = plan.asked ? Math.min(Math.max(t, qs + breath), qe - breath) : edge === 'from' ? Math.max(qs + breath, qe - LEAD) : qe - breath
  plan[edge] = Math.round(at * fps)
}

/** Cuts with nothing said between them become one. */
function merge(plans: Plan[], words: TimelineWord[], fps: number): Plan[] {
  const out: Plan[] = []
  for (const p of [...plans].sort((x, y) => x.from - y.from)) {
    const last = out[out.length - 1]
    const between = last && words.some((w) => (w.start + w.end) / 2 > last.to / fps && (w.start + w.end) / 2 < p.from / fps)
    if (last && (p.from <= last.to || (p.from - last.to <= Math.round(0.3 * fps) && !between))) {
      if (p.to > last.to) {
        last.to = p.to
        last.around.to = p.around.to
        last.estimated.to = p.estimated.to
      }
      last.text = [last.text, p.text].filter(Boolean).join(' … ')
      last.lane = last.lane ?? p.lane
      last.notes.push(...p.notes)
    } else out.push({ ...p, notes: [...p.notes], around: { ...p.around }, estimated: { ...p.estimated } })
  }
  return out
}

/**
 * Works out the cuts a removal makes — in the gaps between words, never through
 * another voice — without changing anything. What can't be cut cleanly comes
 * back in `refused`.
 */
export async function planSpeechCuts(project: Project, req: SpeechRemoval): Promise<{ cuts: PlannedCut[]; refused: Refused[] }> {
  const fps = project.settings.fps
  const words = timelineWords(project)
  const sentences = spokenSentences(project, words)
  const unheard = await untranscribedSpeech(project)
  // Everything said, transcribed or only heard: what a cut has to stay clear of.
  const everyone = [...words, ...unheard.keys()].sort((x, y) => x.start - y.start)
  const lanes = new Map<string, TimelineWord[]>()
  for (const w of everyone) {
    const list = lanes.get(w.lane)
    if (list) list.push(w)
    else lanes.set(w.lane, [w])
  }
  const plans: Plan[] = []
  const refused: Refused[] = []
  const add = (what: string, plan: Plan | string) => (typeof plan === 'string' ? refused.push({ what, reason: plan }) : plans.push(plan))
  const sentence = (id: string) => sentences.find((s) => s.id === id)
  const gone = 'it isn’t on the timeline any more — find the sentences again for their current ids'

  for (const id of new Set(req.sentences ?? [])) {
    const s = sentence(id)
    if (!s) refused.push({ what: `sentence ${id}`, reason: gone })
    else {
      const lane = lanes.get(s.lane)!
      add(`“${s.text}”`, placeWords(everyone, lane, lane.indexOf(s.words[0]), lane.indexOf(s.words[s.words.length - 1]), fps))
    }
  }
  for (const w of req.words ?? []) {
    const s = sentence(w.sentence)
    if (!s) refused.push({ what: `words of sentence ${w.sentence}`, reason: gone })
    else if (!(w.from >= 0 && w.to >= w.from && w.to < s.words.length)) refused.push({ what: `words ${w.from}–${w.to} of “${s.text}”`, reason: `it has words 0–${s.words.length - 1}` })
    else {
      const lane = lanes.get(s.lane)!
      add(`“${said(s.words.slice(w.from, w.to + 1))}”`, placeWords(everyone, lane, lane.indexOf(s.words[w.from]), lane.indexOf(s.words[w.to]), fps))
    }
  }
  for (const [a, b] of req.ranges ?? []) {
    if (!(b > a)) refused.push({ what: `${clock(a)}–${clock(b)}`, reason: 'the end has to come after the start' })
    else add(`${clock(a)}–${clock(b)}`, placeRange(everyone, lanes, a, b, fps))
  }

  // Estimated edges go into the pause the sound has there.
  for (const p of plans) {
    for (const edge of ['from', 'to'] as const) if (p.estimated[edge]) await settleInSound(project, p, edge)
    if (p.estimated.from || p.estimated.to) p.notes.push('Word timings are estimated here — check the cut by ear.')
  }
  const cuts: PlannedCut[] = []
  for (const p of merge(plans, everyone, fps)) {
    const what = p.text ? `“${p.text}”` : `${clock(p.from / fps)}–${clock(p.to / fps)}`
    if (p.to <= p.from) {
      refused.push({ what, reason: 'nothing is left to cut once the words either side are kept whole' })
      continue
    }
    const a = p.from / fps
    const b = p.to / fps
    // Never through another voice.
    const other = everyone.find((w) => w.lane !== p.lane && Math.min(b, w.end) - Math.max(a, w.start) > 0.04)
    if (other && unheard.has(other)) refused.push({ what, reason: `“${unheard.get(other)}” has speech there that isn’t transcribed — cutting it would take that too` })
    else if (other) refused.push({ what, reason: `another voice speaks there (“${other.text}” at ${clock(other.start)}) — cutting it would take their words too` })
    else cuts.push({ from: p.from, to: p.to, text: p.text, ...(p.lane ? { lane: p.lane } : {}), notes: [...new Set(p.notes)] })
  }
  return { cuts, refused }
}

export interface SpeechCut extends PlannedCut {
  /** Where the join landed once every cut before it closed up too (frames). */
  join: number
  /** What's said right after the join, and where it starts now (timeline seconds). */
  next?: { text: string; start: number }
}

export interface SpeechCutResult {
  cuts: SpeechCut[]
  refused: Refused[]
  seconds: number
  /** Repeats still there around the joins, once the cuts are made. */
  remaining: RetakeGroup[]
}

/** Repeats within `window` seconds of the joins (frames). */
export function repeatsNear(project: Project, joins: number[], window = 20): RetakeGroup[] {
  const fps = project.settings.fps
  const at = joins.map((f) => f / fps)
  return findRetakes(spokenSentences(project)).filter((g) => g.takes.some((t) => at.some((s) => t.start - window <= s && s <= t.end + window)))
}

/**
 * Takes speech out of the timeline as one undo step, rippling like removing
 * pauses: captions, B-roll, markers, effects and keyframes stay in sync and
 * music beds play on. Then checks the sentences around each join again.
 */
export async function removeSpeech(req: SpeechRemoval, opts: { label?: string; source?: ActionSource } = {}): Promise<SpeechCutResult> {
  const { cuts, refused } = await planSpeechCuts(getProject(), req)
  if (!cuts.length) return { cuts: [], refused, seconds: 0, remaining: [] }
  const r = rippleRemove(
    cuts.map((c) => [c.from, c.to]),
    opts.label ?? 'Cut speech',
    opts.source ?? 'ai',
  )
  const after = getProject()
  const fps = after.settings.fps
  const sentences = spokenSentences(after)
  const done: SpeechCut[] = []
  r.removed.forEach(([a, b], k) => {
    const plan = cuts.find((c) => c.from === a && c.to === b)
    if (!plan) return
    const join = r.joins[k]
    // What's said next on that voice, from the join on.
    const s = sentences.find((x) => (!plan.lane || x.lane === plan.lane) && x.end > join / fps)
    const w = s?.words.find((x) => x.start >= join / fps - 0.02)
    const rest = s && w ? said(s.words.slice(s.words.indexOf(w))) : ''
    done.push({ ...plan, join, ...(w ? { next: { text: rest.length > 120 ? `${rest.slice(0, 119)}…` : rest, start: w.start } } : {}) })
  })
  for (const c of cuts) if (!done.some((d) => d.from === c.from && d.to === c.to)) refused.push({ what: c.text ? `“${c.text}”` : 'a stretch', reason: 'the timeline wouldn’t take it out' })
  return { cuts: done, refused, seconds: r.seconds, remaining: repeatsNear(after, r.joins) }
}

/** The choice for each group that's applied unless someone says otherwise: the suggestion when it's sure, every take otherwise. */
export function defaultChoices(groups: RetakeGroup[], sure: number): Record<string, number | 'all'> {
  return Object.fromEntries(groups.map((g) => [g.id, g.confidence >= sure ? g.keep : 'all']))
}

/** What choosing a take in each group takes out: the other takes and the asides between them. 'all' keeps every take. */
export function takesToRemove(groups: RetakeGroup[], choices: Record<string, number | 'all'>): SpeechRemoval {
  const sentences: string[] = []
  const words: { sentence: string; from: number; to: number }[] = []
  for (const g of groups) {
    const keep = choices[g.id]
    if (keep === undefined || keep === 'all' || !g.takes[keep]) continue
    if (g.stumble) {
      const { first, second } = g.stumble
      const sentence = g.takes[0].sentenceId
      words.push(keep === 0 ? { sentence, from: first[1] + 1, to: second[1] } : { sentence, from: first[0], to: second[0] - 1 })
    } else {
      g.takes.forEach((t, i) => i !== keep && sentences.push(t.sentenceId))
      sentences.push(...g.asides)
    }
  }
  return { sentences: [...new Set(sentences)], words }
}
