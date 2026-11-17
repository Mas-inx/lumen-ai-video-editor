import { describe, expect, it, vi } from 'vitest'
import type { Asset, Clip, ClipKind, Project, SpeechSegment } from './types'

vi.mock('@/engine/audio-engine', () => ({
  isAudible: (project: Project, clip: Clip) =>
    (clip.kind === 'audio' || clip.kind === 'video') &&
    Boolean(clip.assetId) &&
    !clip.audio.detached &&
    project.assets[clip.assetId!]?.hasAudio !== false &&
    !project.tracks.find((t) => t.id === clip.trackId)?.muted,
  loadAudio: async () => null,
  activeRegions: () => [],
  isLongAudio: () => false,
  activeRegionsStreamed: async () => null,
}))

const { checkEdit, readingTime, sampleFrames, verdict } = await import('./quality')
type Measures = import('./quality').QualityMeasures
type Issue = import('./quality').QualityIssue
const { useEditor, getProject, dispatch } = await import('./store')
const { createClip, createTrack } = await import('./defaults')
const { createEmptyProject } = await import('./new-project')

let n = 0
function setup(settings = {}) {
  const p = createEmptyProject('Check', settings)
  const track = (name: string) => p.tracks.find((t) => t.name === name)!.id
  const media = (kind: Asset['kind'], extra: Partial<Asset> = {}): string => {
    const id = `asset_q${++n}`
    p.assets[id] = {
      id,
      name: `${kind} ${n}`,
      kind,
      duration: 60,
      ...(kind !== 'audio' ? { width: 1920, height: 1080 } : {}),
      hasAudio: kind !== 'image',
      source: { type: 'file', url: `lumen-media://file/${id}`, mime: 'video/mp4', fileName: `${kind}-${n}.mp4`, size: 1 },
      addedAt: 0,
      ...extra,
    } as Asset
    return id
  }
  const add = (trackName: string, kind: ClipKind, start: number, duration: number, extra: Omit<Parameters<typeof createClip>[0], 'kind' | 'trackId' | 'start' | 'duration'> = {}) => {
    const c = createClip({ kind, trackId: track(trackName), start, duration, name: `${kind} at ${start}`, ...extra })
    p.clips[c.id] = c
    return c
  }
  const caption = (start: number, duration: number, text: string, trackName = 'Captions') => {
    if (!p.tracks.some((t) => t.name === trackName)) p.tracks.unshift(createTrack('video', { name: trackName, role: 'captions' }))
    return add(trackName, 'text', start, duration, { text: { content: text } as never })
  }
  const run = (m: Measures = {}) => checkEdit(p, m)
  return { p, track, media, add, caption, run }
}

const only = (issues: Issue[], check: Issue['check']) => issues.filter((i) => i.check === check)

/** Runs an issue's one-click fix on the project, as the UI does. */
function applyFix(p: Project, issue: Issue) {
  useEditor.getState().loadProject(p)
  useEditor.getState().transaction(issue.fix!.label, 'user', () => {
    for (const c of issue.fix!.commands) expect(dispatch(c.command, c.input as never).ok).toBe(true)
  })
  return getProject()
}

/** A phrase whose words the transcriber timed: each word 0.3 s with 0.1 s between. */
function said(start: number, text: string): SpeechSegment {
  let t = start
  const words = text.split(' ').map((w) => {
    const x = { start: t, end: t + 0.3, text: w }
    t += 0.4
    return x
  })
  return { start, end: words[words.length - 1].end, text, words }
}

/** Mix levels every 20 ms for `seconds`, from a function of time. */
const levels = (seconds: number, db: (t: number) => number) => Array.from({ length: Math.round(seconds * 50) }, (_, i) => db(i * 0.02))

