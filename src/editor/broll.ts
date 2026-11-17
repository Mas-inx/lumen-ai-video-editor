/**
 * B-roll by meaning: which media already in the project fits what is being
 * said. Every line is matched against all the project knows about its media —
 * names, tags, descriptions, file names and folders, generation prompts, cue
 * sheets and transcripts — through word stems and related words for common
 * subjects ("drive" finds "road", "skyline" finds "city"), with rare words
 * counting for more than common ones (BM25 over the media library). Nothing
 * leaves the computer, and the same question always gets the same answer.
 */
import { cueText } from './cues'
import type { Asset, Project } from './types'

// ─── Words ───────────────────────────────────────────────────────────────

const STOP = new Set(
  (
    'a an the and or but if then so than as of to in on at by for with from into onto over under about after before between through during without within ' +
    'is are was were be been being am do does did doing have has had having will would shall should can could may might must ' +
    'i me my mine we us our ours you your yours he him his she her hers it its they them their theirs this that these those there here ' +
    'what which who whom whose when where why how all any both each few more most other some such no nor not only own same too very just ' +
    'also again ever even still yet really actually basically literally maybe perhaps quite rather pretty well okay ok yeah yes oh um uh hmm like ' +
    'get got gets getting go goes going gone went come comes came make makes made take takes took say says said tell told know knew think thought ' +
    'want wanted thing things stuff something anything everything nothing way lot lots kind sort bit one two three first last next new old good great ' +
    'let lets gonna wanna gotta im ive youre theyre thats dont doesnt didnt cant wont isnt arent wasnt weve youve ill youll its'
  ).split(/\s+/),
)

/** Splits text into lower-case words, camelCase and snake_case included, without accents or filler. */
export function words(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w) && (!/^\d+$/.test(w) || /^(19|20)\d\d$/.test(w)))
}

const undouble = (w: string) => (/([b-df-hj-np-tv-z])\1$/.test(w) && !/(ll|ss|zz)$/.test(w) ? w.slice(0, -1) : w)

/** A light English stemmer: drives, driving, drive → driv; cities → city; beaches → beach. */
export function stem(word: string): string {
  let w = word
  if (w.length <= 3) return w
  if (w.endsWith('ies') && w.length > 4) w = `${w.slice(0, -3)}y`
  else if (w.endsWith('sses')) w = w.slice(0, -2)
  else if (/(ch|sh|x|zz)es$/.test(w)) w = w.slice(0, -2)
  else if (w.endsWith('ing') && w.length > 5) w = undouble(w.slice(0, -3))
  else if (w.endsWith('ied')) w = `${w.slice(0, -3)}y`
  else if (w.endsWith('ed') && w.length > 4) w = undouble(w.slice(0, -2))
  else if (w.endsWith('ly') && w.length > 5) w = w.slice(0, -2)
  else if (w.endsWith('s') && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1)
  // A silent e after a consonant goes, so "drive" meets "driving".
  if (w.length > 4 && /[^aeiou]e$/.test(w)) w = w.slice(0, -1)
  return w
}

export const terms = (text: string) => words(text).map(stem)

/** File-name noise: camera prefixes, containers and words every file name has. */
const FILE_NOISE = new Set('img mvi dsc dji gopr gp pxl vid video clip mov mp4 mkv webm wav mp3 jpg jpeg png webp gif final edit export render copy untitled new take sequence frame proxy'.split(' ').map(stem))

