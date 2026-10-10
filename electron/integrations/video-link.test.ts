import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// No network here: Electron's fetch is a script each test writes, and every name resolves to a public address.
type Call = { url: string; method: string; headers: Record<string, string>; credentials?: string; redirect?: string; body?: string }
const env = vi.hoisted(() => ({ root: '', calls: [] as Call[], asElectron: false, answer: (_url: URL, _call: Call): Response => new Response('not scripted', { status: 500 }) }))
const redirects = (res: Response) => (res.status >= 300 && res.status < 400 ? res.headers.get('location') : null)

vi.mock('electron', () => ({
  app: { getPath: (name: string) => `${env.root}/${name}`, once: () => {} },
  net: {
    fetch: async (url: string, init: RequestInit = {}) => {
      const call: Call = { url, method: init.method ?? 'GET', headers: (init.headers ?? {}) as Record<string, string>, credentials: init.credentials, redirect: init.redirect, body: typeof init.body === 'string' ? init.body : undefined }
      // Out of sight of the comparisons below: what would end the request.
      Object.defineProperty(call, 'signal', { value: init.signal ?? undefined, enumerable: false })
      env.calls.push(call)
      const res = env.answer(new URL(url), call)
      // Electron's fetch, told not to follow a redirect, fails without saying where it led.
      if (env.asElectron && redirects(res)) throw new Error('Redirect was cancelled')
      return res
    },
    // A request with a listener is told where a redirect leads (and is cancelled when nobody follows it).
    request: (opts: { url: string; method: string; redirect?: string; credentials?: string }) => {
      const headers: Record<string, string> = {}
      const on: Record<string, (...args: unknown[]) => void> = {}
      return {
        setHeader: (name: string, value: string) => void (headers[name] = value),
        on: (event: string, fn: (...args: unknown[]) => void) => void (on[event] = fn),
        abort: () => {},
        end: () => {
          const call: Call = { url: opts.url, method: opts.method, headers, credentials: opts.credentials, redirect: opts.redirect }
          env.calls.push(call)
          const res = env.answer(new URL(opts.url), call)
          const to = redirects(res)
          queueMicrotask(() => {
            if (!to) return on.response?.({ statusCode: res.status })
            on.redirect?.(res.status, 'GET', new URL(to, opts.url).href, {})
            on.error?.(new Error('Redirect was cancelled'))
          })
        },
      }
    },
  },
  nativeImage: {},
  session: {},
  BrowserWindow: class {},
  screen: {},
}))
vi.mock('node:dns/promises', () => ({ lookup: async () => [{ address: '93.184.216.34', family: 4 }] }))

env.root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-watch-test-')).replace(/\\/g, '/')
// yt-dlp is never found here, whatever is installed on the machine running the tests.
const realPath = process.env.PATH
process.env.PATH = ''
const { mediaPath } = await import('./paths')
const {
  canonicalYouTubeId,
  clock,
  descriptionChapters,
  embeddedJson,
  FILE_CAP,
  isoDuration,
  largestStoryboard,
  mediaKind,
  mergeCues,
  parseCaptionXml,
  parseCaptions,
  parseJson3,
  parseStoryboards,
  parseVideoPage,
  parseVtt,
  pickFormat,
  pickTiles,
  pickTrack,
  pickXVariant,
  saveCapped,
  spread,
  storyboardTile,
  vimeoRef,
  watchVideo,
  xPostId,
  youtubeChapters,
  youtubeId,
  ytDlpTracks,
} = await import('./video-link')

afterAll(() => {
  process.env.PATH = realPath
  fs.rmSync(env.root, { recursive: true, force: true })
})
beforeEach(() => {
  env.calls.length = 0
  env.asElectron = false
  env.answer = () => new Response('not scripted', { status: 500 })
})

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=UTF-8' } })
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } })
const until = async (done: () => boolean) => {
  for (let i = 0; i < 100 && !done(); i++) await new Promise((r) => setTimeout(r, 20))
  return done()
}

// ─── Recorded from YouTube (trimmed) ─────────────────────────────────────

/** The storyboard spec of dQw4w9WgXcQ as the watch page gives it (signatures shortened). */
const SPEC =
  'https://i.ytimg.com/sb/dQw4w9WgXcQ/storyboard3_L$L/$N.jpg?sqp=-oaymwENSDfyq4qp|48#27#100#10#10#0#default#rs$AOn4CLDg|80#45#108#10#10#2000#M$M#rs$AOn4CLBf|160#90#108#5#5#2000#M$M#rs$AOn4CLCl|320#180#108#3#3#2000#M$M#rs$AOn4CLCH'
/** What YouTube's apps get: the same without the largest size. */
const APP_SPEC = SPEC.split('|').slice(0, 4).join('|')

/** Auto-generated captions of 5C_HPTJg5ek: a few words per event, with line-break events between. */
const ASR = {
  events: [
    { tStartMs: 0, dDurationMs: 150239 },
    { tStartMs: 160, dDurationMs: 4000, segs: [{ utf8: 'rust' }, { utf8: ' a', tOffsetMs: 680 }, { utf8: ' memory', tOffsetMs: 840 }, { utf8: ' safe', tOffsetMs: 1279 }, { utf8: ' compiled', tOffsetMs: 1559 }, { utf8: ' programming', tOffsetMs: 2040 }] },
    { tStartMs: 2669, dDurationMs: 1491, aAppend: 1, segs: [{ utf8: '\n' }] },
    { tStartMs: 2679, dDurationMs: 3600, segs: [{ utf8: 'language' }, { utf8: ' that', tOffsetMs: 401 }, { utf8: ' delivers', tOffsetMs: 561 }, { utf8: ' highlevel', tOffsetMs: 1000 }] },
    { tStartMs: 4150, dDurationMs: 2129, aAppend: 1, segs: [{ utf8: '\n' }] },
    { tStartMs: 4160, dDurationMs: 3679, segs: [{ utf8: 'Simplicity' }, { utf8: ' with', tOffsetMs: 679 }, { utf8: ' low-level', tOffsetMs: 840 }, { utf8: ' performance', tOffsetMs: 1440 }] },
    { tStartMs: 6269, dDurationMs: 1570, aAppend: 1, segs: [{ utf8: '\n' }] },
    { tStartMs: 6279, dDurationMs: 3681, segs: [{ utf8: "it's" }, { utf8: ' a', tOffsetMs: 120 }, { utf8: ' popular', tOffsetMs: 361 }, { utf8: ' choice', tOffsetMs: 721 }, { utf8: ' for', tOffsetMs: 961 }, { utf8: ' Building', tOffsetMs: 1160 }] },
    { tStartMs: 7829, dDurationMs: 2131, aAppend: 1, segs: [{ utf8: '\n' }] },
    { tStartMs: 7839, dDurationMs: 4760, segs: [{ utf8: 'Systems' }, { utf8: ' where', tOffsetMs: 641 }, { utf8: ' performance', tOffsetMs: 840 }, { utf8: ' is', tOffsetMs: 1361 }, { utf8: ' absolutely', tOffsetMs: 1641 }] },
    { tStartMs: 9950, dDurationMs: 2649, aAppend: 1, segs: [{ utf8: '\n' }] },
    { tStartMs: 9960, dDurationMs: 4559, segs: [{ utf8: 'critical' }, { utf8: ' like', tOffsetMs: 599 }, { utf8: ' game', tOffsetMs: 840 }, { utf8: ' engines', tOffsetMs: 1040 }, { utf8: ' databases', tOffsetMs: 1639 }, { utf8: ' or', tOffsetMs: 2360 }] },
    { tStartMs: 12589, dDurationMs: 1930, aAppend: 1, segs: [{ utf8: '\n' }] },
    { tStartMs: 12599, dDurationMs: 3721, segs: [{ utf8: 'operating' }, { utf8: ' systems', tOffsetMs: 521 }, { utf8: ' and', tOffsetMs: 1080 }, { utf8: ' is', tOffsetMs: 1240 }, { utf8: ' an', tOffsetMs: 1361 }, { utf8: ' excellent', tOffsetMs: 1561 }] },
    { tStartMs: 14509, dDurationMs: 1811, aAppend: 1, segs: [{ utf8: '\n' }] },
    { tStartMs: 14519, dDurationMs: 4161, segs: [{ utf8: 'choice' }, { utf8: ' when', tOffsetMs: 280 }, { utf8: ' targeting', tOffsetMs: 481 }, { utf8: ' web', tOffsetMs: 881 }, { utf8: ' assembly', tOffsetMs: 1120 }, { utf8: ' it', tOffsetMs: 1680 }] },
  ],
}