describe('the timeline', () => {
  it('an empty timeline is critical', () => {
    const { run } = setup()
    expect(run()).toMatchObject([{ check: 'empty', severity: 'critical' }])
  })

  it('finds black under the sound past the end of the main track, and lets the last shot run on', () => {
    const { p, media, add, run } = setup()
    const shot = add('Main', 'video', 0, 300, { assetId: media('video') })
    add('Voice', 'audio', 0, 360, { assetId: media('audio') })
    const [gap] = only(run(), 'gap')
    expect(gap).toMatchObject({ severity: 'warning', frame: 300, end: 360, clipIds: [shot.id] })
    expect(gap.message).toBe('No picture from 0:10.0 to 0:12.0 — black under the sound.')
    expect(gap.fix).toEqual({ label: 'Extend the shot before', commands: [{ command: 'clip.trim', input: { id: shot.id, edge: 'end', frame: 360 } }] })
    expect(only(checkEdit(applyFix(p, gap)), 'gap')).toEqual([])
  })

  it('a hole where nothing plays is critical, and closing it ripples the rest', () => {
    const { p, media, add, run } = setup()
    add('Overlay', 'image', 0, 90, { assetId: media('image') })
    const later = add('Overlay', 'image', 120, 90, { assetId: media('image') })
    const [gap] = only(run(), 'gap')
    expect(gap).toMatchObject({ severity: 'critical', frame: 90, end: 120 })
    expect(gap.message).toBe('Nothing plays from 0:03.0 to 0:04.0: black and silence.')
    const after = applyFix(p, gap)
    expect(after.clips[later.id].start).toBe(90)
  })

  it('a timeline of sound alone — captioned or not — only has holes where nothing plays', () => {
    const { media, add, caption, run } = setup()
    add('Voice', 'audio', 0, 300, { assetId: media('audio') })
    caption(30, 30, 'Hello there')
    caption(120, 30, 'Welcome back')
    expect(only(run(), 'gap')).toEqual([])
    add('Voice', 'audio', 360, 60, { assetId: media('audio') })
    expect(only(run(), 'gap')).toMatchObject([{ severity: 'critical', frame: 300, end: 360 }])
  })

  it('many holes are one issue, closed last first so every one is where it was found', () => {
    const { p, media, add, run } = setup()
    for (let i = 0; i < 5; i++) add('Overlay', 'image', i * 60, 30, { assetId: media('image') })
    const issues = only(run(), 'gap')
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toBe('Nothing plays in 4 places (the first at 0:01.0): black and silence.')
    expect(issues[0].fix!.commands.map((c) => c.input.start)).toEqual([210, 150, 90, 30])
    const after = applyFix(p, issues[0])
    expect(only(checkEdit(after), 'gap')).toEqual([])
    expect(Object.values(after.clips).map((c) => c.start).sort((a, b) => a - b)).toEqual([0, 30, 60, 90, 120])
  })

  it('a title on its own isn’t a gap', () => {
    const { media, add, run } = setup()
    add('Main', 'video', 0, 90, { assetId: media('video') })
    add('Titles', 'text', 90, 60)
    add('Voice', 'audio', 0, 150, { assetId: media('audio') })
    expect(only(run(), 'gap')).toEqual([])
  })

  it('offline media is critical, once per file', () => {
    const { p, media, add, run } = setup()
    const id = media('video')
    p.assets[id].source = { ...(p.assets[id].source as Extract<Asset['source'], { type: 'file' }>), missing: true }
    add('Main', 'video', 0, 60, { assetId: id })
    add('Main', 'video', 60, 60, { assetId: id })
    add('Overlay', 'image', 0, 30, { assetId: 'asset_gone' })
    const issues = only(run(), 'offline')
    expect(issues).toHaveLength(2)
    expect(issues.map((i) => i.severity)).toEqual(['critical', 'critical'])
    expect(issues.find((i) => i.clipIds?.length === 2)!.message).toMatch(/“video-\d+\.mp4” is offline: 2 clips show a slate instead of the picture/)
    expect(issues.find((i) => i.clipIds?.length === 1)!.message).toMatch(/uses media that’s no longer in the project/)
  })

  it('clips running past the end of their media: cut on the main track, trimmed elsewhere', () => {
    const { media, add, run } = setup()
    const short = media('video', { duration: 2 })
    const main = add('Main', 'video', 0, 90, { assetId: short })
    const over = add('Overlay', 'video', 30, 75, { assetId: short })
    const issues = only(run(), 'past-media')
    const onMain = issues.find((i) => i.clipIds![0] === main.id)!
    expect(onMain).toMatchObject({ severity: 'critical', frame: 60, end: 90 })
    expect(onMain.message).toMatch(/runs 1\.0 s past the end of its media — the picture holds still there/)
    expect(onMain.fix!.commands).toEqual([{ command: 'timeline.removeRange', input: { start: 60, end: 90, keepWhole: [] } }])
    const elsewhere = issues.find((i) => i.clipIds![0] === over.id)!
    expect(elsewhere.fix!.commands).toEqual([{ command: 'clip.trim', input: { id: over.id, edge: 'end', frame: 90 } }])
  })

  it('hidden, muted and soloed tracks that would change the export', () => {
    const { p, media, add, run } = setup()
    add('Main', 'video', 0, 90, { assetId: media('video') })
    add('Voice', 'audio', 0, 90, { assetId: media('audio', { transcript: [said(0, 'Hello')] }) })
    p.tracks.find((t) => t.name === 'Main')!.hidden = true
    p.tracks.find((t) => t.name === 'Voice')!.muted = true
    p.tracks.find((t) => t.name === 'Music')!.solo = true
    const issues = run()
    expect(only(issues, 'hidden-track')[0]).toMatchObject({ severity: 'critical', fix: { label: 'Show the track' } })
    expect(only(issues, 'muted-track')[0]).toMatchObject({ severity: 'warning' })
    expect(only(issues, 'muted-track')[0].message).toMatch(/speech included/)
    expect(only(issues, 'solo')[0].fix!.commands).toEqual([{ command: 'track.update', input: { id: p.tracks.find((t) => t.name === 'Music')!.id, patch: { solo: false } } }])
  })
})