/** Subjects that come up in B-roll, as words that mean much the same on screen. */
const RELATED = [
  'city urban street downtown skyline skyscraper building traffic metropolis town',
  'nature forest tree wood woodland jungle park outdoors wilderness',
  'mountain hill peak alpine alps summit ridge hike hiking trail climb',
  'ocean sea beach wave coast shore surf island tide',
  'lake river water stream waterfall creek',
  'car drive road highway vehicle traffic truck motorway',
  'office work desk meeting team colleague coworker workplace business',
  'computer laptop keyboard screen code coding software programming developer tech technology digital',
  'phone smartphone mobile app social message notification',
  'data chart graph analytics statistic number dashboard metric',
  'money cash finance bank invest investment payment dollar price cost budget economy',
  'food cook cooking kitchen meal restaurant eat dinner lunch breakfast chef recipe',
  'coffee cafe espresso latte barista cup',
  'people crowd audience community friend family group',
  'child children kid baby toddler',
  'school student classroom teacher lesson learn education university',
  'sport fitness gym run running exercise workout training athlete',
  'travel trip journey flight plane airport airplane vacation holiday tourist',
  'night dark evening moon star neon',
  'sunrise sunset morning dawn dusk sun golden',
  'rain storm snow winter cloud fog weather',
  'home house apartment room living cozy interior',
  'health doctor hospital medical nurse medicine patient',
  'music song concert band guitar piano singer festival',
  'success win achieve goal celebrate celebration victory',
  'animal dog cat bird wildlife horse pet',
  'shop shopping store retail buy product customer sale',
  'factory industry machine manufacturing construction build engineer worker',
  'aerial drone overhead flyover',
  'time clock watch deadline hour',
  'talk interview conversation speak discussion podcast',
  'write writing notebook pen paper journal',
  'book read reading library',
  'energy power electricity solar wind battery',
  'space rocket planet earth galaxy astronaut',
  'farm field crop harvest agriculture farmer',
  'love couple wedding romance heart',
  'party dance dancing club nightlife',
].map((group) => [...new Set(group.split(' ').map(stem))])

const conceptsOf = new Map<string, number[]>()
RELATED.forEach((group, i) => group.forEach((t) => conceptsOf.set(t, [...(conceptsOf.get(t) ?? []), i])))

/** A related word counts this much of the word itself. */
const RELATED_WEIGHT = 0.45

/** One word of a line, and what finds it: the word itself (1) and words related to it (less). */
interface QueryWord {
  word: string
  terms: Map<string, number>
}

/** The words of a line to look for. Each counts once, by its best match, however many related words it has. */
function queryOf(text: string): QueryWord[] {
  const own = new Map(words(text).map((w) => [stem(w), w]))
  return [...own].map(([t, word]) => {
    const found = new Map([[t, 1]])
    for (const c of conceptsOf.get(t) ?? []) for (const r of RELATED[c]) if (!own.has(r) && !found.has(r)) found.set(r, RELATED_WEIGHT)
    return { word, terms: found }
  })
}

// ─── The media, as documents ─────────────────────────────────────────────

/** Where the project knows something about a media item, and how much that says about what it shows. */
export const FIELD_WEIGHTS = { name: 3, tags: 3, description: 2.5, prompt: 2, file: 1.6, folder: 1.2, cues: 1.4, transcript: 1 } as const
export type BrollField = keyof typeof FIELD_WEIGHTS

interface Segment {
  start: number
  end: number
  text: string
  terms: Set<string>
}

interface Doc {
  asset: Asset
  fields: Partial<Record<BrollField, string[]>>
  all: Set<string>
  /** Timed things in it (what's said, what's cued), for pointing at the moment that matches. */
  segments: Segment[]
}

function fileParts(asset: Asset) {
  if (asset.source.type !== 'file') return { file: '', folder: '' }
  const path = (asset.source.path ?? '').replace(/\\/g, '/')
  const dirs = path.split('/').slice(0, -1)
  return { file: asset.source.fileName.replace(/\.[^.]+$/, ''), folder: dirs.slice(-2).join(' ') }
}

function docOf(asset: Asset): Doc {
  const { file, folder } = fileParts(asset)
  const clean = (list: string[]) => list.filter((t) => !FILE_NOISE.has(t))
  const segments: Segment[] = [
    ...(asset.transcript ?? []).map((s) => ({ start: s.start, end: s.end, text: s.text })),
    ...(asset.cues ?? []).map((c) => ({ start: c.at, end: c.at + (c.seconds ?? 0), text: cueText(c) })),
  ].map((s) => ({ ...s, terms: new Set(terms(s.text)) }))
  const fields: Doc['fields'] = {
    name: clean(terms(asset.name)),
    tags: terms((asset.tags ?? []).filter((t) => t !== 'ai').join(' ')),
    description: terms(asset.description ?? ''),
    prompt: terms(asset.provenance?.prompt ?? ''),
    file: clean(terms(file)),
    folder: clean(terms(folder)),
    cues: terms((asset.cues ?? []).map(cueText).join(' ')),
    transcript: terms((asset.transcript ?? []).map((s) => s.text).join(' ')),
  }
  return { asset, fields, all: new Set(Object.values(fields).flat()), segments }
}