/** Captions a person wrote, of iG9CE55wbtY: whole sentences, with line breaks inside. */
const MANUAL = {
  events: [
    { tStartMs: 27103, dDurationMs: 2575, segs: [{ utf8: 'Good morning. How are you?' }] },
    { tStartMs: 29702, dDurationMs: 1403, segs: [{ utf8: '(Audience) Good.' }] },
    { tStartMs: 31129, dDurationMs: 1668, segs: [{ utf8: "It's been great, hasn't it?" }] },
    { tStartMs: 33408, dDurationMs: 2321, segs: [{ utf8: "I've been blown away by the whole thing." }] },
    { tStartMs: 35753, dDurationMs: 1492, segs: [{ utf8: "In fact, I'm leaving." }] },
    { tStartMs: 37269, dDurationMs: 3906, segs: [{ utf8: '(Laughter)' }] },
    { tStartMs: 43096, dDurationMs: 3567, segs: [{ utf8: 'There have been three themes\nrunning through the conference,' }] },
    { tStartMs: 46687, dDurationMs: 2286, segs: [{ utf8: 'which are relevant\nto what I want to talk about.' }] },
  ],
}

/** The player bar of 5C_HPTJg5ek's watch page. */
const INITIAL_DATA = {
  playerOverlays: {
    playerOverlayRenderer: {
      decoratedPlayerBarRenderer: {
        decoratedPlayerBarRenderer: {
          playerBar: {
            multiMarkersPlayerBarRenderer: {
              markersMap: [
                { key: 'ANIMATION_ANNOTATION_MARKERS', value: { markers: [{ markerRenderer: { title: {}, timeRangeStartMillis: 139800 } }] } },
                {
                  key: 'AUTO_CHAPTERS',
                  value: {
                    chapters: [
                      { chapterRenderer: { title: { simpleText: 'Intro' }, timeRangeStartMillis: 0 } },
                      { chapterRenderer: { title: { simpleText: 'History' }, timeRangeStartMillis: 20000 } },
                      { chapterRenderer: { title: { runs: [{ text: 'Memory ' }, { text: 'Safety' }] }, timeRangeStartMillis: 40000 } },
                      { chapterRenderer: { title: { simpleText: 'Cargo' }, timeRangeStartMillis: 90000 } },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
    },
  },
}

const player = (over: Record<string, unknown> = {}) => ({
  playabilityStatus: { status: 'OK' },
  videoDetails: {
    videoId: 'dQw4w9WgXcQ',
    title: 'Rick Astley - Never Gonna Give You Up (Official Video)',
    author: 'Rick Astley',
    lengthSeconds: '213',
    shortDescription: 'The official video.\n\n0:00 Intro\n0:43 Chorus\n2:55 Outro',
    viewCount: '1825286636',
    thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg', width: 480 }, { url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/sddefault.jpg', width: 640 }] },
  },
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: [
        { baseUrl: 'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&fmt=srv3', languageCode: 'en' },
        { baseUrl: 'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&kind=asr&lang=en', languageCode: 'en', kind: 'asr' },
        { baseUrl: 'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=de-DE', languageCode: 'de-DE' },
      ],
    },
  },
  storyboards: { playerStoryboardSpecRenderer: { spec: APP_SPEC } },
  ...over,
})

const watchPage = (pagePlayer: unknown, data: unknown = INITIAL_DATA) =>
  `<!DOCTYPE html><html><head><title>x</title></head><body><script nonce="a">var ytInitialPlayerResponse = ${JSON.stringify(pagePlayer)};</script><script nonce="a">var ytInitialData = ${JSON.stringify(data)};</script></body></html>`

/** YouTube as it answered when these were recorded. */
function youtube(over: { app?: unknown; page?: Response | null; captions?: () => Response } = {}) {
  env.answer = (url, call) => {
    if (url.pathname === '/youtubei/v1/player') return json(over.app ?? player())
    if (url.pathname === '/watch') return over.page === null ? new Response(null, { status: 302, headers: { location: 'https://consent.youtube.com/m?continue=x' } }) : (over.page ?? html(watchPage(player({ storyboards: { playerStoryboardSpecRenderer: { spec: SPEC } }, microformat: { playerMicroformatRenderer: { publishDate: '2009-10-24T23:57:33-07:00' } } }))))
    if (url.hostname === 'consent.youtube.com') return html('<html><body>Before you continue</body></html>')
    if (url.pathname === '/api/timedtext') return over.captions?.() ?? json(url.searchParams.get('kind') === 'asr' ? ASR : MANUAL)
    if (url.hostname === 'i.ytimg.com') return new Response(Buffer.from(`RIFF sheet ${url.pathname}`), { headers: { 'content-type': url.pathname.startsWith('/sb/') ? 'image/webp' : 'image/jpeg' } })
    return new Response(`unexpected ${call.method} ${url.href}`, { status: 500 })
  }
}

// ─── Links ───────────────────────────────────────────────────────────────

describe('recognising links', () => {
  it('finds the video in every kind of YouTube link', () => {
    const id = (u: string) => youtubeId(new URL(u))
    expect(id('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1&t=42s')).toBe('dQw4w9WgXcQ')
    expect(id('https://youtu.be/dQw4w9WgXcQ?si=abc')).toBe('dQw4w9WgXcQ')
    expect(id('https://www.youtube.com/shorts/-62C9R_41Sc')).toBe('-62C9R_41Sc')
    expect(id('https://youtube.com/live/M3HKLzjvKPc?feature=share')).toBe('M3HKLzjvKPc')
    expect(id('https://music.youtube.com/watch?v=dQw4w9WgXcQ&feature=share')).toBe('dQw4w9WgXcQ')
    expect(id('https://m.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
    expect(id('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=0')).toBe('dQw4w9WgXcQ')
  })

  it('doesn’t take a channel, a playlist, a bad id or another site for a video', () => {
    const id = (u: string) => youtubeId(new URL(u))
    expect(id('https://www.youtube.com/@NASA')).toBeNull()
    expect(id('https://www.youtube.com/playlist?list=PL12345')).toBeNull()
    expect(id('https://www.youtube.com/watch?v=short')).toBeNull()
    expect(id('https://notyoutube.com/watch?v=dQw4w9WgXcQ')).toBeNull()
    expect(id('https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ')).toBeNull()
  })

  it('reads the video a channel’s /live page points at', () => {
    expect(canonicalYouTubeId('<head><link rel="canonical" href="https://www.youtube.com/watch?v=M3HKLzjvKPc"></head>')).toBe('M3HKLzjvKPc')
    expect(canonicalYouTubeId('<head><link rel="canonical" href="https://www.youtube.com/@NASA"></head>')).toBeNull()
  })

  it('finds Vimeo videos, with the hash of unlisted ones', () => {
    expect(vimeoRef(new URL('https://vimeo.com/76979871'))).toEqual({ id: '76979871' })
    expect(vimeoRef(new URL('https://vimeo.com/channels/staffpicks/76979871'))).toEqual({ id: '76979871' })
    expect(vimeoRef(new URL('https://vimeo.com/76979871/8272103f6e'))).toEqual({ id: '76979871', hash: '8272103f6e' })
    expect(vimeoRef(new URL('https://player.vimeo.com/video/76979871?h=8272103f6e'))).toEqual({ id: '76979871', hash: '8272103f6e' })
    expect(vimeoRef(new URL('https://vimeo.com/about'))).toBeNull()
  })

  it('finds posts on X under either name', () => {
    expect(xPostId(new URL('https://x.com/SpaceX/status/1845922924315938922?s=20'))).toBe('1845922924315938922')
    expect(xPostId(new URL('https://twitter.com/SpaceX/status/1845442658397049011/video/1'))).toBe('1845442658397049011')
    expect(xPostId(new URL('https://x.com/SpaceX'))).toBeNull()
    expect(xPostId(new URL('https://example.com/a/status/1845922924315938922'))).toBeNull()
  })

  it('picks the MP4 of a post that is big enough to see and quick to fetch', () => {
    const variants = [
      { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/ext_tw_video/1/pu/pl/a.m3u8' },
      { bitrate: 256000, content_type: 'video/mp4', url: 'https://video.twimg.com/ext_tw_video/1/pu/vid/avc1/480x270/a.mp4' },
      { bitrate: 832000, content_type: 'video/mp4', url: 'https://video.twimg.com/ext_tw_video/1/pu/vid/avc1/640x360/b.mp4' },
      { bitrate: 2176000, content_type: 'video/mp4', url: 'https://video.twimg.com/ext_tw_video/1/pu/vid/avc1/1280x720/c.mp4' },
    ]
    expect(pickXVariant(variants)).toMatch(/640x360/)
    expect(pickXVariant(variants.slice(3))).toMatch(/1280x720/)
    expect(pickXVariant(variants.slice(0, 1))).toBeNull()
  })
})

// ─── Captions ────────────────────────────────────────────────────────────

describe('captions', () => {
  it('reads YouTube’s JSON, skipping the empty line-break events', () => {
    const cues = parseJson3(ASR)
    expect(cues).toHaveLength(8)
    expect(cues[0]).toEqual({ start: 0.16, end: 4.16, text: 'rust a memory safe compiled programming' })
    expect(parseJson3(MANUAL)[6].text).toBe('There have been three themes\nrunning through the conference,')
    expect(parseJson3({})).toEqual([])
  })

  it('reads both shapes of caption XML', () => {
    const srv3 = '<?xml version="1.0" encoding="utf-8" ?><timedtext format="3"><head><ws id="0"/></head><body><w t="0" id="1" wp="1" ws="1"/><p t="160" d="4000" w="1"><s ac="0">rust</s><s t="680" ac="0"> a</s><s t="840" ac="0"> memory</s></p><p t="2669" d="1491" w="1" a="1">\n</p><p t="6279" d="3681" w="1"><s ac="0">it&#39;s</s><s t="120" ac="0"> a</s></p></body></timedtext>'
    expect(parseCaptionXml(srv3)).toEqual([
      { start: 0.16, end: 4.16, text: 'rust a memory' },
      { start: 6.279, end: 9.96, text: 'it\'s a' },
    ])
    const legacy = '<?xml version="1.0" encoding="utf-8" ?><transcript><text start="0.16" dur="4">rust a memory safe</text><text start="6.279" dur="3.681">it&amp;#39;s a popular choice</text></transcript>'
    const old = parseCaptionXml(legacy)
    expect(old.map((c) => [c.start, c.text])).toEqual([
      [0.16, 'rust a memory safe'],
      [6.279, 'it\'s a popular choice'],
    ])
    expect(old[1].end).toBeCloseTo(9.96, 6)
  })

  it('reads WebVTT, with or without hours and markup', () => {
    const vtt = 'WEBVTT\n\n1\n00:00:05.237 --> 00:00:08.043\n<i>Here at Vimeo, there\'s always</i>\n<i>one thing on our minds:</i>\n\n2\n00:08.043 --> 00:11.022 align:middle\nhow to make your videos &amp; more\n\nNOTE a comment\n'
    expect(parseVtt(vtt)).toEqual([
      { start: 5.237, end: 8.043, text: 'Here at Vimeo, there\'s always one thing on our minds:' },
      { start: 8.043, end: 11.022, text: 'how to make your videos & more' },
    ])
  })

  it('tells the formats apart', () => {
    expect(parseCaptions(JSON.stringify(MANUAL))).toHaveLength(8)
    expect(parseCaptions('<transcript><text start="1" dur="2">Hi</text></transcript>')).toHaveLength(1)
    expect(parseCaptions('WEBVTT\n\n00:01.000 --> 00:02.000\nHi\n')).toHaveLength(1)
    expect(parseCaptions('')).toEqual([])
    expect(parseCaptions('{"events": [')).toEqual([])
  })

  it('joins a few words at a time into lines of about 8–15 seconds', () => {
    const lines = mergeCues(parseJson3(ASR))
    expect(lines.map((l) => [l.start, l.text])).toEqual([
      [0.16, 'rust a memory safe compiled programming language that delivers highlevel Simplicity with low-level performance it\'s a popular choice for Building Systems where performance is absolutely critical like game engines databases or operating systems and is an excellent'],
      [14.52, 'choice when targeting web assembly it'],
    ])
    // A cue is over when the next one starts, however long it stayed on screen.
    expect(lines[0].end).toBe(14.52)
  })

  it('breaks lines where a sentence ends or the speaker pauses', () => {
    const lines = mergeCues(parseJson3(MANUAL))
    expect(lines.map((l) => [l.start, l.text])).toEqual([
      [27.1, 'Good morning. How are you? (Audience) Good. It\'s been great, hasn\'t it? I\'ve been blown away by the whole thing.'],
      [35.75, 'In fact, I\'m leaving. (Laughter) There have been three themes running through the conference, which are relevant to what I want to talk about.'],
    ])
    const paused = mergeCues([
      { start: 0, end: 2, text: 'One' },
      { start: 2, end: 4, text: 'two' },
      { start: 30, end: 32, text: 'much later' },
    ])
    expect(paused.map((l) => l.text)).toEqual(['One two', 'much later'])
  })

  it('keeps every line within 15 seconds of talking, whatever the cues', () => {
    const cues = Array.from({ length: 400 }, (_, i) => ({ start: i * 2.3, end: i * 2.3 + 4, text: `word${i} and more words` }))
    const lines = mergeCues(cues)
    expect(Math.max(...lines.map((l) => l.end - l.start))).toBeLessThanOrEqual(15)
    expect(Math.min(...lines.slice(0, -1).map((l) => l.end - l.start))).toBeGreaterThanOrEqual(8)
    expect(lines.map((l) => l.text).join(' ')).toBe(cues.map((c) => c.text).join(' '))
  })

  it('prefers a person’s captions in the language asked for, then English, then auto-generated', () => {
    const t = (language: string, auto = false) => ({ url: `https://c.example/${language}${auto ? '.asr' : ''}`, language, auto })
    const pick = (tracks: ReturnType<typeof t>[], language?: string) => {
      const p = pickTrack(tracks, language)
      return p && `${p.language}${p.auto ? ' auto' : ''}`
    }
    const ted = [t('ar'), t('en'), t('en', true), t('de'), t('pt-BR')]
    expect(pick(ted)).toBe('en')
    expect(pick(ted, 'de')).toBe('de')
    expect(pick(ted, 'pt')).toBe('pt-BR')
    expect(pick(ted, 'ja')).toBe('en')
    expect(pick([t('en', true)])).toBe('en auto')
    expect(pick([t('en', true), t('fr')], 'de')).toBe('en auto')
    expect(pick([t('de', true), t('en', true)], 'de')).toBe('de auto')
    // A Spanish video with its own captions and no English ones: the person's, not the machine's.
    expect(pick([t('es'), t('es', true)])).toBe('es')
    expect(pick([t('fr')])).toBe('fr')
    expect(pick([])).toBeNull()
  })
})

// ─── Chapters ────────────────────────────────────────────────────────────

describe('chapters', () => {
  it('come from the player bar of the watch page', () => {
    expect(youtubeChapters(INITIAL_DATA)).toEqual([
      { start: 0, title: 'Intro' },
      { start: 20, title: 'History' },
      { start: 40, title: 'Memory Safety' },
      { start: 90, title: 'Cargo' },
    ])
    expect(youtubeChapters({})).toEqual([])
    expect(youtubeChapters(null)).toEqual([])
  })

  it('or from the timestamps in a description', () => {
    const description = 'A talk about things.\n\nChapters:\n0:00 Introduction\n4:36 - GPT-4\n[16:02] Political bias\n• 23:03 — AI safety\n1:02:03 Q&A\n\nFollow me: https://example.com'
    expect(descriptionChapters(description, 8636)).toEqual([
      { start: 0, title: 'Introduction' },
      { start: 276, title: 'GPT-4' },
      { start: 962, title: 'Political bias' },
      { start: 1383, title: 'AI safety' },
      { start: 3723, title: 'Q&A' },
    ])
    expect(descriptionChapters('Intro 0:00\nThe build — 1:30\nResult (4:05)')).toEqual([
      { start: 0, title: 'Intro' },
      { start: 90, title: 'The build' },
      { start: 245, title: 'Result' },
    ])
    expect(descriptionChapters('0:00 - 1:30 Intro\n1:30 - 3:00 Main part').map((c) => c.title)).toEqual(['Intro', 'Main part'])
  })

  it('but times mentioned in passing aren’t chapters', () => {
    expect(descriptionChapters('Premieres at 18:00 CET')).toEqual([])
    expect(descriptionChapters('3:10 best part\n1:05 also good')).toEqual([])
    expect(descriptionChapters('0:00 Intro\n9:59 Past the end', 120)).toEqual([])
    expect(descriptionChapters('')).toEqual([])
  })
})

// ─── Preview pictures ────────────────────────────────────────────────────

describe('storyboards', () => {
  const boards = parseStoryboards(SPEC, 213)

  it('parses every size in the spec, with its address', () => {
    expect(boards.map((b) => [b.width, b.height, b.count, b.columns, b.rows, b.interval])).toEqual([
      [48, 27, 100, 10, 10, 2130],
      [80, 45, 108, 10, 10, 2000],
      [160, 90, 108, 5, 5, 2000],
      [320, 180, 108, 3, 3, 2000],
    ])
    expect(boards[0].url).toBe('https://i.ytimg.com/sb/dQw4w9WgXcQ/storyboard3_L0/default.jpg?sqp=-oaymwENSDfyq4qp&sigh=rs$AOn4CLDg')
    expect(boards[3].url).toBe('https://i.ytimg.com/sb/dQw4w9WgXcQ/storyboard3_L3/M$M.jpg?sqp=-oaymwENSDfyq4qp&sigh=rs$AOn4CLCH')
    expect(largestStoryboard(boards)).toBe(boards[3])
    expect(largestStoryboard(parseStoryboards(APP_SPEC, 213))?.width).toBe(160)
  })

  it('ignores a spec it can’t read', () => {
    expect(parseStoryboards('', 100)).toEqual([])
    expect(parseStoryboards('not-a-url|48#27#100#10#10#0#default#x', 100)).toEqual([])
    expect(parseStoryboards('https://i.ytimg.com/sb/x/$L/$N.jpg|garbage|320#180#0#3#3#2000#M$M#s', 100)).toEqual([])
    expect(largestStoryboard([])).toBeNull()
  })

  it('works out which sheet and tile shows a moment', () => {
    const big = boards[3]
    // 3 × 3 tiles of 320 × 180 per sheet, one every 2 s.
    expect(storyboardTile(big, 0)).toEqual({ index: 0, time: 0, sheet: 0, x: 0, y: 0, width: 320, height: 180 })
    expect(storyboardTile(big, 3.9)).toMatchObject({ index: 1, time: 2, sheet: 0, x: 320, y: 0 })
    expect(storyboardTile(big, 10)).toMatchObject({ index: 5, time: 10, sheet: 0, x: 640, y: 180 })
    expect(storyboardTile(big, 17.5)).toMatchObject({ index: 8, time: 16, sheet: 0, x: 640, y: 360 })
    expect(storyboardTile(big, 18)).toMatchObject({ index: 9, time: 18, sheet: 1, x: 0, y: 0 })
    expect(storyboardTile(big, 100)).toMatchObject({ index: 50, time: 100, sheet: 5, x: 640, y: 180 })
    // Past the end and before the start stay on the video.
    expect(storyboardTile(big, 9999)).toMatchObject({ index: 107, sheet: 11, x: 640, y: 360 })
    expect(storyboardTile(big, -5)).toMatchObject({ index: 0, sheet: 0 })
    // 5 × 5 of 160 × 90.
    expect(storyboardTile(boards[2], 100)).toMatchObject({ index: 50, sheet: 2, x: 0, y: 0, width: 160, height: 90 })
  })

  it('spreads frames over the middle of each slice, never the same tile twice', () => {
    expect(spread(0, 100, 4)).toEqual([12.5, 37.5, 62.5, 87.5])
    const tiles = pickTiles(boards[3], 0, 213, 16)
    expect(tiles).toHaveLength(16)
    expect(tiles.map((t) => t.time)).toEqual([6, 18, 32, 46, 58, 72, 86, 98, 112, 126, 138, 152, 166, 178, 192, 206])
    // Ten seconds hold five tiles, however many frames are asked for.
    expect(pickTiles(boards[3], 100, 110, 16).map((t) => t.time)).toEqual([100, 102, 104, 106, 108])
  })
})

// ─── Pages ───────────────────────────────────────────────────────────────

describe('pages with a video on them', () => {
  it('reads Open Graph: the file, the length, the poster', () => {
    // Trimmed from archive.org/details/BigBuckBunny_124.
    const page = parseVideoPage(
      `<html><head><title>Big Buck Bunny : Internet Archive</title>
      <meta name="description" content="Big Buck Bunny is a comedy about a well-tempered rabbit."/>
      <meta property="og:title" content="Big Buck Bunny : Free Download, Borrow, and Streaming"/>
      <meta property="og:site_name" content="Internet Archive"/>
      <meta property="og:type" content="video.movie"/>
      <meta property="og:image" content="/download/BigBuckBunny_124/thumb.jpg"/>
      <meta property="og:video" content="https://archive.org/download/BigBuckBunny_124/Content/big_buck_bunny_720p_surround.mp4?a=1&amp;b=2"/>
      <meta property="og:video:type" content="video/mp4"/>
      <meta property="video:duration" content="596"/>
      <meta name="twitter:player" content="https://archive.org/embed/BigBuckBunny_124"/>
      </head><body></body></html>`,
      new URL('https://archive.org/details/BigBuckBunny_124'),
    )
    expect(page).toMatchObject({
      title: 'Big Buck Bunny : Free Download, Borrow, and Streaming',
      description: 'Big Buck Bunny is a comedy about a well-tempered rabbit.',
      site: 'Internet Archive',
      duration: 596,
      thumbnail: 'https://archive.org/download/BigBuckBunny_124/thumb.jpg',
      media: ['https://archive.org/download/BigBuckBunny_124/Content/big_buck_bunny_720p_surround.mp4?a=1&b=2'],
      video: true,
    })
  })

  it('reads JSON-LD and the players a page carries', () => {
    const page = parseVideoPage(
      `<html><head><title>Talk</title>
      <meta property="og:video:url" content="https://embed.ted.com/talks/a_talk"/>
      <meta property="og:video:type" content="text/html"/>
      <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage"},{"@type":"VideoObject","name":"Do schools kill creativity?","description":"A case for creativity.","duration":"PT19M11S","uploadDate":"2006-06-27T00:11:00Z","thumbnailUrl":["https://pi.tedcdn.com/a.jpg"],"contentUrl":"https://cdn.example.org/talk.mp4","author":{"@type":"Person","name":"Sir Ken Robinson"}}]}</script>
      <link rel="alternate" type="application/json+oembed" href="https://www.ted.com/services/v1/oembed.json?url=https%3A%2F%2Fwww.ted.com%2Ftalks%2Fa_talk" />
      </head><body><iframe width="560" src="https://www.youtube.com/embed/iG9CE55wbtY?feature=oembed"></iframe><video controls><source src="/media/clip.webm" type="video/webm"></video></body></html>`,
      new URL('https://www.ted.com/talks/a_talk'),
    )
    expect(page).toMatchObject({ title: 'Do schools kill creativity?', author: 'Sir Ken Robinson', duration: 1151, published: '2006-06-27', thumbnail: 'https://pi.tedcdn.com/a.jpg', oembed: 'https://www.ted.com/services/v1/oembed.json?url=https%3A%2F%2Fwww.ted.com%2Ftalks%2Fa_talk', video: true })
    // The embed address is a player, not a file: only the real files are candidates.
    expect(page.media).toEqual(['https://cdn.example.org/talk.mp4', 'https://www.ted.com/media/clip.webm'])
    expect(page.embeds).toContain('https://www.youtube.com/embed/iG9CE55wbtY?feature=oembed')
    expect(page.embeds.map((e) => youtubeId(new URL(e))).filter(Boolean)).toEqual(['iG9CE55wbtY'])
  })

  it('knows a page with no video from one that hides it', () => {
    expect(parseVideoPage('<html><head><title>Example Domain</title></head><body><p>Hi</p></body></html>', new URL('https://example.com/'))).toEqual({ title: 'Example Domain', media: [], embeds: [], video: false })
    expect(parseVideoPage('<html><head><meta property="og:type" content="video.other"><title>Clip</title></head></html>', new URL('https://clips.example.tv/x')).video).toBe(true)
  })

  it('reads ISO 8601 lengths', () => {
    expect(isoDuration('PT19M11S')).toBe(1151)
    expect(isoDuration('PT0M596S')).toBe(596)
    expect(isoDuration('PT1H2M3.5S')).toBe(3723.5)
    expect(isoDuration('P1DT1H')).toBe(90000)
    expect(isoDuration('19:11')).toBeUndefined()
    expect(isoDuration('P')).toBeUndefined()
  })

  it('finds an object a page assigns in a script, braces and quotes in strings included', () => {
    const data = { a: 'closing } brace and "quotes" and a backslash \\', b: { c: [1, { d: '{' }] } }
    expect(embeddedJson(`<script>var other = 1; var ytInitialData = ${JSON.stringify(data)};var next = {"x":1};</script>`, 'ytInitialData')).toEqual(data)
    expect(embeddedJson('<script>var ytInitialData = {"cut": "off</script>', 'ytInitialData')).toBeNull()
    expect(embeddedJson('<html></html>', 'ytInitialData')).toBeNull()
  })

  it('writes times the way people read them', () => {
    expect(clock(0)).toBe('0:00')
    expect(clock(149)).toBe('2:29')
    expect(clock(8636)).toBe('2:23:56')
  })
})

// ─── Video files ─────────────────────────────────────────────────────────

describe('video files', () => {
  it('tells a video file from a page, a stream playlist, audio and pictures', () => {
    expect(mediaKind('video/mp4', '/a')).toBe('video')
    expect(mediaKind('Video/WebM; codecs="vp9"', '/a')).toBe('video')
    expect(mediaKind('application/octet-stream', '/clips/intro.MP4')).toBe('video')
    expect(mediaKind('', '/clips/intro.mov')).toBe('video')
    expect(mediaKind('application/octet-stream', '/download/setup.exe')).toBe('page')
    expect(mediaKind('text/html; charset=utf-8', '/watch.mp4')).toBe('page')
    expect(mediaKind('application/vnd.apple.mpegurl', '/live/index')).toBe('stream')
    expect(mediaKind('application/x-mpegURL', '/a')).toBe('stream')
    expect(mediaKind('application/dash+xml', '/a')).toBe('stream')
    expect(mediaKind('application/octet-stream', '/a/master.m3u8')).toBe('stream')
    expect(mediaKind('audio/mpeg', '/a.mp3')).toBe('audio')
    expect(mediaKind('image/webp', '/a.webp')).toBe('image')
  })

  const chunks = (count: number, size: number) => {
    let sent = 0
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < count) controller.enqueue(new Uint8Array(size).fill(7))
        else controller.close()
      },
    })
  }

  it('saves a download under the cap', async () => {
    const file = path.join(env.root, 'ok.mp4')
    expect(await saveCapped(new Response(chunks(5, 1000)), file, 10_000)).toBe(5000)
    expect(fs.statSync(file).size).toBe(5000)
  })

  it('refuses a file that says it is over the cap, before reading any of it', async () => {
    const file = path.join(env.root, 'declared.mp4')
    let pulled = 0
    const body = new ReadableStream<Uint8Array>({ pull: () => void pulled++ }, { highWaterMark: 0 })
    await expect(saveCapped(new Response(body, { headers: { 'content-length': String(3 * 1024 ** 3) } }), file)).rejects.toThrow(/is 3\.0 GB — Lumen downloads at most 400 MB/)
    expect(pulled).toBe(0)
    expect(fs.existsSync(file)).toBe(false)
    expect(FILE_CAP).toBe(400 * 1024 * 1024)
  })

  it('stops a download that turns out longer than the cap and leaves nothing behind', async () => {
    const file = path.join(env.root, 'endless.mp4')
    let cancelled = false
    let sent = 0
    const endless = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        sent++
        controller.enqueue(new Uint8Array(1000))
      },
      cancel: () => void (cancelled = true),
    })
    await expect(saveCapped(new Response(endless), file, 10_000)).rejects.toThrow(/is over 1 MB — Lumen downloads at most 1 MB/)
    expect(cancelled).toBe(true)
    expect(sent).toBeLessThan(20)
    expect(fs.existsSync(file)).toBe(false)
  })

  it('treats an empty download as a failure', async () => {
    const file = path.join(env.root, 'empty.mp4')
    await expect(saveCapped(new Response(chunks(0, 0)), file)).rejects.toThrow(/came back empty/)
    expect(fs.existsSync(file)).toBe(false)
  })

  it('downloads a direct video link to a temporary file the editor can read, and deletes it on release', async () => {
    const bytes = Buffer.from(Array.from({ length: 2000 }, (_, i) => i % 251))
    env.answer = (url) => (url.pathname === '/clips/intro.mp4' ? new Response(bytes, { headers: { 'content-type': 'video/mp4', 'content-length': '2000' } }) : new Response('', { status: 404 }))
    const video = await watchVideo('https://93.184.216.34/clips/intro.mp4')
    expect(video).toMatchObject({ title: 'intro.mp4', site: '93.184.216.34', file: { mime: 'video/mp4', size: 2000 } })
    expect(video.watchedWith).toMatch(/the video file itself/)
    expect(video.notes.join(' ')).toMatch(/no transcript.*transcribe_media/)
    const abs = mediaPath(video.file!.url)!
    expect(abs.replace(/\\/g, '/')).toContain(`${env.root}/temp/lumen/watch/`)
    expect(path.extname(abs)).toBe('.mp4')
    expect(fs.readFileSync(abs).equals(bytes)).toBe(true)
    await watchVideo('', { release: video.file!.id })
    expect(await until(() => !fs.existsSync(abs))).toBe(true)
    expect(env.calls).toHaveLength(1)
  })

  it('follows a redirect to the file, and names it by what the server says it is', async () => {
    env.answer = (url) => {
      if (url.pathname === '/v/abc') return new Response(null, { status: 302, headers: { location: 'https://93.184.216.35/cdn/abc?sig=1' } })
      return new Response(new Uint8Array(64), { headers: { 'content-type': 'video/webm' } })
    }
    const video = await watchVideo('https://93.184.216.34/v/abc')
    expect(video.file).toMatchObject({ mime: 'video/webm', size: 64 })
    expect(path.extname(mediaPath(video.file!.url)!)).toBe('.webm')
    expect(env.calls.map((c) => c.url)).toEqual(['https://93.184.216.34/v/abc', 'https://93.184.216.35/cdn/abc?sig=1'])
    await watchVideo('', { release: video.file!.id })
  })

  it('follows a redirect the way Electron reports one: a failed fetch, then a request that learns the target', async () => {
    env.asElectron = true
    env.answer = (url) => (url.pathname === '/v/abc' ? new Response(null, { status: 301, headers: { location: 'https://93.184.216.35/cdn/abc.mp4' } }) : new Response(new Uint8Array(64), { headers: { 'content-type': 'video/mp4' } }))
    const video = await watchVideo('https://93.184.216.34/v/abc')
    expect(video.file).toMatchObject({ mime: 'video/mp4', size: 64 })
    expect(env.calls.map((c) => c.url)).toEqual(['https://93.184.216.34/v/abc', 'https://93.184.216.34/v/abc', 'https://93.184.216.35/cdn/abc.mp4'])
    expect(env.calls.every((c) => c.credentials === 'omit' && c.redirect === 'manual')).toBe(true)
    await watchVideo('', { release: video.file!.id })

    // The target is checked before anything is asked of it.
    env.calls.length = 0
    env.answer = () => new Response(null, { status: 302, headers: { location: 'http://192.168.1.20/private.mp4' } })
    await expect(watchVideo('https://93.184.216.34/clip.mp4')).rejects.toThrow(/off limits/)
    expect(env.calls.some((c) => c.url.includes('192.168'))).toBe(false)
  })

  it('won’t download a direct link over the cap', async () => {
    env.answer = () => new Response(new Uint8Array(10), { headers: { 'content-type': 'video/webm', 'content-length': '3000000000' } })
    await expect(watchVideo('https://93.184.216.34/big.webm')).rejects.toThrow(/The video file is 2\.8 GB — Lumen downloads at most 400 MB/)
  })

  it('says what a link is when it isn’t a video', async () => {
    env.answer = () => new Response('#EXTM3U', { headers: { 'content-type': 'application/vnd.apple.mpegurl' } })
    await expect(watchVideo('https://93.184.216.34/live/index.m3u8')).rejects.toThrow(/stream playlist/)
    env.answer = () => new Response('ID3', { headers: { 'content-type': 'audio/mpeg' } })
    await expect(watchVideo('https://93.184.216.34/song.mp3')).rejects.toThrow(/audio file.*import_media_url/)
    env.answer = () => html('gone', 404)
    await expect(watchVideo('https://93.184.216.34/clip.mp4')).rejects.toThrow(/answered 404 — there is nothing at that address/)
  })
})