describe('captions', () => {
  it('two caption tracks at once: hide the smaller set', () => {
    const { p, caption, run } = setup()
    caption(0, 60, 'Hello there everyone')
    caption(60, 60, 'Welcome back')
    caption(10, 60, 'Hola a todos', 'Captions 2')
    const [issue] = only(run(), 'caption-overlap')
    expect(issue.message).toBe('Captions on “Captions 2” and “Captions” overlap twice — both show at once.')
    expect(issue.fix!.commands).toEqual([{ command: 'track.update', input: { id: p.tracks.find((t) => t.name === 'Captions 2')!.id, patch: { hidden: true } } }])
  })

  it('too short to read: held longer where there’s room before the next one', () => {
    const { caption, run } = setup()
    const quick = caption(0, 9, 'This caption has far too many words')
    caption(60, 30, 'Next')
    expect(readingTime('This caption has far too many words')).toBeCloseTo(1.75)
    const [issue] = only(run(), 'caption-short')
    expect(issue.message).toMatch(/on screen for 0\.3 s — too short to read \(it needs about 1\.8 s\)/)
    expect(issue.fix!.commands).toEqual([{ command: 'clip.trim', input: { id: quick.id, edge: 'end', frame: 53 } }])
  })

  it('many short captions become one issue with every fix', () => {
    const { caption, run } = setup()
    for (let i = 0; i < 5; i++) caption(i * 60, 6, 'A caption far too quick to read')
    const issues = only(run(), 'caption-short')
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toBe('5 captions are too short to read (the first at 0:00.0).')
    expect(issues[0].fix!.commands).toHaveLength(5)
    expect(issues[0].clipIds).toHaveLength(5)
  })

  it('a caption that stays on after its words, and one with nobody speaking', () => {
    const { media, add, caption, run } = setup()
    // “We built a desk” is said 0.0–1.5 s; the caption stays until 3 s.
    add('Voice', 'audio', 0, 300, { assetId: media('audio', { transcript: [said(0, 'We built a desk'), said(6, 'Then we painted it')] }) })
    const lingers = caption(0, 90, 'We built a desk')
    caption(120, 45, 'Thanks for watching')
    const issues = run()
    const late = only(issues, 'caption-late')[0]
    expect(late).toMatchObject({ severity: 'info', clipIds: [lingers.id] })
    expect(late.message).toBe('Caption “We built a desk” stays 1.5 s after its words are said.')
    expect(late.fix!.commands).toEqual([{ command: 'clip.trim', input: { id: lingers.id, edge: 'end', frame: 53 } }])
    expect(only(issues, 'caption-orphan')[0].message).toBe('Caption “Thanks for watching” shows while nobody speaks.')
  })
})