/** Visual media that could cover a line: video and stills, not mattes or transparent overlays. */
export const isBroll = (asset: Asset) => (asset.kind === 'video' || asset.kind === 'image') && !asset.matteOf && !asset.alpha

/** Media nothing describes: no description or tags, and a file name that says nothing (DJI_0042). */
export function undescribed(asset: Asset) {
  if (asset.description?.trim() || asset.tags?.some((t) => t !== 'ai') || asset.provenance?.prompt) return false
  const { file } = fileParts(asset)
  const said = [...terms(asset.name), ...terms(file)].filter((t) => !FILE_NOISE.has(t))
  return said.length === 0
}

// ─── Ranking ─────────────────────────────────────────────────────────────

export interface BrollLine {
  /** Timeline seconds, when the line comes from the timeline. */
  start?: number
  end?: number
  text: string
}

export interface BrollCandidate {
  assetId: string
  name: string
  kind: Asset['kind']
  /** 0–1: how well it fits. */
  score: number
  /** Words of the line it matched (or that something related to them did). */
  matched: string[]
  /** Where the match is: name, tags, description, prompt, file, folder, cues or transcript. */
  fields: BrollField[]
  /** The moment in the media that matches, when it's something said or cued there (media seconds). */
  at?: { start: number; end: number; text: string }
  onTimeline: number
}

export interface BrollSuggestion {
  line: BrollLine
  candidates: BrollCandidate[]
  /** The candidate to use: the best one not just used for the lines before. */
  pick?: string
}

export interface BrollOptions {
  /** Candidates per line (default 3). */
  perLine?: number
  kinds?: ('video' | 'image')[]
  /** Only media that isn't on the timeline yet. */
  unusedOnly?: boolean
  /** Media to leave out (the speaker's own footage, say). */
  exclude?: string[]
}

const K1 = 1.2
const B = 0.5
/** Below this a match is noise (one related word in a folder name or a transcript). */
const MIN_SCORE = 0.8
/** Raw scores onto 0–1: one name or tag that says it is about 0.7, a related word there about 0.4. */
const normal = (raw: number) => Math.round((1 - Math.exp(-raw / 4)) * 100) / 100