// ─── Only public addresses ───────────────────────────────────────────────

describe('where requests may go', () => {
  it('refuses this computer and the local network outright', async () => {
    for (const url of ['http://localhost:3000/clip.mp4', 'http://192.168.1.20/clip.mp4', 'http://127.0.0.1/clip.mp4', 'http://[::1]/clip.mp4', 'file:///C:/clip.mp4', 'http://nas/clip.mp4']) {
      await expect(watchVideo(url), url).rejects.toThrow(/off limits|Only http and https/)
    }
    expect(env.calls).toHaveLength(0)
  })

  it('refuses a redirect into the local network', async () => {
    env.answer = () => new Response(null, { status: 302, headers: { location: 'http://192.168.1.20/private.mp4' } })
    await expect(watchVideo('https://93.184.216.34/clip.mp4')).rejects.toThrow(/off limits/)
    expect(env.calls.map((c) => c.url)).toEqual(['https://93.184.216.34/clip.mp4'])
  })

  it('doesn’t fetch a local address a page or an answer names', async () => {
    // A page whose "video file" is on the local network, and whose poster is too.
    env.answer = (url) =>
      url.hostname === '93.184.216.34'
        ? html('<html><head><title>Clip</title><meta property="og:type" content="video.other"><meta property="og:video" content="http://192.168.1.20/private.mp4"><meta property="og:video:type" content="video/mp4"><meta property="og:image" content="http://10.0.0.5/poster.jpg"></head></html>')
        : new Response(new Uint8Array(10), { headers: { 'content-type': 'video/mp4' } })
    const video = await watchVideo('https://93.184.216.34/page')
    expect(video.file).toBeUndefined()
    expect(video.thumbnail).toBeUndefined()
    expect(video.notes[0]).toMatch(/couldn’t watch this one: Addresses on this computer or the local network are off limits/)
    expect(env.calls.map((c) => c.url)).toEqual(['https://93.184.216.34/page'])

    // Caption and storyboard addresses come from YouTube's answer: a local one is not fetched either.
    env.calls.length = 0
    youtube({
      app: player({
        captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: 'http://127.0.0.1:8080/api/timedtext?lang=en', languageCode: 'en' }] } },
        storyboards: { playerStoryboardSpecRenderer: { spec: 'http://192.168.1.20/sb/$L/$N.jpg|320#180#108#3#3#2000#M$M#sig' } },
      }),
      page: null,
    })
    const yt = await watchVideo('https://youtu.be/dQw4w9WgXcQ')
    expect(yt.transcript).toBeUndefined()
    expect(yt.tiles).toBeUndefined()
    expect(env.calls.every((c) => /^https:\/\/(www\.youtube\.com|consent\.youtube\.com|i\.ytimg\.com)\//.test(c.url))).toBe(true)
  })
})

