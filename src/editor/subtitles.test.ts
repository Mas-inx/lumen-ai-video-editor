import { beforeEach, describe, expect, it } from 'vitest'
import { createEmptyProject } from './new-project'
import { clipsOnTrack } from './ops'
import { dispatch, getProject, useEditor } from './store'
import { cuesInRange, formatSrt, formatVtt, importSubtitles, parseSubtitles, timelineCues, withoutCaptions } from './subtitles'

const SRT = `1
00:00:01,000 --> 00:00:03,500
Hello <i>there</i>

2
00:00:04,250 --> 00:00:06,000
Two lines
of text

3
00:01:02,5 --> 00:01:04,000
{\\an8}Up top &amp; late
`

const VTT = `WEBVTT - with a title
Kind: captions

NOTE this is ignored

STYLE
::cue { color: yellow }

intro
00:01.000 --> 00:02.500 align:start position:10%
<v Roger>Hi <c.loud>everyone</c>

00:00:03.000 --> 00:00:04.000
<00:00:03.500>Karaoke timing
`

beforeEach(() => {
  useEditor.getState().loadProject(createEmptyProject('Subs'))
})

describe('subtitle files', () => {
  it('reads SRT, cleaning tags and entities', () => {
    const cues = parseSubtitles(SRT.replace(/\n/g, '\r\n'))
    expect(cues).toEqual([
      { start: 1, end: 3.5, text: 'Hello there' },
      { start: 4.25, end: 6, text: 'Two lines\nof text' },
      { start: 62.5, end: 64, text: 'Up top & late' },
    ])
  })

  it('reads WebVTT: headers, notes, styles, cue ids, settings and voice tags', () => {
    expect(parseSubtitles(VTT)).toEqual([
      { start: 1, end: 2.5, text: 'Hi everyone' },
      { start: 3, end: 4, text: 'Karaoke timing' },
    ])
  })

  it('writes SRT and WebVTT that read back the same', () => {
    const cues = [
      { start: 0.5, end: 2, text: 'First' },
      { start: 3661.25, end: 3662, text: 'An hour in\nsecond line' },
    ]
    const srt = formatSrt(cues)
    expect(srt).toContain('2\n01:01:01,250 --> 01:01:02,000\nAn hour in\nsecond line')
    expect(parseSubtitles(srt)).toEqual(cues)
    const vtt = formatVtt(cues)
    expect(vtt.startsWith('WEBVTT\n\n00:00:00.500 --> 00:00:02.000\nFirst')).toBe(true)
    expect(parseSubtitles(vtt)).toEqual(cues)
  })

  it('lays cues on a Captions track, and a second file on a track of its own', () => {
    const fps = getProject().settings.fps
    const first = importSubtitles(SRT, { name: 'English' })
    expect(first.added).toBe(3)
    const track = getProject().tracks.find((t) => t.id === first.trackId)!
    expect(track.role).toBe('captions')
    const clips = clipsOnTrack(getProject(), track.id)
    expect(clips.map((c) => [c.start, c.duration])).toEqual([
      [fps, Math.round(2.5 * fps)],
      [Math.round(4.25 * fps), Math.round(6 * fps) - Math.round(4.25 * fps)],
      [Math.round(62.5 * fps), Math.round(64 * fps) - Math.round(62.5 * fps)],
    ])
    expect(clips[1].text?.content).toBe('Two lines\nof text')
    // One undo step.
    expect(useEditor.getState().past).toHaveLength(1)
    const second = importSubtitles(VTT, { name: 'French' })
    expect(second.trackId).not.toBe(first.trackId)
    expect(getProject().tracks.find((t) => t.id === second.trackId)?.name).toBe('Captions · French')
    // Replace takes over the first captions track instead.
    const third = importSubtitles(VTT, { replace: true, offset: 10 })
    expect(clipsOnTrack(getProject(), third.trackId!).map((c) => c.start)).toEqual([11 * fps, 13 * fps])
    expect(() => importSubtitles('not subtitles')).toThrow(/No subtitles/)
  })

  it('exports the timeline’s captions, re-timed for a range, and can hide them from the picture', () => {
    importSubtitles(SRT)
    const cues = timelineCues(getProject())
    expect(cues.map((c) => c.text)).toEqual(['Hello there', 'Two lines\nof text', 'Up top & late'])
    const fps = getProject().settings.fps
    const part = cuesInRange(getProject(), [2 * fps, 5 * fps])
    expect(part).toEqual([
      { start: 0, end: 1.5, text: 'Hello there' },
      // Cues land on whole frames: 4.25 s is frame 128 at 30 fps.
      { start: Math.round(4.25 * fps) / fps - 2, end: 3, text: 'Two lines\nof text' },
    ])
    const hidden = withoutCaptions(getProject())
    expect(hidden.tracks.filter((t) => t.role === 'captions').every((t) => t.hidden)).toBe(true)
    expect(getProject().tracks.some((t) => t.role === 'captions' && !t.hidden)).toBe(true)
    // Plain titles aren't captions when a captions track exists.
    dispatch('clip.add', { trackId: getProject().tracks.find((t) => t.role === 'titles')!.id, kind: 'text', start: 0, duration: 30, patch: { text: { content: 'Title' } } })
    expect(timelineCues(getProject())).toHaveLength(3)
  })
})