describe('titles against the frame (the compositor’s boxes)', () => {
  it('cut off at an edge is critical, outside title-safe a warning, and both can be moved in', () => {
    const { p, add, run } = setup()
    const cut = add('Titles', 'text', 0, 60, { text: { content: 'Big headline' } as never, transform: { x: 800 } })
    const near = add('Titles', 'text', 60, 60, { text: { content: 'Lower third' } as never, transform: { y: 480 } })
    const issues = run({
      boxes: {
        [cut.id]: { cx: 1760, cy: 540, w: 600, h: 120, rotation: 0 },
        [near.id]: { cx: 960, cy: 1020, w: 500, h: 80, rotation: 0 },
      },
    })
    const off = only(issues, 'text-offscreen')[0]
    expect(off).toMatchObject({ severity: 'critical', clipIds: [cut.id] })
    expect(off.message).toBe('Title “Big headline” is cut off at the right edge.')
    // Moved left so its right edge sits at 95% of the width: 1824 − 300 = 1524 → x 800 − (1760 − 1524).
    expect(off.fix!.commands).toEqual([{ command: 'clip.update', input: { ids: [cut.id], patch: { transform: { x: 564, y: 0 } } } }])
    const unsafe = only(issues, 'text-unsafe')[0]
    expect(unsafe.message).toBe('Title “Lower third” is outside the title-safe area (bottom).')
    // Its bottom (1060) comes up to 95% of the height (1026): the centre moves from 1020 to 986.
    expect(applyFix(p, unsafe).clips[near.id].transform.y).toBe(480 - (1020 - 986))
  })

  it('wholly off screen, too wide to fit, or moving by keyframes', () => {
    const { add, run } = setup()
    const gone = add('Titles', 'text', 0, 60, { text: { content: 'Gone' } as never })
    const wide = add('Overlay', 'text', 0, 60, { text: { content: 'An extremely wide title' } as never })
    const moving = add('Titles', 'text', 90, 60, { text: { content: 'Flying' } as never, keyframes: { x: [{ frame: 0, value: 0, easing: 'linear' }, { frame: 59, value: 900, easing: 'linear' }] } })
    const issues = run({
      boxes: {
        [gone.id]: { cx: 2400, cy: 540, w: 200, h: 80, rotation: 0 },
        [wide.id]: { cx: 960, cy: 540, w: 2400, h: 100, rotation: 0 },
        [moving.id]: { cx: 1900, cy: 540, w: 300, h: 80, rotation: 0 },
      },
    })
    const byClip = (id: string) => issues.find((i) => i.clipIds?.[0] === id)!
    expect(byClip(gone.id).message).toBe('Title “Gone” is entirely off screen.')
    // Shrunk to the safe width: 1728 / 2400.
    expect(byClip(wide.id).fix!.commands[0].input).toMatchObject({ patch: { transform: { scale: 0.72 } } })
    expect(byClip(moving.id).fix).toBeUndefined()
    expect(byClip(moving.id).suggestion).toMatch(/keyframes/)
  })

  it('a caption over a title', () => {
    const { add, caption, run } = setup()
    const title = add('Titles', 'text', 0, 90, { text: { content: 'Chapter one' } as never })
    const cap = caption(30, 60, 'And so it begins')
    const issues = run({ boxes: { [title.id]: { cx: 960, cy: 880, w: 800, h: 120, rotation: 0 }, [cap.id]: { cx: 960, cy: 900, w: 700, h: 90, rotation: 0 } } })
    expect(only(issues, 'text-covers')[0].message).toBe('Caption “And so it begins” covers the title “Chapter one”.')
  })
})