// ─── YouTube, start to finish ────────────────────────────────────────────

describe('watching YouTube', () => {
  it('returns details, chapters, a transcript and frames, with no cookies and no video download', async () => {
    youtube()
    const video = await watchVideo('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s')
    expect(video).toMatchObject({
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      site: 'YouTube',
      title: 'Rick Astley - Never Gonna Give You Up (Official Video)',
      author: 'Rick Astley',
      duration: 213,
      published: '2009-10-24',
      views: 1825286636,
      watchedWith: 'YouTube captions, YouTube preview frames (one every 2 s, 320×180)',
      notes: [],
    })
    // The player bar's chapters win over the description's.
    expect(video.chapters.map((c) => c.title)).toEqual(['Intro', 'History', 'Memory Safety', 'Cargo'])
    expect(video.transcript).toMatchObject({ language: 'en', kind: 'manual', available: ['en', 'en (auto)', 'de-DE'] })
    expect(video.transcript!.lines).toHaveLength(2)

    // The largest storyboard is the watch page's; only the sheets with a wanted tile are downloaded.
    expect(video.tiles!.frames).toHaveLength(16)
    expect(video.tiles!.frames[0]).toEqual({ time: 6, sheet: 0, x: 0, y: 180, width: 320, height: 180 })
    const sheets = env.calls.filter((c) => c.url.includes('/sb/')).map((c) => /storyboard3_L3\/M(\d+)\.jpg\?sqp=-oaymwENSDfyq4qp&sigh=rs\$AOn4CLCH$/.exec(c.url)?.[1])
    expect(sheets.map(Number).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    expect(video.tiles!.sheets).toHaveLength(12)
    expect(video.tiles!.sheets.every((s) => s.mime === 'image/webp')).toBe(true)
    expect(Buffer.from(video.tiles!.sheets[video.tiles!.frames[15].sheet].bytes).toString()).toBe('RIFF sheet /sb/dQw4w9WgXcQ/storyboard3_L3/M11.jpg')
    expect(video.thumbnail).toBeUndefined()

    expect(env.calls.every((c) => c.credentials === 'omit' && c.redirect === 'manual' && !('Cookie' in c.headers))).toBe(true)
    expect(env.calls.some((c) => /googlevideo|videoplayback/.test(c.url))).toBe(false)
    // The captions are asked for as JSON, as the app that listed them.
    const captions = env.calls.find((c) => c.url.includes('/api/timedtext'))!
    expect(new URL(captions.url).searchParams.getAll('fmt')).toEqual(['json3'])
    expect(captions.headers['User-Agent']).toMatch(/^com\.google\.ios\.youtube/)
    expect(JSON.parse(env.calls.find((c) => c.method === 'POST')!.body!)).toMatchObject({ videoId: 'dQw4w9WgXcQ', context: { client: { clientName: 'IOS' } } })
  })

  it('reads the track asked for and only the stretch asked for', async () => {
    youtube()
    const video = await watchVideo('https://youtu.be/dQw4w9WgXcQ', { language: 'de', from: 40, to: 60, frames: 4 })
    expect(video.transcript).toMatchObject({ language: 'de-DE', kind: 'manual' })
    expect(video.transcript!.lines.map((l) => l.start)).toEqual([35.75])
    expect(video.tiles!.frames.map((f) => f.time)).toEqual([42, 46, 52, 56])
    expect(env.calls.find((c) => c.url.includes('/api/timedtext'))!.url).toContain('lang=de-DE')
  })

  it('says which kind of captions it read', async () => {
    youtube({ app: player({ captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: 'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&kind=asr&lang=en', languageCode: 'en', kind: 'asr' }] } } }) })
    const video = await watchVideo('https://youtu.be/dQw4w9WgXcQ')
    expect(video.transcript).toMatchObject({ language: 'en', kind: 'auto-generated', available: ['en (auto)'] })
    expect(video.transcript!.lines[0].text).toMatch(/^rust a memory safe compiled programming language/)
  })

  it('skips the captions when no transcript is wanted', async () => {
    youtube()
    const video = await watchVideo('https://youtu.be/dQw4w9WgXcQ', { transcript: false })
    expect(video.transcript).toBeUndefined()
    expect(video.notes).toEqual([])
    expect(env.calls.some((c) => c.url.includes('/api/timedtext'))).toBe(false)
  })

  it('works when the watch page is a consent wall: the app’s smaller frames, the description’s chapters', async () => {
    youtube({ page: null })
    const video = await watchVideo('https://youtu.be/dQw4w9WgXcQ')
    expect(video.tiles!.frames[0]).toMatchObject({ width: 160, height: 90 })
    expect(video.chapters).toEqual([
      { start: 0, title: 'Intro' },
      { start: 43, title: 'Chorus' },
      { start: 175, title: 'Outro' },
    ])
    expect(video.transcript!.kind).toBe('manual')
  })

  it('falls back to the second app when the first hands over no captions', async () => {
    youtube()
    const scripted = env.answer
    env.answer = (url, call) => (url.pathname === '/api/timedtext' && /ios/.test(call.headers['User-Agent']) ? new Response('', { headers: { 'content-type': 'text/html' } }) : scripted(url, call))
    const video = await watchVideo('https://youtu.be/dQw4w9WgXcQ')
    expect(video.transcript!.kind).toBe('manual')
    expect(env.calls.filter((c) => c.method === 'POST').map((c) => JSON.parse(c.body!).context.client.clientName)).toEqual(['IOS', 'ANDROID'])
  })

  it('says so when there are no captions, or YouTube keeps them back', async () => {
    youtube({ app: player({ captions: undefined }) })
    expect((await watchVideo('https://youtu.be/dQw4w9WgXcQ')).notes).toEqual(['This video has no captions, so there is no transcript of what is said.'])
    youtube({ captions: () => new Response('', { headers: { 'content-type': 'text/html' } }) })
    const kept = await watchVideo('https://youtu.be/dQw4w9WgXcQ')
    expect(kept.transcript).toBeUndefined()
    expect(kept.notes[0]).toMatch(/lists captions \(en, en \(auto\), de-DE\) but didn’t hand them over/)
    expect(kept.tiles!.frames).toHaveLength(16)
  })

  it('shows the thumbnail when a video has no preview frames', async () => {
    const short = player({ storyboards: undefined })
    youtube({ app: short, page: html(watchPage(short, {})) })
    const video = await watchVideo('https://youtu.be/dQw4w9WgXcQ')
    expect(video.tiles).toBeUndefined()
    expect(video.thumbnail).toMatchObject({ mime: 'image/jpeg' })
    expect(Buffer.from(video.thumbnail!.bytes).toString()).toBe('RIFF sheet /vi/dQw4w9WgXcQ/sddefault.jpg')
    expect(video.notes.join(' ')).toMatch(/no preview frames for this video/)
    expect(video.transcript).toBeDefined()
  })

  it('reports an age check instead of working around it', async () => {
    const gated = { playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm your age' }, videoDetails: { videoId: 'dQw4w9WgXcQ', title: 'A trailer', author: 'A studio', lengthSeconds: '142', shortDescription: 'Rated M.' } }
    youtube({ app: gated, page: html(watchPage(gated, {})) })
    const video = await watchVideo('https://youtu.be/dQw4w9WgXcQ')
    expect(video).toMatchObject({ title: 'A trailer', author: 'A studio', duration: 142, watchedWith: 'the page’s public details only' })
    expect(video.notes).toEqual(['YouTube won’t play this video: “Sign in to confirm your age.” Lumen doesn’t sign in or work around restrictions, so there is no transcript and there are no frames — only the title, description and thumbnail.'])
    expect(video.transcript).toBeUndefined()
    expect(video.tiles).toBeUndefined()
    expect(video.thumbnail).toBeDefined()
    expect(env.calls.some((c) => c.url.includes('/api/timedtext') || c.url.includes('/sb/'))).toBe(false)
  })

  it('fails plainly for a removed or mistyped video', async () => {
    const gone = { playabilityStatus: { status: 'ERROR', reason: 'This video is unavailable' } }
    youtube({ app: gone, page: html(watchPage(gone, {})) })
    await expect(watchVideo('https://www.youtube.com/watch?v=aaaaaaaaaaa')).rejects.toThrow('YouTube says: “This video is unavailable.” Check the link — the video may be removed or private.')
  })

  it('says a live stream can’t be watched yet', async () => {
    const live = player({ videoDetails: { videoId: 'dQw4w9WgXcQ', title: 'Live from orbit', author: 'NASA', lengthSeconds: '0', isLive: true, isLiveContent: true }, captions: undefined, storyboards: { playerLiveStoryboardSpecRenderer: { spec: 'https://i.ytimg.com/sb/x/storyboard_live_90_2x2_b1/M$M.jpg?rs=x#159#90#2#2' } } })
    youtube({ app: live, page: html(watchPage(live, {})) })
    const video = await watchVideo('https://youtu.be/dQw4w9WgXcQ')
    expect(video).toMatchObject({ live: true, title: 'Live from orbit' })
    expect(video.duration).toBeUndefined()
    expect(video.notes).toHaveLength(1)
    expect(video.notes[0]).toMatch(/live right now/)
  })

  it('refuses a stretch past the end, saying how long the video is', async () => {
    youtube()
    await expect(watchVideo('https://youtu.be/dQw4w9WgXcQ', { from: 500 })).rejects.toThrow('That stretch is empty — the video is 3:33 long (213 seconds).')
  })

  it('asks for one video when given a channel or a playlist', async () => {
    await expect(watchVideo('https://www.youtube.com/playlist?list=PL12345')).rejects.toThrow(/isn’t one video/)
    expect(env.calls).toHaveLength(0)
  })

  it('watches the YouTube video a page carries', async () => {
    youtube()
    const scripted = env.answer
    env.answer = (url, call) =>
      url.hostname === 'blog.example.org' ? html('<html><head><title>Release notes</title></head><body><iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ?feature=oembed"></iframe><iframe src="https://www.youtube-nocookie.com/embed/iG9CE55wbtY"></iframe></body></html>') : scripted(url, call)
    const video = await watchVideo('https://blog.example.org/release-4-2/')
    expect(video).toMatchObject({ site: 'YouTube', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' })
    expect(video.notes[0]).toBe('The page at blog.example.org carries this YouTube video; that is what was watched. The page has one more video: https://www.youtube.com/watch?v=iG9CE55wbtY.')
    expect(video.tiles!.frames).toHaveLength(16)
  })
})

// ─── Other sites ─────────────────────────────────────────────────────────

describe('watching other sites', () => {
  it('reads Vimeo’s captions and cuts frames from its sprite sheet', async () => {
    env.answer = (url) => {
      if (url.hostname === 'vimeo.com') return html('<html><head><meta property="og:site_name" content="Vimeo"><meta property="og:title" content="The New Vimeo Player"><meta property="og:description" content="We rebuilt our player."><meta property="og:video:url" content="https://player.vimeo.com/video/76979871?h=8272103f6e"><meta property="og:video:type" content="text/html"></head></html>')
      if (url.pathname === '/video/76979871/config')
        return json({
          video: { title: 'The New Vimeo Player (You Know, For Videos)', duration: 62, owner: { name: 'Vimeo' }, thumbnail_url: 'https://i.vimeocdn.com/video/452001751' },
          request: {
            text_tracks: [
              { lang: 'de', url: 'https://captions.vimeo.com/captions/170.vtt?sig=a', kind: 'subtitles', provenance: 'user_uploaded' },
              { lang: 'en', url: 'https://captions.vimeo.com/captions/140662.vtt?sig=b', kind: 'subtitles', provenance: 'user_uploaded' },
            ],
            thumb_preview: { url: 'https://videoapi-sprites.vimeocdn.com/video-sprites/image/f6af.0.webp?sig=c', width: 4260, height: 2880, frame_width: 426, frame_height: 240, columns: 10, frames: 120 },
          },
        })
      if (url.hostname === 'captions.vimeo.com') return new Response('WEBVTT\n\n1\n00:00:05.237 --> 00:00:08.043\n<i>Here at Vimeo, there\'s always</i>\n<i>one thing on our minds:</i>\n\n2\n00:00:08.043 --> 00:00:11.022\n<i>how to make your videos look amazing.</i>\n', { headers: { 'content-type': 'text/vtt; charset=utf-8' } })
      if (url.hostname === 'videoapi-sprites.vimeocdn.com') return new Response(Buffer.from('RIFF sprite'), { headers: { 'content-type': 'image/webp' } })
      return new Response('', { status: 404 })
    }
    const video = await watchVideo('https://vimeo.com/76979871', { frames: 4, from: 1, to: 61 })
    expect(video).toMatchObject({ site: 'Vimeo', title: 'The New Vimeo Player', author: 'Vimeo', duration: 62, description: 'We rebuilt our player.' })
    expect(video.transcript).toMatchObject({ language: 'en', kind: 'manual', available: ['de', 'en'] })
    expect(video.transcript!.lines[0].text).toBe('Here at Vimeo, there\'s always one thing on our minds: how to make your videos look amazing.')
    // 120 tiles of 426 × 240 over 62 s, ten to a row, all on one sheet: tiles 16, 45, 74 and 103.
    expect(video.tiles!.sheets).toHaveLength(1)
    expect(video.tiles!.frames).toEqual([
      { time: 8.27, sheet: 0, x: 2556, y: 240, width: 426, height: 240 },
      { time: 23.25, sheet: 0, x: 2130, y: 960, width: 426, height: 240 },
      { time: 38.23, sheet: 0, x: 1704, y: 1680, width: 426, height: 240 },
      { time: 53.22, sheet: 0, x: 1278, y: 2400, width: 426, height: 240 },
    ])
    expect(video.watchedWith).toBe('Vimeo captions, Vimeo preview frames (one every 0.5 s, 426×240)')
    expect(env.calls.find((c) => c.url.includes('/config'))!.url).toBe('https://player.vimeo.com/video/76979871/config?h=8272103f6e')
  })

  it('downloads the video of a post on X through the endpoint its embeds use', async () => {
    env.answer = (url) => {
      if (url.hostname === 'cdn.syndication.twimg.com')
        return json({
          text: 'Tower view of the first Super Heavy booster catch https://t.co/Bgjeyuw7Hf',
          created_at: '2024-10-14T20:25:25.000Z',
          user: { name: 'SpaceX', screen_name: 'SpaceX' },
          mediaDetails: [
            {
              type: 'video',
              media_url_https: 'https://pbs.twimg.com/amplify_video_thumb/1/img/a.jpg',
              video_info: {
                duration_millis: 21755,
                variants: [
                  { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/amplify_video/1/pl/a.m3u8' },
                  { bitrate: 288000, content_type: 'video/mp4', url: 'https://video.twimg.com/amplify_video/1/vid/avc1/480x270/a.mp4' },
                  { bitrate: 2176000, content_type: 'video/mp4', url: 'https://video.twimg.com/amplify_video/1/vid/avc1/1280x720/b.mp4' },
                ],
              },
            },
          ],
        })
      if (url.hostname === 'video.twimg.com') return new Response(new Uint8Array(500), { headers: { 'content-type': 'video/mp4', 'content-length': '500' } })
      if (url.hostname === 'pbs.twimg.com') return new Response(Buffer.from('JPEG'), { headers: { 'content-type': 'image/jpeg' } })
      return new Response('', { status: 404 })
    }
    const video = await watchVideo('https://x.com/SpaceX/status/1845922924315938922')
    expect(video).toMatchObject({ site: 'X', author: 'SpaceX (@SpaceX)', duration: 21.755, published: '2024-10-14', file: { mime: 'video/mp4', size: 500 } })
    expect(video.title).toMatch(/^Tower view of the first Super Heavy booster catch/)
    // The post, the smaller MP4 (not the playlist, not the 720p one), and the poster.
    expect(env.calls.map((c) => new URL(c.url).pathname)).toEqual(['/tweet-result', '/amplify_video/1/vid/avc1/480x270/a.mp4', '/amplify_video_thumb/1/img/a.jpg'])
    expect(new URL(env.calls[0].url).searchParams.get('id')).toBe('1845922924315938922')
    await watchVideo('', { release: video.file!.id })
  })

  it('says plainly when a post has no video', async () => {
    env.answer = (url) => (url.hostname === 'cdn.syndication.twimg.com' ? json({ text: 'Just words', user: { name: 'Someone', screen_name: 'someone' }, mediaDetails: [] }) : new Response('', { status: 404 }))
    const video = await watchVideo('https://twitter.com/someone/status/1349129669258448897')
    expect(video.notes).toEqual(['This post on X has no video on it: what is here is its text and picture.'])
    expect(video.file).toBeUndefined()
  })

  it('downloads the file a page names, with no referrer (Electron refuses a request that sets one)', async () => {
    env.answer = (url) => {
      if (url.pathname === '/moo') return html('<html><head><meta property="og:site_name" content="Streamable"><meta property="og:title" content="Please don&#x27;t eat me!"><meta property="og:type" content="video.other"><meta property="og:video" content="https://93.184.216.36/video/f644.mp4?Expires=1&amp;Signature=x"><meta property="og:video:type" content="video/mp4"><meta property="og:image" content="https://93.184.216.36/image/f644.jpg"></head></html>')
      if (url.pathname === '/video/f644.mp4') return new Response(new Uint8Array(300), { headers: { 'content-type': 'video/mp4' } })
      if (url.pathname === '/image/f644.jpg') return new Response(Buffer.from('JPEG'), { headers: { 'content-type': 'image/jpeg' } })
      return new Response('', { status: 404 })
    }
    const video = await watchVideo('https://93.184.216.34/moo')
    expect(video).toMatchObject({ site: 'Streamable', title: 'Please don\'t eat me!', file: { size: 300 } })
    const download = env.calls.find((c) => c.url.includes('f644.mp4'))!
    expect(download.url).toBe('https://93.184.216.36/video/f644.mp4?Expires=1&Signature=x')
    expect(Object.keys(download.headers).filter((h) => /^(referer|origin|cookie)$/i.test(h))).toEqual([])
    expect(video.notes.join(' ')).toMatch(/no transcript/)
    await watchVideo('', { release: video.file!.id })
  })

  it('returns what the page says and its poster when the video can’t be had, pointing at yt-dlp', async () => {
    const path0 = process.env.PATH
    process.env.PATH = ''
    try {
      env.answer = (url) => {
        if (url.pathname === '/clip') return html('<html><head><meta property="og:site_name" content="Twitch"><meta property="og:title" content="A great clip"><meta property="og:description" content="Clipped by someone"><meta property="og:type" content="video.other"><meta property="og:image" content="https://93.184.216.36/poster.jpg"></head></html>')
        if (url.pathname === '/poster.jpg') return new Response(Buffer.from('JPEG'), { headers: { 'content-type': 'image/jpeg' } })
        return new Response('', { status: 404 })
      }
      const video = await watchVideo('https://93.184.216.34/clip')
      expect(video).toMatchObject({ title: 'A great clip', description: 'Clipped by someone', watchedWith: 'the page’s public details only', thumbnail: { mime: 'image/jpeg' } })
      expect(video.notes).toEqual(['Lumen couldn’t watch this one: Twitch only hands its videos to its own player, often only after sign-in. What is here is the page’s public title, description and thumbnail. Installing yt-dlp (github.com/yt-dlp/yt-dlp) lets Lumen watch Twitch and many other sites.'])

      env.answer = () => html('<html><head><title>Example Domain</title></head><body>Nothing here</body></html>')
      expect((await watchVideo('https://93.184.216.34/')).notes[0]).toMatch(/^Lumen found no video on this page/)

      env.answer = () => html('Forbidden', 403)
      await expect(watchVideo('https://93.184.216.34/reel/1')).rejects.toThrow(/answered 403 — it may need sign-in/)
    } finally {
      process.env.PATH = path0
    }
  })
})

// ─── yt-dlp ──────────────────────────────────────────────────────────────

describe('yt-dlp’s answer', () => {
  const formats = [
    { format_id: 'sb0', ext: 'mhtml', protocol: 'mhtml', vcodec: 'none', url: 'https://i.ytimg.com/sb/x/storyboard3_L0/default.jpg' },
    { format_id: '140', ext: 'm4a', protocol: 'https', vcodec: 'none', acodec: 'mp4a.40.2', filesize: 3_000_000, url: 'https://rr1.example.com/audio' },
    { format_id: '134', ext: 'mp4', protocol: 'https', vcodec: 'avc1.4d401e', height: 360, filesize: 9_000_000, url: 'https://rr1.example.com/360-avc' },
    { format_id: '243', ext: 'webm', protocol: 'https', vcodec: 'vp09.00.21.08', height: 360, filesize: 6_000_000, url: 'https://rr1.example.com/360-vp9' },
    { format_id: '397', ext: 'mp4', protocol: 'https', vcodec: 'av01.0.04M.08', height: 480, filesize: 8_000_000, url: 'https://rr1.example.com/480-av1' },
    { format_id: '94', ext: 'mp4', protocol: 'm3u8_native', vcodec: 'avc1.4d401f', height: 480, url: 'https://manifest.example.com/480.m3u8' },
    { format_id: '135', ext: 'mp4', protocol: 'https', vcodec: 'avc1.4d401f', height: 480, filesize: 500_000_000, url: 'https://rr1.example.com/480-avc-huge' },
    { format_id: '137', ext: 'mp4', protocol: 'https', vcodec: 'avc1.640028', height: 1080, filesize: 90_000_000, url: 'https://rr1.example.com/1080-avc' },
  ]

  it('picks a small plain file in the codec most likely to decode', () => {
    expect(pickFormat(formats)?.url).toBe('https://rr1.example.com/360-avc')
    expect(pickFormat(formats.filter((f) => !f.vcodec.startsWith('avc')))?.url).toBe('https://rr1.example.com/360-vp9')
    // With room under the cap, the sharper H.264 file.
    expect(pickFormat(formats, 600_000_000)?.url).toBe('https://rr1.example.com/480-avc-huge')
  })

  it('takes the smallest when nothing is 480p or less, and nothing when there are only streams', () => {
    expect(pickFormat(formats.filter((f) => (f.height ?? 0) > 480))?.url).toBe('https://rr1.example.com/1080-avc')
    expect(pickFormat(formats.filter((f) => f.protocol !== 'https'))).toBeNull()
    expect(pickFormat([{ ext: 'mp4', protocol: 'https', vcodec: 'avc1', height: 360, url: 'https://x.example.com/drm', has_drm: true }])).toBeNull()
    expect(pickFormat([])).toBeNull()
  })

  it('lists the captions worth reading: a person’s, and the auto-generated ones in the spoken and asked languages', () => {
    const info = {
      subtitles: { en: [{ ext: 'vtt', url: 'https://c.example.com/en.vtt' }, { ext: 'json3', url: 'https://c.example.com/en.json3' }], live_chat: [{ ext: 'json', url: 'https://c.example.com/chat' }] },
      automatic_captions: {
        'es-orig': [{ ext: 'vtt', url: 'https://c.example.com/es-orig.vtt' }],
        es: [{ ext: 'vtt', url: 'https://c.example.com/es.vtt' }],
        en: [{ ext: 'srv1', url: 'https://c.example.com/en.srv1' }],
        fr: [{ ext: 'vtt', url: 'https://c.example.com/fr.vtt' }],
        de: [{ ext: 'ttml', url: 'https://c.example.com/de.ttml' }, { ext: 'vtt', url: 'https://c.example.com/de.vtt' }],
      },
    }
    expect(ytDlpTracks(info, 'de')).toEqual([
      { url: 'https://c.example.com/en.json3', language: 'en', auto: false },
      { url: 'https://c.example.com/es-orig.vtt', language: 'es', auto: true },
      { url: 'https://c.example.com/es.vtt', language: 'es', auto: true },
      { url: 'https://c.example.com/en.srv1', language: 'en', auto: true },
      { url: 'https://c.example.com/de.vtt', language: 'de', auto: true },
    ])
    expect(ytDlpTracks({})).toEqual([])
  })
})

describe('stopping a watch', () => {
  /** A download that never ends by itself: a kilobyte every few milliseconds until its request is ended. */
  function endless() {
    const sent = { chunks: 0 }
    env.answer = (_url, call) => {
      const signal = (call as Call & { signal?: AbortSignal }).signal
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            await new Promise((r) => setTimeout(r, 5))
            if (signal?.aborted) return controller.error(new DOMException('This operation was aborted', 'AbortError'))
            sent.chunks++
            controller.enqueue(new Uint8Array(1024))
          },
        }),
        { headers: { 'content-type': 'video/mp4' } },
      )
    }
    return sent
  }
  const kept = () => {
    const dir = `${env.root}/temp/lumen/watch`
    return fs.existsSync(dir) ? fs.readdirSync(dir) : []
  }

  it('ends the download, keeps no file and asks for nothing more', async () => {
    // Earlier tests' folders may still be on their way out: this watch's own is the one that counts.
    const before = kept()
    const mine = () => kept().filter((name) => !before.includes(name))
    const sent = endless()
    const watch = watchVideo('https://files.example.com/long.mp4', { id: 'watch-1' })
    watch.catch(() => {})
    expect(await until(() => sent.chunks > 3)).toBe(true)
    expect(mine()).toHaveLength(1)
    const asked = env.calls.length
    await watchVideo('', { cancel: 'watch-1' })
    await expect(watch).rejects.toThrow('Stopped.')
    const at = sent.chunks
    await new Promise((r) => setTimeout(r, 60))
    expect(sent.chunks).toBe(at)
    expect(env.calls).toHaveLength(asked)
    expect(await until(() => mine().length === 0)).toBe(true)
  })

  it('leaves a watch with another name alone, and ignores a name it doesn’t know', async () => {
    const sent = endless()
    const watch = watchVideo('https://files.example.com/long.mp4', { id: 'watch-2' })
    watch.catch(() => {})
    expect(await until(() => sent.chunks > 2)).toBe(true)
    await watchVideo('', { cancel: 'someone-else' })
    const at = sent.chunks
    expect(await until(() => sent.chunks > at + 2)).toBe(true)
    await watchVideo('', { cancel: 'watch-2' })
    await expect(watch).rejects.toThrow('Stopped.')
  })
})
