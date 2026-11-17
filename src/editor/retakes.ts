/**
 * Repeated takes in spoken-word footage. The timeline transcript is split into
 * sentences (punctuation, pauses, the transcriber's phrases), and what a voice
 * said more than once is grouped — word-for-word repeats, near repeats, false
 * starts that stop and start over, and words said twice in a row inside a
 * sentence — with the take to keep, why, and how sure that is.
 *
 * Only the wording is compared. A line said again in other words is the
 * Copilot's call (it gets the sentences); repetition that's likely on purpose —
 * a short emphatic repeat, a rhetorical triple, a call to action at the start
 * and the end — comes out unsure, so it stays unless someone chooses otherwise.
 */
import { hashString } from '@/lib/math'
import { timelineWords, type TimelineWord } from './smart'
import type { Project } from './types'

// ─── Words ───────────────────────────────────────────────────────────────

const FILLERS = new Set(['um', 'umm', 'uh', 'uhh', 'uhm', 'er', 'erm', 'ah', 'ahh', 'eh', 'hmm', 'hm', 'mm', 'mmm'])

/** Openers left out of a comparison: “So, the first thing…” is “the first thing…” said again. */
const OPENERS = new Set(['so', 'okay', 'ok', 'alright', 'well', 'now', 'right', 'and', 'but', 'oh', 'anyway', 'yeah'])

/** Words with no content of their own. Negations and numbers aren't here: they change what's said. */
const FUNCTION = new Set(
  'a an the and or but so to of in on at for with from by as into onto about than then that this these those it its is are was were be been being am do does did done have has had will would can could should shall may might must i we you he she they me us him her them my our your his their what which who whom whose there here if because just also really very quite like okay ok well now right oh yeah'.split(' '),
)

/** A sentence that ends on one of these hasn't finished (“you”, “it” and “that” can end one). */
const DANGLING = new Set(
  'a an the and or but so to of in on at for with from by as into about than because if when while is are was were be am do does did have has had will would can could should might must i we he she they my our your their its very really just'.split(' '),
)

/** Said twice in a row on purpose: “very, very”, “no, no”. */
const EMPHATIC = new Set(
  'very really so no yes yeah never more much many far way too oh go come bye hey ha please again now well wow okay ok right hello hi thanks thank yay boom up down faster slower bigger better'.split(' '),
)

/** Doubles that are often just grammar: “that that”, “had had”, “what it is is”. */
const DOUBLES = new Set(['that', 'had', 'is'])

const NUMBER_WORDS = new Set(
  'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million billion first second third fourth fifth'.split(' '),
)

