/**
 * The beat: tempo, beats and downbeats of the music, and laying clips out on
 * it. Land cuts, punch-ins (clip_animate punch at a beat) and motion graphics
 * (render_motion_graphic bpm) on the music.
 */
import { musicClip } from '@/editor/beat-grid'
import { getProject } from '@/editor/store'
import { analyzeBeats, beatsOf, cutToBeats } from '@/project/beats'
import { assetById, bool, clampNum, int, list, num, number, obj, str, strings, text, toFrame, type AgentTool } from './kit'

const sec = (frame: number) => Math.round((frame / getProject().settings.fps) * 1000) / 1000

export const BEAT_TOOLS: AgentTool[] = [
  {
    name: 'detect_beats',
    description:
      'Find the beat of the music: tempo (BPM), every beat and every downbeat (first beat of a bar, assuming 4/4). For a clip on the timeline (clip_id, or the main music when omitted) the times are timeline seconds, ready to cut on; for media (asset_id) they are seconds into the file. The waveform then shows the beat and cuts snap to it. confidence near 0 means there is no steady beat (speech, ambience).',
    inputSchema: obj({ clip_id: str('A music clip on the timeline (default: the longest music clip)'), asset_id: str('A media item instead of a clip') }),
    run: async (a) => {
      const assetId = text(a, 'asset_id')
      if (assetId) {
        const grid = await analyzeBeats(assetById(assetId).id)
        return { asset_id: assetId, bpm: grid.bpm, confidence: grid.confidence, beats: grid.times.length, beat_seconds: grid.times.slice(0, 400), downbeat_seconds: grid.downbeats.slice(0, 120) }
      }
      const clip = musicClip(getProject(), text(a, 'clip_id'))
      if (!clip) throw new Error('There’s no music on the timeline. Pass asset_id to analyze a media file.')
      const { grid, beats } = await beatsOf(clip)
      return {
        clip_id: clip.id,
        bpm: grid.bpm,
        confidence: grid.confidence,
        beats: beats.length,
        beat_seconds: beats.slice(0, 400).map((b) => sec(b.frame)),
        downbeat_seconds: beats.filter((b) => b.down).slice(0, 120).map((b) => sec(b.frame)),
      }
    },
  },
  {
    name: 'cut_to_beats',
    description:
      'Lay video and image clips out one after another on the beat of the music, each lasting `every_beats` beats (1 = every beat, 2, 4 = a bar…). Clips keep their order and in-points; one whose media runs out ends on the last beat it reaches. One undo step. For energetic edits use 1–2 beats, for calm ones a bar (4) or more.',
    inputSchema: obj(
      {
        clip_ids: list('The clips to cut, in order', { type: 'string' }),
        every_beats: int('Beats per clip (default 2)', { minimum: 1, maximum: 32 }),
        music_clip_id: str('The music to follow (default: the longest music clip)'),
        from_seconds: num('Start at the first beat at or after this time (default: where the first clip is)', { minimum: 0 }),
        start_on_downbeat: bool('Start on the first beat of a bar'),
      },
      ['clip_ids'],
    ),
    run: async (a) => {
      const from = number(a, 'from_seconds')
      const res = await cutToBeats(strings(a, 'clip_ids'), {
        every: clampNum(number(a, 'every_beats') ?? 2, 1, 32),
        music: text(a, 'music_clip_id'),
        from: from !== undefined ? toFrame(from) : undefined,
        downbeat: a.start_on_downbeat === true,
      })
      return { music_clip_id: res.music, bpm: res.bpm, placed: res.placed }
    },
  },
]