describe('picture fit', () => {
  it('small media blown up', () => {
    const { media, add, run } = setup()
    const tiny = add('Overlay', 'image', 0, 60, { assetId: media('image', { width: 640, height: 360 }) })
    const fair = add('Overlay', 'image', 60, 60, { assetId: media('image', { width: 1280, height: 720 }) })
    add('Overlay', 'image', 120, 60, { assetId: media('image') })
    const issues = only(run(), 'upscaled')
    expect(issues.map((i) => [i.clipIds![0], i.severity])).toEqual([
      [tiny.id, 'warning'],
      [fair.id, 'info'],
    ])
    expect(issues[0].message).toMatch(/\(640×360\) is shown at 3\.0× its size/)
  })

  it('vertical footage on a landscape main track: bars, a fill fix, and a canvas that doesn’t match', () => {
    const { p, media, add, run } = setup()
    const phone = media('video', { width: 1080, height: 1920 })
    const a = add('Main', 'video', 0, 120, { assetId: phone })
    const b = add('Main', 'video', 120, 120, { assetId: phone })
    const issues = run()
    const [bars] = only(issues, 'letterbox')
    expect(bars.message).toMatch(/\(9:16\) leaves bars at the sides in the 16:9 frame — 68% of the picture, in 2 clips/)
    expect(bars.fix!.commands).toEqual([{ command: 'clip.update', input: { ids: [a.id, b.id], patch: { transform: { scale: 3.16, x: 0, y: 0 } } } }])
    expect(only(issues, 'aspect')[0].suggestion).toBe('Make the canvas match (reframe to 1080×1920), or fill the frame clip by clip.')
    // Something underneath fills the bars: no longer a problem.
    p.tracks.push(createTrack('video', { name: 'Background' }))
    add('Background', 'image', 0, 240, { assetId: media('image') })
    expect(only(run(), 'letterbox')).toEqual([])
  })
})

describe('the rendered picture', () => {
  /** Samples every half second: black where `dark` says, a still picture where `still` says, moving otherwise. */
  function samples(seconds: number, dark: (t: number) => boolean, still: (t: number) => boolean = () => false) {
    return Array.from({ length: seconds * 2 }, (_, i) => {
      const t = i / 2 + 0.25
      const grid = Array.from({ length: 144 }, (_, k) => (still(t) ? 100 : (k * 7 + i * 13) % 200))
      return { frame: Math.round(t * 30), luma: dark(t) ? 4 : 110, peak: dark(t) ? 10 : 230, grid }
    })
  }

  it('black stretches inside footage, but not a fade at the start', () => {
    const { media, add, run } = setup()
    const shot = add('Main', 'video', 0, 600, { assetId: media('video') })
    const issues = only(run({ frames: samples(20, (t) => t < 1 || (t > 8 && t < 11)) }), 'black')
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ severity: 'warning', clipIds: [shot.id] })
    // The first black sample is at frame 248 (8.27 s).
    expect(issues[0].message).toMatch(/black from 0:08\.3 to 0:11\.0, in “video at 0”/)
  })

  it('footage that stops moving while the clip moves around it; a still image is fine', () => {
    const { media, add, run } = setup()
    const shot = add('Main', 'video', 0, 600, { assetId: media('video') })
    add('Main', 'image', 600, 300, { assetId: media('image') })
    const issues = only(run({ frames: samples(30, () => false, (t) => (t > 6 && t < 10) || t > 20) }), 'frozen')
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ severity: 'warning', clipIds: [shot.id] })
    expect(issues[0].message).toMatch(/doesn’t move from 0:06\.3 to 0:09\.8 although it moves around it/)
  })

  it('samples twice a second, at most 600 frames', () => {
    const { p, media, add } = setup()
    add('Main', 'video', 0, 300, { assetId: media('video') })
    expect(sampleFrames(p)).toHaveLength(20)
    add('Main', 'video', 300, 60 * 30 * 30, { assetId: media('video', { duration: 2000 }) })
    expect(sampleFrames(p)).toHaveLength(600)
  })
})