const CONTRACTIONS: [RegExp, string][] = [
  [/^can't$/, 'can not'],
  [/^won't$/, 'will not'],
  [/^(\w+)n't$/, '$1 not'],
  [/^(\w+)'re$/, '$1 are'],
  [/^(\w+)'ll$/, '$1 will'],
  [/^(\w+)'ve$/, '$1 have'],
  [/^i'm$/, 'i am'],
  [/^(\w+)'d$/, '$1 would'],
  [/^let's$/, 'let us'],
  [/^(it|that|what|there|here|he|she|who|where|how)'s$/, '$1 is'],
  [/^(\w+)'s$/, '$1'],
]

/** A word as compared: lower case, no punctuation, contractions spelled out (“we're” → we are). */
export function wordTokens(text: string): string[] {
  let w = text
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .replace(/(\d),(\d)/g, '$1$2')
  if (!w) return []
  for (const [re, to] of CONTRACTIONS) {
    if (re.test(w)) {
      w = w.replace(re, to)
      break
    }
  }
  return w
    .split(/[\s\-–—/']+/)
    .map((s) => s.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean)
}

const stem = (w: string) => w.replace(/(?:ing|ed|es|s|ly)$/, '')

function letters(a: string, b: string) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[b.length]
}

/** Two words that are the same word as transcribed: identical, or a plural / spelling apart. Numbers must match exactly. */
export function sameWord(a: string, b: string) {
  if (a === b) return true
  if (a.length < 5 || b.length < 5 || a.slice(0, 2) !== b.slice(0, 2) || /\d/.test(a + b) || NUMBER_WORDS.has(a) || NUMBER_WORDS.has(b)) return false
  return stem(a) === stem(b) || letters(a, b) <= 1
}

/** Longest common subsequence of two token lists: its length, and which tokens of each are in it. */
export function align(a: string[], b: string[]) {
  const m = a.length
  const n = b.length
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1))
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) dp[i][j] = sameWord(a[i], b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const inA: boolean[] = new Array(m).fill(false)
  const inB: boolean[] = new Array(n).fill(false)
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (sameWord(a[i], b[j]) && dp[i][j] === dp[i + 1][j + 1] + 1) {
      inA[i] = inB[j] = true
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++
    else j++
  }
  return { length: dp[0][0], inA, inB }
}

/** Edit distance in words (insertions, deletions, substitutions). */
export function wordDistance(a: string[], b: string[]) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (sameWord(a[i - 1], b[j - 1]) ? 0 : 1))
    prev = cur
  }
  return prev[b.length]
}

/** `short` is how `long` starts, give or take a word: a false start of it. */
export function startsLike(short: string[], long: string[]) {
  if (!short.length || short.length >= long.length || !sameWord(short[0], long[0])) return false
  const covered = align(short, long.slice(0, short.length + 1)).length / short.length
  return covered >= (short.length <= 3 ? 1 : 0.75)
}

/** How many words two token lists start with in common. */
function sharedStart(a: string[], b: string[]) {
  let n = 0
  while (n < a.length && n < b.length && sameWord(a[n], b[n])) n++
  return n
}

// ─── Sentences ───────────────────────────────────────────────────────────

export interface Token {
  /** Normalized (see wordTokens). */
  t: string
  /** Which of the sentence's words it came from. */
  word: number
  filler: boolean
}

export interface Sentence {
  /** Stays the same while its words stay on the timeline: the media and the second the sentence starts at. */
  id: string
  text: string
  /** Timeline seconds. */
  start: number
  end: number
  /** The track it's heard on. */
  lane: string
  words: TimelineWord[]
  tokens: Token[]
}

const ENDS = /[.!?…]["”’')\]]*$/
const TRAILS = /(?:\.\.\.|…)["”’')\]]*$/
const CUT_OFF = /(?:-|–|—|\.\.\.|…)["”’')\]]*$/
const ABBREVIATION = /^(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|e\.g|i\.e|a\.m|p\.m|u\.s|inc|ltd|no)\.$/i
const capital = (w: TimelineWord | undefined) => Boolean(w && /^["“']?\p{Lu}/u.test(w.text) && !/^["“']?I(?:\b|')/.test(w.text))

/** Whether a sentence ends after word `i` of a voice's words. */
function endsAfter(words: TimelineWord[], i: number, length: number) {
  const w = words[i]
  const next = words[i + 1]
  if (!next) return true
  const gap = next.start - w.end
  if (gap >= 1) return true
  if (CUT_OFF.test(w.text) && !TRAILS.test(w.text)) return gap >= 0.25 || capital(next)
  if (TRAILS.test(w.text)) return gap >= 0.3 || capital(next)
  if (ENDS.test(w.text) && !ABBREVIATION.test(w.text)) return true
  if (w.phraseEnd && next.phraseStart && gap >= 0.5) return true
  if (length >= 40 && (/,["”’')\]]*$/.test(w.text) || gap >= 0.35)) return true
  return length >= 60
}

const anchor = (assetId: string) => hashString(assetId).toString(36).slice(0, 4).padStart(4, '0')

/** Items by a key, keeping their order. */
function byKey<T>(items: Iterable<T>, key: (item: T) => string) {
  const out = new Map<string, T[]>()
  for (const item of items) {
    const k = key(item)
    const list = out.get(k)
    if (list) list.push(item)
    else out.set(k, [item])
  }
  return out
}

/**
 * What's said on the timeline as sentences, per voice (track), in time order.
 * Ids are anchored to the media, so they survive edits elsewhere on the timeline.
 */
export function spokenSentences(project: Project, words: TimelineWord[] = timelineWords(project)): Sentence[] {
  const lanes = byKey(words, (w) => w.lane)
  const out: Sentence[] = []
  const seen = new Map<string, number>()
  for (const [lane, list] of lanes) {
    let cur: TimelineWord[] = []
    list.forEach((w, i) => {
      cur.push(w)
      if (!endsAfter(list, i, cur.length)) return
      const base = `${anchor(cur[0].assetId)}@${Math.round(cur[0].source * 100)}`
      const n = (seen.get(base) ?? 0) + 1
      seen.set(base, n)
      out.push({
        id: n > 1 ? `${base}#${n}` : base,
        text: cur.map((x) => x.text).join(' '),
        start: cur[0].start,
        end: cur[cur.length - 1].end,
        lane,
        words: cur,
        tokens: cur.flatMap((x, k) => wordTokens(x.text).map((t) => ({ t, word: k, filler: FILLERS.has(t) }))),
      })
      cur = []
    })
  }
  return out.sort((a, b) => a.start - b.start)
}

/** The tokens a sentence is compared by: no fillers, no openers in front. */
function comparable(s: Sentence) {
  const t = s.tokens.filter((k) => !k.filler).map((k) => k.t)
  while (t.length > 1 && OPENERS.has(t[0])) t.shift()
  return t.length === 1 && OPENERS.has(t[0]) ? [] : t
}

// ─── Groups ──────────────────────────────────────────────────────────────

export type TakeKind = 'restart' | 'repeat' | 'similar' | 'stumble'

export interface Take {
  sentenceId: string
  /** A stumble's take: which of the sentence's words (first and last, inclusive). */
  words?: [number, number]
  text: string
  /** Timeline seconds. */
  start: number
  end: number
}

export interface RetakeGroup {
  /** Stays the same while its first take stays on the timeline. */
  id: string
  kind: TakeKind
  takes: Take[]
  /** The take to keep (index into takes). */
  keep: number
  /** 0..1. Below SURE nothing goes unless someone chooses it. */
  confidence: number
  reason: string
  /** Sentences between the takes that only ask for another go (“sorry, let me start again”): they go with the takes that go. */
  asides: string[]
  lane: string
  /** A stumble: the sentence it's in, and its two runs of words (first and last word of each). */
  stumble?: { sentence: string; first: [number, number]; second: [number, number] }
}

/** From here up, a suggestion is applied unless someone says otherwise. */
export const SURE = 0.75

const ASIDE = /\b(?:sorry|start (?:again|over)|(?:try|do|say) (?:that|this|it )?again|one more time|scratch that|from the top|take (?:two|three|2|3)|let me (?:re)?(?:say|do|start|try|phrase)|hold on|redo|again)\b/i

const quote = (s: string, max = 60) => `“${s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s}”`
const quoteWords = (words: string[]) => words.slice(0, 4).map((w) => `“${w}”`).join(', ') + (words.length > 4 ? '…' : '')

function minutes(sec: number) {
  if (sec < 90) return `${Math.round(sec)} s`
  return `${Math.round(sec / 60)} min`
}

/** Words of `a` with content that `b` doesn't have (fillers and function words aside). */
function extraWords(a: string[], b: string[], toleratedTail: boolean) {
  const { inA } = align(a, b)
  const extra: string[] = []
  a.forEach((t, i) => {
    if (inA[i] || FUNCTION.has(t) || FILLERS.has(t)) return
    // A false start's last word is often cut off half-said.
    if (toleratedTail && i === a.length - 1) return
    extra.push(t)
  })
  return extra
}

/** The sentence ends mid-thought: cut off, trailing away, or on a word that needs another. */
function dangles(s: Sentence) {
  const last = s.words[s.words.length - 1]
  if (CUT_OFF.test(last.text)) return true
  const core = s.tokens.filter((k) => !k.filler)
  const tail = s.tokens[s.tokens.length - 1]
  if (tail?.filler) return true
  return Boolean(core.length && DANGLING.has(core[core.length - 1].t))
}

/** Whether the edges of a sentence's cut sit on timings the transcriber gave (not on an estimate inside a phrase). */
function timedEdges(words: TimelineWord[], laneWords: TimelineWord[], from: number, to: number) {
  const first = words[from]
  const last = words[to]
  const i = laneWords.indexOf(first)
  const j = laneWords.indexOf(last)
  const prev = laneWords[i - 1]
  const next = laneWords[j + 1]
  const startOk = (first.timed || first.phraseStart) && (!prev || prev.timed || prev.phraseEnd)
  const endOk = (last.timed || last.phraseEnd) && (!next || next.timed || next.phraseStart)
  return Boolean(startOk && endOk)
}

const ESTIMATED = ' Word timings are estimated here — check the cut by ear.'

/**
 * Groups the sentences a voice said more than once, choosing the take to keep:
 * the one that finishes (not cut off by a restart, not trailing away), and that
 * says everything the others do — a take with words the others lack is never
 * dropped for them. Ambiguous and likely deliberate repeats come out below SURE.
 */
export function findRetakes(sentences: Sentence[]): RetakeGroup[] {
  const lanes = byKey(sentences, (s) => s.lane)
  const groups: RetakeGroup[] = []
  for (const [lane, list] of lanes) {
    list.sort((a, b) => a.start - b.start)
    const cmp = list.map(comparable)
    const laneWords = list.flatMap((s) => s.words)
    // Union-find over related sentences.
    const parent = list.map((_, i) => i)
    const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i])))
    const join = (i: number, j: number) => {
      parent[root(j)] = root(i)
    }
    for (let i = 0; i < list.length; i++) {
      const a = cmp[i]
      if (!a.length) continue
      for (let j = i + 1; j < list.length && j <= i + 4; j++) {
        const b = cmp[j]
        if (!b.length || list[j].start - list[i].end > 30) continue
        const exact = a.length === b.length && align(a, b).length === a.length
        // A word or two said twice is only a take when it comes right after.
        if (exact && a.length < 3 && (j !== i + 1 || list[j].start - list[i].end > 3)) continue
        const restart = startsLike(a, b) || startsLike(b, a)
        // Broken off and started over in other words: “We went with the— We picked React.”
        const brokeOff = dangles(list[i]) && b.length >= 3 && sharedStart(a, b) >= Math.max(2, Math.ceil(a.length * 0.4))
        const shorter = Math.min(a.length, b.length)
        const common = shorter >= 3 ? align(a, b).length : 0
        const similar = shorter >= 3 && common / Math.max(a.length, b.length) >= 0.6 && common / shorter >= 0.7 && 1 - wordDistance(a, b) / Math.max(a.length, b.length) >= 0.5
        if (exact || restart || brokeOff || similar) join(i, j)
      }
    }
    const members = byKey(
      list.map((_, i) => i),
      (i) => String(root(i)),
    )
    const alone: number[] = []
    for (const idx of members.values()) {
      if (idx.length < 2) alone.push(idx[0])
      else groups.push(sentenceGroup(lane, list, cmp, laneWords, idx))
    }
    // The same line said again much later, apart from any retake: likely on purpose, so it stays.
    const repeated = byKey(
      alone.filter((i) => cmp[i].length >= 3),
      (i) => cmp[i].join(' '),
    )
    for (const idx of repeated.values()) if (idx.length >= 2) groups.push(sentenceGroup(lane, list, cmp, laneWords, idx))
  }
  // Words said twice inside a sentence — except in a take that's going anyway.
  const dropped = new Set(groups.filter((g) => g.confidence >= SURE).flatMap((g) => g.takes.filter((_, i) => i !== g.keep).map((t) => t.sentenceId)))
  for (const [, list] of lanes) {
    const laneWords = list.flatMap((s) => s.words)
    for (const s of list) if (!dropped.has(s.id)) groups.push(...stumbles(s, laneWords))
  }
  return groups.sort((a, b) => a.takes[0].start - b.takes[0].start)
}

function sentenceGroup(lane: string, list: Sentence[], cmp: string[][], laneWords: TimelineWord[], idx: number[]): RetakeGroup {
  const takes = idx.map((i) => list[i])
  const toks = idx.map((i) => cmp[i])
  const n = takes.length
  const dangling = takes.map(dangles)
  // A take that's how a longer one starts, and stops mid-thought or well short of it, was cut off (a false start).
  const cutShort = (i: number, j: number) => startsLike(toks[i], toks[j]) && (dangling[i] || toks[i].length < toks[j].length * 0.6)
  const partial = toks.map((_, i) => toks.some((_o, j) => j !== i && cutShort(i, j)))
  let candidates = idx.map((_, i) => i).filter((i) => !partial[i] && !dangling[i])
  if (!candidates.length) candidates = idx.map((_, i) => i).filter((i) => !partial[i])
  if (!candidates.length) candidates = idx.map((_, i) => i)
  const missing = (k: number) => toks.reduce((sum, t, i) => (i === k ? sum : sum + extraWords(t, toks[k], partial[i]).length), 0)
  const keep = candidates.reduce((best, k) => {
    const d = missing(k) - missing(best)
    if (d !== 0) return d < 0 ? k : best
    if (toks[k].length !== toks[best].length) return toks[k].length > toks[best].length ? k : best
    return k > best ? k : best
  })
  const others = toks.map((_, i) => i).filter((i) => i !== keep)
  const same = (i: number) => toks[i].length === toks[keep].length && align(toks[i], toks[keep]).length === toks[keep].length
  const prefix = (i: number) => cutShort(i, keep)
  // Broken off and started over in other words: what it had is unfinished, not extra.
  const brokeOff = (i: number) => !same(i) && !prefix(i) && dangling[i] && sharedStart(toks[i], toks[keep]) >= 2
  const extra = others.map((i) => (brokeOff(i) ? [] : extraWords(toks[i], toks[keep], partial[i])))
  const ambiguous = extra.some((e) => e.length > 0)
  const exact = others.every(same)
  const restart = others.every((i) => prefix(i) || brokeOff(i))
  const kind: TakeKind = restart ? 'restart' : exact ? 'repeat' : 'similar'
  const label = (i: number) => `take ${i + 1}`
  const Label = (i: number) => `Take ${i + 1}`

  // How far apart the takes are: sentences of this voice in between, and seconds.
  const spread = idx[idx.length - 1] - idx[0] - (n - 1)
  const apart = Math.max(...takes.slice(1).map((t, i) => t.start - takes[i].end))
  const far = apart > 45 || spread > 6

  let confidence: number
  let reason: string
  if (kind === 'restart') {
    const cut = others.some((i) => CUT_OFF.test(takes[i].words[takes[i].words.length - 1].text))
    const oneWord = others.every((i) => toks[i].length === 1)
    confidence = oneWord ? (cut ? 0.8 : 0.55) : cut || others.every((i) => dangling[i]) ? 0.9 : 0.78
    const stops = others.map((i) => `${label(i)} (${quote(takes[i].text, 40)})`).join(' and ')
    reason = `${stops[0].toUpperCase()}${stops.slice(1)} ${others.length > 1 ? 'stop' : 'stops'} part-way; ${label(keep)} says it in full.`
    if (oneWord && !cut) reason += ' One word on its own could be meant, though.'
    if (others.some(brokeOff)) {
      confidence = Math.min(confidence, 0.6)
      reason += ' It starts over in other words — check nothing the first take had is missing.'
    }
  } else if (kind === 'repeat') {
    if (far) {
      confidence = 0.2
      reason = `Said again ${minutes(apart)} later — likely on purpose (a callback, or a call to action at the start and the end).`
    } else if (n >= 3 && toks[keep].length <= 6) {
      confidence = 0.15
      reason = `Said ${n} times in a row — a deliberate pattern, most likely.`
    } else if (toks[keep].length <= 3) {
      confidence = 0.35
      reason = 'A short phrase said twice in a row — likely emphasis.'
    } else {
      confidence = spread === 0 && apart <= 15 ? 0.85 : 0.75
      reason = keep === n - 1 ? 'Said twice word for word; the later take is usually the redo.' : `Said twice word for word; ${label(n - 1)} trails off, so ${label(keep)} stays.`
    }
  } else if (!ambiguous) {
    const more = others.flatMap((i) => extraWords(toks[keep], toks[i], false))
    // Only the small words differ: either take will do. More in the kept one: nothing is lost either way.
    confidence = far ? 0.3 : spread === 0 && apart <= 15 && !more.length ? 0.78 : 0.72
    reason = more.length
      ? `${Label(keep)} says everything ${others.map(label).join(' and ')} ${others.length > 1 ? 'do' : 'does'}, and more (${quoteWords([...new Set(more)])}).`
      : `The takes say the same in slightly different words; ${keep === n - 1 ? 'the later one is usually the redo' : `${label(keep)} is the one that finishes`}.`
  } else {
    confidence = 0.35
    const i = others[extra.findIndex((e) => e.length)]
    const theirs = extra[others.indexOf(i)]
    const ours = extraWords(toks[keep], toks[i], false)
    reason = `The takes differ: ${label(i)} has ${quoteWords(theirs)}${ours.length ? ` where ${label(keep)} has ${quoteWords(ours)}` : ''} — they aren’t interchangeable, so choose.`
  }
  if (ambiguous) confidence = Math.min(confidence, 0.4)

  // “Sorry, let me start again” between the takes goes with them.
  const takeIds = new Set(takes.map((t) => t.id))
  const asides = list.slice(idx[0] + 1, idx[idx.length - 1]).filter((s) => !takeIds.has(s.id) && s.tokens.length <= 10 && ASIDE.test(s.text))
  if (asides.length && confidence >= 0.5) {
    confidence = Math.min(0.95, confidence + 0.05)
    reason += ` ${asides.map((s) => quote(s.text, 40)).join(', ')} goes with it.`
  }
  // Cutting whole sentences needs timings at their edges; an estimate inside a phrase is a guess.
  if (others.some((i) => !timedEdges(takes[i].words, laneWords, 0, takes[i].words.length - 1)) && confidence > 0.6) {
    confidence = 0.6
    reason += ESTIMATED
  }
  return {
    id: `g-${takes[0].id}`,
    kind,
    takes: takes.map((s) => ({ sentenceId: s.id, text: s.text, start: s.start, end: s.end })),
    keep,
    confidence: Math.round(confidence * 100) / 100,
    reason,
    asides: asides.map((s) => s.id),
    lane,
  }
}

/** Words said twice in a row inside a sentence (“we can — we can do this”): the second run usually carries on, so the first goes. */
function stumbles(s: Sentence, laneWords: TimelineWord[]): RetakeGroup[] {
  const core = s.tokens.map((k, i) => ({ ...k, i })).filter((k) => !k.filler)
  const out: RetakeGroup[] = []
  const used: [number, number][] = []
  for (let n = Math.min(6, Math.floor(core.length / 2)); n >= 1; n--) {
    for (let p = 0; p + 2 * n <= core.length; p++) {
      if (used.some(([a, b]) => p < b && p + 2 * n > a)) continue
      const A = core.slice(p, p + n).map((k) => k.t)
      const B = core.slice(p + n, p + 2 * n).map((k) => k.t)
      const match = n <= 2 ? A.every((t, i) => t === B[i]) : sameWord(A[0], B[0]) && align(A, B).length >= n - 1
      if (!match) continue
      const first: [number, number] = [core[p].word, core[p + n - 1].word]
      const second: [number, number] = [core[p + n].word, core[p + 2 * n - 1].word]
      if (first[1] >= second[0]) continue
      const C = core.slice(p + 2 * n, p + 3 * n).map((k) => k.t)
      const triple = C.length === n && C.every((t, i) => t === B[i])
      used.push([p, p + (triple ? 3 : 2) * n])
      const between = s.words.slice(first[1] + 1, second[0])
      const gap = s.words[second[0]].start - s.words[first[1]].end
      const marked = CUT_OFF.test(s.words[first[1]].text) || /,["”’')\]]*$/.test(s.words[first[1]].text) || between.length > 0 || gap >= 0.2
      const said = s.words
        .slice(first[0], first[1] + 1)
        .map((w) => w.text)
        .join(' ')
        .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
      let confidence: number
      let reason: string
      if (triple) {
        confidence = 0.15
        reason = `${quote(said)} three times in a row — on purpose, most likely.`
      } else if (n === 1 && EMPHATIC.has(A[0])) {
        confidence = 0.15
        reason = `${quote(`${said} ${said}`)} — likely emphasis.`
      } else if (n === 1 && DOUBLES.has(A[0])) {
        confidence = 0.2
        reason = `${quote(`${said} ${said}`)} can be grammatical — check before cutting.`
      } else if (n === 1) {
        confidence = FUNCTION.has(A[0]) ? (marked ? 0.8 : 0.7) : marked ? 0.6 : 0.45
        reason = `${quote(said)} is said twice in a row — a stumble.`
      } else {
        confidence = marked ? 0.9 : 0.8
        reason = `${quote(said)} is said twice in a row${marked ? ', cut off the first time' : ''} — a stumble.`
      }
      if (confidence > 0.55 && !timedEdges(s.words, laneWords, first[0], second[0] - 1)) {
        confidence = 0.55
        reason += ESTIMATED
      }
      const take = (from: number, to: number): Take => ({
        sentenceId: s.id,
        words: [from, to],
        text: s.words
          .slice(from, to + 1)
          .map((w) => w.text)
          .join(' '),
        start: s.words[from].start,
        end: s.words[to].end,
      })
      out.push({
        id: `w-${s.id}-${first[0]}`,
        kind: 'stumble',
        takes: [take(first[0], second[0] - 1), take(second[0], second[1])],
        keep: 1,
        confidence,
        reason,
        asides: [],
        lane: s.lane,
        stumble: { sentence: s.text, first, second },
      })
    }
  }
  return out
}

/** Every repeated take on the timeline. */
export function timelineRetakes(project: Project) {
  const sentences = spokenSentences(project)
  return { sentences, groups: findRetakes(sentences) }
}