export function rankBroll(project: Project, lines: BrollLine[], opts: BrollOptions = {}) {
  const exclude = new Set(opts.exclude ?? [])
  const uses = new Map<string, number>()
  for (const c of Object.values(project.clips)) if (c.assetId) uses.set(c.assetId, (uses.get(c.assetId) ?? 0) + 1)
  const media = Object.values(project.assets).filter(
    (a) => isBroll(a) && !exclude.has(a.id) && (!opts.kinds?.length || opts.kinds.includes(a.kind as 'video' | 'image')) && (!opts.unusedOnly || !uses.get(a.id)),
  )
  const docs = media.map(docOf)
  const n = docs.length
  const df = new Map<string, number>()
  for (const d of docs) for (const t of d.all) df.set(t, (df.get(t) ?? 0) + 1)
  const avg = Object.fromEntries((Object.keys(FIELD_WEIGHTS) as BrollField[]).map((f) => [f, Math.max(1, docs.reduce((s, d) => s + (d.fields[f]?.length ?? 0), 0) / Math.max(1, n))])) as Record<BrollField, number>
  const idf = (t: string) => {
    const k = df.get(t) ?? 0
    return Math.log(1 + (n - k + 0.5) / (k + 0.5))
  }
  const perLine = Math.max(1, Math.min(10, opts.perLine ?? 3))

  /** How strongly a term is in a media item's fields (BM25 per field, weighted), and in which. */
  const strength = (d: Doc, t: string) => {
    let s = 0
    const found: BrollField[] = []
    for (const f of Object.keys(FIELD_WEIGHTS) as BrollField[]) {
      const list = d.fields[f]
      if (!list?.length) continue
      const tf = list.reduce((k, x) => k + (x === t ? 1 : 0), 0)
      if (!tf) continue
      s += FIELD_WEIGHTS[f] * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * list.length) / avg[f])))
      found.push(f)
    }
    return { s, found }
  }

  const suggestions: BrollSuggestion[] = lines.map((line) => {
    const query = queryOf(line.text)
    const scored: BrollCandidate[] = []
    for (const d of docs) {
      let score = 0
      const matched = new Set<string>()
      const fields = new Set<BrollField>()
      for (const q of query) {
        // The word counts by its best match: itself, or the closest related word.
        let best = 0
        let where: BrollField[] = []
        for (const [t, weight] of q.terms) {
          if (!d.all.has(t)) continue
          const { s, found } = strength(d, t)
          if (weight * idf(t) * s > best) {
            best = weight * idf(t) * s
            where = found
          }
        }
        if (!best) continue
        score += best
        matched.add(q.word)
        for (const f of where) fields.add(f)
      }
      if (score < MIN_SCORE) continue
      // Media not on the timeline yet is a little more welcome.
      if (!uses.get(d.asset.id)) score *= 1.08
      if (d.asset.favorite) score *= 1.05
      scored.push({
        assetId: d.asset.id,
        name: d.asset.name,
        kind: d.asset.kind,
        score: normal(score),
        matched: [...matched],
        fields: [...fields],
        ...momentOf(d, query),
        onTimeline: uses.get(d.asset.id) ?? 0,
      })
    }
    scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    return { line, candidates: scored.slice(0, perLine) }
  })

  // Picks: the best fit for each line that the lines just before haven't used, so cutaways vary.
  const recent: string[] = []
  const used = new Set<string>()
  for (const s of suggestions) {
    const pick = s.candidates.find((c) => !recent.includes(c.assetId) && !used.has(c.assetId)) ?? s.candidates.find((c) => !recent.includes(c.assetId)) ?? s.candidates[0]
    if (!pick) continue
    s.pick = pick.assetId
    used.add(pick.assetId)
    recent.push(pick.assetId)
    if (recent.length > 3) recent.shift()
  }
  return { suggestions, considered: n, undescribed: media.filter(undescribed).map((a) => a.id) }
}

/** The best-matching thing said or cued in the media, if the match is there. */
function momentOf(d: Doc, query: QueryWord[]): { at?: BrollCandidate['at'] } {
  let best: Segment | null = null
  let bestScore = 0
  for (const s of d.segments) {
    let score = 0
    for (const q of query) score += Math.max(0, ...[...q.terms].map(([t, w]) => (s.terms.has(t) ? w : 0)))
    if (score > bestScore) {
      best = s
      bestScore = score
    }
  }
  return best && bestScore >= 1 ? { at: { start: Math.round(best.start * 100) / 100, end: Math.round(Math.max(best.end, best.start) * 100) / 100, text: best.text } } : {}
}

// ─── Lines to match ──────────────────────────────────────────────────────

/** Timed phrases joined into sentences: until a full stop, 25 words, or 8 seconds. */
export function sentencesOf(lines: { start: number; end: number; text: string }[]): BrollLine[] {
  const out: BrollLine[] = []
  let cur: { start: number; end: number; text: string } | null = null
  for (const l of [...lines].sort((a, b) => a.start - b.start)) {
    cur = cur ? { start: cur.start, end: l.end, text: `${cur.text} ${l.text.trim()}` } : { start: l.start, end: l.end, text: l.text.trim() }
    if (/[.!?…]["”’)]?$/.test(cur.text) || cur.text.split(/\s+/).length >= 25 || cur.end - cur.start >= 8) {
      out.push(cur)
      cur = null
    }
  }
  if (cur) out.push(cur)
  return out.filter((l) => terms(l.text).length > 0)
}

/** A script (a storyboard scene's, or any text) as sentences. */
export function scriptSentences(text: string): BrollLine[] {
  return text
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((t) => t.trim())
    .filter((t) => terms(t).length > 0)
    .map((t) => ({ text: t }))
}
