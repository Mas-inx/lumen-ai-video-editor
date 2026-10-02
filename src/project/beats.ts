/**
 * Beat detection for media in the project: finds a track's tempo, beats and
 * downbeats once (kept on the media item), and lays clips out on the beat.
 */
import { clipBeats, musicClip, type TimelineBeat } from '@/editor/beat-grid'
import { clipEnd, sourceFrames } from '@/editor/ops'
import { dispatch, getProject, useEditor } from '@/editor/store'
import type { Asset, Clip } from '@/editor/types'
import { loadAudio } from '@/engine/audio-engine'
import { detectBeats, type BeatGrid } from '@/engine/beats'
import { decodeAudio } from '@/engine/decode'

const running = new Map<string, Promise<BeatGrid>>()

/** The beat grid of a media item, found the first time and kept on it. */
export function analyzeBeats(assetId: string): Promise<BeatGrid> {
  const asset = getProject().assets[assetId]
  if (!asset) return Promise.reject(new Error('That media isn’t in the project.'))
  if (asset.beats) return Promise.resolve(asset.beats)
  let job = running.get(assetId)
  if (!job) {
    job = find(asset).finally(() => running.delete(assetId))
    running.set(assetId, job)
  }
  return job
}

async function find(asset: Asset): Promise<BeatGrid> {
  if (asset.kind === 'image') throw new Error(`“${asset.name}” is an image — it has no sound.`)
  if (asset.source.type !== 'file' || asset.source.missing) throw new Error(`“${asset.name}” is offline.`)
  // Long files stream in playback; beats only need the first quarter hour, decoded once.
  const buffer = (await loadAudio(asset)) ?? (await decodeAudio(asset.source.url))
  if (!buffer) throw new Error(`“${asset.name}” has no sound Lumen can decode.`)
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c))
  const grid = await detectBeats(channels, buffer.sampleRate)
  if (getProject().assets[asset.id]) dispatch('asset.update', { id: asset.id, patch: { beats: grid } }, { history: false })
  return grid
}

/** The beats of a music clip on the timeline (detecting them first if needed). */
export async function beatsOf(clip: Clip): Promise<{ grid: BeatGrid; beats: TimelineBeat[] }> {
  if (!clip.assetId) throw new Error('That clip has no media to listen to.')
  const grid = await analyzeBeats(clip.assetId)
  return { grid, beats: clipBeats(getProject(), getProject().clips[clip.id] ?? clip) }
}

export interface MontageResult {
  music: string
  bpm: number
  placed: { clip_id: string; start_seconds: number; beats: number }[]
}

/**
 * Lays clips out one after another on the beat of a music clip: each lasts
 * `every` beats (1, 2, 4 = a bar…), starting on the first beat at or after
 * `from` (a timeline frame). Clips whose media runs out end early and the next
 * one starts on the following beat. One undo step.
 */
export async function cutToBeats(clipIds: string[], opts: { every?: number; music?: string; from?: number; downbeat?: boolean } = {}): Promise<MontageResult> {
  const project = getProject()
  const music = musicClip(project, opts.music)
  if (!music) throw new Error('Add music to the timeline first — the cuts follow its beat.')
  const { grid, beats } = await beatsOf(music)
  if (beats.length < 2) throw new Error('Couldn’t find a steady beat in that music.')
  const clips = clipIds
    .map((id) => getProject().clips[id])
    .filter((c): c is Clip => Boolean(c) && c.kind !== 'audio' && c.id !== music.id)
    .sort((a, b) => a.start - b.start)
  if (!clips.length) throw new Error('Select the video or image clips to cut to the beat.')
  const every = Math.max(1, Math.round(opts.every ?? 2))
  const from = opts.from ?? Math.min(...clips.map((c) => c.start))
  let i = beats.findIndex((b) => b.frame >= from && (!opts.downbeat || b.down))
  if (i < 0) throw new Error('There are no beats after that point.')
  const fps = getProject().settings.fps
  const placed: MontageResult['placed'] = []
  useEditor.getState().transaction(`Cut ${clips.length} clips to the beat`, 'user', () => {
    // Out of the way first, so clips never overlap mid-move.
    const parking = Math.max(...Object.values(getProject().clips).map(clipEnd)) + fps * 10
    dispatch('clip.move', { moves: clips.map((c, k) => ({ id: c.id, start: parking + k * fps * 60 })), mode: 'free' })
    for (const c of clips) {
      if (i >= beats.length - 1) break
      const j = Math.min(beats.length - 1, i + every)
      const start = beats[i].frame
      let length = beats[j].frame - start
      const current = getProject().clips[c.id]
      // Media that runs out sooner ends early, on the last beat it reaches.
      const media = current.assetId ? sourceFrames(getProject(), current) : Infinity
      const available = Number.isFinite(media) ? (media - current.inPoint) / Math.max(0.01, current.speed) : Infinity
      let used = every
      if (length > available) {
        let k = i + 1
        while (k < j && beats[k].frame - start <= available) k++
        k = Math.max(i + 1, k - 1)
        length = beats[k].frame - start
        used = k - i
      }
      dispatch('clip.move', { moves: [{ id: c.id, start }], mode: 'free' })
      dispatch('clip.trim', { id: c.id, edge: 'end', frame: start + length })
      placed.push({ clip_id: c.id, start_seconds: Math.round((start / fps) * 1000) / 1000, beats: used })
      i += used
    }
  })
  return { music: music.id, bpm: grid.bpm, placed }
}