describe('the sound', () => {
  const sound = (seconds: number, db: (t: number) => number, extra = {}) => ({ from: 0, levels: levels(seconds, db), lufs: -14, peakDb: -3, clipped: [] as [number, number][], ...extra })

  it('clipping: a limiter on the master fixes it', () => {
    const { media, add, run } = setup()
    add('Main', 'video', 0, 300, { assetId: media('video') })
    const [issue] = only(run({ sound: sound(10, () => -12, { clipped: [[2, 400], [2.5, 900], [7, 20]], peakDb: 0 }) }), 'clipping')
    expect(issue).toMatchObject({ severity: 'critical', frame: 60 })
    expect(issue.message).toBe('The mix clips: 1320 samples at full scale in 2 places, the first at 0:02.0 — audible distortion.')
    expect(issue.fix!.commands).toEqual([{ command: 'mix.update', input: { target: 'master', patch: { limiter: { enabled: true, ceiling: -1 } } } }])
  })

  it('loudness far from the target, raised on the master with a limiter guarding the peaks', () => {
    const { media, add, run } = setup()
    add('Main', 'video', 0, 300, { assetId: media('video') })
    const [quiet] = only(run({ sound: sound(10, () => -30, { lufs: -24.3, peakDb: -6 }) }), 'loudness')
    expect(quiet.message).toBe('The mix is -24.3 LUFS — quieter than the -14 LUFS it should be for online video.')
    expect(quiet.fix).toEqual({ label: 'Raise the master 10 dB (with a limiter)', commands: [{ command: 'mix.update', input: { target: 'master', patch: { volume: 10, limiter: { enabled: true, ceiling: -1 } } } }] })
    expect(only(run({ sound: sound(10, () => -12, { lufs: -15 }) }), 'loudness')).toEqual([])
    expect(only(run({ sound: sound(10, () => -120, { lufs: null }) }), 'loudness')[0]).toMatchObject({ severity: 'critical' })
  })

  it('music that stops dead at a cut gets a fade-out', () => {
    const { media, add, run } = setup()
    add('Main', 'video', 0, 300, { assetId: media('video', { hasAudio: false }) })
    const bed = add('Music', 'audio', 0, 150, { assetId: media('audio') })
    const [issue] = only(run({ sound: sound(10, (t) => (t < 5 ? -12 : -90)) }), 'abrupt')
    expect(issue.message).toBe('The sound of “audio at 0” cuts off at 0:05.0 (-12 → -90 dB).')
    expect(issue.fix!.commands).toEqual([{ command: 'clip.update', input: { ids: [bed.id], patch: { audio: { fadeOut: 30 } } } }])
    // Already fading: fine.
    bed.audio.fadeOut = 20
    expect(only(run({ sound: sound(10, (t) => (t < 5 ? -12 : -90)) }), 'abrupt')).toEqual([])
  })

  it('silence where the transcript has words', () => {
    const { media, add, run } = setup()
    add('Main', 'video', 0, 300, { assetId: media('video', { hasAudio: false }) })
    const voice = add('Voice', 'audio', 0, 300, { assetId: media('audio', { transcript: [said(0, 'We drove up to the lake'), said(4, 'and the light was perfect')] }) })
    // The sound drops out 4.4–5.2 s, under “the light”.
    const issues = only(run({ sound: sound(10, (t) => (t > 4.38 && t < 5.25 ? -120 : -20)) }), 'speech-silent')
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ severity: 'warning', clipIds: [voice.id] })
    expect(issues[0].message).toBe('No sound under “the light” at 0:04.4 — the transcript has words there.')
  })
})

describe('checkEdit', () => {
  it('puts the worst first, keeps to a range, and says whether the edit is finished', () => {
    const { p, media, add, run } = setup()
    add('Main', 'video', 0, 300, { assetId: media('video') })
    add('Voice', 'audio', 0, 360, { assetId: media('audio') })
    const off = media('image')
    p.assets[off].source = { ...(p.assets[off].source as Extract<Asset['source'], { type: 'file' }>), missing: true }
    add('Overlay', 'image', 30, 30, { assetId: off })
    const issues = run()
    expect(issues.map((i) => i.severity)).toEqual(['critical', 'warning'])
    expect(verdict(issues)).toEqual({ finished: false, text: '1 critical issue, 1 warning. Critical issues mean the edit isn’t finished.' })
    expect(checkEdit(p, {}, [200, 400]).map((i) => i.check)).toEqual(['gap'])
    expect(verdict([])).toEqual({ finished: true, text: 'No problems found.' })
  })
})
